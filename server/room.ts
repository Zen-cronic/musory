// The rooms: guests' taste, each venue's private crowd memory, and the pick for the next track.
// No model picks a track. The pick is Atlas Vector Search over the catalogue, with a query vector
// blended from the guests in the room, the venue's crowd memory and the current track.
import { ObjectId, type ClientSession, type Document } from "mongodb";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  client, db, redactError, loginName, isVenue,
  TRACKS, TAPS, DERIVED, CONSENTS, PRESENCE, SESSIONS, PREFS, PLAYS, TOMBSTONES,
  VENUES, VENUE_IDS, type VenueId,
} from "./db.js";
import { TRACKS as CATALOG, byId, GENRES } from "./catalog.js";
import { emit } from "./events.js";

const DAY = 86_400_000;
const GEN_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "public", "audio", "gen");
const PLAY_MS = Number(process.env.PLAY_MS || 15_000); // each clip is 15 s
const TONIGHT_MS = Number(process.env.TONIGHT_MS || 120_000); // demo clock for "tonight only"
const RECENT_TAP_MS = 120_000; // guests who just arrived or reacted in the last 2 minutes count 3x in the room blend
const TONIGHT_WINDOW_MS = 6 * 3600_000; // taps from tonight count 2x in a venue's crowd memory
export const W = { taste: 0.6, crowd: 0.25, now: 0.15 };
// Stage mode: the whole audience is the crowd. Tastes are rebuilt in batches and rooms re-pick at most every 2 s.
export const STAGE = process.env.STAGE === "1";
const dirtyTastes = new Set<string>();

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const fail = (status: number, message: string) => new HttpError(status, message);

// Vectors
const vec = new Map<string, number[]>();
export async function loadTracks() {
  const d = await db();
  for (const t of await d.collection(TRACKS).find({}, { projection: { embedding: 1 } }).toArray())
    vec.set(String(t._id), t.embedding as number[]);
  if (vec.size < CATALOG.length) throw new Error("Track catalogue missing; run pnpm setup:db");
}
const norm = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const addInto = (acc: number[], v: number[], w: number) => {
  for (let i = 0; i < acc.length; i++) acc[i] += v[i] * w;
};

type Tap = {
  _id: ObjectId; personId: string; venueId: VenueId; playId: string; trackId: string; genre: string; signal: number;
  at: Date; expiresAt: Date; scope: "long" | "tonight"; status: "current" | "superseded"; sessionId?: ObjectId;
  promotedBy?: string; contribute?: boolean; consentId: ObjectId;
};

/** A vector from reactions: likes pull toward a track, "not for me" pushes away at half strength. */
function vectorFromTaps(taps: Tap[]): number[] | null {
  if (!taps.length) return null;
  const acc = new Array(1024).fill(0);
  for (const t of taps) {
    const v = vec.get(t.trackId);
    if (v) addInto(acc, v, t.signal > 0 ? 1 : -0.5);
  }
  return norm(acc);
}
function genreWeights(taps: Tap[]): Record<string, number> {
  const w: Record<string, number> = {};
  for (const t of taps) if (t.signal > 0) w[t.genre] = (w[t.genre] ?? 0) + 1;
  const total = Object.values(w).reduce((s, x) => s + x, 0) || 1;
  for (const k of Object.keys(w)) w[k] = Math.round((w[k] / total) * 100) / 100;
  return w;
}

// Live context: the time of night sets the energy the room aims for
const HOURS = [
  { label: "10 pm", energy: 0.5 },
  { label: "11 pm", energy: 0.62 },
  { label: "12 am", energy: 0.72 },
  { label: "1 am", energy: 0.84 },
  { label: "2 am", energy: 0.72 },
];
let hourIdx = 2;
export const clockState = () => ({ hour: HOURS[hourIdx].label, energy: HOURS[hourIdx].energy });
export function nextHour() {
  hourIdx = (hourIdx + 1) % HOURS.length;
  emit("clock", clockState());
  for (const v of VENUE_IDS) scheduleRefresh(v, 0);
  return clockState();
}

// Taste: a guest's own, portable
const tasteEvidence = (personId: string) => ({
  personId,
  status: "current",
  $or: [{ scope: "long" }, { promotedBy: { $exists: true } }],
});

/** Rebuild one guest's taste from their own current taps. Long-term taps only, plus tonight taps they kept. */
export async function rebuildTaste(personId: string, session?: ClientSession) {
  const d = await db();
  const taps = (await d.collection(TAPS).find(tasteEvidence(personId), { session }).toArray()) as unknown as Tap[];
  const coll = d.collection(DERIVED);
  if (!taps.length) {
    await coll.deleteMany({ kind: "taste", ownerId: personId }, { session });
    return null;
  }
  const prev = await coll.findOne({ kind: "taste", ownerId: personId }, { session, projection: { version: 1 } });
  const doc = {
    kind: "taste",
    ownerId: personId,
    sourceOwners: [...new Set(taps.map((t) => t.personId))],
    derivedFrom: taps.map((t) => t._id),
    evidence: taps.map((t) => ({ tapId: t._id, scope: t.scope, ...(t.promotedBy ? { promotedBy: t.promotedBy } : {}) })),
    vector: vectorFromTaps(taps),
    weights: genreWeights(taps),
    likes: taps.filter((t) => t.signal > 0).length,
    skips: taps.filter((t) => t.signal < 0).length,
    version: ((prev?.version as number) ?? 0) + 1,
    at: new Date(),
  };
  await coll.replaceOne({ kind: "taste", ownerId: personId }, doc, { upsert: true, session });
  return doc;
}

/** Stage mode: rebuild many guests' tastes with one read and one bulk write. */
async function rebuildTastesBatch(ids: string[]) {
  ids.forEach((id) => dirtyTastes.delete(id));
  if (!ids.length) return;
  const d = await db();
  const taps = (await d
    .collection(TAPS)
    .find({ personId: { $in: ids }, status: "current", $or: [{ scope: "long" }, { promotedBy: { $exists: true } }] })
    .toArray()) as unknown as Tap[];
  const prev = await d.collection(DERIVED).find({ kind: "taste", ownerId: { $in: ids } }, { projection: { ownerId: 1, version: 1 } }).toArray();
  const ops = ids.map((id) => {
    const mine = taps.filter((t) => t.personId === id);
    const doc = {
      kind: "taste", ownerId: id, sourceOwners: [id], derivedFrom: mine.map((t) => t._id),
      evidence: mine.map((t) => ({ tapId: t._id, scope: t.scope, ...(t.promotedBy ? { promotedBy: t.promotedBy } : {}) })),
      vector: vectorFromTaps(mine), weights: genreWeights(mine), likes: mine.filter((t) => t.signal > 0).length, skips: mine.filter((t) => t.signal < 0).length,
      version: (((prev.find((p) => p.ownerId === id)?.version as number) ?? 0) + 1), at: new Date(),
    };
    return mine.length
      ? { replaceOne: { filter: { kind: "taste", ownerId: id }, replacement: doc, upsert: true } }
      : { deleteMany: { filter: { kind: "taste", ownerId: id } } };
  });
  await d.collection(DERIVED).bulkWrite(ops as never, { ordered: false });
}

// Crowd memory: each venue's own, private, 3+ people, no ids
type CrowdCalc = { vector: number[] | null; weights: Record<string, number>; contributors: number; tapIds: ObjectId[]; likes: number; skips: number };

async function crowdFromTaps(venueId: VenueId, opts: { excludePerson?: string; session?: ClientSession } = {}): Promise<CrowdCalc> {
  const d = await db();
  const q: Document = { venueId, contribute: true };
  if (opts.excludePerson) q.personId = { $ne: opts.excludePerson };
  const taps = (await d.collection(TAPS).find(q, { session: opts.session }).toArray()) as unknown as Tap[];
  const byPerson = new Map<string, Tap[]>();
  for (const t of taps) byPerson.set(t.personId, [...(byPerson.get(t.personId) ?? []), t]);
  const acc = new Array(1024).fill(0);
  let any = false;
  const now = Date.now();
  for (const list of byPerson.values()) {
    const v = vectorFromTaps(list);
    if (!v) continue;
    const tonight = list.some((t) => now - t.at.getTime() < TONIGHT_WINDOW_MS);
    addInto(acc, v, tonight ? 2 : 1);
    any = true;
  }
  return {
    vector: any ? norm(acc) : null,
    weights: genreWeights(taps),
    contributors: byPerson.size,
    tapIds: taps.map((t) => t._id),
    likes: taps.filter((t) => t.signal > 0).length,
    skips: taps.filter((t) => t.signal < 0).length,
  };
}

