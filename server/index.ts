import "dotenv/config";
import express from "express";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { ObjectId } from "mongodb";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { db, redactError, isVenue, VENUES, VENUE_IDS, TRACKS, TAPS, DERIVED, PRESENCE, CONSENTS, SESSIONS, PREFS, PLAYS, TOMBSTONES, type VenueId } from "./db.js";
import { subscribe, emit, recentEvents, clientCount } from "./events.js";
import {
  HttpError, fail, loadTracks, startPlayer, resetAndSeed, roomState, me, personOf, checkin, checkout, tap, bored, undoBored,
  startTonight, endTonight, keepTonightTap, forget, proof, headline, nextHour, clockState, advance, playView, rooms, guestLabel,
  emitPresence, scheduleRefresh, crossVenueRead, withoutYou, filmReset, guestTag, STAGE, simulateGuests, dropQueuedClip, clearLoadGuests,
} from "./room.js";
import { generateFromRoom, hasMusicKey, liveMusicOn, musicState, pauseMusic, setAudience, markTheirTurn, audienceState } from "./music.js";
import { forgetGraphOn, runForgetGraph, resumePending } from "./forget-graph.js";
import { findOn, findTrack } from "./find.js";
import { latestEvals } from "./evals.js";
import { vibeTap, vibeOn } from "./vibe.js";
import { byId } from "./catalog.js";
import { removeClipAudio } from "./expiry.js";

// "Start your taste": one short sample per sound, so a new guest can say what they like in one tap.
const SAMPLES = ["t13", "t10", "t17", "t15", "t08", "t05"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
app.use(express.json({ limit: "32kb" }));
app.set("trust proxy", "loopback");

// Room and demo controls work only from the laptop itself: a request that came through a tunnel or proxy
// (Cloudflare adds cf-ray / cf-connecting-ip; others add x-forwarded-for) or from another device is refused,
// unless it carries the local ADMIN_TOKEN. Guest routes (check in, tap, forget me) stay open.
const ADMIN = [
  /^\/api\/reset$/, /^\/api\/film\//, /^\/api\/volunteer$/, /^\/api\/room\/[a-z]+\/(skip|generate|read-other)$/,
  /^\/api\/clock\/next$/, /^\/api\/stage\//, /^\/api\/proof\//, /^\/api\/evals?\//,
];
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export function isLocalAdmin(req: express.Request): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.get("x-admin-token") === token) return true;
  const proxied = Boolean(
    req.get("cf-ray") || req.get("cf-connecting-ip") || req.get("x-forwarded-for") || req.get("forwarded") || req.get("x-musory-public") === "1",
  );
  return !proxied && LOOPBACK.has(req.socket.remoteAddress ?? "");
}
app.use((req, res, next) => {
  // Routes match case-insensitively and with a trailing slash, so the lock normalises the path the same way.
  const p = req.path.toLowerCase().replace(/\/+$/, "") || "/";
  if (req.method !== "GET" && ADMIN.some((r) => r.test(p)) && !isLocalAdmin(req)) {
    res.status(403).json({ error: { message: "Room controls work only on the venue's own screen." } });
    return;
  }
  next();
});
app.use(express.static(path.join(root, "public")));

const LAN = process.env.LAN === "1";
const port = Number(process.env.PORT || 4377);
function lanIp(): string | null {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  return null;
}
/** The address phones should open: a public URL when deployed, the laptop's LAN address in LAN mode. */
let publicBase = process.env.PUBLIC_BASE_URL || "";
function baseUrl(req: express.Request): string {
  if (publicBase) return publicBase.replace(/\/$/, "");
  if (LAN) {
    const ip = lanIp();
    if (ip) return `http://${ip}:${port}`;
  }
  return `${req.protocol}://${req.get("host")}`;
}

const venueOf = (v: unknown): VenueId => {
  if (!isVenue(v)) throw fail(404, "Unknown venue");
  return v;
};
const wrap =
  (fn: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const s = redactError(e);
      if (status >= 500) console.error("request failed:", req.path, s.codeName ?? "", s.message.slice(0, 200));
      res.status(status).json({ error: s });
    }
  };

