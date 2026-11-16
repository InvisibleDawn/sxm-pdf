// Interface en anglais : parcourt l'accueil, le ruban et les fenêtres principales et vérifie
// qu'aucun texte français ne reste affiché. Lancer : npm run test:e2e
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fs from "node:fs";
const root = process.cwd();
const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => p && fs.existsSync(p));
const server = await createServer({ root, logLevel: "silent", server: { port: 5197 } });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
page.on("pageerror", (e) => console.log("PAGEERR", e.message));
await page.addInitScript(() => {
  localStorage.setItem("sxm.lang", "en");
  const files = new Map(); window.__fs = files;
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: () => 1, unregisterCallback: () => {}, convertFileSrc: (p) => p,
    invoke: async (c, a) => {
      if (c === "data_load") return JSON.stringify({ "sxm.welcomed": "1" });
      if (c === "startup_args") return [];
      if (c === "check_tools") return { qpdf: true, libreoffice: true };
      if (c === "read_bytes") return files.get(a.path).slice().buffer;
      if (c === "plugin:event|listen") return 1;
      return null; } };
});
await page.goto("http://localhost:5197/");
await page.waitForTimeout(1500);
const pdf = await PDFDocument.create(); const f = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 3; i++) pdf.addPage([595, 842]).drawText("Page " + (i + 1), { x: 72, y: 760, size: 24, font: f });
const bytes = [...await pdf.save()];
const FRW = /[éèêàçùôîâûœ«»]|\b(le|la|les|des|du|une|un|pour|avec|sur|dans|vos|votre|est|sont|pas|ou|et|au|aux|ce|cette|à)\b/i;
const { EN } = await import(root + "/src/i18n-en.js");
const enWords = new Set(Object.values(EN).join(" ").toLowerCase().match(/[a-zà-ÿ]{4,}/g));
const frVocab = new Set(Object.keys(EN).join(" ").toLowerCase().match(/[a-zà-ÿ]{4,}/g).filter((w) => !enWords.has(w)));
const isFr = (t) => FRW.test(t) || (t.toLowerCase().match(/[a-zà-ÿ]{4,}/g) || []).some((w) => frVocab.has(w));
const found = new Map();
async function collect(where) {
  const list = await page.evaluate(() => {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const e = n.nodeType === 1 ? n : n.parentElement;
      if (e.closest(".pdfViewer, script, style, pre")) continue;
      if (n.nodeType === 3) { const t = n.nodeValue.trim(); if (t) out.push(t); }
      else for (const a of ["title", "placeholder", "aria-label", "data-tip"]) { const v = n.getAttribute(a); if (v) out.push("@" + a + ": " + v); }
      if (n.nodeType === 1 && n.tagName === "OPTION") out.push(n.textContent);
    }
    return out;
  });
  for (const t of list) if (isFr(t.replace(/^@[\w-]+: /, "")) && !found.has(t)) found.set(t, where);
}
async function escAll() { for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); } }
await collect("accueil");
await page.evaluate(async (data) => { window.__fs.set("/d/test.pdf", new Uint8Array(data)); await (await import("/src/tabs.js")).openPaths(["/d/test.pdf"]); }, bytes);
await page.waitForTimeout(1200);
await collect("document ouvert");
for (const p of ["home", "annotate", "sign", "pages", "tools"]) {
  await page.evaluate((p) => document.querySelector(`.rib-tabs [data-rib="${p}"]`)?.click(), p);
  await page.waitForTimeout(200); await collect("ruban " + p);
}
await page.evaluate(() => [...document.querySelectorAll(".rib-tabs button")].forEach((b) => b.click()));
await collect("ruban (tous)");
const acts = ["signature", "stamp", "paraphe", "watermark", "search-redact", "batch", "merge", "split", "protect", "extract", "about", "more", "menu"];
for (const a of acts) {
  await page.evaluate((a) => document.querySelector(`[data-act="${a}"]`)?.click(), a);
  await page.waitForTimeout(700); await collect("action " + a);
  if (a === "about") { await page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => /DejaVu/.test(b.textContent))?.click()); await page.waitForTimeout(400); await collect("licence"); }
  await escAll();
}
await page.evaluate(() => document.querySelector('[data-menu="more"]')?.click());
await page.waitForTimeout(300); await collect("menu ⋯");
await page.evaluate(async () => { const t = (await import("/src/core.js")).tab(); t.dirty = true; (await import("/src/tabs.js")).closeTab(t); });
await page.waitForTimeout(500); await collect("fermeture");
await browser.close(); await server.close();

test("anglais : aucun texte français à l'accueil, dans le ruban et les fenêtres principales", () => {
  found.delete("Français"); // nom de la langue dans le choix de langue
  assert.deepEqual([...found], []);
});
