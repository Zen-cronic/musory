import { api, events, $, bars, progress, refusalTicket } from "/js/common.js";

const venue = location.pathname.split("/")[2];
const params = new URLSearchParams(location.search);
const film = params.get("film") === "1";
const CROSSFADE_MS = 1000;
let soundOn = true;
let started = film;
let current = null;
const players = [$("audio-a"), $("audio-b")];
let active = 0;

function crossfade(src) {
  if (!started || !soundOn) return;
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
    else { from.pause(); }
  };
  step();
  active = 1 - active;
}

function showPlay(play) {
  if (!play) return;
  current = play;
  const t = $("now-title");
  t.textContent = play.title;
  t.dataset.trackId = play.trackId;
  $("now-meta").textContent = `${play.genre} · ${play.bpm} BPM · ${play.trackId}`;
  progress($("now-progress"), play);
  crossfade(play.audio);
  console.log("now-playing", JSON.stringify({ trackId: play.trackId, at: Date.now() }));
}

function showNext(d) {
  if (!d) return;
  const n = $("next-title");
  n.textContent = d.picked ? d.picked.title : "…";
  n.dataset.trackId = d.picked?.trackId || "";
  $("with-memory").textContent = d.picked ? `${d.picked.title} (${d.picked.genre})` : "…";
  $("without-memory").textContent = d.baselinePick ? `${d.baselinePick.title} (${d.baselinePick.genre})` : "…";
  $("without-memory").dataset.trackId = d.baselinePick?.trackId || "";
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
    <h2 class="big" style="font-size:40px">Removed ${r.label}'s share from ${rooms} room${rooms === 1 ? "" : "s"}' crowd memory.</h2>
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
$("next-hour").onclick = () => api("/api/clock/next", {});
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
  refusal: (e) => {
    feed(`refused ${e.code} ${e.where}`);
    if (!e.venueId || e.venueId === venue) { $("refusals").innerHTML = refusalTicket(e) + $("refusals").innerHTML; }
  },
  forgotten: (e) => { showReceipt(e); refreshMemory(); },
  reset: () => load(),
});
load();
