import { api, events, $, bars, progress, refusalTicket, genreName } from "/js/common.js";
import { film, embed, params, look, lookMenu, helpPanel, busy, settle, withLook, PRODUCT, DEFAULT_LOOK } from "/js/look.js";

const venue = location.pathname.split("/")[2] || params.get("venue") || "copper";
const CROSSFADE_MS = 1000;
let soundOn = !embed;
let started = film && !embed;
let current = null;
let cfg = null;
let venueName = venue;
const players = [$("audio-a"), $("audio-b")];
let active = 0;

const RING = `<svg class="mark ring draw" viewBox="0 0 220 110" preserveAspectRatio="none" aria-hidden="true"><path d="M200 34 C 214 74, 160 106, 104 106 C 44 106, 4 86, 5 54 C 6 22, 56 3, 114 3 C 170 3, 214 16, 210 44"/></svg>`;
const UNDER = `<svg class="mark under draw" viewBox="0 0 220 24" preserveAspectRatio="none" aria-hidden="true"><path d="M4 12 C 60 4, 140 3, 216 9 M 34 20 C 92 13, 150 14, 204 18"/></svg>`;
const LEAF = `<span class="logo-chip"><img src="/img/mongodb-leaf.svg" alt="MongoDB"></span>`;
const trackLine = (t) => (t ? `${genreName(t.genre)}${t.bpm ? `, ${t.bpm} BPM` : ""}` : "");

function crossfade(src) {
  if (!started || !soundOn || !src) return;
  const from = players[active];
  const to = players[1 - active];
  to.src = src;
  to.volume = 0;
  to.currentTime = 0;
  to.play().catch(() => {});
  const t0 = performance.now();
  const step = () => {
    const f = Math.min(1, (performance.now() - t0) / CROSSFADE_MS);
    to.volume = f;
    from.volume = 1 - f;
    if (f < 1) requestAnimationFrame(step);
    else from.pause();
  };
  step();
  active = 1 - active;
}

// Now playing: the title fades out and in with the audio crossfade; the page is settled after both.
function showPlay(play, { instant = false } = {}) {
  if (!play) return;
  const changed = !current || current.playId !== play.playId;
  current = play;
  const slab = $("now-playing");
  const t = $("now-title");
  const apply = () => {
    t.textContent = play.title;
    t.dataset.trackId = play.trackId;
    slab.dataset.trackId = play.trackId;
    $("now-meta").innerHTML = `<span class="chip solid">${genreName(play.genre)}</span><span class="chip">${play.bpm} BPM</span>${play.generated ? `<span class="chip solid made-chip">Made just now for this room</span>` : ""}`;
    $("now-desc").textContent = play.descriptor || "";
    const why = $("now-why");
    why.textContent = !film && play.memoryChangedPick && play.baselinePick ? `Picked from the room's memory. Without memory it would be ${play.baselinePick.title}.` : "";
    why.hidden = !why.textContent;
    progress($("now-progress"), play);
  };
  if (!changed || instant) { apply(); settle(); return; }
  busy(true);
  t.classList.add("out");
  setTimeout(() => { apply(); t.classList.remove("out"); }, 320);
  crossfade(play.audio);
  console.log("now-playing", JSON.stringify({ trackId: play.trackId, at: Date.now() }));
  setTimeout(() => { busy(false); settle(); }, Math.max(CROSSFADE_MS, 640));
}

// The plain-words reason for the next pick. No raw percentages on screen.
function whyLine(d) {
  const n = d.sharingCount || 0;
  const hour = d.hour ? `, and it's ${d.hour}` : "";
  const top = Object.entries(d.mix || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!n) return `No one here is sharing their taste yet, so this follows ${venueName}'s crowd memory${hour}.`;
  const people = n === 1 ? "1 person here shares their taste" : `${n} people here share their taste`;
  return `${people}${top ? `, leaning ${genreName(top).toLowerCase()}` : ""}${hour}. Recent taps count most.`;
}

function showNext(d) {
  if (!d) return;
  const p = d.picked, b = d.baselinePick;
  $("next-up").dataset.trackId = p?.trackId || "";
  const n = $("next-title");
  n.textContent = p ? p.title : "…";
  n.dataset.trackId = p?.trackId || "";
  $("with-memory").dataset.trackId = p?.trackId || "";
  $("with-genre").textContent = trackLine(p);
  $("without-memory").dataset.trackId = b?.trackId || "";
  $("without-title").textContent = b ? b.title : "…";
  $("without-genre").textContent = trackLine(b);
  // When both picks are the same track, the no-memory card adds nothing: hide it.
  $("without-memory").hidden = Boolean(b && p && b.trackId === p.trackId);
  const ring = $("with-memory").querySelector(".mark");
  if (ring) ring.remove();
  if (p && b && p.trackId !== b.trackId) $("with-memory").insertAdjacentHTML("beforeend", RING);
  $("next-why").textContent = whyLine(d);
  bars($("mix"), d.mix);
  settle();
}

