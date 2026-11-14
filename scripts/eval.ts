// The guarantee experiments, run with LangSmith evaluate() against the real API of a running server.
//
//   EVAL_ALLOW_RESET=1 pnpm eval            guarantees: scripted crowds (resets the edmRoom demo data)
//   pnpm eval -- --suite find               find-that-track: words vs meaning vs hybrid (read-only)
//   pnpm eval -- --limit 2                  a dry run on the first 2 scenarios (--only 0,12 picks by index)
//
// With LANGSMITH_API_KEY set, the dataset and the experiment are uploaded and the link is stored.
// Without it, the same evaluate() runs locally (uploadRuns: false) and the result says "local run".
// Every evaluator is plain code: no model grades anything.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { evaluate } from "langsmith/evaluation";
import { Client } from "langsmith";
import { saveEval, type EvalMetric } from "../server/evals.js";
import { closeAll, db } from "../server/db.js";
import { findTrack } from "../server/find.js";
import { TRACKS } from "../server/catalog.js";

const BASE = (process.env.EVAL_BASE_URL || `http://localhost:${process.env.PORT || 4377}`).replace(/\/$/, "");
const args = process.argv.slice(2);
const suite = args.includes("--suite") ? args[args.indexOf("--suite") + 1] : "guarantees";
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const upload = Boolean(process.env.LANGSMITH_API_KEY) && !args.includes("--local");

async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

type Ex = { id: string; inputs: Record<string, any>; outputs: Record<string, any> };
function localExamples(rows: { inputs: Record<string, any>; outputs?: Record<string, any> }[]) {
  const ds = randomUUID();
  const now = new Date().toISOString();
  return rows.map((r) => ({ id: randomUUID(), dataset_id: ds, inputs: r.inputs, outputs: r.outputs ?? {}, created_at: now, modified_at: now, runs: [] })) as never;
}

async function datasetFor(name: string, description: string, rows: { inputs: Record<string, any>; outputs?: Record<string, any> }[]) {
  if (!upload) return localExamples(rows);
  const client = new Client();
  if (!(await client.hasDataset({ datasetName: name }))) {
    const ds = await client.createDataset(name, { description });
    await client.createExamples(rows.map((r) => ({ inputs: r.inputs, outputs: r.outputs ?? {}, dataset_id: ds.id })));
  }
  return name;
}

async function experimentUrl(experiment: string): Promise<string | undefined> {
  if (!upload) return undefined;
  try {
    return await new Client().getProjectUrl({ projectName: experiment });
  } catch {
    return undefined;
  }
}

// Guarantees: one scripted guest per scenario, then forget me
const PROFILES: Record<string, string[]> = {
  "techno-trance": ["t13", "t15"],
  "afro-deep": ["t08", "t05"],
  "disco-dnb": ["t10", "t17"],
};
const other = (v: string) => (v === "copper" ? "basement" : "copper");

function guaranteeScenarios() {
  const rows: { inputs: Record<string, any> }[] = [];
  let i = 0;
  for (const venue of ["copper", "basement"])
    for (const profile of Object.keys(PROFILES))
      for (const scope of ["long", "tonight"]) {
        rows.push({ inputs: { n: i, venue, profile, likes: PROFILES[profile], scope, consent: "full", visitOther: scope === "long", hourSteps: i % 3 } });
        i++;
      }
  // Negative controls: the guest taps but shares nothing (no use_taste, no contribute_crowd),
  // so no room's pick may move because of them.
  for (const venue of ["copper", "basement"]) {
    rows.push({ inputs: { n: i, venue, profile: "techno-trance", likes: PROFILES["techno-trance"], scope: "long", consent: "none", visitOther: false, hourSteps: 0 } });
    i++;
  }
  return rows;
}

