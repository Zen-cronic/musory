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

const RING = `<svg class="mark ring draw" viewBox="0 0 220 110" preserveAspectRatio="none" aria-hidden="true"><path d="M34 5 C 90 1, 160 1, 208 7 C 217 32, 217 78, 209 103 C 150 109, 70 109, 11 103 C 3 78, 3 32, 12 8 C 30 4, 52 3, 70 4"/></svg>`;
const UNDER = `<svg class="mark under draw" viewBox="0 0 220 24" preserveAspectRatio="none" aria-hidden="true"><path d="M4 12 C 60 4, 140 3, 216 9 M 34 20 C 92 13, 150 14, 204 18"/></svg>`;
const LEAF = `<span class="logo-chip"><img src="/img/mongodb-leaf.svg" alt="MongoDB"></span>`;
const trackLine = (t) => (t ? `${genreName(t.genre)}${t.bpm ? `, ${t.bpm} BPM` : ""}` : "");

// Transitions: 1 s crossfade between catalogue tracks, 3 s with filter sweeps into or out of a track made
// just now (low-pass sweep down on the outgoing track, high-pass sweep down on the incoming one).
const SWEEP_MS = 3000;
let ctx = null;
const chains = players.map((el) => ({ el, filter: null, gain: null }));
function ensureGraph() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain();
  master.connect(ctx.destination);
  if (film) {
    // For filming: the room's audio after the filters, as a MediaStream.
    const dest = ctx.createMediaStreamDestination();
    master.connect(dest);
    window.__roomStream = dest.stream;
  }
  for (const c of chains) {
    const src = ctx.createMediaElementSource(c.el);
    c.filter = ctx.createBiquadFilter();
    c.filter.type = "lowpass";
    c.filter.frequency.value = 22000;
    c.gain = ctx.createGain();
    c.gain.gain.value = 0;
    src.connect(c.filter).connect(c.gain).connect(master);
  }
}
function crossfade(src, sweep = false) {
  if (!started || !soundOn || !src) return;
  ensureGraph();
  ctx.resume().catch(() => {});
  const from = chains[active];
  const to = chains[1 - active];
  const dur = (sweep ? SWEEP_MS : CROSSFADE_MS) / 1000;
  const t = ctx.currentTime;
  to.el.src = src;
  to.el.currentTime = 0;
  to.el.play().catch(() => {});
  to.gain.gain.cancelScheduledValues(t);
  to.gain.gain.setValueAtTime(0, t);
  to.gain.gain.linearRampToValueAtTime(1, t + dur);
  from.gain.gain.cancelScheduledValues(t);
  from.gain.gain.setValueAtTime(from.gain.gain.value, t);
  from.gain.gain.linearRampToValueAtTime(0, t + dur);
  for (const c of [from, to]) c.filter.frequency.cancelScheduledValues(t);
  if (sweep) {
    from.filter.type = "lowpass";
    from.filter.frequency.setValueAtTime(18000, t);
    from.filter.frequency.exponentialRampToValueAtTime(250, t + dur);
    to.filter.type = "highpass";
    to.filter.frequency.setValueAtTime(1500, t);
    to.filter.frequency.exponentialRampToValueAtTime(20, t + dur);
  } else {
    from.filter.type = "lowpass";
    from.filter.frequency.setValueAtTime(22000, t);
    to.filter.type = "lowpass";
    to.filter.frequency.setValueAtTime(22000, t);
  }
  const el = from.el;
  setTimeout(() => el.pause(), dur * 1000 + 100);
  active = 1 - active;
}