// Pages
const page = (file: string) => (_req: express.Request, res: express.Response) => res.sendFile(path.join(root, "public", file));
app.get("/", page("landing.html")); // the product page; /start is the room launcher
app.get("/start", page("start.html"));
app.get("/room/:venue", page("room.html"));
app.get("/join/:venue", page("phone.html"));
app.get("/me", page("phone.html"));
app.get("/join", page("phone.html"));
app.get("/p/:guest", page("phone.html"));
app.get("/proof", page("proof.html"));
app.get("/about", page("landing.html"));
// Pages the visual layer adds (stage mode, how it works): 404 until the file exists.
// /stage falls back to the room screen (Copper Bar, with the Simulated guests button) until stage.html lands.
for (const name of ["stage", "how"])
  app.get(`/${name}`, (_req, res) => {
    const file = path.join(root, "public", `${name}.html`);
    if (existsSync(file)) res.sendFile(file);
    else if (name === "stage") res.sendFile(path.join(root, "public", "room.html"));
    else res.status(404).send("Not built yet");
  });

// Stream
app.get("/events", (req, res) => subscribe(res));
app.get("/api/recent", (_req, res) => res.json(recentEvents()));

// Read
app.get("/api/config", (req, res) =>
  res.json({
    admin: isLocalAdmin(req),
    baseUrl: baseUrl(req),
    lan: LAN,
    stage: STAGE,
    music: hasMusicKey(),
    musicLive: liveMusicOn(),
    vibe: vibeOn(),
    venues: VENUE_IDS.map((v) => ({ id: v, name: VENUES[v].name, view: VENUES[v].view })),
    clock: clockState(),
  }),
);
app.get("/api/qr", async (req, res) => {
  try {
    const venue = venueOf(req.query.venue);
    const style = typeof req.query.style === "string" && /^[a-z0-9-]{1,24}$/.test(req.query.style) ? req.query.style : "";
    const url = `${baseUrl(req)}/join/${venue}${style ? `?style=${style}` : ""}`;
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#111111", light: "#F4F1EA" } });
    res.type("image/svg+xml").send(svg);
  } catch (e) {
    res.status(404).send(String((e as Error).message));
  }
});
app.get("/api/room/:venue", wrap(async (req) => roomState(venueOf(req.params.venue))));
app.get("/api/me", wrap(async (req) => me(personOf(req.query.personId))));
app.get("/api/number", wrap(async () => headline()));
app.get("/api/without", wrap(async (req) => withoutYou(personOf(req.query.personId))));

// Guest actions
app.post("/api/checkin", wrap(async (req) => checkin(personOf(req.body?.personId), venueOf(req.body?.venueId), Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : ["use_taste", "contribute_crowd"])));
app.post("/api/checkout", wrap(async (req) => checkout(personOf(req.body?.personId))));
app.post("/api/tap", wrap(async (req) => tap(personOf(req.body?.personId), Number(req.body?.signal) < 0 ? -1 : 1, req.body?.trackId ? String(req.body.trackId) : undefined)));
app.get("/api/samples", (_req, res) => res.json(SAMPLES.map((id) => ({ trackId: id, ...byId.get(id) }))));
app.post("/api/bored", wrap(async (req) => bored(personOf(req.body?.personId))));
app.post("/api/bored/undo", wrap(async (req) => undoBored(personOf(req.body?.personId), String(req.body?.prefId ?? ""))));
app.post("/api/tonight/start", wrap(async (req) => startTonight(personOf(req.body?.personId))));
app.post("/api/tonight/end", wrap(async (req) => endTonight(personOf(req.body?.personId))));
app.post("/api/tonight/keep", wrap(async (req) => keepTonightTap(personOf(req.body?.personId), String(req.body?.tapId ?? ""))));
app.post("/api/forget", wrap(async (req) => (forgetGraphOn() ? runForgetGraph : forget)(personOf(req.body?.personId))));
app.get("/api/find", wrap(async (req) => {
  if (!findOn()) throw fail(404, "Track search is off.");
  return findTrack(req.query.venue, req.query.q, req.query.mode);
}));
app.get("/api/evals/latest", wrap(async () => latestEvals()));
app.post("/api/vibe", wrap(async (req) => vibeTap(personOf(req.body?.personId), req.body?.text)));

