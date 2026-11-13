// Deux PDF de test : un PDF texte (comme un document Word) et un PDF scanné (page = image seule).
import fs from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
const dir = process.argv[2]; fs.mkdirSync(dir, { recursive: true });
const t = await PDFDocument.create(); const f = await t.embedFont(StandardFonts.Helvetica);
const p = t.addPage([595, 842]);
p.drawText("Contrat de travail a duree indeterminee", { x: 72, y: 760, size: 20, font: f });
p.drawText("Article 1 : le salarie est engage en qualite de technicien informatique.", { x: 72, y: 720, size: 12, font: f });
fs.writeFileSync(dir + "/texte.pdf", await t.save());
const s = await PDFDocument.create(); const ps = s.addPage([595, 842]);
// « scan » : une image (PNG gris) sans aucun texte
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAG7buVgAAAABJRU5ErkJggg==", "base64");
ps.drawImage(await s.embedPng(png), { x: 40, y: 40, width: 515, height: 762 });
ps.drawRectangle({ x: 72, y: 740, width: 300, height: 14, color: rgb(0.2, 0.2, 0.2) });
fs.writeFileSync(dir + "/scan.pdf", await s.save());
console.log("PDF de test écrits dans", dir);
