# SXM PDF — fiche de reprise du projet

Application PDF de bureau (Tauri 2 : interface JavaScript + Rust) de Invisible_Dawn.
Nom public dans l'appli : **Invisible_Dawn** (À propos, copyright, métadonnées). Ne jamais afficher le vrai nom.
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
- outils : `annots.js, sign.js, rh.js, watermark.js, capture.js` ; données : `store.js`
- natif : `src-tauri/src/main.rs` (19 tests `cargo test --release` dans `src-tauri`)
- données utilisateur : `~/.config/com.sxm.pdf/sxm-pdf-donnees.json` (+ `.bak`), file d'écriture unique
  côté JS (`enqueue`), verrou `DATA_LOCK` côté Rust, validation stricte des imports et des `.bak`.
- Ne pas réécrire les modules qui fonctionnent ; ne supprimer aucune fonction ; tester après chaque changement.
- Livrer les zips avec un nom daté et mettre à jour `CHANGELOG.md`.

## Compilation
- Fedora : `npm install && npx tauri build --bundles rpm`
- GitHub Actions : workflow « Compiler SXM PDF » (tests 3 OS puis installateurs ; Mac = macos-15-intel,
  les Mac arm64 de GitHub sont souvent indisponibles) ; « Publier les installateurs » crée une page Releases.
- Publier une version : pousser un tag `vX.Y.Z` (stable) ou `vX.Y.Z-beta.N` (bêta) → compilation,
  page Releases et fichier de mise à jour automatiques. Penser à écrire la section du CHANGELOG avant.
- Mises à jour auto : `src/update.js` + commandes Rust `update_check` / `update_install`. Clé privée de
  signature : secrets GitHub (sauvegarde chez Invisible_Dawn) — la perdre = plus de mises à jour possibles.
- Version de test publiée : release `v1.0.3-test` (dmg, exe, msi, rpm, deb).

## État au 2026-11-06
- Tests de sauvegarde 19/19 sur Windows Server 2025, macOS 15.7 (Intel), Ubuntu 22.04.
- Windows : LibreOffice + qpdf 12.4.2 embarqués. Mac : LibreOffice 26.8.2 embarqué, qpdf à installer (brew).
- 07/11 : validé par Invisible_Dawn sur MacBook Pro 2018 (Intel) — release `v1.0.3-test`. Inclut : impression Mac
  (`print_window`), capture (masquage côté Rust, `screencapture -i` sur Mac), initiales en écriture neutre,
  nouveau look (icônes colorées, info-bulles `tooltip.js`), surlignage par zone sur les pages scannées.
- Tester l'interface sans Mac : app compilée en debug sous Xvfb + xdotool (WebKitGTK), voir CHANGELOG.

## Reste à faire avant la vente
1. Essais réels Windows / Mac (capture, impression, envoi mail, conversion Office).
2. Signature des installateurs (certificat Windows, compte développeur Apple 99 $/an).
3. Licence + paiement (19,99 €/an ou 59,99 € à vie, essai 14 jours). Mises à jour automatiques : faites (14/11).
4. Version 2 : OCR (Tesseract local), aussi pour le masquage par recherche sur les scans.