function showMemory(m) {
  if (!m) return;
  $("memory-login").textContent = m.login ? `${m.login} on ${m.view}` : "";
  if (m.error) { $("memory").innerHTML = refusalTicket({ code: m.error.code, reason: `${venueName}'s login was refused.` }); settle(); return; }
  const c = m.crowd;
  $("memory").innerHTML = c
    ? `<span class="note">From ${c.contributors} people's likes. No names kept.</span><div id="memory-bars" class="bars"></div>`
    : `<span class="note">Not kept yet. It needs at least 3 people.</span>`;
  if (c) bars($("memory-bars"), c.weights, 3);
  settle();
}

// Live from the database: each change in plain words, newest first, at most four.
const VENUE_SHORT = { copper: "Copper Room", basement: "Basement 2" };
function changeWords(e) {
  const k = `${e.coll}:${e.op}:${e.kind ?? ""}`;
  if (e.coll === "taps" && e.op === "insert") return e.signal < 0 ? "Skip saved" : "Like saved, room updated";
  if (e.coll === "taps" && e.op === "update") return "Like marked old";
  if (e.coll === "taps" && e.op === "delete") return "Like deleted";
  if (k.startsWith("derived") && e.kind === "decision") return "Next track picked by vector search";
  if (k.startsWith("derived") && e.kind === "crowd") return e.op === "delete" ? "Crowd memory removed" : "Crowd memory updated";
  if (k.startsWith("derived") && e.kind === "taste") return e.op === "delete" ? "A guest's taste deleted" : "A guest's taste rebuilt";
  if (e.coll === "presence") return e.op === "delete" ? "A guest left" : "A guest checked in";
  if (e.coll === "consents") return e.op === "delete" ? "Consent removed" : "Consent saved";
  if (e.coll === "sessions") return "Tonight only changed";
  if (e.coll === "prefs") return "Old likes set aside";
  if (e.coll === "tombstones") return "Forget me recorded";
  if (e.coll === "plays") return null;
  return "Database change";
}
function feed(words) {
  if (!words) return;
  const el = $("feed");
  const chip = document.createElement("span");
  chip.className = "ev";
  chip.innerHTML = `${LEAF}<span></span>`;
  chip.lastChild.textContent = words;
  el.querySelector(".kicker").after(chip);
  while (el.querySelectorAll(".ev").length > 4) el.querySelector(".ev:last-of-type").remove();
}
const txnWords = (e) => {
  const c = e.counts || {};
  if (e.op === "forget_me") return `Forget me: ${c.total ?? "all"} records deleted in one transaction`;
  if (e.op === "bored") return `Bored of this: ${c.superseded ?? 0} likes set aside`;
  if (e.op === "undo_bored") return `Undo: ${c.restored ?? 0} likes back`;
  if (e.op === "keep_tonight_tap") return "Tonight's like kept in long-term taste";
  return "Transaction saved";
};

function sameQuery(before, after, who) {
  const el = $("same-count");
  el.innerHTML = `${before}<span class="count-arrow"></span>${after}${UNDER}`;
  el.classList.add("marked");
  $("same-text").textContent = `Records about ${who} after forget me`;
}

function showReceipt(r) {
  const el = $("receipt");
  const lines = (r.venues || []).map((v) => {
    const crowd = v.contributionRemoved
      ? `Crowd memory: ${v.crowdContributorsBefore} people, now ${v.crowdContributorsAfter}${v.crowdMemoryKept === false ? ". Too few left, so it was removed" : ""}.`
      : "None of their likes were in its crowd memory.";
    const play = v.pickAfter ? ` Next: ${v.pickAfter.title}${v.matchesWithoutYou ? ", the track it would play without them" : ""}.` : "";
    return `<div class="line" data-venue="${v.venueId}"><b>${v.venue}</b>${crowd}${play}</div>`;
  }).join("");
  el.innerHTML = `<span class="kicker" style="color:inherit">Forget me</span>
    <h2 class="display">${r.label} said forget me</h2>
    <div class="figure marked" id="receipt-count" data-testid="receipt-count" style="justify-self:start">${r.totalBefore}<span class="count-arrow"></span>${r.totalAfter}${RING}</div>
    <p class="sub">records about them, deleted in one step</p>
    <div class="lines">${lines}</div>
    <button id="receipt-close" class="btn controls" style="border-color:currentColor">Close</button>`;
  el.classList.remove("hidden");
  busy(true);
  $("receipt-close").onclick = () => el.classList.add("hidden");
  setTimeout(() => { busy(false); settle(); }, 800);
  setTimeout(() => el.classList.add("hidden"), 14000);
  sameQuery(r.totalBefore, r.totalAfter, r.label);
}

// The room makes a new track: the visual peak. Shapes are tolerant until the event contract settles.
function showMaking(e) {
  const slab = $("now-playing");
  const phase = e.phase || e.status || "start";
  if (phase === "start" || phase === "making") {
    slab.classList.add("is-making");
    $("now-kicker").textContent = "Making the next track";
    const people = e.people ?? e.presentCount ?? e.sharing;
    const what = [e.genre && genreName(e.genre), e.bpm && `${e.bpm} BPM`].filter(Boolean).join(", ");
    $("making-for").textContent = `For ${people ? `the ${people} ${people === 1 ? "person" : "people"} here` : "the people here"}${what ? `: ${what}` : ""}`;
    $("making-now").textContent = current?.title || "";
    busy(true);
  } else {
    slab.classList.remove("is-making");
    $("now-kicker").textContent = "Now playing";
    busy(false);
    if (phase === "fallback") $("now-meta").insertAdjacentHTML("beforeend", `<span class="chip">Playing the closest track we have</span>`);
  }
  settle();
}

