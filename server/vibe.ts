// "Tell the room what you want": a guest types a vibe in their own words. Voyage AI voyage-4 embeds
// it as a query, MongoDB Vector Search (exact) finds the closest track in the catalogue, and that
// becomes one ordinary like through the same tap path as a button press: the same consent, the same
// tonight-only scope, the same 180-day expiry, the same validators, and forget me deletes it.
// The words themselves are sent to Voyage for this one query and never stored, cached or logged.
// No model picks what plays: the like joins the guest's taste, and the room's pick stays the
// deterministic Vector Search over the blend.
import { db, TRACKS } from "./db.js";
import { HttpError, tap } from "./room.js";
import { embedQuery } from "./find.js";
import { composeToward } from "./music.js";
import { isVenue } from "./db.js";

export const vibeOn = () => process.env.VIBE_TAP === "1";

export async function vibeTap(personId: string, textArg: unknown) {
  if (!vibeOn()) throw new HttpError(404, "Telling the room is off.");
  const text = String(textArg ?? "").trim().slice(0, 120);
  if (text.length < 2) throw new HttpError(400, "Say what you want in a few words.");
  const vector = await embedQuery(text);
  if (!vector) throw new HttpError(503, "Couldn't read that just now. Tap a track instead.");
  const d = await db();
  const [hit] = await d
    .collection(TRACKS)
    .aggregate([
      { $vectorSearch: { index: "vec_tracks", path: "embedding", queryVector: vector, exact: true, limit: 1 } },
      { $project: { title: 1, genre: 1, bpm: 1, score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
  if (!hit) throw new HttpError(404, "No track is close to that.");
  // The rest is the button-press path: consent and presence checks, scope, expiry, validators, re-pick.
  // With live music on, that re-pick composes a new track led by the matched track (descriptors only).
  const d2 = await db();
  const pres = await d2.collection("presence").findOne({ personId });
  const making = pres && isVenue(pres.venueId) ? composeToward(pres.venueId, String(hit._id)) : false;
  const result = (await tap(personId, 1, String(hit._id))) as Record<string, unknown>;
  return {
    ...result,
    vibe: { trackId: String(hit._id), title: hit.title, genre: hit.genre, bpm: hit.bpm, score: Math.round(hit.score * 1000) / 1000 },
    making: Boolean(making && !result.already),
    message: result.already
      ? result.message
      : making
        ? `The room is making a track for that: ${hit.genre}, ${hit.bpm} BPM.`
        : `Counted as a like for ${hit.title} (${hit.genre}, ${hit.bpm} BPM).`,
  };
}
