// Filigrane : texte Unicode, derrière ou devant le contenu, horizontal / diagonal / vertical,
// plage de pages, modèles enregistrés, aperçu rendu à partir du vrai PDF.
import { PDFDocument, rgb, degrees, PDFArray, PDFName } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { modal, el, toast, askText, confirmBox } from "./ui.js";

const TPL_KEY = "sxm.watermarkTemplates";
import * as db from "./store.js";
const loadTpl = () => [...(db.get(TPL_KEY, []) || [])];
const saveTpl = (v) => db.set(TPL_KEY, v);

export const WM_PRESETS = ["CONFIDENTIEL", "COPIE", "BROUILLON", "NE PAS DIFFUSER", "DOCUMENT INTERNE"];
export const WM_DEFAULT = { text: "CONFIDENTIEL", color: "#dc2626", opacity: 0.25, scale: 0.9, orient: "diagonal", layer: "back" };

// Police Unicode (DejaVu Sans Bold) : accents, ç, œ, ß, grec, cyrillique…
let fontBytes = null;
async function unicodeFont() {
  if (!fontBytes) fontBytes = new Uint8Array(await (await fetch("/fonts/DejaVuSans-Bold.ttf")).arrayBuffer());
  return fontBytes;
}

/** Remplace par « ? » les caractères absents de la police (ex. chinois). */
function encodable(font, text) {
  let out = "";
  for (const ch of text) {
    try { font.encodeText(ch); out += font.widthOfTextAtSize(ch, 10) > 0 || ch === " " ? ch : "?"; } catch { out += "?"; }
  }
  return out;
}

/** Met le dernier flux de contenu de la page en premier : il est alors dessiné sous le contenu existant. */
function sendToBack(page) {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray) || contents.size() < 2) return;
  const last = contents.get(contents.size() - 1);
  contents.remove(contents.size() - 1);
  contents.insert(0, last);
}

/**
 * Écrit le filigrane dans le document pdf-lib.
 * pageIdx : liste d'indices de pages (0 = première) ; null = toutes.
 */
export async function drawWatermark(pdf, opt, pageIdx = null) {
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await unicodeFont(), { subset: true });
  const n = parseInt(opt.color.slice(1), 16);
  const color = rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  const label = encodable(font, opt.text);
  const wanted = pageIdx ? new Set(pageIdx) : null;

  pdf.getPages().forEach((page, i) => {
    if (wanted && !wanted.has(i)) return;
    const { width: W, height: H } = page.getSize();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const sideways = rot === 90 || rot === 270;
    const Wv = sideways ? H : W, Hv = sideways ? W : H; // dimensions telles qu'affichées

    // Angle voulu à l'écran, puis compensation de la rotation de la page
    const vis = opt.orient === "horizontal" ? 0 : opt.orient === "vertical" ? Math.PI / 2 : Math.atan2(Hv, Wv);
    const ang = vis + (rot * Math.PI) / 180;

    const length = opt.orient === "horizontal" ? Wv * 0.8 : opt.orient === "vertical" ? Hv * 0.8 : Math.hypot(Wv, Hv) * 0.72;
    const cross = opt.orient === "horizontal" ? Hv : opt.orient === "vertical" ? Wv : Math.min(Wv, Hv);
    const fs = Math.max(8, Math.min((100 * length * opt.scale) / Math.max(1, font.widthOfTextAtSize(label, 100)), cross * 0.22));
    const tw = font.widthOfTextAtSize(label, fs), th = font.heightAtSize(fs, { descender: false }) * 0.72;

    // Centre du texte au centre de la page (repère PDF non tourné)
    const x = W / 2 - (tw / 2) * Math.cos(ang) + (th / 2) * Math.sin(ang);
    const y = H / 2 - (tw / 2) * Math.sin(ang) - (th / 2) * Math.cos(ang);
    page.drawText(label, { x, y, size: fs, font, color, opacity: opt.opacity, rotate: degrees((ang * 180) / Math.PI) });
    if (opt.layer === "back") sendToBack(page);
  });
  return label !== opt.text; // vrai si des caractères ont été remplacés
}

/**
 * Fenêtre de réglage. ctx = { bytes, pageCount, currentPage, parseRange, renderPage }
 * renderPage(bytes, canvas) dessine la page 1 d'un PDF dans un canevas.
 * Renvoie { opt, pages: indices|null } ou null.
 */
