// Calque d'annotations (dessin, sélection, texte) et outils.
import { toast, el, askText, confirmBox, busy, modal } from "./ui.js";
import * as io from "./io.js";
import { drawOverlay, writeAnnots, shift, norm, newId, viewBox, LABELS, BOXY, pixelate } from "./annots.js";
import { signatureDialog, stampDialog, imgRatio } from "./sign.js";
import { $, $$, DRAW_TOOLS, MARK_TOOLS, opt, state, tab } from "./core.js";
import { reloadKeepingView, renderAnnotList } from "./pages.js";
import { markDirty } from "./tabs.js";

// ======================================================================= Calque d'annotations

export function pageView(t, i) { return t.viewer.getPageView(i); }

export function renderOverlay(t, i) {
  const pv = pageView(t, i);
  if (!pv?.div || !pv.viewport) return;
  let svg = pv.div.querySelector("svg.sxm-overlay");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("sxm-overlay");
    attachOverlayEvents(t, i, svg);
    pv.div.append(svg);
  }
  svg.dataset.page = i;
  drawOverlay(svg, pv.viewport, t.annots.filter((a) => a.page === i), t.selected, pv.canvas || pv.div.querySelector("canvas"));
}

export function refreshAll(t = tab()) {
  if (!t) return;
  for (let i = 0; i < t.viewer.pagesCount; i++) renderOverlay(t, i);
  renderAnnotList();
}

export function pushUndo(t, structural = false) {
  t.undo.push({ annots: structuredClone(t.annots), bytes: structural ? t.bytes : null });
  if (t.undo.length > 60) t.undo.shift();
  t.redo = [];
  markDirty(t);
}

export async function undoRedo(redo) {
  const t = tab(); if (!t) return;
  const from = redo ? t.redo : t.undo, to = redo ? t.undo : t.redo;
  const snap = from.pop(); if (!snap) return;
  to.push({ annots: structuredClone(t.annots), bytes: snap.bytes ? t.bytes : null });
  t.annots = snap.annots; t.selected = null;
  if (snap.bytes) await reloadKeepingView(t, snap.bytes);
  refreshAll(t); markDirty(t);
}

export const pdfPoint = (pv, e) => {
  const r = pv.div.getBoundingClientRect();
  return pv.viewport.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
};

