// Fonctions RH (paraphe, masquage par recherche, lot), filigrane et mots de passe.
import { PDFDocument, degrees } from "pdf-lib";
import { toast, el, askText, confirmBox, busy, modal } from "./ui.js";
import * as io from "./io.js";
import { drawOverlay, writeAnnots, shift, norm, newId, viewBox, LABELS, BOXY, pixelate } from "./annots.js";
import { watermarkDialog, drawWatermark } from "./watermark.js";
import { parapheDialog, parapheAnnots, searchRedactDialog, findMatches, batchDialog, batchAnnots } from "./rh.js";
import { pdfjsLib } from "./pdfsetup.js";
import { ensureTool } from "./app.js";
import { $, $$, tab } from "./core.js";
import { pushUndo, refreshAll } from "./editor.js";
import { parseRange, restructure } from "./pages.js";
import { formBytes, saveTab } from "./save.js";
import { markDirty, renderTabs } from "./tabs.js";

// ======================================================================= Fonctions RH

export const PDFJS_OPTS = { cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" };

export async function doParaphe() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  const n = t.viewer.pagesCount;
  const r = await parapheDialog(n); if (!r) return;
  const annots = await parapheAnnots(n, async (i) => (await t.pdfDoc.getPage(i + 1)).getViewport({ scale: 1 }), r);
  pushUndo(t);
  t.annots.push(...annots);
  refreshAll(t);
  toast(`✍️ ${annots.length} page(s) paraphée(s). Sélectionnez un paraphe pour le déplacer si besoin.`);
}

export async function doSearchRedact() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  const r = await searchRedactDialog(); if (!r) return;
  const matches = await busy("Recherche dans le document…", () => findMatches(t.pdfDoc, r.regexes));
  if (!matches.length) return toast("Aucune occurrence trouvée. Si le document est scanné, masquez à la main avec ▦ Masquer.", true);
  pushUndo(t);
  for (const mt of matches)
    for (const [x1, y1, x2, y2] of mt.rects)
      t.annots.push({ id: newId(), page: mt.page, type: "redact", mode: r.mode, ...norm(x1, y1, x2, y2) });
  refreshAll(t);
  const pages = new Set(matches.map((x) => x.page)).size;
  $$("[data-side]").find((b) => b.dataset.side === "annots")?.click();
  t.viewer.currentPageNumber = matches[0].page + 1;
  toast(`🔍 ${matches.length} occurrence(s) masquée(s) sur ${pages} page(s).\nVérifiez le résultat avant d'enregistrer (Ctrl+Z pour annuler).`);
}

export async function doBatch() {
  const cfg = await batchDialog({ pickPdfs: async () => io.toArray(await io.pickPdf(true)), pickFolder: io.pickFolder, baseName: io.baseName });
  if (!cfg) return;
  if (cfg.password && !(await ensureTool("qpdf"))) return;
  const errors = [];
  let ok = 0;
  await busy("Traitement…", async (setLabel) => {
    for (const [k, f] of cfg.files.entries()) {
      setLabel(`Traitement ${k + 1} / ${cfg.files.length} : ${io.baseName(f)}`);
      try {
        const bytes = await io.readFile(f);
        let pdf;
        try { pdf = await PDFDocument.load(bytes); }
        catch (e) { throw new Error(/encrypt/i.test(String(e)) ? "protégé par mot de passe, ignoré" : "PDF illisible"); }
        const js = await pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_OPTS }).promise;
        const vps = new Map();
        const getVp = async (i) => {
          if (!vps.has(i)) vps.set(i, (await js.getPage(i + 1)).getViewport({ scale: 1 }));
          return vps.get(i);
        };
        await writeAnnots(pdf, await batchAnnots(cfg, pdf.getPageCount(), getVp), getVp);
        js.destroy();
        const sep = f.includes("\\") ? "\\" : "/";
        let out = cfg.outDir ? `${cfg.outDir}${sep}${io.baseName(f)}` : `${io.dirName(f)}${sep}${io.stem(f)}${cfg.suffix}.pdf`;
        if (out === f) out = `${io.dirName(f)}${sep}${io.stem(f)}${cfg.suffix}.pdf`; // jamais d'écrasement de l'original
        await io.writeFile(out, await pdf.save());
        if (cfg.password) await io.pdfEncrypt(out, out, { user: cfg.password, owner: cfg.password, print: true, copy: true, modify: true });
        ok++;
      } catch (e) {
        errors.push(`${io.baseName(f)} : ${e?.message || e}`);
      }
    }
  });
  if (errors.length) {
    modal((m, close) => m.append(
      el("h2", {}, `📦 ${ok} fichier(s) traité(s), ${errors.length} problème(s)`),
      ...errors.map((x) => el("p", {}, "⚠️ " + x)),
      el("div", { class: "row end" }, el("button", { class: "btn accent", onclick: () => close() }, "OK"))));
  } else toast(`📦 ${ok} fichier(s) traité(s) avec succès.`);
}

