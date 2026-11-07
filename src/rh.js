// Fonctions « RH » : paraphe sur toutes les pages, masquage par recherche, traitement par lot.
import { PDFDocument } from "pdf-lib";
import { modal, el, toast, askText, confirmBox } from "./ui.js";

const PROF_KEY = "sxm.batchProfiles";
import * as db from "./store.js";
const loadProfiles = () => [...(db.get(PROF_KEY, []) || [])];
const saveProfiles = (v) => db.set(PROF_KEY, v);
import { signatureDialog, stampDialog, trimCanvas, today } from "./sign.js";
import { norm, newId } from "./annots.js";

export const POSITIONS = [
  ["bas-droite", "En bas à droite"], ["bas-gauche", "En bas à gauche"], ["bas-centre", "En bas au centre"],
  ["haut-droite", "En haut à droite"], ["haut-gauche", "En haut à gauche"],
];

const INIT_KEY = "sxm.initials";
const getInitials = () => db.get(INIT_KEY, "") || "";
const setInitials = (v) => db.set(INIT_KEY, v);
// Style d'écriture des initiales tapées : « neutre » (Arial) par défaut, ou « manuscrit ».
const INIT_STYLE_KEY = "sxm.initialsStyle";
export const INITIAL_STYLES = [["neutre", "Neutre (Arial)"], ["manuscrit", "Manuscrite"]];
const getInitialsStyle = () => (db.get(INIT_STYLE_KEY, "neutre") === "manuscrit" ? "manuscrit" : "neutre");
const setInitialsStyle = (v) => db.set(INIT_STYLE_KEY, v);
const INITIAL_FONTS = {
  neutre: '600 96px Arial, Helvetica, "Liberation Sans", "DejaVu Sans", sans-serif',
  manuscrit: 'italic 600 96px "Segoe Script", "Brush Script MT", "URW Chancery L", "Z003", cursive',
};

/** Rectangle PDF d'un élément w×h (points) placé à une position de la page affichée. */
export function posBox(vp1, pos, w, h, margin = 28) {
  const W = vp1.width, H = vp1.height;
  const x = pos.endsWith("gauche") ? margin : pos.endsWith("centre") ? (W - w) / 2 : W - w - margin;
  const y = pos.startsWith("haut") ? margin : H - h - margin;
  const [x1, y1] = vp1.convertToPdfPoint(x, y);
  const [x2, y2] = vp1.convertToPdfPoint(x + w, y + h);
  return norm(x1, y1, x2, y2);
}

/** Image des initiales tapées au clavier (style neutre ou manuscrit). */
export function initialsImage(text, color = "#0f172a", style = getInitialsStyle()) {
  const c = document.createElement("canvas");
  c.width = 60 + text.length * 70; c.height = 170;
  const ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.font = INITIAL_FONTS[style] || INITIAL_FONTS.neutre;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 20, 85);
  return trimCanvas(c);
}

const sel = (opts, value) => {
  const s = el("select", { style: "padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--panel2)" });
  for (const [v, l] of opts) s.append(el("option", { value: v }, l));
  if (value) s.value = value;
  return s;
};
const textIn = (ph, value = "", w = "") => {
  const i = el("input", { type: "text", placeholder: ph, style: w });
  i.value = value;
  return i;
};

// ======================================================================= Paraphe

/** Fenêtre « Parapher toutes les pages ». Renvoie { mark:{src,ratio}, pos, width, skipLast } ou null. */
export function parapheDialog(nPages) {
  return modal((m, close) => {
    let mark = null;
    const initials = textIn("Vos initiales, ex. L.H.", getInitials(), "max-width:200px");
    const preview = el("div", { style: "min-height:60px;display:flex;align-items:center;justify-content:center;background:#fff;border:1px dashed var(--border);border-radius:8px;padding:6px" });
    const showPreview = () => {
      const m2 = mark || (initials.value.trim() ? initialsImage(initials.value.trim(), undefined, style.value) : null);
      preview.replaceChildren(m2 ? el("img", { src: m2.src, style: "max-height:56px" }) : el("span", { style: "color:#94a3b8" }, "Aperçu"));
    };
    const style = sel(INITIAL_STYLES, getInitialsStyle());
    initials.addEventListener("input", () => { mark = null; showPreview(); });
    style.addEventListener("change", () => { mark = null; showPreview(); });
    const pos = sel(POSITIONS, "bas-droite");
    const size = sel([["45", "Petit"], ["60", "Moyen"], ["80", "Grand"]], "60");
    const skipLast = el("input", { type: "checkbox" });
    showPreview();
    m.append(
      el("h2", {}, "✍️ Parapher toutes les pages"),
      el("p", {}, `Vos initiales seront posées au même endroit sur les ${nPages} pages. Vous pourrez ensuite en déplacer une si besoin.`),
      el("div", { class: "row" }, initials, "Écriture :", style,
        el("button", { class: "btn", onclick: async () => { const sg = await signatureDialog(); if (sg) { mark = sg; showPreview(); } } }, "…ou utiliser une signature enregistrée")),
      preview,
      el("div", { class: "row" }, "Position :", pos, "Taille :", size),
      el("label", { class: "row" }, skipLast, "Sauf la dernière page (elle reçoit souvent la signature complète)"),
      el("div", { class: "row end" },
        el("button", { class: "btn", onclick: () => close(null) }, "Annuler"),
        el("button", { class: "btn accent", onclick: () => {
          const txt = initials.value.trim();
          const mk = mark || (txt ? initialsImage(txt, undefined, style.value) : null);
          if (!mk) return toast("Tapez vos initiales ou choisissez une signature.", true);
          if (!mark) { setInitials(txt); setInitialsStyle(style.value); }
          close({ mark: mk, pos: pos.value, width: +size.value, skipLast: skipLast.checked });
        } }, "Parapher")));
  });
}

