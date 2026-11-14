// "ID?": find a track you heard tonight by describing it, in your own words.
// The answer is MongoDB Vector Search (vec_tracks, exact) with the guest's words embedded by
// Voyage AI voyage-4, limited to tracks this room played tonight. The guest's words go to Voyage
// to make one query vector; Musory doesn't save, cache or log them.
//
// We measured before choosing (scripts/eval.ts --suite find, 20 hand-written
// descriptions): $rankFusion of Atlas Search (txt_tracks) + Vector Search with equal weights found
// 11/20 first, words alone 11/20, meaning alone 17/20, meaning then Voyage rerank-3 18/20.
// Descriptions of music rarely reuse the catalogue's words, so the product uses meaning, plus
// rerank-3 over the top five when FIND_RERANK=1; mode=compare returns every method.
import type { Document } from "mongodb";
import { db, TRACKS, PLAYS, DERIVED, isVenue, VENUES, type VenueId } from "./db.js";
import { EMBED_MODEL, hasVoyage, embed } from "./embed.js";
import { HttpError } from "./room.js";

export const findOn = () => process.env.FIND_TRACK === "1";
const TONIGHT_MS = 8 * 3600_000;

type Hit = { trackId: string; title: string; genre: string; bpm: number; playedAt?: Date | null; ranks: { words?: number; meaning?: number } };

export async function embedQuery(q: string): Promise<number[] | null> {
  if (!hasVoyage()) return null;
  try {
    const r = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ input: [q], model: EMBED_MODEL, input_type: "query" }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data: { embedding: number[] }[] };
    return j.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// Voyage rerank-3 via the Voyage API (not Atlas $rerank): re-orders the top Vector Search candidates
// by reading each track's text description next to the guest's words. Used only when FIND_RERANK=1.
export const rerankOn = () => process.env.FIND_RERANK === "1";
async function rerank(q: string, hits: Hit[], texts: Map<string, string>): Promise<Hit[] | null> {
  if (!hasVoyage() || hits.length < 2) return null;
  try {
    const r = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ query: q, documents: hits.map((h) => texts.get(h.trackId) ?? h.title), model: "rerank-3" }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data: { index: number; relevance_score: number }[] };
    return j.data.sort((a, b) => b.relevance_score - a.relevance_score).map((x) => hits[x.index]);
  } catch {
    return null;
  }
}

