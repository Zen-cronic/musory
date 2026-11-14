// Voyage AI embeddings (voyage-4, 1024 dims) of each track's text description.
export const EMBED_MODEL = "voyage-4";
export const hasVoyage = () => Boolean(process.env.VOYAGE_API_KEY);

import { createHash } from "node:crypto";
import { db } from "./db.js";

// Embeddings of the fixed track descriptions are cached in MongoDB (edmRoom.embeddingCache), one
// document per model and text, so a reset or a fresh machine doesn't spend the Voyage rate limit.
// A guest's search words (server/find.ts) are embedded for that one query and never stored or cached.
export const EMBEDDING_CACHE = "embeddingCache";
const cacheKey = (text: string, inputType: string) => createHash("sha256").update(`${EMBED_MODEL}\u0000${inputType}\u0000${text}`).digest("hex");

export async function embedSeed(texts: string[]): Promise<number[][] | null> {
  const keys = texts.map((t) => cacheKey(t, "document"));
  let cached = new Map<string, number[]>();
  try {
    const d = await db();
    const rows = await d.collection(EMBEDDING_CACHE).find({ _id: { $in: keys } } as never).toArray();
    cached = new Map(rows.map((r) => [String(r._id), r.vector as number[]]));
  } catch (e) {
    console.error("embedding cache unavailable, computing:", (e as Error).message);
  }
  const missing = texts.filter((_, i) => !cached.has(keys[i]));
  if (missing.length) {
    const out = await embed(missing, "document");
    if (!out) return null;
    missing.forEach((t, i) => cached.set(cacheKey(t, "document"), out[i]));
    try {
      const d = await db();
      await d.collection(EMBEDDING_CACHE).bulkWrite(
        missing.map((t, i) => ({
          replaceOne: { filter: { _id: cacheKey(t, "document") } as never, replacement: { model: EMBED_MODEL, inputType: "document", text: t, vector: out[i], at: new Date() }, upsert: true },
        })),
      );
    } catch (e) {
      console.error("embedding cache write failed:", (e as Error).message);
    }
  }
  return keys.map((k) => cached.get(k)!);
}

export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][] | null> {
  if (!hasVoyage() || !texts.length) return null;
  return call(texts, inputType);
}

async function call(texts: string[], inputType: "document" | "query"): Promise<number[][] | null> {
  try {
    const r = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ input: texts, model: EMBED_MODEL, input_type: inputType }),
    });
    if (!r.ok) {
      console.error("voyage embed failed: HTTP", r.status);
      return null;
    }
    const j = (await r.json()) as { data: { embedding: number[]; index: number }[] };
    return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } catch (e) {
    console.error("voyage embed failed:", (e as Error).message);
    return null;
  }
}
