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
export function bars(el, weights, max = 6) {
  const rows = Object.entries(weights || {}).sort((a, b) => b[1] - a[1]).slice(0, max);
  const total = rows.reduce((s, [, v]) => s + v, 0) || 1;
  el.innerHTML = rows.length
    ? rows.map(([k, v]) => `<div class="bar" data-genre="${k}"><span>${k}</span><div><div class="fill" style="width:${Math.round((v / total) * 100)}%"></div></div><span class="mono">${Math.round((v / total) * 100)}%</span></div>`).join("")
    : `<div class="mute">Nothing yet.</div>`;
}
export function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 2600);
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
export function refusalTicket(r) {
  const code = r.code === 11000 ? "E11000" : `${r.code}${r.codeName ? " " + r.codeName : ""}`;
  return `<div class="ticket" data-code="${r.code}"><div><b>${r.reason || "The database refused this."}</b></div><div class="code">Database refused it: code ${code}</div><div class="mono" style="font-size:11px">${r.where || ""}</div></div>`;
}
