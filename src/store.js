// Données de l'utilisateur dans un fichier JSON du dossier de configuration
// (signatures, tampons, initiales, profils de lot, modèles de filigrane, préférences).
//
// Règles de fiabilité :
//  - TOUTES les écritures (modifications, import, restauration) passent par une file unique : jamais
//    deux écritures simultanées, et chaque écriture enregistre l'état le plus récent.
//  - Un échec d'écriture est toujours signalé (bandeau), avec nouvelle tentative et restauration .bak.
//  - Un import est validé entièrement puis préparé sur une copie : en cas d'erreur, rien ne change.
import { invoke } from "@tauri-apps/api/core";

const KEYS = ["sxm.signatures", "sxm.stamps", "sxm.initials", "sxm.initialsStyle", "sxm.batchProfiles", "sxm.watermarkTemplates", "sxm.theme", "sxm.welcomed"];
const RAW = new Set(["sxm.initials", "sxm.initialsStyle", "sxm.theme", "sxm.welcomed"]); // valeurs texte dans l'ancien stockage
const LISTS = ["sxm.signatures", "sxm.stamps", "sxm.batchProfiles", "sxm.watermarkTemplates"];
const TEXTS = ["sxm.initials", "sxm.initialsStyle"]; // réglages texte inclus dans l'export et la restauration
export const BACKUP_FORMAT = 1;

let data = {};
let queue = Promise.resolve(); // file d'écriture unique
let pendingFlush = null;       // regroupe les modifications rapprochées en une seule écriture
let unsaved = false;
let retryTimer = null;
const listeners = new Set();

/** status : { ok: true } | { ok: false, error, canRestore } — pour l'interface. */
let lastStatus = { ok: true };
export const onStatus = (fn) => { listeners.add(fn); if (!lastStatus.ok) fn(lastStatus); return () => listeners.delete(fn); };
const emit = (st) => { lastStatus = st; listeners.forEach((fn) => { try { fn(st); } catch {} }); };
export const hasUnsavedChanges = () => unsaved;

/** Ajoute une tâche à la file : elle ne démarre qu'après la fin de la précédente. */
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

export const DATA_FORMAT = 1; // version du fichier de données (vérifiée aussi côté Rust)
async function writeNow(obj) {
  await invoke("data_save", { content: JSON.stringify({ ...obj, _format: DATA_FORMAT }, null, 1) });
}

function mirror(k) {
  try {
    // Les listes (signatures, tampons, profils, modèles) ne sont plus recopiées dans le stockage
    // interne de la fenêtre : le fichier de données et son .bak suffisent. L'ancienne copie,
    // lue une seule fois pour la migration des anciennes versions, est effacée dès que le fichier
    // de données a été écrit avec succès.
    if (LISTS.includes(k)) return; // effacée après une écriture réussie (dropLegacyCopies)
    if (k in data) localStorage.setItem(k, RAW.has(k) ? String(data[k]) : JSON.stringify(data[k]));
    else localStorage.removeItem(k);
  } catch { /* copie facultative */ }
}

/** Ancienne copie des listes dans le stockage de la fenêtre : inutile une fois le fichier écrit. */
function dropLegacyCopies() {
  for (const k of LISTS) { try { localStorage.removeItem(k); } catch { /* facultatif */ } }
}

/** À appeler une fois au démarrage, avant toute lecture. */
export async function initStore() {
  let loaded = null, loadError = null;
  try { loaded = JSON.parse(await invoke("data_load")); } catch (e) { loadError = e; }

  let moved = null;
  if (loadError) {
    // Fichier illisible sans copie de secours valide : on le met de côté (jamais écrasé) et on repart.
    try { moved = await invoke("data_quarantine"); } catch {}
    data = {};
  } else {
    data = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
  }

  // Migration automatique depuis l'ancien stockage (versions précédentes)
  let migrated = false;
  for (const k of KEYS) {
    if (k in data) continue;
    try {
      const v = localStorage.getItem(k);
      if (v == null) continue;
      data[k] = RAW.has(k) ? v : JSON.parse(v);
      migrated = true;
    } catch { /* valeur illisible : ignorée */ }
  }
  if (migrated) await flush();
  else if (!loadError && Object.keys(data).length) dropLegacyCopies(); // fichier valide : la copie est inutile
  if (loadError) {
    emit({
      ok: false, startup: true,
      error: "Vos données enregistrées étaient illisibles." +
        (moved ? ` Le fichier a été conservé à part : ${moved}.` : "") +
        (migrated ? " Une copie locale de vos réglages a été récupérée : vérifiez vos signatures et profils." : " Restaurez une sauvegarde si vous en avez une (menu ⋯ > Restaurer une sauvegarde)."),
    });
  }
}

