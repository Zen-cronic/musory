// Creates the edmRoom database: collections with validators at validationLevel "constraint",
// unique and TTL indexes, one View per venue, and the track catalogue with Voyage embeddings.
// Safe to re-run; it only touches the edmRoom database. --recreate drops edmRoom's collections first.
import { db, closeAll, redactError, TRACKS as TRACKS_COLL, TAPS, DERIVED, CONSENTS, PRESENCE, SESSIONS, PREFS, PLAYS, TOMBSTONES, VENUES, VENUE_IDS } from "../server/db.js";
import { TRACKS, embedText } from "../server/catalog.js";
import { embedSeed } from "../server/embed.js";

const DAY = 86_400_000;
const missing = (f: string) => ({ $eq: [{ $type: f }, "missing"] });
const present = (f: string) => ({ $ne: [{ $type: f }, "missing"] });

// A tap is one guest's reaction to one play. It needs the consent it was made under, lives at most
// 180 days, a "tonight only" tap must name its session, and a superseded like must say when.
export const tapValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["personId", "venueId", "playId", "trackId", "genre", "signal", "at", "expiresAt", "consentId", "scope", "status"],
    properties: {
      signal: { enum: [1, -1] },
      scope: { enum: ["long", "tonight"] },
      status: { enum: ["current", "superseded"] },
      at: { bsonType: "date" },
      expiresAt: { bsonType: "date" },
    },
  },
  $expr: {
    $and: [
      { $lte: [{ $subtract: ["$expiresAt", "$at"] }, 180 * DAY] },
      { $or: [{ $ne: ["$scope", "tonight"] }, present("$sessionId")] },
      { $or: [{ $ne: ["$status", "superseded"] }, present("$supersededAt")] },
    ],
  },
};

// Everything built from taps. The rules the database enforces (121 otherwise):
// - taste, crowd memory and venue cards must name the taps they were built from;
// - a guest's taste can be built only from that guest's own taps;
// - a "tonight only" tap can't enter long-term taste unless the guest kept it (promotedBy);
// - a venue's crowd memory needs at least 3 different people, a public venue card at least 5;
// - venue memory (crowd, decisions, notes, cards, generated clips) can't hold a person's id;
// - a generated clip must name the taste and crowd memory it was composed from.
export const derivedValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["kind"],
    properties: { kind: { enum: ["taste", "crowd", "decision", "venue_card", "note", "clip"] } },
  },
  $expr: {
    $and: [
      { $or: [{ $in: ["$kind", ["decision", "note"]] }, { $gte: [{ $size: { $ifNull: ["$derivedFrom", []] } }, 1] }] },
      { $or: [{ $ne: ["$kind", "taste"] }, { $setIsSubset: [{ $ifNull: ["$sourceOwners", ["(none)"]] }, ["$ownerId"]] }] },
      {
        $or: [
          { $ne: ["$kind", "taste"] },
          {
            $eq: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$evidence", []] },
                    as: "e",
                    cond: { $and: [{ $eq: ["$$e.scope", "tonight"] }, { $eq: [{ $ifNull: ["$$e.promotedBy", null] }, null] }] },
                  },
                },
              },
              0,
            ],
          },
        ],
      },
      { $or: [{ $ne: ["$kind", "crowd"] }, { $gte: ["$distinctContributors", 3] }] },
      { $or: [{ $ne: ["$kind", "venue_card"] }, { $and: [{ $gte: ["$distinctContributors", 5] }, { $eq: ["$optIn", true] }] }] },
      {
        $or: [
          { $not: [{ $in: ["$kind", ["crowd", "decision", "note", "venue_card", "clip"]] }] },
          { $and: [missing("$personId"), missing("$ownerId"), missing("$sourceOwners")] },
        ],
      },
    ],
  },
};

const consentValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["personId", "venueId", "scopes", "grantedAt", "expiresAt"],
    properties: { scopes: { bsonType: "array", items: { enum: ["use_taste", "contribute_crowd"] } } },
  },
};
const prefValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["personId", "kind", "at", "by", "supersedes"],
    properties: { kind: { enum: ["bored"] }, supersedes: { bsonType: "array", minItems: 1 } },
  },
};

type D = Awaited<ReturnType<typeof db>>;
async function ensure(d: D, name: string, validator: object | null, existing: Set<string>) {
  if (existing.has(name)) return console.log(`${name} exists`);
  if (!validator) {
    await d.createCollection(name);
    return console.log(`created ${name}`);
  }
  try {
    await d.createCollection(name, { validator, validationLevel: "constraint" as never, validationAction: "error" });
    console.log(`created ${name} with validationLevel: constraint`);
  } catch (e) {
    console.log(`constraint refused for ${name}, using strict:`, redactError(e).message);
    await d.createCollection(name, { validator, validationLevel: "strict", validationAction: "error" });
  }
}

