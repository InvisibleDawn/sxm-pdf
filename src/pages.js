// Opérations sur les pages : pivoter, supprimer, déplacer, insérer, extraire, fusionner, diviser, miniatures.
import { PDFDocument, degrees } from "pdf-lib";
import { toast, el, askText, confirmBox, busy, modal } from "./ui.js";
import * as io from "./io.js";
import { drawOverlay, writeAnnots, shift, norm, newId, viewBox, LABELS, BOXY, pixelate } from "./annots.js";
import { imagesToPdf } from "./convert.js";
import { $, $$, tab } from "./core.js";
import { pageView, pushUndo, refreshAll } from "./editor.js";
import { buildFinal, formBytes } from "./save.js";
import { loadBytes, markDirty, openPdfBytes } from "./tabs.js";

// ======================================================================= Pages

export async function reloadKeepingView(t, bytes) {
  t.restore = { scale: t.viewer.currentScaleValue, page: t.viewer.currentPageNumber };
  await loadBytes(t, bytes);
}

/** Applique une modification de structure (pdf-lib) puis recharge. */
export async function restructure(t, fn, remapAnnots) {
  pushUndo(t, true);
  const pdf = await PDFDocument.load(await formBytes(t), { ignoreEncryption: true });
  await fn(pdf);
  const bytes = await pdf.save();
  if (remapAnnots) t.annots = remapAnnots(t.annots);
  t.selected = null;
  await reloadKeepingView(t, bytes);
  renderAnnotList();
}

export async function rotatePage(i, delta) {
  const t = tab();
  await restructure(t, (pdf) => {
    const p = pdf.getPage(i);
    p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
  });
}
export async function deletePage(i) {
  const t = tab();
  if (t.viewer.pagesCount <= 1) return toast("Impossible de supprimer la seule page du document.", true);
  await restructure(t, (pdf) => pdf.removePage(i),
    (an) => an.filter((a) => a.page !== i).map((a) => (a.page > i ? { ...a, page: a.page - 1 } : a)));
}
export async function movePage(from, to) {
  const t = tab();
  if (from === to || from + 1 === to) return;
  await restructure(t, (pdf) => {
    const p = pdf.getPage(from);
    pdf.removePage(from);
    pdf.insertPage(to > from ? to - 1 : to, p);
  }, (an) => {
    const order = [...Array(t.viewer.pagesCount).keys()];
    order.splice(from, 1);
    order.splice(to > from ? to - 1 : to, 0, from);
    const map = new Map(order.map((old, nw) => [old, nw]));
    return an.map((a) => ({ ...a, page: map.get(a.page) }));
  });
}
export async function insertPdf() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  const paths = io.toArray(await io.pickPdf(true)); if (!paths.length) return;
  await busy("Ajout des pages…", () => restructure(t, async (pdf) => {
    for (const p of paths) {
      const other = await PDFDocument.load(await io.readFile(p), { ignoreEncryption: true });
      const pages = await pdf.copyPages(other, other.getPageIndices());
      pages.forEach((pg) => pdf.addPage(pg));
    }
  }));
  toast(`${paths.length} PDF ajouté(s) à la fin du document.`);
}

