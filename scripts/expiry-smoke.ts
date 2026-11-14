// Smoke for server/expiry.ts: a test clip record that is already past closing is removed by the Atlas
// TTL monitor, and the change stream's delete event removes its audio file. Inserts one test record
// (kind "clip", no venue, test: true) into edmRoom.derived and one dummy file; both are gone at the end.
import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ObjectId } from "mongodb";
import { db, closeAll, DERIVED } from "../server/db.js";
import { ensureClipExpiry, removeClipAudio } from "../server/expiry.js";

const d = await db();
await ensureClipExpiry(d);
const idx = (await d.collection(DERIVED).indexes()).find((i) => i.name === "clips_expire_after_closing");
console.log("TTL index:", JSON.stringify({ key: idx?.key, expireAfterSeconds: idx?.expireAfterSeconds, partial: idx?.partialFilterExpression }));
const id = new ObjectId();
const file = path.join("public", "audio", "gen", `${id.toHexString()}.mp3`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, "test");
const cs = d.collection(DERIVED).watch([{ $match: { operationType: "delete", "documentKey._id": id } }]);
const deleted = new Promise<number>((resolve) => cs.on("change", (c) => { removeClipAudio((c as { documentKey: { _id: unknown } }).documentKey._id); resolve(Date.now()); }));
await new Promise((r) => setTimeout(r, 500));
const t0 = Date.now();
await d.collection(DERIVED).insertOne({ _id: id, kind: "clip", test: true, derivedFrom: [new ObjectId()], at: new Date(), expiresAt: new Date(Date.now() - 1000) });
const at = await Promise.race([deleted, new Promise<number>((r) => setTimeout(() => r(0), 180_000))]);
const gone = !(await d.collection(DERIVED).findOne({ _id: id }));
console.log(at ? `TTL removed the record after ${((at - t0) / 1000).toFixed(1)} s` : "TTL did not remove the record within 180 s");
console.log(`record gone: ${gone}; audio file gone: ${!existsSync(file)}`);
if (!gone) await d.collection(DERIVED).deleteOne({ _id: id });
removeClipAudio(id);
await cs.close();
await closeAll();
process.exit(at && gone && !existsSync(file) ? 0 : 1);