const runTag = Date.now().toString(36);
async function freshDecision(venue: string, after: number) {
  const until = Date.now() + 8000;
  let room = await api("GET", `/api/room/${venue}`);
  while (Date.now() < until) {
    if (room.next?.at && new Date(room.next.at).getTime() >= after) return { ...room, fresh: true };
    await new Promise((r) => setTimeout(r, 250));
    room = await api("GET", `/api/room/${venue}`);
  }
  return { ...room, fresh: false };
}
// Independent of forget's own receipt: read every document in every edmRoom collection
// (including the LangGraph checkpoints, plays, tombstones and evals) and the recent event feed,
// and look for the guest's plaintext id anywhere.
async function scanFor(personId: string) {
  const d = await db();
  const hits: Record<string, number> = {};
  let scanned = 0;
  for (const c of await d.listCollections({ type: "collection" }, { nameOnly: true }).toArray()) {
    if (c.name.startsWith("system.")) continue;
    for (const doc of await d.collection(c.name).find({}).toArray()) {
      scanned++;
      if (JSON.stringify(doc).includes(personId)) hits[c.name] = (hits[c.name] ?? 0) + 1;
    }
  }
  if (JSON.stringify(await api("GET", "/api/recent")).includes(personId)) hits["event feed"] = 1;
  return { scanned, hits };
}

let venueChecked = false;
async function runScenario(inp: Record<string, any>) {
  const personId = `eval-${runTag}-${inp.n}`;
  const t0 = Date.now();
  await api("POST", "/api/reset");
  for (let k = 0; k < inp.hourSteps; k++) await api("POST", "/api/clock/next");
  const scopes = inp.consent === "none" ? [] : ["use_taste", "contribute_crowd"];
  await api("POST", "/api/checkin", { personId, venueId: inp.venue, scopes });
  if (inp.scope === "tonight") await api("POST", "/api/tonight/start", { personId });
  let lastTapAt = Date.now();
  for (const trackId of inp.likes) {
    lastTapAt = Date.now();
    await api("POST", "/api/tap", { personId, signal: 1, trackId });
  }
  // A tap re-picks in the background; wait for the room's first decision made after the last tap.
  const room = await freshDecision(inp.venue, lastTapAt);
  const meBefore = await api("GET", `/api/me?personId=${personId}`);
  let tonightLeak: any = null;
  if (inp.scope === "tonight") tonightLeak = await api("POST", "/api/proof/tonight-leak", { personId });
  if (inp.visitOther) {
    const t = Date.now();
    await api("POST", "/api/checkin", { personId, venueId: other(inp.venue), scopes: ["use_taste", "contribute_crowd"] });
    // Let both rooms finish re-picking before forget me, so the receipt compares settled picks.
    await freshDecision(inp.venue, t);
    await freshDecision(other(inp.venue), t);
  }
  // The venue login rules are the same in every scenario, so they are checked once per run.
  let crossVenue: any = null;
  let ownVenue: any = null;
  if (!venueChecked) {
    venueChecked = true;
    crossVenue = await api("POST", "/api/proof/cross-venue");
    ownVenue = await api("POST", "/api/proof/own-venue");
  }
  const tForget = Date.now();
  const receipt = await api("POST", "/api/forget", { personId });
  const forgetMs = Date.now() - tForget;
  const meAfter = await api("GET", `/api/me?personId=${personId}`);
  const scan = await scanFor(personId);
  return {
    personId,
    ms: Date.now() - t0,
    forgetMs,
    tapsBefore: meBefore.taps?.length ?? 0,
    tonightTapsBefore: (meBefore.taps ?? []).filter((t: any) => t.scope === "tonight").length,
    tasteEvidenceBefore: meBefore.taste?.evidence ?? 0,
    memoryChangedPick: Boolean(room.next?.memoryChangedPick),
    decision: {
      fresh: room.fresh,
      picked: room.next?.picked?.trackId ?? null,
      baseline: room.next?.baselinePick?.trackId ?? null,
      sharing: room.next?.sharingCount ?? null,
      crowd: room.next?.crowdContributors ?? null,
      parts: room.next?.parts ?? null,
      top2: (room.next?.candidates ?? []).slice(0, 2).map((c: any) => `${c.trackId}:${c.score}`),
    },
    tonightLeak: tonightLeak ? { ok: tonightLeak.ok, code: tonightLeak.error?.code ?? null, usedRealTonightTap: tonightLeak.usedRealTonightTap ?? null } : null,
    crossVenue: crossVenue ? { ok: crossVenue.ok, code: crossVenue.error?.code ?? null } : null,
    ownVenue: ownVenue ? { ok: ownVenue.ok } : null,
    scan,
    receipt: {
      totalBefore: receipt.totalBefore,
      totalAfter: receipt.totalAfter,
      venues: (receipt.venues ?? []).map((v: any) => ({ venueId: v.venueId, pickBefore: v.pickBefore?.trackId ?? null, contributionRemoved: v.contributionRemoved, matchesWithoutYou: v.matchesWithoutYou, pickAfter: v.pickAfter?.trackId ?? null, pickWithoutYou: v.pickWithoutYou?.trackId ?? null })),
      durable: receipt.durable ?? null,
    },
    after: { taps: meAfter.taps?.length ?? 0, taste: Boolean(meAfter.taste), consents: meAfter.consents?.length ?? 0, venue: meAfter.venueId ?? null },
  };
}

