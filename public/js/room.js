import { api, events, $, bars, progress, refusalTicket } from "/js/common.js";

const venue = location.pathname.split("/")[2];
const params = new URLSearchParams(location.search);
const film = params.get("film") === "1";
// Transitions: 1 s crossfade between catalogue tracks; 3 s crossfade with filter sweeps into or out of a
// track made just now (low-pass sweep down on the outgoing track, high-pass sweep down on the incoming one).
const CROSSFADE_MS = 1000;
const SWEEP_MS = 3000;
let soundOn = true;
let started = film;
let current = null;
const players = [$("audio-a"), $("audio-b")];
let active = 0;
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
  if (!started || !soundOn) return;
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

function showPlay(play) {
  if (!play) return;
  const sweep = Boolean(play.composed || current?.composed);
  current = play;
  const t = $("now-title");
  t.textContent = play.title;
  t.dataset.trackId = play.trackId;
  $("now-meta").textContent = `${play.genre} · ${play.bpm} BPM · ${play.trackId}`;
  $("now-why").textContent = play.memoryChangedPick && play.baselinePick ? `Picked from the room's memory. With no memory it would be ${play.baselinePick.title} (${play.baselinePick.genre}).` : "";
  progress($("now-progress"), play);
  t.dataset.audio = play.audio;
  $("now-provenance").textContent = play.provenance || "";
  if (play.composed) $("making").classList.add("hidden");
  crossfade(play.audio, sweep);
  console.log("now-playing", JSON.stringify({ trackId: play.trackId, audio: play.audio, composed: Boolean(play.composed), crossfadeMs: sweep ? SWEEP_MS : CROSSFADE_MS, at: Date.now() }));
}

function showNext(d) {
  if (!d) return;
  const n = $("next-title");
  n.textContent = d.picked ? d.picked.title : "…";
  n.dataset.trackId = d.picked?.trackId || "";
  $("with-memory").textContent = d.picked ? `${d.picked.title} (${d.picked.genre})` : "…";
  $("without-memory").textContent = d.baselinePick ? `${d.baselinePick.title} (${d.baselinePick.genre})` : "…";
  $("without-memory").dataset.trackId = d.baselinePick?.trackId || "";
  $("without-memory-row").classList.toggle("hidden", !d.baselinePick || d.baselinePick.trackId === d.picked?.trackId);
  $("with-memory").dataset.trackId = d.picked?.trackId || "";
  const p = d.parts || {};
  const bits = [];
  if (p.taste) bits.push(`${d.sharingCount} ${d.sharingCount === 1 ? "guest's" : "guests'"} taste ${Math.round(p.taste * 100)}%`);
  if (p.crowd) bits.push(`crowd memory of ${d.crowdContributors} people ${Math.round(p.crowd * 100)}%`);
  bits.push(`current track ${Math.round((p.now || 0) * 100)}%`);
  $("next-why").textContent = `Atlas Vector Search query: ${bits.join(" + ")}.`;
  $("candidates").textContent = (d.candidates || []).map((c) => `${c.title} ${c.score}`).join(" · ");
  bars($("mix"), d.mix);
}

function showMemory(m) {
  if (!m) return;
  $("memory-login").textContent = m.login ? `${m.login} on ${m.view}` : "";
  if (m.error) { $("memory").innerHTML = refusalTicket({ code: m.error.code, codeName: m.error.codeName, reason: m.error.message }); return; }
  const c = m.crowd;
  $("memory").innerHTML = `
    <div>${c ? `<b class="mono">${c.contributors}</b> people, <b class="mono">${c.likes}</b> likes, <b class="mono">${c.skips}</b> skips` : "No crowd memory yet (needs 3+ people)."}</div>
    <div id="memory-bars" class="bars"></div>
    <div class="mute" style="margin-top:6px">${(m.notes || []).join(" ")}</div>
    <div class="mono mute" style="font-size:12px">${m.decisions} picks logged · ${m.memoryChangedPicks} differ from the no-memory pick</div>`;
  if (c) bars($("memory-bars"), c.weights, 4);
}

function feed(line) {
  const el = $("feed");
  const div = document.createElement("div");
  div.textContent = line;
  el.prepend(div);
  while (el.children.length > 40) el.lastChild.remove();
}

