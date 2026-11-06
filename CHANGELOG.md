# Journal des modifications — SXM PDF

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
