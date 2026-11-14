// Voyage AI embeddings (voyage-4, 1024 dims) of each track's text description.
export const EMBED_MODEL = "voyage-4";
export const hasVoyage = () => Boolean(process.env.VOYAGE_API_KEY);

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const queryCache = new Map<string, number[]>();
// Disk cache for the fixed track descriptions, so a reset doesn't spend the Voyage rate limit.
// Nothing a guest types is ever embedded.
const SEED_CACHE = ".cache/seed-embeddings.json";
let seedCache: Record<string, number[][]> = {};
try {
  if (existsSync(SEED_CACHE)) seedCache = JSON.parse(readFileSync(SEED_CACHE, "utf8"));
} catch {}

export async function embedSeed(texts: string[]): Promise<number[][] | null> {
  const key = createHash("sha256").update(texts.join("\u0000")).digest("hex");
  if (seedCache[key]) return seedCache[key];
  const out = await embed(texts, "document");
  if (out) {
    seedCache[key] = out;
    mkdirSync(".cache", { recursive: true });
    writeFileSync(SEED_CACHE, JSON.stringify(seedCache));
  }
  return out;
}

export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][] | null> {
  if (!hasVoyage() || !texts.length) return null;
  const key = texts.join("\u0000").toLowerCase().trim();
  if (inputType === "query" && queryCache.has(key)) return [queryCache.get(key)!];
  const out = await call(texts, inputType);
  if (out && inputType === "query") queryCache.set(key, out[0]);
  return out;
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
