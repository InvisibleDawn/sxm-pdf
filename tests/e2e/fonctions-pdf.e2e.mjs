// Tests de bout en bout des fonctions PDF de SXM PDF, dans un vrai navigateur (Chrome sans écran).
// L'interface réelle est chargée par Vite ; Tauri est remplacé par un faux système de fichiers en
// mémoire et des boîtes de dialogue préprogrammées. Chaque fichier « enregistré » est relu ici avec
// pdf-lib pour vérifier le résultat. Lancer : npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
  .find((p) => p && fs.existsSync(p));

let server, browser, page;

// ------------------------------------------------------------------ faux Tauri (dans la page)
const FAKE_TAURI = () => {
  const files = new Map(); // chemin → Uint8Array
  const dialogs = [];      // réponses préprogrammées des boîtes « Ouvrir / Enregistrer / Dossier »
  window.__fs = files;
  window.__dialogs = dialogs;
  let cb = 0;
  const callbacks = {};
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (fn) => { const id = ++cb; callbacks[id] = fn; return id; },
    unregisterCallback: (id) => delete callbacks[id],
    convertFileSrc: (p) => p,
    invoke: async (cmd, args, opts) => {
      switch (cmd) {
        case "read_bytes": {
          const f = files.get(args.path);
          if (!f) throw `Fichier introuvable : ${args.path}`;
          return f.slice().buffer;
        }
        case "write_bytes": files.set(decodeURIComponent(opts.headers["x-path"]), new Uint8Array(args)); return null;
        case "unique_path": {
          if (!files.has(args.path)) return args.path;
          const m = args.path.match(/^(.*?)(\.[^.\/]+)?$/);
          for (let n = 2; ; n++) { const c = `${m[1]} (${n})${m[2] || ""}`; if (!files.has(c)) return c; }
        }
        case "plugin:dialog|open": case "plugin:dialog|save": return dialogs.shift() ?? null;
        case "data_load": return JSON.stringify({ "sxm.welcomed": "1" });
        case "data_save": return null;
        case "startup_args": return [];
        case "check_tools": return { qpdf: false, libreoffice: false };
        case "temp_path": return "/tmp/sxm-pdf/envoi/" + args.name;
        case "remove_temp": files.delete(args.path); return null;
        case "plugin:event|listen": return 1;
        case "plugin:event|unlisten": return null;
        default: return null;
      }
    },
  };
};

// ------------------------------------------------------------------ outils côté Node
async function makePdf(texts) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const t of texts) pdf.addPage([595, 842]).drawText(t, { x: 72, y: 760, size: 24, font });
  return pdf.save();
}

/** Textes (Tj/TJ en hexadécimal ou en clair) de chaque page, dans l'ordre. */
async function pageTexts(bytes) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((p) => {
    const c = p.node.Contents();
    const streams = c instanceof PDFRawStream ? [c] : c ? c.asArray().map((r) => pdf.context.lookup(r)) : [];
    let s = "";
    for (const st of streams) if (st instanceof PDFRawStream) s += Buffer.from(decodePDFRawStream(st).decode()).toString("latin1");
    const hex = [...s.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"));
    const lit = [...s.matchAll(/\(([^)]*)\)\s*Tj/g)].map((m) => m[1]);
    return { text: [...hex, ...lit].join(" "), ops: s };
  });
}

/** Ouvre un PDF (octets) dans l'appli via le vrai chemin d'ouverture ; renvoie le chemin. */
async function openInApp(name, bytes) {
  const path = "/docs/" + name;
  await page.evaluate(async ({ path, data }) => {
    window.__fs.set(path, new Uint8Array(data));
    const tabs = await import("/src/tabs.js");
    await tabs.openPaths([path]);
  }, { path, data: [...bytes] });
  await page.waitForFunction(async () => (await import("/src/core.js")).tab()?.viewer?.pagesCount > 0);
  return path;
}