// Now playing: the title fades out and in with the audio crossfade; the page is settled after both.
function showPlay(play, { instant = false } = {}) {
  if (!play) return;
  const changed = !current || current.playId !== play.playId;
  const sweep = Boolean(play.composed || current?.composed);
  current = play;
  const slab = $("now-playing");
  const t = $("now-title");
  const apply = () => {
    t.textContent = play.title;
    t.classList.toggle("long", play.title.length > 14);
    t.dataset.trackId = play.trackId;
    slab.dataset.trackId = play.trackId;
    $("now-meta").innerHTML = `<span class="chip solid">${genreName(play.genre)}</span><span class="chip">${play.bpm} BPM</span>${play.composed ? `<span class="chip made">Made just now for this room</span>` : ""}`;
    $("now-provenance").textContent = play.provenance || "";
    t.dataset.audio = play.audio;
    $("now-desc").textContent = (play.descriptor || "").replace(/\s*\|\s*/g, ". ").replace(/&/g, "and");
    const why = $("now-why");
    why.textContent = !film && play.memoryChangedPick && play.baselinePick ? `Picked from the room's memory. Without memory it would be ${play.baselinePick.title}.` : "";
    why.hidden = !why.textContent;
    progress($("now-progress"), play);
  };
  if (!changed || instant) { apply(); settle(); return; }
  busy(true);
  if (play.composed) endMaking();
  t.classList.add("out");
  setTimeout(() => { apply(); t.classList.remove("out"); }, 320);
  crossfade(play.audio, sweep);
  console.log("now-playing", JSON.stringify({ trackId: play.trackId, audio: play.audio, composed: Boolean(play.composed), crossfadeMs: sweep ? SWEEP_MS : CROSSFADE_MS, at: Date.now() }));
  setTimeout(() => { busy(false); settle(); }, Math.max(sweep ? SWEEP_MS : CROSSFADE_MS, 640));
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
  $("without-memory-row").classList.toggle("hidden", !b || b.trackId === p?.trackId);
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

// The room makes a new track: the visual peak. Driven by music_making, music_gen and music_fallback.
function startMaking(e) {
  const slab = $("now-playing");
  slab.classList.add("is-making");
  $("now-kicker").textContent = "Making the next track";
  const d = e.descriptors || {};
  const what = [d.genres?.length ? d.genres.map(genreName).join(" and ") : e.genre && genreName(e.genre), (d.bpm || e.bpm) && `${d.bpm || e.bpm} BPM`].filter(Boolean).join(", ");
  const people = e.people ?? e.present;
  $("making-for").textContent = e.text ? e.text.replace(/…$/, "").replace(/^Making a new track\s*/i, "").replace(/^./, (c) => c.toUpperCase()) : `For ${people ? `the ${people} ${people === 1 ? "person" : "people"} here` : "the people here"}${what ? `: ${what}` : ""}`;
  $("making-now").textContent = current?.title || "";
  busy(true);
  settle();
}
function endMaking(note) {
  const slab = $("now-playing");
  if (!slab.classList.contains("is-making")) { if (note) $("making-for").textContent = note; return; }
  slab.classList.remove("is-making");
  $("now-kicker").textContent = "Now playing";
  busy(false);
  if (note) $("now-meta").insertAdjacentHTML("beforeend", `<span class="chip">${note}</span>`);
  settle();
}

async function load() {
  cfg = await api("/api/config");
  $("compose").classList.toggle("hidden", !(cfg.music && cfg.musicLive));
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
  ensureGraph();
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
$("simulate").onclick = () => api("/api/stage/simulate", { venueId: venue }).then((r) => feed(`Simulated guests: ${r.guests} tapped ${genreName(r.genre).toLowerCase()}`)).catch(() => {});
$("compose").onclick = async () => {
  $("compose").disabled = true;
  try { await api(`/api/room/${venue}/generate`, {}); } catch { /* the fallback event explains */ }
  $("compose").disabled = false;
};
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
  music_making: (e) => { if (e.venueId === venue) startMaking(e); },
  music_gen: (e) => {
    if (e.venueId !== venue) return;
    const d = e.descriptors || {};
    feed(`ElevenLabs Music made ${(d.genres || []).map(genreName).join(" and ")}${d.bpm ? `, ${d.bpm} BPM` : ""}`);
    $("making-for").textContent = `Made in ${Math.round((e.ms || 0) / 100) / 10} seconds. It plays next.`;
    settle();
  },
  music_fallback: (e) => { if (e.venueId === venue) endMaking("Playing the closest track we have"); },
  forgotten: (e) => { showReceipt(e); refreshMemory(); },
  reset: () => load(),
});
load();
void look;
