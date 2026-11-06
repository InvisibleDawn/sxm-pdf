// Modèle d'annotation, affichage (SVG) et écriture dans le PDF (pdf-lib).
// Les coordonnées sont stockées dans l'espace PDF (points, origine en bas à gauche),
// ce qui les rend indépendantes du zoom et de la rotation d'affichage.
import { rgb, degrees, BlendMode, StandardFonts, PDFHexString, PDFName, LineCapStyle } from "pdf-lib";

const NS = "http://www.w3.org/2000/svg";
export const BOXY = ["rect", "ellipse", "image", "signature", "stamp", "hlarea", "redact"];
export const UPRIGHT = ["text", "note", "image", "signature", "stamp"];

export const LABELS = {
  highlight: "Surlignage", underline: "Soulignement", strike: "Barré", hlarea: "Zone surlignée",
  text: "Texte", note: "Note", ink: "Dessin", rect: "Rectangle", ellipse: "Ellipse",
  arrow: "Flèche", line: "Ligne", signature: "Signature", stamp: "Tampon", image: "Image", redact: "Zone masquée",
};

let seq = 1;
export const newId = () => "a" + Date.now().toString(36) + (seq++);

export const norm = (x1, y1, x2, y2) => ({
  x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2),
});

/** Points PDF significatifs d'une annotation (pour la boîte englobante). */
export function annotPoints(a) {
  switch (a.type) {
    case "highlight": case "underline": case "strike":
      return a.rects.flatMap((r) => [[r[0], r[1]], [r[2], r[3]]]);
    case "ink": return a.points;
    case "text": {
      const lines = (a.text || " ").split("\n");
      const w = Math.max(...lines.map((l) => l.length), 2) * a.size * 0.55;
      const h = lines.length * a.size * 1.25;
      return [[a.x, a.y], [a.x + w, a.y - h]]; // approximatif (sert à la sélection)
    }
    case "note": return [[a.x, a.y], [a.x + 20, a.y - 20]];
    default: return [[a.x1, a.y1], [a.x2, a.y2]];
  }
}