export function attachOverlayEvents(t, _i, svg) {
  svg.addEventListener("pointerdown", async (e) => {
    if (e.button !== 0) return;
    const i = +svg.dataset.page;
    const pv = pageView(t, i);
    const [px, py] = pdfPoint(pv, e);
    const o = opt();

    // ---- Placement d'une signature / tampon / image
    if (state.pending) {
      e.preventDefault();
      const p = state.pending;
      const w = p.w, h = p.h;
      pushUndo(t);
      const a = { id: newId(), page: i, ...p.annot, x1: px - w / 2, y1: py - h / 2, x2: px + w / 2, y2: py + h / 2 };
      t.annots.push(a); t.selected = a.id;
      if (!e.shiftKey) { state.pending = null; setTool("select"); }
      return refreshAll(t);
    }

    // ---- Outils de dessin
    if (DRAW_TOOLS.includes(state.tool)) {
      e.preventDefault();
      if (state.tool === "text" || state.tool === "note") {
        const a = state.tool === "text"
          ? { id: newId(), page: i, type: "text", x: px, y: py, text: "", size: o.size, color: o.color }
          : { id: newId(), page: i, type: "note", x: px - 10, y: py + 10, text: "", color: "#facc15" };
        const ok = await editText(t, a, true);
        if (ok) setTool("select");
        return;
      }
      svg.setPointerCapture(e.pointerId);
      const lasso = state.tool === "lasso";
      const a = { id: newId(), page: i, type: lasso ? "ink" : state.tool, color: state.tool === "hlarea" ? state.hlColor : o.color, width: o.width };
      if (a.type === "redact") a.mode = $("#redactmode").value;
      if (lasso) { a.closed = true; a.fill = $("#lassofill").checked; }
      if (a.type === "ink") a.points = [[px, py]];
      else Object.assign(a, { x1: px, y1: py, x2: px, y2: py });
      t.annots.push(a);
      const move = (ev) => {
        const [qx, qy] = pdfPoint(pv, ev);
        if (a.type === "ink") a.points.push([qx, qy]); else { a.x2 = qx; a.y2 = qy; }
        renderOverlay(t, i);
      };
      const up = () => {
        svg.removeEventListener("pointermove", move);
        svg.removeEventListener("pointerup", up);
        t.annots.pop();
        const tiny = a.type === "ink" ? a.points.length < 2 : Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3;
        if (tiny) return renderOverlay(t, i);
        if (["rect", "ellipse", "hlarea", "redact"].includes(a.type)) Object.assign(a, norm(a.x1, a.y1, a.x2, a.y2));
        pushUndo(t);
        t.annots.push(a);
        refreshAll(t);
      };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerup", up);
      return;
    }

    // ---- Sélection, déplacement, redimensionnement
    const handle = e.target.closest("[data-handle]");
    const g = e.target.closest("g.annot");
    if (!handle && !g) { if (t.selected) { t.selected = null; refreshAll(t); } return; }
    e.preventDefault(); e.stopPropagation();
    const a = t.annots.find((x) => x.id === (handle ? handle.dataset.handle : g.dataset.id));
    if (!a) return;
    t.selected = a.id; renderAnnotList();
    const before = structuredClone(t.annots);
    let changed = false;
    svg.setPointerCapture(e.pointerId);
    let last = [px, py];
    const startBox = viewBox(pv.viewport, a);
    const ratio = a.ratio || startBox.w / Math.max(1, startBox.h);
    const move = (ev) => {
      const [qx, qy] = pdfPoint(pv, ev);
      if (handle) {
        // coin opposé fixe (haut-gauche à l'écran)
        const [fx, fy] = pv.viewport.convertToPdfPoint(startBox.x, startBox.y);
        const r = pv.div.getBoundingClientRect();
        let vw = Math.max(12, ev.clientX - r.left - startBox.x), vh = Math.max(12, ev.clientY - r.top - startBox.y);
        if (["image", "signature", "stamp"].includes(a.type)) vh = vw / ratio;
        const [qx2, qy2] = pv.viewport.convertToPdfPoint(startBox.x + vw, startBox.y + vh);
        Object.assign(a, norm(fx, fy, qx2, qy2));
      } else {
        shift(a, qx - last[0], qy - last[1]);
        last = [qx, qy];
      }
      changed = true;
      renderOverlay(t, i);
    };
    const up = () => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      if (changed) { t.undo.push({ annots: before, bytes: null }); t.redo = []; markDirty(t); }
      refreshAll(t);
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
  });

  svg.addEventListener("dblclick", (e) => {
    const g = e.target.closest("g.annot");
    const a = g && t.annots.find((x) => x.id === g.dataset.id);
    if (a && (a.type === "text" || a.type === "note")) editText(t, a, false);
  });
}

/** Édition en place d'un texte ou d'une note (zone de saisie sur la page). */
export function editText(t, a, isNew) {
  return new Promise((resolve) => {
    const pv = pageView(t, a.page);
    const [vx, vy] = pv.viewport.convertToViewportPoint(a.x, a.y);
    const ta = el("textarea", { class: "inline-edit", placeholder: a.type === "note" ? "Votre commentaire…" : "Tapez votre texte…" });
    ta.value = a.text || "";
    const sc = pv.viewport.scale;
    ta.style.left = vx + (a.type === "note" ? 24 * sc : 0) + "px";
    ta.style.top = vy + "px";
    if (a.type === "text") { ta.style.fontSize = a.size * sc + "px"; ta.style.color = a.color; }
    pv.div.append(ta);
    ta.focus();
    let done = false;
    const commit = (keep) => {
      if (done) return; done = true;
      ta.remove();
      const text = ta.value.replace(/\s+$/, "");
      if (!keep || (!text && isNew)) return resolve(false);
      pushUndo(t);
      if (!text) t.annots = t.annots.filter((x) => x.id !== a.id);
      else { a.text = text; if (isNew) t.annots.push(a); t.selected = a.id; }
      refreshAll(t); resolve(true);
    };
    ta.addEventListener("blur", () => commit(true));
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") commit(false);
      if (e.key === "Enter" && e.ctrlKey) commit(true);
    });
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  });
}

