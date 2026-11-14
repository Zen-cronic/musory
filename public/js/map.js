// Draws the arrows between map nodes: [from, to, label]
export function drawMap(root, links) {
  const svg = root.querySelector("svg.wires");
  const draw = () => {
    root.querySelectorAll(".wl").forEach((x) => x.remove());
    svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="#B1FF05"/></marker></defs>';
    const R = root.getBoundingClientRect();
    for (const [a, b, label] of links) {
      const A = root.querySelector(a).getBoundingClientRect(), B = root.querySelector(b).getBoundingClientRect();
      const ax = A.left + A.width / 2 - R.left, ay = A.top + A.height / 2 - R.top, bx = B.left + B.width / 2 - R.left, by = B.top + B.height / 2 - R.top;
      // Clip both ends to the box edges
      const edge = (cx, cy, box, dx, dy) => { const hw = box.width / 2 + 8, hh = box.height / 2 + 8; const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity); return [cx + dx * t, cy + dy * t]; };
      const dx = bx - ax, dy = by - ay;
      const [x1, y1] = edge(ax, ay, A, dx, dy), [x2, y2] = edge(bx, by, B, -dx, -dy);
      svg.insertAdjacentHTML("beforeend", `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#B1FF05" stroke-width="2.5" marker-end="url(#ah)"/>`);
      if (label) { const l = document.createElement("span"); l.className = "wl"; l.textContent = label; l.style.left = `${(x1 + x2) / 2}px`; l.style.top = `${(y1 + y2) / 2}px`; l.style.translate = "-50% -50%"; root.appendChild(l); }
    }
  };
  draw();
  addEventListener("resize", draw);
  document.fonts?.ready.then(draw);
}
export const MAP_LINKS = [["#n-tap", "#n-change", "Likes"], ["#n-embed", "#n-change", "Vectors"], ["#n-change", "#n-room", "Next track"], ["#n-play", "#n-room", "New track"], ["#n-lang", "#n-change", "Checks"]];
