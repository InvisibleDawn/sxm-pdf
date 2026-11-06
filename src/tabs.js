// Onglets et chargement des documents.
import { toast, el, askText, confirmBox, busy, modal } from "./ui.js";
import * as io from "./io.js";
import { pdfjsLib } from "./pdfsetup.js";
import { PDFViewer, EventBus, PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";
import { ensureTool } from "./app.js";
import { convertOffice, imagesToPdf } from "./convert.js";
import { $, appWindow, state, tab } from "./core.js";
import { applyToolCursor, renderOverlay } from "./editor.js";
import { highlightThumb, renderAnnotList, renderThumbs, syncZoomSelect, updatePageInfo, zoom } from "./pages.js";
import { saveTab } from "./save.js";

// ======================================================================= Onglets

export let tabSeq = 1;
export function createTab(name, path) {
  const container = el("div", { class: "doc-container", tabindex: "0" });
  const viewerEl = el("div", { class: "pdfViewer" });
  container.append(viewerEl);
  $("#docs").append(container);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const viewer = new PDFViewer({
    container, viewer: viewerEl, eventBus, linkService,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS, textLayerMode: 1,
  });
  linkService.setViewer(viewer);

  const t = {
    id: tabSeq++, name, path, container, viewer, eventBus, linkService,
    pdfDoc: null, bytes: null, annots: [], undo: [], redo: [], dirty: false, selected: null,
    restore: null,
  };

  eventBus.on("pagesinit", () => {
    viewer.currentScaleValue = t.restore?.scale || $("#zoom").value || "page-width";
    if (t.restore?.page) viewer.currentPageNumber = Math.min(t.restore.page, viewer.pagesCount);
    t.restore = null;
    updatePageInfo();
  });
  eventBus.on("pagerendered", (e) => renderOverlay(t, e.pageNumber - 1));
  eventBus.on("pagechanging", () => { updatePageInfo(); highlightThumb(); });
  eventBus.on("scalechanging", () => syncZoomSelect());
  eventBus.on("annotationlayerrendered", () => {});
  // Modification d'un champ de formulaire
  container.addEventListener("input", (e) => { if (e.target.closest(".annotationLayer")) markDirty(t); });

  state.tabs.push(t);
  activate(t.id);
  return t;
}

export function activate(id) {
  state.active = id;
  for (const t of state.tabs) t.container.classList.toggle("hidden", t.id !== id);
  $("#empty").classList.toggle("hidden", state.tabs.length > 0);
  renderTabs(); renderThumbs(); renderAnnotList(); updatePageInfo(); updateTitle(); applyToolCursor();
}

export function renderTabs() {
  $("#tabs").replaceChildren(...state.tabs.map((t) =>
    el("div", { class: "tab" + (t.id === state.active ? " on" : ""), title: t.path || t.name, onclick: () => activate(t.id) },
      el("span", { class: "name" }, (t.dirty ? "● " : "") + (t.protect ? "🔒 " : "") + t.name),
      el("button", { class: "x", title: "Fermer", onclick: (e) => { e.stopPropagation(); closeTab(t); } }, "✕"))));
}

export async function closeTab(t) {
  if (t.dirty) {
    const r = await confirmBox("Modifications non enregistrées", `Enregistrer « ${t.name} » avant de fermer ?`, "Enregistrer", "Annuler", "Ne pas enregistrer");
    if (r === false || r === null) return;
    if (r === true && !(await saveTab(t))) return;
  }
  t.container.remove();
  t.pdfDoc?.destroy();
  state.tabs = state.tabs.filter((x) => x !== t);
  activate(state.tabs.at(-1)?.id ?? null);
}

export function updateTitle() {
  const t = tab();
  appWindow.setTitle(t ? `${t.dirty ? "● " : ""}${t.name} — SXM PDF` : "SXM PDF").catch(() => {});
}

export function markDirty(t) {
  if (!t.dirty) { t.dirty = true; renderTabs(); updateTitle(); }
}

// ======================================================================= Chargement

export async function loadBytes(t, bytes) {
  t.bytes = bytes;
  const old = t.pdfDoc;
  const doc = await pdfjsLib.getDocument({
    data: bytes.slice(), cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/",
  }).promise;
  t.pdfDoc = doc;
  t.linkService.setDocument(doc);
  t.viewer.setDocument(doc);
  old?.destroy();
  if (t.id === state.active) { renderThumbs(); updatePageInfo(); }
}

export async function openPdfBytes(bytes, name, path = null) {
  const t = createTab(name, path);
  try {
    await loadBytes(t, bytes);
  } catch (e) {
    if (e?.name === "PasswordException" && path && (await unlockInto(t, path))) return t;
    t.container.remove(); state.tabs = state.tabs.filter((x) => x !== t); activate(state.tabs.at(-1)?.id ?? null);
    if (e?.name !== "PasswordException") toast("Impossible d'ouvrir ce PDF : " + (e?.message || e), true);
  }
  return t;
}

/** Demande le mot de passe d'un PDF protégé, le déchiffre et le charge dans l'onglet. */
export async function unlockInto(t, path) {
  if (!(await ensureTool("qpdf"))) return false;
  let text = `« ${io.baseName(path)} » est protégé par un mot de passe.`;
  for (;;) {
    const pw = await askText("🔒 Mot de passe requis", "", { password: true, text });
    if (pw == null) return false;
    try {
      const tmp = await busy("Déverrouillage…", () => io.pdfDecrypt(path, pw));
      const bytes = await io.readFile(tmp);
      io.removeTemp(tmp);
      await loadBytes(t, bytes);
      // On garde le mot de passe : le fichier reste protégé à l'enregistrement
      t.protect = { user: pw, owner: pw, print: true, copy: true, modify: true };
      renderTabs();
      return true;
    } catch (e) {
      if (String(e).includes("MOT_DE_PASSE_INVALIDE")) text = "Mot de passe incorrect. Réessayez :";
      else { toast(String(e), true); return false; }
    }
  }
}

export async function openPaths(paths) {
  const pdfs = [], office = [], images = [];
  for (const p of paths) {
    const x = io.ext(p);
    if (x === "pdf") pdfs.push(p);
    else if (io.OFFICE_EXT.includes(x)) office.push(p);
    else if (io.IMAGE_EXT.includes(x)) images.push(p);
  }
  for (const p of pdfs) {
    const existing = state.tabs.find((t) => t.path === p);
    if (existing) { activate(existing.id); continue; }
    try { await openPdfBytes(await io.readFile(p), io.baseName(p), p); } catch (e) { toast(String(e), true); }
  }
  if (office.length) await convertOffice(office);
  if (images.length) await imagesToPdf(images);
}
