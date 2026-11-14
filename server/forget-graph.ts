// Forget me as a durable job: a LangGraph graph checkpointed in Atlas with MongoDBSaver.
//
//   accept -> erase -> verify
//
// accept  records which taps are the guest's, before anything is deleted (checkpointed in Atlas);
// erase   calls the room's forget (one transaction across every venue); safe to run again;
// verify  recounts every guest record, checks no derived record still points at those taps,
//         and writes the result onto the forget-me tombstone.
//
// Once "accept" is checkpointed, a restart can't lose the request: on boot, unfinished jobs resume at
// the step they stopped at. When a job ends (or is found finished on boot) its checkpoints are deleted,
// so the job's own log never outlives it as a copy of the guest's id.
//
// Never traced: a trace would copy the guest's id to a third party that forget me can't reach.
process.env.LANGSMITH_TRACING = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";
process.env.LANGCHAIN_TRACING = "false";

import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { client, db, redactError, DB_NAME, TAPS, DERIVED, CONSENTS, PRESENCE, SESSIONS, PREFS, TOMBSTONES } from "./db.js";
import { forget } from "./room.js";

export const forgetGraphOn = () => process.env.FORGET_GRAPH === "1";
export const CHECKPOINTS = "lg_checkpoints";
export const CHECKPOINT_WRITES = "lg_checkpoint_writes";
const THREAD_PREFIX = "forget-";

// Same keyed hash as the tombstone, so the job finds the receipt without storing the id there.
const hmac = (personId: string) => createHmac("sha256", process.env.TOMBSTONE_HMAC_KEY || "musory").update(personId).digest("hex");

