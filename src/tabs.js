// Onglets et chargement des documents.
import { toast, el, askText, confirmBox, busy, modal } from "./ui.js";
import { invoke } from "@tauri-apps/api/core";
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
  // Liens internet du PDF : ouverts dans le navigateur après confirmation (adresse affichée)
  container.addEventListener("click", async (e) => {
    const a = e.target.closest?.(".annotationLayer a[href]");
    const href = a?.getAttribute("href") || "";
    if (!/^(https?:|mailto:)/i.test(href)) return; // liens internes (vers une page) : gérés par pdf.js
    e.preventDefault(); e.stopPropagation();
    if (await confirmBox("Ouvrir le lien ?", `Ce PDF contient un lien vers :\n${href}`, "Ouvrir", "Annuler"))
      invoke("open_external", { url: href }).catch((err) => toast(String(err), true));
  }, true);

  state.tabs.push(t);
  activate(t.id);
  return t;
}

export function activate(id) {
  state.active = id;
  for (const t of state.tabs) t.container.classList.toggle("hidden", t.id !== id);
  const home = !state.tabs.some((t) => t.id === id);
  $("#empty").classList.toggle("hidden", !home);
  document.body.classList.toggle("at-home", home);
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
  // WebKit ne rend la mémoire des images (canevas) qu'au passage de son ramasse-miettes, parfois
  // très tard : on les vide explicitement avant de retirer l'onglet (mesuré : ~750 Mo par cycle sinon).
  const shrink = (root) => root?.querySelectorAll("canvas").forEach((c) => { c.width = 0; c.height = 0; });
  shrink(t.container);
  if (state.active === t.id) shrink($("#thumbs"));
  t.container.remove();
  // Libération complète : visionneuse, document pdf.js, octets et historique d'annulation
  try { t.viewer?.setDocument(null); t.linkService?.setDocument(null); } catch { /* déjà libéré */ }
  t.pdfDoc?.destroy();
  t.pdfDoc = null; t.bytes = null; t.undo = []; t.redo = []; t.annots = [];
  state.tabs = state.tabs.filter((x) => x !== t);
  if (!state.tabs.length) (await import("./pages.js")).releaseThumbs();
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
    data: bytes, cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/",
  }).promise;
  t.pdfDoc = doc;
  t.linkService.setDocument(doc);
  t.viewer.setDocument(doc);
  old?.destroy();
  if (t.id === state.active) { renderThumbs(); updatePageInfo(); }
}

/** Vrai si le fichier contient un dictionnaire de chiffrement (/Encrypt). Vérifié ensuite par qpdf. */
function looksEncrypted(bytes) {
  const pat = [47, 69, 110, 99, 114, 121, 112, 116]; // "/Encrypt"
  outer: for (let i = bytes.indexOf(47); i !== -1 && i < bytes.length - 8; i = bytes.indexOf(47, i + 1)) {
    for (let k = 1; k < 8; k++) if (bytes[i + k] !== pat[k]) continue outer;
    return true;
  }
  return false;
}

export async function openPdfBytes(bytes, name, path = null) {
  const t = createTab(name, path);
  try {
    await loadBytes(t, bytes);
    // PDF chiffré sans mot de passe d'ouverture (restrictions seules) : il s'affiche, mais l'enregistrer
    // tel quel produirait un fichier illisible. On le déchiffre et on garde ses restrictions.
    if (path && looksEncrypted(bytes)) await unlockRestricted(t, path);
  } catch (e) {
    if (e?.name === "PasswordException" && path && (await unlockInto(t, path))) return t;
    t.container.remove(); state.tabs = state.tabs.filter((x) => x !== t); activate(state.tabs.at(-1)?.id ?? null);
    if (e?.name === "InvalidPDFException")
      toast("Ce fichier PDF est abîmé ou incomplet (téléchargement interrompu ?) : il ne peut pas être ouvert. Le fichier n'a pas été modifié.", true);
    else if (e?.name !== "PasswordException") toast("Impossible d'ouvrir ce PDF : " + (e?.message || e), true);
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
      let bytes;
      try { bytes = await io.readFile(tmp); } finally { io.removeTemp(tmp); } // copie déchiffrée toujours effacée
      await loadBytes(t, bytes);
      // Le fichier reste protégé à l'enregistrement, avec ses droits d'origine
      t.protect = await keepRights(path, pw);
      renderTabs();
      return true;
    } catch (e) {
      if (String(e).includes("MOT_DE_PASSE_INVALIDE")) text = "Mot de passe incorrect. Réessayez :";
      else { toast(String(e), true); return false; }
    }
  }
}