async function load() {
  cfg = await api("/api/config");
  const s = await api(`/api/room/${venue}`);
  venueName = s.venue;
  document.title = `${s.venue}, ${PRODUCT}`;
  $("venue-name").textContent = s.venue;
  $("memory-title").textContent = `${s.venue}'s own crowd memory`;
  setQr();
  const base = cfg.baseUrl || "";
  $("join-url").textContent = !film && base && !/localhost|127\.0\.0\.1|192\.168\.|\.local/.test(base) ? `${base.replace(/^https?:\/\//, "")}/join/${venue}` : "";
  $("present").textContent = s.present;
  $("now-clock").textContent = "";
  $("now-caption").textContent = s.clock?.hour ? `${s.venue}, ${s.clock.hour}` : s.venue;
  showPlay(s.play, { instant: true });
  showNext(s.next);
  showMemory(s.memory);
  const n = await api("/api/number").catch(() => null);
  if (n && n.forgotten) { $("same-count").textContent = String(n.recordsLeftForForgottenGuests ?? 0); $("same-text").textContent = `Records left about the ${n.forgotten} ${n.forgotten === 1 ? "guest" : "guests"} who said forget me`; }
  settle();
}
function setQr() {
  $("qr").src = `/api/qr?venue=${venue}${document.documentElement.dataset.look !== DEFAULT_LOOK ? `&style=${document.documentElement.dataset.look}` : ""}`;
  $("link-stage").href = withLook(`/stage?venue=${venue}`);
  $("link-how").href = withLook(`/how?venue=${venue}`);
}
window.addEventListener("lookchange", setQr);

if (!film && !embed) {
  $("menu-slot").replaceWith(lookMenu());
  $("help-slot").replaceWith(helpPanel([["N", "Play the next track now"], ["H", "Next hour"], ["M", "Sound on or off"], ["?", "Show or hide this panel"]]));
}
if (film || embed) $("start-overlay").classList.add("hidden");
$("start-room").onclick = () => {
  started = true;
  $("start-overlay").classList.add("hidden");
  if (current) crossfade(current.audio);
};
const toggleSound = () => {
  soundOn = !soundOn;
  $("sound").textContent = `Sound: ${soundOn ? "on" : "off"}`;
  if (!soundOn) players.forEach((p) => p.pause());
  else if (current) crossfade(current.audio);
};
$("sound").onclick = toggleSound;
$("skip").onclick = () => api(`/api/room/${venue}/skip`, {});
$("next-hour").onclick = () => api("/api/clock/next", {});
$("read-other").onclick = () => api(`/api/room/${venue}/read-other`, {}).catch(() => {});
document.addEventListener("keydown", (e) => {
  if (film || embed || e.target.closest?.("input, select, textarea")) return;
  if (e.key === "n" || e.key === "N") $("skip").click();
  if (e.key === "h" || e.key === "H") $("next-hour").click();
  if (e.key === "m" || e.key === "M") toggleSound();
});

let memTimer;
const refreshMemory = () => { clearTimeout(memTimer); memTimer = setTimeout(async () => showMemory((await api(`/api/room/${venue}`)).memory), 400); };
const mine = (e) => !e.venueId || e.venueId === venue;

events({
  play: (e) => { if (e.venueId === venue) showPlay(e.play); },
  next: (e) => { if (e.venueId === venue) { showNext(e.decision); refreshMemory(); } },
  presence: (e) => { if (e.venueId === venue) { $("present").textContent = e.count; settle(); } },
  crowd: (e) => { if (e.venueId === venue) refreshMemory(); },
  clock: (e) => { $("now-caption").textContent = e.hour ? `${venueName}, ${e.hour}` : venueName; settle(); },
  tonight: (e) => { if (e.venueId === venue) { $("tonight").textContent = e.active ? "Tonight only is on" : ""; settle(); } },
  change_event: (e) => { if (mine(e)) { feed(changeWords(e)); settle(); } },
  txn: (e) => { if (mine(e)) { feed(txnWords(e)); settle(); } },
  refusal: (e) => {
    feed(`Refused, code ${e.code}`);
    if (mine(e)) { $("refusals").innerHTML = refusalTicket(e) + [...$("refusals").children].slice(0, 1).map((x) => x.outerHTML).join(""); }
    settle();
  },
  making: (e) => { if (e.venueId === venue) showMaking(e); },
  music_gen: (e) => { if (e.venueId === venue) showMaking({ ...e, phase: e.phase || (e.fallback ? "fallback" : "done") }); },
  forgotten: (e) => { showReceipt(e); refreshMemory(); },
  reset: () => load(),
});
load();
void look;
