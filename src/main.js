// Point d'entrée : actions, raccourcis clavier, événements globaux et démarrage.
import "./pdfsetup.js";
import "pdfjs-dist/web/pdf_viewer.css";
import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { message, open } from "@tauri-apps/plugin-dialog";
import * as db from "./store.js";
import { toast, el, askText, confirmBox, busy, modal } from "./ui.js";
import * as io from "./io.js";
import { createIcons, Image as ImageIcon, FolderOpen, Scissors, Signature, Package, Send, Pin, SunMoon, Info, Save, Printer, Ellipsis, Undo2, Redo2, MousePointer2, Highlighter, Type, Stamp, Underline, Strikethrough, SquareDashed, MessageSquare, Pencil, Lasso, Square, Circle, MoveUpRight, Minus, Trash, PenLine, ImagePlus, EyeOff, Search, Lock, LockOpen, FilePlus, FileImage, FileOutput, Combine, Split, FileText, FileDown, ZoomIn, ZoomOut, Droplet, House, ShieldCheck, Files, Wrench, PaintBucket, FileInput, Images, LetterText, FileType, LayoutGrid } from "lucide";
const ICONS = { Image: ImageIcon, FolderOpen, Scissors, Signature, Package, Send, Pin, SunMoon, Info, Save, Printer, Ellipsis, Undo2, Redo2, MousePointer2, Highlighter, Type, Stamp, Underline, Strikethrough, SquareDashed, MessageSquare, Pencil, Lasso, Square, Circle, MoveUpRight, Minus, Trash, PenLine, ImagePlus, EyeOff, Search, Lock, LockOpen, FilePlus, FileImage, FileOutput, Combine, Split, FileText, FileDown, ZoomIn, ZoomOut, Droplet, House, ShieldCheck, Files, Wrench, PaintBucket, FileInput, Images, LetterText, FileType, LayoutGrid };
import { initTooltips } from "./tooltip.js";
import { about, applyTheme, exportData, firstRunWelcome, importData, initTheme, pinApp, setDefault, initSaveStatus } from "./app.js";
import { convertOffice, doCapture, imagesToPdf, pdfToDocx, pdfToPng, pdfToText } from "./convert.js";
import { $, $$, appWindow, state, tab } from "./core.js";
import { blobToDataUrl, deleteSelected, doInsertImage, doSignature, doStamp, loadImg, placeImageDataUrl, pushUndo, refreshAll, setTool, undoRedo } from "./editor.js";
import { extractPages, insertImagePage, insertPdf, mergePdfs, splitPdf, zoom } from "./pages.js";
import { printDoc, saveTab, sendDoc } from "./save.js";
import { doBatch, doParaphe, doSearchRedact, doWatermark, protectDialog, unprotect } from "./secure.js";
import { activate, closeTab, openPaths } from "./tabs.js";
import { autoCheck, checkNow } from "./update.js";

const ACTIONS = {
  open: async () => openPaths(io.toArray(await io.pickPdf(true))),
  save: () => saveTab(),
  saveas: () => saveTab(tab(), true),
  office2pdf: () => convertOffice(),
  img2pdf: () => imagesToPdf(),
  print: printDoc, send: sendDoc,
  "export-data": exportData, "import-data": importData,
  pin: () => pinApp(), paraphe: doParaphe, watermark: doWatermark, "search-redact": doSearchRedact, batch: doBatch,
  merge: mergePdfs, split: splitPdf, protect: protectDialog, unprotect,
  pdf2png: pdfToPng, pdf2txt: pdfToText, pdf2docx: pdfToDocx,
  capture: doCapture,
  signature: doSignature, stamp: doStamp, "insert-image": doInsertImage,
  undo: () => undoRedo(false), redo: () => undoRedo(true), delete: deleteSelected,
  "zoom-in": () => zoom(1), "zoom-out": () => zoom(-1),
  "insert-pdf": insertPdf, "insert-image-page": insertImagePage, extract: extractPages,
  theme: () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
  "default-pdf": setDefault, about, updates: checkNow,
};

