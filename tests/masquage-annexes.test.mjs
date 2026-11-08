// Masquage : données annexes retirées (propriétés, XMP, pièces jointes, JavaScript). Lancer : npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFString, StandardFonts, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { purgeUnreachable, stripSensitiveExtras } from "../src/pdfclean.js";

async function contains(bytes, text) {
  // texte cherché en clair, en hexadécimal latin-1 et en hexadécimal UTF-16 (propriétés du fichier)
  const hexes = [Buffer.from(text, "latin1").toString("hex").toUpperCase(), Buffer.from(text, "utf16le").swap16().toString("hex").toUpperCase()];
  const hit = (s) => s.includes(text) || hexes.some((h) => s.toUpperCase().includes(h));
  const raw = Buffer.from(bytes).toString("latin1");
  if (hit(raw)) return true;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) { if (hit(o.toString())) return true; continue; } // objets compressés (object streams)
    let s; try { s = Buffer.from(decodePDFRawStream(o).decode()).toString("latin1"); } catch { continue; }
    if (hit(s)) return true;
  }
  return false;
}

async function fixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([595, 842]);
  p.drawText("Contenu visible conserve", { x: 72, y: 760, size: 14, font });
  pdf.setTitle("Licenciement Dupont NIR185057800608");
  pdf.setAuthor("Sylviane RH confidentiel");
  pdf.setKeywords(["salaire-42000"]);
  const xmp = pdf.context.flateStream("<x:xmpmeta>XMP-SECRET-DUPONT</x:xmpmeta>", { Type: "Metadata", Subtype: "XML" });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(xmp));
  await pdf.attach(Buffer.from("PIECE-JOINTE-BULLETIN-PAIE"), "bulletin.txt", { mimeType: "text/plain" });
  pdf.addJavaScript("ouverture", "app.alert('JS-SECRET-SCRIPT');");
  // signet conservé
  const ctx = pdf.context;
  const outline = ctx.obj({ Type: "Outlines" }); const oref = ctx.register(outline);
  const item = ctx.register(ctx.obj({ Title: PDFString.of("Signet garde"), Parent: oref, Dest: [p.ref, PDFName.of("Fit")] }));
  outline.set(PDFName.of("First"), item); outline.set(PDFName.of("Last"), item);
  pdf.catalog.set(PDFName.of("Outlines"), oref);
  return pdf.save();
}

test("témoin : sans nettoyage, propriétés, XMP, pièce jointe et script sont dans le fichier", async () => {
  const b = await fixture();
  for (const s of ["NIR185057800608", "XMP-SECRET-DUPONT", "PIECE-JOINTE-BULLETIN-PAIE", "JS-SECRET-SCRIPT"]) assert.equal(await contains(b, s), true, s);
});

test("masquage : données annexes retirées, contenu et signets conservés", async () => {
  const pdf = await PDFDocument.load(await fixture());
  const r = stripSensitiveExtras(pdf);
  await purgeUnreachable(pdf);
  const out = await pdf.save();
  assert.equal(r.metadata, true);
  assert.ok(r.attachments >= 1 && r.javascript >= 1);
  for (const s of ["NIR185057800608", "Sylviane", "salaire-42000", "XMP-SECRET-DUPONT", "PIECE-JOINTE-BULLETIN-PAIE", "JS-SECRET-SCRIPT"])
    assert.equal(await contains(out, s), false, `« ${s} » ne doit plus être dans le fichier`);
  assert.equal(await contains(out, "Contenu visible conserve"), true);
  assert.equal(await contains(out, "Signet garde"), true);
  const back = await PDFDocument.load(out);
  assert.equal(back.getPageCount(), 1);
  assert.equal(back.getTitle(), undefined);
});

test("PDF sans données annexes : rien à retirer, fichier intact", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const doc = await PDFDocument.load(await pdf.save({ updateMetadata: false }));
  const r = stripSensitiveExtras(doc);
  assert.deepEqual({ a: r.attachments, j: r.javascript }, { a: 0, j: 0 });
  assert.equal((await PDFDocument.load(await doc.save())).getPageCount(), 1);
});