// ---- Annotations sur le texte sélectionné (surligner, souligner, barrer)
export function selectionRects(t) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const node = sel.anchorNode?.parentElement;
  if (!node || !t.container.contains(node)) return null;
  const byPage = new Map();
  for (const r of sel.getRangeAt(0).getClientRects()) {
    if (r.width < 1 || r.height < 2) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < t.viewer.pagesCount; i++) {
      const pv = pageView(t, i);
      if (!pv?.div) continue;
      const pr = pv.div.getBoundingClientRect();
      if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
      const [x1, y1] = pv.viewport.convertToPdfPoint(r.left - pr.left, r.top - pr.top);
      const [x2, y2] = pv.viewport.convertToPdfPoint(r.right - pr.left, r.bottom - pr.top);
      const n = norm(x1, y1, x2, y2);
      if (!byPage.has(i)) byPage.set(i, []);
      byPage.get(i).push([n.x1, n.y1, n.x2, n.y2]);
      break;
    }
  }
  return byPage.size ? byPage : null;
}

export function mergeRects(rects) {
  // fusionne les morceaux d'une même ligne pour un rendu propre
  rects.sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const out = [];
  for (const r of rects) {
    const l = out.at(-1);
    if (l && Math.abs(l[1] - r[1]) < 2 && Math.abs(l[3] - r[3]) < 2 && r[0] <= l[2] + 3) l[2] = Math.max(l[2], r[2]);
    else out.push([...r]);
  }
  return out;
}

export function applyMark(type) {
  const t = tab(); if (!t) return;
  const byPage = selectionRects(t);
  if (!byPage) return;
  pushUndo(t);
  const color = type === "highlight" ? state.hlColor : opt().color;
  for (const [page, rects] of byPage) t.annots.push({ id: newId(), page, type, color, rects: mergeRects(rects) });
  window.getSelection().removeAllRanges();
  $("#sel-pop").classList.add("hidden");
  refreshAll(t);
}

document.addEventListener("mouseup", (e) => {
  if (e.target.closest("#sel-pop")) return;
  setTimeout(() => {
    const t = tab(); if (!t) return;
    if (MARK_TOOLS.includes(state.tool)) return applyMark(state.tool);
    const sel = window.getSelection();
    const pop = $("#sel-pop");
    if (state.tool !== "select" || !sel || sel.isCollapsed || !selectionRects(t)) return pop.classList.add("hidden");
    const r = sel.getRangeAt(0).getBoundingClientRect();
    pop.style.left = Math.max(8, r.left + r.width / 2 - 150) + "px";
    pop.style.top = Math.max(8, r.top - 46) + "px";
    pop.classList.remove("hidden");
  }, 10);
});
$("#sel-pop").addEventListener("mousedown", (e) => e.preventDefault());
// ---- Pages scannées (image, sans texte) : rien à sélectionner. Surligner / Souligner / Barrer
// tracent alors un rectangle sur la zone, au lieu de ne rien faire sans explication.
function pageHasText(pv) {
  const tl = pv?.div?.querySelector(".textLayer");
  return !tl || tl.textContent.trim().length > 0; // couche de texte pas encore prête : on ne touche à rien
}
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || state.pending) return;
  const t = tab(); if (!t) return;
  const pageDiv = e.target.closest?.(".page");
  if (!pageDiv || !t.container.contains(pageDiv)) return;
  if (state.tool !== "select" && !MARK_TOOLS.includes(state.tool)) return;
  if (e.target.closest("g.annot, [data-handle]")) return; // déplacement d'une annotation existante
  const i = +pageDiv.dataset.pageNumber - 1;
  const pv = pageView(t, i);
  if (!pv || pageHasText(pv)) return;
  if (state.tool === "select") {
    if (!t.scanTip) { t.scanTip = true; toast("Cette page est une image (document scanné) : il n'y a pas de texte à sélectionner.\nPour surligner, choisissez Surligner puis tracez un rectangle sur la zone."); }
    return;
  }
  e.preventDefault(); e.stopPropagation();
  if (!t.scanMarkTip) { t.scanMarkTip = true; toast("Document scanné : tracez un rectangle sur la zone à " + ({ highlight: "surligner", underline: "souligner", strike: "barrer" })[state.tool] + "."); }
  const [x0, y0] = pdfPoint(pv, e);
  const a = { id: newId(), page: i, type: state.tool, color: state.tool === "highlight" ? state.hlColor : opt().color, rects: [[x0, y0, x0, y0]] };
  t.annots.push(a);
  const move = (ev) => {
    const [x, y] = pdfPoint(pv, ev);
    const n = norm(x0, y0, x, y);
    a.rects = [[n.x1, n.y1, n.x2, n.y2]];
    renderOverlay(t, i);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    t.annots.pop();
    const [x1, y1, x2, y2] = a.rects[0];
    if (Math.abs(x2 - x1) < 3 || Math.abs(y2 - y1) < 3) return renderOverlay(t, i);
    pushUndo(t);
    t.annots.push(a);
    refreshAll(t);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}, true);

