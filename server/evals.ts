// Results of the guarantee experiments (scripts/eval.ts), kept in edmRoom.evals so the
// proof screen can show the latest pass rate and its LangSmith link.
import { db } from "./db.js";

export const EVALS = "evals";

export type EvalMetric = { key: string; passed: number; total: number };
export type EvalRecord = {
  suite: "guarantees" | "find-track";
  at: Date;
  scenarios: number;
  passed: number; // scenarios where every pass/fail check passed
  metrics: EvalMetric[];
  measured?: Record<string, number | string>;
  langsmith: { uploaded: boolean; experiment?: string; url?: string; dataset?: string };
  sentence: string;
};

export async function saveEval(rec: EvalRecord) {
  const d = await db();
  await d.collection(EVALS).insertOne(rec);
}

export async function latestEvals() {
  const d = await db();
  const out: Record<string, unknown> = {};
  for (const suite of ["guarantees", "find-track"]) {
    const row = await d.collection(EVALS).find({ suite }, { projection: { _id: 0 } }).sort({ at: -1 }).limit(1).next();
    out[suite] = row ?? null;
  }
  return out;
}