export const get = (k, def) => (k in data ? data[k] : def);

/** Modifie une valeur et l'enregistre. Ne lève jamais d'erreur : un échec est signalé par onStatus. */
export function set(k, v) {
  data[k] = v;
  mirror(k);
  return flush();
}

/** Enregistre l'état courant. Les appels rapprochés sont regroupés ; l'écriture prend toujours l'état le plus récent. */
export function flush() {
  unsaved = true;
  if (pendingFlush) return pendingFlush;
  pendingFlush = enqueue(async () => {
    pendingFlush = null; // une modification arrivant pendant l'écriture déclenchera une nouvelle écriture
    try {
      await writeNow(data);
      unsaved = false;
      dropLegacyCopies();
      clearTimeout(retryTimer); retryTimer = null;
      emit({ ok: true });
      return true;
    } catch (e) {
      unsaved = true;
      emit({ ok: false, error: String(e?.message || e) });
      // nouvelle tentative automatique unique, 4 s plus tard
      if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; if (unsaved) flush(); }, 4000);
      return false;
    }
  });
  return pendingFlush;
}

/** Nouvelle tentative manuelle (bouton « Réessayer »). Renvoie true si la sauvegarde a réussi. */
export const retry = () => flush();

/**
 * Remplace les données par la copie de secours .bak. Les modifications plus récentes sont perdues :
 * l'interface demande confirmation avant d'appeler cette fonction.
 */
export function restoreFromBackup() {
  return enqueue(async () => {
    // 1. Lecture du .bak sans rien modifier, puis vérification complète (mêmes règles qu'un import)
    let raw;
    try { raw = JSON.parse(await invoke("data_read_backup")); }
    catch (e) { throw new Error(String(e).includes("Aucune") ? String(e) : "La copie de secours est illisible. Rien n'a été modifié."); }
    if (!isObj(raw)) throw new Error("La copie de secours est invalide. Rien n'a été modifié.");
    if (raw._format !== undefined && (!Number.isInteger(raw._format) || raw._format < 1 || raw._format > DATA_FORMAT))
      throw new Error("La copie de secours provient d'une version incompatible de SXM PDF. Rien n'a été modifié.");
    const payload = {};
    for (const k of [...LISTS, ...TEXTS]) if (raw[k] !== undefined) payload[k] = raw[k];
    if (Object.keys(payload).length) {
      try { validateBackup(JSON.stringify({ app: "SXM PDF", format: BACKUP_FORMAT, data: payload })); }
      catch (e) { throw new Error(String(e.message || e).replace("Sauvegarde endommagée", "Copie de secours invalide")); }
    }
    for (const k of ["sxm.theme", "sxm.welcomed"]) if (raw[k] !== undefined && typeof raw[k] !== "string") throw new Error("La copie de secours est invalide. Rien n'a été modifié.");
    // 2. Restauration (Rust revérifie la structure et ne touche à rien en cas de problème)
    const content = await invoke("data_restore_backup");
    const restored = JSON.parse(content);
    data = restored;
    KEYS.forEach(mirror);
    unsaved = false;
    emit({ ok: true, restored: true });
    return true;
  });
}

export const dataPath = () => invoke("data_path");

/** Contenu du fichier d'export (sans les préférences d'affichage). */
export function exportJson() {
  const out = {};
  for (const k of [...LISTS, ...TEXTS]) if (k in data) out[k] = data[k];
  return JSON.stringify({ app: "SXM PDF", format: BACKUP_FORMAT, exported: new Date().toISOString(), data: out }, null, 1);
}

// ======================================================================= Validation des sauvegardes

const POS = ["bas-droite", "bas-gauche", "bas-centre", "haut-droite", "haut-gauche"];
const PAGES = ["last", "first", "all"];
const HEX = /^#[0-9a-f]{6}$/i;
const IMG = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const MAX_ITEMS = 500, MAX_IMG = 3_000_000;

