# Journal des modifications — SXM PDF

## 2026-11-07 (soir) — Consolidation v1 · lot 2 : intégrité des conversions et des fichiers de sortie

- **I3** : chaque conversion LibreOffice écrit dans son propre dossier (`convert_with`) ; une conversion
  ratée ne peut plus ouvrir un ancien résultat du même nom. Le fichier converti est effacé dès sa lecture.
- **T3** : une conversion à la fois (`CONVERT_LOCK`), le profil LibreOffice n'étant pas partageable.
- **M6** : délai maximal de 120 s, LibreOffice est arrêté avec un message clair. Pas de fenêtre console sous Windows.
- **I4 / I5** : traitement par lot, export en images et division ne remplacent plus jamais un fichier
  existant (`unique_path` : « nom (2).pdf »…).
- PDF → Word sur un PDF protégé : message clair au lieu d'une conversion bloquée.
- Tests Rust 28/28 (nouveaux : nom unique, conversion ratée sans ancien résultat, arrêt après délai,
  vraie conversion LibreOffice quand il est installé — vérifiée avec LibreOffice 24.2).

## 2026-11-07 (soir) — Consolidation v1 · lot 1 : masquage, pages supprimées, enregistrement sûr

Suite à l'audit technique (document « SXM PDF — Audit technique avant v1.0 »).
- **S1 masquage réel** : le texte masqué restait dans le fichier (pdf-lib garde les objets inutilisés).
  Nouveau module `src/pdfclean.js` : `purgeUnreachable` retire tout objet non atteignable (une page
  retirée n'est jamais conservée, même si un signet ou un champ pointe vers elle) ; `removePageClean`
  retire aussi les champs de formulaire de la page et corrige la liste des pages de pdf-lib
  (non mise à jour après `removePage`). Utilisé par `applyRedactions`, `buildFinal` et `restructure`.
- **I2 suppression de page** : la page supprimée n'est plus cachée dans le fichier.
- **I1 écriture sûre des PDF** : `write_bytes` écrit dans un temporaire voisin puis remplace
  (`atomic_write`, comme pour les données). Une coupure laisse l'original intact.
- **S2 PDF protégés** : plus jamais écrits en clair à leur emplacement final (`io.writePdf` :
  clair dans le dossier temporaire privé, chiffrement direct vers un temporaire voisin, remplacement
  seulement si qpdf a réussi). Enregistrer, Envoyer, traitement par lot.
- **S3** : mots de passe transmis à qpdf par fichier d'arguments privé (0600), plus en ligne de commande.
- **S7** : `remove_temp` résout le chemin (« .. », liens) avant de supprimer.
- Dossier temporaire privé `sxm-pdf/` (0700 sous Linux/macOS) pour les envois et le chiffrement.
- Tests : `npm test` (6 tests, dont un témoin qui reproduit le défaut d'origine) ; Rust 24/24
  (5 nouveaux : écriture sûre, échec sans perte, `remove_temp`, fichier d'arguments, chiffrement réel
  avec qpdf). Masquage vérifié de bout en bout dans le navigateur avec `applyRedactions` : NIR et IBAN
  introuvables dans tous les objets du fichier, en noir comme en flou. CI : `npm test` + qpdf sur Ubuntu.

## 2026-11-07 — Surligner sur les documents scannés

- Sur une page scannée (image, sans texte), Sélectionner et Surligner ne faisaient rien, sans
  explication. Désormais : Surligner / Souligner / Barrer tracent un rectangle sur la zone ;
  Sélectionner affiche un message expliquant que la page est une image. PDF texte : inchangé.
- Vérifié dans l'application compilée (WebKitGTK) : PDF texte et PDF scanné.

## 2026-11-06 (23 h) — Interface plus vivante, moins de texte

- **Ruban** : outils en icônes colorées (une couleur par famille : fichiers bleu, surlignage jaune,
  texte violet, formes orange, signature indigo, tampon rose, protection vert…), libellés déplacés
  dans des info-bulles maison (pastille sombre + raccourci clavier). Onglets avec icônes, onglet
  actif en pastille dégradée. « Capture » reste l'action vedette avec libellé.
- **Rail de gauche** : tuiles d'icônes colorées, sans libellés (info-bulle à droite).
- « remplir » (Entourer) devient un bouton-icône pot de peinture ; couleur en pastille ronde.
- Barre latérale : onglets Pages / Notes en segment, boutons d'ajout en icônes ; miniatures :
  pivoter / supprimer en icônes.
- Accueil : titre en dégradé, cartes avec icônes pleines et effet au survol, fond légèrement coloré.
- Bouton « Envoyer » en dégradé. Thème sombre : icônes éclaircies.
- Aucun changement de fonctionnement (mêmes boutons, mêmes raccourcis).

## 2026-11-06 (19 h 30) — Corrections après essais sur Mac

- **Impression (macOS)** : WKWebView ignore `window.print()`. Nouvelle commande Rust `print_window`
  (impression native Tauri) appelée sur Mac ; le contenu à imprimer reste en place tant que la
  fenêtre d'impression est ouverte (elle est asynchrone). Windows/Linux inchangés.
- **Capture d'écran** : l'erreur « plugin:window|minimize not allowed by ACL » venait du masquage
  de la fenêtre côté JavaScript. La fenêtre est désormais masquée puis réaffichée côté Rust
  (`capture_screen`), toujours réaffichée même en cas d'erreur. Sur Mac : outil de sélection natif
  (`screencapture -i`, comme Cmd+Maj+4, Échap = annuler) et vérification de l'autorisation
  « Enregistrement de l'écran » avec message explicatif. Windows : capture xcap inchangée
  (xcap n'est plus compilé pour macOS).
- **Initiales** : choix « Écriture : Neutre (Arial) / Manuscrite » dans « Parapher toutes les pages » ;
  Neutre par défaut, choix mémorisé et repris par le traitement par lot.
- **Éditeur de capture redessiné** : barre à icônes (info-bulles + raccourcis C, A, R, H, T, F, N),
  pastilles de couleur + couleur libre, Annuler/Rétablir (Ctrl+Z / Ctrl+Maj+Z), Ctrl+C copier,
  Ctrl+S enregistrer, Entrée ajouter au PDF, bulle flottante qui explique l'outil choisi,
  fond pointillé et petites animations. Fonctions inchangées.
- Tests Rust 19/19 (Linux).

## 2026-11-06 (17 h 40) — Installateurs complets

- Windows : qpdf 12.4.2 embarqué (publications officielles github.com/qpdf) en plus de LibreOffice ;
  aide « outil nécessaire » avec commandes winget ; détection de qpdf dans « Program Files\qpdf* ».
- macOS : LibreOffice 26.8.2 embarqué (téléchargé sur download.documentfoundation.org).
- GitHub Actions run 42296229226 : tests 19/19 sur Windows, macOS 15 (Intel) et Ubuntu 22.04,
  puis installateurs .msi/.exe, .dmg universel, .rpm/.deb produits.
- Non embarqué : qpdf sur macOS (`brew install qpdf`, l'application l'indique). Installateurs non signés.

## 2026-11-06 (11 h 40) — v4 : sauvegardes multiplateformes, validation des .bak, verrou Rust

**Statut : NON prêt pour la commercialisation** tant que les tests Windows et macOS n'ont pas été exécutés
par GitHub Actions (voir « Non testé » ci-dessous).

Repères pour vérifier cette version : `fn replace_file(` et `static DATA_LOCK` dans `src-tauri/src/main.rs`,
`data_read_backup` dans `src/store.js`, 19 tests Rust (`cargo test --release` dans `src-tauri`).

### 1. Remplacement des fichiers sous Windows — `src-tauri/src/main.rs`
- Constat vérifié : `std::fs::rename` **remplace déjà** un fichier existant sous Windows (la bibliothèque
  standard appelle `MoveFileExW` avec `MOVEFILE_REPLACE_EXISTING`, documentation officielle de Rust et
  PR rust-lang/rust#137528). La remarque reçue sur ce point était inexacte.
- Renforcement appliqué quand même : nouvelle fonction `replace_file()` qui appelle explicitement
  `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` sous Windows (le renommage est écrit
  sur le disque avant le retour), avec repli sur `std::fs::rename` si la destination est ouverte par un autre
  programme ; sous Linux/macOS, `rename(2)` + synchronisation du dossier. Aucune dépendance ajoutée.
- Le `.bak` est désormais écrit de façon atomique lui aussi (fichier `.bak.tmp` + remplacement).
- Utilisé par `save_json_file()` et `restore_backup_file()`.

### 2. Validation des fichiers `.bak` — `src-tauri/src/main.rs`, `src/store.js`
- Rust : `validate_data()` contrôle la version du format (`_format`), le type de chaque rubrique et la
  structure de chaque signature, tampon, initiales, modèle et profil, avant toute écriture, lecture de secours
  ou restauration. Un `.bak` invalide ou d'un format plus récent n'est jamais restauré.
- Interface : la restauration lit d'abord le `.bak` (`data_read_backup`, sans modification), applique la
  validation détaillée des imports, puis seulement restaure. Message explicite en cas de refus.
- Le fichier de données porte maintenant `"_format": 1`.

### 3. Opérations simultanées JavaScript / Rust — `src-tauri/src/main.rs`
- Verrou unique `DATA_LOCK` autour de toutes les opérations natives sur le fichier (lecture, sauvegarde,
  lecture du .bak, restauration, mise de côté). Les fonctions internes ne reprennent jamais le verrou :
  pas d'interblocage possible. Les commandes s'exécutent hors du fil principal (`spawn_blocking`).
- Côté JavaScript, la file `enqueue()` existante reste le point d'entrée unique.
- Mise de côté d'un fichier illisible : nom unique garanti, jamais d'écrasement.

### 4. Tests — `src-tauri/src/main.rs`, `.github/workflows/build.yml`
- 9 tests existants conservés (1 adapté : il compte maintenant aussi les tentatives d'écriture du .bak),
  10 ajoutés : remplacement d'un fichier présent, sauvegarde avec fichier ouvert par un autre programme,
  8 formes de .bak invalide refusées, .bak de format futur refusé, .bak valide complet restauré, échec de
  restauration qui conserve le fichier principal, contenu de structure invalide jamais écrit, opérations
  simultanées (8 rédacteurs × 25 sauvegardes + 4 lecteurs + restaurations), interruption pendant une
  sauvegarde, 60 sauvegardes avec .bak toujours valide.
- Le workflow GitHub Actions exécute `cargo test` sous Windows, macOS et Linux ; la compilation échoue si un test échoue.

### Résultats réels (exécutés le 2026-11-06 sous Linux)
- `cargo test --release` : **19 réussis, 0 échec**.
- Interface (tests automatisés) : 16/16 sauvegardes malformées refusées ; 4/4 .bak invalides refusés sans
  modification ; file d'écriture : 1 écriture maximum à la fois ; bandeau d'échec, réessai, restauration OK.
- Application réelle lancée sur un bureau virtuel : fichier créé avec `_format: 1`, remplacé au 2e lancement
  avec création du .bak ; fichier corrompu sans .bak mis de côté intact (`illisible-….json`).
- Non-régression : 14 scénarios de fonctions PDF réussis ; texte masqué absent du fichier produit.

### Résultats GitHub Actions (2026-11-06, dépôt InvisibleDawn/sxm-pdf)
- **Windows Server 2025** (windows-2025-vs2026) : **19 réussis, 0 échec** (23,6 s) — code `replace_file`
  Windows compilé et validé, dont le remplacement d'un fichier existant et le fichier ouvert par un autre programme.
- **Ubuntu 22.04** : **19 réussis, 0 échec** (4,7 s).
- **macOS 15.7.9** (Mac Intel, runner macos-15-intel) : **19 réussis, 0 échec** (9,9 s).

### Non testé
- Mac **Apple Silicon** (M1–M4) : les machines arm64 de GitHub n'ont pas été disponibles (3 tentatives
  annulées faute de machine). Le code de sauvegarde est identique sur Mac Intel et Apple Silicon.
- Comportement avec un antivirus ou OneDrive réels.

## 2026-11-06 (10 h 45) — Fiabilisation des données utilisateur

Pour vérifier rapidement que vous avez bien cette version, cherchez ces éléments :

| Fichier | Ce qu'il faut y trouver |
|---|---|
| `src/store.js` | `function enqueue(` (file d'écriture unique), `export function validateBackup(`, `function vProfile(`, `export function restoreFromBackup(`, `export const onStatus` — environ 295 lignes |
| `src-tauri/src/main.rs` | `fn save_json_file_with<R>(`, `fn data_restore_backup(`, `fn data_quarantine(`, module `mod tests` avec 9 tests dont `cinquante_sauvegardes_sur_fichier_existant` |
| `src/app.js` | `export function initSaveStatus(` (bandeau « Signatures et réglages NON enregistrés ») |
| `.github/workflows/build.yml` | étape « Tests Rust (sauvegarde des données) » avec `cargo test` |

### Changements
1. **Échecs de sauvegarde signalés** : bandeau rouge persistant (Réessayer · Restaurer la copie de secours · Détails),
   notification, nouvel essai automatique après 4 s, avertissement à la fermeture si des réglages ne sont pas enregistrés.
2. **Validation stricte des sauvegardes importées** : type de chaque propriété, structures internes des signatures,
   tampons, initiales, modèles et profils ; refus des `null`, tableaux ou objets incorrects ; format/version vérifiés.
3. **File d'écriture unique** : sauvegardes, imports et restaurations sérialisés ; jamais deux écritures simultanées.
4. **Tests Rust** : 9 tests (50+ sauvegardes, échec de renommage, verrou temporaire, .tmp impossible, JSON invalide,
   restauration .bak, absence de .bak, fichier illisible mis de côté, restauration manuelle), exécutés aussi sous
   Windows et macOS par GitHub Actions.
5. **Fichier illisible au démarrage** : mis de côté (`sxm-pdf-donnees.illisible-….json`), jamais écrasé.

## 2026-11-06 (10 h 20) — Sauvegarde Windows, import « Tout remplacer », licence DejaVu
## 2026-11-06 (9 h 45) — Découpage de main.js en modules, données en fichier JSON, paquet allégé
