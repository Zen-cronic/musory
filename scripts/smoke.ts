export {};
// End-to-end checks against the running server (default http://localhost:4377).
// Every claim in the README's proof table is one of these checks.
const BASE = process.env.BASE || "http://localhost:4377";
let pass = 0;
let fail = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}
async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const room = (v: string) => api(`/api/room/${v}`);

// Wait until the server has finished starting (tracks loaded, change streams on, rooms playing).
for (let i = 0; i < 60; i++) {
  const h = await fetch(BASE + "/api/health").then((r) => r.json()).catch(() => null);
  if (h?.ready) break;
  await sleep(500);
}
// Listen to the screens' event stream: nothing on it may name a guest.
const streamed: { type: string; data: any }[] = [];
const ac = new AbortController();
void (async () => {
  const r = await fetch(BASE + "/events", { signal: ac.signal });
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
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (type && data) streamed.push({ type, data: JSON.parse(data) });
    }
  }
})();
await api("/api/film/reset", {});
const guest = `smoke-${Date.now() % 1_000_000}`;

// 1. Check in with consent, then taps change the pick against the no-memory pick.
const c = await api("/api/checkin", { personId: guest, venueId: "copper", scopes: ["use_taste", "contribute_crowd"] });
check("check in at Copper Bar with consent", c.venueId === "copper" && c.consents?.[0]?.scopes?.length === 2);
await api("/api/tap", { personId: guest, signal: 1, trackId: "t17" });
await api("/api/tap", { personId: guest, signal: 1, trackId: "t18" });
const dup = await api("/api/tap", { personId: guest, signal: 1, trackId: "t17" });
check("a second like on the same track is refused (E11000)", dup.already === true);
await sleep(2500);
let r = await room("copper");
// Either the room already moved to the guest's sound (the play records what the no-memory pick was),
// or the next pick differs from the no-memory pick.
const moved = r.play?.memoryChangedPick === true || r.next?.memoryChangedPick === true;
check("the taps change Copper Bar's pick vs the no-memory pick", moved, `playing ${r.play?.title} (no memory: ${r.play?.baselinePick?.title ?? "-"}), next ${r.next?.picked?.title} (no memory: ${r.next?.baselinePick?.title})`);
const tap = (await api(`/api/me?personId=${guest}`)).taps?.[0];
check("the tap is saved with track, venue and time", Boolean(tap?.trackId && tap?.venueId === "copper" && tap?.at));

// 2. Taste carries to Pulse Club at once.
const before = (await room("basement")).next;
await api("/api/checkin", { personId: guest, venueId: "basement" });
await sleep(2000); // the room re-picks right after the check-in
r = await room("basement");
check("taste applies at Pulse Club immediately", r.next?.sharingCount >= 1 && r.next?.parts?.taste > 0, `sharing ${r.next?.sharingCount}, pick ${before?.picked?.title} -> ${r.next?.picked?.title}`);

// "Tell the room what you want": a few words become one like on the closest track.
let vibeClipUrl: string | undefined;
const cfg0 = await api("/api/config");
if (cfg0.vibe) {
  await sleep(1100);
  const from = streamed.length;
  const tv = Date.now();
  const v = await api("/api/vibe", { personId: guest, text: "something dark and driving" });
  check("tell the room what you want: words become a like on the closest track", v.status === 200 && Boolean(v.vibe?.trackId), `${v.vibe?.title} (${v.vibe?.genre})`);
  if (cfg0.musicLive && v.making) {
    let made: any = null;
    for (let i = 0; i < 40 && !made; i++) {
      await sleep(250);
      made = streamed.slice(from).find((e) => e.type === "play" && e.data.venueId === "basement" && e.data.play?.composed);
    }
    vibeClipUrl = made?.data.play.audio;
    check("the room makes and plays a track for what the guest asked for", Boolean(made), made ? `${((Date.now() - tv) / 1000).toFixed(1)} s from the words to the new track` : "no track");
  }
}

// 3. Bored of this: likes superseded, then undo.
const pre = await api(`/api/me?personId=${guest}`);
const playing = (await room("basement")).play?.genre;
const b = await api("/api/bored", { personId: guest });
check("bored of this runs (superseded or nothing to set aside)", b.status === 200, `${b.superseded} ${b.genre} likes, playing ${playing}`);
if (b.superseded) {
  const u = await api("/api/bored/undo", { personId: guest, prefId: b.prefId });
  check("undo restores the superseded likes", u.restored === b.superseded);
}
void pre;

// 4. Tonight only: tonight taps never enter long-term taste unless kept (121).
await api("/api/tonight/start", { personId: guest });
await api("/api/tap", { personId: guest, signal: 1 });
const leak = await api("/api/proof/tonight-leak", { personId: guest });
check("a tonight-only tap can't enter long-term taste (121)", leak.ok === false && leak.error?.code === 121);
await api("/api/tonight/end", { personId: guest });

// 5. Venue isolation and venue memory rules.
const cross = await api("/api/proof/cross-venue", {});
check("Pulse Club's login can't read Copper Bar's crowd memory (13)", cross.ok === false && cross.error?.code === 13);
const own = await api("/api/proof/own-venue", {});
check("Copper Bar's login reads its own crowd memory", own.ok === true);
const raw = await api("/api/proof/venue-reads-taps", {});
check("a venue login can't read guests' raw taps (13)", raw.ok === false && raw.error?.code === 13);
const under3 = await api("/api/proof/crowd-under-3", {});
check("crowd memory from fewer than 3 people is refused (121)", under3.ok === false && under3.error?.code === 121);
const others = await api("/api/proof/others-taps", {});
check("taste built from someone else's taps is refused (121)", others.ok === false && others.error?.code === 121);
const ident = await api("/api/proof/identity-in-venue", {});
check("a guest id in venue memory is refused (121)", ident.ok === false && ident.error?.code === 121);

