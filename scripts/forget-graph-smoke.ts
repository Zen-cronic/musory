// Kill/resume smoke for the durable forget-me job (server/forget-graph.ts).
//
//   FORGET_SMOKE_OK=1 pnpm smoke:forget-graph
//
// Uses the running server (EVAL_BASE_URL, default :4377) to create two scripted guests, then runs the
// job in child processes that are killed (exit 137) at the start of a step, and a fresh process that
// resumes them. Writes to the shared edmRoom database: run only in an agreed slot.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { db, closeAll, DERIVED, PLAYS, TOMBSTONES, VENUE_IDS } from "../server/db.js";

const BASE = (process.env.EVAL_BASE_URL || `http://localhost:${process.env.PORT || 4377}`).replace(/\/$/, "");
const self = fileURLToPath(import.meta.url);
const hmac = (p: string) => createHmac("sha256", process.env.TOMBSTONE_HMAC_KEY || "musory").update(p).digest("hex");

async function hydrateRooms() {
  // A child process has no player: give its rooms the latest play and decision the server committed.
  const { rooms, loadTracks } = await import("../server/room.js");
  await loadTracks();
  const d = await db();
  for (const v of VENUE_IDS) {
    const p = await d.collection(PLAYS).find({ venueId: v }).sort({ startedAt: -1 }).limit(1).next();
    if (p) rooms[v].play = { playId: String(p._id), trackId: String(p.trackId), startedAt: +p.startedAt, endsAt: +p.endsAt, memoryChangedPick: false, baselinePick: null } as never;
    rooms[v].next = await d.collection(DERIVED).find({ kind: "decision", venueId: v }).sort({ at: -1 }).limit(1).next();
  }
}

async function child(mode: string, personId?: string) {
  await hydrateRooms();
  const fg = await import("../server/forget-graph.js");
  const out = mode === "run" ? await fg.runForgetGraph(personId!) : await fg.resumePending();
  console.log("RESULT " + JSON.stringify(out));
  await closeAll();
  process.exit(0);
}

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
  return j;
}

function spawn(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [...process.execArgv, self, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 90_000 });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  return { code: r.status, result: line ? JSON.parse(line.slice(7)) : null, err: (r.stderr ?? "").split("\n").filter((l) => l && !l.includes("dotenv")).slice(-3).join(" | ") };
}

async function records(personId: string) {
  const d = await db();
  let n = 0;
  for (const c of await d.listCollections({ type: "collection" }, { nameOnly: true }).toArray()) {
    if (c.name.startsWith("system.")) continue;
    for (const doc of await d.collection(c.name).find({}).toArray()) if (JSON.stringify(doc).includes(personId)) n++;
  }
  return n;
}
const checkpoints = async (personId: string) => {
  const d = await db();
  const t = "forget-" + hmac(personId).slice(0, 32);
  return (await d.collection("lg_checkpoints").countDocuments({ thread_id: t })) + (await d.collection("lg_checkpoint_writes").countDocuments({ thread_id: t }));
};
const tombstones = async (personId: string) => (await db()).collection(TOMBSTONES).countDocuments({ hmac: hmac(personId) });

let failures = 0;
const check = (name: string, ok: boolean, detail: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

async function variant(killAt: "erase" | "erase-committed" | "verify") {
  const personId = `fgsmoke-${Date.now().toString(36)}-${killAt}`;
  await api("POST", "/api/checkin", { personId, venueId: "copper", scopes: ["use_taste", "contribute_crowd"] });
  for (const trackId of ["t13", "t15"]) await api("POST", "/api/tap", { personId, signal: 1, trackId });
  await new Promise((r) => setTimeout(r, 2500));
  const before = await records(personId);
  const a = spawn(["--child", "run", personId], { FORGET_GRAPH_KILL_AT: killAt });
  const afterKill = { exit: a.code, documentsWithId: await records(personId), checkpoints: await checkpoints(personId), tombstones: await tombstones(personId) };
  check(`killed at ${killAt}: process exited 137 with the request checkpointed`, a.code === 137 && afterKill.checkpoints > 0, { ...afterKill, before, stderr: a.err });
  const b = spawn(["--child", "resume"]);
  const mine = (b.result ?? []).find((x: any) => x?.durable) as any;
  const all = (b.result ?? []) as any[];
  const job = all.find((x) => x.durable && x.durable.steps) ?? mine;
  const left = await records(personId);
  const tombs = await tombstones(personId);
  check(`resumed after kill at ${killAt}`, b.code === 0 && Boolean(job?.durable?.resumed), { exit: b.code, resumedAfter: job?.resumedAfter, steps: job?.durable?.steps, erase: job?.durable?.erase, stderr: b.code ? b.err : undefined });
  check("each step ran once", JSON.stringify(job?.durable?.steps) === JSON.stringify(["accept", "erase", "verify"]), job?.durable?.steps);
  // erase: killed before the delete, so the resumed job deletes. erase-committed: killed after the delete
  // committed but before its checkpoint, so the resumed job re-enters erase and must find nothing to do.
  // verify: the erase step's checkpoint exists, so the resumed job doesn't re-enter erase at all.
  const wantErase = killAt === "erase-committed" ? "already erased before a restart" : "ran";
  check(`erase after the restart: ${wantErase}`, job?.durable?.erase === wantErase, job?.durable?.erase);
  check("verified: 0 records, nothing derived points at the taps, tombstone", job?.durable?.verified === true, { recordsLeft: job?.durable?.recordsLeft, derived: job?.durable?.derivedPointingAtYourTaps });
  check("one tombstone", tombs === 1, tombs);
  check("no copy of the guest id in any collection, checkpoints included", left === 0, { documentsWithId: left, checkpointsLeft: job?.durable?.checkpointsLeft });
}

if (process.argv[2] === "--child") await child(process.argv[3], process.argv[4]);
else {
  if (process.env.FORGET_SMOKE_OK !== "1") {
    console.error("Writes to the shared edmRoom database. Set FORGET_SMOKE_OK=1 in an agreed slot.");
    process.exit(2);
  }
  await api("GET", "/api/health");
  await variant("verify");
  await variant("erase");
  await variant("erase-committed");
  console.log(failures ? `${failures} check(s) failed` : "forget graph smoke: all checks passed");
  await closeAll();
  process.exit(failures ? 1 : 0);
}