const lastCrowdRefusal: Partial<Record<VenueId, number>> = {};
/** Save a venue's crowd memory. Atlas refuses (121) a crowd note from fewer than 3 people; then only the pick is kept. */
export async function rebuildCrowd(venueId: VenueId, session?: ClientSession) {
  const d = await db();
  const c = await crowdFromTaps(venueId, { session });
  const coll = d.collection(DERIVED);
  if (!c.contributors) {
    await coll.deleteMany({ kind: "crowd", venueId }, { session });
    return null;
  }
  const doc = {
    kind: "crowd",
    venueId,
    distinctContributors: c.contributors,
    likes: c.likes,
    skips: c.skips,
    weights: c.weights,
    vector: c.vector,
    derivedFrom: c.tapIds,
    at: new Date(),
  };
  try {
    await coll.replaceOne({ kind: "crowd", venueId }, doc, { upsert: true, session });
    lastCrowdRefusal[venueId] = undefined;
    return doc;
  } catch (e) {
    const err = redactError(e);
    if (err.code !== 121) throw e;
    if (session) throw e; // inside a transaction the caller deletes instead
    await coll.deleteMany({ kind: "crowd", venueId });
    if (lastCrowdRefusal[venueId] !== c.contributors) {
      lastCrowdRefusal[venueId] = c.contributors;
      emit("refusal", {
        code: 121, codeName: "DocumentValidationFailure", venueId, where: `${DERIVED} (crowd memory)`,
        reason: `${VENUES[venueId].name}'s crowd memory needs at least 3 people; it has ${c.contributors}. Only the pick was kept.`,
      });
    }
    return null;
  }
}

// Who is in the room
type Guest = { personId: string; taste: number[] | null; tasteId?: ObjectId; tonight: number[] | null; recent: boolean; weights: Record<string, number> };

async function guestsIn(venueId: VenueId, excludePerson?: string): Promise<{ present: number; guests: Guest[] }> {
  const d = await db();
  const pres = await d.collection(PRESENCE).find({ venueId }).toArray();
  const ids = pres.map((p) => String(p.personId)).filter((p) => p !== excludePerson);
  if (!ids.length) return { present: 0, guests: [] };
  const now = new Date();
  const [consents, tastesAll, sessions, recent] = await Promise.all([
    d.collection(CONSENTS).find({ venueId, personId: { $in: ids }, scopes: "use_taste" }).toArray(),
    d.collection(DERIVED).find({ kind: "taste", ownerId: { $in: ids } }, { projection: { derivedFrom: 0, evidence: 0 } }).toArray(),
    d.collection(SESSIONS).find({ venueId, personId: { $in: ids }, expiresAt: { $gt: now } }).toArray(),
    d.collection(TAPS).distinct("personId", { venueId, personId: { $in: ids }, at: { $gt: new Date(Date.now() - RECENT_TAP_MS) } }),
  ]);
  const sharing = new Set(consents.map((c) => String(c.personId)));
  const tastes = tastesAll.filter((t) => sharing.has(String(t.ownerId)));
  const sessionIds = sessions.filter((s) => sharing.has(String(s.personId))).map((s) => s._id);
  const tonightTaps = sessionIds.length
    ? ((await d.collection(TAPS).find({ sessionId: { $in: sessionIds }, status: "current" }).toArray()) as unknown as Tap[])
    : [];
  const recentTappers = new Set(recent.map(String));
  for (const p of pres) if (Date.now() - new Date(p.since as Date).getTime() < RECENT_TAP_MS) recentTappers.add(String(p.personId));
  const guests: Guest[] = [];
  for (const id of sharing) {
    const t = tastes.find((x) => x.ownerId === id);
    const mine = tonightTaps.filter((x) => x.personId === id);
    const tonight = vectorFromTaps(mine);
    if (!t?.vector && !tonight) continue;
    guests.push({
      personId: id,
      taste: (t?.vector as number[]) ?? null,
      tasteId: t?._id as ObjectId | undefined,
      tonight,
      recent: recentTappers.has(id),
      weights: tonight ? genreWeights(mine) : ((t?.weights as Record<string, number>) ?? {}),
    });
  }
  return { present: ids.length, guests };
}

// The pick
type Candidate = { trackId: string; title: string; genre: string; bpm: number; score: number };
export type RoomQuery = {
  vector: number[];
  parts: { taste: number; crowd: number; now: number };
  sharing: number;
  present: number;
  crowdContributors: number;
  mix: Record<string, number>;
  derivedFrom: ObjectId[];
};

async function roomQuery(venueId: VenueId, opts: { excludePerson?: string; crowd?: CrowdCalc | null } = {}): Promise<RoomQuery> {
  const nowTrack = catalogueId(rooms[venueId].play?.trackId ?? "t01");
  const crowdDocP = opts.crowd !== undefined || opts.excludePerson ? null : db().then((d) => d.collection(DERIVED).findOne({ kind: "crowd", venueId }));
  const { present, guests } = await guestsIn(venueId, opts.excludePerson);
  let crowdVec: number[] | null = null;
  let crowdWeights: Record<string, number> = {};
  let crowdContributors = 0;
  let crowdId: ObjectId | undefined;
  if (opts.crowd !== undefined || opts.excludePerson) {
    const c = opts.crowd !== undefined ? opts.crowd : await crowdFromTaps(venueId, { excludePerson: opts.excludePerson });
    if (c && c.contributors >= 3) {
      crowdVec = c.vector;
      crowdWeights = c.weights;
      crowdContributors = c.contributors;
    }
  } else {
    const doc = await crowdDocP;
    if (doc) {
      crowdVec = doc.vector as number[];
      crowdWeights = doc.weights as Record<string, number>;
      crowdContributors = doc.distinctContributors as number;
      crowdId = doc._id as ObjectId;
    }
  }
  // Guests in the room: each counts once; anyone who just arrived or reacted in the last 2 minutes counts 3x.
  let tasteVec: number[] | null = null;
  const tasteMix: Record<string, number> = {};
  if (guests.length) {
    const acc = new Array(1024).fill(0);
    let wsum = 0;
    for (const g of guests) {
      const w = g.recent ? 3 : 1;
      const v = g.tonight && g.taste ? norm(g.taste.map((x, i) => 0.3 * x + 0.7 * g.tonight![i])) : (g.tonight ?? g.taste)!;
      addInto(acc, v, w);
      wsum += w;
      for (const [k, x] of Object.entries(g.weights)) tasteMix[k] = (tasteMix[k] ?? 0) + (x * w);
    }
    for (const k of Object.keys(tasteMix)) tasteMix[k] /= wsum;
    tasteVec = norm(acc);
  }
  let parts = { ...W };
  if (!tasteVec && !crowdVec) parts = { taste: 0, crowd: 0, now: 1 };
  else if (!tasteVec) parts = { taste: 0, crowd: 0.6, now: 0.4 };
  else if (!crowdVec) parts = { taste: 0.75, crowd: 0, now: 0.25 };
  const acc = new Array(1024).fill(0);
  if (tasteVec) addInto(acc, tasteVec, parts.taste);
  if (crowdVec) addInto(acc, crowdVec, parts.crowd);
  addInto(acc, vec.get(nowTrack)!, parts.now);
  const mix: Record<string, number> = {};
  const nowGenre = byId.get(nowTrack)?.genre ?? "house";
  for (const [k, x] of Object.entries(tasteMix)) mix[k] = (mix[k] ?? 0) + x * parts.taste;
  for (const [k, x] of Object.entries(crowdWeights)) mix[k] = (mix[k] ?? 0) + x * parts.crowd;
  mix[nowGenre] = (mix[nowGenre] ?? 0) + parts.now;
  for (const k of Object.keys(mix)) mix[k] = Math.round(mix[k] * 100) / 100;
  const derivedFrom = [...guests.map((g) => g.tasteId).filter(Boolean), ...(crowdId ? [crowdId] : [])] as ObjectId[];
  return { vector: norm(acc), parts, sharing: guests.length, present, crowdContributors, mix, derivedFrom };
}

async function recentlyPlayed(venueId: VenueId): Promise<string[]> {
  const d = await db();
  const plays = await d.collection(PLAYS).find({ venueId }).sort({ startedAt: -1 }).limit(6).toArray();
  return [...new Set(plays.map((p) => String(p.trackId)))];
}

