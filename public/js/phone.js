import { api, events, $, bars, toast, progress, genreName } from "/js/common.js";
import { busy, settle, film } from "/js/look.js";

const params = new URLSearchParams(location.search);
const parts = location.pathname.split("/").filter(Boolean);
// /join/<venue>, /join?venue=<venue>&as=<guest>, /p/<guest>, /me
const pathVenue = parts[0] === "join" ? parts[1] : null;
// The venue this page is for: the QR code's venue at first, then wherever the guest checks in.
let wantVenue = pathVenue || params.get("venue");
let switching = false; // while moving venues, a late reply about the old venue must not bring back the check-in sheet
const asGuest = parts[0] === "p" ? parts[1] : (params.get("guest") || params.get("as"));
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
function guestTag(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
let state = null;
let cfg = null;
let lastPref = null;
const venueName = (v) => cfg?.venues.find((x) => x.id === v)?.name ?? v;

function render(m) {
  state = m;
  $("guest-label").textContent = m.label;
  const here = m.venueId;
  const target = wantVenue || here;
  const needsCheckin = target && here !== target && !switching;
  $("consent").classList.toggle("hidden", !needsCheckin);
  $("main").classList.toggle("hidden", needsCheckin || !here);
  $("forget-section").classList.toggle("hidden", !(here || m.taste || (m.taps || []).length));
  $("venue-name").textContent = here ? m.venue : venueName(target) || "Musory";
  $("consent-venue").textContent = venueName(target);
  if (!here && !target) { $("venue-name").textContent = "Scan a venue's QR code"; }
  if (m.nowPlaying) showPlay(m.nowPlaying);
  bars($("taste"), m.taste?.weights);
  $("taste-version").textContent = m.taste ? `From ${m.taste.likes} ${m.taste.likes === 1 ? "like" : "likes"}` : "";
  const other = here === "copper" ? "basement" : "copper";
  $("switch-venue").textContent = `Switch to ${venueName(other)}`;
  $("switch-venue").dataset.testid = `checkin-venue-${other}`;
  $("carry").textContent = m.taste ? `Your taste goes with you. It counts at ${m.venue ?? "a venue"} only while you're checked in.` : "Tap \"I like this\" to start your taste.";
  $("tonight-state").textContent = m.tonight ? `Tonight only is on at ${venueName(m.tonight.venueId)} until ${new Date(m.tonight.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Tonight's likes stay out of your long-term taste unless you keep one.` : "";
  $("tonight").textContent = m.tonight ? "Only count my likes tonight: on" : "Only count my likes tonight: off";
  $("tonight").setAttribute("aria-pressed", m.tonight ? "true" : "false");
  $("night").innerHTML = (m.night || []).map((p) => `<div class="tap" data-track-id="${p.trackId}"><span><b>${p.title}</b><br><span class="meta">${genreName(p.genre)}</span></span><span class="state">${new Date(p.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>`).join("") || `<div class="note">Nothing yet.</div>`;
  $("taps").innerHTML = (m.taps || []).slice(0, 12).map((t) => `
    <div class="tap" data-tap-id="${t.tapId}"><span>${t.signal > 0 ? "Liked" : "Skipped"} <b>${t.title}</b><br><span class="meta">${genreName(t.genre)}, ${venueName(t.venueId)}</span></span>
    <span class="state">${t.status === "superseded" ? "Set aside" : t.scope === "tonight" ? (t.promoted ? "Kept" : `<button data-keep="${t.tapId}">Keep this one</button>`) : ""}</span></div>`).join("") || `<div class="note">No taps yet.</div>`;
  document.querySelectorAll("[data-keep]").forEach((b) => (b.onclick = async () => { render(await api("/api/tonight/keep", { personId: pid, tapId: b.dataset.keep })); toast("Kept in your long-term taste."); }));
  settle();
}
let wyTimer;
function withoutYou() {
  clearTimeout(wyTimer);
  wyTimer = setTimeout(async () => {
    if (!state?.venueId && !state?.taps?.length) { $("without-you").innerHTML = ""; return; }
    const w = await api(`/api/without?personId=${pid}`).catch(() => null);
    if (!w) return;
    $("without-you").innerHTML = `<div class="label">If you say forget me</div>` + w.venues.map((v) =>
      `<div data-venue="${v.venueId}"><b>${v.venue}</b> plays <span data-role="with-you" data-track-id="${v.withYou?.trackId ?? ""}">${v.withYou?.title ?? "the same track"}</span> with you, <b data-role="without-you" data-track-id="${v.withoutYou?.trackId ?? ""}">${v.withoutYou?.title ?? "the same track"}</b> without you.</div>`).join("");
  }, 300);
}
function showPlay(p) {
  const t = $("now-title");
  t.textContent = p.title;
  t.dataset.trackId = p.trackId;
  $("now-meta").textContent = `${genreName(p.genre)}, ${p.bpm} BPM`;
  progress($("now-progress"), p);
  withoutYou();
}
const act = (fn) => async () => {
  try { await fn(); } catch (e) { toast(e.message); }
};

$("checkin").onclick = act(async () => {
  const scopes = [$("scope-taste").checked && "use_taste", $("scope-crowd").checked && "contribute_crowd"].filter(Boolean);
  render(await api("/api/checkin", { personId: pid, venueId: wantVenue || state?.venueId, scopes }));
  wantVenue = state.venueId;
  toast(`Checked in at ${state.venue}.`);
});
$("like").onclick = act(async () => { const r = await api("/api/tap", { personId: pid, signal: 1 }); if (r.me) render(r.me); snack(r.already ? "Already counted" : "Liked"); });
$("skip").onclick = act(async () => { const r = await api("/api/tap", { personId: pid, signal: -1 }); if (r.me) render(r.me); snack(r.already ? "Already counted" : "Skipped"); });
$("bored").onclick = act(async () => {
  const r = await api("/api/bored", { personId: pid });
  render(r.me);
  if (r.superseded) { lastPref = r.prefId; snack(`Playing something different. ${r.superseded} old likes set aside.`, true); }
  else toast(`You have no ${r.genre} likes to set aside.`);
});
$("undo").onclick = act(async () => { const r = await api("/api/bored/undo", { personId: pid, prefId: lastPref }); render(r.me); $("undo").classList.add("hidden"); $("snackbar").classList.add("hidden"); toast(`${r.restored} likes restored.`); });
$("tonight").onclick = act(async () => render(await api(state?.tonight ? "/api/tonight/end" : "/api/tonight/start", { personId: pid })));
$("switch-venue").onclick = act(async () => {
  const other = state.venueId === "copper" ? "basement" : "copper";
  wantVenue = other;
  switching = true;
  try {
    render(await api("/api/checkin", { personId: pid, venueId: other, scopes: ["use_taste", "contribute_crowd"] }));
  } finally {
    switching = false;
  }
  render(state);
  history.replaceState(null, "", asGuest ? location.pathname + location.search.replace(/venue=\w+/, `venue=${other}`) : `/join/${other}`);
  toast(`Checked in at ${state.venue}. Your taste came with you.`);
});
$("checkout").onclick = act(async () => render(await api("/api/checkout", { personId: pid })));
$("forget").onclick = () => $("forget-confirm").classList.remove("hidden");
$("forget-no").onclick = () => $("forget-confirm").classList.add("hidden");
// Forgetting: each line ticks when its real step finishes, then the receipt.
let forgetPlayed = false, forgetting = false;
const tick = (n, text) => { const li = $(`fg-${n}`); li.classList.remove("wait"); li.classList.add("done"); if (text) li.querySelector("span").textContent = text; settle(); };
async function doForget() {
  forgetting = true; forgetPlayed = false;
  $("main").classList.add("hidden");
  $("forget-section").classList.add("hidden");
  $("volunteer").classList.add("hidden");
  $("consent").classList.add("hidden");
  ["fg-1", "fg-2", "fg-3", "fg-4"].forEach((id, k) => { const li = $(id); li.classList.remove("done"); li.classList.toggle("wait", k > 0); });
  $("forgetting").classList.remove("hidden");
  busy(true);
  let r;
  try { r = await api("/api/forget", { personId: pid }); }
  catch (e) { $("forgetting").classList.add("hidden"); busy(false); forgetting = false; throw e; }
  tick(1, "Your likes and taste deleted");
  const names = (r.venues || []).map((v) => v.venue).join(" and ");
  tick(2, `Done at ${names}: ${r.totalBefore} records deleted in one step`);
  const clips = r.composedClipsRemoved ?? r.before?.composedClips ?? 0;
  tick(3, clips ? `${clips} ${clips === 1 ? "track" : "tracks"} made from your taste deleted` : "No tracks made from your taste to delete");
  if (forgetPlayed) tick(4);
  else await new Promise((res) => { const done = () => { tick(4); res(); }; window.__forgetPlayed = done; setTimeout(() => { if (window.__forgetPlayed === done) { window.__forgetPlayed = null; $("fg-4").querySelector("span").textContent = "Each room will choose without you"; tick(4); res(); } }, 4000); });
  forgetting = false;
  showForgotten(r);
}
function showForgotten(r) {
  $("forgetting").classList.add("hidden");
  const el = $("receipt");
  const RING = `<svg class="mark ring wide draw" viewBox="0 0 220 110" preserveAspectRatio="none" aria-hidden="true"><path d="M34 5 C 90 1, 160 1, 208 7 C 217 32, 217 78, 209 103 C 150 109, 70 109, 11 103 C 3 78, 3 32, 12 8 C 30 4, 52 3, 70 4"/></svg>`;
  el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><a class="back" href="/about" id="receipt-back" aria-label="Back to Musory">&larr; Back</a><span class="wordmark">Musory</span></div>
    <h1 class="display">You're forgotten</h1>
    <div class="figure marked" id="receipt-count" data-testid="receipt-count">${r.totalBefore}<span class="count-arrow"></span>${r.totalAfter}${RING}</div>
    <p>records about you, deleted in one step</p>
    <div class="surface receipt-box">${r.venues.map((v) => `<div class="row" data-venue="${v.venueId}"><b>${v.venue}</b><span>${v.contributionRemoved ? "Your share of its crowd memory: removed." : "None of your likes were in its crowd memory."}</span>${v.pickAfter ? `<span class="ok">Now choosing without you: ${v.pickAfter.title}.</span>` : ""}</div>`).join("")}</div>
    <div class="exits"><button class="btn primary" id="checkin-again" style="background:var(--on-band);color:var(--band);border-color:var(--on-band)">Check in again</button><p>You'll start fresh. Nothing from before comes back.</p><a class="btn" id="receipt-done" href="/about" style="border-color:var(--on-band);color:var(--on-band)">Done</a></div>`;
  el.classList.remove("hidden");
  $("checkin-again").onclick = () => {
    try { localStorage.removeItem("musory.personId"); } catch {}
    const v = state?.venueId || wantVenue || "copper";
    location.href = `/join/${v}`;
  };
  busy(false);
  setTimeout(settle, 800);
}
// What was that track? Live pitch only (hidden when filming). Shows name, genre and time played.
let findTimer;
$("find-q").addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const q = $("find-q").value.trim();
    const v = state?.venueId || wantVenue;
    if (q.length < 3 || !v) { $("find-result").innerHTML = ""; return; }
    const r = await api(`/api/find?venue=${v}&q=${encodeURIComponent(q)}`).catch(() => null);
    const t = (r?.tracks || r?.results || (Array.isArray(r) ? r : []))[0];
    $("find-result").innerHTML = t
      ? `<div class="result"><b>${t.title}</b><span>${genreName(t.genre)}${t.playedAt || t.at ? `, played at ${new Date(t.playedAt || t.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span></div>`
      : `<span class="note">${r ? "Nothing played here tonight matches that yet." : "Not available right now."}</span>`;
  }, 350);
});
if (film) $("find").remove();
$("forget-yes").onclick = act(doForget);
$("forget-big").onclick = act(doForget);

events({
  play: (e) => {
    if (forgetting && e.play?.reason === "forget") { forgetPlayed = true; if (window.__forgetPlayed) { const f = window.__forgetPlayed; window.__forgetPlayed = null; f(); } }
    if (state && e.venueId === state.venueId) showPlay(e.play);
  },
  volunteer: (e) => { if (e.tag === guestTag(pid)) { $("volunteer").classList.remove("hidden"); window.scrollTo(0, 0); } },
  reset: async () => render(await api(`/api/me?personId=${pid}`)),
});
async function samples() {
  const list = await api("/api/samples");
  $("samples").innerHTML = list.map((t) => `<button data-sample="${t.trackId}">${genreName(t.genre)}</button>`).join("");
  document.querySelectorAll("[data-sample]").forEach((b) => (b.onclick = act(async () => {
    const r = await api("/api/tap", { personId: pid, signal: 1, trackId: b.dataset.sample });
    if (r.me) render(r.me);
    toast(r.already ? "Already counted." : `Saved: you like ${b.textContent}.`);
  })));
}
(async () => {
  cfg = await api("/api/config");
  // "Tell the room what you want": a few words become one like on the closest track (Voyage + Vector Search).
  if (!(cfg.vibe && !film)) $("vibe").classList.add("hidden");
  if (cfg.vibe && !film) {
    $("vibe").classList.remove("hidden");
    $("vibe-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = $("vibe-q").value.trim();
      if (text.length < 2) return;
      $("vibe-send").disabled = true;
      try {
        const r = await api("/api/vibe", { personId: pid, text });
        if (r.me) render(r.me);
        $("vibe-result").textContent = r.message;
        toast(r.message);
        $("vibe-q").value = "";
      } catch (err) {
        $("vibe-result").textContent = err.status === 409 ? "Check in to a venue first." : err.message;
      }
      $("vibe-send").disabled = false;
    });
  }
  samples();
  render(await api(`/api/me?personId=${pid}`));
})();

// Snackbar: a short note after an action, with Undo only where the app can undo it.
let snackTimer;
function snack(text, undo = false) {
  $("snack-text").textContent = text;
  $("undo").classList.toggle("hidden", !undo);
  $("snackbar").classList.remove("hidden");
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => $("snackbar").classList.add("hidden"), undo ? 5000 : 2200);
}
// The More sheet
$("more-close").onclick = () => { $("more").open = false; };
$("bored").addEventListener("click", () => { $("more").open = false; });
// Swipe the now-playing card: right likes, left skips. The same handlers as the buttons.
(() => {
  const card = $("swipe-card");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let x0 = null, dx = 0;
  // One gentle nudge on first load shows the card can be swiped
  if (!reduce) { card.classList.add("nudge"); card.addEventListener("animationend", () => card.classList.remove("nudge"), { once: true }); }
  const stamps = (v) => { card.querySelector(".stamp-like").style.opacity = Math.max(0, Math.min(1, v / 90)); card.querySelector(".stamp-skip").style.opacity = Math.max(0, Math.min(1, -v / 90)); };
  const reset = () => { card.classList.remove("dragging"); card.style.transform = ""; stamps(0); };
  card.addEventListener("pointerdown", (e) => { x0 = e.clientX; dx = 0; card.classList.add("dragging"); card.setPointerCapture(e.pointerId); });
  card.addEventListener("pointermove", (e) => { if (x0 === null) return; dx = e.clientX - x0; card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`; stamps(dx); });
  const end = () => {
    if (x0 === null) return; x0 = null;
    const go = dx > 90 ? "like" : dx < -90 ? "skip" : null;
    card.classList.remove("dragging");
    if (go && !reduce) { card.style.transform = `translateX(${go === "like" ? 130 : -130}%) rotate(${go === "like" ? 18 : -18}deg)`; setTimeout(reset, 220); } else reset();
    if (go) $(go).click();
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", () => { x0 = null; reset(); });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select") || $("main").classList.contains("hidden")) return;
    if (e.key === "ArrowRight") $("like").click();
    if (e.key === "ArrowLeft") $("skip").click();
  });
})();
