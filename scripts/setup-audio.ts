// Stores each catalogue clip's MP3 inside its track document in Atlas (BinData), so the rooms stream
// every sound from the database. Safe to re-run: it sets the same bytes again.
import { readFileSync, existsSync } from "node:fs";
import { Binary } from "mongodb";
import { db, closeAll, redactError, TRACKS as TRACKS_COLL } from "../server/db.js";
import { TRACKS } from "../server/catalog.js";

try {
  const d = await db("app");
  let n = 0;
  let bytes = 0;
  for (const t of TRACKS) {
    const file = `public/audio/${t._id}.mp3`;
    if (!existsSync(file)) {
      const has = await d.collection(TRACKS_COLL).countDocuments({ _id: t._id as never, "audio.bytes": { $exists: true } });
      console.log(t._id, has ? "already stored (no local file)" : "MISSING: no file and nothing stored");
      continue;
    }
    const buf = readFileSync(file);
    await d.collection(TRACKS_COLL).updateOne({ _id: t._id as never }, { $set: { audio: { mime: "audio/mpeg", bytes: new Binary(buf) } } });
    n++;
    bytes += buf.length;
  }
  console.log(`stored ${n} clips in ${TRACKS_COLL} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
} catch (e) {
  console.error(redactError(e));
  process.exitCode = 1;
}
await closeAll();