/** Atlas Vector Search (exact) over the catalogue, pre-filtered on the hour's energy and the current BPM, without recent repeats. */
export const BPM_RANGE = 50;
export const ENERGY_RANGE = 0.3;
async function vectorSearch(queryVector: number[], exclude: string[], nowBpm: number, k = 5): Promise<Candidate[]> {
  const d = await db();
  const e = clockState().energy;
  const run = (filter?: Document) =>
    d
      .collection(TRACKS)
      .aggregate([
        { $vectorSearch: { index: "vec_tracks", path: "embedding", queryVector, exact: true, limit: 15, ...(filter ? { filter } : {}) } },
        { $match: { _id: { $nin: exclude } } },
        { $limit: k },
        { $project: { title: 1, genre: 1, bpm: 1, score: { $meta: "vectorSearchScore" } } },
      ])
      .toArray();
  let rows = await run({
    $and: [{ energy: { $gte: e - ENERGY_RANGE, $lte: e + ENERGY_RANGE } }, { bpm: { $gte: nowBpm - BPM_RANGE, $lte: nowBpm + BPM_RANGE } }],
  });
  if (!rows.length) rows = await run();
  return rows.map((r) => ({ trackId: String(r._id), title: r.title, genre: r.genre, bpm: r.bpm, score: Math.round(r.score * 10000) / 10000 }));
}

export async function computePick(venueId: VenueId, opts: { excludePerson?: string; crowd?: CrowdCalc | null } = {}) {
  const [q, exclude] = await Promise.all([roomQuery(venueId, opts), recentlyPlayed(venueId)]);
  const nowTrack = catalogueId(rooms[venueId].play?.trackId ?? "t01");
  if (!exclude.includes(nowTrack)) exclude.push(nowTrack);
  const bpm = byId.get(nowTrack)?.bpm ?? 124;
  const [candidates, baseline] = await Promise.all([vectorSearch(q.vector, exclude, bpm), vectorSearch(vec.get(nowTrack)!, exclude, bpm, 3)]);
  return { q, candidates, baseline };
}

/** Pick the next track for a room and store the decision next to the pick with no memory. */
export async function decide(venueId: VenueId) {
  const t0 = Date.now();
  const { q, candidates, baseline } = await computePick(venueId);
  const picked = candidates[0] ?? null;
  const baselinePick = baseline[0] ?? null;
  const decision = {
    kind: "decision",
    venueId,
    at: new Date(),
    picked,
    baselinePick,
    candidates,
    memoryChangedPick: Boolean(picked && baselinePick && picked.trackId !== baselinePick.trackId),
    presentCount: q.present,
    sharingCount: q.sharing,
    crowdContributors: q.crowdContributors,
    parts: q.parts,
    mix: q.mix,
    energyTarget: clockState().energy,
    hour: clockState().hour,
    derivedFrom: q.derivedFrom,
  };
  const d = await db();
  await d.collection(DERIVED).insertOne(decision);
  rooms[venueId].next = decision;
  try {
    decisionHook?.(venueId, decision);
  } catch (e) {
    console.error("decision hook", (e as Error).message);
  }
  emit("vector_search", {
    venueId,
    source: "room blend",
    parts: q.parts,
    sharing: q.sharing,
    crowdContributors: q.crowdContributors,
    exact: true,
    filter: {
      energy: [Math.round((clockState().energy - ENERGY_RANGE) * 100) / 100, Math.round((clockState().energy + ENERGY_RANGE) * 100) / 100],
      bpm: [(byId.get(rooms[venueId].play?.trackId ?? "t01")?.bpm ?? 124) - BPM_RANGE, (byId.get(rooms[venueId].play?.trackId ?? "t01")?.bpm ?? 124) + BPM_RANGE],
    },
    topK: candidates.map((c) => ({ trackId: c.trackId, title: c.title, genre: c.genre, score: c.score })),
    baseline: baseline.map((c) => ({ trackId: c.trackId, title: c.title, genre: c.genre, score: c.score })),
    ms: Date.now() - t0,
  });
  return decision;
}

// Refresh: crowd memory then the pick, at most once a second per room
const refreshState: Record<VenueId, { running: boolean; dirty: boolean; last: number; timer?: NodeJS.Timeout; waiters: (() => void)[] }> = {
  copper: { running: false, dirty: false, last: 0, waiters: [] },
  basement: { running: false, dirty: false, last: 0, waiters: [] },
};
const MIN_GAP_MS = Number(process.env.REFRESH_GAP_MS || (STAGE ? 2000 : 1000));

export function scheduleRefresh(venueId: VenueId, delay?: number): Promise<void> {
  const s = refreshState[venueId];
  return new Promise((resolve) => {
    s.waiters.push(resolve);
    if (s.running) {
      s.dirty = true;
      return;
    }
    if (s.timer) return;
    const wait = delay ?? Math.max(0, s.last + MIN_GAP_MS - Date.now());
    s.timer = setTimeout(() => runRefresh(venueId), wait);
  });
}
async function runRefresh(venueId: VenueId) {
  const s = refreshState[venueId];
  s.timer = undefined;
  s.running = true;
  const waiters = s.waiters.splice(0);
  try {
    if (dirtyTastes.size) await rebuildTastesBatch([...dirtyTastes].splice(0));
    await rebuildCrowd(venueId);
    await decide(venueId);
  } catch (e) {
    console.error("refresh failed", venueId, redactError(e).message);
  }
  s.running = false;
  s.last = Date.now();
  waiters.forEach((w) => w());
  if (s.dirty || s.waiters.length) {
    s.dirty = false;
    s.timer = setTimeout(() => runRefresh(venueId), MIN_GAP_MS);
  }
}

// The player: each room plays its latest pick when the current clip ends
type Play = {
  playId: string; trackId: string; startedAt: number; endsAt: number;
  // The decision that chose this track: did memory change it, and what would have played with no memory.
  memoryChangedPick: boolean; baselinePick: { trackId: string; title: string; genre: string } | null;
};
export type ClipMeta = { trackId: string; clipId: string; title: string; genre: string; bpm: number; audio: string; descriptor: string; anchorTrackId?: string };
export const rooms: Record<VenueId, { play: Play | null; next: Document | null; queued?: ClipMeta }> = {
  copper: { play: null, next: null },
  basement: { play: null, next: null },
};
// Clips composed live by ElevenLabs Music for a room, by play track id.
const genClips = new Map<string, ClipMeta>();
/** Queue a composed clip to play next in a room. Taps on it count as taps on the catalogue track it was composed around. */
export function queueClip(venueId: VenueId, meta: ClipMeta) {
  const anchor = (rooms[venueId].next?.picked?.trackId as string) ?? rooms[venueId].play?.trackId ?? "t01";
  const m = { ...meta, anchorTrackId: byId.has(anchor) ? anchor : "t01" };
  genClips.set(m.trackId, m);
  rooms[venueId].queued = m;
}
// Bumped by every forget me: a track still being composed when a guest is forgotten is thrown away.
export let forgetEpoch = 0;
// Venues whose next pick follows a simulated-guests run: live music may compose sooner for them.
export const composeSoon = new Set<VenueId>();
// Live music registers here: it hears every new pick, and tells the room when a track is being made.
let decisionHook: ((venueId: VenueId, decision: Document) => void) | null = null;
export const setDecisionHook = (fn: (venueId: VenueId, decision: Document) => void) => (decisionHook = fn);
let composing: (venueId: VenueId) => boolean = () => false;
export const setComposingCheck = (fn: (venueId: VenueId) => boolean) => (composing = fn);
/** The leading sound of what a room is playing now. */
export const currentGenre = (venueId: VenueId) => {
  const id = rooms[venueId].play?.trackId ?? "";
  return genClips.get(id)?.genre.split(" + ")[0] ?? byId.get(id)?.genre ?? "house";
};
/** A composed clip's record is gone (expired or forgotten): it must not play. */
export function dropQueuedClip(clipId: string) {
  if (!clipId) return;
  for (const [k, m] of genClips) if (m.clipId === clipId) genClips.delete(k);
  for (const v of VENUE_IDS) if (rooms[v].queued?.clipId === clipId) rooms[v].queued = undefined;
}
/** The catalogue track behind what a room is playing (a composed clip maps to the track it was built around). */
const catalogueId = (trackId: string) => (byId.has(trackId) ? trackId : genClips.get(trackId)?.anchorTrackId ?? "t01");