/** Enregistre l'onglet actif (vrai saveTab) et renvoie les octets écrits. */
async function saveActive(path) {
  const ok = await page.evaluate(async () => (await import("/src/save.js")).saveTab());
  assert.equal(ok, true, "l'enregistrement doit réussir");
  return Buffer.from(await page.evaluate((p) => [...window.__fs.get(p)], path));
}

/** Clique le bouton principal de la fenêtre qui s'ouvre (confirmation). */
async function acceptModal() {
  await page.waitForSelector(".modal .btn.accent", { timeout: 5000 });
  await page.click(".modal .btn.accent");
}

async function closeAll() {
  await page.evaluate(async () => {
    const core = await import("/src/core.js");
    for (const t of [...core.state.tabs]) { t.dirty = false; await (await import("/src/tabs.js")).closeTab(t); }
  });
}

// ------------------------------------------------------------------ mise en place
before(async () => {
  if (!CHROME) throw new Error("Chrome introuvable (variable CHROME_PATH)");
  server = await createServer({ logLevel: "error", server: { port: 0, strictPort: false }, clearScreen: false });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => console.error("Erreur dans la page :", e.message));
  await page.addInitScript(FAKE_TAURI);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#ribbon"));
});

after(async () => {
  await browser?.close();
  await server?.close();
});

// ------------------------------------------------------------------ tests
test("ouvrir puis enregistrer sans modification : document identique", async () => {
  const path = await openInApp("simple.pdf", await makePdf(["Page A", "Page B"]));
  const out = await saveActive(path);
  const t = await pageTexts(out);
  assert.deepEqual(t.map((p) => p.text), ["Page A", "Page B"]);
  await closeAll();
});

test("document non modifié : Ctrl+S ne réécrit pas le fichier", async () => {
  const src = await makePdf(["Intact"]);
  const path = await openInApp("intact.pdf", src);
  await page.evaluate((p) => window.__fs.set(p, new Uint8Array([1, 2, 3])), path); // marqueur
  const ok = await page.evaluate(async () => (await import("/src/save.js")).saveTab());
  assert.equal(ok, true);
  assert.deepEqual(await page.evaluate((p) => [...window.__fs.get(p)], path), [1, 2, 3], "aucune écriture");
  await closeAll();
});

test("annotations : surlignage, texte, stylo, cadre, flèche, note — écrits dans le fichier", async () => {
  const path = await openInApp("annot.pdf", await makePdf(["Contrat de travail"]));
  await page.evaluate(async () => {
    const core = await import("/src/core.js"); const ed = await import("/src/editor.js");
    const t = core.tab(); const id = () => Math.random().toString(36).slice(2);
    ed.pushUndo(t); // comme l'interface : l'ajout marque le document « modifié »
    t.annots.push(
      { id: id(), page: 0, type: "highlight", color: "#ffd400", rects: [[70, 755, 300, 785]] },
      { id: id(), page: 0, type: "text", color: "#d92d20", x: 100, y: 600, size: 14, text: "Vu et approuvé" },
      { id: id(), page: 0, type: "ink", color: "#1d4ed8", width: 2, points: [[100, 500], [150, 520], [200, 500]] },
      { id: id(), page: 0, type: "rect", color: "#16a34a", width: 2, x1: 90, y1: 400, x2: 300, y2: 450 },
      { id: id(), page: 0, type: "arrow", color: "#ea580c", width: 2, x1: 320, y1: 420, x2: 420, y2: 470 },
      { id: id(), page: 0, type: "note", color: "#facc15", x: 500, y: 800, text: "Note RH" });
    ed.refreshAll(t);
  });
  const out = await saveActive(path);
  const [p] = await pageTexts(out);
  assert.match(p.text, /Contrat de travail/);
  assert.match(p.text, /Vu et approuv/);
  assert.match(p.ops, /1 0\.83\d* 0 rg/, "surlignage jaune (remplissage)");
  assert.ok((p.ops.match(/ RG\b/g) || []).length >= 3, "traits colorés : stylo, cadre, flèche");
  assert.ok((p.ops.match(/\bS\b/g) || []).length >= 4, "tracés dessinés");
  const doc = await PDFDocument.load(out);
  const annots = doc.getPage(0).node.Annots();
  assert.ok(annots && annots.size() === 1, "la note est une vraie annotation PDF");
  await closeAll();
});

