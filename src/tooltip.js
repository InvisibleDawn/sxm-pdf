// Info-bulles maison : pastille sombre avec le raccourci clavier, à la place des
// info-bulles système (lentes et austères). Fonctionne pour tout élément ayant un title.

let tip, timer, current;

function parse(text) {
  // « Ouvrir (Ctrl+O) » → nom « Ouvrir », raccourci « Ctrl+O »
  const m = text.match(/^(.*?)\s*\(([^()]{1,16})\)\s*$/);
  if (m && /Ctrl|Maj|Suppr|Échap|Entrée|^[A-Z0-9]$/.test(m[2])) return [m[1], m[2]];
  return [text, ""];
}

function show(target) {
  const text = target.dataset.tip;
  if (!text) return;
  const [name, key] = parse(text);
  tip.replaceChildren(document.createTextNode(name));
  if (key) {
    const k = document.createElement("kbd");
    k.textContent = key;
    tip.appendChild(k);
  }
  tip.classList.add("show");
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  // à droite pour le rail, en dessous ailleurs
  let x, y;
  if (target.closest("#rail")) { x = r.right + 10; y = r.top + r.height / 2 - t.height / 2; }
  else { x = r.left + r.width / 2 - t.width / 2; y = r.bottom + 8; }
  if (y + t.height > innerHeight - 4) y = r.top - t.height - 8;
  x = Math.max(6, Math.min(x, innerWidth - t.width - 6));
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}

function hide() {
  clearTimeout(timer);
  current = null;
  tip?.classList.remove("show");
}

export function initTooltips() {
  // Les libellés du ruban et du rail deviennent des info-bulles (moins de texte à l'écran).
  document.querySelectorAll(".rib-panel button, .rail-btn, .side-tabs button").forEach((b) => {
    const label = b.querySelector("span")?.textContent.trim();
    if (!b.title && label) b.title = label;
  });
  tip = document.createElement("div");
  tip.id = "tip";
  document.body.appendChild(tip);

  document.addEventListener("pointerover", (e) => {
    const t = e.target.closest?.("[title], [data-tip]");
    if (!t || t === current) return;
    if (t.title) { t.dataset.tip = t.title; t.removeAttribute("title"); }
    hide();
    current = t;
    timer = setTimeout(() => { if (current === t && t.isConnected) show(t); }, 350);
  });
  document.addEventListener("pointerout", (e) => {
    if (current && !current.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("wheel", hide, { passive: true });
  document.addEventListener("keydown", hide, true);
}