// Room and demo controls
app.post("/api/room/:venue/skip", wrap(async (req) => {
  const v = venueOf(req.params.venue);
  await advance(v);
  return { play: playView(v) };
}));
app.post("/api/room/:venue/generate", wrap(async (req) => generateFromRoom(venueOf(req.params.venue), { reason: "requested" })));
app.get("/api/music", (_req, res) => res.json(musicState()));
app.post("/api/room/:venue/read-other", wrap(async (req) => {
  const v = venueOf(req.params.venue);
  return crossVenueRead(v, v === "copper" ? "basement" : "copper");
}));
app.post("/api/clock/next", wrap(async () => nextHour()));
app.post("/api/proof/:name", wrap(async (req) => proof(String(req.params.name), req.body?.personId ? personOf(req.body.personId) : undefined)));
app.post("/api/reset", wrap(async () => resetAndSeed()));
app.post("/api/film/reset", wrap(async () => filmReset()));
app.post("/api/volunteer", wrap(async (req) => {
  const v = venueOf(req.body?.venueId);
  const d = await db();
  const guests = await d.collection(PRESENCE).find({ venueId: v, personId: { $not: /^g-(ben|carla|tess|joel|mark|julie|sam|ray)$/ } }).toArray();
  if (!guests.length) throw fail(409, "No guests checked in yet.");
  const pick = guests[Math.floor(Math.random() * guests.length)];
  // The phone recognises itself by a short tag of its own id; the id itself never goes out.
  emit("volunteer", { venueId: v, tag: guestTag(String(pick.personId)) });
  return { label: guestLabel(String(pick.personId)) };
}));
// Point the QR codes at a public URL (e.g. a tunnel) without a restart. Local screen only (see the lock).
app.post("/api/stage/base-url", wrap(async (req) => {
  const url = String(req.body?.url ?? "");
  if (url && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(url)) throw fail(400, "Expected an https origin, like https://example.trycloudflare.com");
  publicBase = url;
  return { baseUrl: publicBase || null };
}));
app.post("/api/stage/audience", wrap(async (req) => setAudience(Boolean(req.body?.on))));
app.post("/api/stage/their-turn", wrap(async (req) => markTheirTurn(venueOf(req.body?.venueId ?? "copper"))));
app.get("/api/stage/audience", (_req, res) => res.json(audienceState()));
app.post("/api/stage/music-pause", wrap(async (req) => pauseMusic(Number(req.body?.seconds ?? 90))));
app.post("/api/stage/clear-load", wrap(async () => clearLoadGuests()));
app.post("/api/stage/simulate", wrap(async (req) => simulateGuests(venueOf(req.body?.venueId ?? "copper"), req.body?.genre ? String(req.body.genre) : undefined)));
let ready = false; // true once tracks are loaded, change streams are on and the rooms are playing
// Every sound the rooms play is read from Atlas. Catalogue tracks (shared, nothing personal) may be cached;
// a track made for a room is never cached and is gone (404) once forget me or closing time deletes its record.
const catalogueAudio = new Map<string, Buffer>();
async function sendAudio(id: string, res: express.Response) {
  const d = await db();
  if (/^t\d{2}$/.test(id)) {
    let buf = catalogueAudio.get(id);
    if (!buf) {
      const doc = await d.collection(TRACKS).findOne({ _id: id as never }, { projection: { audio: 1 } });
      const b = doc?.audio?.bytes as { buffer: Uint8Array } | undefined;
      if (!b) return void res.status(404).end();
      buf = Buffer.from(b.buffer);
      catalogueAudio.set(id, buf);
    }
    res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "Content-Length": String(buf.length) });
    return void res.end(buf);
  }
  if (!/^[a-f0-9]{24}$/.test(id)) return void res.status(404).end();
  const doc = await d.collection(DERIVED).findOne({ _id: new ObjectId(id), kind: "clip" }, { projection: { audio: 1 } });
  const b = doc?.audio?.bytes as { buffer: Uint8Array } | undefined;
  if (!b) return void res.status(404).end();
  res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": String(b.buffer.length) });
  res.end(Buffer.from(b.buffer));
}
for (const route of ["/api/audio/:id", "/api/clip/:id"])
  app.get(route, (req, res) => sendAudio(String(req.params.id), res).catch((e) => res.status(500).json({ error: redactError(e) })));
