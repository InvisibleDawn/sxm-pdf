// Nettoyage réel des PDF (pdf-lib) : pdf-lib garde dans le fichier les objets qui ne sont plus
// utilisés (page supprimée, page d'origine remplacée par une image lors d'un masquage…).
// Ces objets ne s'affichent plus mais restent lisibles avec un outil d'analyse PDF.
// Ce module les retire vraiment. Il ne dépend que de pdf-lib (testable avec Node).
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream } from "pdf-lib";

const N = (s) => PDFName.of(s);
const key = (ref) => ref.toString();

/**
 * Retire du document tout objet qui n'est plus atteignable depuis le catalogue et les informations
 * du fichier. Une page qui ne fait plus partie de l'arborescence des pages n'est jamais conservée,
 * même si un signet, un lien ou une annotation pointe encore vers elle.
 * À appeler juste avant pdf.save(). Renvoie le nombre d'objets retirés.
 */
export async function purgeUnreachable(pdf) {
  await pdf.flush(); // polices et images en attente : leurs objets doivent exister avant le tri
  const ctx = pdf.context;
  // Pages réellement présentes : lues dans l'arborescence du fichier (pdf.getPages() de pdf-lib
  // n'est pas mis à jour après removePage et listerait encore la page retirée).
  const livePages = new Set();
  pdf.catalog.Pages().traverse((node, ref) => { if (node.get(N("Type")) === N("Page")) livePages.add(key(ref)); });
  const seen = new Set();
  const stack = [];
  const t = ctx.trailerInfo;
  for (const v of [t.Root, t.Info, t.Encrypt, t.ID]) if (v) stack.push(v);
  while (stack.length) {
    let v = stack.pop();
    if (v instanceof PDFRef) {
      const k = key(v);
      if (seen.has(k)) continue;
      const obj = ctx.lookup(v);
      if (obj instanceof PDFDict && obj.get(N("Type")) === N("Page") && !livePages.has(k)) continue; // page retirée
      seen.add(k);
      v = obj;
      if (!v) continue;
    }
    if (v instanceof PDFStream) v = v.dict;
    if (v instanceof PDFDict) for (const [, val] of v.entries()) stack.push(val);
    else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(key(ref))) { ctx.delete(ref); removed++; }
  }
  return removed;
}

/** Référence de la page n° index (0 = première), lue dans l'arborescence du fichier. */
function pageRefAt(pdf, index) {
  let n = 0, found = null;
  pdf.catalog.Pages().traverse((node, ref) => {
    if (node.get(N("Type")) === N("Page")) { if (n === index) found = ref; n++; }
  });
  return found;
}

/**
 * Avant de retirer une page : enlève du formulaire (AcroForm) les champs dont les zones de saisie
 * sont sur cette page. Sinon la valeur d'un champ (ex. un NIR saisi) resterait dans le fichier.
 */
export function dropPageFields(pdf, pageRef) {
  const acro = pdf.catalog.lookupMaybe(N("AcroForm"), PDFDict);
  const fields = acro?.lookupMaybe(N("Fields"), PDFArray);
  const leaf = pdf.context.lookup(pageRef);
  if (!fields || !(leaf instanceof PDFDict)) return 0;
  const pageKey = key(pageRef);
  const annots = new Set();
  const arr = leaf.lookupMaybe(N("Annots"), PDFArray);
  if (arr) for (let i = 0; i < arr.size(); i++) { const r = arr.get(i); if (r instanceof PDFRef) annots.add(key(r)); }
  const onPage = (ref, d) => annots.has(key(ref)) || (d.get(N("P")) instanceof PDFRef && key(d.get(N("P"))) === pageKey);
  let dropped = 0;
  const clean = (list) => {
    for (let i = list.size() - 1; i >= 0; i--) {
      const r = list.get(i);
      const d = r instanceof PDFRef ? pdf.context.lookup(r) : r;
      if (!(d instanceof PDFDict)) continue;
      const kids = d.lookupMaybe(N("Kids"), PDFArray);
      if (kids) { if (clean(kids) === 0) { list.remove(i); dropped++; } }
      else if (r instanceof PDFRef && onPage(r, d)) { list.remove(i); dropped++; }
    }
    return list.size();
  };
  clean(fields);
  return dropped;
}

/**
 * Retire définitivement la page n° index : ses champs de formulaire sont enlevés et la liste
 * des pages de pdf-lib est remise à jour (pdf-lib ne le fait pas après removePage).
 * Appeler purgeUnreachable() avant l'enregistrement pour effacer son contenu du fichier.
 */
export function removePageClean(pdf, index) {
  const ref = pageRefAt(pdf, index);
  if (ref) dropPageFields(pdf, ref);
  pdf.removePage(index);
  pdf.pageCache?.invalidate?.();
}

/**
 * Document masqué : retire aussi les données annexes qui pourraient révéler ce qui a été masqué
 * ou des informations personnelles — propriétés du fichier (titre, auteur, sujet, mots-clés…),
 * métadonnées XMP, pièces jointes (dans le document et sur les pages), JavaScript et actions
 * automatiques. Les signets, liens internes et formulaires des autres pages sont conservés.
 * À appeler avant purgeUnreachable(). Renvoie ce qui a été retiré.
 */
export function stripSensitiveExtras(pdf) {
  const ctx = pdf.context;
  const cat = pdf.catalog;
  const report = { metadata: false, attachments: 0, javascript: 0 };
  const isJs = (action) => {
    const a = action instanceof PDFRef ? ctx.lookup(action) : action;
    return a instanceof PDFDict && a.get(N("S")) === N("JavaScript");
  };
  // Propriétés du fichier et XMP
  const infoRef = ctx.trailerInfo.Info;
  const info = infoRef ? ctx.lookup(infoRef) : null;
  if (info instanceof PDFDict && info.keys().length) report.metadata = true;
  if (infoRef) ctx.trailerInfo.Info = ctx.register(ctx.obj({}));
  if (cat.get(N("Metadata"))) { cat.delete(N("Metadata")); report.metadata = true; }
  // Pièces jointes et JavaScript du document
  const names = cat.lookupMaybe(N("Names"), PDFDict);
  if (names) {
    for (const k of ["EmbeddedFiles", "JavaScript"]) {
      if (names.get(N(k))) {
        if (k === "EmbeddedFiles") report.attachments++; else report.javascript++;
        names.delete(N(k));
      }
    }
  }
  for (const k of ["Collection", "AF"]) if (cat.get(N(k))) { cat.delete(N(k)); report.attachments++; }
  if (cat.get(N("AA"))) { cat.delete(N("AA")); report.javascript++; }
  if (cat.get(N("OpenAction")) && isJs(cat.get(N("OpenAction")))) { cat.delete(N("OpenAction")); report.javascript++; }
  // Pages : pièces jointes en annotation, actions automatiques et JavaScript des annotations
  for (const page of pdf.getPages()) {
    const node = page.node;
    if (node.get(N("AA"))) { node.delete(N("AA")); report.javascript++; }
    const annots = node.lookupMaybe(N("Annots"), PDFArray);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = ctx.lookup(annots.get(i));
      if (!(a instanceof PDFDict)) continue;
      if (a.get(N("Subtype")) === N("FileAttachment")) { annots.remove(i); report.attachments++; continue; }
      if (a.get(N("AA"))) { a.delete(N("AA")); report.javascript++; }
      if (a.get(N("A")) && isJs(a.get(N("A")))) { a.delete(N("A")); report.javascript++; }
    }
  }
  return report;
}
