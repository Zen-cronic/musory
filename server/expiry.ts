// Composed clips expire after closing.
// Every clip a room composes is built from its guests' taste, so it shouldn't outlive the night.
// Each clip record gets an expiresAt at closing time; a partial TTL index on derived lets Atlas remove
// the record (the TTL monitor runs about once a minute, so removal lands within about a minute of
// closing, not instantly); and the change stream on derived deletes the clip's audio file when it sees
// the record's delete event. Forget me still removes a guest's clips at once, as before.
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "mongodb";
import { DERIVED } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEN_DIR = path.join(root, "public", "audio", "gen"); // where server/music.ts writes composed clips
const CLOSING_HOUR = Number(process.env.CLOSING_HOUR ?? 3); // 3 am, venue (server) local time

/** When a clip composed now expires: the next closing time, or now + CLIP_TTL_MS for a demo. */
export function closingAfter(now = new Date()): Date {
  const ms = Number(process.env.CLIP_TTL_MS || 0);
  if (ms > 0) return new Date(now.getTime() + ms);
  const d = new Date(now);
  d.setHours(CLOSING_HOUR, 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

/** A TTL index that applies only to clip records, so no other derived record can expire by accident. */
export async function ensureClipExpiry(d: Db) {
  await d.collection(DERIVED).createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { kind: "clip" }, name: "clips_expire_after_closing" },
  );
}

/** Called from the derived change stream on every delete: removes the clip's audio file if there is one. */
export function removeClipAudio(id: unknown): boolean {
  const hex = id && typeof id === "object" && "toHexString" in id ? (id as { toHexString(): string }).toHexString() : String(id ?? "");
  if (!/^[a-f0-9]{24}$/.test(hex)) return false;
  rmSync(path.join(GEN_DIR, `${hex}.mp3`), { force: true });
  return true;
}
