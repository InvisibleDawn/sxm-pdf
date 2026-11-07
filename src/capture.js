// Éditeur de capture : recadrer, flèches, cadres, texte, flou, numéros d'étapes, surligneur.
import { modal, el, askText, toast } from "./ui.js";
import { createElement, Crop, MoveUpRight, Square, Highlighter, Type, Grid3x3, Hash, Undo2, Redo2, Copy, Download, Pin, FilePlus2, X, Scissors, Plus } from "lucide";

const icon = (node, size = 18) => createElement(node, { width: size, height: size, "stroke-width": 2 });

// Outils : [id, icône, nom, raccourci, astuce]
const TOOLS = [
  ["crop", Crop, "Recadrer", "C", "Tracez la zone à garder"],
  ["arrow", MoveUpRight, "Flèche", "A", "Glissez pour tracer une flèche"],
  ["rect", Square, "Cadre", "R", "Glissez pour encadrer"],
  ["hl", Highlighter, "Surligner", "H", "Glissez pour surligner"],
  ["text", Type, "Texte", "T", "Cliquez où placer le texte"],
  ["blur", Grid3x3, "Flouter", "F", "Glissez sur ce qu'il faut cacher"],
  ["num", Hash, "Étapes numérotées", "N", "Cliquez pour poser 1, 2, 3…"],
];
const SWATCHES = ["#e11d48", "#f97316", "#facc15", "#16a34a", "#2563eb", "#7c3aed", "#111827"];

/**
 * Ouvre l'éditeur sur une image (Uint8Array PNG).
 * Résout avec { action: "page" | "place" | "save" | "copy", png, dataUrl, w, h } ou null.
 */
