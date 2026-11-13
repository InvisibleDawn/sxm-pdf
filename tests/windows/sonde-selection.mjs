// Sonde « Sélection » dans la VRAIE application sous Windows (WebView2).
// L'application est lancée avec le port de débogage de WebView2 ouvert, puis pilotée par Playwright (CDP) :
//   A) glisser avec la souris simulée (CDP) ; B) glisser avec la VRAIE souris de Windows (SendInput).
// Lancement : node tests/windows/sonde-selection.mjs <app.exe> <pdf-texte> <pdf-scan>
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const [app, pdfText, pdfScan] = process.argv.slice(2);
const log = (...a) => console.log(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function osDrag(x1, y1, x2, y2) {
  const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][M]::SetProcessDPIAware()
[M]::SetCursorPos(${x1},${y1}); Start-Sleep -Milliseconds 300
[M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 200
for ($i=1; $i -le 12; $i++) { [M]::SetCursorPos([int](${x1}+(${x2}-${x1})*$i/12),[int](${y1}+(${y2}-${y1})*$i/12)); Start-Sleep -Milliseconds 40 }
[M]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 300`;
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
}

async function session(pdf, label, port) {
  log(`\n===== ${label} =====`);
  const proc = spawn(app, [pdf], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "inherit" });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(1000); } }
  if (!browser) { log("ÉCHEC : impossible de se connecter à WebView2"); proc.kill(); return; }
  let page;
  for (let i = 0; i < 30 && !page; i++) { page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools")); if (!page) await sleep(500); }
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) log("console", m.type(), m.text().slice(0, 300)); });
  page.on("pageerror", (e) => log("ERREUR PAGE", e.message));
  const js = (f, a) => page.evaluate(f, a);
  try {
    log("url", page.url(), "navigateur", await js(() => navigator.userAgent));
    await page.waitForSelector(".textLayer, .page canvas", { timeout: 30000 }).catch(() => {});
    await sleep(3000);
    await js(() => document.querySelectorAll(".modal-bg").forEach((m) => m.remove()));
    log("écran", await js(() => ({ dpr: devicePixelRatio, inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], screen: [screenX, screenY] })));
    log("spans de texte", await js(() => document.querySelectorAll(".textLayer span").length), "pages", await js(() => document.querySelectorAll(".page").length));
    log("outil actif", await js(() => [...document.querySelectorAll("[data-tool].on")].map((b) => b.dataset.tool)));
    await page.click('[data-tool="select"]:visible');
    log("outil après clic sur Sélection", await js(() => [...document.querySelectorAll("[data-tool].on")].map((b) => b.dataset.tool)));
    const r = await js(() => { const s = [...document.querySelectorAll(".textLayer span")].find((x) => x.textContent.trim().length > 10);
      if (!s) return null; const r = s.getBoundingClientRect(); return { t: s.textContent, x: r.x, y: r.y, w: r.width, h: r.height }; });
    log("1er texte", r);
    if (r) {
      const cx = r.x + 5, cy = r.y + r.h / 2;
      log("éléments sous la souris", await js(([x, y]) => document.elementsFromPoint(x, y).slice(0, 6).map((e) => e.tagName + "." + (e.getAttribute("class") || "") + " pe=" + getComputedStyle(e).pointerEvents + " us=" + getComputedStyle(e).userSelect), [cx, cy]));
      log("styles", await js(() => { const t = document.querySelector(".textLayer"); const s = t.querySelector("span"); const c = getComputedStyle;
        return { tl: { us: c(t).userSelect, pe: c(t).pointerEvents, z: c(t).zIndex }, span: { us: c(s).userSelect, pe: c(s).pointerEvents, color: c(s).color, font: c(s).fontFamily }, body: c(document.body).userSelect, drawing: document.querySelectorAll(".drawing,.placing").length }; }));
      await js(() => { window.__ev = []; for (const t of ["pointerdown", "mousedown", "selectstart", "mouseup", "dragstart"]) addEventListener(t, (e) => window.__ev.push(t + ":" + (e.target.tagName || "") + "." + (e.target.getAttribute?.("class") || "") + (e.defaultPrevented ? "[empêché]" : "")), true); });
      // A) souris simulée (CDP)
      await js(() => getSelection().removeAllRanges());
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(r.x + r.w * 0.6, cy, { steps: 10 }); await page.mouse.up();
      await sleep(400);
      log("A) souris simulée → sélection =", await js(() => getSelection().toString()), "menu =", await js(() => !document.querySelector("#sel-pop").classList.contains("hidden")));
      log("A) événements", await js(() => window.__ev.splice(0)));
      // B) vraie souris Windows
      await js(() => getSelection().removeAllRanges());
      const g = await js(() => { const dpr = devicePixelRatio, bx = (outerWidth - innerWidth) / 2, by = outerHeight - innerHeight - bx; return { dpr, ox: screenX + bx, oy: screenY + by }; });
      const P = (x, y) => [Math.round((g.ox + x) * g.dpr), Math.round((g.oy + y) * g.dpr)];
      await js(() => { window.__hover = null; addEventListener("mousemove", (e) => (window.__hover = [e.clientX, e.clientY, e.target.tagName + "." + (e.target.getAttribute("class") || "")])); });
      const [x1, y1] = P(cx, cy), [x2, y2] = P(r.x + r.w * 0.6, cy);
      log("B) points écran", [x1, y1, x2, y2]);
      osDrag(x1, y1, x2, y2);
      await sleep(600);
      log("B) dernier survol", await js(() => window.__hover));
      log("B) vraie souris → sélection =", await js(() => getSelection().toString()), "menu =", await js(() => !document.querySelector("#sel-pop").classList.contains("hidden")));
      log("B) événements", await js(() => window.__ev.splice(0)));
      // C) double-clic sur un mot
      await js(() => getSelection().removeAllRanges());
      await page.mouse.dblclick(r.x + r.w * 0.3, cy); await sleep(300);
      log("C) double-clic → sélection =", await js(() => getSelection().toString()));
    } else {
      const c = await js(() => { const r = document.querySelector(".page").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 3]; });
      await page.mouse.click(c[0], c[1]); await sleep(800);
      log("scan : messages affichés =", await js(() => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent)));
    }
  } catch (e) { log("ÉCHEC sonde", String(e?.stack || e)); }
  finally { await browser.close().catch(() => {}); proc.kill(); await sleep(1500); }
}

await session(pdfText, "pdf-texte", 9222);
await session(pdfScan, "pdf-scanne", 9223);
process.exit(0);
