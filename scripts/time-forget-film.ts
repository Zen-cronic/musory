// Forget me under demo conditions: the demo guest checks in, simulated guests move the room, a made track plays,
// then the demo guest says forget me. Prints when Copper Bar's now-playing changed and the receipt's own timings.
export {};
const BASE = process.env.BASE || "http://localhost:4377";
const post = (p: string, b: unknown) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev: [number, string, any][] = [];
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
      if (type && ["play", "music_making", "music_gen", "music_discarded"].includes(type)) ev.push([Date.now(), type, JSON.parse(/^data: (.*)$/m.exec(chunk)![1])]);
    }
  }
})();
await post("/api/film/reset", {});
await post("/api/checkin", { personId: "g-jess", venueId: "copper" });
await sleep(9000);
await post("/api/stage/simulate", { venueId: "copper" });
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (ev.some(([, t, d]) => t === "play" && d.venueId === "copper" && d.play?.composed && i > 2)) break;
}
await sleep(Number(process.env.AFTER_MS || 1500));
const t0 = Date.now();
const r = await post("/api/forget", { personId: "g-jess" });
const tr = Date.now() - t0;
await sleep(1500);
ac.abort();
const p = ev.find(([t, type, d]) => t >= t0 && type === "play" && d.venueId === "copper");
console.log(`room changed at ${p ? p[0] - t0 : "never"} ms (${p?.[2].play.title}), receipt ${tr} ms, ${r.totalBefore} -> ${r.totalAfter}`);
console.log("timing", JSON.stringify(r.timing ?? r.erased?.receipt?.timing ?? Object.keys(r)));
for (const [t, type, d] of ev.filter(([t]) => t >= t0 - 4000)) console.log(`${((t - t0) / 1000).toFixed(2).padStart(6)} s ${type} ${d.venueId} ${d.play?.title ?? d.text ?? d.reason ?? ""}`);
process.exit(0);