export async function captureEditor(bytes, hasDoc) {
  const blob = new Blob([bytes], { type: "image/png" });
  const base = await createImageBitmap(blob);

  return modal((m, close) => {
    const ops = [];
    let crop = null; // {x,y,w,h} en pixels image
    let tool = "arrow", color = "#e11d48", num = 1, cur = null;

    const canvas = el("canvas");
    const stage = el("div", { class: "cap-stage" }, canvas);
    const ctx = canvas.getContext("2d");
    let scale = 1;

    const fit = () => {
      const r = stage.getBoundingClientRect();
      scale = Math.min((r.width - 30) / base.width, (r.height - 90) / base.height, 1);
      canvas.width = Math.round(base.width * scale);
      canvas.height = Math.round(base.height * scale);
      redraw();
    };

    // Dessin d'une opération sur un contexte à l'échelle k
    const drawOp = (c, op, k) => {
      c.save();
      c.strokeStyle = c.fillStyle = op.color;
      c.lineWidth = 4 * k; c.lineCap = "round"; c.lineJoin = "round";
      const x = op.x * k, y = op.y * k, w = (op.w || 0) * k, h = (op.h || 0) * k;
      switch (op.type) {
        case "rect": c.strokeRect(x, y, w, h); break;
        case "hl": c.globalAlpha = 0.35; c.fillStyle = "#facc15"; c.fillRect(x, y, w, h); break;
        case "arrow": {
          const x2 = x + w, y2 = y + h, ang = Math.atan2(h, w), L = 18 * k;
          c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke();
          c.beginPath(); c.moveTo(x2, y2);
          c.lineTo(x2 - L * Math.cos(ang - 0.45), y2 - L * Math.sin(ang - 0.45));
          c.lineTo(x2 - L * Math.cos(ang + 0.45), y2 - L * Math.sin(ang + 0.45));
          c.closePath(); c.fill();
          break;
        }
        case "blur": {
          // pixellisation : on réduit puis on agrandit la zone sans lissage
          const sx = Math.min(op.x, op.x + op.w), sy = Math.min(op.y, op.y + op.h);
          const sw = Math.abs(op.w), sh = Math.abs(op.h);
          if (sw < 2 || sh < 2) break;
          const px = Math.max(6, Math.round(Math.min(sw, sh) / 10));
          const tmp = document.createElement("canvas");
          tmp.width = Math.max(1, Math.round(sw / px)); tmp.height = Math.max(1, Math.round(sh / px));
          tmp.getContext("2d").drawImage(base, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
          c.imageSmoothingEnabled = false;
          c.drawImage(tmp, sx * k, sy * k, sw * k, sh * k);
          break;
        }
        case "num": {
          const r = 16 * k;
          c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
          c.fillStyle = "#fff"; c.font = `bold ${18 * k}px sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
          c.fillText(String(op.n), x, y + 1 * k);
          break;
        }
        case "text": {
          c.font = `bold ${22 * k}px sans-serif`; c.textBaseline = "top";
          c.lineWidth = 5 * k; c.strokeStyle = "#fff";
          op.text.split("\n").forEach((line, i) => { c.strokeText(line, x, y + i * 26 * k); c.fillText(line, x, y + i * 26 * k); });
          break;
        }
      }
      c.restore();
    };

    const redraw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
      for (const op of ops) if (op.type === "blur") drawOp(ctx, op, scale);
      for (const op of ops) if (op.type !== "blur") drawOp(ctx, op, scale);
      if (cur) drawOp(ctx, cur, scale);
      const cr = cur?.type === "crop" ? cur : crop;
      if (cr) {
        const x = Math.min(cr.x, cr.x + cr.w) * scale, y = Math.min(cr.y, cr.y + cr.h) * scale;
        const w = Math.abs(cr.w) * scale, h = Math.abs(cr.h) * scale;
        ctx.save(); ctx.fillStyle = "rgba(0,0,0,.5)";
        ctx.fillRect(0, 0, canvas.width, y); ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
        ctx.fillRect(0, y, x, h); ctx.fillRect(x + w, y, canvas.width - x - w, h);
        ctx.strokeStyle = "#fff"; ctx.setLineDash([6, 4]); ctx.strokeRect(x, y, w, h); ctx.restore();
      }
    };

    const pos = (e) => [e.offsetX / scale, e.offsetY / scale];
    canvas.addEventListener("pointerdown", async (e) => {
      const [x, y] = pos(e);
      if (tool === "num") { ops.push({ type: "num", x, y, n: num++, color }); return redraw(); }
      if (tool === "text") {
        const t = await askText("Texte à ajouter", "", { multiline: true });
        if (t) { ops.push({ type: "text", x, y, text: t, color }); redraw(); }
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      cur = { type: tool, x, y, w: 0, h: 0, color };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!cur) return;
      const [x, y] = pos(e);
      cur.w = x - cur.x; cur.h = y - cur.y;
      redraw();
    });
    canvas.addEventListener("pointerup", () => {
      if (!cur) return;
      if (Math.abs(cur.w) > 3 || Math.abs(cur.h) > 3) {
        if (cur.type === "crop") crop = { ...cur };
        else {
          if (cur.type !== "arrow") { // normaliser les rectangles
            if (cur.w < 0) { cur.x += cur.w; cur.w = -cur.w; }
            if (cur.h < 0) { cur.y += cur.h; cur.h = -cur.h; }
          }
          ops.push(cur);
        }
      }
      cur = null; redraw();
    });

    /** Image finale (recadrée) en pleine résolution. */
    const exportPng = async () => {
      const full = document.createElement("canvas");
      full.width = base.width; full.height = base.height;
      const c = full.getContext("2d");
      c.drawImage(base, 0, 0);
      for (const op of ops) if (op.type === "blur") drawOp(c, op, 1);
      for (const op of ops) if (op.type !== "blur") drawOp(c, op, 1);
      let out = full;
      if (crop) {
        const x = Math.round(Math.min(crop.x, crop.x + crop.w)), y = Math.round(Math.min(crop.y, crop.y + crop.h));
        const w = Math.round(Math.abs(crop.w)), h = Math.round(Math.abs(crop.h));
        out = document.createElement("canvas"); out.width = w; out.height = h;
        out.getContext("2d").drawImage(full, x, y, w, h, 0, 0, w, h);
      }
      const b = await new Promise((r) => out.toBlob(r, "image/png"));
      return { png: new Uint8Array(await b.arrayBuffer()), dataUrl: out.toDataURL("image/png"), w: out.width, h: out.height, blob: b };
    };

    const finish = async (action) => {
      const res = await exportPng();
      if (action === "copy") {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": res.blob })]);
          toast("Capture copiée dans le presse-papiers.");
        } catch { toast("Copie impossible ici : utilisez « Enregistrer PNG ».", true); }
        return;
      }
      close({ action, ...res });
    };

    // ---- Barre d'outils (icônes, pastilles de couleur, raccourcis clavier)
    const redoStack = [];
    const hint = el("div", { class: "cap-hint" });
    const toolBtns = new Map();
    const setTool = (t) => {
      tool = t;
      for (const [id, b] of toolBtns) b.classList.toggle("on", id === t);
      const d = TOOLS.find((x) => x[0] === t);
      hint.replaceChildren(icon(d[1], 15), el("b", {}, d[2]), el("span", {}, " · " + d[4]));
      hint.classList.remove("pop"); void hint.offsetWidth; hint.classList.add("pop");
    };
    for (const [id, ic, name, key] of TOOLS) {
      const b = el("button", { class: "cap-ic", title: `${name}  (${key})`, onclick: () => setTool(id) });
      b.append(icon(ic));
      toolBtns.set(id, b);
    }
    const swatchBtns = [];
    const setColor = (c) => {
      color = c;
      swatchBtns.forEach((b) => b.classList.toggle("on", b.dataset.c === c));
      custom.style.setProperty("--c", c);
    };
    for (const c of SWATCHES) {
      const b = el("button", { class: "cap-sw", title: "Couleur", style: `--c:${c}`, onclick: () => setColor(c) });
      b.dataset.c = c;
      swatchBtns.push(b);
    }
    const colorIn = el("input", { type: "color", value: color, oninput: (e) => setColor(e.target.value) });
    const custom = el("label", { class: "cap-sw custom", title: "Autre couleur" }, icon(Plus, 13), colorIn);

    const undo = () => {
      const o = ops.pop();
      if (o) { if (o.type === "num") num--; redoStack.push(o); }
      else if (crop) { redoStack.push({ type: "__crop", crop }); crop = null; }
      redraw();
    };
    const redo = () => {
      const o = redoStack.pop(); if (!o) return;
      if (o.type === "__crop") crop = o.crop;
      else { ops.push(o); if (o.type === "num") num++; }
      redraw();
    };
    // toute nouvelle forme vide la pile « rétablir »
    canvas.addEventListener("pointerup", () => { redoStack.length = 0; }, true);

    const act = (ic, label, title, fn, cls = "") =>
      el("button", { class: "cap-act " + cls, title, onclick: fn }, icon(ic, 17), label ? el("span", {}, label) : null);

    const onKey = (e) => {
      if (document.getElementById("modal-root").lastElementChild !== m.parentElement) return; // une autre fenêtre est ouverte
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && k === "y") { e.preventDefault(); redo(); }
      else if (mod && k === "c") { e.preventDefault(); finish("copy"); }
      else if (mod && k === "s") { e.preventDefault(); finish("save"); }
      else if (e.key === "Enter") { e.preventDefault(); finish("page"); }
      else if (!mod && !e.altKey) {
        const d = TOOLS.find((x) => x[3].toLowerCase() === k);
        if (d) { e.preventDefault(); setTool(d[0]); }
      }
    };
    document.addEventListener("keydown", onKey);
    const obs = new MutationObserver(() => { if (!m.isConnected) { document.removeEventListener("keydown", onKey); obs.disconnect(); } });
    obs.observe(document.getElementById("modal-root"), { childList: true });

    m.append(
      el("div", { class: "cap-top" },
        el("div", { class: "cap-title" }, el("span", { class: "cap-logo" }, icon(Scissors, 16)), el("span", {}, "Capture")),
        el("div", { class: "cap-pill" },
          ...toolBtns.values(),
          el("span", { class: "cap-sep" }),
          ...swatchBtns, custom,
          el("span", { class: "cap-sep" }),
          el("button", { class: "cap-ic", title: "Annuler  (Ctrl+Z)", onclick: undo }, icon(Undo2)),
          el("button", { class: "cap-ic", title: "Rétablir  (Ctrl+Maj+Z)", onclick: redo }, icon(Redo2))),
        el("div", { class: "cap-actions" },
          act(Copy, "", "Copier dans le presse-papiers  (Ctrl+C)", () => finish("copy")),
          act(Download, "", "Enregistrer en PNG  (Ctrl+S)", () => finish("save")),
          hasDoc ? act(Pin, "", "Placer sur la page affichée", () => finish("place")) : null,
          act(FilePlus2, hasDoc ? "Ajouter au PDF" : "Créer un PDF", hasDoc ? "Ajouter comme nouvelle page  (Entrée)" : "Créer un PDF avec cette capture  (Entrée)", () => finish("page"), "primary"),
          el("button", { class: "cap-ic close", title: "Fermer  (Échap)", onclick: () => close(null) }, icon(X)))),
      stage,
      hint,
    );
    setColor(color);
    setTool(tool);
    requestAnimationFrame(fit);
    window.addEventListener("resize", fit, { once: true });
  }, { cls: "cap" });
}