export function watermarkDialog(ctx) {
  return modal((m, close) => {
    let opt = { ...WM_DEFAULT };
    let templates = loadTpl();

    const input = el("input", { type: "text", style: "flex:1" });
    input.value = opt.text;
    const chips = WM_PRESETS.map((p) => el("button", { class: "btn", onclick: () => { input.value = p; sync(); } }, p));

    const COLORS = ["#dc2626", "#6b7280", "#0f6cbd", "#059669", "#7c3aed", "#ea580c"];
    const colorBtns = COLORS.map((c) => {
      const b = el("button", { class: "swatch", style: `background:${c}`, title: c });
      b.onclick = () => { opt.color = c; sync(); };
      return b;
    });
    const custom = el("input", { type: "color", value: opt.color, title: "Autre couleur", style: "width:34px;height:28px;border:1px solid var(--border);border-radius:6px;padding:2px;background:var(--panel2)" });
    custom.addEventListener("input", () => { opt.color = custom.value; sync(); });

    const seg = (name, items) => {
      const box = el("div", { style: "display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden" });
      const btns = items.map(([v, l]) => {
        const b = el("button", { style: "border:0;padding:6px 12px;background:var(--panel2)" }, l);
        b.onclick = () => { opt[name] = v; sync(); };
        b.dataset.v = v;
        return b;
      });
      box.append(...btns);
      box.refresh = () => btns.forEach((b) => { const on = b.dataset.v === String(opt[name]); b.style.background = on ? "var(--accent)" : "var(--panel2)"; b.style.color = on ? "#fff" : ""; });
      return box;
    };
    const orient = seg("orient", [["horizontal", "Horizontal"], ["diagonal", "Diagonal"], ["vertical", "Vertical"]]);
    const layer = seg("layer", [["back", "Derrière le texte"], ["front", "Devant"]]);
    const op = el("input", { type: "range", min: 5, max: 80, value: opt.opacity * 100 });
    op.addEventListener("input", () => { opt.opacity = op.value / 100; sync(); });
    const size = el("select", {}, el("option", { value: "1" }, "Très grand"), el("option", { value: "0.9" }, "Grand"), el("option", { value: "0.7" }, "Moyen"), el("option", { value: "0.5" }, "Petit"));
    size.addEventListener("change", () => { opt.scale = +size.value; sync(); });

    // Pages
    const pagesSel = el("select", {}, el("option", { value: "all" }, "Toutes les pages"), el("option", { value: "first" }, "Première page"), el("option", { value: "range" }, "Pages…"));
    const rangeIn = el("input", { type: "text", placeholder: `ex. 1-3, 5 (sur ${ctx.pageCount})`, style: "max-width:190px" });
    rangeIn.classList.add("hidden");
    pagesSel.addEventListener("change", () => { rangeIn.classList.toggle("hidden", pagesSel.value !== "range"); if (pagesSel.value === "range") rangeIn.focus(); schedule(); });
    rangeIn.addEventListener("input", schedule);
    const pageList = () => {
      if (pagesSel.value === "all") return null;
      if (pagesSel.value === "first") return [0];
      return ctx.parseRange(rangeIn.value, ctx.pageCount);
    };

    // Modèles personnels
    const tplSel = el("select", { style: "flex:1" });
    const renderTpl = (selected = "") => {
      tplSel.replaceChildren(el("option", { value: "" }, templates.length ? "— Mes modèles —" : "— Aucun modèle enregistré —"), ...templates.map((t) => el("option", { value: t.name }, t.name)));
      tplSel.value = selected;
    };
    renderTpl();
    tplSel.addEventListener("change", () => {
      const t = templates.find((x) => x.name === tplSel.value);
      if (!t) return;
      opt = { ...WM_DEFAULT, ...t.opt }; input.value = opt.text; op.value = opt.opacity * 100; size.value = String(opt.scale); custom.value = opt.color;
      sync();
    });
    const saveTemplate = async () => {
      const name = (await askText("Nom du modèle", tplSel.value || input.value.trim(), { placeholder: "ex. Confidentiel RH" }))?.trim();
      if (!name) return;
      opt.text = input.value.trim() || opt.text;
      templates = [...templates.filter((t) => t.name !== name), { name, opt: { ...opt } }].sort((a, b) => a.name.localeCompare(b.name));
      saveTpl(templates); renderTpl(name);
      toast(`Modèle « ${name} » enregistré.`);
    };
    const delTemplate = async () => {
      if (!tplSel.value) return;
      if (!(await confirmBox("Supprimer le modèle", `Supprimer « ${tplSel.value} » ?`, "Supprimer"))) return;
      templates = templates.filter((t) => t.name !== tplSel.value); saveTpl(templates); renderTpl();
    };

    // Aperçu : la vraie page du document, filigranée exactement comme à l'enregistrement
    const canvas = el("canvas", { style: "max-width:100%;max-height:100%;box-shadow:var(--shadow);background:#fff" });
    const pv = el("div", { style: "width:330px;height:430px;flex:none;background:var(--doc-bg);border-radius:12px;display:flex;align-items:center;justify-content:center;padding:12px" }, canvas);
    const pvLabel = el("p", { style: "font-size:12px;text-align:center" }, "");
    const warn = el("p", { style: "font-size:12px;color:#b45309" }, "");
    let onePage = {}, timer = null, job = 0;
    const pageBytes = async (i) => {
      if (!onePage[i]) {
        const src = await PDFDocument.load(ctx.bytes, { ignoreEncryption: true });
        const out = await PDFDocument.create();
        const [p] = await out.copyPages(src, [i]);
        out.addPage(p);
        onePage[i] = await out.save();
      }
      return onePage[i];
    };
    async function renderPreview() {
      const my = ++job;
      const list = pageList();
      const i = list?.length ? list[0] : Math.min(ctx.currentPage, ctx.pageCount - 1);
      pvLabel.textContent = list === undefined || (pagesSel.value === "range" && !list) ? "Plage de pages invalide" : `Aperçu de la page ${i + 1}`;
      try {
        const doc = await PDFDocument.load(await pageBytes(i));
        const replaced = await drawWatermark(doc, { ...opt, text: input.value.trim() || " " });
        warn.textContent = replaced ? "⚠️ Certains caractères ne sont pas disponibles et seront remplacés par « ? »." : "";
        const bytes = await doc.save();
        if (my === job) await ctx.renderPage(bytes, canvas, 300);
      } catch (e) { pvLabel.textContent = "Aperçu indisponible : " + (e?.message || e); }
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(renderPreview, 180); }
    function sync() {
      colorBtns.forEach((b, k) => b.classList.toggle("on", COLORS[k] === opt.color));
      orient.refresh(); layer.refresh();
      schedule();
    }
    input.addEventListener("input", schedule);

    const label = (t) => el("span", { style: "min-width:92px;color:var(--muted)" }, t);
    const left = el("div", { style: "display:flex;flex-direction:column;gap:10px;min-width:430px" },
      el("div", { class: "row" }, tplSel,
        el("button", { class: "btn", onclick: saveTemplate, title: "Enregistrer ces réglages comme modèle" }, "💾 Enregistrer"),
        el("button", { class: "btn", onclick: delTemplate, title: "Supprimer ce modèle" }, "🗑")),
      el("div", { class: "row" }, ...chips),
      el("div", { class: "row" }, input),
      warn,
      el("div", { class: "row" }, label("Orientation"), orient),
      el("div", { class: "row" }, label("Position"), layer),
      el("div", { class: "row" }, label("Couleur"), ...colorBtns, custom),
      el("div", { class: "row" }, label("Transparence"), op),
      el("div", { class: "row" }, label("Taille"), size),
      el("div", { class: "row" }, label("Pages"), pagesSel, rangeIn),
      el("p", { style: "font-size:12px" }, "« Derrière le texte » garde le document lisible. Sur un document scanné (page en image), choisissez « Devant » : sinon le filigrane serait caché par l'image."),
    );

    m.append(
      el("h2", {}, "Filigrane"),
      el("div", { style: "display:flex;gap:18px;align-items:flex-start" }, left, el("div", {}, pv, pvLabel)),
      el("div", { class: "row end" },
        el("button", { class: "btn", onclick: () => close(null) }, "Annuler"),
        el("button", { class: "btn accent", onclick: () => {
          const text = input.value.trim();
          if (!text) return toast("Tapez le texte du filigrane.", true);
          const pages = pageList();
          if (pagesSel.value === "range" && !pages) return toast("Plage de pages invalide. Exemple : 1-3, 5", true);
          close({ opt: { ...opt, text }, pages });
        } }, "Appliquer")));
    size.value = String(opt.scale);
    sync();
    setTimeout(() => input.select(), 30);
  });
}
