// Traduction de l'interface (i18n.js / i18n-en.js) : sans effet en français, complète en anglais.
import { test } from "node:test";
import assert from "node:assert/strict";

let lang = "en";
globalThis.localStorage = { getItem: () => lang, setItem: (_k, v) => { lang = v; } };
const { tr, currentLang } = await import("../src/i18n.js");
const { EN, EN_PATTERNS } = await import("../src/i18n-en.js");

test("français : aucun texte n'est modifié", () => {
  lang = "fr";
  assert.equal(currentLang(), "fr");
  assert.equal(tr("Ouvrir un PDF"), "Ouvrir un PDF");
  lang = "en";
});

test("anglais : textes fixes, raccourcis, « : » et parties variables", () => {
  assert.equal(tr("Ouvrir un PDF"), "Open a PDF");
  assert.equal(tr("Ouvrir (Ctrl+O)"), "Open (Ctrl+O)");
  assert.equal(tr("Capture d'écran (Ctrl+Maj+X)"), "Screenshot (Ctrl+Shift+X)");
  assert.equal(tr("Taille :"), "Size:");
  assert.equal(tr("Impression impossible : erreur"), "Printing failed: erreur");
  assert.equal(tr("🎉 SXM PDF 1.5.1 est disponible"), "🎉 SXM PDF 1.5.1 is available");
  assert.equal(tr("🔍 3 occurrence(s) masquée(s) sur 2 page(s).\nVérifiez le résultat avant d'enregistrer (Ctrl+Z pour annuler)."),
    "🔍 3 match(es) redacted on 2 page(s).\nCheck the result before saving (Ctrl+Z to undo).");
});

test("anglais : les noms de fichiers ne sont pas traduits", () => {
  for (const n of ["Paul et Marie.pdf", "● Contrat — SXM PDF", "Notes de réunion.pdf"]) assert.equal(tr(n), n);
});

test("dictionnaire : pas de traduction en chaîne (boucle d'affichage impossible)", () => {
  for (const [fr, en] of Object.entries(EN)) {
    if (en !== fr && EN[en] !== undefined) assert.equal(EN[en], en, `${fr} → ${en} → ${EN[en]}`);
  }
  for (const [fr, en] of EN_PATTERNS) {
    const holes = (x) => (x.match(/\{\d\}/g) || []).sort().join();
    assert.equal(holes(fr), holes(en), fr);
  }
});
