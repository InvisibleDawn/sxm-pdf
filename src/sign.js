// Signatures réutilisables et tampons.
import { modal, el, toast } from "./ui.js";
import { pickImages, readFile, ext } from "./io.js";

const SIG_KEY = "sxm.signatures";
const STAMP_KEY = "sxm.stamps";

import * as db from "./store.js";
const load = (k) => [...(db.get(k, []) || [])];
const store = (k, v) => db.set(k, v);

/** Rogne les marges transparentes d'un canevas et renvoie une image PNG. */
export function trimCanvas(c) {
  const ctx = c.getContext("2d");
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
  if (x2 < 0) return null;
  const pad = 6, w = x2 - x1 + 1 + pad * 2, h = y2 - y1 + 1 + pad * 2;
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  out.getContext("2d").drawImage(c, x1 - pad, y1 - pad, w, h, 0, 0, w, h);
  return { src: out.toDataURL("image/png"), ratio: w / h };
}

const imgRatio = (src) => new Promise((res) => {
  const i = new Image();
  i.onload = () => res(i.naturalWidth / i.naturalHeight);
  i.onerror = () => res(3);
  i.src = src;
});

/** Fenêtre « Signer » : choisir une signature enregistrée ou en dessiner une. */
export function signatureDialog() {
  return modal((m, close) => {
    let sigs = load(SIG_KEY);
    const list = el("div", { class: "saved-sigs" });
    const renderList = () => {
      list.replaceChildren();
      if (!sigs.length) list.append(el("p", {}, "Aucune signature enregistrée pour l'instant."));
      sigs.forEach((sg, i) => {
        list.append(el("div", { class: "saved-sig", title: "Cliquer pour placer cette signature", onclick: () => close(sg) },
          el("img", { src: sg.src }),
          el("button", { class: "del", title: "Supprimer", onclick: (e) => { e.stopPropagation(); sigs.splice(i, 1); store(SIG_KEY, sigs); renderList(); } }, "✕")));
      });
    };
    renderList();

    const pad = el("canvas", { class: "pad", width: 560, height: 180 });
    const ctx = pad.getContext("2d");
    let ink = "#0f172a", drawing = false, last = null;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    pad.addEventListener("pointerdown", (e) => { drawing = true; pad.setPointerCapture(e.pointerId); last = [e.offsetX, e.offsetY]; });
    pad.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const p = [e.offsetX, e.offsetY];
      const d = Math.hypot(p[0] - last[0], p[1] - last[1]);
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.6, 3.4 - d * 0.08); // trait plus fin quand on va vite
      ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke();
      last = p;
    });
    pad.addEventListener("pointerup", () => (drawing = false));

    const swatches = ["#0f172a", "#1d4ed8", "#0e7490"].map((c) => {
      const b = el("button", { class: "swatch" + (c === ink ? " on" : ""), style: `background:${c}`, title: "Couleur de l'encre" });
      b.onclick = () => { ink = c; swatches.forEach((x) => x.classList.remove("on")); b.classList.add("on"); };
      return b;
    });

    const saveNew = (useNow) => {
      const t = trimCanvas(pad);
      if (!t) return toast("Dessinez d'abord votre signature dans le cadre.", true);
      sigs.unshift(t); store(SIG_KEY, sigs);
      if (useNow) close(t); else { ctx.clearRect(0, 0, pad.width, pad.height); renderList(); }
    };
    const noBg = el("input", { type: "checkbox", checked: "" });
    // Ajoute une signature à partir d'une image (fichier ou presse-papiers)
    const addFromBlob = async (blob) => {
      const sg = await cleanSignature(blob, noBg.checked);
      if (!sg) return toast("Image vide ou illisible.", true);
      sigs.unshift(sg); store(SIG_KEY, sigs); close(sg);
    };
    const importImg = async () => {
      const p = await pickImages(false);
      if (!p) return;
      const bytes = await readFile(p);
      await addFromBlob(new Blob([bytes], { type: ext(p) === "png" ? "image/png" : "image/jpeg" }));
    };
    // Ctrl+V : coller une signature découpée dans un autre document
    const onPaste = (e) => {
      if (!document.body.contains(m)) return document.removeEventListener("paste", onPaste);
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (!item) return toast("Le presse-papiers ne contient pas d'image. Copiez d'abord la signature.", true);
      e.preventDefault();
      addFromBlob(item.getAsFile());
    };
    document.addEventListener("paste", onPaste);
    const pasteBtn = async () => {
      try {
        for (const it of await navigator.clipboard.read()) {
          const type = it.types.find((t) => t.startsWith("image/"));
          if (type) return addFromBlob(await it.getType(type));
        }
        toast("Le presse-papiers ne contient pas d'image. Copiez d'abord la signature.", true);
      } catch {
        toast("Appuyez sur Ctrl+V dans cette fenêtre pour coller la signature.");
      }
    };

    m.append(
      el("h2", {}, "✍️ Signature"),
      el("p", {}, "Cliquez sur une signature enregistrée, puis sur la page pour la placer."),
      list,
      el("h2", { style: "font-size:14px;margin-top:6px" }, "Nouvelle signature"),
      el("p", {}, "Dessinez-la, ou collez-la (Ctrl+V) après l'avoir copiée depuis un autre document."),
      el("label", { class: "row" }, noBg, "Retirer le fond blanc des images collées ou importées"),
      pad,
      el("div", { class: "row" }, ...swatches,
        el("button", { class: "btn", onclick: () => ctx.clearRect(0, 0, pad.width, pad.height) }, "Effacer"),
        el("button", { class: "btn", onclick: pasteBtn, title: "Ou Ctrl+V" }, "📋 Coller"),
        el("button", { class: "btn", onclick: importImg }, "Importer une image…"),
        el("span", { style: "flex:1" }),
        el("button", { class: "btn", onclick: () => saveNew(false) }, "Enregistrer"),
        el("button", { class: "btn accent", onclick: () => saveNew(true) }, "Enregistrer et placer")),
    );
  });
}