/** PDF chiffré sans mot de passe d'ouverture : déchiffré pour l'édition, droits conservés à l'enregistrement. */
async function unlockRestricted(t, path) {
  let info;
  try { info = await io.pdfEncryptionInfo(path, ""); } catch { info = null; }
  if (info && !info.encrypted) return;
  if (!(await ensureTool("qpdf"))) {
    t.encryptedNoTool = true;
    toast("Ce PDF est chiffré (restrictions d'usage). Vous pouvez le lire, mais pas l'enregistrer tant que qpdf n'est pas installé.", true);
    return;
  }
  const tmp = await io.pdfDecrypt(path, "");
  let bytes;
  try { bytes = await io.readFile(tmp); } finally { io.removeTemp(tmp); }
  await loadBytes(t, bytes);
  t.protect = await keepRights(path, "");
  renderTabs();
}

/**
 * Droits à réappliquer à l'enregistrement d'un PDF protégé (impression, copie, modification).
 * Le mot de passe propriétaire d'origine est demandé pour conserver les restrictions ; à défaut,
 * un mot de passe propriétaire aléatoire les maintient.
 */
async function keepRights(path, pw) {
  const all = { user: pw, owner: pw, print: true, copy: true, modify: true };
  let info;
  try { info = await io.pdfEncryptionInfo(path, pw); } catch { return all; }
  const rights = { print: !!info.print, copy: !!info.copy, modify: !!info.modify };
  if (info.ownerSupplied) {
    // Ouvert avec le mot de passe propriétaire : le mot de passe d'ouverture n'est pas récupérable (AES-256)
    const user = await askText("🔒 Mot de passe d'ouverture", "", { password: true,
      text: "Vous avez ouvert ce PDF avec son mot de passe propriétaire. Quel mot de passe faudra-t-il pour l'ouvrir après enregistrement ? Laissez vide pour garder le même." });
    return { user: user || pw, owner: pw, ...rights };
  }
  if (rights.print && rights.copy && rights.modify) return { ...all, ...rights };
  let text = "Ce PDF limite l'impression, la copie ou la modification. Pour conserver ces limites à l'enregistrement avec leur mot de passe d'origine, indiquez le mot de passe propriétaire. Laissez vide : les limites seront conservées avec un nouveau mot de passe propriétaire aléatoire.";
  for (;;) {
    const owner = await askText("🔒 Mot de passe propriétaire", "", { password: true, text });
    if (!owner) {
      const rnd = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
      toast("Les limites d'usage du PDF seront conservées à l'enregistrement.");
      return { user: pw, owner: rnd, ...rights };
    }
    try {
      const o = await io.pdfEncryptionInfo(path, owner);
      if (o.ownerSupplied) return { user: pw, owner, ...rights };
    } catch { /* mot de passe faux */ }
    text = "Ce n'est pas le mot de passe propriétaire de ce PDF. Réessayez, ou laissez vide :";
  }
}

/**
 * Limites mesurées sur l'appli compilée (Linux, 08/11/2026) — PDF de 241 Mo : 1,3 Go ouvert,
 * 2,1 Go au pic d'une rotation, 2,5 Go au pic d'enregistrement ; 1 000 pages (1 Mo) : 0,8 Go.
 * Au-delà de 1 Go de fichier, l'ouverture est refusée (risque de manque de mémoire).
 */
const PDF_WARN_MB = 150, PDF_MAX_MB = 1024;
async function sizeAllowed(path) {
  let mb = 0;
  try { mb = (await io.fileSize(path)) / 1048576; } catch { return true; } // taille inconnue : on laisse l'ouverture répondre
  if (mb > PDF_MAX_MB) {
    toast(`« ${io.baseName(path)} » pèse ${Math.round(mb)} Mo : c'est trop pour être ouvert sans risque. Divisez-le d'abord avec un autre outil, ou réduisez la taille de ses images.`, true);
    return false;
  }
  if (mb > PDF_WARN_MB)
    toast(`« ${io.baseName(path)} » est très volumineux (${Math.round(mb)} Mo). La lecture fonctionne ; modifier ou enregistrer peut demander jusqu'à environ 10 fois sa taille en mémoire : fermez les autres documents.`);
  return true;
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
    try {
      if (!(await sizeAllowed(p))) continue;
      await openPdfBytes(await io.readFile(p), io.baseName(p), p);
    } catch (e) { toast(String(e), true); }
  }
  if (office.length) await convertOffice(office);
  if (images.length) await imagesToPdf(images);
}