test("signature (image) et tampon daté", async () => {
  const path = await openInApp("signature.pdf", await makePdf(["Bon pour accord"]));
  await page.evaluate(async () => {
    const core = await import("/src/core.js"); const ed = await import("/src/editor.js");
    const t = core.tab();
    const c = document.createElement("canvas"); c.width = 200; c.height = 80;
    const x = c.getContext("2d"); x.strokeStyle = "#0f172a"; x.lineWidth = 4; x.beginPath(); x.moveTo(10, 60); x.bezierCurveTo(60, 0, 120, 90, 190, 20); x.stroke();
    ed.pushUndo(t);
    t.annots.push(
      { id: "sig", page: 0, type: "signature", src: c.toDataURL("image/png"), x1: 350, y1: 100, x2: 500, y2: 160 },
      { id: "tp", page: 0, type: "stamp", color: "#16a34a", label: "REÇU", date: "08/11/2026", x1: 60, y1: 100, x2: 220, y2: 170 });
    ed.refreshAll(t);
  });
  const out = await saveActive(path);
  const doc = await PDFDocument.load(out);
  const xobj = doc.getPage(0).node.Resources().lookup(PDFName.of("XObject"));
  assert.ok(xobj && xobj.keys().length >= 1, "image de la signature présente");
  const [p] = await pageTexts(out);
  assert.match(p.text, /RE.U/);
  assert.match(p.text, /08\/11\/2026/);
  await closeAll();
});

test("rotation, déplacement et suppression de pages, puis Annuler", async () => {
  const path = await openInApp("pages.pdf", await makePdf(["UN", "DEUX", "TROIS"]));
  await page.evaluate(async () => (await import("/src/pages.js")).rotatePage(1, 90));
  await page.evaluate(async () => (await import("/src/pages.js")).movePage(2, 0)); // TROIS en premier
  // supprime DEUX (désormais 3e) — la confirmation est posée par le bouton de la miniature
  await page.evaluate(async () => (await import("/src/pages.js")).deletePage(2));
  let out = await saveActive(path);
  let doc = await PDFDocument.load(out);
  assert.deepEqual((await pageTexts(out)).map((p) => p.text), ["TROIS", "UN"]);
  assert.equal(doc.getPage(0).getRotation().angle, 0);
  // « DEUX » (page tournée puis supprimée) n'est plus nulle part dans le fichier
  assert.equal(Buffer.from(out).toString("latin1").includes(Buffer.from("DEUX").toString("hex").toUpperCase()), false);
  // Annuler la suppression : DEUX revient avec sa rotation
  await page.evaluate(async () => (await import("/src/editor.js")).undoRedo(false));
  await page.waitForFunction(async () => (await import("/src/core.js")).tab().viewer.pagesCount === 3);
  out = await saveActive(path);
  doc = await PDFDocument.load(out);
  assert.deepEqual((await pageTexts(out)).map((p) => p.text), ["TROIS", "UN", "DEUX"]);
  assert.equal(doc.getPage(2).getRotation().angle, 90);
  await closeAll();
});