const BUILTIN = [
  { label: "APPROUVÉ", color: "#15803d" }, { label: "REÇU", color: "#1d4ed8" }, { label: "PAYÉ", color: "#15803d" },
  { label: "REFUSÉ", color: "#b91c1c" }, { label: "CONFIDENTIEL", color: "#b91c1c" }, { label: "COPIE", color: "#6d28d9" },
  { label: "URGENT", color: "#c2410c" }, { label: "VU", color: "#0e7490" }, { label: "BROUILLON", color: "#475569" },
];

export const today = () => new Date().toLocaleDateString("fr-FR");

/** Fenêtre « Tampon » : renvoie {label, color, date?}. */
export function stampDialog() {
  return modal((m, close) => {
    let custom = load(STAMP_KEY);
    const withDate = el("input", { type: "checkbox", checked: "" });
    const grid = el("div", { class: "stamps" });
    const pick = (st) => close({ ...st, date: withDate.checked ? today() : null });
    const render = () => {
      grid.replaceChildren(...[...BUILTIN, ...custom].map((st) =>
        el("button", { class: "stamp-btn", style: `color:${st.color};border-color:${st.color}`, onclick: () => pick(st) }, st.label)));
    };
    render();
    const name = el("input", { type: "text", placeholder: "Texte du tampon (ex. TRAITÉ PAR LH)" });
    const color = el("input", { type: "color", value: "#0e7490" });
    const add = () => {
      const label = name.value.trim().toUpperCase();
      if (!label) return;
      custom.push({ label, color: color.value }); store(STAMP_KEY, custom);
      name.value = ""; render();
    };
    m.append(
      el("h2", {}, "🔖 Tampon"),
      grid,
      el("label", { class: "row" }, withDate, "Ajouter la date du jour (" + today() + ")"),
      el("div", { class: "row" }, name, color, el("button", { class: "btn", onclick: add }, "Créer")),
      custom.length ? el("button", { class: "btn", style: "align-self:flex-start", onclick: () => { custom = []; store(STAMP_KEY, custom); render(); } }, "Effacer mes tampons personnalisés") : null,
    );
  });
}

export { imgRatio };

/**
 * Prépare une signature collée/importée : fond blanc (ou gris clair d'un scan) rendu
 * transparent, puis marges rognées. Renvoie { src, ratio } ou null.
 */
async function cleanSignature(blob, removeBg) {
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { return null; }
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  if (removeBg) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum > 215) d[i + 3] = 0;                                  // fond : transparent
      else if (lum > 160) d[i + 3] = Math.round(d[i + 3] * (215 - lum) / 55); // bords adoucis
    }
    ctx.putImageData(img, 0, 0);
  }
  return trimCanvas(c);
}