const na = () => ({ results: [] }) as never;
const guaranteeEvaluators = ([
  ({ outputs }: any) => ({
    key: "no_trace_left",
    score: outputs.scan.scanned > 0 && Object.keys(outputs.scan.hits).length === 0 ? 1 : 0,
    comment: `scanned ${outputs.scan.scanned} documents in every edmRoom collection + the event feed; hits ${JSON.stringify(outputs.scan.hits)}`,
  }),
  ({ outputs }: any) => ({
    key: "forget_zero_records",
    score: outputs.receipt.totalBefore > 0 && outputs.receipt.totalAfter === 0 && outputs.after.taps === 0 && !outputs.after.taste && outputs.after.consents === 0 && !outputs.after.venue && (outputs.receipt.durable ? outputs.receipt.durable.checkpointsLeft === 0 : true) ? 1 : 0,
    comment: `records before ${outputs.receipt.totalBefore}, after ${outputs.receipt.totalAfter}; forget took ${outputs.forgetMs} ms${outputs.receipt.durable ? `; durable job ${JSON.stringify(outputs.receipt.durable)}` : " (direct path)"}`,
  }),
  ({ outputs }: any) => ({
    key: "forget_matches_pick_without_you",
    score: outputs.receipt.venues.length > 0 && outputs.receipt.venues.every((v: any) => v.matchesWithoutYou) ? 1 : 0,
    comment: outputs.receipt.venues.map((v: any) => `${v.venueId}: ${v.pickAfter} vs ${v.pickWithoutYou}`).join("; "),
  }),
  ({ outputs, inputs }: any) =>
    inputs.scope !== "tonight"
      ? na()
      : {
          key: "tonight_never_in_taste",
          score: outputs.tonightTapsBefore > 0 && outputs.tasteEvidenceBefore === 0 && outputs.tonightLeak?.ok === false && outputs.tonightLeak?.code === 121 ? 1 : 0,
          comment: `tonight taps ${outputs.tonightTapsBefore}, taste evidence ${outputs.tasteEvidenceBefore}, forced write -> ${outputs.tonightLeak?.code}`,
        },
  ({ outputs }: any) =>
    !outputs.crossVenue
      ? na()
      : {
          key: "venue_b_refused",
          score: outputs.crossVenue.ok === false && outputs.crossVenue.code === 13 && outputs.ownVenue?.ok === true ? 1 : 0,
          comment: `checked once per run: cross-venue read -> ${outputs.crossVenue.code}; own venue ok ${outputs.ownVenue?.ok}`,
        },
  ({ outputs, inputs }: any) =>
    inputs.consent !== "none"
      ? na()
      : {
          key: "no_consent_no_influence",
          score: outputs.receipt.venues.length > 0 && outputs.receipt.venues.every((v: any) => v.pickBefore === v.pickWithoutYou) ? 1 : 0,
          comment: outputs.receipt.venues.map((v: any) => `${v.venueId}: with ${v.pickBefore} / without ${v.pickWithoutYou}`).join("; "),
        },
  // Measured, not pass/fail: does the room's pick differ from the no-memory pick after this guest's taps?
  ({ outputs }: any) => ({
    key: "memory_changed_pick",
    score: outputs.decision.fresh && outputs.memoryChangedPick ? 1 : 0,
    comment: `picked ${outputs.decision.picked}, no-memory ${outputs.decision.baseline}, sharing ${outputs.decision.sharing}, top2 ${outputs.decision.top2.join(" ")}${outputs.decision.fresh ? "" : " (no fresh decision)"}`,
  }),
  // Measured, separate: did this guest change any room's pick (pick with them vs pick without them)?
  ({ outputs, inputs }: any) =>
    inputs.consent === "none"
      ? na()
      : {
          key: "guest_changed_pick",
          score: outputs.receipt.venues.some((v: any) => v.pickBefore && v.pickWithoutYou && v.pickBefore !== v.pickWithoutYou) ? 1 : 0,
          comment: outputs.receipt.venues.map((v: any) => `${v.venueId}: with ${v.pickBefore} / without ${v.pickWithoutYou}`).join("; "),
        },
] as ((a: any) => any)[]).map((f) => (a: any) => (a.outputs?.receipt ? f(a) : na()));
const PASS_FAIL = ["no_trace_left", "forget_zero_records", "forget_matches_pick_without_you", "tonight_never_in_taste", "venue_b_refused", "no_consent_no_influence"];