test("fusion de deux PDF puis division en fichiers d'une page", async () => {
  await page.evaluate(async ({ a, b }) => {
    window.__fs.set("/docs/a.pdf", new Uint8Array(a)); window.__fs.set("/docs/b.pdf", new Uint8Array(b));
    window.__dialogs.push(["/docs/a.pdf", "/docs/b.pdf"]);
  }, { a: [...(await makePdf(["A1", "A2"]))], b: [...(await makePdf(["B1"]))] });
  const merge = page.evaluate(async () => (await import("/src/pages.js")).mergePdfs());
  await acceptModal(); await merge;
  // enregistrer la fusion
  await page.evaluate(() => window.__dialogs.push("/docs/fusion.pdf"));
  const ok = await page.evaluate(async () => (await import("/src/save.js")).saveTab());
  assert.equal(ok, true);
  const fused = Buffer.from(await page.evaluate(() => [...window.__fs.get("/docs/fusion.pdf")]));
  assert.deepEqual((await pageTexts(fused)).map((p) => p.text), ["A1", "A2", "B1"]);
  // diviser : 1 page par fichier, dans /out
  await page.evaluate(() => window.__dialogs.push("/out"));
  const split = page.evaluate(async () => (await import("/src/pages.js")).splitPdf());
  await acceptModal(); await split;
  const names = await page.evaluate(() => [...window.__fs.keys()].filter((k) => k.startsWith("/out/")).sort());
  assert.equal(names.length, 3, names.join(", "));
  for (const [i, n] of names.entries()) {
    const b = Buffer.from(await page.evaluate((p) => [...window.__fs.get(p)], n));
    assert.deepEqual((await pageTexts(b)).map((p) => p.text), [["A1", "A2", "B1"][i]]);
  }
  // diviser une 2e fois : aucun fichier existant écrasé
  await page.evaluate(() => window.__dialogs.push("/out"));
  const split2 = page.evaluate(async () => (await import("/src/pages.js")).splitPdf());
  await acceptModal(); await split2;
  const after2 = await page.evaluate(() => [...window.__fs.keys()].filter((k) => k.startsWith("/out/")).length);
  assert.equal(after2, 6, "les 3 nouveaux fichiers portent un nom libre « (2) »");
  await closeAll();
});

test("masquage : texte et propriétés absents du fichier enregistré", async () => {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  src.addPage([595, 842]).drawText("NIR 185057800608436", { x: 72, y: 760, size: 18, font });
  src.setTitle("Dossier Dupont");
  const path = await openInApp("masque.pdf", await src.save());
  await page.evaluate(async () => {
    const core = await import("/src/core.js"); const ed = await import("/src/editor.js");
    const t = core.tab();
    ed.pushUndo(t);
    t.annots.push({ id: "r", page: 0, type: "redact", mode: "black", x1: 60, y1: 740, x2: 400, y2: 790 });
    ed.refreshAll(t);
  });
  const saving = page.evaluate(async () => (await import("/src/save.js")).saveTab());
  await acceptModal(); // « masquage définitif » : confirmer
  assert.equal(await saving, true);
  const out = Buffer.from(await page.evaluate((p) => [...window.__fs.get(p)], path));
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getTitle(), undefined);
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    let s = o.toString();
    if (o instanceof PDFRawStream) { try { s = Buffer.from(decodePDFRawStream(o).decode()).toString("latin1"); } catch { s = ""; } }
    assert.equal(s.includes("185057800608436") || s.toUpperCase().includes(Buffer.from("185057800608436").toString("hex").toUpperCase()), false);
  }
  await closeAll();
});

test("deux enregistrements lancés en même temps : fichier final valide", async () => {
  const path = await openInApp("concurrence.pdf", await makePdf(["X"]));
  await page.evaluate(async () => {
    const core = await import("/src/core.js"); const ed = await import("/src/editor.js");
    ed.pushUndo(core.tab());
    core.tab().annots.push({ id: "c", page: 0, type: "text", color: "#000000", x: 100, y: 600, size: 12, text: "Ajout" });
  });
  const res = await page.evaluate(async () => {
    const s = await import("/src/save.js");
    return Promise.all([s.saveTab(), s.saveTab()]);
  });
  assert.ok(res.some(Boolean));
  const out = Buffer.from(await page.evaluate((p) => [...window.__fs.get(p)], path));
  const [p] = await pageTexts(out);
  assert.match(p.text, /Ajout/);
  await closeAll();
});
