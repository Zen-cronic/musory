// Sets the look before the first paint, so pages never flash the wrong colours. Keep in step with look.js.
(function () {
  var L = ["evergreen", "pitwall", "livery"];
  var q = new URLSearchParams(location.search).get("style"), s = null;
  try { s = localStorage.getItem("musory:look"); } catch (e) {}
  document.documentElement.dataset.look = q !== null ? (L.indexOf(q) >= 0 ? q : L[0]) : (L.indexOf(s) >= 0 ? s : L[0]);
})();
