// Tests des sauvegardes de réglages (export / import). Lancer : npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBackup } from "../src/store.js";

const backup = (data) => JSON.stringify({ app: "SXM PDF", format: 1, exported: new Date().toISOString(), data });

test("le style des initiales fait partie de la sauvegarde", () => {
  const v = validateBackup(backup({ "sxm.initials": "LH", "sxm.initialsStyle": "manuscrit" }));
  assert.equal(v["sxm.initials"], "LH");
  assert.equal(v["sxm.initialsStyle"], "manuscrit");
});

test("un style d'initiales inconnu est refusé sans rien importer", () => {
  assert.throws(() => validateBackup(backup({ "sxm.initials": "LH", "sxm.initialsStyle": "gothique" })), /style des initiales/);
});

test("les sauvegardes anciennes (sans style) restent valides", () => {
  const v = validateBackup(backup({ "sxm.initials": "LH" }));
  assert.equal(v["sxm.initialsStyle"], undefined);
});
