// Application : épinglage, outils externes, sauvegarde des données, thème, à propos.
import { message, open } from "@tauri-apps/plugin-dialog";
import * as db from "./store.js";
import { toast, el, askText, confirmBox, busy, modal } from "./ui.js";
import * as io from "./io.js";
import { invoke } from "@tauri-apps/api/core";
import { $ } from "./core.js";

// ======================================================================= Épingler l'application

export const isMac = navigator.userAgent.includes("Mac");
export const isWin = navigator.userAgent.includes("Windows");
export const PIN_PLACE = isMac ? "le Dock" : isWin ? "la barre des tâches" : "la barre des favoris";

export function windowsPinHelp() {
  return modal((m, close) => m.append(
    el("h2", {}, "📌 Épingler à la barre des tâches"),
    el("p", {}, "Windows ne permet pas aux applications de s'épingler toutes seules. Ça se fait en 2 secondes :"),
    el("p", { style: "color:var(--text)" }, "1. Regardez en bas de l'écran : l'icône de SXM PDF est dans la barre des tâches pendant qu'il est ouvert."),
    el("p", { style: "color:var(--text)" }, "2. Faites un clic droit dessus, puis « Épingler à la barre des tâches »."),
    el("p", {}, "Un raccourci SXM PDF a aussi été placé sur le Bureau et dans le menu Démarrer."),
    el("div", { class: "row end" }, el("button", { class: "btn accent", onclick: () => close() }, "Compris"))));
}

export async function pinApp(silentIfDone = false) {
  try {
    const r = await invoke("pin_app");
    if (r === "windows") return windowsPinHelp();
    if (r === "deja") { if (!silentIfDone) toast(`SXM PDF est déjà dans ${PIN_PLACE}.`); return; }
    toast(`📌 SXM PDF est maintenant dans ${PIN_PLACE}.`);
  } catch (e) { toast(String(e), true); }
}

/** Accueil au premier lancement : proposer d'épingler l'app pour la retrouver facilement. */
export function firstRunWelcome() {
  if (db.get("sxm.welcomed")) return;
  db.set("sxm.welcomed", "1");
  setTimeout(() => modal((m, close) => m.append(
    el("img", { src: "/logo.png", style: "width:64px;align-self:center" }),
    el("h2", { style: "text-align:center" }, "Bienvenue dans SXM PDF !"),
    el("p", { style: "text-align:center" }, `Pour retrouver l'application facilement, ajoutez-la à ${PIN_PLACE}.`),
    el("div", { class: "row end" },
      el("button", { class: "btn", onclick: () => close() }, "Plus tard"),
      el("button", { class: "btn accent", onclick: () => { close(); pinApp(); } }, `📌 Ajouter à ${PIN_PLACE}`)),
    el("p", { style: "font-size:12px;text-align:center" }, "Vous pourrez le faire plus tard depuis le menu ⋯"))), 700);
}

// ======================================================================= Divers