/** Ajoute une image comme nouvelle page (taille A4 maximum). */
export async function addImagePage(pdf, bytes, isPng, at = null) {
  const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const k = Math.min(1, 595 / img.width, 842 / img.height) || 1;
  const w = Math.max(img.width * 0.75 * (k < 1 ? k / 0.75 : 1), 50), h = w * (img.height / img.width);
  const page = at == null ? pdf.addPage([w, h]) : pdf.insertPage(at, [w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
}

export async function insertImagePage() {
  const t = tab(); if (!t) return imagesToPdf();
  const paths = io.toArray(await io.pickImages(true)); if (!paths.length) return;
  await restructure(t, async (pdf) => {
    for (const p of paths) await addImagePage(pdf, await io.readFile(p), io.ext(p) === "png");
  });
}

export function parseRange(str, n) {
  const set = [];
  for (const part of str.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) if (k >= 1 && k <= n) set.push(k - 1);
  }
  return set.length ? set : null;
}

export async function extractPages() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  const n = t.viewer.pagesCount;
  const r = await askText(`Pages à extraire (1 à ${n})`, String(t.viewer.currentPageNumber), { placeholder: "ex. 1-3, 5, 8" });
  if (r == null) return;
  const idx = parseRange(r, n);
  if (!idx) return toast("Plage de pages invalide. Exemple : 1-3, 5", true);
  const path = await io.savePath(io.stem(t.name) + ` (pages ${r.replace(/\s+/g, "")}).pdf`);
  if (!path) return;
  await busy("Extraction…", async () => {
    const src = await PDFDocument.load(await buildFinal(t));
    const out = await PDFDocument.create();
    (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
    await io.writeFile(path, await out.save());
  });
  toast("Pages extraites dans : " + io.baseName(path));
}

// ---- Miniatures
export let thumbJob = 0;
export async function renderThumbs() {
  const box = $("#thumbs");
  box.replaceChildren();
  const t = tab();
  if (!t?.pdfDoc) return;
  const job = ++thumbJob;
  const doc = t.pdfDoc;
  for (let i = 0; i < doc.numPages; i++) {
    const c = el("canvas");
    const item = el("div", { class: "thumb", draggable: "true", "data-i": i },
      c, el("span", { class: "num" }, String(i + 1)),
      el("div", { class: "ops" },
        el("button", { title: "Pivoter à gauche", onclick: (e) => { e.stopPropagation(); rotatePage(i, -90); } }, "⟲"),
        el("button", { title: "Pivoter à droite", onclick: (e) => { e.stopPropagation(); rotatePage(i, 90); } }, "⟳"),
        el("button", { title: "Supprimer la page", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Supprimer la page", `Supprimer la page ${i + 1} ?`, "Supprimer")) deletePage(i); } }, "🗑")));
    item.addEventListener("click", () => { t.viewer.currentPageNumber = i + 1; });
    item.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/sxm-page", String(i)));
    item.addEventListener("dragover", (e) => { e.preventDefault(); item.classList.add("drop-before"); });
    item.addEventListener("dragleave", () => item.classList.remove("drop-before"));
    item.addEventListener("drop", (e) => {
      e.preventDefault(); item.classList.remove("drop-before");
      const from = +e.dataTransfer.getData("text/sxm-page");
      if (!Number.isNaN(from)) movePage(from, i);
    });
    box.append(item);
  }
  // zone de dépôt « en dernier »
  const end = el("div", { class: "thumb", style: "height:30px;width:130px" });
  end.addEventListener("dragover", (e) => { e.preventDefault(); end.classList.add("drop-before"); });
  end.addEventListener("dragleave", () => end.classList.remove("drop-before"));
  end.addEventListener("drop", (e) => { e.preventDefault(); end.classList.remove("drop-before"); movePage(+e.dataTransfer.getData("text/sxm-page"), doc.numPages); });
  box.append(end);
  highlightThumb();

  for (let i = 0; i < doc.numPages; i++) {
    if (job !== thumbJob || t.pdfDoc !== doc) return;
    try {
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const sc = 260 / vp.width;
      const v2 = page.getViewport({ scale: sc });
      const c = box.children[i]?.querySelector("canvas");
      if (!c) return;
      c.width = v2.width; c.height = v2.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: v2 }).promise;
    } catch { /* document remplacé pendant le rendu */ }
  }
}
export function highlightThumb() {
  const t = tab(); if (!t) return;
  $$("#thumbs .thumb").forEach((n) => n.classList.toggle("on", +n.dataset.i === t.viewer.currentPageNumber - 1));
}

// ---- Liste des annotations
export function renderAnnotList() {
  const t = tab();
  const box = $("#annot-list");
  if (!t || !t.annots.length) return box.replaceChildren(el("div", { class: "empty-list" }, "Aucune annotation."));
  const sorted = [...t.annots].sort((a, b) => a.page - b.page);
  box.replaceChildren(...sorted.map((a) => {
    const desc = a.text || a.label || (a.type === "signature" ? "Signature" : "") || "";
    return el("div", {
      class: "annot-item", style: a.id === t.selected ? "border-color:var(--accent-2)" : "",
      onclick: () => {
        t.selected = a.id; refreshAll(t);
        const pv = pageView(t, a.page);
        const b = viewBox(pv.viewport, a);
        t.viewer.scrollPageIntoView({ pageNumber: a.page + 1, destArray: [null, { name: "XYZ" }, ...pv.viewport.convertToPdfPoint(0, Math.max(0, b.y - 60)), null] });
      },
    },
    el("div", { class: "t" }, el("span", { class: "dot", style: `background:${a.color || "#888"}` }), (a.closed ? "Zone entourée" : a.kind === "paraphe" ? "Paraphe" : LABELS[a.type] || a.type), el("span", { style: "margin-left:auto;color:var(--muted);font-weight:400" }, "p. " + (a.page + 1))),
    desc ? el("div", { class: "d" }, desc) : null);
  }));
}

export function updatePageInfo() {
  const t = tab();
  $("#pageinfo").textContent = t?.pdfDoc ? `${t.viewer.currentPageNumber} / ${t.viewer.pagesCount}` : "";
}
export function syncZoomSelect() {
  const t = tab(); if (!t) return;
  const v = String(t.viewer.currentScaleValue);
  const sel = $("#zoom");
  if (![...sel.options].some((o) => o.value === v)) {
    let o = sel.querySelector("option[data-custom]");
    if (!o) { o = el("option", { "data-custom": "1" }); sel.append(o); }
    o.value = v; o.textContent = Math.round(t.viewer.currentScale * 100) + " %";
  }
  sel.value = v;
}
export function zoom(step) {
  const t = tab(); if (!t) return;
  const s = t.viewer.currentScale;
  t.viewer.currentScale = Math.min(5, Math.max(0.25, +(step > 0 ? s * 1.15 : s / 1.15).toFixed(2)));
}

// ======================================================================= Fusion / division

export async function mergePdfs() {
  let paths = io.toArray(await io.pickPdf(true));
  if (!paths.length) return;
  const ordered = await modal((m, close) => {
    const list = el("div", { style: "display:flex;flex-direction:column;gap:6px;min-width:440px" });
    const render = () => {
      list.replaceChildren(...paths.map((p, i) => el("div", { class: "annot-item", style: "display:flex;align-items:center;gap:6px;cursor:default" },
        el("b", {}, i + 1 + "."), el("span", { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, io.baseName(p)),
        el("button", { class: "btn", title: "Monter", onclick: () => { if (i) { [paths[i - 1], paths[i]] = [paths[i], paths[i - 1]]; render(); } } }, "↑"),
        el("button", { class: "btn", title: "Descendre", onclick: () => { if (i < paths.length - 1) { [paths[i + 1], paths[i]] = [paths[i], paths[i + 1]]; render(); } } }, "↓"),
        el("button", { class: "btn", title: "Retirer", onclick: () => { paths.splice(i, 1); render(); } }, "✕"))));
    };
    render();
    m.append(el("h2", {}, "Fusionner des PDF"), el("p", {}, "Réglez l'ordre des fichiers :"), list,
      el("div", { class: "row end" },
        el("button", { class: "btn", style: "margin-right:auto", onclick: async () => { paths.push(...io.toArray(await io.pickPdf(true))); render(); } }, "➕ Ajouter…"),
        el("button", { class: "btn", onclick: () => close(null) }, "Annuler"),
        el("button", { class: "btn accent", onclick: () => close(paths.length ? paths : null) }, "Fusionner")));
  });
  if (!ordered) return;
  const bytes = await busy("Fusion…", async () => {
    const pdf = await PDFDocument.create();
    for (const p of ordered) {
      let other;
      try { other = await PDFDocument.load(await io.readFile(p)); }
      catch { throw new Error(`« ${io.baseName(p)} » est protégé ou illisible : ouvrez-le et retirez son mot de passe d'abord.`); }
      (await pdf.copyPages(other, other.getPageIndices())).forEach((pg) => pdf.addPage(pg));
    }
    return pdf.save();
  });
  markDirty(await openPdfBytes(bytes, "Fusion.pdf", null));
  toast(`${ordered.length} PDF fusionnés. Pensez à enregistrer (Ctrl+S).`);
}

export async function splitPdf() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord le PDF à diviser.", true);
  const n = t.viewer.pagesCount;
  const opts = await modal((m, close) => {
    const every = el("input", { type: "radio", name: "mode", checked: "" });
    const ranges = el("input", { type: "radio", name: "mode" });
    const nIn = el("input", { type: "number", min: 1, max: n, value: 1, style: "width:70px;padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--panel2)" });
    const rIn = el("input", { type: "text", placeholder: "ex. 1-3; 4-7; 8" });
    rIn.addEventListener("focus", () => (ranges.checked = true));
    nIn.addEventListener("focus", () => (every.checked = true));
    m.append(el("h2", {}, `Diviser « ${t.name} » (${n} pages)`),
      el("label", { class: "row" }, every, "Un fichier toutes les", nIn, "page(s)"),
      el("label", { class: "row" }, ranges, "Selon des plages (séparées par ;)"), rIn,
      el("div", { class: "row end" },
        el("button", { class: "btn", onclick: () => close(null) }, "Annuler"),
        el("button", { class: "btn accent", onclick: () => close(every.checked ? { every: Math.max(1, +nIn.value || 1) } : { ranges: rIn.value }) }, "Choisir le dossier…")));
  });
  if (!opts) return;
  let groups = [];
  if (opts.every) for (let i = 0; i < n; i += opts.every) groups.push([...Array(Math.min(opts.every, n - i)).keys()].map((k) => i + k));
  else {
    for (const part of opts.ranges.split(";").map((x) => x.trim()).filter(Boolean)) {
      const g = parseRange(part, n);
      if (!g) return toast(`Plage invalide : « ${part} »`, true);
      groups.push(g);
    }
  }
  if (!groups.length) return toast("Aucune page à extraire.", true);
  const dir = await io.pickFolder(); if (!dir) return;
  const sep = dir.includes("\\") ? "\\" : "/";
  await busy("Division…", async () => {
    const src = await PDFDocument.load(await buildFinal(t));
    let k = 1;
    for (const g of groups) {
      const out = await PDFDocument.create();
      (await out.copyPages(src, g)).forEach((p) => out.addPage(p));
      const label = g.length === 1 ? `page-${g[0] + 1}` : `pages-${g[0] + 1}-${g.at(-1) + 1}`;
      await io.writeFile(`${dir}${sep}${io.stem(t.name)}-${String(k++).padStart(2, "0")}-${label}.pdf`, await out.save());
    }
  });
  toast(`${groups.length} fichier(s) créé(s) dans ${dir}`);
}
