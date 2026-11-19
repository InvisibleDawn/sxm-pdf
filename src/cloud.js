// « Ouvrir depuis OneDrive / Proton Drive » : ouvre la fenêtre d'ouverture du système directement dans le
// dossier que l'application OneDrive / Proton Drive synchronise déjà sur l'ordinateur (dernier dossier
// utilisé en priorité). Aucune connexion à un service en ligne : à l'enregistrement, c'est l'application
// de synchronisation qui envoie le fichier dans le cloud.
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import * as db from "./store.js";
import * as io from "./io.js";
import { el, modal } from "./ui.js";
import { openPaths } from "./tabs.js";
import { tr } from "./i18n.js";

export const SERVICES = {
  onedrive: { name: "OneDrive", download: "https://www.microsoft.com/microsoft-365/onedrive/download" },
  proton: { name: "Proton Drive", download: "https://proton.me/drive/download" },
};

let found = { onedrive: [], proton: [] };

const chosen = (s) => db.get(`sxm.cloud.${s}.root`, "");
const exists = (path) => invoke("dir_exists", { path }).catch(() => false);

/** Boutons toujours visibles (choix d'Invisible_Dawn, 19/11) : au clic, le dossier s'ouvre, ou SXM PDF
 *  prévient que l'application n'est pas installée et propose de choisir le dossier. */
export function refresh() {
  document.querySelectorAll("[data-cloud]").forEach((e) => { e.hidden = false; });
}

export async function initCloud() {
  try { found = { ...found, ...(await invoke("cloud_folders")) }; } catch { /* hors application : rien à détecter */ }
  refresh();
}

async function rootOf(s) {
  const c = chosen(s);
  if (c && (await exists(c))) return c;
  return (found[s] || [])[0] || "";
}

/** Ouvre la fenêtre d'ouverture dans le dossier du service, puis les PDF choisis. */
export async function openFrom(s) {
  const root = await rootOf(s);
  if (!root) return notInstalled(s);
  const last = db.get(`sxm.cloud.${s}.last`, "");
  const start = last && last.startsWith(root) && (await exists(last)) ? last : root;
  const picked = io.toArray(await open({ multiple: true, defaultPath: start, filters: [{ name: "PDF", extensions: ["pdf"] }] }));
  if (!picked.length) return;
  db.set(`sxm.cloud.${s}.last`, io.dirName(picked[0]));
  return openPaths(picked);
}

/** Service introuvable : télécharger l'application, ou choisir le dossier synchronisé une fois pour toutes. */
function notInstalled(s) {
  const { name, download } = SERVICES[s];
  return modal((m, close) => m.append(
    el("h2", {}, `${name} n'est pas installé`),
    el("p", {}, `Pour ouvrir vos fichiers ${name} ici, installez l'application ${name} sur cet ordinateur : elle synchronise un dossier que SXM PDF ouvrira directement.`),
    el("p", {}, "Déjà installée, ou dossier synchronisé autrement ? Choisissez-le une fois pour toutes."),
    el("div", { class: "row end" },
      el("button", { class: "btn", onclick: async () => {
        const dir = await io.pickFolder();
        if (!dir) return;
        await db.set(`sxm.cloud.${s}.root`, dir);
        close(); refresh(); openFrom(s);
      } }, "Choisir le dossier…"),
      el("button", { class: "btn accent", onclick: () => { close(); invoke("open_external", { url: download }).catch(() => {}); } },
        tr(`Télécharger ${name}`)))));
}
