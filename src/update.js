// Mises à jour automatiques : vérification au démarrage, bandeau de proposition, installation avec progression.
// Le téléchargement et la vérification de la signature se font côté Rust (update_check / update_install).
import { invoke, Channel } from "@tauri-apps/api/core";
import * as db from "./store.js";
import { toast, el, confirmBox, modal } from "./ui.js";
import { state } from "./core.js";

const RELEASES = "https://github.com/InvisibleDawn/sxm-pdf/releases";
export const isLinux = !navigator.userAgent.includes("Windows") && !navigator.userAgent.includes("Mac");

export const autoEnabled = () => db.get("sxm.updates.auto", "1") !== "0";
export const betaEnabled = () => db.get("sxm.updates.beta", "0") === "1";
export const setAuto = (on) => db.set("sxm.updates.auto", on ? "1" : "0");
export const setBeta = (on) => db.set("sxm.updates.beta", on ? "1" : "0");

let running = false;

/** Vérification discrète quelques secondes après le démarrage. */
export function autoCheck() {
  if (isLinux || !autoEnabled()) return;
  setTimeout(async () => {
    try {
      const u = await invoke("update_check", { beta: betaEnabled() });
      if (u && db.get("sxm.updates.skip") !== u.version) offer(u, true);
    } catch { /* hors ligne ou serveur indisponible : on réessaiera au prochain lancement */ }
  }, 5000);
}

/** Vérification demandée par l'utilisateur (menu ⋯ ou À propos). */
export async function checkNow() {
  if (isLinux) {
    return modal((m, close) => m.append(
      el("h2", {}, "Mises à jour sous Linux"),
      el("p", {}, "Sous Linux, installez la nouvelle version (.rpm ou .deb) depuis la page de téléchargement :"),
      el("p", { style: "user-select:text;font-size:12px" }, RELEASES),
      el("div", { class: "row end" }, el("button", { class: "btn accent", onclick: () => close() }, "Compris"))));
  }
  if (running) return;
  running = true;
  toast("Recherche des mises à jour…");
  try {
    const u = await invoke("update_check", { beta: betaEnabled() });
    if (u) await offer(u, false);
    else toast("Vous avez la dernière version de SXM PDF.");
  } catch (e) {
    toast("Impossible de vérifier les mises à jour. Vérifiez votre connexion Internet.\n" + String(e?.message || e), true);
  } finally { running = false; }
}

function offer(u, automatic) {
  return modal((m, close) => m.append(
    el("h2", {}, `🎉 SXM PDF ${u.version} est disponible`),
    el("p", {}, `Vous utilisez la version ${u.current}. La mise à jour se télécharge et s'installe en un clic ; vos signatures et réglages sont conservés.`),
    u.notes ? el("div", {},
      el("b", {}, "Nouveautés"),
      el("pre", { style: "max-height:40vh;overflow:auto;white-space:pre-wrap;font:inherit;font-size:13px;background:var(--panel2);padding:10px 12px;border-radius:8px;user-select:text;margin:6px 0 0" }, u.notes)) : null,
    el("div", { class: "row end" },
      automatic ? el("button", { class: "btn", onclick: () => { db.set("sxm.updates.skip", u.version); close(); } }, "Ignorer cette version") : null,
      el("button", { class: "btn", onclick: () => close() }, "Plus tard"),
      el("button", { class: "btn accent", onclick: () => { close(); install(u); } }, "Installer maintenant"))));
}

async function install(u) {
  const dirty = state.tabs.filter((t) => t.dirty);
  if (dirty.length) {
    const ok = await confirmBox("Documents non enregistrés",
      `${dirty.length} document(s) contiennent des modifications non enregistrées. SXM PDF va redémarrer pendant la mise à jour : enregistrez-les d'abord, sinon les modifications seront perdues.`,
      "Installer quand même", "Annuler");
    if (ok !== true) return;
  }
  if (db.hasUnsavedChanges()) await db.retry();

  const bar = el("div", { style: "height:8px;border-radius:4px;background:var(--accent, #4f46e5);width:0%;transition:width .2s" });
  const label = el("p", {}, "Téléchargement…");
  let closeBox = () => {};
  modal((m, close) => {
    closeBox = close;
    m.append(el("h2", {}, `Mise à jour vers ${u.version}`), label,
      el("div", { style: "height:8px;border-radius:4px;background:var(--panel2);overflow:hidden" }, bar),
      el("p", { style: "font-size:12px" }, "SXM PDF redémarrera automatiquement à la fin."));
  });
  const progress = new Channel();
  progress.onmessage = ([done, total]) => {
    const mo = (n) => (n / 1048576).toFixed(0);
    if (total) {
      bar.style.width = Math.min(100, (done / total) * 100).toFixed(1) + "%";
      label.textContent = `Téléchargement… ${mo(done)} / ${mo(total)} Mo`;
      if (done >= total) label.textContent = "Installation…";
    } else label.textContent = `Téléchargement… ${mo(done)} Mo`;
  };
  const wasDirty = state.tabs.filter((t) => t.dirty);
  try {
    state.tabs.forEach((t) => (t.dirty = false)); // évite la question « Quitter sans enregistrer » au redémarrage
    await invoke("update_install", { beta: betaEnabled(), progress });
  } catch (e) {
    wasDirty.forEach((t) => (t.dirty = true));
    closeBox();
    toast("La mise à jour a échoué : " + String(e?.message || e) + `\nVous pouvez télécharger la nouvelle version sur ${RELEASES}`, true);
  }
}

/** Réglages affichés dans « À propos ». */
export function settingsBlock() {
  if (isLinux) return el("p", { style: "font-size:12px" }, "Mises à jour : installez les nouvelles versions .rpm / .deb depuis la page de téléchargement.");
  const check = (label, on, set) => {
    const c = el("input", { type: "checkbox" });
    c.checked = on;
    c.addEventListener("change", () => set(c.checked));
    return el("label", { style: "display:flex;gap:8px;align-items:center;cursor:pointer" }, c, label);
  };
  return el("div", { style: "display:flex;flex-direction:column;gap:6px" },
    el("b", {}, "Mises à jour"),
    check("Rechercher automatiquement au démarrage", autoEnabled(), setAuto),
    check("Recevoir aussi les versions de test (bêta)", betaEnabled(), setBeta));
}
