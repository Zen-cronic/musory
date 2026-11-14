// Live ElevenLabs Music: compose a clip from the room's current blend (descriptors only).
import type { VenueId } from "./db.js";
import { fail } from "./room.js";

export const hasMusicKey = () => Boolean(process.env.ELEVENLABS_API_KEY);
export const liveMusicOn = () => process.env.LIVE_MUSIC === "1";

export async function generateFromRoom(_venueId: VenueId): Promise<unknown> {
  throw fail(501, "Live music generation is off; the rooms play the pre-generated catalogue.");
}
