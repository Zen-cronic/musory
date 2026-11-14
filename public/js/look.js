// Looks, demo links and the settled signal, shared by every page.
//
//   ?style=<look>     the look; the URL always wins, an unknown value falls back to the default
//   ?film=1           filming: no controls, no menus, sound starts without the button
//   ?embed=1          a light panel for /compare: no sound, no controls
//   ?venue=<venue>    which venue a page shows (stage, how it works, phone)
//   ?guest=<id>       the phone acts as this guest (same as /p/<id>)

export const PRODUCT = "Musory";

export const LOOKS = ["evergreen"];
export const LOOK_LABEL = {
  evergreen: "Evergreen",
};
// The default look. Change this one line (and look-early.js) to switch it.
export const DEFAULT_LOOK = "evergreen";
const KEY = "musory:look";

export const params = new URLSearchParams(location.search);
export const film = params.get("film") === "1";
export const embed = params.get("embed") === "1";
const root = document.documentElement;

function initialLook() {
  const q = params.get("style");
  if (q !== null) return LOOKS.includes(q) ? q : DEFAULT_LOOK;
  try {
    const s = localStorage.getItem(KEY);
    if (s && LOOKS.includes(s)) return s;
  } catch {
    // Storage blocked: use the default.
  }
  return DEFAULT_LOOK;
}

export let look = initialLook();
root.dataset.look = look;
if (film) root.dataset.film = "1";
if (embed) root.dataset.embed = "1";

export function setParam(key, value) {
  const url = new URL(location.href);
  if (value === null || value === undefined) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  history.replaceState(null, "", url);
}

export function setLook(next) {
  if (!LOOKS.includes(next)) return;
  look = next;
  try { localStorage.setItem(KEY, next); } catch { /* this tab only */ }
  setParam("style", next === DEFAULT_LOOK ? null : next);
  root.dataset.look = next;
  window.dispatchEvent(new CustomEvent("lookchange", { detail: next }));
}

/** A link that keeps the current look, for the QR code and in-app links. */
export function withLook(href) {
  const url = new URL(href, location.origin);
  if (look !== DEFAULT_LOOK) url.searchParams.set("style", look);
  return url.origin === location.origin ? url.pathname + url.search : url.toString();
}

/** Settled signal for recorders: data-seq goes up once each update is fully on screen. */
let busyCount = 0;
export function busy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  root.dataset.busy = busyCount ? "1" : "0";
}
export function settle() {
  root.dataset.seq = String((Number(root.dataset.seq) || 0) + 1);
}
root.dataset.seq = root.dataset.seq || "0";
root.dataset.busy = "0";

/** The Look menu: a plain select in the top bar. */
export function lookMenu() {
  if (LOOKS.length < 2) return document.createElement("span");
  const wrap = document.createElement("label");
  wrap.className = "look-menu";
  wrap.innerHTML = `<span>Look</span><select aria-label="Look">${LOOKS.map((l) => `<option value="${l}">${LOOK_LABEL[l]}</option>`).join("")}</select>`;
  const sel = wrap.querySelector("select");
  sel.value = look;
  sel.onchange = () => setLook(sel.value);
  window.addEventListener("lookchange", (e) => (sel.value = e.detail));
  return wrap;
}

/** The Keys and links panel. keys: [[key, what it does]]. */
export function helpPanel(keys = []) {
  const links = [
    ["?film=1", "Filming: no controls or menus"],
    ["?embed=1", "Light panel, used by /compare"],
    ["?venue=copper|basement", "Which venue the page shows"],
    ["?guest=jess", "The phone acts as this guest"],
    ["/stage?venue=copper", "Projector screen: QR, count, receipt"],
    ["/how", "How it works, live"],
  ];
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn small help-btn";
  btn.textContent = "Keys and links";
  const panel = document.createElement("div");
  panel.className = "help-panel surface";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Keys and links");
  panel.innerHTML = `<h2 class="display">Keys and links</h2>
    ${keys.length ? `<table>${keys.map(([k, v]) => `<tr><th><kbd>${k}</kbd></th><td>${v}</td></tr>`).join("")}</table>` : ""}
    <table>${links.map(([k, v]) => `<tr><th><code>${k}</code></th><td>${v}</td></tr>`).join("")}</table>
    <button type="button" class="btn small">Close</button>`;
  const toggle = (show = panel.hidden) => { panel.hidden = !show; };
  btn.onclick = () => toggle();
  panel.querySelector("button").onclick = () => toggle(false);
  document.body.appendChild(panel);
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, select, textarea")) return;
    if (e.key === "?") toggle();
    if (e.key === "Escape") toggle(false);
  });
  return btn;
}