class Invalid extends Error {}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const need = (cond, where) => { if (!cond) throw new Invalid(where); };
const str = (v, where, { min = 0, max = 500 } = {}) => { need(typeof v === "string" && v.length >= min && v.length <= max, where); return v; };
const bool = (v, where) => { need(typeof v === "boolean", where); return v; };
const num = (v, where, lo, hi) => { need(typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi, where); return v; };
const oneOf = (v, list, where) => { need(list.includes(v), where); return v; };
const opt = (o, k, fn, def) => (o[k] === undefined ? def : fn(o[k]));

function vSignature(x, w) {
  need(isObj(x), w);
  need(typeof x.src === "string" && x.src.length <= MAX_IMG && IMG.test(x.src), w + " (image)");
  return { src: x.src, ratio: num(x.ratio, w + " (proportions)", 0.05, 50) };
}
function vStamp(x, w, withDate = false) {
  need(isObj(x), w);
  const s = { label: str(x.label, w + " (texte)", { min: 1, max: 60 }), color: (need(HEX.test(x.color ?? ""), w + " (couleur)"), x.color) };
  if (withDate) s.date = x.date == null ? null : str(x.date, w + " (date)", { max: 20 });
  return s;
}
function vTemplate(x, w) {
  need(isObj(x) && isObj(x.opt), w);
  const o = x.opt;
  return {
    name: str(x.name, w + " (nom)", { min: 1, max: 80 }),
    opt: {
      text: str(o.text, w + " (texte)", { min: 1, max: 200 }),
      color: (need(HEX.test(o.color ?? ""), w + " (couleur)"), o.color),
      opacity: num(o.opacity, w + " (transparence)", 0.01, 1),
      scale: num(o.scale, w + " (taille)", 0.1, 2),
      orient: opt(o, "orient", (v) => oneOf(v, ["horizontal", "diagonal", "vertical"], w + " (orientation)"), "diagonal"),
      layer: opt(o, "layer", (v) => oneOf(v, ["back", "front"], w + " (position)"), "back"),
    },
  };
}
function vProfile(x, w) {
  need(isObj(x) && isObj(x.par) && isObj(x.sig) && isObj(x.stamp) && isObj(x.out), w);
  return {
    name: str(x.name, w + " (nom)", { min: 1, max: 80 }),
    par: {
      on: bool(x.par.on, w + " (paraphe)"),
      initials: str(x.par.initials ?? "", w + " (initiales)", { max: 20 }),
      pos: oneOf(x.par.pos, POS, w + " (position du paraphe)"),
      skip: bool(x.par.skip, w + " (paraphe dernière page)"),
    },
    sig: {
      on: bool(x.sig.on, w + " (signature)"),
      sig: x.sig.sig == null ? null : vSignature(x.sig.sig, w + " (signature)"),
      page: oneOf(x.sig.page, PAGES, w + " (page de signature)"),
      pos: oneOf(x.sig.pos, POS, w + " (position de signature)"),
    },
    stamp: {
      on: bool(x.stamp.on, w + " (tampon)"),
      stamp: x.stamp.stamp == null ? null : vStamp(x.stamp.stamp, w + " (tampon)", true),
      page: oneOf(x.stamp.page, PAGES, w + " (page du tampon)"),
      pos: oneOf(x.stamp.pos, POS, w + " (position du tampon)"),
    },
    pw: bool(x.pw, w + " (mot de passe)"),
    out: {
      dir: x.out.dir == null ? null : str(x.out.dir, w + " (dossier)", { min: 1, max: 4096 }),
      suffix: str(x.out.suffix, w + " (suffixe)", { max: 60 }),
    },
  };
}
const VALIDATORS = { "sxm.signatures": vSignature, "sxm.stamps": (x, w) => vStamp(x, w), "sxm.batchProfiles": vProfile, "sxm.watermarkTemplates": vTemplate };
const LABEL = { "sxm.signatures": "signature", "sxm.stamps": "tampon", "sxm.batchProfiles": "profil de lot", "sxm.watermarkTemplates": "modèle de filigrane" };
const itemKey = (k, item) => (k === "sxm.signatures" ? item.src : k === "sxm.stamps" ? item.label : item.name);

