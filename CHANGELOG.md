# Journal des modifications — SXM PDF

## 2026-11-10 — Version 1.3.2 : « Failed to parse PDF document … No PDF header found »

- **Symptôme** (capture `fail1` de Laurent) : erreur en voulant imprimer, enregistrer ou envoyer.
- **Cause** (introduite en 1.2.0, lot E) : pour un document sans annotation, `buildFinal` renvoie directement
  la copie du document gardée en mémoire (`t.bytes`) au lieu de la réécrire. L'impression (et l'export en
  images) la donnait telle quelle à pdf.js, qui **transfère** les octets à son worker et vide donc le tableau.
  Après une impression, `t.bytes` était vide : l'enregistrement et l'envoi échouaient, et l'impression suivante aussi.
- **Correction** (`pdfsetup.js`) : le point d'accès unique à pdf.js donne toujours à pdf.js sa propre copie.
  Plus aucun appel ne peut vider `t.bytes`. Les trois copies devenues inutiles (`tabs.js`, `save.js`,
  `secure.js`) sont retirées pour ne pas doubler la mémoire.
- **Tests** : nouveau test d'interface « imprimer puis envoyer et enregistrer » (échoue sans la correction,
  passe avec) : interface 10/10, JS 12/12. Application compilée sous Xvfb : impression (boîte GTK) puis
  annulation, ajout d'un texte, enregistrement → PDF valide contenant le texte.

## 2026-11-10 — Version 1.3.1 : la fenêtre ne se fermait plus

- **Symptôme** (signalé par Laurent) : le bouton X et « Fermer la fenêtre » depuis la barre des tâches
  ne faisaient rien.
- **Cause** : l'interface ferme la fenêtre avec `appWindow.destroy()` après avoir vérifié les documents
  non enregistrés, mais l'autorisation Tauri `core:window:allow-destroy` n'était pas déclarée dans
  `src-tauri/capabilities/default.json` : Tauri refusait sans message. Même cause pour Cmd+Q sur Mac.
- **Correction** : autorisation ajoutée (une ligne). Nouveau test Rust `autorisations_fermeture_fenetre` (41/41).
- **Vérifié dans l'application compilée** (Xvfb, vraie demande de fermeture WM_DELETE_WINDOW, comme le bouton X) :
  avant = reste ouverte ; après = se ferme. Avec un document modifié : la question s'affiche,
  « Annuler » garde la fenêtre, « Quitter sans enregistrer » ferme.

## 2026-11-10 — Design v3 (version 1.3.0)

Nouvelle interface inspirée des maquettes « Linux USB Creator » et « SXM Multiboot » du projet.
Aucune fonction retirée, aucun module réécrit : HTML de la barre latérale et de l'accueil remplacé,
styles ajoutés en fin de `style.css` (bloc « Design v3 »), thème sombre conservé.

- **Barre latérale à libellés** (232 px) : logo, nom, numéro de version (lu dans `package.json`),
  Accueil / Ouvrir / Capture / Signer / Lot / Envoyer, puis Thème / Épingler / À propos, et une carte
  illustrée en bas. Élément actif = pastille bleue. Sous 1000 px de large : icônes seules.
- **Nouvelle action « Accueil »** : revient à l'écran d'accueil sans fermer les documents ouverts
  (`activate(null)` ; `activate()` affiche l'accueil quand aucun onglet n'est actif).
- **Accueil** : bandeau avec illustration originale d'une baie tropicale (`public/illustrations/baie.svg`,
  fondu à gauche), titre, 6 cartes d'action (Ouvrir, Fusionner, Convertir, Images → PDF, Capture, Lot)
  avec icône ronde, description et étiquette, zone de dépôt et grand bouton bleu « Ouvrir un PDF ».
  Le panneau des miniatures est masqué sur l'accueil.
- Palette : fond `#f3f6fb`, bleu `#1867d8`, cartes blanches arrondies (14–16 px).
- Tests : `npm test` 12/12, interface 9/9 (nouveau test du bouton Accueil), Rust 40/40, contrôle visuel
  dans l'application compilée (WebKitGTK sous Xvfb) en clair, sombre, 1280, 1440 et 960 px.

## 2026-11-08 — Consolidation v2 · lot G : main.rs découpé en modules

- `src-tauri/src/main.rs` (2 120 lignes) découpé par **déplacement pur** : `files.rs` (écriture sûre,
  temporaires), `data.rs` (données utilisateur), `convert.rs` (LibreOffice), `capture.rs`, `qpdf.rs`,
  `system.rs` (ouverture de fichiers, impression, messagerie, liens, épinglage, menu macOS). `main.rs`
  garde le démarrage et les tests.
- Découpage fait par un outil qui lit la syntaxe Rust ; vérification ligne à ligne : aucune ligne
  d'origine absente, seules les déclarations de modules et `pub(crate)` ajoutés. Aucun changement de logique.
