import { api, events, $, bars, toast, progress } from "/js/common.js";

const params = new URLSearchParams(location.search);
const parts = location.pathname.split("/").filter(Boolean);
// /join/<venue>, /join?venue=<venue>&as=<guest>, /p/<guest>, /me
const pathVenue = parts[0] === "join" ? parts[1] : null;
const wantVenue = pathVenue || params.get("venue");
const asGuest = parts[0] === "p" ? parts[1] : params.get("as");
function personId() {
  if (asGuest) return asGuest;
  let id = null;
  try { id = localStorage.getItem("musory.personId"); } catch {}
  if (!id) {
    id = "g-" + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem("musory.personId", id); } catch {}
  }
  return id;
}
const pid = personId();
let state = null;
let cfg = null;
let lastPref = null;
const venueName = (v) => cfg?.venues.find((x) => x.id === v)?.name ?? v;

function render(m) {
  state = m;
  $("guest-label").textContent = m.label;
  const here = m.venueId;
  const target = wantVenue || here;
  const needsCheckin = target && here !== target;
  $("consent").classList.toggle("hidden", !needsCheckin);
  $("main").classList.toggle("hidden", needsCheckin || !here);
  $("venue-name").textContent = here ? m.venue : venueName(target) || "Musory";
  $("consent-venue").textContent = venueName(target);
  if (!here && !target) { $("venue-name").textContent = "Scan a venue's QR code"; }
  if (m.nowPlaying) showPlay(m.nowPlaying);
  bars($("taste"), m.taste?.weights);
  $("taste-version").textContent = m.taste ? `v${m.taste.version} · ${m.taste.likes} likes` : "";
  const other = here === "copper" ? "basement" : "copper";
  $("switch-venue").textContent = `Go to ${venueName(other)}`;
  $("carry").textContent = m.taste ? `Your taste goes with you. It counts at ${m.venue ?? "a venue"} only while you're checked in.` : "Tap \"I like this\" to start your taste.";
  $("tonight-state").textContent = m.tonight ? `Tonight only at ${venueName(m.tonight.venueId)} until ${new Date(m.tonight.expiresAt).toLocaleTimeString()}. These taps never enter your long-term taste unless you keep one.` : "Your taps go into your long-term taste.";
  $("tonight").textContent = m.tonight ? "End tonight-only" : "Try something different tonight (here only)";
  $("taps").innerHTML = (m.taps || []).slice(0, 12).map((t) => `
    <div class="tap" data-tap-id="${t.tapId}"><span>${t.signal > 0 ? "♥" : "✕"} ${t.title} <span class="mute">${t.genre} · ${venueName(t.venueId)}</span></span>
    <span class="mono mute">${t.status === "superseded" ? "superseded" : t.scope === "tonight" ? (t.promoted ? "kept" : `<button data-keep="${t.tapId}">Keep this one</button>`) : ""}</span></div>`).join("") || `<div class="mute">No taps yet.</div>`;
  document.querySelectorAll("[data-keep]").forEach((b) => (b.onclick = async () => { render(await api("/api/tonight/keep", { personId: pid, tapId: b.dataset.keep })); toast("Kept in your long-term taste."); }));
}
let wyTimer;
function withoutYou() {
  clearTimeout(wyTimer);
  wyTimer = setTimeout(async () => {
    if (!state?.venueId && !state?.taps?.length) { $("without-you").innerHTML = ""; return; }
    const w = await api(`/api/without?personId=${pid}`).catch(() => null);
    if (!w) return;
    $("without-you").innerHTML = `<div class="label">If you leave every crowd's memory</div>` + w.venues.map((v) =>
      `<div data-venue="${v.venueId}"><b>${v.venue}</b> plays next: <span class="mono" data-role="with-you" data-track-id="${v.withYou?.trackId ?? ""}">${v.withYou?.title ?? "–"}</span> with you, <span class="mono" data-role="without-you" data-track-id="${v.withoutYou?.trackId ?? ""}">${v.withoutYou?.title ?? "–"}</span> without you</div>`).join("");
  }, 300);
}
function showPlay(p) {
  const t = $("now-title");
  t.textContent = p.title;
  t.dataset.trackId = p.trackId;
  $("now-meta").textContent = `${p.genre} · ${p.bpm} BPM`;
  progress($("now-progress"), p);
  withoutYou();
}
const act = (fn) => async () => {
  try { await fn(); } catch (e) { toast(e.message); }
};