// 6. Forget me: N -> 0, every venue's crowd memory rebuilt, the room plays the pick without them.
const w = await api(`/api/without?personId=${guest}`);
const f = await api("/api/forget", { personId: guest });
if (vibeClipUrl) {
  check("forget me counts the track made for the guest's words", (f.before?.composedClips ?? 0) >= 1, `composedClips ${f.before?.composedClips}`);
  const gone = await fetch(BASE + vibeClipUrl);
  check("that track's sound is gone after forget me (404)", gone.status === 404);
}
check("forget me removes every record (N -> 0)", f.totalBefore > 0 && f.totalAfter === 0, `${f.totalBefore} -> ${f.totalAfter}, txn ${f.txnMs} ms`);
check("forget me removed the guest's share from both venues' crowd memory", (f.venues ?? []).filter((v: any) => v.contributionRemoved).length === 2);
await sleep(500);
for (const v of ["copper", "basement"]) {
  const now = (await room(v)).play?.trackId;
  const promised = (f.venues ?? []).find((x: any) => x.venueId === v)?.pickWithoutYou?.trackId;
  const preview = (w.venues ?? []).find((x: any) => x.venueId === v)?.withoutYou?.trackId;
  check(`${v}: now playing the pick without them`, Boolean(now && now === promised), `${now} vs ${promised}; preview ${preview}`);
}
// Room controls refuse anything that looks like it came through the public link, however the path is spelled.
for (const p of ["/api/reset", "/API/RESET", "/api/reset/", "/api/stage/simulate"]) {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-musory-public": "1" }, body: "{}" });
  check(`room control ${p} through the public link is refused (403)`, r.status === 403);
}
// Every sound comes from Atlas: a catalogue track streams from its track document.
const cat = await fetch(BASE + "/api/audio/t01");
check("a catalogue track's sound streams from Atlas", cat.status === 200 && cat.headers.get("content-type") === "audio/mpeg" && (await cat.arrayBuffer()).byteLength > 100_000);
// With live music on: the demo guest checks in, the room makes a track from her taste, and forget me deletes its sound.
const cfg = await api("/api/config");
if (cfg.musicLive) {
  const from = streamed.length;
  await api("/api/checkin", { personId: "g-jess", venueId: "copper" });
  let made: any = null;
  for (let i = 0; i < 30 && !made; i++) {
    await sleep(500);
    made = streamed.slice(from).find((e) => e.type === "play" && e.data.venueId === "copper" && e.data.play?.composed);
  }
  const url = made?.data.play.audio as string | undefined;
  const got = url ? await fetch(BASE + url) : null;
  check("a track made for the room streams from its record in Atlas, never cached", Boolean(got && got.status === 200 && got.headers.get("cache-control") === "no-store"), url ?? "no track made");
  await api("/api/forget", { personId: "g-jess" });
  const gone = url ? await fetch(BASE + url) : null;
  check("after forget me, the made track's sound is gone (404)", Boolean(gone && gone.status === 404));
}
const { readdirSync, existsSync } = await import("node:fs");
check("no sound files are written to disk", !existsSync("public/audio/gen") || readdirSync("public/audio/gen").length === 0);
await sleep(800);
const fe = streamed.filter((e) => e.type === "forgotten");
check("the screens' forget-me event carries no guest label or id", fe.length > 0 && fe.every((e) => !("label" in e.data) && !("personId" in e.data) && !JSON.stringify(e.data).includes(guest)));
check("no event on the screens' stream carries this guest's id", !streamed.some((e) => JSON.stringify(e.data).includes(guest)), `${streamed.length} events`);
// Last, because its composition starts the per-room gap that the checks above would otherwise wait on.
// Audience mode: typed vibes from a crowd are ordinary likes; only "their turn" makes a track at once.
if (cfg0.vibe && cfg0.musicLive) {
  await api("/api/stage/audience", { on: true });
  const crowd = ["aud-1", "aud-2", "aud-3", "aud-4", "aud-5"];
  for (const id of crowd) await api("/api/checkin", { personId: id, venueId: "copper" });
  const from = streamed.length;
  const vs = await Promise.all(crowd.map((id) => api("/api/vibe", { personId: id, text: "warm disco strings" })));
  await sleep(6000);
  const makings = streamed.slice(from).filter((e) => e.type === "music_making" && e.data.venueId === "copper").length;
  check("audience mode: 5 typed vibes count as likes and make at most 1 track", vs.every((v) => v.status === 200 && !v.making) && makings <= 1, `${makings} track(s) started`);
  await sleep(1100);
  await api("/api/stage/their-turn", { venueId: "copper" });
  const from2 = streamed.length;
  const tv = await api("/api/vibe", { personId: "aud-1", text: "hard fast techno" });
  let made = false;
  for (let i = 0; i < 40 && !made; i++) {
    await sleep(250);
    made = streamed.slice(from2).some((e) => e.type === "music_making" && e.data.venueId === "copper");
  }
  check("audience mode: the volunteer's vibe after \"their turn\" makes a track at once", tv.making === true && made);
  await api("/api/stage/audience", { on: false });
  for (const id of crowd) await api("/api/forget", { personId: id });
}
ac.abort();
const n = await api("/api/number");
check("the headline number recomputes with 0 records left", n.recordsLeftForForgottenGuests === 0 && n.forgotten >= 1, n.sentence);

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