$("#sel-pop").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.mark === "copy") {
    try { await navigator.clipboard.writeText(window.getSelection().toString()); toast("Texte copié."); } catch { document.execCommand("copy"); }
    $("#sel-pop").classList.add("hidden");
  } else applyMark(b.dataset.mark);
});

// ======================================================================= Outils

export function setTool(tl) {
  state.tool = tl;
  if (tl !== "place") state.pending = null;
  $$("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === tl));
  applyToolCursor();
}
export function applyToolCursor() {
  for (const t of state.tabs) {
    t.container.classList.toggle("drawing", DRAW_TOOLS.includes(state.tool));
    t.container.classList.toggle("placing", !!state.pending);
  }
}
export async function startPlacing(annot, w, h, hint) {
  if (!tab()) return toast("Ouvrez d'abord un PDF.", true);
  setTool("place");
  state.pending = { annot, w, h };
  applyToolCursor();
  toast(hint + "\nAstuce : Maj+clic pour en placer plusieurs, Échap pour arrêter.");
}

export async function doSignature() {
  if (!tab()) return toast("Ouvrez d'abord un PDF.", true);
  const sg = await signatureDialog();
  if (!sg) return;
  const ratio = sg.ratio || (await imgRatio(sg.src));
  const w = 150;
  startPlacing({ type: "signature", src: sg.src, ratio }, w, w / ratio, "Cliquez sur la page pour placer la signature.");
}
export async function doStamp() {
  if (!tab()) return toast("Ouvrez d'abord un PDF.", true);
  const st = await stampDialog();
  if (!st) return;
  const w = Math.max(120, st.label.length * 15), h = st.date ? 54 : 40;
  startPlacing({ type: "stamp", label: st.label, color: st.color, date: st.date, ratio: w / h }, w, h, "Cliquez sur la page pour poser le tampon.");
}
export async function placeImageDataUrl(src, pxW, pxH) {
  const ratio = pxW / pxH;
  const w = Math.min(320, pxW * 0.75);
  startPlacing({ type: "image", src, ratio }, w, w / ratio, "Cliquez sur la page pour placer l'image.");
}
export async function doInsertImage() {
  if (!tab()) return toast("Ouvrez d'abord un PDF.", true);
  const p = await io.pickImages(false); if (!p) return;
  const bytes = await io.readFile(p);
  const mime = io.ext(p) === "png" ? "image/png" : "image/jpeg";
  const src = await blobToDataUrl(new Blob([bytes], { type: mime }));
  const im = await loadImg(src);
  placeImageDataUrl(src, im.naturalWidth, im.naturalHeight);
}
export const blobToDataUrl = (b) => new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
export const loadImg = (src) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = src; });

export function deleteSelected() {
  const t = tab(); if (!t?.selected) return;
  pushUndo(t);
  t.annots = t.annots.filter((a) => a.id !== t.selected);
  t.selected = null; refreshAll(t);
}
