// Atlas Vector Search indexes: the track catalogue (filters on energy, genre and BPM),
// and the public venue cards View (optional venue suggestions).
import { db, closeAll, redactError, TRACKS } from "../server/db.js";

async function ensureIndex(coll: string, name: string, fields: object[]) {
  const d = await db("app");
  try {
    const existing = (await d.collection(coll).listSearchIndexes().toArray()) as { name: string; status?: string }[];
    const found = existing.find((i) => i.name === name);
    if (found) {
      await d.collection(coll).updateSearchIndex(name, { fields });
      return console.log(coll, name, "updated");
    }
    await d.collection(coll).createSearchIndex({ name, type: "vectorSearch", definition: { fields } });
    console.log("created", name);
  } catch (e) {
    console.log(coll, "failed:", redactError(e).message);
  }
}

await ensureIndex(TRACKS, "vec_tracks", [
  { type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine" },
  { type: "filter", path: "energy" },
  { type: "filter", path: "genre" },
  { type: "filter", path: "bpm" },
]);
await ensureIndex("v_discoverable", "vec_cards", [{ type: "vector", path: "vector", numDimensions: 1024, similarity: "cosine" }]);
await closeAll();
