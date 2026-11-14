// Stage-mode load test: N guests check in to one room and tap, while we watch the room's event stream.
// Reports the p50/p95 time from a tap being sent to the room's next pick arriving over SSE.
// Run against a server started with STAGE=1. Removes the load guests at the end unless --keep (no room reset).
export {};
const BASE = process.env.BASE || "http://localhost:4377";
const N = Number(process.env.LOAD_N || 200);
const VENUE = process.env.LOAD_VENUE || "copper";
const CONC = Number(process.env.LOAD_CONC || 25);
const SAMPLES = ["t13", "t10", "t17", "t15", "t08", "t05"];

const nextEvents: number[] = [];
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
      if (chunk.startsWith("event: next") && chunk.includes(`"venueId":"${VENUE}"`)) nextEvents.push(Date.now());
    }
  }
})();

async function post(path: string, body: unknown) {
  const t = Date.now();
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await r.text();
  return { status: r.status, ms: Date.now() - t, sentAt: t, doneAt: Date.now() };
}
async function pool<T>(items: T[], fn: (x: T) => Promise<unknown>) {
  const q = [...items];
  await Promise.all(Array.from({ length: CONC }, async () => { while (q.length) await fn(q.shift()!); }));
}
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : NaN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const run = Date.now() % 100000;
const guests = Array.from({ length: N }, (_, i) => `load-${run}-${i}`);
await sleep(500);
const t0 = Date.now();
const checkins: number[] = [];
let errors = 0;
await pool(guests, async (g) => {
  const r = await post("/api/checkin", { personId: g, venueId: VENUE });
  if (r.status !== 200) errors++;
  checkins.push(r.ms);
});
console.log(`${N} check-ins in ${((Date.now() - t0) / 1000).toFixed(1)} s, p95 ${pct(checkins, 95)} ms, errors ${errors}`);

const taps: { sentAt: number; doneAt: number; ms: number; status: number }[] = [];
const t1 = Date.now();
await pool(
  guests.flatMap((g) => [0, 1].map((k) => ({ g, s: SAMPLES[(guests.indexOf(g) + k * 3) % SAMPLES.length] }))),
  async ({ g, s }) => {
    await sleep(Math.random() * 200);
    taps.push(await post("/api/tap", { personId: g, signal: 1, trackId: s }));
  },
);
console.log(`${taps.length} taps in ${((Date.now() - t1) / 1000).toFixed(1)} s, HTTP p95 ${pct(taps.map((t) => t.ms), 95)} ms, errors ${taps.filter((t) => t.status !== 200).length}`);
await sleep(5000);
// Time from a tap being sent to the first room pick that arrives after the tap was saved.
const lat = taps.filter((t) => t.status === 200).map((t) => {
  const e = nextEvents.find((x) => x >= t.doneAt);
  return e ? e - t.sentAt : NaN;
}).filter((x) => !Number.isNaN(x));
console.log(`tap -> room update: p50 ${pct(lat, 50)} ms, p95 ${pct(lat, 95)} ms, max ${Math.max(...lat)} ms (${lat.length}/${taps.length} matched, ${nextEvents.length} room picks)`);
ac.abort();
if (!process.argv.includes("--keep")) {
  const r = await post("/api/stage/clear-load", {});
  console.log("load guests removed:", r.status);
}
process.exit(0);