export async function advance(venueId: VenueId) {
  const r = rooms[venueId];
  const queued = r.queued;
  r.queued = undefined;
  const trackId: string = queued?.trackId ?? r.next?.picked?.trackId ?? (venueId === "copper" ? "t01" : "t11");
  const now = Date.now();
  const playId = new ObjectId().toHexString();
  const bp = r.next?.picked?.trackId === trackId || queued ? (r.next?.baselinePick as Candidate | null) : null;
  r.play = {
    playId, trackId, startedAt: now, endsAt: now + PLAY_MS,
    memoryChangedPick: Boolean(bp && bp.trackId !== trackId),
    baselinePick: bp ? { trackId: bp.trackId, title: bp.title, genre: bp.genre } : null,
  };
  const d = await db();
  await d.collection(PLAYS).insertOne({
    _id: playId as never, venueId, trackId, startedAt: new Date(now), endsAt: new Date(now + PLAY_MS),
    picked: r.next ? { memoryChangedPick: r.next.memoryChangedPick, baseline: r.next.baselinePick?.trackId ?? null } : null,
  });
  void scheduleRefresh(venueId, 0);
}

/** Run a refresh right away (waiting for one already running), so a room re-picks from committed data. */
export async function refreshNow(venueId: VenueId) {
  const s = refreshState[venueId];
  while (s.running) await new Promise((r) => setTimeout(r, 25));
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = undefined;
  }
  await runRefresh(venueId);
}

// After a guest acts, the room re-picks; if the pick moved to another sound and the current clip has
// played for a few seconds, the room crossfades to it now instead of waiting for the clip to end.
const MIN_DWELL_MS = Number(process.env.MIN_DWELL_MS || 4000);
export async function afterAction(venueId: VenueId, force = false) {
  if (force) await refreshNow(venueId);
  else await scheduleRefresh(venueId);
  const r = rooms[venueId];
  const nowGenre = byId.get(catalogueId(r.play?.trackId ?? ""))?.genre;
  const nextGenre = r.next?.picked?.genre;
  const played = Date.now() - (r.play?.startedAt ?? 0);
  // While a new track is being made for this room, let it arrive (or the 10 s fallback fire) instead.
  if (!force && composing(venueId)) return;
  if (force || (nextGenre && nextGenre !== nowGenre && played >= MIN_DWELL_MS)) await advance(venueId);
}

let ticking = false;
// While forget-me runs, rooms hold the current clip so "the pick without you" stays the pick they play.
const hold = new Set<VenueId>();
export function startPlayer() {
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const v of VENUE_IDS) {
        const p = rooms[v].play;
        if (hold.has(v)) continue;
        if (!p || Date.now() >= p.endsAt) await advance(v);
      }
    } catch (e) {
      console.error("player tick failed", redactError(e).message);
    }
    ticking = false;
  }, 400).unref();
}

export const playView = (venueId: VenueId) => {
  const p = rooms[venueId].play;
  if (!p) return null;
  const g = genClips.get(p.trackId);
  if (g) return { ...p, title: g.title, genre: g.genre, bpm: g.bpm, audio: g.audio, descriptor: g.descriptor, composed: true, provenance: "Made just now for this room" };
  const t = byId.get(p.trackId)!;
  return { ...p, title: t.title, genre: t.genre, bpm: t.bpm, audio: t.audio, descriptor: t.descriptor, composed: false, provenance: "From the room's catalogue" };
};

