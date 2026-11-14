// Many guests at once through the public link: 15 headless guests check in with consent, like a few
// tracks, 3 tell the room what they want, 2 say forget me, all in parallel. Then everyone is forgotten.
export {};
const BASE = (process.env.BASE || "").replace(/\/$/, ""); // the public link, e.g. BASE=https://<your-link>
if (!BASE) throw new Error("Set BASE to the public link");
const N = Number(process.env.CROWD_N || 15);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let errors = 0;
async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status >= 400 && r.status !== 429) errors++;
  return { status: r.status, ...j };
}
let sse = 0;
const ac = new AbortController();
void (async () => {
  const r = await fetch(`${BASE}/events`, { signal: ac.signal });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
    if (done) break;
    sse += (dec.decode(value).match(/^event:/gm) ?? []).length;
  }
})();
const run = Date.now() % 10000;
const ids = Array.from({ length: N }, (_, i) => `aud-${run}-${i}`);
const t0 = Date.now();
const checkins = await Promise.all(ids.map((id, i) => post("/api/checkin", { personId: id, venueId: i % 3 === 2 ? "basement" : "copper" })));
const present = (await fetch(`${BASE}/api/room/copper`).then((r) => r.json())).present;
const samples = ["t13", "t10", "t17", "t15", "t08", "t05"];
let limited = 0;
for (const k of [0, 1]) {
  const rs = await Promise.all(ids.map((id, i) => post("/api/tap", { personId: id, signal: 1, trackId: samples[(i + k) % samples.length] })));
  limited += rs.filter((r) => r.status === 429).length;
  await sleep(1100);
}
const vibes = await Promise.all(ids.slice(0, 3).map((id) => post("/api/vibe", { personId: id, text: "something dark and driving" })));
await sleep(1500);
// Two guests say forget me at the same time; each receipt must count only that guest's records.
const mine = await Promise.all(ids.slice(3, 5).map((id) => fetch(`${BASE}/api/me?personId=${id}`).then((r) => r.json())));
const forgets = await Promise.all(ids.slice(3, 5).map((id) => post("/api/forget", { personId: id })));
const ownOnly = forgets.every((f, i) => f.before?.taps === mine[i].taps.length && f.totalAfter === 0);
console.log(`${N} guests: check-ins ${checkins.filter((c) => c.status === 200).length}/${N}, distinct ids ${new Set(checkins.map((c) => c.personId)).size}, Copper Bar shows ${present} here`);
console.log(`likes rate-limited: ${limited}; vibes ok ${vibes.filter((v) => v.status === 200).length}/3; forget receipts count only their own records: ${ownOnly} (${forgets.map((f) => `${f.totalBefore}->${f.totalAfter}`).join(", ")})`);
console.log(`errors ${errors}, SSE events seen ${sse}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
// Clean up: everyone left is forgotten (one after another, so the rooms settle).
for (const id of ids.slice(5).concat(ids.slice(0, 3))) await post("/api/forget", { personId: id });
ac.abort();
console.log("all test guests forgotten");
process.exit(errors ? 1 : 0);