export function viewBox(vp, a) {
  const pts = annotPoints(a).map(([x, y]) => vp.convertToViewportPoint(x, y));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** Déplace une annotation de (dx, dy) en unités PDF. */
export function shift(a, dx, dy) {
  if (a.rects) a.rects = a.rects.map(([x1, y1, x2, y2]) => [x1 + dx, y1 + dy, x2 + dx, y2 + dy]);
  if (a.points) a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
  if ("x1" in a) { a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; }
  if ("x" in a) { a.x += dx; a.y += dy; }
}

function s(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Dessine les annotations d'une page dans le SVG superposé. */
export function drawOverlay(svg, vp, annots, selectedId, pageCanvas = null) {
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${vp.width} ${vp.height}`);
  const sc = vp.scale;
  const P = (x, y) => vp.convertToViewportPoint(x, y);
  const box = (a) => {
    const [ax, ay] = P(a.x1, a.y1), [bx, by] = P(a.x2, a.y2);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  };

  for (const a of annots) {
    const g = s("g", { class: "annot" + (BOXY.includes(a.type) || UPRIGHT.includes(a.type) ? " boxy" : ""), "data-id": a.id });
    const sw = (a.width || 2) * sc;
    switch (a.type) {
      case "redact": {
        const b = box(a);
        if (a.mode === "black" || !pageCanvas) {
          g.append(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: "#000" }));
        } else {
          const k = pageCanvas.width / vp.width;
          const src = pixelate(pageCanvas, b.x * k, b.y * k, b.w * k, b.h * k);
          if (src) g.append(s("image", { href: src, x: b.x, y: b.y, width: b.w, height: b.h, preserveAspectRatio: "none" }));
          g.append(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: "transparent", stroke: "#64748b", "stroke-width": 1, "stroke-dasharray": "3 3" }));
        }
        break;
      }
      case "highlight":
        for (const r of a.rects) {
          const b = box({ x1: r[0], y1: r[1], x2: r[2], y2: r[3] });
          g.append(s("rect", { ...b, width: b.w, height: b.h, fill: a.color, "fill-opacity": 0.4, class: "hl" }));
        }
        break;
      case "hlarea": {
        const b = box(a);
        g.append(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: a.color, "fill-opacity": 0.4, class: "hl" }));
        break;
      }
      case "underline": case "strike":
        for (const r of a.rects) {
          const b = box({ x1: r[0], y1: r[1], x2: r[2], y2: r[3] });
          const y = a.type === "underline" ? b.y + b.h - 1 : b.y + b.h * 0.55;
          g.append(s("line", { x1: b.x, x2: b.x + b.w, y1: y, y2: y, stroke: a.color, "stroke-width": Math.max(1.2, b.h * 0.08) }));
          g.append(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: "transparent" }));
        }
        break;
      case "ink":
        g.append(s(a.closed ? "polygon" : "polyline", {
          points: a.points.map(([x, y]) => P(x, y).join(",")).join(" "),
          fill: a.closed && a.fill ? a.color : "none", "fill-opacity": 0.18, stroke: a.color, "stroke-width": sw, "stroke-linecap": "round", "stroke-linejoin": "round",
        }));
        break;
      case "rect": { const b = box(a); g.append(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: "none", stroke: a.color, "stroke-width": sw })); break; }
      case "ellipse": { const b = box(a); g.append(s("ellipse", { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2, fill: "none", stroke: a.color, "stroke-width": sw })); break; }
      case "line": case "arrow": {
        const [x1, y1] = P(a.x1, a.y1), [x2, y2] = P(a.x2, a.y2);
        g.append(s("line", { x1, y1, x2, y2, stroke: a.color, "stroke-width": sw, "stroke-linecap": "round" }));
        g.append(s("line", { x1, y1, x2, y2, stroke: "transparent", "stroke-width": Math.max(12, sw * 3) }));
        if (a.type === "arrow") {
          const ang = Math.atan2(y2 - y1, x2 - x1), L = Math.max(10, sw * 4);
          const p1 = [x2 - L * Math.cos(ang - 0.45), y2 - L * Math.sin(ang - 0.45)];
          const p2 = [x2 - L * Math.cos(ang + 0.45), y2 - L * Math.sin(ang + 0.45)];
          g.append(s("polygon", { points: `${x2},${y2} ${p1} ${p2}`, fill: a.color }));
        }
        break;
      }
      case "text": {
        const [x, y] = P(a.x, a.y);
        const fs = a.size * sc;
        const t = s("text", { x, y, fill: a.color, "font-size": fs, "font-family": "Helvetica, Arial, sans-serif" });
        (a.text || "").split("\n").forEach((line, i) => {
          const sp = s("tspan", { x, dy: i === 0 ? fs * 0.9 : fs * 1.25 });
          sp.textContent = line || " ";
          t.append(sp);
        });
        g.append(t);
        const b = viewBox(vp, a);
        g.append(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: "transparent" }));
        break;
      }
      case "note": {
        const [x, y] = P(a.x, a.y), z = 20 * sc;
        g.append(s("rect", { x, y, width: z, height: z, rx: 3 * sc, fill: a.color || "#facc15", stroke: "#a16207", "stroke-width": 1 }));
        g.append(s("path", { d: `M${x + z * .22},${y + z * .32}h${z * .56}M${x + z * .22},${y + z * .5}h${z * .56}M${x + z * .22},${y + z * .68}h${z * .36}`, stroke: "#713f12", "stroke-width": Math.max(1, sc * 1.4) }));
        const title = s("title", {}); title.textContent = a.text || ""; g.append(title);
        break;
      }
      case "image": case "signature": {
        const b = box(a);
        g.append(s("image", { href: a.src, x: b.x, y: b.y, width: b.w, height: b.h, preserveAspectRatio: "none" }));
        break;
      }
      case "stamp": {
        const b = box(a);
        g.append(s("rect", { x: b.x + 2, y: b.y + 2, width: b.w - 4, height: b.h - 4, rx: 6 * sc, fill: a.color, "fill-opacity": 0.06, stroke: a.color, "stroke-width": 3 * sc }));
        const lines = stampLines(a);
        const fs = stampFontSize(a) * sc;
        stampBaselines(lines.length, b.y + b.h / 2, fs).forEach(([y, size], i) => {
          const line = lines[i];
          const t = s("text", {
            x: b.x + b.w / 2, y,
            fill: a.color, "font-size": size, "font-weight": 700, "text-anchor": "middle",
            "font-family": "Helvetica, Arial, sans-serif",
          });
          t.textContent = line;
          g.append(t);
        });
        break;
      }
    }
    svg.append(g);

    if (a.id === selectedId) {
      const b = viewBox(vp, a);
      svg.append(s("rect", { class: "selbox", x: b.x - 3, y: b.y - 3, width: b.w + 6, height: b.h + 6 }));
      if (BOXY.includes(a.type)) svg.append(s("rect", { class: "handle", "data-handle": a.id, x: b.x + b.w - 5, y: b.y + b.h - 5, width: 10, height: 10, rx: 2 }));
    }
  }
}

export const stampLines = (a) => (a.date ? [a.label, a.date] : [a.label]);
/** Lignes de base (écran) du tampon, centrées verticalement : [[y, taille], …] */
export function stampBaselines(n, cy, fs) {
  if (n === 1) return [[cy + fs * 0.35, fs]];
  const top = cy - (fs + fs * 0.2 + fs * 0.55) / 2;
  return [[top + fs * 0.82, fs], [top + fs * 1.2 + fs * 0.55 * 0.82, fs * 0.55]];
}
export const stampFontSize = (a) => {
  const h = Math.abs(a.y2 - a.y1), w = Math.abs(a.x2 - a.x1);
  return Math.min(h * (a.date ? 0.4 : 0.52), (w * 1.18) / Math.max(4, a.label.length));
};

// ------------------------------------------------------------------ écriture PDF

const hex = (c) => {
  const n = parseInt((c || "#000000").slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** Remplace les caractères que la police standard ne sait pas encoder. */
function safe(font, text) {
  let out = "";
  for (const ch of text) {
    try { font.encodeText(ch); out += ch; } catch { out += ch === "’" ? "'" : "?"; }
  }
  return out;
}

async function dataUrlBytes(src) {
  const r = await fetch(src);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Écrit les annotations dans le document pdf-lib.
 * getViewport(i) doit renvoyer le viewport pdf.js (échelle 1) de la page i.
 */
export async function writeAnnots(pdf, annots, getViewport) {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const images = new Map();
  const pages = pdf.getPages();

  for (const a of annots) {
    const page = pages[a.page];
    if (!page || a.type === "redact") continue; // les zones masquées sont traitées à part
    const color = hex(a.color);
    const w = a.width || 2;
    const vp = await getViewport(a.page);
    const rot = vp.rotation || 0;
    // Point PDF correspondant à un point de l'écran (échelle 1)
    const V2P = (vx, vy) => vp.convertToPdfPoint(vx, vy);
    const vbox = () => viewBox(vp, a);

    switch (a.type) {
      case "highlight": case "hlarea": {
        const rects = a.rects || [[a.x1, a.y1, a.x2, a.y2]];
        for (const [x1, y1, x2, y2] of rects)
          page.drawRectangle({ x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), color, opacity: 0.4, blendMode: BlendMode.Multiply });
        break;
      }
      case "underline": case "strike":
        for (const r of a.rects) {
          const b = viewBox(vp, { type: "rect", x1: r[0], y1: r[1], x2: r[2], y2: r[3] });
          const y = a.type === "underline" ? b.y + b.h - 0.8 : b.y + b.h * 0.55;
          page.drawLine({ start: pt(V2P(b.x, y)), end: pt(V2P(b.x + b.w, y)), thickness: Math.max(0.8, b.h * 0.07), color });
        }
        break;
      case "ink": {
        const pts = a.closed ? [...a.points, a.points[0]] : a.points;
        if (a.closed && a.fill) {
          const d = "M" + pts.map(([x, y]) => `${x},${-y}`).join(" L") + " Z";
          page.drawSvgPath(d, { x: 0, y: 0, color, opacity: 0.18, blendMode: BlendMode.Multiply });
        }
        for (let i = 1; i < pts.length; i++)
          page.drawLine({ start: pt(pts[i - 1]), end: pt(pts[i]), thickness: w, color, lineCap: LineCapStyle.Round });
        break;
      }
      case "rect":
        page.drawRectangle({ x: a.x1, y: a.y1, width: a.x2 - a.x1, height: a.y2 - a.y1, borderColor: color, borderWidth: w });
        break;
      case "ellipse":
        page.drawEllipse({ x: (a.x1 + a.x2) / 2, y: (a.y1 + a.y2) / 2, xScale: (a.x2 - a.x1) / 2, yScale: (a.y2 - a.y1) / 2, borderColor: color, borderWidth: w });
        break;
      case "line": case "arrow": {
        page.drawLine({ start: { x: a.x1, y: a.y1 }, end: { x: a.x2, y: a.y2 }, thickness: w, color, lineCap: LineCapStyle.Round });
        if (a.type === "arrow") {
          const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1), L = Math.max(8, w * 4);
          for (const d of [-0.45, 0.45])
            page.drawLine({ start: { x: a.x2, y: a.y2 }, end: { x: a.x2 - L * Math.cos(ang + d), y: a.y2 - L * Math.sin(ang + d) }, thickness: w, color, lineCap: LineCapStyle.Round });
        }
        break;
      }
      case "text": {
        const [vx, vy] = vp.convertToViewportPoint(a.x, a.y);
        (a.text || "").split("\n").forEach((line, i) => {
          const p = V2P(vx, vy + a.size * 0.9 + i * a.size * 1.25);
          page.drawText(safe(font, line), { x: p[0], y: p[1], size: a.size, font, color, rotate: degrees(rot) });
        });
        break;
      }
      case "note": {
        // Vraie note PDF : visible et lisible dans tous les lecteurs (Acrobat, Foxit…)
        const annot = pdf.context.obj({
          Type: "Annot", Subtype: "Text", Rect: [a.x, a.y - 20, a.x + 20, a.y],
          Contents: PDFHexString.fromText(a.text || ""), T: PDFHexString.fromText("SXM PDF"),
          Name: "Comment", C: [0.98, 0.8, 0.08], F: 4, Open: false,
        });
        page.node.addAnnot(pdf.context.register(annot));
        break;
      }
      case "image": case "signature": {
        let img = images.get(a.src);
        if (!img) {
          const bytes = await dataUrlBytes(a.src);
          img = a.src.startsWith("data:image/jp") ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
          images.set(a.src, img);
        }
        const b = vbox();
        const p = V2P(b.x, b.y + b.h); // coin bas-gauche à l'écran
        page.drawImage(img, { x: p[0], y: p[1], width: b.w, height: b.h, rotate: degrees(rot) });
        break;
      }
      case "stamp": {
        const b = vbox();
        const o = V2P(b.x + 2, b.y + b.h - 2);
        page.drawRectangle({ x: o[0], y: o[1], width: b.w - 4, height: b.h - 4, borderColor: color, borderWidth: 3, color, opacity: 0.06, borderOpacity: 1, rotate: degrees(rot) });
        const lines = stampLines(a), fs = stampFontSize(a);
        stampBaselines(lines.length, b.y + b.h / 2, fs).forEach(([cy, size], i) => {
          const f = bold;
          const text = safe(f, lines[i]);
          const tw = f.widthOfTextAtSize(text, size);
          const p = V2P(b.x + b.w / 2 - tw / 2, cy);
          page.drawText(text, { x: p[0], y: p[1], size, font: f, color, rotate: degrees(rot) });
        });
        break;
      }
    }
  }
  return pdf;
}

const pt = (p) => ({ x: p[0], y: p[1] });
export { PDFName };

/**
 * Pixellise une zone d'un canevas source. Renvoie une image (dataURL) ou, si
 * target est fourni, dessine directement dedans aux mêmes coordonnées.
 */
export function pixelate(src, x, y, w, h, target = null) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.round(Math.min(w, src.width - x)); h = Math.round(Math.min(h, src.height - y));
  if (w < 2 || h < 2) return null;
  const block = Math.max(14, Math.round(Math.min(w, h) / 4));
  const tiny = document.createElement("canvas");
  tiny.width = Math.max(1, Math.round(w / block)); tiny.height = Math.max(1, Math.round(h / block));
  tiny.getContext("2d").drawImage(src, x, y, w, h, 0, 0, tiny.width, tiny.height);
  if (target) {
    const c = target.getContext("2d");
    c.imageSmoothingEnabled = false;
    c.drawImage(tiny, 0, 0, tiny.width, tiny.height, x, y, w, h);
    c.imageSmoothingEnabled = true;
    return null;
  }
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const c = out.getContext("2d");
  c.imageSmoothingEnabled = false;
  c.drawImage(tiny, 0, 0, w, h);
  return out.toDataURL("image/png");
}
