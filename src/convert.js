// Conversions (Office, images, PNG, texte, Word) et capture d'écran.
import { PDFDocument, degrees } from "pdf-lib";
import { toast, el, askText, confirmBox, busy, modal } from "./ui.js";
import * as io from "./io.js";
import { captureEditor } from "./capture.js";
import { pdfjsLib } from "./pdfsetup.js";
import { ensureTool } from "./app.js";
import { $, appWindow, tab } from "./core.js";
import { placeImageDataUrl } from "./editor.js";
import { addImagePage, restructure } from "./pages.js";
import { buildFinal } from "./save.js";
import { markDirty, openPdfBytes } from "./tabs.js";

// ======================================================================= Conversions

export async function convertOffice(paths) {
  if (!(await ensureTool("libreoffice"))) return;
  paths = io.toArray(paths ?? (await io.pickOffice()));
  for (const p of paths) {
    try {
      const out = await busy(`Conversion de ${io.baseName(p)}…`, () => io.officeConvert(p, "pdf"));
      let bytes;
      try { bytes = await io.readFile(out); } finally { io.removeTemp(out); } // copie temporaire effacée
      const t = await openPdfBytes(bytes, io.stem(p) + ".pdf", null);
      markDirty(t); // pas encore enregistré à côté du fichier d'origine
      t.suggestDir = io.dirName(p);
    } catch (e) { toast(String(e), true); }
  }
}

export async function imagesToPdf(paths) {
  paths = io.toArray(paths ?? (await io.pickImages(true)));
  if (!paths.length) return;
  const pdf = await PDFDocument.create();
  for (const p of paths) await addImagePage(pdf, await io.readFile(p), io.ext(p) === "png");
  const t = await openPdfBytes(await pdf.save(), io.stem(paths[0]) + ".pdf", null);
  markDirty(t);
}

export async function pdfToPng() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  const dir = await io.pickFolder(); if (!dir) return;
  await busy("Export des images…", async () => {
    const doc = await pdfjsLib.getDocument({ data: await buildFinal(t), cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 2 }); // ~144 dpi
      const c = el("canvas", { width: vp.width, height: vp.height });
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const sep = dir.includes("\\") ? "\\" : "/";
      const dest = await io.uniquePath(`${dir}${sep}${io.stem(t.name)}-page-${String(i).padStart(2, "0")}.png`); // jamais d'écrasement
      await io.writeFile(dest, new Uint8Array(await blob.arrayBuffer()));
    }
    doc.destroy();
  });
  toast(`${t.viewer.pagesCount} image(s) enregistrée(s) dans ${dir}`);
}

export async function pdfToText() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  const path = await io.savePath(io.stem(t.name) + ".txt", "Texte", ["txt"]); if (!path) return;
  let out = "";
  for (let i = 1; i <= t.pdfDoc.numPages; i++) {
    const tc = await (await t.pdfDoc.getPage(i)).getTextContent();
    let line = "", lastY = null;
    for (const it of tc.items) {
      const y = it.transform?.[5];
      if (lastY != null && Math.abs(y - lastY) > 2) { out += line.trimEnd() + "\n"; line = ""; }
      line += it.str + (it.hasEOL ? "\n" : "");
      lastY = y;
    }
    out += line.trimEnd() + `\n\n--- page ${i} ---\n\n`;
  }
  await io.writeFile(path, new TextEncoder().encode(out));
  if (!out.replace(/--- page \d+ ---|\s/g, "")) toast("Aucun texte trouvé : ce PDF est probablement scanné (l'OCR arrive dans la version 2).", true);
  else toast("Texte exporté : " + io.baseName(path));
}

export async function pdfToDocx() {
  const t = tab(); if (!t) return toast("Ouvrez d'abord un PDF.", true);
  if (!t.path || t.dirty) return toast("Enregistrez d'abord le PDF, puis relancez la conversion.", true);
  if (t.protect) return toast("Ce PDF est protégé par mot de passe : LibreOffice ne peut pas l'ouvrir. Retirez d'abord la protection (Signer & masquer), puis relancez.", true);
  if (!(await ensureTool("libreoffice"))) return;
  try {
    const out = await busy("Conversion vers Word…", () => io.officeConvert(t.path, "docx:MS Word 2007 XML", "writer_pdf_import"));
    try {
      const dest = await io.savePath(io.stem(t.name) + ".docx", "Word", ["docx"]); if (!dest) return;
      await io.writeFile(dest, await io.readFile(out));
    } finally { io.removeTemp(out); } // copie temporaire effacée, même si l'enregistrement est annulé
    toast("Document Word créé. La mise en page peut différer légèrement de l'original.");
  } catch (e) { toast(String(e), true); }
}

// ======================================================================= Capture

export async function doCapture() {
  // La fenêtre est masquée puis réaffichée côté Rust (capture_screen) : plus besoin
  // des permissions minimize/unminimize, et la fenêtre revient même en cas d'erreur.
  let path;
  try {
    path = await io.captureScreen();
  } catch (e) {
    if (!String(e).includes("annulée")) toast(String(e), true);
    return;
  }
  const res = await captureEditor(await io.readFile(path), !!tab());
  if (!res) return;
  if (res.action === "save") {
    const d = new Date();
    const name = `Capture ${d.toLocaleDateString("fr-FR").replaceAll("/", "-")} ${d.toTimeString().slice(0, 8).replaceAll(":", "h")}.png`;
    const p = await io.savePath(name, "Image PNG", ["png"]); if (!p) return;
    await io.writeFile(p, res.png); toast("Capture enregistrée.");
  } else if (res.action === "place") {
    placeImageDataUrl(res.dataUrl, res.w, res.h);
  } else if (res.action === "page") {
    const t = tab();
    if (!t) {
      const pdf = await PDFDocument.create();
      await addImagePage(pdf, res.png, true);
      markDirty(await openPdfBytes(await pdf.save(), "Capture.pdf", null));
    } else {
      const at = t.viewer.currentPageNumber; // juste après la page affichée
      await restructure(t, (pdf) => addImagePage(pdf, res.png, true, at),
        (an) => an.map((a) => (a.page >= at ? { ...a, page: a.page + 1 } : a)));
      t.viewer.currentPageNumber = at + 1;
      toast(`Capture ajoutée en page ${at + 1}.`);
    }
  }
}
