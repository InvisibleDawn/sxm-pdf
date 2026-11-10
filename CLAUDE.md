# SXM PDF — fiche de reprise du projet

Application PDF de bureau (Tauri 2 : interface JavaScript + Rust) de Laurent Honoré.
Répondre en français. Dépôt privé : github.com/InvisibleDawn/sxm-pdf.

## Fonctions (toutes opérationnelles)
Lecture PDF (pdf.js), onglets, annotations (surlignage couleurs, souligné, barré, zone, texte, note,
stylo, entourer, formes, flèches), signature réutilisable (dessin / import / Ctrl+V avec retrait du fond),
tampons datés, paraphe de toutes les pages, filigrane (Unicode DejaVu, derrière/devant, H/D/V, plages,
modèles), masquage flou/noir définitif (page convertie en image) + masquage par recherche (NIR, IBAN,
e-mail, tél.), mots de passe AES-256 (qpdf), fusion/division/pages, conversions Office (LibreOffice),
capture d'écran avec éditeur, traitement par lot avec profils, impression, envoi par mail,
épinglage, thème clair/sombre (design « nouvel Outlook + Spark »).

## Organisation du code
- `src/main.js` point d'entrée ; modules `core, tabs, editor, save, pages, convert, secure, app`
- outils : `annots.js, sign.js, rh.js, watermark.js, capture.js, tooltip.js` ; données : `store.js`
- `pdfclean.js` : effacement réel des pages retirées / masquées (`purgeUnreachable`, `removePageClean`).
  Toujours l'utiliser au lieu de `pdf.removePage` seul (pdf-lib garde les objets inutilisés dans le fichier).
- natif : `src-tauri/src/` — `main.rs` (démarrage + 41 tests `cargo test --release`), `files.rs`, `data.rs`, `convert.rs`,
  `capture.rs`, `qpdf.rs`, `system.rs` ; tests JS : `npm test` (12) ; interface : `npm run test:e2e` (10, Chrome sans écran)
- écriture des PDF : toujours sûre (`write_file_safely`) ; PDF protégés via `io.writePdf` (jamais en clair à destination) ;
  mots de passe qpdf par fichier d'arguments privé ; temporaires dans un dossier privé à l'utilisateur
  (Linux : `$XDG_RUNTIME_DIR/sxm-pdf`), nettoyés au démarrage ; noms de temporaires aléatoires (`create_new`).
- données utilisateur : `~/.config/com.sxm.pdf/sxm-pdf-donnees.json` (+ `.bak`), file d'écriture unique
  côté JS (`enqueue`), verrou `DATA_LOCK` côté Rust, validation stricte des imports et des `.bak`.
- Ne pas réécrire les modules qui fonctionnent ; ne supprimer aucune fonction ; tester après chaque changement.
- Livrer les zips avec un nom daté et mettre à jour `CHANGELOG.md`.

## Compilation
- Fedora : `npm install && npx tauri build --bundles rpm`
- GitHub Actions : workflow « Compiler SXM PDF » (tests 3 OS + Fedora 45 en conteneur, puis installateurs ; Mac = macos-15-intel,
  les Mac arm64 de GitHub sont souvent indisponibles) ; « Publier les installateurs » crée une page Releases.
- Version de test publiée : release `v1.0.3-test` (dmg, exe, msi, rpm, deb).

## État au 2026-11-06
- Tests de sauvegarde 19/19 sur Windows Server 2025, macOS 15.7 (Intel), Ubuntu 22.04.
- Windows : LibreOffice + qpdf 12.4.2 embarqués. Mac : LibreOffice 26.8.2 embarqué, qpdf à installer (brew).
- 07/11 : validé par Laurent sur MacBook Pro 2018 (Intel) — release `v1.0.3-test`. Inclut : impression Mac
  (`print_window`), capture (masquage côté Rust, `screencapture -i` sur Mac), initiales en écriture neutre,
  nouveau look (icônes colorées, info-bulles `tooltip.js`), surlignage par zone sur les pages scannées.
- Tester l'interface sans Mac : app compilée en debug sous Xvfb + xdotool (WebKitGTK), voir CHANGELOG.

## Consolidation v1 (07/11 soir)
- Audit (31 problèmes) + rapport : document « SXM PDF — Audit technique avant v1.0 » (Claude Docs).
- Branche `consolidation-v1`, 6 lots corrigés et testés ; à fusionner dans `main` après validation de Laurent.
- À confirmer sur Mac : double-clic Finder, Cmd+Q, qpdf embarqué, Envoyer (Mail/Outlook) ; Windows : capture 2e écran.

## Consolidation v2 (08/11)
- Branche `consolidation-v2` (à partir de v1) : lots A à G (temporaires, CI reproductible + audit, masquage complet,
  tests d'interface, mémoire mesurée, Debian 13 / Ubuntu 24.04 / Mac ARM, version 1.2.0 + SHA-256, modules Rust).
- Mesures mémoire et limites : voir CHANGELOG (lot E). Environnement de test sans DBus : chaque lancement = nouvelle instance.

## Design v3 (10/11) — version 1.3.0
- Branche `design-v3` (à partir de v2) : barre latérale à libellés, accueil illustré (`public/illustrations/`),
  action `home`, styles dans le bloc « Design v3 » en fin de `style.css`. Release `v1.3.0-test` pour essai Windows 11 (DRH).
- 1.3.1 : fermeture de la fenêtre réparée (autorisation `core:window:allow-destroy`, test Rust). Release `v1.3.1-test`.
- 1.3.2 : pdf.js reçoit toujours sa propre copie (`pdfsetup.js`) — sinon `t.bytes` était vidé après impression
  (« No PDF header found » à l'enregistrement / envoi). Release `v1.3.2-test`.
  Test de fermeture réelle : envoyer WM_DELETE_WINDOW (python-xlib) à l'app sous Xvfb.
- Captures d'écran de contrôle : `node .shots/shot.mjs` (dossier ignoré par git).

## Reste à faire avant la vente
1. Essais réels Windows / Mac (capture, impression, envoi mail, conversion Office).
2. Signature des installateurs (certificat Windows, compte développeur Apple 99 $/an).
3. Licence + paiement (19,99 €/an ou 59,99 € à vie, essai 14 jours) et mises à jour automatiques.
4. Version 2 : OCR (Tesseract local), aussi pour le masquage par recherche sur les scans.