// Composed clips in the finder (FIND_CLIPS=1). A clip the room composed tonight gets a voyage-4
// embedding of its own description, written into the clip's own document, so forget me (same
// transaction) and closing time (TTL) delete the embedding with the sound.
export const clipsOn = () => process.env.FIND_CLIPS === "1";
const clipText = (c: Document) => {
  const g = (c.descriptors?.genres ?? []) as string[];
  const styles = ((c.plan?.chunks?.[1]?.positive_styles ?? []) as string[]).join(", ");
  return `Composed live: ${g.join(" with ")}, ${c.descriptors?.bpm ?? ""} BPM. ${styles}`;
};
async function findClips(venueId: VenueId | null, vector: number[]) {
  const d = await db();
  const since = new Date(Date.now() - TONIGHT_MS);
  const scope = { kind: "clip", at: { $gte: since }, ...(venueId ? { venueId } : {}) };
  const fresh = await d.collection(DERIVED).find({ ...scope, embedding: { $exists: false } }, { projection: { descriptors: 1, plan: 1 } }).limit(20).toArray();
  if (fresh.length) {
    const vecs = await embed(fresh.map(clipText), "document");
    if (vecs) await Promise.all(fresh.map((c, i) => d.collection(DERIVED).updateOne({ _id: c._id, kind: "clip" }, { $set: { embedding: vecs[i] } })));
  }
  const rows = await d
    .collection(DERIVED)
    .aggregate([
      { $vectorSearch: { index: "vec_clips", path: "embedding", queryVector: vector, exact: true, limit: 10, filter: { $and: [{ kind: "clip" }, ...(venueId ? [{ venueId }] : [])] } } },
      { $match: { at: { $gte: since } } },
      { $limit: 5 },
      { $project: { venueId: 1, descriptors: 1, audioUrl: 1, at: 1, score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
  return rows.map((c) => ({
    trackId: `gen-${String(c._id).slice(-6)}`,
    clipId: String(c._id),
    title: `Made for ${VENUES[c.venueId as VenueId]?.name ?? "this room"}`,
    genre: ((c.descriptors?.genres ?? []) as string[]).join(" + "),
    bpm: c.descriptors?.bpm ?? null,
    audioUrl: c.audioUrl ?? null,
    playedAt: c.at,
    composed: true,
    score: Math.round(c.score * 10000) / 10000,
  }));
}

async function playedTonight(venueId: VenueId): Promise<Map<string, Date>> {
  const d = await db();
  const rows = await d
    .collection(PLAYS)
    .aggregate([
      { $match: { venueId, startedAt: { $gte: new Date(Date.now() - TONIGHT_MS) } } },
      { $group: { _id: "$trackId", last: { $max: "$startedAt" } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [String(r._id), r.last as Date]));
}

export async function findTrack(venueArg: unknown, qArg: unknown, modeArg?: unknown) {
  const q = String(qArg ?? "").trim().slice(0, 120);
  if (q.length < 2) throw new HttpError(400, "Describe the track in a few words.");
  const all = venueArg === "all";
  if (!all && !isVenue(venueArg)) throw new HttpError(404, "Unknown venue");
  const played = all ? null : await playedTonight(venueArg as VenueId);
  if (played && !played.size) return { q, venueId: venueArg, results: [], note: "Nothing has played here yet tonight." };
  const only: Document[] = played ? [{ $match: { _id: { $in: [...played.keys()] } } }] : [];

  const t0 = Date.now();
  const vector = await embedQuery(q);
  const words: Document[] = [
    { $search: { index: "txt_tracks", text: { query: q, path: ["title", "genre", "descriptor"], fuzzy: { maxEdits: 1 } } } },
    ...only,
    { $limit: 10 },
  ];
  const meaning: Document[] | null = vector
    ? [{ $vectorSearch: { index: "vec_tracks", path: "embedding", queryVector: vector, exact: true, limit: 21 } }, ...only, { $limit: 10 }]
    : null;
  const project = { $project: { title: 1, genre: 1, bpm: 1, descriptor: 1, score: { $meta: "searchScore" } } };
  const projectV = { $project: { title: 1, genre: 1, bpm: 1, descriptor: 1, score: { $meta: "vectorSearchScore" } } };
  const d = await db();
  const tracks = d.collection(TRACKS);
  const toHit = (r: Document, ranks: Hit["ranks"] = {}): Hit => ({
    trackId: String(r._id), title: r.title, genre: r.genre, bpm: r.bpm, playedAt: played?.get(String(r._id)) ?? null, ranks,
  });

  // The product answer: meaning (Vector Search). Words (Atlas Search) only if Voyage is unavailable.
  const rows = await tracks.aggregate([...(meaning ?? words), { $limit: 5 }, meaning ? projectV : project]).toArray();
  const texts = new Map(rows.map((r) => [String(r._id), `${r.title}. ${r.genre}. ${r.descriptor}`]));
  const vectorAnswer = rows.map((r) => toHit(r));
  const reranked = meaning && (rerankOn() || modeArg === "compare") ? await rerank(q, vectorAnswer, texts) : null;
  let answer: Record<string, unknown>[] = rerankOn() && reranked ? reranked : vectorAnswer;
  // Composed clips compete with catalogue tracks on the same Vector Search score.
  if (clipsOn() && vector && modeArg !== "compare") {
    const clips = await findClips(all ? null : (venueArg as VenueId), vector).catch(() => []);
    if (clips.length) {
      const scored = rows.map((r, i) => ({ ...vectorAnswer[i], score: Math.round((r.score ?? 0) * 10000) / 10000 }));
      answer = [...scored, ...clips].sort((a, b) => (b.score as number) - (a.score as number)).slice(0, 5);
    }
  }
  const out: Record<string, unknown> = {
    q, venueId: all ? "all" : venueArg, by: meaning ? (rerankOn() && reranked ? "meaning, reranked" : "meaning") : "words", voyage: Boolean(vector), ms: Date.now() - t0,
    results: answer,
    note: vector ? null : "Voyage AI was unavailable, so this search matched words only.",
  };
  if (modeArg === "compare") {
    // The measurement behind that choice: both lists alone, and fused with $rankFusion.
    const pipelines: Record<string, Document[]> = meaning ? { words, meaning } : { words };
    const fused = await tracks
      .aggregate([
        { $rankFusion: { input: { pipelines }, scoreDetails: true } },
        { $limit: 5 },
        { $project: { title: 1, genre: 1, bpm: 1, details: { $meta: "scoreDetails" } } },
      ])
      .toArray();
    out.hybrid = fused.map((r) => {
      const ranks: Hit["ranks"] = {};
      for (const x of (r.details?.details ?? []) as { inputPipelineName: string; rank?: number }[])
        if (typeof x.rank === "number" && (x.inputPipelineName === "words" || x.inputPipelineName === "meaning")) ranks[x.inputPipelineName] = x.rank;
      return toHit(r, ranks);
    });
    out.words = (await tracks.aggregate([...words, project]).toArray()).map((r) => toHit(r));
    out.meaning = meaning ? (await tracks.aggregate([...meaning, projectV]).toArray()).map((r) => toHit(r)) : [];
    out.reranked = reranked ?? [];
  }
  return out;
}
