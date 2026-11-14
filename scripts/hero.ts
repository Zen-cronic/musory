// The live transition, timed: the demo guest checks in at Copper Bar, then five simulated guests tap a new sound.
// Prints when the room started making a new track, when it arrived, and when it started playing.
export {};
const BASE = process.env.BASE || "http://localhost:4377";
const post = (p: string, b: unknown) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const log: [number, string, any][] = [];
const ac = new AbortController();
(async () => {
  const r = await fetch(`${BASE}/events`, { signal: ac.signal });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = /^event: (\S+)/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (type && ["music_making", "music_gen", "music_fallback", "play", "simulated"].includes(type)) log.push([Date.now(), type, JSON.parse(data!)]);
    }
  }
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await post("/api/film/reset", {});
await post("/api/checkin", { personId: "g-jess", venueId: "copper" });
await sleep(Number(process.env.HERO_GAP_MS || 9000));
const t0 = Date.now();
const sim = await post("/api/stage/simulate", { venueId: "copper" });
console.log("simulated:", JSON.stringify(sim));
await sleep(16000);
ac.abort();
for (const [t, type, d] of log) {
  if (d.venueId && d.venueId !== "copper") continue;
  const extra = type === "play" ? `${d.play.title} (${d.play.provenance})` : type === "music_gen" ? `${d.ms} ms ${d.mode}` : d.text ?? d.genre ?? "";
  console.log(`${((t - t0) / 1000).toFixed(1).padStart(5)} s  ${type}  ${extra}`);
}
process.exit(0);