// Find that track: words only, meaning only, and both fused, over the whole catalogue.
// Two hand-written sets, both written before any run: "literal" reuses words from the track's
// description or title; "paraphrase" shares no content word with the answer's description.
const FIND_CASES: { q: string; want: string; set?: string }[] = [
  { q: "marimba", want: "t08" },
  { q: "the chill piano one with crackle", want: "t20" },
  { q: "Fire Exit", want: "t14" },
  { q: "rooftop strings", want: "t10" },
  { q: "dark rolling breakbeats with growly bass", want: "t18" },
  { q: "euphoric supersaws", want: "t15" },
  { q: "smoky late night rhodes", want: "t05" },
  { q: "acid line metallic loops", want: "t13" },
  { q: "skippy swung garage", want: "t19" },
  { q: "funky slap bass and guitar", want: "t09" },
  { q: "sleepy coffee shop beat", want: "t20", set: "paraphrase" },
  { q: "hands in the air big emotional synth anthem", want: "t15", set: "paraphrase" },
  { q: "very fast but smooth and dreamy jungle", want: "t17", set: "paraphrase" },
  { q: "seventies roller rink groove", want: "t09", set: "paraphrase" },
  { q: "late nineties london pirate radio vibe", want: "t19", set: "paraphrase" },
  { q: "a journey that keeps unfolding gradually", want: "t16", set: "paraphrase" },
  { q: "menacing jungle with a snarling low end", want: "t18", set: "paraphrase" },
  { q: "the hardest most aggressive banger of the night", want: "t14", set: "paraphrase" },
  { q: "summer terrace party with violins", want: "t10", set: "paraphrase" },
  { q: "squelchy 303 stripped-back groove", want: "t13", set: "paraphrase" },
];