/** Annotations « paraphe » pour chaque page. getVp(i) → viewport échelle 1. */
export async function parapheAnnots(nPages, getVp, { mark, pos, width, skipLast }) {
  const out = [];
  const w = width, h = Math.min(width / mark.ratio, 40);
  const ww = h * mark.ratio; // garde les proportions si la hauteur a été plafonnée
  for (let i = 0; i < nPages; i++) {
    if (skipLast && i === nPages - 1 && nPages > 1) continue;
    const vp = await getVp(i);
    out.push({ id: newId(), page: i, type: "signature", kind: "paraphe", src: mark.src, ratio: mark.ratio, ...posBox(vp, pos, Math.min(w, ww), h) });
  }
  return out;
}

// ======================================================================= Masquage par recherche

// despace : la recherche ignore les espaces (numéros écrits par groupes de chiffres)
export const PRESETS = {
  nir: { label: "N° de sécurité sociale", despace: true, re: /(?<![\dA-Z])[12]\d{2}(?:0[1-9]|1[0-2]|[2-9]\d)(?:\d{2}|2A|2B)\d{6}(?:\d{2})?(?!\d)/gi },
  iban: { label: "IBAN", despace: true, re: /(?<![A-Z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Z0-9])/g },
  email: { label: "Adresses e-mail", despace: false, re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  tel: { label: "Téléphones", despace: true, re: /(?<!\d)(?:\+33|0033|\+590|00590|\+1|0)[1-9]\d{8,9}(?!\d)/g },
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Cherche des motifs dans le texte d'un document pdf.js. Les espaces sont ignorés,
 * ce qui retrouve « FR76 3000 6000 … » comme « FR76300060… ».
 * Renvoie [{ page, rects:[[x1,y1,x2,y2]…], text }].
 */
export async function findMatches(pdfDoc, regexes) {
  const found = [];
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter((it) => it.str);
    // Deux versions du texte de la page, avec la correspondance caractère → élément :
    // l'une sans espaces (numéros par groupes), l'autre avec. Les retours à la ligne
    // deviennent un séparateur que les motifs ne peuvent pas franchir.
    const build = (keepSpaces) => {
      let str = "";
      const map = [];
      let lastY = null;
      items.forEach((it, ii) => {
        const y = it.transform[5];
        if (lastY != null && Math.abs(y - lastY) > 2) { str += "\u0001"; map.push(null); }
        lastY = y;
        [...it.str].forEach((ch, ci) => {
          if (/\s/.test(ch)) { if (keepSpaces) { str += " "; map.push(null); } }
          else { str += ch; map.push([ii, ci]); }
        });
        if (it.hasEOL) { str += "\u0001"; map.push(null); lastY = null; }
        else if (keepSpaces) { str += " "; map.push(null); }
      });
      return { str, map };
    };
    const texts = { true: build(false), false: build(true) };
    for (const { re, despace } of regexes) {
      const { str: normStr, map } = texts[despace];
      re.lastIndex = 0;
      let mt;
      while ((mt = re.exec(normStr))) {
        if (!mt[0].length) { re.lastIndex++; continue; }
        // regroupe les caractères trouvés par élément de texte
        const parts = new Map();
        for (let k = mt.index; k < mt.index + mt[0].length; k++) {
          if (!map[k]) continue;
          const [ii, ci] = map[k];
          const r = parts.get(ii) || [ci, ci];
          parts.set(ii, [Math.min(r[0], ci), Math.max(r[1], ci)]);
        }
        const rects = [];
        for (const [ii, [c0, c1]] of parts) {
          const it = items[ii];
          const [a, b, , d, e, f] = it.transform;
          const len = [...it.str].length || 1;
          const fh = Math.hypot(b, d) || it.height || 10;
          const w = it.width || fh * 0.5 * len;
          const x1 = e + (w * c0) / len - 1, x2 = e + (w * (c1 + 1)) / len + 1;
          rects.push([x1, f - fh * 0.28, x2, f + fh * 0.95]);
        }
        found.push({ page: p - 1, rects, text: mt[0] });
      }
    }
  }
  return found;
}

/** Fenêtre « Masquer par recherche ». Renvoie { regexes, mode, labels } ou null. */
export function searchRedactDialog() {
  return modal((m, close) => {
    const term = textIn("Texte à masquer (nom, numéro…) — plusieurs possibles, séparés par ;");
    const checks = Object.entries(PRESETS).map(([k, p]) => [k, el("input", { type: "checkbox" }), p.label]);
    const mode = sel([["black", "Bloc noir (recommandé)"], ["blur", "Flou (moins sûr pour les numéros)"]], "black");
    const go = () => {
      const regexes = [], labels = [];
      for (const t of term.value.split(";").map((x) => x.trim()).filter(Boolean)) {
        regexes.push({ re: new RegExp(escapeRe(t.replace(/\s+/g, "")), "gi"), despace: true }); labels.push(`« ${t} »`);
      }
      for (const [k, c, l] of checks) if (c.checked) { const p = PRESETS[k]; regexes.push({ re: new RegExp(p.re.source, p.re.flags), despace: p.despace }); labels.push(l); }
      if (!regexes.length) return toast("Tapez un texte ou cochez au moins un type d'information.", true);
      close({ regexes, mode: mode.value, labels });
    };
    term.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    m.append(
      el("h2", {}, "🔍 Masquer par recherche"),
      el("p", {}, "Toutes les occurrences trouvées dans le document seront masquées. Vous pourrez vérifier et ajuster avant d'enregistrer."),
      el("div", { class: "row" }, term),
      el("p", {}, "Rechercher aussi automatiquement :"),
      ...checks.map(([, c, l]) => el("label", { class: "row" }, c, l)),
      el("div", { class: "row" }, "Masquage :", mode),
      el("p", { style: "font-size:12px" }, "ℹ️ Fonctionne sur les PDF contenant du texte. Pour un document scanné, utilisez l'outil ▦ Masquer à la main."),
      el("p", { style: "font-size:12px" }, "ℹ️ Les valeurs saisies dans les champs de formulaire et les propriétés du fichier (titre, auteur) ne sont pas analysées : vérifiez-les avant d'envoyer le document."),
      el("div", { class: "row end" }, el("button", { class: "btn", onclick: () => close(null) }, "Annuler"), el("button", { class: "btn accent", onclick: go }, "Rechercher et masquer")));
    setTimeout(() => term.focus(), 30);
  });
}

// ======================================================================= Traitement par lot

/**
 * Fenêtre « Traitement par lot ». pickPdfs() et pickFolder() viennent de io.js.
 * Renvoie la configuration choisie, ou null.
 */
export function batchDialog({ pickPdfs, pickFolder, baseName }) {
  return modal((m, close) => {
    let files = [], sig = null, stamp = null, outDir = null;
    const fileList = el("div", { style: "max-height:110px;overflow:auto;font-size:12px;color:var(--muted)" });
    const renderFiles = () => fileList.replaceChildren(...(files.length ? files.map((f) => el("div", {}, "• " + baseName(f))) : [el("div", {}, "Aucun fichier choisi.")]));
    renderFiles();

    const cPar = el("input", { type: "checkbox" }), cSig = el("input", { type: "checkbox" }), cStamp = el("input", { type: "checkbox" }), cPw = el("input", { type: "checkbox" });
    const initials = textIn("Initiales", getInitials(), "max-width:120px");
    const parPos = sel(POSITIONS, "bas-droite"), parSkip = el("input", { type: "checkbox", checked: "" });
    const sigLabel = el("span", { style: "color:var(--muted)" }, "aucune");
    const sigPage = sel([["last", "dernière page"], ["first", "première page"], ["all", "toutes les pages"]], "last"), sigPos = sel(POSITIONS, "bas-droite");
    const stampLabel = el("span", { style: "color:var(--muted)" }, "aucun");
    const stampPage = sel([["first", "première page"], ["last", "dernière page"], ["all", "toutes les pages"]], "first"), stampPos = sel(POSITIONS, "haut-droite");
    const pw = el("input", { type: "password", placeholder: "Mot de passe d'ouverture", style: "flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel2);user-select:text" });
    const outSame = el("input", { type: "radio", name: "out", checked: "" }), outOther = el("input", { type: "radio", name: "out" });
    const suffix = textIn("Suffixe", "-traité", "max-width:130px");
    const outLabel = el("span", { style: "color:var(--muted)" }, "");
    const section = (title, ...rows) => el("div", { style: "border:1px solid var(--border);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px" }, title, ...rows);

    // ---- Profils enregistrés (ex. « Contrats » : paraphe + signature + tampon REÇU)
    let profiles = loadProfiles();
    const profSel = el("select", { style: "flex:1;padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--panel2)" });
    const renderProfiles = (selected = "") => {
      profSel.replaceChildren(el("option", { value: "" }, profiles.length ? "— Choisir un profil —" : "— Aucun profil enregistré —"),
        ...profiles.map((p) => el("option", { value: p.name }, p.name)));
      profSel.value = selected;
    };
    renderProfiles();
    const showSig = () => sigLabel.replaceChildren(sig ? el("img", { src: sig.src, style: "height:28px;background:#fff" }) : "aucune");
    const showStamp = () => { stampLabel.textContent = stamp ? stamp.label + (stamp.date ? " + date" : "") : "aucun"; stampLabel.style.color = stamp ? stamp.color : "var(--muted)"; };
    const applyProfile = (p) => {
      cPar.checked = p.par.on; initials.value = p.par.initials || initials.value; parPos.value = p.par.pos; parSkip.checked = p.par.skip;
      cSig.checked = p.sig.on; sig = p.sig.sig; sigPage.value = p.sig.page; sigPos.value = p.sig.pos; showSig();
      cStamp.checked = p.stamp.on; stamp = p.stamp.stamp; stampPage.value = p.stamp.page; stampPos.value = p.stamp.pos; showStamp();
      cPw.checked = p.pw; pw.value = "";
      outOther.checked = !!p.out.dir; outSame.checked = !p.out.dir; outDir = p.out.dir; outLabel.textContent = p.out.dir || ""; suffix.value = p.out.suffix;
      if (p.pw) setTimeout(() => pw.focus(), 30);
    };
    profSel.addEventListener("change", () => { const p = profiles.find((x) => x.name === profSel.value); if (p) applyProfile(p); });
    const saveProfile = async () => {
      const name = (await askText("Nom du profil", profSel.value || "", { placeholder: "ex. Contrats de travail" }))?.trim();
      if (!name) return;
      const prof = {
        name,
        par: { on: cPar.checked, initials: initials.value.trim(), pos: parPos.value, skip: parSkip.checked },
        sig: { on: cSig.checked, sig, page: sigPage.value, pos: sigPos.value },
        stamp: { on: cStamp.checked, stamp, page: stampPage.value, pos: stampPos.value },
        pw: cPw.checked, // le mot de passe lui-même n'est jamais enregistré
        out: { dir: outOther.checked ? outDir : null, suffix: suffix.value || "-traité" },
      };
      profiles = [...profiles.filter((p) => p.name !== name), prof].sort((a, b) => a.name.localeCompare(b.name));
      saveProfiles(profiles); renderProfiles(name);
      toast(`Profil « ${name} » enregistré.` + (prof.pw ? "\nLe mot de passe sera redemandé à chaque utilisation." : ""));
    };
    const deleteProfile = async () => {
      if (!profSel.value) return;
      if (!(await confirmBox("Supprimer le profil", `Supprimer « ${profSel.value} » ?`, "Supprimer"))) return;
      profiles = profiles.filter((p) => p.name !== profSel.value); saveProfiles(profiles); renderProfiles();
    };

    const go = () => {
      if (!files.length) return toast("Choisissez au moins un PDF.", true);
      if (!cPar.checked && !cSig.checked && !cStamp.checked && !cPw.checked) return toast("Cochez au moins une action.", true);
      if (cPar.checked && !initials.value.trim()) return toast("Tapez vos initiales pour le paraphe.", true);
      if (cSig.checked && !sig) return toast("Choisissez la signature à apposer.", true);
      if (cStamp.checked && !stamp) return toast("Choisissez le tampon à apposer.", true);
      if (cPw.checked && pw.value.length < 4) return toast("Mot de passe : au moins 4 caractères.", true);
      if (outOther.checked && !outDir) return toast("Choisissez le dossier de destination.", true);
      if (cPar.checked) setInitials(initials.value.trim());
      close({
        files,
        paraphe: cPar.checked ? { mark: initialsImage(initials.value.trim()), pos: parPos.value, width: 60, skipLast: parSkip.checked } : null,
        signature: cSig.checked ? { sig, page: sigPage.value, pos: sigPos.value } : null,
        stamp: cStamp.checked ? { stamp, page: stampPage.value, pos: stampPos.value } : null,
        password: cPw.checked ? pw.value : null,
        outDir: outOther.checked ? outDir : null,
        suffix: suffix.value || "-traité",
      });
    };

    m.append(
      el("h2", {}, "📦 Traitement par lot"),
      el("div", { class: "row" }, "Profil :", profSel,
        el("button", { class: "btn", title: "Enregistrer les réglages actuels comme profil", onclick: saveProfile }, "💾 Enregistrer le profil"),
        el("button", { class: "btn", title: "Supprimer ce profil", onclick: deleteProfile }, "🗑")),
      el("div", { class: "row" },
        el("button", { class: "btn", onclick: async () => { files = [...new Set([...files, ...(await pickPdfs())])]; renderFiles(); } }, "➕ Choisir des PDF…"),
        el("button", { class: "btn", onclick: () => { files = []; renderFiles(); } }, "Vider la liste")),
      fileList,
      section(el("label", { class: "row" }, cPar, el("b", {}, "Parapher chaque page")),
        el("div", { class: "row" }, initials, parPos, el("label", { class: "row" }, parSkip, "sauf la dernière"))),
      section(el("label", { class: "row" }, cSig, el("b", {}, "Signer")),
        el("div", { class: "row" },
          el("button", { class: "btn", onclick: async () => { const s = await signatureDialog(); if (s) { sig = s; cSig.checked = true; sigLabel.replaceChildren(el("img", { src: s.src, style: "height:28px;background:#fff" })); } } }, "Choisir…"),
          sigLabel, "sur la", sigPage, sigPos)),
      section(el("label", { class: "row" }, cStamp, el("b", {}, "Tamponner")),
        el("div", { class: "row" },
          el("button", { class: "btn", onclick: async () => { const s = await stampDialog(); if (s) { stamp = s; cStamp.checked = true; stampLabel.textContent = s.label + (s.date ? " + date" : ""); stampLabel.style.color = s.color; } } }, "Choisir…"),
          stampLabel, "sur la", stampPage, stampPos)),
      section(el("label", { class: "row" }, cPw, el("b", {}, "Protéger par mot de passe")), el("div", { class: "row" }, pw)),
      el("div", { class: "row" }, el("b", {}, "Enregistrer :")),
      el("label", { class: "row" }, outSame, "à côté des originaux, avec le suffixe", suffix),
      el("label", { class: "row" }, outOther, "dans un autre dossier",
        el("button", { class: "btn", onclick: async () => { const d = await pickFolder(); if (d) { outDir = d; outOther.checked = true; outLabel.textContent = d; } } }, "Choisir…"), outLabel),
      el("p", { style: "font-size:12px" }, "Les originaux ne sont jamais modifiés."),
      el("div", { class: "row end" }, el("button", { class: "btn", onclick: () => close(null) }, "Annuler"), el("button", { class: "btn accent", onclick: go }, "Lancer le traitement")));
  });
}

/** Annotations à apposer sur un fichier du lot. */
export async function batchAnnots(cfg, n, getVp) {
  const list = [];
  const pagesFor = (which) => (which === "all" ? [...Array(n).keys()] : which === "first" ? [0] : [n - 1]);
  if (cfg.paraphe) {
    const skipPage = cfg.signature && cfg.signature.page === "last" ? true : cfg.paraphe.skipLast;
    list.push(...(await parapheAnnots(n, getVp, { ...cfg.paraphe, skipLast: skipPage })));
  }
  if (cfg.signature) {
    const { sig, page, pos } = cfg.signature;
    const w = 150, h = Math.min(w / sig.ratio, 70);
    for (const i of pagesFor(page)) list.push({ id: newId(), page: i, type: "signature", src: sig.src, ratio: sig.ratio, ...posBox(await getVp(i), pos, h * sig.ratio, h, 40) });
  }
  if (cfg.stamp) {
    const { stamp, page, pos } = cfg.stamp;
    const w = Math.max(120, stamp.label.length * 15), h = stamp.date ? 54 : 40;
    for (const i of pagesFor(page))
      list.push({ id: newId(), page: i, type: "stamp", label: stamp.label, color: stamp.color, date: stamp.date ? today() : null, ratio: w / h, ...posBox(await getVp(i), pos, w, h) });
  }
  return list;
}

export { PDFDocument };
