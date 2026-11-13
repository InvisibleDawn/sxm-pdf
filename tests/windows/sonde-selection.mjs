// Sonde « Sélection » dans la VRAIE application sous Windows (WebView2), pilotée par tauri-driver.
// 1) glisser avec la souris simulée (WebDriver) ; 2) glisser avec la VRAIE souris de Windows (SendInput).
// Lancement : node tests/windows/sonde-selection.mjs <app.exe> <pdf-texte> <pdf-scan> <dossier-sortie>
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { Builder, By } from "selenium-webdriver";

const [app, pdfText, pdfScan, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(s); fs.appendFileSync(out + "/sonde.txt", s + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Vraie souris Windows : déplacement + bouton gauche via user32 (SetCursorPos / mouse_event). */
function osDrag(x1, y1, x2, y2) {
  const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }
"@
[M]::SetCursorPos(${x1},${y1}); Start-Sleep -Milliseconds 300
[M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 200
for ($i=1; $i -le 12; $i++) { [M]::SetCursorPos([int](${x1}+(${x2}-${x1})*$i/12),[int](${y1}+(${y2}-${y1})*$i/12)); Start-Sleep -Milliseconds 40 }
[M]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 300`;
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
}

async function session(pdf, label) {
  const d = await new Builder()
    .withCapabilities({ browserName: "wry", "tauri:options": { application: app, args: [pdf] } })
    .usingServer("http://127.0.0.1:4444/").build();
  const js = (f, ...a) => d.executeScript(f, ...a);
  const shot = async (n) => fs.writeFileSync(`${out}/${label}-${n}.png`, await d.takeScreenshot(), "base64");
  try {
    await js(`window.__errs = []; window.addEventListener("error", e => window.__errs.push(String(e.message)));
              window.addEventListener("unhandledrejection", e => window.__errs.push(String(e.reason)));`);
    // fenêtre d'accueil du premier lancement
    for (let i = 0; i < 40; i++) { if (await js(`return !!document.querySelector(".textLayer span, .page canvas")`)) break; await sleep(500); }
    await sleep(2500);
    await js(`document.querySelectorAll(".modal-bg").forEach(m => m.remove())`);
    log(`\n===== ${label} =====`);
    log("navigateur", await js(`return navigator.userAgent`), "écran", await js(`return {dpr: devicePixelRatio, inner:[innerWidth,innerHeight], outer:[outerWidth,outerHeight], screen:[screenX,screenY]}`));
    log("spans de texte", await js(`return document.querySelectorAll(".textLayer span").length`));
    log("outil actif", await js(`return [...document.querySelectorAll("[data-tool].on")].map(b=>b.dataset.tool)`));
    // clic (WebDriver) sur le bouton Sélection visible
    const btns = await d.findElements(By.css('[data-tool="select"]'));
    for (const b of btns) if (await b.isDisplayed()) { await b.click(); break; }
    log("outil après clic sur Sélection", await js(`return [...document.querySelectorAll("[data-tool].on")].map(b=>b.dataset.tool)`));
    const r = await js(`const s=[...document.querySelectorAll(".textLayer span")].find(x=>x.textContent.trim().length>10);
      if(!s) return null; const r=s.getBoundingClientRect(); return {t:s.textContent, x:r.x, y:r.y, w:r.width, h:r.height}`);
    log("1er texte", r);
    if (r) {
      const cx = r.x + 5, cy = r.y + r.h / 2;
      log("éléments sous la souris", await js(`return document.elementsFromPoint(${cx}, ${cy}).slice(0,6).map(e => e.tagName + "." + (e.getAttribute("class")||"") + (getComputedStyle(e).pointerEvents==="none"?" [pe:none]":"") + " us=" + getComputedStyle(e).userSelect)`));
      log("styles textLayer", await js(`const t=document.querySelector(".textLayer"); const s=t.querySelector("span"); const c=getComputedStyle;
        return {tl:{us:c(t).userSelect, pe:c(t).pointerEvents, z:c(t).zIndex, op:c(t).opacity}, span:{us:c(s).userSelect, pe:c(s).pointerEvents, color:c(s).color}, conteneurs: [...document.querySelectorAll(".drawing,.placing")].length}`));
      // A) souris WebDriver
      await js(`getSelection().removeAllRanges()`);
      await d.actions({ bridge: true }).move({ x: Math.round(cx), y: Math.round(cy), origin: "viewport" }).press()
        .move({ x: Math.round(r.x + r.w * 0.6), y: Math.round(cy), origin: "viewport", duration: 400 }).release().perform();
      await sleep(400);
      log("A) souris WebDriver → sélection =", await js(`return getSelection().toString()`), "menu =", await js(`return !document.querySelector("#sel-pop").classList.contains("hidden")`));
      await shot("A-webdriver");
      // B) vraie souris Windows
      await js(`getSelection().removeAllRanges()`);
      const g = await js(`const dpr=devicePixelRatio; const bx=(outerWidth-innerWidth)/2; const by=outerHeight-innerHeight-bx;
        return {dpr, ox: screenX + bx, oy: screenY + by}`);
      const P = (x, y) => [Math.round((g.ox + x) * g.dpr), Math.round((g.oy + y) * g.dpr)];
      const [x1, y1] = P(cx, cy), [x2, y2] = P(r.x + r.w * 0.6, cy);
      // vérifie que le point visé tombe bien sur le texte : la souris « survole » et on lit l'élément sous le curseur
      await js(`window.__hover=null; addEventListener("mousemove", e => window.__hover = [e.clientX, e.clientY, e.target.tagName+"."+(e.target.getAttribute("class")||"")], {once:false})`);
      osDrag(x1, y1, x2, y2);
      await sleep(500);
      log("B) vraie souris : dernier survol =", await js(`return window.__hover`));
      log("B) vraie souris → sélection =", await js(`return getSelection().toString()`), "menu =", await js(`return !document.querySelector("#sel-pop").classList.contains("hidden")`));
      await shot("B-vraie-souris");
    } else {
      // document scanné : un clic avec l'outil Sélection doit afficher l'explication
      const c = await js(`const r=document.querySelector(".page").getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/3]`);
      await d.actions({ bridge: true }).move({ x: Math.round(c[0]), y: Math.round(c[1]), origin: "viewport" }).press().release().perform();
      await sleep(600);
      log("scan : messages affichés =", await js(`return [...document.querySelectorAll("#toasts .toast")].map(t=>t.textContent)`));
      await shot("scan");
    }
    log("erreurs JavaScript", await js(`return window.__errs`));
  } catch (e) { log("ÉCHEC sonde", String(e?.stack || e)); try { await shot("echec"); } catch {} }
  finally { await d.quit(); }
}

await session(pdfText, "pdf-texte");
await session(pdfScan, "pdf-scanne");
