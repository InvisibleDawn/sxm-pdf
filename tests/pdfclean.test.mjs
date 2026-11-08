// Tests du nettoyage réel des PDF (masquage, suppression de pages). Lancer : npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { purgeUnreachable, removePageClean } from "../src/pdfclean.js";

const SECRET = "NIR 1850578006084";
const SECRET_FIELD = "FR7630006000011234567890189";
const hex = (s) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

/** Cherche un texte dans TOUS les objets du fichier (flux décompressés compris), en clair ou en hexadécimal. */
async function contains(bytes, text) {
  const raw = Buffer.from(bytes).toString("latin1");
  if (raw.includes(text) || raw.toUpperCase().includes(hex(text))) return true;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) { const t = obj.toString(); if (t.includes(text) || t.toUpperCase().includes(hex(text))) return true; continue; }
    let s;
    try { s = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"); } catch { continue; }
    if (s.includes(text) || s.toUpperCase().includes(hex(text))) return true;
  }
  return false;
}

/** PDF de 2 pages : page 1 = secret en texte + champ de formulaire rempli + signet vers la page 1. */
async function fixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p1 = pdf.addPage([595, 842]);
  p1.drawText(SECRET, { x: 72, y: 760, size: 14, font });
  const p2 = pdf.addPage([595, 842]);
  p2.drawText("Page publique", { x: 72, y: 760, size: 14, font });
  const form = pdf.getForm();
  const f1 = form.createTextField("iban"); f1.setText(SECRET_FIELD); f1.addToPage(p1, { x: 72, y: 700 });
  const f2 = form.createTextField("ville"); f2.setText("Marigot"); f2.addToPage(p2, { x: 72, y: 700 });
  // Signet pointant vers la page 1 (cas qui retenait la page supprimée)
  const ctx = pdf.context;
  const outline = ctx.obj({ Type: "Outlines" });
  const outlineRef = ctx.register(outline);
  const item = ctx.obj({ Title: PDFString.of("Page 1"), Parent: outlineRef, Dest: [p1.ref, PDFName.of("Fit")] });
  const itemRef = ctx.register(item);
  outline.set(PDFName.of("First"), itemRef); outline.set(PDFName.of("Last"), itemRef);
  pdf.catalog.set(PDFName.of("Outlines"), outlineRef);
  return pdf.save();
}

test("témoin : sans nettoyage, pdf-lib garde la page supprimée dans le fichier", async () => {
  const pdf = await PDFDocument.load(await fixture());
  pdf.removePage(0);
  const out = await pdf.save();
  assert.equal(await contains(out, SECRET), true, "le défaut S1/I2 doit être reproduit par ce test");
});

test("suppression de page : le texte de la page n'est plus dans le fichier", async () => {
  const pdf = await PDFDocument.load(await fixture());
  removePageClean(pdf, 0);
  assert.equal(pdf.getPages().length, 1, "liste des pages de pdf-lib à jour");
  const removed = await purgeUnreachable(pdf);
  const out = await pdf.save();
  assert.ok(removed > 0);
  assert.equal(await contains(out, SECRET), false, "texte de la page supprimée");
  assert.equal(await contains(out, SECRET_FIELD), false, "valeur du champ de la page supprimée");
  // le reste est intact
  const back = await PDFDocument.load(out);
  assert.equal(back.getPageCount(), 1);
  assert.equal(await contains(out, "Page publique"), true);
  assert.deepEqual(back.getForm().getFields().map((f) => f.getName()), ["ville"]);
  assert.equal(back.getForm().getTextField("ville").getText(), "Marigot");
});

test("masquage : page remplacée par une image (même séquence que applyRedactions)", async () => {
  const pdf = await PDFDocument.load(await fixture());
  const np = pdf.insertPage(0, [595, 842]);
  np.drawRectangle({ x: 0, y: 0, width: 595, height: 842 }); // tient lieu de l'image rendue
  removePageClean(pdf, 1);
  await purgeUnreachable(pdf);
  const out = await pdf.save();
  assert.equal(await contains(out, SECRET), false);
  assert.equal(await contains(out, SECRET_FIELD), false);
  assert.equal((await PDFDocument.load(out)).getPageCount(), 2);
});

test("nettoyage sans suppression : aucun contenu perdu, fichier relisible", async () => {
  const src = await fixture();
  const pdf = await PDFDocument.load(src);
  await purgeUnreachable(pdf); // retire seulement d'anciennes apparences de champs laissées par pdf-lib
  const out = await pdf.save();
  assert.equal(await contains(out, SECRET), true);
  assert.equal(await contains(out, SECRET_FIELD), true);
  const back = await PDFDocument.load(out);
  assert.equal(back.getPageCount(), 2);
  assert.equal(back.getForm().getFields().length, 2);
  // chaque zone de champ garde une apparence valide (sinon le champ s'afficherait vide)
  for (const f of back.getForm().getFields())
    for (const w of f.acroField.getWidgets()) assert.ok(back.context.lookup(w.getNormalAppearance()), "apparence du champ " + f.getName());
});

test("polices ajoutées juste avant le nettoyage : conservées", async () => {
  const pdf = await PDFDocument.load(await fixture());
  const font = await pdf.embedFont(StandardFonts.TimesRoman); // pas encore écrite (flush)
  pdf.getPage(1).drawText("Ajout après coup", { x: 72, y: 600, size: 12, font });
  await purgeUnreachable(pdf);
  const out = await pdf.save();
  assert.equal(await contains(out, "Ajout après coup"), true);
  assert.equal(await contains(out, "Times-Roman"), true);
});

test("plusieurs pages masquées à la suite : la bonne page est retirée à chaque fois", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const t of ["SECRET-A", "PUBLIC-B", "SECRET-C"]) pdf.addPage([300, 300]).drawText(t, { x: 20, y: 200, size: 12, font });
  const doc = await PDFDocument.load(await pdf.save());
  for (const i of [0, 2]) { // même boucle que applyRedactions
    doc.insertPage(i, [300, 300]);
    removePageClean(doc, i + 1);
  }
  await purgeUnreachable(doc);
  const out = await doc.save();
  assert.equal(await contains(out, "SECRET-A"), false);
  assert.equal(await contains(out, "SECRET-C"), false);
  assert.equal(await contains(out, "PUBLIC-B"), true);
  assert.equal((await PDFDocument.load(out)).getPageCount(), 3);
});