export function applyTheme(th) {
  document.documentElement.dataset.theme = th;
  db.set("sxm.theme", th);
}
export function initTheme() {
  const th = db.get("sxm.theme", null);
  applyTheme(th || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
}

// ---- Outils externes facultatifs (LibreOffice, qpdf)
export const TOOL_INFO = {
  libreoffice: {
    label: "LibreOffice", why: "les conversions Word / Excel / PowerPoint",
    fedora: "sudo dnf install libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-pdfimport",
    debian: "sudo apt install libreoffice-writer libreoffice-calc libreoffice-impress",
    mac: "brew install --cask libreoffice",
    windows: "winget install --id TheDocumentFoundation.LibreOffice -e",
  },
  qpdf: {
    label: "qpdf", why: "les mots de passe (protéger, ouvrir ou retirer)",
    fedora: "sudo dnf install qpdf", debian: "sudo apt install qpdf", mac: "brew install qpdf",
    windows: "winget install --id QPDF.QPDF -e",
  },
};
export let toolCache = null;

/** Vérifie qu'un outil est présent ; sinon explique comment l'installer. Renvoie true s'il est disponible. */
export async function ensureTool(name) {
  try { toolCache = await invoke("check_tools"); } catch { return true; } // en cas de doute, on laisse la commande répondre
  if (toolCache[name]) return true;
  const info = TOOL_INFO[name];
  const isMacOS = navigator.userAgent.includes("Mac");
  const isWindows = navigator.userAgent.includes("Windows");
  const cmds = isWindows
    ? [["Windows (Invite de commandes ou PowerShell)", info.windows]]
    : isMacOS ? [["macOS (Homebrew)", info.mac]] : [["Fedora", info.fedora], ["Ubuntu / Debian", info.debian]];
  await modal((m, close) => m.append(
    el("h2", {}, `${info.label} est nécessaire`),
    el("p", {}, `SXM PDF utilise ${info.label} pour ${info.why}. Il n'est pas installé sur cet ordinateur. Le reste de l'application fonctionne normalement.`),
    ...cmds.map(([os, cmd]) => el("div", { style: "display:flex;flex-direction:column;gap:4px" },
      el("b", {}, os),
      el("div", { class: "row" },
        el("code", { style: "flex:1;padding:8px 10px;border-radius:8px;background:var(--panel2);border:1px solid var(--border);user-select:text;font-size:12px" }, cmd),
        el("button", { class: "btn", onclick: async () => { try { await navigator.clipboard.writeText(cmd); toast("Commande copiée."); } catch { toast("Sélectionnez la commande et copiez-la (Ctrl+C).", true); } } }, "Copier")))),
    el("p", { style: "font-size:12px" }, isWindows
      ? "Ouvrez « Invite de commandes » depuis le menu Démarrer, collez la commande, validez, puis relancez l'action. Vous pouvez aussi réinstaller SXM PDF, qui inclut normalement cet outil."
      : "Collez la commande dans un terminal, puis relancez l'action. Inutile de redémarrer SXM PDF."),
    el("div", { class: "row end" }, el("button", { class: "btn accent", onclick: () => close() }, "Compris"))));
  return false;
}

export async function exportData() {
  const p = await io.savePath(`SXM PDF - sauvegarde ${new Date().toLocaleDateString("fr-FR").replaceAll("/", "-")}.json`, "Sauvegarde SXM PDF", ["json"]);
  if (!p) return;
  await io.writeFile(p, new TextEncoder().encode(db.exportJson()));
  toast("Sauvegarde créée : signatures, tampons, initiales, profils et modèles.\nGardez ce fichier en lieu sûr : il contient vos signatures.");
}

export async function importData() {
  const p = await open({ multiple: false, filters: [{ name: "Sauvegarde SXM PDF", extensions: ["json"] }] });
  if (!p) return;
  const merge = await confirmBox("Importer une sauvegarde",
    "Ajouter le contenu de la sauvegarde à vos éléments actuels, ou tout remplacer ?", "Ajouter", "Annuler", "Tout remplacer");
  if (merge === false || merge === null) return;
  if (merge === "third" && !(await confirmBox("Tout remplacer",
    "Vos signatures, tampons, initiales, profils de lot et modèles de filigrane actuels seront supprimés et remplacés par ceux de la sauvegarde. Conseil : faites d'abord une sauvegarde de l'état actuel.",
    "Tout remplacer"))) return;
  try {
    const n = await db.importJson(new TextDecoder().decode(await io.readFile(p)), merge === true);
    toast(`Sauvegarde importée : ${n} élément(s).`);
  } catch (e) { toast(String(e?.message || e), true); }
}

export async function setDefault() {
  try { await io.setDefaultPdf(); toast("SXM PDF ouvre maintenant les fichiers PDF par défaut."); }
  catch (e) { toast(String(e), true); }
}

export function about() {
  modal((m, close) => m.append(
    el("h2", {}, "SXM PDF 1.0"),
    el("p", {}, "Lire, annoter, signer, convertir et capturer."),
    el("p", {}, "© 2026 Invisible_Dawn."),
    el("p", {}, "Composants libres : PDF.js et pdf-lib (Apache 2.0 / MIT), Tauri (MIT/Apache 2.0). Les conversions Office utilisent LibreOffice, distribué sous licence MPL 2.0 (www.libreoffice.org). Le chiffrement utilise qpdf (Apache 2.0). Police des filigranes : DejaVu Sans 2.37 (licences Bitstream Vera et Arev, redistribution autorisée)."),
    el("div", { class: "row end" },
      el("button", { class: "btn", onclick: () => showLicense() }, "Licence de la police DejaVu"),
      el("button", { class: "btn accent", onclick: () => close() }, "Fermer"))));
}

async function showLicense() {
  let text = "";
  try { text = await (await fetch("/licenses/DejaVu-LICENSE.txt")).text(); } catch { text = "Texte de licence introuvable."; }
  modal((m, close) => m.append(
    el("h2", {}, "DejaVu Sans 2.37 — licence"),
    el("pre", { style: "max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:11px;background:var(--panel2);padding:12px;border-radius:8px;user-select:text;margin:0" }, text),
    el("div", { class: "row end" }, el("button", { class: "btn accent", onclick: () => close() }, "Fermer"))));
}

// ======================================================================= État de la sauvegarde des données

/** Affiche en permanence l'état d'enregistrement des signatures / réglages, avec réessai et restauration. */
export function initSaveStatus() {
  const box = $("#status-left");
  let shownError = null;
  let startupNotice = null; // reste affiché jusqu'à ce que l'utilisateur le ferme
  const link = (label, fn) => el("button", { style: "border:0;background:none;color:inherit;text-decoration:underline;cursor:pointer;font:inherit;width:auto;padding:0", onclick: fn }, label);
  const showStartup = () => {
    box.style.cssText = "color:#b45309;display:flex;gap:8px;align-items:center;font-weight:600";
    box.replaceChildren("⚠ Données récupérées au démarrage",
      link("Détails", () => saveErrorDetails(startupNotice)),
      link("OK", () => { startupNotice = null; box.replaceChildren("SXM PDF"); box.removeAttribute("style"); }));
  };
  db.onStatus((st) => {
    if (st.startup) { startupNotice = st; toast(st.error, true); return showStartup(); }
    if (st.ok) {
      if (startupNotice) showStartup();
      else { box.replaceChildren("SXM PDF"); box.removeAttribute("style"); }
      if (shownError) toast(st.restored ? "Copie de secours restaurée." : "Signatures et réglages enregistrés.");
      shownError = null;
      return;
    }
    box.style.cssText = "color:#b91c1c;display:flex;gap:8px;align-items:center;font-weight:600";
    box.replaceChildren(
      "⚠ Signatures et réglages NON enregistrés",
      link("Réessayer", async () => { if (!(await db.retry())) toast("La sauvegarde échoue toujours : " + (shownError || ""), true); }),
      link("Restaurer la copie de secours", restoreBackupUi),
      link("Détails", () => saveErrorDetails(st)));
    if (shownError !== st.error) {
      toast("⚠ Vos dernières modifications (signatures, tampons, profils, modèles) ne sont PAS enregistrées.\n" + st.error, true);
      shownError = st.error;
    }
  });
}

async function restoreBackupUi() {
  const ok = await confirmBox("Restaurer la copie de secours",
    "Vos signatures, tampons, initiales, profils et modèles reviendront à leur état de l'avant-dernière sauvegarde. Les modifications plus récentes seront perdues.",
    "Restaurer");
  if (!ok) return;
  try { await db.restoreFromBackup(); }
  catch (e) { toast("Restauration impossible : " + (e?.message || e), true); }
}

async function saveErrorDetails(st) {
  let path = "";
  try { path = await db.dataPath(); } catch {}
  modal((m, close) => m.append(
    el("h2", {}, st.startup ? "Données récupérées au démarrage" : "Problème d'enregistrement"),
    el("p", {}, st.error),
    el("p", {}, "Causes possibles : disque plein, dossier en lecture seule, fichier verrouillé par un antivirus ou une synchronisation (OneDrive, Dropbox…)."),
    path ? el("p", { style: "user-select:text;font-size:12px" }, "Fichier : " + path) : null,
    el("p", {}, "Tant que le problème persiste, vos documents PDF s'enregistrent normalement : seuls les signatures et réglages de l'application sont concernés. Pensez à « Sauvegarder mes signatures et réglages » (menu ⋯) vers un autre emplacement."),
    el("div", { class: "row end" },
      el("button", { class: "btn", onclick: () => { close(); exportData(); } }, "Sauvegarder ailleurs…"),
      el("button", { class: "btn accent", onclick: () => close() }, "Fermer"))));
}
