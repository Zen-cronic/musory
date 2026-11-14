// Smoke for the two Voyage features, against the running server (EVAL_BASE_URL, default :4377) plus
// in-process calls. Writes one scripted guest, one like and one test clip record to edmRoom; forget me
// removes all three. Run only in an agreed slot: VOYAGE_SMOKE_OK=1 pnpm tsx scripts/voyage-smoke.ts
//   V1 VIBE_TAP: a typed vibe becomes one like on the closest track; the words are stored nowhere.
//   V2 FIND_CLIPS: a composed clip is findable by description, served, then gone after forget me.
import "dotenv/config";
import { Binary, ObjectId } from "mongodb";
import { db, closeAll, DERIVED, PLAYS, VENUE_IDS } from "../server/db.js";

process.env.VIBE_TAP = "1";
process.env.FIND_CLIPS = "1";
const BASE = (process.env.EVAL_BASE_URL || `http://localhost:${process.env.PORT || 4377}`).replace(/\/$/, "");
if (process.env.VOYAGE_SMOKE_OK !== "1") {
  console.error("Writes to the shared edmRoom database. Set VOYAGE_SMOKE_OK=1 in an agreed slot.");
  process.exit(2);
}
const { rooms, loadTracks } = await import("../server/room.js");
const { vibeTap } = await import("../server/vibe.js");
const { findTrack } = await import("../server/find.js");
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const readable = (doc: unknown) =>
  JSON.stringify(doc, function (this: Record<string, unknown>, k, v) {
    const raw = this[k] as { _bsontype?: string; buffer?: Uint8Array } | undefined;
    return raw && typeof raw === "object" && raw._bsontype === "Binary" && raw.buffer ? Buffer.from(raw.buffer).toString("latin1") : v;
  });
async function docsContaining(s: string) {
  const d = await db();
  const names = (await d.listCollections({ type: "collection" }, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
  const all = await Promise.all(names.map(async (n) => (await d.collection(n).find({}).toArray()).filter((x) => readable(x).includes(s)).length));
  return all.reduce((a, b) => a + b, 0);
}
let failures = 0;
const check = (name: string, ok: boolean, detail: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

// The in-process tap path needs the rooms as the server last committed them.
await loadTracks();
const d = await db();
for (const v of VENUE_IDS) {
  const p = await d.collection(PLAYS).find({ venueId: v }).sort({ startedAt: -1 }).limit(1).next();
  if (p) rooms[v].play = { playId: String(p._id), trackId: String(p.trackId), startedAt: +p.startedAt, endsAt: +p.endsAt } as never;
  rooms[v].next = await d.collection(DERIVED).find({ kind: "decision", venueId: v }).sort({ at: -1 }).limit(1).next();
}

const personId = `vsmoke-${Date.now().toString(36)}`;
const words = `something dark and driving for the warehouse ${Date.now().toString(36)}`; // unique, so a leak is findable
await api("POST", "/api/checkin", { personId, venueId: "copper", scopes: ["use_taste", "contribute_crowd"] });

// V1
const t0 = Date.now();
const vibe = (await vibeTap(personId, words)) as any;
const me = (await api("GET", `/api/me?personId=${personId}`)).json;
const like = (me.taps ?? []).find((t: any) => t.trackId === vibe.vibe?.trackId && t.signal === 1);
check("V1 a typed vibe became one like on the closest track", Boolean(like), { track: vibe.vibe, ms: Date.now() - t0, scope: like?.scope, taste: Boolean(me.taste) });
check("V1 the typed words are in no collection", (await docsContaining(words)) === 0, { documentsWithWords: await docsContaining(words) });

// V2: a test clip composed from this guest's taste (derivedFrom), with its sound stored in the document
const taste = await d.collection(DERIVED).findOne({ kind: "taste", ownerId: personId }, { projection: { _id: 1 } });
const clipId = new ObjectId();
await d.collection(DERIVED).insertOne({
  _id: clipId, kind: "clip", test: true, venueId: "copper", model: "test", mode: "test", people: 3, mix: { techno: 1 },
  descriptors: { from: "house", genres: ["techno"], bpm: 132 },
  plan: { chunks: [{ text: "[Lead-in]" }, { text: "[New groove]", positive_styles: ["dark driving techno", "pounding four-on-the-floor kick", "warehouse atmosphere"] }] },
  audio: { mime: "audio/mpeg", bytes: new Binary(Buffer.from("test")) }, audioUrl: `/api/clip/${clipId.toHexString()}`,
  at: new Date(), expiresAt: new Date(Date.now() + 15 * 60_000), derivedFrom: taste ? [taste._id] : [new ObjectId()],
});
await new Promise((r) => setTimeout(r, 2000)); // let the clip index see it
let found: any = await findTrack("copper", "pounding dark warehouse techno");
if (!found.results.some((h: any) => h.clipId === clipId.toHexString())) {
  await new Promise((r) => setTimeout(r, 4000));
  found = await findTrack("copper", "pounding dark warehouse techno");
}
const hit = found.results.find((h: any) => h.clipId === clipId.toHexString());
check("V2 the composed clip is findable by description", Boolean(hit), { rank: found.results.findIndex((h: any) => h.clipId === clipId.toHexString()) + 1, results: found.results.map((h: any) => `${h.trackId}:${h.score}`) });
const served = (await api("GET", `/api/clip/${clipId.toHexString()}`)).status;
check("V2 the clip's sound is served before forget", served === 200, { status: served });

// Forget me, then everything must be gone
const receipt = (await api("POST", "/api/forget", { personId })).json;
const after = (await api("GET", `/api/clip/${clipId.toHexString()}`)).status;
const again: any = await findTrack("copper", "pounding dark warehouse techno");
check("forget removed the like", ((await api("GET", `/api/me?personId=${personId}`)).json.taps ?? []).length === 0, { totalAfter: receipt.totalAfter, composedClipsRemoved: receipt.composedClipsRemoved });
check("V2 after forget the clip URL is 404", after === 404, { status: after });
check("V2 after forget the clip is not findable", !again.results.some((h: any) => h.clipId === clipId.toHexString()), again.results.map((h: any) => h.trackId));
check("no copy of the guest id or the words anywhere", (await docsContaining(personId)) + (await docsContaining(words)) === 0, { id: await docsContaining(personId), words: await docsContaining(words) });
if (await d.collection(DERIVED).findOne({ _id: clipId })) await d.collection(DERIVED).deleteOne({ _id: clipId });
console.log(failures ? `${failures} ${failures === 1 ? "check" : "checks"} failed` : "voyage smoke: all checks passed");
await closeAll();
process.exit(failures ? 1 : 0);