function showReceipt(r) {
  const el = $("receipt");
  const rooms = (r.venues || []).filter((v) => v.contributionRemoved).length;
  el.innerHTML = `<div class="label">Forget me · ${r.label}</div>
    <h2 class="big" style="font-size:40px">Removed ${r.label}'s share from ${rooms === 1 ? "1 room's" : `${rooms} rooms'`} crowd memory.</h2>
    <div class="count" id="receipt-count">${r.totalBefore} → ${r.totalAfter}</div>
    <div>records about this guest, in one database transaction (${r.txnMs} ms)</div>
    ${(r.venues || []).map((v) => `<div style="margin-top:8px" data-venue="${v.venueId}"><b>${v.venue}</b>: crowd memory ${v.crowdContributorsBefore} → ${v.crowdContributorsAfter} people${v.crowdMemoryKept ? "" : " (not enough people: removed)"} · now playing <b>${v.pickAfter?.title ?? "–"}</b>${v.matchesWithoutYou ? ", the pick it promised without them" : ""}</div>`).join("")}
    <button id="receipt-close" style="margin-top:16px">Close</button>`;
  el.classList.remove("hidden");
  $("receipt-close").onclick = () => el.classList.add("hidden");
  setTimeout(() => el.classList.add("hidden"), 20000);
}

async function load() {
  const cfg = await api("/api/config");
  $("compose").classList.toggle("hidden", !(cfg.music && cfg.musicLive));
  const s = await api(`/api/room/${venue}`);
  document.title = `Musory · ${s.venue}`;
  $("venue-name").textContent = s.venue;
  $("qr").src = `/api/qr?venue=${venue}`;
  $("join-url").textContent = `${cfg.baseUrl}/join/${venue}`;
  $("present").textContent = s.present;
  $("now-clock").textContent = s.clock.hour;
  showPlay(s.play);
  showNext(s.next);
  showMemory(s.memory);
}

if (film) $("start-overlay").classList.add("hidden");
$("start-room").onclick = () => {
  started = true;
  ensureGraph();
  $("start-overlay").classList.add("hidden");
  if (current) crossfade(current.audio);
};
$("sound").onclick = () => {
  soundOn = !soundOn;
  $("sound").textContent = `Sound: ${soundOn ? "on" : "off"}`;
  if (!soundOn) players.forEach((p) => p.pause());
  else if (current) crossfade(current.audio);
};
$("skip").onclick = () => api(`/api/room/${venue}/skip`, {});
$("simulate").onclick = () => api("/api/stage/simulate", { venueId: venue }).then((r) => feed(`Simulated guests: ${r.guests} tapped ${r.genre}`)).catch((e) => feed(e.message));
function making(text, hold = false) {
  const el = $("making");
  el.innerHTML = `<div class="label">ElevenLabs Music</div><div style="font-size:22px;font-weight:800">${text}</div>`;
  el.classList.remove("hidden");
  clearTimeout(el._h);
  if (!hold) el._h = setTimeout(() => el.classList.add("hidden"), 8000);
}
$("next-hour").onclick = () => api("/api/clock/next", {});
$("compose").onclick = async () => {
  $("compose").disabled = true;
  $("compose").textContent = "Composing…";
  try { const r = await api(`/api/room/${venue}/generate`, {}); feed(`ElevenLabs Music composed ${r.descriptors.genres.join(" + ")} at ${r.descriptors.bpm} BPM in ${r.ms} ms`); }
  catch (e) { feed(`compose failed: ${e.message}`); }
  $("compose").disabled = false;
  $("compose").textContent = "Compose the next clip (ElevenLabs Music)";
};
$("read-other").onclick = () => api(`/api/room/${venue}/read-other`, {}).catch(() => {});

let memTimer;
const refreshMemory = () => { clearTimeout(memTimer); memTimer = setTimeout(async () => showMemory((await api(`/api/room/${venue}`)).memory), 400); };

events({
  play: (e) => { if (e.venueId === venue) showPlay(e.play); },
  next: (e) => { if (e.venueId === venue) { showNext(e.decision); refreshMemory(); } },
  presence: (e) => { if (e.venueId === venue) $("present").textContent = e.count; },
  crowd: (e) => { if (e.venueId === venue) refreshMemory(); },
  clock: (e) => { $("now-clock").textContent = e.hour; },
  tonight: (e) => { if (e.venueId === venue) $("tonight").textContent = e.active ? `Tonight-only session until ${new Date(e.expiresAt).toLocaleTimeString()}` : ""; },
  change_event: (e) => feed(`${new Date(e.at).toLocaleTimeString()} ${e.op} ${e.coll}${e.kind ? ` (${e.kind})` : ""}${e.venueId ? ` @${e.venueId}` : ""}`),
  txn: (e) => feed(`transaction ${e.op} ${JSON.stringify(e.counts)}`),
  music_making: (e) => { if (e.venueId === venue) making(`${e.text}…`, true); },
  music_gen: (e) => {
    if (e.venueId !== venue) return;
    feed(`ElevenLabs Music made ${e.descriptors.genres.join(" + ")}, ${e.descriptors.bpm} BPM in ${(e.ms / 1000).toFixed(1)} s`);
    making(`Made in ${(e.ms / 1000).toFixed(1)} s: ${e.descriptors.genres.join(" and ")}, ${e.descriptors.bpm} BPM${e.late ? " (plays next)" : ""}`);
  },
  music_fallback: (e) => { if (e.venueId === venue) making(e.text); },
  refusal: (e) => {
    feed(`refused ${e.code} ${e.where}`);
    if (!e.venueId || e.venueId === venue) { $("refusals").innerHTML = refusalTicket(e) + $("refusals").innerHTML; }
  },
  forgotten: (e) => { showReceipt(e); refreshMemory(); },
  reset: () => load(),
});
load();
