// Warm-up: a few batches of simulated guests (ids sim-11..sim-22) at both venues, so the rooms and the
// numbers look like an evening in progress. They check in with consent, like samples and live tracks,
// say "not for me", "bored of this" and "tonight only", and four of them say forget me.
// Live composition is paused while it runs (no ElevenLabs credits). The demo guest is never touched.
// Run on the laptop (room controls are local only): pnpm warmup
export {};
const BASE = process.env.BASE || "http://localhost:4377";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const t0 = Date.now();
const paused = await post("/api/stage/music-pause", { seconds: 120 });
if (paused.status !== 200) {
  console.error("Run this on the laptop that runs the server (room controls are local only).", paused.status);
  process.exit(1);
}

// Who likes what: two samples each, chosen so both rooms' crowds lean their own way with some variety.
const plan: { id: string; venue: "copper" | "basement"; likes: string[] }[] = [
  { id: "sim-11", venue: "copper", likes: ["t01", "t05"] },
  { id: "sim-12", venue: "copper", likes: ["t09", "t10"] },
  { id: "sim-13", venue: "copper", likes: ["t06", "t08"] },
  { id: "sim-14", venue: "copper", likes: ["t13", "t12"] },
  { id: "sim-15", venue: "copper", likes: ["t04", "t07"] },
  { id: "sim-16", venue: "copper", likes: ["t19", "t10"] },
  { id: "sim-17", venue: "basement", likes: ["t11", "t14"] },
  { id: "sim-18", venue: "basement", likes: ["t15", "t16"] },
  { id: "sim-19", venue: "basement", likes: ["t17", "t18"] },
  { id: "sim-20", venue: "basement", likes: ["t13", "t12"] },
  { id: "sim-21", venue: "basement", likes: ["t09", "t06"] },
  { id: "sim-22", venue: "basement", likes: ["t11", "t16"] },
];

// Batch 1: everyone checks in and likes two samples.
await Promise.all(plan.map((g) => post("/api/checkin", { personId: g.id, venueId: g.venue, scopes: ["use_taste", "contribute_crowd"] })));
for (const k of [0, 1]) {
  await Promise.all(plan.map((g) => post("/api/tap", { personId: g.id, signal: 1, trackId: g.likes[k] })));
  await sleep(1200);
}
console.log(`batch 1: ${plan.length} guests checked in and liked 2 samples each`);

// Batch 2: reactions to what is playing, a couple of "bored" and one "tonight only".
for (const [i, g] of plan.entries()) {
  if (i % 3 === 0) await post("/api/tap", { personId: g.id, signal: 1 });
  else if (i % 3 === 1) await post("/api/tap", { personId: g.id, signal: -1 });
}
await sleep(1500);
const bored = await Promise.all([post("/api/bored", { personId: "sim-12" }), post("/api/bored", { personId: "sim-19" })]);
await post("/api/tonight/start", { personId: "sim-15" });
await sleep(1100);
await post("/api/tap", { personId: "sim-15", signal: 1 });
await post("/api/tonight/end", { personId: "sim-15" });
console.log(`batch 2: live reactions, bored (${bored.map((b) => b.superseded ?? 0).join(" + ")} likes set aside), one tonight-only tap`);

// Batch 3: a second wave of likes on whatever plays next.
await sleep(3000);
await Promise.all(plan.filter((_, i) => i % 2 === 0).map((g) => post("/api/tap", { personId: g.id, signal: 1 })));
await sleep(1500);

// Batch 4: four guests say forget me, one after another.
for (const id of ["sim-14", "sim-17", "sim-20", "sim-22"]) {
  const r = await post("/api/forget", { personId: id });
  console.log(`forget ${id}: ${r.totalBefore} -> ${r.totalAfter} records`);
}
await post("/api/stage/music-pause", { seconds: 0 });
const n = await fetch(BASE + "/api/number").then((r) => r.json());
console.log(n.sentence);
console.log(`warm-up done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(0);