const State = Annotation.Root({
  personId: Annotation<string>(),
  tapIds: Annotation<string[]>(),
  before: Annotation<number>(),
  erase: Annotation<{ ran: boolean; skipped?: string; receipt?: Record<string, any> } | null>(),
  verify: Annotation<{ ok: boolean; recordsLeft: number; derivedPointingAtTaps: number; tombstone: boolean; picksMatched: boolean | null } | null>(),
  steps: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
type S = typeof State.State;

async function recordsFor(personId: string) {
  const d = await db();
  const counts = await Promise.all([
    d.collection(TAPS).countDocuments({ personId }),
    d.collection(DERIVED).countDocuments({ ownerId: personId }),
    d.collection(CONSENTS).countDocuments({ personId }),
    d.collection(PRESENCE).countDocuments({ personId }),
    d.collection(SESSIONS).countDocuments({ personId }),
    d.collection(PREFS).countDocuments({ personId }),
  ]);
  return counts.reduce((s, x) => s + x, 0);
}

// A test hook for the kill/resume smoke: exit hard at the start of a step.
const killAt = (step: string) => {
  if (process.env.FORGET_GRAPH_KILL_AT === step) {
    console.error(`forget graph: killed at ${step} (test hook)`);
    process.exit(137);
  }
};

async function accept(s: S): Promise<Partial<S>> {
  const d = await db();
  const taps = await d.collection(TAPS).find({ personId: s.personId }, { projection: { _id: 1 } }).toArray();
  return { tapIds: taps.map((t) => String(t._id)), before: await recordsFor(s.personId), erase: null, verify: null, steps: ["accept"] };
}

async function erase(s: S): Promise<Partial<S>> {
  killAt("erase");
  if ((await recordsFor(s.personId)) > 0) {
    const receipt = (await forget(s.personId)) as Record<string, any>;
    return { erase: { ran: true, receipt }, steps: ["erase"] };
  }
  // Nothing left: either an earlier attempt committed the delete before a restart, or there was nothing.
  const d = await db();
  const tomb = await d.collection(TOMBSTONES).countDocuments({ hmac: hmac(s.personId) });
  return { erase: { ran: false, skipped: tomb ? "already erased before a restart" : "nothing to erase" }, steps: ["erase"] };
}

async function verify(s: S): Promise<Partial<S>> {
  killAt("verify");
  const d = await db();
  const recordsLeft = await recordsFor(s.personId);
  const ids = (s.tapIds ?? []).filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
  const derivedPointingAtTaps = ids.length ? await d.collection(DERIVED).countDocuments({ derivedFrom: { $in: ids } }) : 0;
  const tombstone = (await d.collection(TOMBSTONES).countDocuments({ hmac: hmac(s.personId) })) > 0 || s.before === 0;
  // The pick check needs the rooms as forget left them, so it only applies when erase ran in this process.
  const venues = s.erase?.receipt?.venues as { matchesWithoutYou: boolean }[] | undefined;
  const picksMatched = venues ? venues.every((v) => v.matchesWithoutYou) : null;
  // The job's guarantee is the delete itself; the pick check stays forget's own receipt line.
  const ok = recordsLeft === 0 && derivedPointingAtTaps === 0 && tombstone;
  const v = { ok, recordsLeft, derivedPointingAtTaps, tombstone, picksMatched };
  await d.collection(TOMBSTONES).updateOne({ hmac: hmac(s.personId) }, { $set: { durableCheck: { ...v, steps: [...s.steps, "verify"], at: new Date() } } });
  // The guest's id and tap ids leave the job's state before its last checkpoint is written.
  return { verify: v, personId: "", tapIds: [], steps: ["verify"] };
}

let saver: MongoDBSaver | null = null;
let graph: ReturnType<typeof build> | null = null;
function build(checkpointer: MongoDBSaver) {
  return new StateGraph(State)
    .addNode("accept", accept)
    .addNode("erase", erase)
    .addNode("verify", verify)
    .addEdge(START, "accept")
    .addEdge("accept", "erase")
    .addEdge("erase", "verify")
    .addEdge("verify", END)
    .compile({ checkpointer });
}
async function ready() {
  if (graph && saver) return { graph, saver };
  // The checkpointer bundles its own driver types; the app's MongoClient (7.9) speaks the same protocol.
  saver = new MongoDBSaver({ client: (await client("app")) as never, dbName: DB_NAME, checkpointCollectionName: CHECKPOINTS, checkpointWritesCollectionName: CHECKPOINT_WRITES });
  const errs = await saver.setup();
  if (errs.length) console.error("forget graph: checkpoint index setup:", errs.map((e) => e.message).join("; "));
  graph = build(saver);
  return { graph, saver };
}

async function checkpointDocs(threadId: string) {
  const d = await db();
  const [a, b] = await Promise.all([d.collection(CHECKPOINTS).countDocuments({ thread_id: threadId }), d.collection(CHECKPOINT_WRITES).countDocuments({ thread_id: threadId })]);
  return a + b;
}

async function finish(threadId: string, final: S, resumed: boolean) {
  const { saver } = await ready();
  const written = await checkpointDocs(threadId);
  await saver.deleteThread(threadId);
  const left = await checkpointDocs(threadId);
  const receipt = final.erase?.receipt ?? { totalBefore: final.before ?? 0, totalAfter: 0, venues: [] };
  return {
    ...receipt,
    durable: {
      engine: "LangGraph + MongoDBSaver",
      steps: final.steps,
      resumed,
      erase: final.erase?.ran ? "ran" : final.erase?.skipped ?? "unknown",
      verified: Boolean(final.verify?.ok),
      recordsLeft: final.verify?.recordsLeft ?? null,
      derivedPointingAtYourTaps: final.verify?.derivedPointingAtTaps ?? null,
      checkpointsWritten: written,
      checkpointsLeft: left,
    },
  };
}

const running = new Map<string, Promise<unknown>>();

/** Forget me through the durable job. Same receipt as forget(), plus what the job did. */
export async function runForgetGraph(personId: string) {
  const threadId = THREAD_PREFIX + hmac(personId).slice(0, 32);
  const inflight = running.get(threadId);
  if (inflight) return inflight;
  const job = (async () => {
    const { graph } = await ready();
    const cfg = { configurable: { thread_id: threadId } };
    const final = (await graph.invoke({ personId, steps: [] } as never, cfg)) as S;
    return finish(threadId, final, false);
  })();
  running.set(threadId, job);
  try {
    return await job;
  } finally {
    running.delete(threadId);
  }
}

/** On boot: resume every unfinished forget job, and delete the checkpoints of finished ones. */
export async function resumePending() {
  const { graph } = await ready();
  const d = await db();
  const threads = (await d.collection(CHECKPOINTS).distinct("thread_id", { thread_id: { $regex: `^${THREAD_PREFIX}` } })) as string[];
  const out: unknown[] = [];
  for (const threadId of threads) {
    const cfg = { configurable: { thread_id: threadId } };
    try {
      const state = await graph.getState(cfg);
      const unfinished = (state.next ?? []).length > 0;
      const final = unfinished ? ((await graph.invoke(null as never, cfg)) as S) : (state.values as S);
      const r = await finish(threadId, final, unfinished);
      out.push({ resumedAt: unfinished ? state.next : null, durable: (r as { durable: unknown }).durable });
      console.log(`forget graph: ${unfinished ? `resumed at ${state.next.join(",")}` : "cleaned a finished job"}`);
    } catch (e) {
      console.error("forget graph: resume failed", redactError(e).message);
    }
  }
  return out;
}
