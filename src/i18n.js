// Langue de l'interface : français (texte d'origine du code) ou anglais.
// Les modules ne sont pas réécrits : en anglais, les textes affichés (nœuds texte, title, placeholder,
// aria-label, data-tip) sont traduits à la volée par un MutationObserver, à partir du dictionnaire
// i18n-en.js (correspondances exactes, préfixes « … : » et modèles avec parties variables).
// Le contenu des PDF (.pdfViewer) et les champs de saisie ne sont jamais touchés.
import { EN, EN_PATTERNS } from "./i18n-en.js";

const KEY = "sxm.lang";

/** Choix enregistré : "auto" (langue du système), "fr" ou "en". */
export function langSetting() {
  try { return localStorage.getItem(KEY) || "auto"; } catch { return "auto"; }
}

export function setLangSetting(v) {
  try { localStorage.setItem(KEY, v); } catch { /* stockage indisponible : choix non mémorisé */ }
}

/** Langue effective. Automatique : français si le système est en français, sinon anglais. */
export function currentLang() {
  const s = langSetting();
  if (s === "fr" || s === "en") return s;
  const sys = (navigator.languages?.[0] || navigator.language || "fr").toLowerCase();
  return sys.startsWith("fr") ? "fr" : "en";
}

export const isEn = () => currentLang() === "en";

// ------------------------------------------------------------------ traduction d'une chaîne
const PREFIXES = Object.keys(EN)
  .filter((k) => k.endsWith(":"))
  .sort((a, b) => b.length - a.length);

const COMPILED = EN_PATTERNS.map(([fr, en]) => {
  const parts = fr.split(/\{(\d)\}/);
  let src = "^";
  for (let i = 0; i < parts.length; i++) {
    src += i % 2 ? "([\\s\\S]+?)" : parts[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return { re: new RegExp(src + "$"), en };
});

/** Noms de touches dans les raccourcis affichés. */
const keys = (s) => s.replace(/\bMaj\b/g, "Shift").replace(/\bSuppr\b/g, "Del").replace(/\bEntrée\b/g, "Enter").replace(/\bÉchap\b/g, "Esc");

function trLine(line) {
  if (!line) return line;
  const lead = line.match(/^\s*/)[0];
  const trail = line.match(/\s*$/)[0];
  const core = line.trim();
  if (!core) return line;
  let out = EN[core];
  if (out === undefined) {
    for (const p of COMPILED) {
      const m = core.match(p.re);
      if (m) { out = p.en.replace(/\{(\d)\}/g, (_, i) => trLine(m[+i + 1])); break; }
    }
  }
  if (out === undefined) {
    // « Taille : » → « Size: » ; « Ouvrir (Ctrl+O) » → « Open (Ctrl+O) »
    let m = core.match(/^(.+?)\s?:$/);
    if (m && EN[m[1]] !== undefined) out = EN[m[1]] + ":";
    else if ((m = core.match(/^(.+?)(\s+\([^()]*\))$/)) && EN[m[1]] !== undefined) out = EN[m[1]] + keys(m[2]);
  }
  if (out === undefined) {
    for (const p of PREFIXES) {
      if (core.startsWith(p) && core.length > p.length) { out = EN[p] + core.slice(p.length); break; }
    }
  }
  return out === undefined ? line : lead + out + trail;
}

/** Traduit un texte (plusieurs lignes possibles) dans la langue de l'interface. */
export function tr(text) {
  if (!isEn() || typeof text !== "string") return text;
  return text.includes("\n") ? text.split("\n").map(trLine).join("\n") : trLine(text);
}

// ------------------------------------------------------------------ traduction de l'interface
const ATTRS = ["title", "placeholder", "aria-label", "data-tip"];
const SKIP = ".pdfViewer, textarea, [contenteditable], [data-no-tr]";

function skip(node) {
  const e = node.nodeType === 1 ? node : node.parentElement;
  return !e || !!e.closest(SKIP) || e.tagName === "SCRIPT" || e.tagName === "STYLE";
}

function trText(n) {
  if (skip(n)) return;
  const v = n.nodeValue;
  const t = tr(v);
  if (t !== v) n.nodeValue = t;
}

function trAttrs(e) {
  if (e.closest?.(SKIP)) return;
  for (const a of ATTRS) {
    const v = e.getAttribute?.(a);
    if (v) { const t = tr(v); if (t !== v) e.setAttribute(a, t); }
  }
}

function trTree(root) {
  if (root.nodeType === 3) return trText(root);
  if (root.nodeType !== 1 || root.closest?.(".pdfViewer")) return;
  trAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(".pdfViewer") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? trText(n) : trAttrs(n);
}

/** À appeler au démarrage : traduit la page puis tout ce qui s'y ajoute. Sans effet en français. */
export function initI18n() {
  document.documentElement.lang = currentLang();
  if (!isEn()) return;
  document.title = tr(document.title);
  trTree(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "childList") m.addedNodes.forEach(trTree);
      else if (m.type === "characterData") trText(m.target);
      else if (m.type === "attributes") trAttrs(m.target);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
