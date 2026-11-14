// Search indexes for "What was that track?": Atlas Search on the catalogue's words (the fallback when
// Voyage is down), and Vector Search over composed clips' embeddings (FIND_CLIPS=1). Safe to re-run.
import { db, closeAll, redactError, TRACKS, DERIVED } from "../server/db.js";

async function ensure(coll: string, name: string, type: "search" | "vectorSearch", definition: object) {
  const d = await db("app");
  try {
    const found = ((await d.collection(coll).listSearchIndexes().toArray()) as { name: string }[]).find((i) => i.name === name);
    if (found) await d.collection(coll).updateSearchIndex(name, definition);
    else await d.collection(coll).createSearchIndex({ name, type, definition });
    console.log(coll, name, found ? "updated" : "created");
  } catch (e) {
    console.log(coll, name, "failed:", redactError(e).message);
  }
}

await ensure(TRACKS, "txt_tracks", "search", {
  mappings: { dynamic: false, fields: { title: { type: "string", analyzer: "lucene.english" }, genre: { type: "string", analyzer: "lucene.english" }, descriptor: { type: "string", analyzer: "lucene.english" } } },
});
await ensure(DERIVED, "vec_clips", "vectorSearch", {
  fields: [
    { type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine" },
    { type: "filter", path: "kind" },
    { type: "filter", path: "venueId" },
  ],
});
await closeAll();
