import type { Response } from "express";

// Server-sent events. Every page gets the same stream; nothing in it names a guest.
// Event names: play, next, crowd, presence, tonight, clock, change_event, vector_search, txn, refusal,
// music_gen, forgotten, volunteer, reset. Payloads are documented in the README's UI contract.
const clients = new Set<Response>();
const RECENT_TYPES = new Set(["change_event", "vector_search", "txn", "refusal", "music_gen", "forgotten"]);
let recent: { type: string; data: unknown; at: number }[] = [];

export function subscribe(res: Response) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": connected\n\n");
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export const recentEvents = () => recent;
export const clientCount = () => clients.size;

export function emit(type: string, data: unknown) {
  if (type === "reset") recent = [];
  else if (RECENT_TYPES.has(type)) {
    recent.push({ type, data, at: Date.now() });
    if (recent.length > 80) recent = recent.slice(-80);
  }
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

setInterval(() => {
  for (const c of clients) c.write(": ping\n\n");
}, 20000).unref();
