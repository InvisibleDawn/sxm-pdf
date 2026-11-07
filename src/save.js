// Enregistrement, caviardage définitif, impression et envoi par mail.
import { PDFDocument, degrees } from "pdf-lib";
import { message, open } from "@tauri-apps/plugin-dialog";
import { toast, el, askText, confirmBox, busy, modal } from "./ui.js";
import * as io from "./io.js";
import { drawOverlay, writeAnnots, shift, norm, newId, viewBox, LABELS, BOXY, pixelate } from "./annots.js";
import { invoke } from "@tauri-apps/api/core";
import { pdfjsLib } from "./pdfsetup.js";
import { $, tab } from "./core.js";
import { renderTabs, updateTitle } from "./tabs.js";
import { purgeUnreachable, removePageClean } from "./pdfclean.js";

// ======================================================================= Enregistrement

/** Octets du PDF courant avec formulaires remplis (sans nos annotations). */
export async function formBytes(t) {
  try { return await t.pdfDoc.saveDocument(); } catch { return t.bytes; }
}

/** PDF final : formulaires + annotations écrites dans le fichier. */
export async function buildFinal(t) {
  if (t.encryptedNoTool) throw new Error("ce PDF est chiffré et qpdf n'est pas installé : impossible de produire une copie lisible.");
  const pdf = await PDFDocument.load(await formBytes(t), { ignoreEncryption: true });
  const vps = new Map();
  await writeAnnots(pdf, t.annots, async (i) => {
    if (!vps.has(i)) vps.set(i, (await t.pdfDoc.getPage(i + 1)).getViewport({ scale: 1 }));
    return vps.get(i);
  });
  await purgeUnreachable(pdf); // pages supprimées auparavant : effacées pour de bon du fichier
  const bytes = await pdf.save();
  const redacts = t.annots.filter((a) => a.type === "redact");
  return redacts.length ? applyRedactions(bytes, redacts) : bytes;
}

/**
 * Caviardage réel : chaque page contenant une zone masquée est transformée en image,
 * la zone y est noircie ou pixellisée, puis l'image remplace la page d'origine.
 * Le texte caché n'existe donc plus dans le fichier (ni copiable, ni cherchable).
 */
export async function applyRedactions(bytes, redacts) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
  const pdf = await PDFDocument.load(bytes);
  const pages = [...new Set(redacts.map((a) => a.page))].sort((x, y) => x - y);
  for (const i of pages) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 2.5 });
    const vp1 = page.getViewport({ scale: 1 });
    const c = el("canvas", { width: Math.round(vp.width), height: Math.round(vp.height) });
    const ctx = c.getContext("2d");
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    for (const a of redacts.filter((r) => r.page === i)) {
      const b = viewBox(vp, a);
      if (a.mode === "black") { ctx.fillStyle = "#000"; ctx.fillRect(b.x, b.y, b.w, b.h); }
      else pixelate(c, b.x, b.y, b.w, b.h, c);
    }
    const jpg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9))).arrayBuffer());
    const img = await pdf.embedJpg(jpg);
    const np = pdf.insertPage(i, [vp1.width, vp1.height]);
    np.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    removePageClean(pdf, i + 1); // page d'origine retirée avec ses champs de formulaire
  }
  doc.destroy();
  await purgeUnreachable(pdf); // le texte masqué n'existe plus nulle part dans le fichier
  return pdf.save();
}

/** Prévient une fois par document que le masquage est définitif. */
export async function confirmRedactions(t) {
  if (!t.annots.some((a) => a.type === "redact") || t.redactOk) return true;
  const ok = await confirmBox("Masquage définitif",
    "Les zones masquées seront effacées pour de bon dans le fichier : les pages concernées deviennent des images et le texte caché ne pourra plus être récupéré. Gardez une copie de l'original si besoin.",
    "Continuer");
  if (ok) t.redactOk = true;
  return !!ok;
}

// ======================================================================= Impression et envoi

export async function printDoc() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  const root = $("#print-root");
  await busy("Préparation de l'impression…", async () => {
    const doc = await pdfjsLib.getDocument({ data: await buildFinal(t), cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
    root.replaceChildren();
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 2.2 });
      const c = el("canvas", { width: Math.round(vp.width), height: Math.round(vp.height) });
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      root.append(el("img", { src: c.toDataURL("image/jpeg", 0.92) }));
    }
    doc.destroy();
    await Promise.all([...root.querySelectorAll("img")].map((im) => im.decode().catch(() => {})));
  });
  if (io.isMac) {
    // WKWebView (macOS) ignore window.print() : on passe par l'impression native de Tauri.
    // La fenêtre d'impression est asynchrone : #print-root reste en place (invisible à l'écran)
    // jusqu'à la prochaine impression, sinon la page imprimée sortirait blanche.
    try { await invoke("print_window"); }
    catch (e) { toast("Impression impossible : " + (e?.message || e), true); }
    return;
  }
  window.print();
  setTimeout(() => root.replaceChildren(), 1500);
}

export async function sendDoc() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  if (!(await confirmRedactions(t))) return;
  try {
    const name = /\.pdf$/i.test(t.name) ? t.name : t.name + ".pdf";
    const tmp = await invoke("temp_path", { name });
    await busy("Préparation du mail…", async () => io.writePdf(tmp, await buildFinal(t), t.protect));
    await invoke("send_mail", { path: tmp, subject: io.stem(name) });
    toast("Nouveau message ouvert avec « " + name + " » en pièce jointe.");
  } catch (e) {
    toast(String(e), true);
  }
}

export async function saveTab(t = tab(), as = false) {
  if (!t) return false;
  if (t.encryptedNoTool) {
    toast("Enregistrement impossible : ce PDF est chiffré et qpdf n'est pas installé. Le fichier d'origine n'a pas été modifié.", true);
    return false;
  }
  let path = t.path;
  if (as || !path) {
    path = await io.savePath(t.path || (io.stem(t.name) + ".pdf"));
    if (!path) return false;
    if (!/\.pdf$/i.test(path)) path += ".pdf";
  }
  try {
    if (!(await confirmRedactions(t))) return false;
    const out = await busy("Enregistrement…", () => buildFinal(t));
    // Écriture sûre ; un PDF protégé n'est jamais écrit en clair à son emplacement final
    await busy(t.protect ? "Chiffrement…" : "Enregistrement…", () => io.writePdf(path, out, t.protect));
    t.path = path; t.name = io.baseName(path); t.dirty = false;
    renderTabs(); updateTitle();
    toast("Enregistré : " + t.name);
    return true;
  } catch (e) {
    toast("Échec de l'enregistrement : " + (e?.message || e), true);
    return false;
  }
}