async function main() {
  const d = await db("app");
  if (process.argv.includes("--recreate")) {
    for (const c of await d.listCollections({}, { nameOnly: true }).toArray()) {
      if (c.name.startsWith("v_") || c.name.startsWith("system.")) continue;
      if (c.name === TRACKS_COLL && !process.argv.includes("--tracks")) continue;
      await d.collection(c.name).drop().catch(() => {});
    }
    console.log("dropped edmRoom collections (tracks kept unless --tracks)");
  }
  const existing = new Set((await d.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  await ensure(d, TAPS, tapValidator, existing);
  await ensure(d, DERIVED, derivedValidator, existing);
  await ensure(d, CONSENTS, consentValidator, existing);
  await ensure(d, PREFS, prefValidator, existing);
  for (const c of [TRACKS_COLL, PRESENCE, SESSIONS, PLAYS, TOMBSTONES]) await ensure(d, c, null, existing);

  // One reaction per guest per play: a second tap on the same play fails with E11000.
  await d.collection(TAPS).createIndex({ personId: 1, playId: 1 }, { unique: true, name: "one_reaction_per_play" });
  await d.collection(TAPS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "taps_expire" });
  await d.collection(TAPS).createIndex({ venueId: 1, status: 1 });
  await d.collection(DERIVED).createIndex({ derivedFrom: 1 });
  await d.collection(DERIVED).createIndex({ kind: 1, venueId: 1, at: -1 });
  await d.collection(DERIVED).createIndex({ kind: 1, ownerId: 1 });
  await d.collection(CONSENTS).createIndex({ personId: 1, venueId: 1 }, { unique: true });
  await d.collection(CONSENTS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  // One room at a time: a guest's presence is one document.
  // Presence _id is "<venue>|<guest>", so a delete event (TTL expiry) still says which room to re-mix.
  await d.collection(PRESENCE).createIndex({ personId: 1 }, { unique: true });
  await d.collection(PRESENCE).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await d.collection(SESSIONS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await d.collection(PLAYS).createIndex({ venueId: 1, startedAt: -1 });

  // Each venue reads its own crowd memory, decisions and staff notes through its own View,
  // with the lineage (which taps it was built from) removed.
  for (const v of VENUE_IDS) {
    const pipeline = [
      { $match: { $expr: { $and: [{ $eq: ["$venueId", v] }, { $in: ["$kind", ["crowd", "decision", "note"]] }] } } },
      { $unset: ["derivedFrom", "vector"] },
    ];
    const view = VENUES[v].view;
    if (existing.has(view)) await d.command({ collMod: view, viewOn: DERIVED, pipeline });
    else await d.createCollection(view, { viewOn: DERIVED, pipeline });
  }
  // Public venue cards (opted in, 5+ people). $expr-only $match so Vector Search can index the View.
  const discoverable = [{ $match: { $expr: { $eq: ["$kind", "venue_card"] } } }];
  if (existing.has("v_discoverable")) await d.command({ collMod: "v_discoverable", viewOn: DERIVED, pipeline: discoverable });
  else await d.createCollection("v_discoverable", { viewOn: DERIVED, pipeline: discoverable });

  // The catalogue, embedded with Voyage from each clip's text description.
  const vectors = await embedSeed(TRACKS.map(embedText));
  if (!vectors) throw new Error("Voyage embedding failed; check VOYAGE_API_KEY");
  await d.collection(TRACKS_COLL).deleteMany({ _id: { $nin: TRACKS.map((t) => t._id) } as never });
  for (const [i, tr] of TRACKS.entries())
    await d.collection(TRACKS_COLL).replaceOne({ _id: tr._id as never }, { ...tr, embedding: vectors[i] }, { upsert: true });
  console.log("tracks embedded:", TRACKS.length, "dims:", vectors[0].length);

  for (const name of [TAPS, DERIVED]) {
    const [info] = await d.listCollections({ name }).toArray();
    const o = (info as { options?: Record<string, unknown> }).options ?? {};
    console.log(`${name}: validationLevel=${o.validationLevel} validationAction=${o.validationAction}`);
  }
  await closeAll();
}

main().catch(async (e) => {
  console.error(redactError(e));
  await closeAll();
  process.exit(1);
});