/**
 * Vérifie entièrement une sauvegarde, sans rien modifier.
 * Renvoie des données reconstruites (seuls les champs connus et valides sont conservés).
 */
export function validateBackup(text) {
  if (typeof text !== "string" || text.length > 60_000_000) throw new Error("Fichier trop volumineux ou illisible.");
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error("Fichier illisible : ce n'est pas une sauvegarde SXM PDF valide."); }
  if (!isObj(obj) || obj.app !== "SXM PDF") throw new Error("Ce fichier n'est pas une sauvegarde SXM PDF.");
  if (!Number.isInteger(obj.format)) throw new Error("Sauvegarde sans numéro de format : fichier non reconnu.");
  if (obj.format > BACKUP_FORMAT) throw new Error("Sauvegarde créée par une version plus récente de SXM PDF : mettez l'application à jour.");
  if (obj.format < 1) throw new Error("Format de sauvegarde inconnu.");
  if (obj.exported !== undefined && (typeof obj.exported !== "string" || Number.isNaN(Date.parse(obj.exported)))) throw new Error("Sauvegarde endommagée (date d'export).");
  if (!isObj(obj.data)) throw new Error("Sauvegarde endommagée : contenu absent.");
  const src = obj.data;
  const clean = {};
  try {
    for (const k of LISTS) {
      if (src[k] === undefined) continue;
      need(Array.isArray(src[k]), `liste des ${LABEL[k]}s`);
      need(src[k].length <= MAX_ITEMS, `trop d'éléments (${LABEL[k]}s)`);
      const seen = new Set();
      clean[k] = [];
      src[k].forEach((x, i) => {
        const v = VALIDATORS[k](x, `${LABEL[k]} n° ${i + 1}`);
        if (!seen.has(itemKey(k, v))) { seen.add(itemKey(k, v)); clean[k].push(v); }
      });
    }
    if (src["sxm.initials"] !== undefined) clean["sxm.initials"] = str(src["sxm.initials"], "initiales", { max: 20 });
    if (src["sxm.initialsStyle"] !== undefined) clean["sxm.initialsStyle"] = oneOf(src["sxm.initialsStyle"], ["neutre", "manuscrit"], "style des initiales");
  } catch (e) {
    if (e instanceof Invalid) throw new Error(`Sauvegarde endommagée : ${e.message} invalide. Aucune donnée n'a été modifiée.`);
    throw e;
  }
  if (!Object.keys(clean).length) throw new Error("Cette sauvegarde ne contient aucune donnée à importer.");
  return clean;
}

/**
 * Importe une sauvegarde (passe par la file d'écriture unique).
 *  - merge = true  : ajoute les éléments absents, sans doublon ; garde les initiales actuelles si elles existent.
 *  - merge = false : « Tout remplacer » — signatures, tampons, initiales, profils et modèles actuels sont
 *    supprimés puis remplacés exactement par la sauvegarde (vides s'ils en sont absents).
 * Validation complète d'abord, préparation sur une copie, écriture, et seulement ensuite mise à jour
 * des données en mémoire : en cas d'erreur, rien ne change. Renvoie le nombre d'éléments importés.
 */
export function importJson(text, merge = true) {
  const src = validateBackup(text); // avant toute modification
  return enqueue(async () => {
    const next = structuredClone(data); // état le plus récent, au moment de l'écriture
    let count = 0;
    for (const k of LISTS) {
      const incoming = src[k] || [];
      if (merge) {
        const cur = Array.isArray(next[k]) ? next[k] : [];
        const seen = new Set(cur.map((x) => itemKey(k, x)));
        const added = incoming.filter((x) => !seen.has(itemKey(k, x)));
        next[k] = [...cur, ...added];
        count += added.length;
      } else {
        next[k] = incoming;
        count += incoming.length;
      }
    }
    for (const k of TEXTS) {
      if (merge) { if (!next[k] && src[k]) { next[k] = src[k]; count++; } }
      else if (src[k]) { next[k] = src[k]; count++; }
      else delete next[k];
    }
    await writeNow(next); // une erreur ici laisse data intact et remonte à l'appelant
    data = next;
    [...LISTS, ...TEXTS].forEach(mirror);
    unsaved = false;
    emit({ ok: true });
    return count;
  });
}