app.get("/api/health", (_req, res) => res.json({ ok: true, ready, clients: clientCount(), rooms: VENUE_IDS.map((v) => ({ v, play: rooms[v].play?.trackId })) }));

// Change streams: rooms and screens are driven by what the database commits.
async function watch() {
  const d = await db();
  const colls = [TAPS, DERIVED, PRESENCE, CONSENTS, SESSIONS, PREFS, PLAYS, TOMBSTONES];
  for (const coll of colls) {
    const start = () => {
      const cs = d.collection(coll).watch([], { fullDocument: coll === DERIVED || coll === PLAYS ? "updateLookup" : undefined });
      cs.on("change", (ch) => {
        const c = ch as { operationType: string; fullDocument?: Record<string, any>; documentKey?: { _id: unknown } };
        // A guest left a room (checked out, moved, or their presence expired): that room re-mixes.
        if (coll === PRESENCE && c.operationType === "delete") {
          const v = String(c.documentKey?._id ?? "").split("|")[0];
          if (isVenue(v)) {
            void emitPresence(v);
            void scheduleRefresh(v);
          }
        }
        const doc = c.fullDocument;
        // Nothing that names a guest leaves the server: collection, operation, venue and kind only.
        emit("change_event", {
          coll,
          op: c.operationType,
          venueId: doc?.venueId ?? null,
          kind: doc?.kind ?? null,
          scope: doc?.scope ?? null,
          signal: doc?.signal ?? null,
          at: Date.now(),
        });
        if (coll === PLAYS && c.operationType === "insert" && doc && isVenue(doc.venueId)) emit("play", { venueId: doc.venueId, play: playView(doc.venueId) });
        if (coll === DERIVED && doc?.kind === "decision" && c.operationType === "insert") {
          const { derivedFrom, ...rest } = doc;
          emit("next", { venueId: doc.venueId, decision: rest });
        }
        // A composed clip expired (TTL) or was forgotten: remove its audio file and drop it from any queue.
        if (coll === DERIVED && c.operationType === "delete") {
          removeClipAudio(c.documentKey?._id);
          dropQueuedClip(String((c.documentKey?._id as { toHexString?: () => string })?.toHexString?.() ?? ""));
        }
        if (coll === DERIVED && doc?.kind === "crowd")
          emit("crowd", { venueId: doc.venueId, contributors: doc.distinctContributors, weights: doc.weights });
      });
      cs.on("error", (e) => {
        console.error("change stream error", coll, redactError(e).message);
        setTimeout(start, 2000);
      });
    };
    start();
  }
}

const host = LAN || process.env.PUBLIC_BASE_URL ? "0.0.0.0" : "127.0.0.1";
app.listen(port, host, async () => {
  console.log(`Musory on http://localhost:${port}/`);
  if (LAN) console.log(`LAN mode: phones open http://${lanIp()}:${port}/`);
  try {
    await loadTracks();
    await watch();
    console.log("change streams on");
    const d = await db();
    startPlayer();
    ready = true;
    if (forgetGraphOn()) void resumePending();
    if (!(await d.collection(PLAYS).countDocuments({}))) await resetAndSeed();
    console.log("rooms playing");
  } catch (e) {
    console.error("startup failed", redactError(e).message);
  }
});