// ======================================================================= Filigrane

/** Rend la page 1 d'un PDF dans un canevas (largeur cible en px). */
export async function renderFirstPage(bytes, canvas, width) {
  const doc = await pdfjsLib.getDocument({ data: bytes, cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
  const page = await doc.getPage(1);
  const vp0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (width * 2) / vp0.width });
  canvas.width = vp.width; canvas.height = vp.height;
  canvas.style.width = width + "px";
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  doc.destroy();
}

export async function doWatermark() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  const r = await watermarkDialog({
    bytes: await formBytes(t), pageCount: t.viewer.pagesCount, currentPage: t.viewer.currentPageNumber - 1,
    parseRange, renderPage: renderFirstPage,
  });
  if (!r) return;
  await busy("Ajout du filigrane…", () => restructure(t, (pdf) => drawWatermark(pdf, r.opt, r.pages)));
  toast(`Filigrane « ${r.opt.text} » ajouté. Ctrl+Z pour l'annuler.`);
}

// ======================================================================= Mot de passe

export async function protectDialog() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  if (!(await ensureTool("qpdf"))) return;
  const inp = (ph) => el("input", { type: "password", placeholder: ph, style: "flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel2);user-select:text" });
  const r = await modal((m, close) => {
    const pw = inp("Mot de passe d'ouverture"), pw2 = inp("Confirmer le mot de passe");
    const cPrint = el("input", { type: "checkbox", checked: "" }), cCopy = el("input", { type: "checkbox", checked: "" }), cMod = el("input", { type: "checkbox", checked: "" });
    const owner = inp("Mot de passe propriétaire (pour changer les droits)");
    const ownerRow = el("div", { class: "row hidden" }, owner);
    const sync = () => ownerRow.classList.toggle("hidden", cPrint.checked && cCopy.checked && cMod.checked);
    [cPrint, cCopy, cMod].forEach((c) => c.addEventListener("change", sync));
    const err = el("p", { style: "color:#dc2626" });
    const ok = () => {
      if (pw.value.length < 4) return (err.textContent = "Au moins 4 caractères.");
      if (pw.value !== pw2.value) return (err.textContent = "Les deux mots de passe ne correspondent pas.");
      const restricted = !(cPrint.checked && cCopy.checked && cMod.checked);
      if (restricted && !owner.value) return (err.textContent = "Indiquez un mot de passe propriétaire pour appliquer les restrictions.");
      if (restricted && owner.value === pw.value) return (err.textContent = "Le mot de passe propriétaire doit être différent.");
      close({ user: pw.value, owner: restricted ? owner.value : pw.value, print: cPrint.checked, copy: cCopy.checked, modify: cMod.checked });
    };
    m.append(el("h2", {}, "🔒 Protéger par mot de passe"),
      el("p", {}, "Chiffrement AES-256. Le mot de passe sera demandé à chaque ouverture, dans tous les lecteurs PDF."),
      el("div", { class: "row" }, pw), el("div", { class: "row" }, pw2),
      el("p", { style: "margin-top:6px" }, "Autoriser :"),
      el("label", { class: "row" }, cPrint, "l'impression"), el("label", { class: "row" }, cCopy, "la copie du texte"), el("label", { class: "row" }, cMod, "la modification"),
      ownerRow, err,
      el("p", { style: "font-size:12px" }, "⚠️ Sans le mot de passe, le document ne pourra plus être ouvert : conservez-le bien."),
      el("div", { class: "row end" }, el("button", { class: "btn", onclick: () => close(null) }, "Annuler"), el("button", { class: "btn accent", onclick: ok }, "Protéger et enregistrer")));
    setTimeout(() => pw.focus(), 30);
  });
  if (!r) return;
  const prev = t.protect;
  t.protect = r; markDirty(t);
  if (!(await saveTab(t))) { t.protect = prev; renderTabs(); return; }
  toast("🔒 Document protégé par mot de passe.");
}

export async function unprotect() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  if (!t.protect) return toast("Ce document n'est pas protégé par mot de passe.");
  const ok = await confirmBox("Retirer le mot de passe", `« ${t.name} » pourra être ouvert sans mot de passe.`, "Retirer et enregistrer");
  if (!ok) return;
  const prev = t.protect;
  t.protect = null; markDirty(t);
  if (await saveTab(t)) toast("🔓 Mot de passe retiré.");
  else { t.protect = prev; renderTabs(); }
}
