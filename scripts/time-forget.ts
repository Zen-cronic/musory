// Times one forget me: from the request to Copper Bar's now-playing changing (over SSE), and to the receipt.
export {};
const BASE = process.env.BASE || "http://localhost:4377";
const post = (p: string, b: unknown) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plays: [number, string, string][] = [];
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
      if (type === "play") {
        const d = JSON.parse(/^data: (.*)$/m.exec(chunk)![1]);
        plays.push([Date.now(), d.venueId, d.play.trackId]);
      }
    }
  }
})();
await post("/api/film/reset", {});
await post("/api/checkin", { personId: "g-jess", venueId: "copper" });
await sleep(12000);
const t0 = Date.now();
const r = await post("/api/forget", { personId: "g-jess" });
const tr = Date.now() - t0;
await sleep(1500);
ac.abort();
const firstPlay = plays.find(([t, v]) => t >= t0 && v === "copper");
console.log(`room changed at ${firstPlay ? firstPlay[0] - t0 : "never"} ms, receipt at ${tr} ms, ${r.totalBefore} -> ${r.totalAfter}, txn ${r.txnMs} ms, clips ${r.before?.composedClips}, timing ${JSON.stringify(r.timing ?? r.erased?.receipt?.timing ?? r)}`.slice(0, 600) + ``);
process.exit(0);