- Tests Rust 40/40, compilation sans avertissement.

## 2026-11-08 — Consolidation v2 · lot F : plateformes, version et sommes de contrôle

- Compilation : tests aussi sur **Ubuntu 24.04** (+ tests d'interface) ; nouvelle étape **Debian 13**
  (conteneur : tests JS et Rust, .deb construit, installé avec apt et lancé 15 s) ; **Mac Apple Silicon**
  (macos-15, arm64) : tests JS et Rust, sans bloquer les installateurs si GitHub n'a pas de machine libre.
  Les installateurs attendent : audit, tests (Windows, Mac Intel, Ubuntu 22.04/24.04), Fedora 45, Debian 13.
- Version **1.2.0** partout (package.json, Cargo.toml, tauri.conf.json) : les noms de fichiers des
  installateurs correspondent enfin à la version publiée.
- Publication : fichier **SHA256SUMS.txt** avec chaque release (vérification : `sha256sum -c SHA256SUMS.txt`).
- Hors code (à la charge de Laurent) : compte développeur Apple pour la signature et la notarisation,
  certificat Windows. Le .dmg reste « universal » mais LibreOffice et qpdf embarqués sont en version
  Intel (Rosetta sur Apple Silicon).

## 2026-11-08 — Consolidation v2 · lot E : mémoire mesurée et maîtrisée

Mesures sur l'appli compilée en version finale (Linux, WebKitGTK), une seule instance :

| Document | Appli vide | Ouvert | Pic rotation | Pic enregistrement | Après fermeture |
| --- | --- | --- | --- | --- | --- |
| 1 000 pages (1 Mo) | 620 Mo | 776 Mo | — | 859 Mo | 761 Mo |
| 122 Mo (59 photos) | 618 Mo | 1 034 Mo | 1 440 Mo | 1 670 Mo | 1 028 Mo |
| 241 Mo (117 photos) | 618 Mo | 1 313 Mo | 2 059 Mo | 2 529 Mo | 1 239 Mo |

Aucune fuite : dans Chrome, après 4 cycles ouvrir/fermer, le tas JavaScript revient à son niveau de
départ et aucun document, page ni visionneuse ne reste en vie. (Une première série de mesures montrait
+750 Mo par cycle : c'était un artefact, chaque ouverture lançant une nouvelle instance de l'appli
dans l'environnement de test sans DBus.)

- Enregistrer un document non modifié ne réécrit plus le fichier ; sans annotation ni formulaire rempli,
  le PDF n'est plus réanalysé par pdf-lib ; pdf.js ne recopie le document que si un champ a été rempli.
- Fermeture d'un onglet : visionneuse, document, octets, historique et miniatures libérés explicitement.
- Miniatures : en attente sans mémoire réservée (canevas 1×1 + `aspect-ratio`), libérées loin de l'écran
  et redessinées au retour (corrige le lot 6 qui réservait ~380 Mo pour 1 000 pages).
- PDF de plus de 150 Mo : avertissement à l'ouverture ; plus de 1 Go : ouverture refusée avec un message
  (commande `file_size`).
- Tests : `npm run test:e2e` 8/8 (nouveau : un document non modifié n'est pas réécrit) ; tous les
  chemins réels d'ajout d'annotation marquent bien le document « modifié » (vérifié dans le code).

## 2026-11-08 — Consolidation v2 · lot D : tests automatisés des fonctions PDF

- Nouvelle suite `npm run test:e2e` (`tests/e2e/fonctions-pdf.e2e.mjs`) : la vraie interface est chargée
  dans Chrome sans écran ; Tauri est remplacé par un système de fichiers en mémoire et des boîtes de
  dialogue préprogrammées ; chaque fichier enregistré est relu avec pdf-lib. 7 scénarios :
  ouverture/enregistrement sans changement ; annotations (surlignage, texte, stylo, cadre, flèche, note
  PDF) ; signature image et tampon daté ; rotation, déplacement, suppression de page puis Annuler
  (la page supprimée n'est plus dans le fichier, elle revient avec sa rotation) ; fusion puis division
  (et 2e division sans écrasement) ; masquage (texte et titre absents du fichier) ; deux enregistrements
  simultanés (fichier final valide).
- Test Rust de concurrence : 8 écritures simultanées du même PDF, 5 fois — le fichier est toujours
  entièrement l'une des versions, jamais mélangé ni tronqué, aucun temporaire laissé.
- CI : tests d'interface sur Ubuntu. `playwright-core` 1.65.0 (outil de test, sans navigateur téléchargé).
- Tests : `npm test` 12/12, `npm run test:e2e` 7/7, Rust 40/40.

## 2026-11-08 — Consolidation v2 · lot C : masquage complet et avertissements visibles

- Document masqué : à l'enregistrement, `stripSensitiveExtras` retire aussi les propriétés du fichier
  (titre, auteur, sujet, mots-clés), les métadonnées XMP, les pièces jointes (document et annotations),
  le JavaScript et les actions automatiques. Signets, liens internes et formulaires des autres pages sont
  conservés. Vérifié : titre et auteur absents du fichier final, texte masqué introuvable.
- Masquage par recherche : encadré d'avertissement bien visible ; après la recherche, SXM PDF signale
  si le texte apparaît aussi dans des champs de formulaire ou des signets (non masqués automatiquement),
  avec une fenêtre à confirmer.
- PDF abîmé ou tronqué : message clair, fichier non modifié (vérifié avec un PDF tronqué à 60 %).
- Tests : `npm test` 12/12 (nouveaux : témoin des données annexes, retrait complet avec contenu et
  signets conservés, document sans annexes intact). L'outil de recherche des tests analyse maintenant
  aussi les objets compressés (object streams) : les tests de la v1 passent toujours.

## 2026-11-08 — Consolidation v2 · lot B : compilation reproductible et audit des dépendances

- `npm ci` seul (plus de repli `npm install`) ; `cargo test --locked` et `tauri build -- --locked` :
  la compilation échoue si un fichier de verrouillage n'est pas à jour, au lieu de résoudre d'autres versions.
- Versions exactes pour les bibliothèques PDF critiques : pdf-lib 1.17.1, pdfjs-dist 4.10.38,
  @pdf-lib/fontkit 1.1.1.
- Nouvelle étape « audit » : cohérence de package-lock.json et Cargo.lock, `npm audit --audit-level=high`,
  `cargo audit` (base RustSec). État au 08/11 : 0 vulnérabilité npm, 0 vulnérabilité Rust ; 5 avertissements
  non bloquants dans des dépendances Linux de Tauri (bibliothèques non maintenues : proc-macro-error,
  zbus_names, zvariant, zvariant_derive ; glib 0.18 `VariantStrIter`, non utilisé par SXM PDF).
- Plus d'installateur « dégradé » : l'embarquement de qpdf et LibreOffice (Mac, Windows) n'est plus
  facultatif ; en cas d'échec, la compilation échoue. Les installateurs attendent audit, tests 3 OS et Fedora.

## 2026-11-08 — Consolidation v2 · lot A : temporaires par utilisateur, écriture sûre renforcée

- **Dossier temporaire propre à l'utilisateur** : sous Linux, `$XDG_RUNTIME_DIR/sxm-pdf` (en mémoire,
  effacé à la déconnexion), sinon `~/.cache/com.sxm.pdf/sxm-pdf` — plus jamais `/tmp/sxm-pdf` partagé
  (un autre compte pouvait le créer avant SXM PDF). macOS et Windows : dossier temporaire de
  l'utilisateur. Le dossier est vérifié (vrai dossier, pas un lien, propriétaire = utilisateur, 0700) ;
  sinon un dossier neuf au nom aléatoire est utilisé. L'ancien `/tmp/sxm-pdf` est effacé s'il nous appartient.
- **Écriture sûre** (`atomic_write`) : nom de temporaire aléatoire (aléa du système, `getrandom`),
  `create_new` (refuse un fichier ou un lien symbolique déjà présent), `flush` + `sync_all`, droits du
  document conservés, synchronisation du dossier après remplacement (déjà en place). Les restes d'un
  enregistrement interrompu (plus de 10 min) sont effacés au prochain enregistrement du document.
- Chiffrement qpdf : temporaire de sortie au nom aléatoire également.
- Au démarrage, copies déchiffrées, arguments qpdf, captures et conversions sont effacés quel que soit
  leur âge (aucune opération n'est en cours) ; pièces jointes envoyées : après 24 h.
- `remove_temp` : refuse les liens symboliques ; accepte le dossier de l'appli et le dossier temporaire.
- Tests Rust 39/39 (nouveaux : nom imprévisible, piège non écrasé, lien symbolique non suivi, droits
  conservés, dossier privé, restes effacés, temporaires d'opération effacés au démarrage). Les 2 tests
  d'échec d'écriture utilisent maintenant une simulation explicite (l'ancien piège ne fonctionne plus,
  preuve que le nom n'est plus prévisible).

## 2026-11-07 (soir) — Consolidation v1 · lot 6 : performances et ergonomie

- **P1** : historique « Annuler » limité à 300 Mo de copies de PDF (au moins 5 annulations gardées).
- **P2** : miniatures dessinées seulement quand elles deviennent visibles (vérifié sur un PDF de 500 pages).
- **P3 (macOS)** : images d'impression libérées au premier clic après la fenêtre d'impression.
- **U1** : les liens internet d'un PDF s'ouvrent dans le navigateur après confirmation affichant
  l'adresse (`open_external` : http, https et mailto uniquement ; testé).
- **U2** : à la fermeture, « Tout enregistrer et quitter » en plus de « Quitter sans enregistrer ».
- **U3** : le masquage par recherche indique qu'il n'analyse ni les champs de formulaire ni les
  propriétés du fichier.
- Tests Rust 34/34 (nouveau : liens refusés hors http/https/mailto). Vérifié dans l'appli compilée :
  confirmation du lien, PDF de 500 pages (miniatures au défilement).

## 2026-11-07 (soir) — Consolidation v1 · lot 5 : multiplateforme

- **M1 (macOS)** : double-clic sur un PDF / « Ouvrir avec » ouvre le fichier (événement `Opened`) ; les
  fichiers reçus avant que l'interface soit prête sont gardés et remis au démarrage. À confirmer sur Mac.
- **M2 (macOS)** : qpdf et ses bibliothèques embarqués dans le .dmg (dylibbundler, aucune dépendance
  Homebrew, vérifié par `otool` dans la compilation). PDF protégés sans rien installer.
- **M3 (Windows)** : la capture prend l'écran où se trouve la souris (plusieurs écrans).
- **M4 (Fedora 45)** : nouvelle étape de compilation dans un conteneur Fedora 45 : tests JS et Rust,
  .rpm construit sur Fedora, installé avec dnf et lancé (l'appli doit tourner 15 s).
- **M5 (macOS)** : « Envoyer » utilise la messagerie par défaut (Apple Mail ou Outlook) ; sinon le
  fichier est montré dans le Finder.
- **M6** : délai de 120 s pour LibreOffice (lot 2). **M7 (macOS)** : chemin protégé dans l'entrée du Dock.
- Tests Rust 33/33 (nouveaux : messagerie par défaut Mac, fichiers reçus avant l'interface).

## 2026-11-07 (soir) — Consolidation v1 · lot 4 : fichiers temporaires

- **T1** : tous les temporaires (pièces jointes envoyées, conversions, captures, copies déchiffrées,
  fichiers d'arguments qpdf) sont dans un seul dossier privé `sxm-pdf/` du dossier temporaire
  (0700 sous Linux/macOS). Au démarrage, les fichiers de plus de 24 h sont effacés en arrière-plan,
  ainsi que les anciens dossiers des versions précédentes. Le profil LibreOffice est conservé.
  La capture brute est effacée dès sa lecture ; le fichier converti dès son ouverture (lot 2).
- **T2** : la copie déchiffrée est toujours effacée, même en cas d'erreur de lecture (lot 3).
- Tests Rust 31/31 (nouveaux : nettoyage des seuls fichiers anciens, profil conservé, dossier privé).

## 2026-11-07 (soir) — Consolidation v1 · lot 3 : sécurité (suite) et sauvegarde

- **Nouveau défaut trouvé et corrigé** : un PDF chiffré sans mot de passe d'ouverture (restrictions
  seules, fréquent pour les documents officiels) s'affichait, mais une fois annoté et enregistré il
  devenait illisible. Il est maintenant déchiffré à l'ouverture (`unlockRestricted`) et ses restrictions
  sont réappliquées à l'enregistrement. Sans qpdf : lecture seule, enregistrement refusé, original intact.
- **S4** : à la réouverture d'un PDF protégé, les droits d'origine (impression, copie, modification) sont
  relus (`pdf_encryption_info`) et conservés ; le mot de passe propriétaire est demandé et vérifié, ou
  remplacé par un mot de passe aléatoire qui maintient les limites. Ouverture avec le mot de passe
  propriétaire : le mot de passe d'ouverture à conserver est demandé.
- **S5** : politique de sécurité (CSP) stricte dans la fenêtre ; pdf.js sans `eval` (`isEvalSupported:
  false`) ; module `fs` de Tauri retiré (inutilisé).
- **S6** : masquage manuel en noir par défaut, « Flou (moins sûr) » ; pixellisation à blocs plus larges.
- **B1 (macOS)** : Cmd+Q passe par la fermeture de la fenêtre et propose d'enregistrer (menu « Quitter »
  remplacé). À confirmer sur Mac.
- **B2** : le style des initiales est inclus dans l'export, l'import et la restauration (validé).
- **B3** : la copie des signatures dans le stockage interne de la fenêtre est effacée dès que le fichier
  de données est écrit avec succès.
- Tests : `npm test` 9/9 ; Rust 29/29 (nouveau : droits relus et conservés, mauvais mot de passe refusé).
  Vérifié dans l'appli compilée (Linux) avec la CSP active : affichage, surlignage, Ctrl+S (aucun
  temporaire laissé) ; PDF restreint : mot de passe propriétaire vérifié, surlignage enregistré, fichier
  toujours ouvrable sans mot de passe, impression et copie toujours interdites, `qpdf --check` sans erreur.

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