async function main() {
  const isFind = suite === "find";
  if (!isFind && process.env.EVAL_ALLOW_RESET !== "1") {
    console.error("The guarantees suite resets the edmRoom demo data. Set EVAL_ALLOW_RESET=1 to run it.");
    process.exit(2);
  }
  await api("GET", "/api/health");
  const rows = isFind ? FIND_CASES.map((c) => ({ inputs: { q: c.q, set: c.set ?? "literal" }, outputs: { want: c.want } })) : guaranteeScenarios();
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",").map(Number) : null;
  const picked = (only ? rows.filter((_, i) => only.includes(i)) : rows).slice(0, limit);
  const name = isFind ? "musory-find-track" : "musory-guarantees";
  const data = await datasetFor(
    name,
    isFind ? "Describe a track you heard; does the search find it first?" : "Scripted guests: check in, tap, carry to the other venue, then forget me.",
    picked,
  );
  const target = isFind
    ? async (inp: Record<string, any>) => findTrack("all", inp.q, "compare")
    : runScenario;
  const evaluators = isFind
    ? (["words", "meaning", "hybrid", "reranked"] as const).map((m) => ({ outputs, referenceOutputs, inputs }: any) => ({
        key: `hit_at_1_${m}`,
        score: outputs?.[m]?.[0]?.trackId === referenceOutputs?.want ? 1 : 0,
        comment: `${inputs.set}: "${inputs.q}" -> ${outputs?.[m]?.[0]?.trackId ?? "none"} (want ${referenceOutputs?.want})`,
      }))
    : guaranteeEvaluators;
  const res = await evaluate(target as never, {
    data: data as never,
    evaluators: evaluators as never,
    experimentPrefix: isFind ? "find-track" : "guarantees",
    description: isFind ? "Hit@1 for words-only, meaning-only and $rankFusion" : "The four guarantees on the real API",
    maxConcurrency: 1,
    uploadRuns: upload,
    metadata: { app: "musory", base: "local API", run: runTag },
  });

  const metrics = new Map<string, EvalMetric>();
  let passed = 0;
  let errors = 0;
  const perSet: Record<string, Record<string, number>> = {};
  const forgetTimes: number[] = [];
  for (const row of res.results) {
    if (isFind) {
      const set = String(row.example.inputs.set);
      perSet[set] ??= { n: 0, words: 0, meaning: 0, hybrid: 0, reranked: 0 };
      perSet[set].n++;
      for (const r of row.evaluationResults.results) if (r.score === 1) perSet[set][r.key.replace("hit_at_1_", "")]++;
    }
    if (row.run.error) errors++;
    if (typeof row.run.outputs?.forgetMs === "number") forgetTimes.push(row.run.outputs.forgetMs);
    let ok = !row.run.error;
    for (const r of row.evaluationResults.results) {
      const m = metrics.get(r.key) ?? { key: r.key, passed: 0, total: 0 };
      m.total++;
      if (r.score === 1) m.passed++;
      else if (PASS_FAIL.includes(r.key)) ok = false;
      metrics.set(r.key, m);
    }
    if (isFind || ok) passed++;
    console.log(row.run.error ? `ERROR ${row.run.error}` : (isFind ? "" : `#${row.example.inputs.n} ${row.example.inputs.venue} ${row.example.inputs.profile} ${row.example.inputs.scope} consent=${row.example.inputs.consent} (${row.run.outputs?.ms} ms)\n  `) + row.evaluationResults.results.map((r: any) => `${r.key}=${r.score} [${r.comment ?? ""}]`).join("\n  "));
  }
  const list = [...metrics.values()];
  const url = await experimentUrl(res.experimentName);
  const m = (k: string) => metrics.get(k);
  const sentence = isFind
    ? `Find that track, ${picked.length} hand-written descriptions, ${TRACKS.length}-track catalogue: words ${m("hit_at_1_words")?.passed ?? 0}/${picked.length}, meaning ${m("hit_at_1_meaning")?.passed ?? 0}/${picked.length}, hybrid ${m("hit_at_1_hybrid")?.passed ?? 0}/${picked.length}, meaning + Voyage rerank-3 ${m("hit_at_1_reranked")?.passed ?? 0}/${picked.length} found first.`
    : `${passed} of ${picked.length} scripted forget-me runs on the real API: no trace of the guest's id left in any collection, and each room's next pick matched the pick computed, before the delete, without that guest. Tonight-only taps were refused from taste (121) and venue B was refused venue A (13, checked once per run).`;
  await saveEval({
    suite: isFind ? "find-track" : "guarantees",
    at: new Date(),
    scenarios: picked.length,
    passed: isFind ? (m("hit_at_1_hybrid")?.passed ?? 0) : passed,
    metrics: list,
    measured: isFind ? Object.fromEntries(Object.entries(perSet).map(([k, v]) => [k, `n ${v.n}: words ${v.words}, meaning ${v.meaning}, hybrid ${v.hybrid}, reranked ${v.reranked}`])) : { memoryChangedPick: `${m("memory_changed_pick")?.passed ?? 0}/${m("memory_changed_pick")?.total ?? 0}`, guestChangedPick: `${m("guest_changed_pick")?.passed ?? 0}/${m("guest_changed_pick")?.total ?? 0}`, errors, forgetMsMedian: forgetTimes.sort((a, b) => a - b)[Math.floor(forgetTimes.length / 2)] ?? 0, forgetMsMax: Math.max(0, ...forgetTimes) },
    langsmith: { uploaded: upload, experiment: res.experimentName, url, dataset: upload ? name : undefined },
    sentence: upload ? sentence : `${sentence} (local run)`,
    aborted: errors > 0,
  });
  console.log("\n" + sentence);
  if (isFind) console.log(JSON.stringify(perSet));
  console.log(list.map((x) => `${x.key}: ${x.passed}/${x.total}`).join("\n"));
  console.log(upload ? `LangSmith experiment: ${url ?? res.experimentName}` : "Local run: set LANGSMITH_API_KEY to upload.");
  if (!isFind) await api("POST", "/api/reset");
  await closeAll();
}

main().catch(async (e) => {
  console.error("eval failed:", (e as Error).message);
  await closeAll();
  process.exit(1);
});
