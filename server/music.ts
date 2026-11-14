// Live ElevenLabs Music: when guests' taps move a room's blend to a new leading sound, the room composes
// a new clip at its current tempo and crossfades into it.
// The composition plan eases out of the current sound and into the new one, described by genre, tempo
// and texture only (never an artist, title or label). Nothing about a guest is sent to ElevenLabs.
// The clip record holds the aggregate mix and the number of people behind it (3 or more), never a
// guest id or tap id. It names the taste and crowd memory documents it came from (derivedFrom), so
// forget me deletes it, and its file, with everything else built from that guest.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ObjectId, type Document } from "mongodb";
import { db, DERIVED, VENUES, type VenueId } from "./db.js";
import * as room from "./room.js";
import { fail, rooms, queueClip, advance, setDecisionHook, setComposingCheck, currentGenre, composeSoon } from "./room.js";
import { TRACKS, byId } from "./catalog.js";
import { emit } from "./events.js";
import { closingAfter } from "./expiry.js";

export const hasMusicKey = () => Boolean(process.env.ELEVENLABS_API_KEY);
export const liveMusicOn = () => process.env.MUSIC_LIVE === "1" || process.env.LIVE_MUSIC === "1";
export const MUSIC_MODEL = "music_v2_5";
const CLIP_MS = 15_000;
const FALLBACK_MS = Number(process.env.MUSIC_FALLBACK_MS || 10_000); // after this, play the closest catalogue track
// At most one composition per room every 20 s for guests' taps; 8 s in stage mode and after simulated guests.
const MIN_GAP_MS = Number(process.env.MUSIC_GAP_MS || (process.env.STAGE === "1" ? 8_000 : 20_000));
const MAX_PER_DAY = Number(process.env.LIVE_MUSIC_MAX || 60);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GEN_DIR = path.join(root, "public", "audio", "gen");

let today = new Date().toDateString();
let usedToday = 0;
const busy = new Set<VenueId>();
const lastStart: Partial<Record<VenueId, number>> = {};
const lastLeading: Partial<Record<VenueId, string>> = {};

function stylesFor(genre: string): string[] {
  const t = TRACKS.find((x) => x.genre === genre);
  const words = (t?.descriptor ?? genre).split(",").map((w) => w.trim()).filter((w) => !/BPM/i.test(w));
  return [genre, ...words.slice(1, 5), "instrumental"];
}
const leadingOf = (mix: Record<string, number> = {}) => Object.entries(mix).sort((a, b) => b[1] - a[1])[0]?.[0];

/** Two sections at the room's current tempo: a short lead-in from the current sound, then the crowd's new sound. */
export function planFor(fromGenre: string, toGenres: string[], bpm: number) {
  const to = toGenres[0] ?? "house";
  const second = toGenres[1];
  const chunks = [
    { text: "[Lead-in]", duration_ms: 4000, positive_styles: [...stylesFor(fromGenre).slice(0, 3), to, `${bpm} BPM`], negative_styles: ["vocals", "spoken word"] },
    {
      text: "[New groove]",
      duration_ms: CLIP_MS - 4000,
      positive_styles: [...stylesFor(to), ...(second ? [`hints of ${second}`] : []), `${bpm} BPM`],
      negative_styles: ["vocals", "spoken word"],
    },
  ];
  return { descriptors: { from: fromGenre, genres: toGenres, bpm }, plan: { chunks } };
}