// Guests
const PERSON = /^[a-z0-9-]{4,40}$/;
export function personOf(p: unknown): string {
  const s = String(p ?? "");
  if (!PERSON.test(s)) throw fail(400, "Unknown guest");
  return s;
}
/** A short, non-reversible tag a phone can compute for its own id (FNV-1a, 32-bit). */
export function guestTag(personId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < personId.length; i++) {
    h ^= personId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
const NAMED: Record<string, string> = { "g-jess": "Jess" };
export const guestLabel = (personId: string) => {
  if (NAMED[personId]) return NAMED[personId];
  const sim = /^sim-(\d+)$/.exec(personId);
  if (sim) return `Simulated guest ${sim[1]}`;
  let h = 0;
  for (const ch of personId) h = (h * 31 + ch.charCodeAt(0)) % 90;
  return `Guest ${h + 10}`;
};

export async function checkin(personId: string, venueId: VenueId, scopes: string[]) {
  const d = await db();
  const allowed = scopes.filter((s) => s === "use_taste" || s === "contribute_crowd");
  const now = new Date();
  const prev = await d.collection(PRESENCE).findOne({ personId });
  await d.collection(CONSENTS).updateOne(
    { personId, venueId },
    { $set: { scopes: allowed, grantedAt: now, expiresAt: new Date(now.getTime() + 8 * 3600_000) } },
    { upsert: true },
  );
  // One room at a time. The _id names the venue, so an expiry (TTL delete) still says which room to re-mix.
  await d.collection(PRESENCE).deleteMany({ personId, venueId: { $ne: venueId } });
  await d.collection(PRESENCE).updateOne(
    { _id: `${venueId}|${personId}` as never },
    { $set: { personId, venueId, since: now, expiresAt: new Date(now.getTime() + 3 * 3600_000) } },
    { upsert: true },
  );
  emitPresence(venueId);
  if (prev && prev.venueId !== venueId && isVenue(prev.venueId)) {
    emitPresence(prev.venueId);
    void scheduleRefresh(prev.venueId, 0);
  }
  void afterAction(venueId).catch((e) => console.error("after check-in", redactError(e).message));
  return me(personId);
}

export async function checkout(personId: string) {
  const d = await db();
  const prev = await d.collection(PRESENCE).findOneAndDelete({ personId });
  await d.collection(SESSIONS).deleteMany({ personId });
  if (prev && isVenue(prev.venueId)) {
    emitPresence(prev.venueId);
    await scheduleRefresh(prev.venueId, 0);
  }
  return me(personId);
}

export async function emitPresence(venueId: VenueId) {
  const d = await db();
  emit("presence", { venueId, count: await d.collection(PRESENCE).countDocuments({ venueId }) });
}

/** A guest's reaction to the track playing now, or to a short sample they picked to start their taste. */
const buckets = new Map<string, { tokens: number; at: number }>();
function allowTap(personId: string) {
  const now = Date.now();
  const b = buckets.get(personId) ?? { tokens: 3, at: now };
  b.tokens = Math.min(3, b.tokens + (now - b.at) / 1000);
  b.at = now;
  buckets.set(personId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
export async function tap(personId: string, signal: number, sampleTrackId?: string) {
  if (!allowTap(personId)) throw fail(429, "One tap a second, please.");
  const d = await db();
  const pres = await d.collection(PRESENCE).findOne({ personId });
  if (!pres || !isVenue(pres.venueId)) throw fail(409, "Check in to a venue first.");
  const venueId = pres.venueId as VenueId;
  const consent = await d.collection(CONSENTS).findOne({ personId, venueId });
  if (!consent) throw fail(409, "Check in to a venue first.");
  const live = rooms[venueId].play;
  if (sampleTrackId && !byId.has(sampleTrackId)) throw fail(404, "Unknown track");
  const play = sampleTrackId ? { playId: `sample-${sampleTrackId}`, trackId: sampleTrackId } : live ? { playId: live.playId, trackId: catalogueId(live.trackId) } : null;
  if (!play) throw fail(409, "Nothing is playing yet.");
  const track = byId.get(play.trackId)!;
  const now = new Date();
  const session = await d.collection(SESSIONS).findOne({ personId, venueId, expiresAt: { $gt: now } });
  const doc = {
    personId, venueId, playId: play.playId, trackId: play.trackId, genre: track.genre,
    signal: signal > 0 ? 1 : -1, at: now,
    expiresAt: session ? (session.expiresAt as Date) : new Date(now.getTime() + 180 * DAY),
    consentId: consent._id, scope: session ? "tonight" : "long", status: "current",
    contribute: (consent.scopes as string[]).includes("contribute_crowd"),
    ...(session ? { sessionId: session._id } : {}),
  };
  try {
    await d.collection(TAPS).insertOne(doc);
  } catch (e) {
    const err = redactError(e);
    if (err.code === 11000) {
      emit("refusal", { code: 11000, codeName: "DuplicateKey", venueId, where: TAPS, reason: "Already counted: one reaction per guest per track." });
      return { already: true, message: "Already counted. One reaction per track.", me: STAGE ? null : await me(personId) };
    }
    throw e;
  }
  if (doc.scope === "long") {
    if (STAGE) dirtyTastes.add(personId);
    else await rebuildTaste(personId);
  }
  void afterAction(venueId).catch((e) => console.error("after tap", redactError(e).message));
  return { already: false, message: signal > 0 ? `Saved: you like ${track.genre}.` : "Saved: not for you.", me: STAGE ? null : await me(personId) };
}

/** "Bored of this": the guest's likes of the current genre are superseded (kept, with who and when). */
export async function bored(personId: string) {
  const d = await db();
  const pres = await d.collection(PRESENCE).findOne({ personId });
  if (!pres || !isVenue(pres.venueId)) throw fail(409, "Check in to a venue first.");
  const venueId = pres.venueId as VenueId;
  const genre = byId.get(catalogueId(rooms[venueId].play?.trackId ?? ""))?.genre;
  if (!genre) throw fail(409, "Nothing is playing yet.");
  const c = await client("app");
  let result: Document = {};
  await c.withSession((session) =>
    session.withTransaction(async () => {
      const likes = await d.collection(TAPS).find({ personId, genre, signal: 1, status: "current", scope: "long" }, { session, projection: { _id: 1 } }).toArray();
      if (!likes.length) {
        result = { superseded: 0, genre };
        return;
      }
      const at = new Date();
      const pref = await d.collection(PREFS).insertOne({ personId, kind: "bored", genre, at, by: personId, supersedes: likes.map((l) => l._id) }, { session });
      await d.collection(TAPS).updateMany(
        { _id: { $in: likes.map((l) => l._id) } },
        { $set: { status: "superseded", supersededAt: at, supersededBy: pref.insertedId } },
        { session },
      );
      const taste = await rebuildTaste(personId, session);
      result = { superseded: likes.length, genre, prefId: String(pref.insertedId), at, tasteVersion: taste?.version ?? 0 };
    }),
  );
  emit("txn", { op: "bored", venueId, counts: { superseded: result.superseded ?? 0, prefs: result.superseded ? 1 : 0, tasteRebuilt: result.superseded ? 1 : 0 }, genre });
  if (result.superseded) await afterAction(venueId, true);
  return { ...result, me: await me(personId) };
}

export async function undoBored(personId: string, prefId: string) {
  const d = await db();
  const id = new ObjectId(prefId);
  const c = await client("app");
  let restored = 0;
  await c.withSession((session) =>
    session.withTransaction(async () => {
      const pref = await d.collection(PREFS).findOne({ _id: id, personId }, { session });
      if (!pref) throw fail(404, "Nothing to undo.");
      const r = await d.collection(TAPS).updateMany(
        { supersededBy: id },
        { $set: { status: "current" }, $unset: { supersededAt: "", supersededBy: "" } },
        { session },
      );
      restored = r.modifiedCount;
      await d.collection(PREFS).deleteOne({ _id: id }, { session });
      await rebuildTaste(personId, session);
    }),
  );
  emit("txn", { op: "undo_bored", counts: { restored } });
  const pres = await d.collection(PRESENCE).findOne({ personId });
  if (pres && isVenue(pres.venueId)) await afterAction(pres.venueId, true);
  return { restored, me: await me(personId) };
}

// "Tonight only": a session tied to one venue, with an end time
export async function startTonight(personId: string) {
  const d = await db();
  const pres = await d.collection(PRESENCE).findOne({ personId });
  if (!pres || !isVenue(pres.venueId)) throw fail(409, "Check in to a venue first.");
  const venueId = pres.venueId as VenueId;
  await d.collection(SESSIONS).deleteMany({ personId });
  const expiresAt = new Date(Date.now() + TONIGHT_MS);
  await d.collection(SESSIONS).insertOne({ personId, venueId, mode: "tonight", startedAt: new Date(), expiresAt });
  emit("tonight", { venueId, active: true, expiresAt });
  setTimeout(() => {
    emit("tonight", { venueId, active: false });
    void scheduleRefresh(venueId, 0);
  }, TONIGHT_MS + 200).unref();
  await scheduleRefresh(venueId, 0);
  return me(personId);
}
export async function endTonight(personId: string) {
  const d = await db();
  const s = await d.collection(SESSIONS).findOneAndDelete({ personId });
  if (s && isVenue(s.venueId)) {
    emit("tonight", { venueId: s.venueId, active: false });
    await scheduleRefresh(s.venueId, 0);
  }
  return me(personId);
}
/** "Keep this one": the guest promotes one tonight-only like into their long-term taste. */
export async function keepTonightTap(personId: string, tapId: string) {
  const d = await db();
  const r = await d.collection(TAPS).updateOne({ _id: new ObjectId(tapId), personId, scope: "tonight" }, { $set: { promotedBy: personId } });
  if (!r.matchedCount) throw fail(404, "That tap isn't a tonight-only tap of yours.");
  const taste = await rebuildTaste(personId);
  emit("txn", { op: "keep_tonight_tap", counts: { promoted: 1, tasteRebuilt: taste ? 1 : 0 } });
  return me(personId);
}

// Forget me: one $graphLookup and one transaction, across every venue
const hmac = (personId: string) => createHmac("sha256", process.env.TOMBSTONE_HMAC_KEY || "musory").update(personId).digest("hex");

async function countFor(personId: string, session?: ClientSession) {
  const d = await db();
  const tapIds = (await d.collection(TAPS).find({ personId }, { session, projection: { _id: 1 } }).toArray()).map((t) => t._id);
  const taste = await d.collection(DERIVED).findOne({ kind: "taste", ownerId: personId }, { session, projection: { _id: 1 } });
  const crowdLinks = tapIds.length
    ? await d.collection(DERIVED).find({ kind: "crowd", derivedFrom: { $in: tapIds } }, { session, projection: { venueId: 1 } }).toArray()
    : [];
  const [decisionLinks, consents, presence, sessions, prefs, composedClips] = await Promise.all([
    taste ? d.collection(DERIVED).countDocuments({ kind: "decision", derivedFrom: taste._id }, { session }) : 0,
    d.collection(CONSENTS).countDocuments({ personId }, { session }),
    d.collection(PRESENCE).countDocuments({ personId }, { session }),
    d.collection(SESSIONS).countDocuments({ personId }, { session }),
    d.collection(PREFS).countDocuments({ personId }, { session }),
    tapIds.length ? d.collection(DERIVED).countDocuments({ kind: "clip", derivedFrom: { $in: tapIds } }, { session }) : 0,
  ]);
  const counts = { taps: tapIds.length, taste: taste ? 1 : 0, consents, presence, sessions, prefs, crowdMemories: crowdLinks.length, decisionLinks, composedClips };
  return { counts, total: Object.values(counts).reduce((s, x) => s + x, 0), crowdVenues: crowdLinks.map((c) => String(c.venueId)) };
}

export async function forget(personId: string) {
  forgetEpoch++;
  VENUE_IDS.forEach((v) => hold.add(v));
  try {
    return await forgetInner(personId);
  } finally {
    VENUE_IDS.forEach((v) => hold.delete(v));
  }
}

/** What each room would play next if this guest had never been here: the same function forget-me checks against. */
export async function withoutYou(personId: string) {
  const out = await Promise.all(
    VENUE_IDS.map(async (v) => {
      const cf = await computePick(v, { excludePerson: personId });
      const w = cf.candidates[0];
      const withYou = rooms[v].next?.picked as Candidate | undefined;
      return {
        venueId: v,
        venue: VENUES[v].name,
        withYou: withYou ? { trackId: withYou.trackId, title: withYou.title, genre: withYou.genre } : null,
        withoutYou: w ? { trackId: w.trackId, title: w.title, genre: w.genre } : null,
      };
    }),
  );
  return { venues: out };
}

async function forgetInner(personId: string) {
  const d = await db();
  const before = await countFor(personId);
  // What each room would pick if this guest had never been here: computed before anything is deleted.
  const counterfactual: Partial<Record<VenueId, Candidate | null>> = {};
  const pickBefore: Partial<Record<VenueId, Candidate | null>> = {};
  const crowdBefore: Partial<Record<VenueId, number>> = {};
  const mixBefore: Partial<Record<VenueId, Record<string, number> | null>> = {};
  const mixAfter: Partial<Record<VenueId, Record<string, number> | null>> = {};
  await Promise.all(
    VENUE_IDS.map(async (v) => {
      pickBefore[v] = (rooms[v].next?.picked as Candidate) ?? null;
      const [crowd, cf] = await Promise.all([
        d.collection(DERIVED).findOne({ kind: "crowd", venueId: v }, { projection: { distinctContributors: 1, weights: 1 } }),
        computePick(v, { excludePerson: personId }),
      ]);
      crowdBefore[v] = (crowd?.distinctContributors as number) ?? 0;
      mixBefore[v] = (crowd?.weights as Record<string, number>) ?? null;
      counterfactual[v] = cf.candidates[0] ?? null;
    }),
  );
  const c = await client("app");
  let graph: { depth0: number; depth1: number; venues: string[] } = { depth0: 0, depth1: 0, venues: [] };
  let clipIds: ObjectId[] = [];
  const crowdAfter: Partial<Record<VenueId, number>> = {};
  const t0 = Date.now();
  await c.withSession((session) =>
    session.withTransaction(async () => {
      // Everything built from this guest's taps, at any depth: taste, crowd memories, decisions.
      const [closure] = await d
        .collection(TAPS)
        .aggregate(
          [
            { $match: { personId } },
            { $group: { _id: null, ids: { $push: "$_id" } } },
            { $graphLookup: { from: DERIVED, startWith: "$ids", connectFromField: "_id", connectToField: "derivedFrom", as: "closure", depthField: "depth" } },
            { $project: { closure: { _id: 1, kind: 1, venueId: 1, depth: 1 } } },
          ],
          { session },
        )
        .toArray();
      const nodes = (closure?.closure ?? []) as { _id: ObjectId; kind: string; venueId?: string; depth: number }[];
      const crowdVenues = [...new Set(nodes.filter((n) => n.kind === "crowd").map((n) => String(n.venueId)))] as VenueId[];
      graph = {
        depth0: nodes.filter((n) => n.depth === 0).length,
        depth1: nodes.filter((n) => n.depth === 1).length,
        venues: crowdVenues,
      };
      const taste = await d.collection(DERIVED).findOne({ kind: "taste", ownerId: personId }, { session, projection: { _id: 1 } });
      await d.collection(TAPS).deleteMany({ personId }, { session });
      await d.collection(DERIVED).deleteMany({ kind: "taste", ownerId: personId }, { session });
      await d.collection(CONSENTS).deleteMany({ personId }, { session });
      await d.collection(PRESENCE).deleteMany({ personId }, { session });
      await d.collection(SESSIONS).deleteMany({ personId }, { session });
      await d.collection(PREFS).deleteMany({ personId }, { session });
      // Clips composed while this guest's taste or taps were in a room's memory: our copies go too.
      clipIds = nodes.filter((n) => n.kind === "clip").map((n) => n._id);
      if (clipIds.length) await d.collection(DERIVED).deleteMany({ _id: { $in: clipIds } }, { session });
      if (taste) await d.collection(DERIVED).updateMany({ kind: "decision", derivedFrom: taste._id }, { $pull: { derivedFrom: taste._id } } as never, { session });
      // Rebuild each venue's crowd memory without this guest. Below 3 people it is removed, not kept.
      for (const v of crowdVenues) {
        const calc = await crowdFromTaps(v, { session });
        if (calc.contributors < 3) {
          // Not enough people left for a crowd memory: it is removed, and the room falls back to its default.
          await d.collection(DERIVED).deleteMany({ kind: "crowd", venueId: v }, { session });
          crowdAfter[v] = calc.contributors;
          mixAfter[v] = null;
        } else {
          mixAfter[v] = calc.weights;
          await d.collection(DERIVED).replaceOne(
            { kind: "crowd", venueId: v },
            { kind: "crowd", venueId: v, distinctContributors: calc.contributors, likes: calc.likes, skips: calc.skips, weights: calc.weights, vector: calc.vector, derivedFrom: calc.tapIds, at: new Date() },
            { session },
          );
          crowdAfter[v] = calc.contributors;
        }
      }
      await d.collection(TOMBSTONES).insertOne(
        { hmac: hmac(personId), at: new Date(), removed: before.counts, venuesRebuilt: crowdVenues },
        { session },
      );
    }),
  );
  const txnMs = Date.now() - t0;
  for (const id of clipIds) {
    const hex = id.toHexString();
    rmSync(path.join(GEN_DIR, `${hex}.mp3`), { force: true });
    for (const [k, m] of genClips) if (m.clipId === hex) genClips.delete(k);
    for (const v of VENUE_IDS) if (rooms[v].queued?.clipId === hex) rooms[v].queued = undefined;
  }
  // Both rooms re-pick from the committed data and play the new pick now.
  const [after] = await Promise.all([countFor(personId), ...VENUE_IDS.map((v) => afterAction(v, true))]);
  const venues = [];
  for (const v of VENUE_IDS) {
    const now = rooms[v].play ? (byId.get(rooms[v].play!.trackId) ? { ...byId.get(rooms[v].play!.trackId)!, trackId: rooms[v].play!.trackId } : null) : null;
    venues.push({
      venueId: v,
      venue: VENUES[v].name,
      crowdContributorsBefore: crowdBefore[v] ?? 0,
      crowdContributorsAfter: crowdAfter[v] ?? crowdBefore[v] ?? 0,
      crowdMemoryKept: (crowdAfter[v] ?? crowdBefore[v] ?? 0) >= 3,
      crowdMixBefore: mixBefore[v] ?? null,
      crowdMixAfter: graph.venues.includes(v) ? (mixAfter[v] ?? null) : (mixBefore[v] ?? null),
      contributionRemoved: graph.venues.includes(v),
      pickBefore: pickBefore[v] ? { trackId: pickBefore[v]!.trackId, title: pickBefore[v]!.title, genre: pickBefore[v]!.genre } : null,
      pickAfter: now ? { trackId: now.trackId, title: now.title, genre: now.genre } : null,
      pickWithoutYou: counterfactual[v] ? { trackId: counterfactual[v]!.trackId, title: counterfactual[v]!.title, genre: counterfactual[v]!.genre } : null,
      matchesWithoutYou: Boolean(now && counterfactual[v] && now.trackId === counterfactual[v]!.trackId),
    });
  }
  const receipt = { before: before.counts, totalBefore: before.total, totalAfter: after.total, graph, composedClipsRemoved: clipIds.length, txnMs, venues, at: new Date() };
  await d.collection(TOMBSTONES).updateOne({ hmac: hmac(personId) }, { $set: { venues: venues.map((v) => ({ venueId: v.venueId, matchesWithoutYou: v.matchesWithoutYou })) } });
  emit("txn", { op: "forget_me", counts: { ...before.counts, total: before.total, after: after.total }, graph, ms: txnMs });
  emit("forgotten", { label: guestLabel(personId), ...receipt });
  return receipt;
}

// What a guest sees about themselves
export async function me(personId: string) {
  const d = await db();
  const [pres, consents, taste, session, taps, prefs] = await Promise.all([
    d.collection(PRESENCE).findOne({ personId }),
    d.collection(CONSENTS).find({ personId }).toArray(),
    d.collection(DERIVED).findOne({ kind: "taste", ownerId: personId }, { projection: { vector: 0, derivedFrom: 0 } }),
    d.collection(SESSIONS).findOne({ personId, expiresAt: { $gt: new Date() } }),
    d.collection(TAPS).find({ personId }).sort({ at: -1 }).limit(30).toArray(),
    d.collection(PREFS).find({ personId }).sort({ at: -1 }).limit(5).toArray(),
  ]);
  const venueId = pres?.venueId as VenueId | undefined;
  // Your night: what this room played since you checked in (from the room's play log, no listening).
  const night = venueId
    ? await d.collection(PLAYS).find({ venueId, startedAt: { $gte: pres!.since as Date } }).sort({ startedAt: -1 }).limit(12).toArray()
    : [];
  return {
    night: night.map((p) => {
      const g = genClips.get(String(p.trackId));
      const t = byId.get(String(p.trackId));
      return { trackId: p.trackId, title: g?.title ?? t?.title ?? "Made for this room", genre: g?.genre ?? t?.genre ?? "", at: p.startedAt };
    }),
    personId,
    label: guestLabel(personId),
    venueId: venueId ?? null,
    venue: venueId ? VENUES[venueId].name : null,
    consents: consents.map((c) => ({ venueId: c.venueId, venue: VENUES[c.venueId as VenueId]?.name, scopes: c.scopes })),
    taste: taste ? { version: taste.version, weights: taste.weights, likes: taste.likes, skips: taste.skips, evidence: (taste.evidence as unknown[]).length } : null,
    tonight: session ? { venueId: session.venueId, expiresAt: session.expiresAt } : null,
    taps: taps.map((t) => ({
      tapId: String(t._id), venueId: t.venueId, trackId: t.trackId, title: byId.get(String(t.trackId))?.title, genre: t.genre,
      signal: t.signal, scope: t.scope, status: t.status, promoted: Boolean(t.promotedBy), at: t.at,
    })),
    bored: prefs.map((p) => ({ prefId: String(p._id), genre: p.genre, at: p.at, superseded: (p.supersedes as unknown[]).length })),
    nowPlaying: venueId ? playView(venueId) : null,
  };
}

// What a room screen shows
export async function roomState(venueId: VenueId) {
  const d = await db();
  return {
    venueId,
    venue: VENUES[venueId].name,
    play: playView(venueId),
    next: rooms[venueId].next ? { ...rooms[venueId].next, derivedFrom: undefined } : null,
    present: await d.collection(PRESENCE).countDocuments({ venueId }),
    tonight: await d.collection(SESSIONS).find({ venueId, expiresAt: { $gt: new Date() } }, { projection: { expiresAt: 1, _id: 0 } }).toArray(),
    clock: clockState(),
    memory: await venueMemory(venueId),
  };
}

/** A venue reads its own memory through its own database login and View. */
export async function venueMemory(venueId: VenueId) {
  try {
    const d = await db(VENUES[venueId].login);
    const view = VENUES[venueId].view;
    const crowd = await d.collection(view).findOne({ kind: "crowd" });
    const notes = await d.collection(view).find({ kind: "note" }).toArray();
    const decisions = await d.collection(view).countDocuments({ kind: "decision" });
    const changed = await d.collection(view).countDocuments({ kind: "decision", memoryChangedPick: true });
    return {
      login: loginName(VENUES[venueId].login),
      view,
      crowd: crowd ? { contributors: crowd.distinctContributors, likes: crowd.likes, skips: crowd.skips, weights: crowd.weights } : null,
      notes: notes.map((n) => n.text),
      decisions,
      memoryChangedPicks: changed,
    };
  } catch (e) {
    return { error: redactError(e) };
  }
}

// Proofs the database enforces, run live
export async function crossVenueRead(asVenue: VenueId, target: VenueId) {
  const d = await db(VENUES[asVenue].login);
  const view = VENUES[target].view;
  try {
    const rows = await d.collection(view).find({}).limit(3).toArray();
    return { ok: true, login: loginName(VENUES[asVenue].login), view, rows: rows.length };
  } catch (e) {
    const err = redactError(e);
    emit("refusal", {
      code: err.code, codeName: err.codeName, venueId: asVenue, where: view,
      reason: `${VENUES[asVenue].name}'s login asked for ${VENUES[target].name}'s crowd memory. Atlas refused.`,
    });
    return { ok: false, login: loginName(VENUES[asVenue].login), view, error: err };
  }
}

export async function venueReadsTaps(asVenue: VenueId) {
  const d = await db(VENUES[asVenue].login);
  try {
    await d.collection(TAPS).findOne({});
    return { ok: true };
  } catch (e) {
    const err = redactError(e);
    emit("refusal", { code: err.code, codeName: err.codeName, venueId: asVenue, where: TAPS, reason: `${VENUES[asVenue].name}'s login asked for guests' raw taps. Atlas refused.` });
    return { ok: false, login: loginName(VENUES[asVenue].login), coll: TAPS, error: err };
  }
}

async function tryInsert(label: string, reason: string, doc: Document, where = DERIVED) {
  const d = await db();
  try {
    const r = await d.collection(where).insertOne(doc);
    await d.collection(where).deleteOne({ _id: r.insertedId });
    return { ok: true, label };
  } catch (e) {
    const err = redactError(e);
    emit("refusal", { code: err.code, codeName: err.codeName, where, reason });
    return { ok: false, label, reason, error: { code: err.code, codeName: err.codeName } };
  }
}

export async function proof(name: string, personId?: string) {
  const d = await db();
  const anyTap = await d.collection(TAPS).findOne({});
  const tapId = anyTap?._id ?? new ObjectId();
  switch (name) {
    case "cross-venue":
      return crossVenueRead("basement", "copper");
    case "own-venue":
      return crossVenueRead("copper", "copper");
    case "venue-reads-taps":
      return venueReadsTaps("copper");
    case "crowd-under-3":
      return tryInsert("Crowd memory from 2 people", "A venue's crowd memory needs at least 3 people.", {
        kind: "crowd", venueId: "copper", distinctContributors: 2, derivedFrom: [tapId], at: new Date(),
      });
    case "others-taps":
      return tryInsert("Taste built from someone else's taps", "A guest's taste can only be built from their own taps.", {
        kind: "taste", ownerId: "g-ben", sourceOwners: ["g-ben", "g-carla"], derivedFrom: [tapId], evidence: [], at: new Date(),
      });
    case "identity-in-venue":
      return tryInsert("A guest id inside venue memory", "Venue memory can't hold a guest's id.", {
        kind: "decision", venueId: "copper", personId: personId ?? "g-ben", at: new Date(),
      });
    case "tonight-leak": {
      const t = await d.collection(TAPS).findOne({ scope: "tonight", promotedBy: { $exists: false }, ...(personId ? { personId } : {}) });
      const owner = (t?.personId as string) ?? personId ?? "g-ben";
      const taste = await d.collection(DERIVED).findOne({ kind: "taste", ownerId: owner });
      const base = taste ?? { kind: "taste", ownerId: owner, sourceOwners: [owner], derivedFrom: [tapId], evidence: [] };
      const doc = { ...base, evidence: [...((base.evidence as unknown[]) ?? []), { tapId: t?._id ?? tapId, scope: "tonight" }] };
      try {
        await d.collection(DERIVED).replaceOne({ kind: "taste", ownerId: owner }, doc, { upsert: true });
        return { ok: true, label: "Tonight-only tap into long-term taste" };
      } catch (e) {
        const err = redactError(e);
        const reason = "A tonight-only tap can't enter long-term taste unless the guest keeps it.";
        emit("refusal", { code: err.code, codeName: err.codeName, where: DERIVED, reason });
        return { ok: false, label: "Tonight-only tap into long-term taste", reason, error: { code: err.code, codeName: err.codeName }, usedRealTonightTap: Boolean(t) };
      }
    }
    case "double-tap": {
      const pres = await d.collection(PRESENCE).findOne(personId ? { personId } : {});
      if (!pres) throw fail(409, "Nobody is checked in.");
      const pid = String(pres.personId);
      const a = await tap(pid, 1).catch((e) => ({ error: redactError(e).message }));
      const b = await tap(pid, 1).catch((e) => ({ error: redactError(e).message }));
      return { first: a, second: b };
    }
  }
  throw fail(404, "Unknown proof");
}

/** The headline number, recomputed on demand. */
export async function headline() {
  const d = await db();
  const decisions = await d.collection(DERIVED).find({ kind: "decision", picked: { $ne: null } }, { projection: { memoryChangedPick: 1, sharingCount: 1, crowdContributors: 1 } }).toArray();
  const withMemory = decisions.filter((x) => (x.sharingCount as number) > 0 || (x.crowdContributors as number) > 0);
  const changed = withMemory.filter((x) => x.memoryChangedPick).length;
  const tombstones = await d.collection(TOMBSTONES).find({}).toArray();
  const forgotten = new Set(tombstones.map((t) => t.hmac));
  // Every guest id still anywhere in the database, hashed and checked against the forget-me receipts.
  const ids = new Set<string>([
    ...(await d.collection(TAPS).distinct("personId")),
    ...(await d.collection(CONSENTS).distinct("personId")),
    ...(await d.collection(PRESENCE).distinct("personId")),
    ...(await d.collection(SESSIONS).distinct("personId")),
    ...(await d.collection(PREFS).distinct("personId")),
    ...(await d.collection(DERIVED).distinct("ownerId")),
  ].map(String));
  const leftovers = [...ids].filter((id) => forgotten.has(hmac(id))).length;
  const checks = tombstones.flatMap((t) => (t.venues ?? []) as { matchesWithoutYou: boolean }[]);
  return {
    picks: withMemory.length,
    picksChangedByMemory: changed,
    forgotten: tombstones.length,
    recordsLeftForForgottenGuests: leftovers,
    roomPicksMatchingWithoutThem: checks.filter((c) => c.matchesWithoutYou).length,
    roomPicksChecked: checks.length,
    sentence:
      `${changed} of ${withMemory.length} picks tonight differ from the no-memory pick. ` +
      `${tombstones.length} guest(s) said forget me: ${leftovers} records left, and ${checks.filter((c) => c.matchesWithoutYou).length} of ${checks.length} room picks match the pick without them.`,
  };
}

// Reset and seed: two venues, their regulars from last weekend, one guest in each room
const REGULARS: { id: string; venue: VenueId; likes: string[]; skips?: string[]; present?: boolean }[] = [
  { id: "g-ben", venue: "copper", likes: ["t01", "t04", "t05", "t07"] },
  { id: "g-carla", venue: "copper", likes: ["t06", "t08", "t09"], skips: ["t11"] },
  { id: "g-tess", venue: "copper", likes: ["t01", "t10", "t09"] },
  { id: "g-joel", venue: "copper", likes: ["t05", "t07", "t08"] },
  { id: "g-mark", venue: "basement", likes: ["t11", "t13", "t14"] },
  { id: "g-julie", venue: "basement", likes: ["t15", "t16", "t12"] },
  { id: "g-sam", venue: "basement", likes: ["t13", "t18", "t11"], skips: ["t20"] },
  { id: "g-ray", venue: "basement", likes: ["t14", "t12", "t16"] },
];

// Resets run one at a time (two at once would collide on the unique indexes).
let resetChain: Promise<unknown> = Promise.resolve();
export function resetAndSeed() {
  const run = resetChain.then(() => resetInner());
  resetChain = run.catch(() => {});
  return run;
}
async function resetInner() {
  const d = await db();
  for (const c of [TAPS, DERIVED, CONSENTS, PRESENCE, SESSIONS, PREFS, PLAYS, TOMBSTONES]) await d.collection(c).deleteMany({});
  for (const v of VENUE_IDS) {
    await d.collection(DERIVED).insertOne({ kind: "note", venueId: v, text: VENUES[v].note, at: new Date() });
    rooms[v] = { play: null, next: null };
  }
  hourIdx = 2;
  const lastWeek = Date.now() - 7 * DAY;
  for (const r of REGULARS) {
    const consent = await d.collection(CONSENTS).insertOne({
      personId: r.id, venueId: r.venue, scopes: ["use_taste", "contribute_crowd"], grantedAt: new Date(lastWeek), expiresAt: new Date(Date.now() + 8 * 3600_000),
    });
    const docs = [...r.likes.map((t) => [t, 1] as const), ...(r.skips ?? []).map((t) => [t, -1] as const)].map(([trackId, signal], i) => {
      const at = new Date(lastWeek + i * 600_000);
      return {
        personId: r.id, venueId: r.venue, playId: `past-${r.venue}-${trackId}-${i}`, trackId, genre: byId.get(trackId)!.genre, signal,
        at, expiresAt: new Date(at.getTime() + 180 * DAY), consentId: consent.insertedId, scope: "long", status: "current", contribute: true,
      };
    });
    await d.collection(TAPS).insertMany(docs);
    await rebuildTaste(r.id);
    if (r.present)
      await d.collection(PRESENCE).insertOne({ _id: `${r.venue}|${r.id}` as never, personId: r.id, venueId: r.venue, since: new Date(), expiresAt: new Date(Date.now() + 3 * 3600_000) });
  }
  for (const v of VENUE_IDS) await rebuildCrowd(v);
  emit("reset", {});
  for (const v of VENUE_IDS) await advance(v);
  return { ok: true };
}

// Demo seed: one guest, Jess, whose portable taste is techno-heavy from last weekend
// at Basement 2. She is not checked in anywhere yet, so each scripted step lands the same way every run.
export const FILM_GUEST = { id: "g-jess", name: "Jess" };
export function filmReset() {
  const run = resetChain.then(() => filmInner());
  resetChain = run.catch(() => {});
  return run;
}
async function filmInner() {
  await resetInner();
  const d = await db();
  const at0 = Date.now() - 7 * DAY + 3600_000;
  const consent = await d.collection(CONSENTS).insertOne({
    personId: FILM_GUEST.id, venueId: "basement", scopes: ["use_taste", "contribute_crowd"], grantedAt: new Date(at0), expiresAt: new Date(Date.now() + 8 * 3600_000),
  });
  const likes = ["t11", "t13", "t14", "t12"];
  await d.collection(TAPS).insertMany(
    likes.map((trackId, i) => {
      const at = new Date(at0 + i * 600_000);
      return {
        personId: FILM_GUEST.id, venueId: "basement", playId: `past-basement-${trackId}-jess-${i}`, trackId, genre: byId.get(trackId)!.genre, signal: 1,
        at, expiresAt: new Date(at.getTime() + 180 * DAY), consentId: consent.insertedId, scope: "long", status: "current", contribute: true,
      };
    }),
  );
  await rebuildTaste(FILM_GUEST.id);
  // Four more guests already in Copper Room, checked in with consent but no taps yet.
  for (let i = 1; i <= 4; i++) await checkinQuiet(`sim-${i}`, "copper");
  await Promise.all(VENUE_IDS.map((v) => refreshNow(v)));
  return { ok: true, guest: FILM_GUEST, phone: `/p/${FILM_GUEST.id}?venue=copper`, consent: `/join?venue=copper&as=${FILM_GUEST.id}` };
}

async function checkinQuiet(personId: string, venueId: VenueId) {
  const d = await db();
  const now = new Date();
  await d.collection(CONSENTS).updateOne(
    { personId, venueId },
    { $set: { scopes: ["use_taste", "contribute_crowd"], grantedAt: now, expiresAt: new Date(now.getTime() + 8 * 3600_000) } },
    { upsert: true },
  );
  await d.collection(PRESENCE).deleteMany({ personId, venueId: { $ne: venueId } });
  await d.collection(PRESENCE).updateOne(
    { _id: `${venueId}|${personId}` as never },
    { $set: { personId, venueId, since: new Date(now.getTime() - 10 * 60_000), expiresAt: new Date(now.getTime() + 3 * 3600_000) } },
    { upsert: true },
  );
}

/**
 * Simulated guests (to try a room without phones): five seeded guests check in to a room and tap
 * "I like this" on two short samples of one sound. Deterministic: same guests, same samples, same order.
 * Default sound: disco if the room is playing something hard (techno, trance, drum & bass), otherwise techno.
 */
export async function simulateGuests(venueId: VenueId, genre?: string) {
  const hard = ["techno", "trance", "drum & bass"].includes(currentGenre(venueId));
  const target = genre && GENRES.includes(genre) ? genre : hard ? "disco" : "techno";
  const samples = CATALOG.filter((t) => t.genre === target).slice(0, 2).map((t) => t._id);
  const d = await db();
  const ids = [1, 2, 3, 4, 5].map((i) => `sim-${i}`);
  // Each simulated guest starts fresh for this sound: earlier simulated taps are cleared first.
  await Promise.all([d.collection(TAPS).deleteMany({ personId: { $in: ids } }), ...ids.map((id) => checkinQuiet(id, venueId))]);
  const consents = await d.collection(CONSENTS).find({ personId: { $in: ids }, venueId }).toArray();
  const now = Date.now();
  const docs = ids.flatMap((id, i) =>
    samples.map((trackId, k) => ({
      personId: id, venueId, playId: `sample-${trackId}`, trackId, genre: target, signal: 1,
      at: new Date(now + i * 10 + k), expiresAt: new Date(now + 180 * DAY), scope: "long", status: "current", contribute: true,
      consentId: consents.find((c) => c.personId === id)!._id,
    })),
  );
  await d.collection(TAPS).insertMany(docs);
  emit("simulated", { venueId, guests: ids.length, genre: target, samples });
  composeSoon.add(venueId);
  ids.forEach((id) => dirtyTastes.add(id)); // rebuilt in the room's next refresh, in one batch
  void refreshNow(venueId).then(() => afterAction(venueId)).catch(() => {});
  return { venueId, guests: ids.length, genre: target, taps: docs.length };
}

/** Load tests: remove every record of guests whose id starts with "load-", rebuild crowd memory, re-pick. */
export async function clearLoadGuests() {
  const d = await db();
  const q = { personId: { $regex: /^load-/ } };
  const taps = await d.collection(TAPS).deleteMany(q);
  await Promise.all([
    d.collection(CONSENTS).deleteMany(q),
    d.collection(PRESENCE).deleteMany(q),
    d.collection(SESSIONS).deleteMany(q),
    d.collection(PREFS).deleteMany(q),
    d.collection(DERIVED).deleteMany({ kind: "taste", ownerId: { $regex: /^load-/ } }),
  ]);
  for (const v of VENUE_IDS) {
    await refreshNow(v);
    void emitPresence(v);
  }
  return { tapsRemoved: taps.deletedCount };
}