document.addEventListener("click", (e) => {
  const menuBtn = e.target.closest("[data-menu]");
  $$(".menu-pop").forEach((p) => { if (!menuBtn || p.id !== "menu-" + menuBtn.dataset.menu) p.classList.remove("open"); });
  if (menuBtn) return $("#menu-" + menuBtn.dataset.menu).classList.toggle("open");
  const act = e.target.closest("[data-act]");
  if (act && ACTIONS[act.dataset.act]) {
    Promise.resolve(ACTIONS[act.dataset.act]()).catch((err) => toast(String(err?.message || err), true));
    return;
  }
  const rib = e.target.closest("[data-rib]");
  if (rib) {
    $$("[data-rib]").forEach((b) => b.classList.toggle("on", b === rib));
    $$(".rib-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== rib.dataset.rib));
    return;
  }
  const tl = e.target.closest("[data-tool]");
  if (tl) setTool(tl.dataset.tool);
  const side = e.target.closest("[data-side]");
  if (side) {
    $$("[data-side]").forEach((b) => b.classList.toggle("on", b === side));
    $("#side-pages").classList.toggle("hidden", side.dataset.side !== "pages");
    $("#side-annots").classList.toggle("hidden", side.dataset.side !== "annots");
  }
});

// Palette des surligneurs : change la couleur des prochains surlignages et du surlignage sélectionné
$("#hlcolors").addEventListener("click", (e) => {
  const b = e.target.closest("[data-hl]"); if (!b) return;
  state.hlColor = b.dataset.hl;
  $$("#hlcolors [data-hl]").forEach((x) => x.classList.toggle("on", x === b));
  const t = tab(); const a = t?.annots.find((x) => x.id === t.selected);
  if (a && ["highlight", "hlarea"].includes(a.type)) { pushUndo(t); a.color = state.hlColor; refreshAll(t); }
  else if (!["highlight", "hlarea"].includes(state.tool)) setTool("hlarea");
});
$("#redactmode").addEventListener("change", () => {
  const t = tab(); const a = t?.annots.find((x) => x.id === t.selected);
  if (a?.type === "redact") { pushUndo(t); a.mode = $("#redactmode").value; refreshAll(t); }
});
$("#lassofill").addEventListener("change", () => {
  const t = tab(); const a = t?.annots.find((x) => x.id === t.selected);
  if (a?.closed) { pushUndo(t); a.fill = $("#lassofill").checked; refreshAll(t); }
});

$("#zoom").addEventListener("change", (e) => { const t = tab(); if (t) t.viewer.currentScaleValue = e.target.value; });
// Changer la couleur / l'épaisseur modifie aussi l'annotation sélectionnée
for (const id of ["color", "width", "fontsize"]) {
  $("#" + id).addEventListener("change", () => {
    const t = tab(); const a = t?.annots.find((x) => x.id === t.selected);
    if (!a) return;
    pushUndo(t);
    if (id === "color" && !["signature", "image"].includes(a.type)) a.color = $("#color").value;
    if (id === "width" && "width" in a) a.width = +$("#width").value;
    if (id === "fontsize" && a.type === "text") a.size = +$("#fontsize").value;
    refreshAll(t);
  });
}

document.addEventListener("keydown", (e) => {
  const typing = e.target.matches("input, textarea, select, [contenteditable]");
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === "o") { e.preventDefault(); ACTIONS.open(); }
    else if (k === "s" && e.shiftKey) { e.preventDefault(); ACTIONS.saveas(); }
    else if (k === "s") { e.preventDefault(); ACTIONS.save(); }
    else if (k === "p") { e.preventDefault(); printDoc(); }
    else if (k === "x" && e.shiftKey) { e.preventDefault(); doCapture(); }
    else if (k === "w") { e.preventDefault(); const t = tab(); if (t) closeTab(t); }
    else if (k === "z" && !typing) { e.preventDefault(); undoRedo(e.shiftKey); }
    else if (k === "y" && !typing) { e.preventDefault(); undoRedo(true); }
    else if ((k === "=" || k === "+") && !typing) { e.preventDefault(); zoom(1); }
    else if (k === "-" && !typing) { e.preventDefault(); zoom(-1); }
    else if (k === "tab") { e.preventDefault(); const i = state.tabs.findIndex((t) => t.id === state.active); const n = state.tabs[(i + 1) % state.tabs.length]; if (n) activate(n.id); }
    return;
  }
  if (typing) return;
  if (e.key === "Escape") { setTool("select"); const t = tab(); if (t) { t.selected = null; refreshAll(t); } }
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else {
    const map = { v: "select", h: "highlight", u: "underline", k: "strike", t: "text", n: "note", p: "ink", o: "lasso", m: "redact", r: "rect", e: "ellipse", a: "arrow", l: "line" };
    if (map[k]) setTool(map[k]);
  }
});

// Ctrl+V dans le document : placer l'image copiée (capture, logo, signature…)
document.addEventListener("paste", async (e) => {
  if (document.querySelector(".modal-bg") || e.target.matches("input, textarea")) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item || !tab()) return;
  e.preventDefault();
  const src = await blobToDataUrl(item.getAsFile());
  const im = await loadImg(src);
  placeImageDataUrl(src, im.naturalWidth, im.naturalHeight);
});

// Molette + Ctrl = zoom
document.addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !e.target.closest(".doc-container")) return;
  e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

// Glisser-déposer de fichiers depuis le bureau
getCurrentWebview().onDragDropEvent((ev) => {
  const p = ev.payload;
  $("#docs").classList.toggle("dragover", p.type === "over" || p.type === "enter");
  if (p.type === "drop") { $("#docs").classList.remove("dragover"); openPaths(p.paths); }
  if (p.type === "leave") $("#docs").classList.remove("dragover");
});

// Fermeture de la fenêtre : prévenir si des documents ne sont pas enregistrés
appWindow.onCloseRequested(async (ev) => {
  const dirty = state.tabs.filter((t) => t.dirty);
  if (db.hasUnsavedChanges()) {
    ev.preventDefault();
    await db.retry();
    if (db.hasUnsavedChanges()) {
      const r = await confirmBox("Réglages non enregistrés",
        "Vos dernières signatures / réglages n'ont pas pu être enregistrés et seront perdus si vous quittez. Utilisez « Sauvegarder ailleurs » via le bandeau rouge en bas pour les conserver.",
        "Quitter quand même", "Rester");
      if (r !== true) return;
    }
    if (!dirty.length) return appWindow.destroy();
  }
  if (!dirty.length) return;
  ev.preventDefault();
  const r = await confirmBox("Quitter SXM PDF", `${dirty.length} document(s) contiennent des modifications non enregistrées.`, "Quitter sans enregistrer", "Annuler");
  if (r === true) { state.tabs.forEach((t) => (t.dirty = false)); appWindow.destroy(); }
});

// Arguments au lancement : fichiers à ouvrir ou --capture (raccourci GNOME)
async function handleArgs(args) {
  const files = args.filter((a) => !a.startsWith("-"));
  if (files.length) await openPaths(files);
  if (args.includes("--capture")) doCapture();
}
listen("sxm-args", (e) => handleArgs(e.payload));

await db.initStore();
initSaveStatus();
createIcons({ icons: ICONS, attrs: { "stroke-width": 1.8 } });
initTooltips();
initTheme();
firstRunWelcome();
autoCheck();
setTool("select");
activate(null);
io.startupArgs().then(handleArgs).catch(() => {});
window.__sxm = { message };