async function compose(body: object): Promise<Buffer> {
  const r = await fetch(`https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": String(process.env.ELEVENLABS_API_KEY), "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw fail(502, `ElevenLabs Music HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}

export function musicState() {
  if (new Date().toDateString() !== today) {
    today = new Date().toDateString();
    usedToday = 0;
  }
  return { live: liveMusicOn(), key: hasMusicKey(), usedToday, maxPerDay: MAX_PER_DAY, busy: [...busy] };
}

/**
 * Compose the room's next clip from its current blend and crossfade into it as soon as it arrives.
 * If it takes longer than 10 s or fails, the room crossfades to the closest catalogue track instead.
 */
export async function generateFromRoom(venueId: VenueId, opts: { reason?: string } = {}) {
  musicState();
  if (!hasMusicKey()) throw fail(501, "No ElevenLabs key set.");
  if (busy.has(venueId)) throw fail(409, "This room is already making a track.");
  if (usedToday >= MAX_PER_DAY) throw fail(429, `Daily limit of ${MAX_PER_DAY} composed tracks reached.`);
  // Marked busy before any await, so the room doesn't also jump to a catalogue track meanwhile.
  busy.add(venueId);
  try {
    return await composeFor(venueId, opts);
  } finally {
    busy.delete(venueId);
    // Simulated guests tapped while this room was busy: make their track now.
    if (pendingSoon.delete(venueId)) setTimeout(() => void generateFromRoom(venueId, { reason: "simulated guests" }).catch(() => {}), 0);
  }
}
const pendingSoon = new Set<VenueId>();

async function composeFor(venueId: VenueId, opts: { reason?: string }) {
  const epoch = room.forgetEpoch;
  const decision = rooms[venueId].next as Document | null;
  // Lineage, like crowd memory: the tap ids behind the tastes and crowd memory in this blend. No guest ids.
  const d0 = await db();
  const sources = decision?.derivedFrom?.length
    ? await d0.collection(DERIVED).find({ _id: { $in: decision.derivedFrom as ObjectId[] } }, { projection: { derivedFrom: 1 } }).toArray()
    : [];
  const derivedFrom = [...new Map(sources.flatMap((x) => (x.derivedFrom ?? []) as ObjectId[]).map((id) => [id.toHexString(), id])).values()];
  const people = ((decision?.sharingCount as number) ?? 0) + ((decision?.crowdContributors as number) ?? 0);
  if (!decision || !derivedFrom.length) throw fail(409, "This room has no memory to compose from yet.");
  if (people < 3) throw fail(409, "A composed track needs a blend of at least 3 people.");
  usedToday++;
  lastStart[venueId] = Date.now();
  const t0 = Date.now();
  const fromGenre = currentGenre(venueId);
  const bpm = byId.get(rooms[venueId].play?.trackId ?? "")?.bpm ?? (decision.picked?.bpm as number) ?? 124;
  const genres = Object.entries((decision.mix ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([g]) => g);
  const { descriptors, plan } = planFor(fromGenre, genres, bpm);
  lastLeading[venueId] = genres[0];
  emit("music_making", {
    venueId, people, genres, bpm, from: fromGenre, reason: opts.reason ?? "manual",
    text: `Making a new track for the ${people} people in this room's blend: ${genres.join(" and ")}, ${bpm} BPM`,
  });
  // Fallback: if the new track isn't here in 10 s, play the closest catalogue track now.
  let fellBack = false;
  const timer = setTimeout(async () => {
    if (room.forgetEpoch !== epoch) return; // a guest was forgotten meanwhile; forget already re-picked the room
    fellBack = true;
    emit("music_fallback", { venueId, reason: "slow", text: "Playing the closest track we have", afterMs: FALLBACK_MS });
    await advance(venueId).catch(() => {});
  }, FALLBACK_MS);
  try {
    let audio: Buffer;
    let mode = "composition plan";
    try {
      audio = await compose({ model_id: MUSIC_MODEL, composition_plan: plan });
    } catch {
      mode = "prompt";
      const prompt = `Instrumental club track, ${bpm} BPM: ${genres.join(" with ")}. ${stylesFor(genres[0] ?? "house").slice(1, 4).join(", ")}.`;
      audio = await compose({ model_id: MUSIC_MODEL, prompt, music_length_ms: CLIP_MS, force_instrumental: true });
    }
    if (room.forgetEpoch !== epoch) {
      // Someone in this blend said forget me while the track was being made: throw it away unplayed.
      clearTimeout(timer);
      emit("music_discarded", { venueId, reason: "a guest in this blend said forget me", ms: Date.now() - t0 });
      return { ok: false, venueId, discarded: true };
    }
    const id = new ObjectId();
    mkdirSync(GEN_DIR, { recursive: true });
    writeFileSync(path.join(GEN_DIR, `${id.toHexString()}.mp3`), audio);
    const ms = Date.now() - t0;
    const doc = {
      _id: id,
      kind: "clip",
      venueId,
      model: MUSIC_MODEL,
      mode,
      mix: decision.mix,
      people,
      descriptors,
      plan,
      audio: `/audio/gen/${id.toHexString()}.mp3`,
      ms,
      at: new Date(),
      expiresAt: closingAfter(),
      derivedFrom,
    };
    const d = await db();
    await d.collection(DERIVED).insertOne(doc);
    clearTimeout(timer);
    queueClip(venueId, {
      trackId: `gen-${id.toHexString().slice(-6)}`,
      clipId: id.toHexString(),
      title: `Made for ${VENUES[venueId].name}`,
      genre: genres.join(" + "),
      bpm,
      audio: doc.audio,
      descriptor: plan.chunks.map((c) => c.positive_styles.join(", ")).join(" | "),
    });
    emit("music_gen", { venueId, model: MUSIC_MODEL, mode, descriptors, people, ms, late: fellBack });
    // Arrived in time: crossfade into it now. Arrived late: it plays next.
    if (!fellBack) await advance(venueId);
    return { ok: true, venueId, ms, mode, descriptors, people, audio: doc.audio, late: fellBack };
  } catch (e) {
    clearTimeout(timer);
    if (!fellBack) {
      emit("music_fallback", { venueId, reason: "failed", text: "Playing the closest track we have" });
      await advance(venueId).catch(() => {});
    }
    throw e;
  }
}

setComposingCheck((v) => busy.has(v));

// The trigger: a new pick whose leading sound differs from what the room is playing starts a composition
// right away, in parallel with the current clip.
setDecisionHook((venueId, decision) => {
  if (!liveMusicOn() || !hasMusicKey()) return;
  // Simulated guests always get a fresh track (no gap, no same-sound check; the daily cap still applies).
  const soon = composeSoon.has(venueId);
  if (busy.has(venueId)) {
    if (soon) {
      composeSoon.delete(venueId);
      pendingSoon.add(venueId);
    }
    return;
  }
  if (!soon && Date.now() - (lastStart[venueId] ?? 0) < MIN_GAP_MS) return;
  const leading = leadingOf(decision.mix as Record<string, number>);
  if (!soon && (!leading || leading === currentGenre(venueId) || leading === lastLeading[venueId])) return;
  const people = ((decision.sharingCount as number) ?? 0) + ((decision.crowdContributors as number) ?? 0);
  if (!(decision.sharingCount as number) || people < 3) return;
  composeSoon.delete(venueId);
  void generateFromRoom(venueId, { reason: "the crowd's taps moved the room" }).catch((e) => console.error("compose failed", (e as Error).message));
});