$("checkin").onclick = act(async () => {
  const scopes = [$("scope-taste").checked && "use_taste", $("scope-crowd").checked && "contribute_crowd"].filter(Boolean);
  render(await api("/api/checkin", { personId: pid, venueId: wantVenue || state?.venueId, scopes }));
  toast(`Checked in at ${state.venue}.`);
});
$("like").onclick = act(async () => { const r = await api("/api/tap", { personId: pid, signal: 1 }); render(r.me); toast(r.message); });
$("skip").onclick = act(async () => { const r = await api("/api/tap", { personId: pid, signal: -1 }); render(r.me); toast(r.message); });
$("bored").onclick = act(async () => {
  const r = await api("/api/bored", { personId: pid });
  render(r.me);
  if (r.superseded) { lastPref = r.prefId; $("undo").classList.remove("hidden"); toast(`${r.superseded} ${r.genre} likes set aside. Kept, marked superseded.`); }
  else toast(`You have no ${r.genre} likes to set aside.`);
});
$("undo").onclick = act(async () => { const r = await api("/api/bored/undo", { personId: pid, prefId: lastPref }); render(r.me); $("undo").classList.add("hidden"); toast(`${r.restored} likes restored.`); });
$("tonight").onclick = act(async () => render(await api(state?.tonight ? "/api/tonight/end" : "/api/tonight/start", { personId: pid })));
$("switch-venue").onclick = act(async () => {
  const other = state.venueId === "copper" ? "basement" : "copper";
  render(await api("/api/checkin", { personId: pid, venueId: other, scopes: ["use_taste", "contribute_crowd"] }));
  history.replaceState(null, "", asGuest ? location.pathname + location.search.replace(/venue=\w+/, `venue=${other}`) : `/join/${other}`);
  toast(`Checked in at ${state.venue}. Your taste came with you.`);
});
$("checkout").onclick = act(async () => render(await api("/api/checkout", { personId: pid })));
$("forget").onclick = () => $("forget-confirm").classList.remove("hidden");
$("forget-no").onclick = () => $("forget-confirm").classList.add("hidden");
async function doForget() {
  const r = await api("/api/forget", { personId: pid });
  $("main").classList.add("hidden");
  $("volunteer").classList.add("hidden");
  $("consent").classList.add("hidden");
  const el = $("receipt");
  const rooms = r.venues.filter((v) => v.contributionRemoved).length;
  el.innerHTML = `<div class="label">Forgotten</div>
    <h2 class="big" style="font-size:26px">Removed your share from ${rooms} room${rooms === 1 ? "" : "s"}' crowd memory.</h2>
    <div class="count" id="receipt-count">${r.totalBefore} → ${r.totalAfter}</div>
    <div>records about you, in one database transaction.</div>
    ${r.venues.map((v) => `<div style="margin-top:8px" data-venue="${v.venueId}"><b>${v.venue}</b>: ${v.contributionRemoved ? `crowd memory ${v.crowdContributorsBefore} → ${v.crowdContributorsAfter} people${v.crowdMemoryKept ? "" : " (not enough people, so it was removed)"}` : "none of your taps were in its crowd memory"}. Now playing <b>${v.pickAfter?.title ?? "–"}</b>${v.matchesWithoutYou ? ", the track it said it would play without you" : ""}.</div>`).join("")}
    <div class="mute" style="margin-top:8px">Your taste, taps and check-ins are gone. The venues keep their own staff notes.</div>`;
  el.classList.remove("hidden");
}
$("forget-yes").onclick = act(doForget);
$("forget-big").onclick = act(doForget);

events({
  play: (e) => { if (state && e.venueId === state.venueId) showPlay(e.play); },
  volunteer: (e) => { if (e.personId === pid) { $("volunteer").classList.remove("hidden"); window.scrollTo(0, 0); } },
  reset: async () => render(await api(`/api/me?personId=${pid}`)),
});
async function samples() {
  const list = await api("/api/samples");
  $("samples").innerHTML = list.map((t) => `<button data-sample="${t.trackId}">${t.genre}</button>`).join("");
  document.querySelectorAll("[data-sample]").forEach((b) => (b.onclick = act(async () => {
    const r = await api("/api/tap", { personId: pid, signal: 1, trackId: b.dataset.sample });
    render(r.me);
    toast(r.already ? "Already counted." : `Saved: you like ${b.textContent}.`);
  })));
}
(async () => {
  cfg = await api("/api/config");
  samples();
  render(await api(`/api/me?personId=${pid}`));
})();
