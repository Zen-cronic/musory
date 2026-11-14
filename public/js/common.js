// Shared helpers for the pages.
export async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
}
export function events(handlers) {
  const es = new EventSource("/events");
  for (const [type, fn] of Object.entries(handlers)) es.addEventListener(type, (e) => fn(JSON.parse(e.data)));
  return es;
}
export const $ = (id) => document.getElementById(id);
const cap = (k) => (k ? k.charAt(0).toUpperCase() + k.slice(1) : k);
export const genreName = (g) => cap(String(g || "").replace(/&/g, "and"));
export function bars(el, weights, max = 6) {
  const rows = Object.entries(weights || {}).sort((a, b) => b[1] - a[1]).slice(0, max);
  const total = rows.reduce((s, [, v]) => s + v, 0) || 1;
  el.innerHTML = rows.length
    ? rows.map(([k, v], i) => { const p = Math.round((v / total) * 100); return `<div class="bar-row${i === 0 ? " is-top" : ""}" data-genre="${k}"><span class="name">${genreName(k)}</span><span class="track"><span class="fill" style="width:${p}%"></span></span><span class="pct">${p}%</span></div>`; }).join("")
    : `<div class="note">Nothing yet.</div>`;
}
export function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; t.id = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2600);
}
export function progress(el, play) {
  if (!play) return;
  const tick = () => {
    const f = Math.min(1, Math.max(0, (Date.now() - play.startedAt) / (play.endsAt - play.startedAt)));
    el.style.width = `${f * 100}%`;
    if (f < 1 && el._play === play) requestAnimationFrame(tick);
  };
  el._play = play;
  tick();
}
// Plain words for each refusal code. The reason from the server says what happened; this says why.
const WHY = {
  121: "The database checks every memory against its rules before saving.",
  13: "Each venue's login can only read its own crowd memory.",
  11000: "One like per guest per track.",
};
export function refusalTicket(r) {
  const code = r.code === 11000 ? "11000" : String(r.code);
  return `<div class="refusal" data-code="${r.code}"><span class="code">${code}</span><span class="what">${r.reason || "The database refused this."}</span><span class="why">${WHY[r.code] || "The database refused it."}</span></div>`;
}
