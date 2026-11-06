# SXM PDF

Lire, annoter, signer, convertir et capturer — Fedora, Windows et macOS.

## Installer sur Fedora

```bash
sudo dnf install ./sxm-pdf-1.0.0-1.x86_64.rpm
```

### Fonctionnalités avancées (facultatives)

| Fonction | Outil nécessaire |
|---|---|
| Conversions Word / Excel / PowerPoint, PDF → Word | LibreOffice |
| Mots de passe (protéger, ouvrir, retirer) | qpdf |

Ces outils sont **recommandés**, pas obligatoires : `dnf` les installe par défaut avec SXM PDF.
Pour une **installation allégée** (lecture, annotation, signature, pages, capture, filigrane, masquage…) :

```bash
sudo dnf install --setopt=install_weak_deps=False ./sxm-pdf-1.0.0-1.x86_64.rpm
```

Si une fonction avancée est utilisée sans son outil, SXM PDF l'indique et affiche la commande d'installation à copier.

Aucune association avec les fichiers Office : Word, Excel et PowerPoint restent tels quels.
SXM PDF apparaît dans « Ouvrir avec » pour les PDF, sans devenir le lecteur par défaut
(menu ⋯ > « Définir comme lecteur PDF par défaut » si vous le souhaitez).

## Raccourci de capture sous GNOME

Paramètres > Clavier > Raccourcis personnalisés > Ajouter :
- Nom : `Capture SXM PDF`
- Commande : `sxm-pdf --capture`
- Raccourci : celui de votre choix (ex. `Super+Maj+S`)

## Raccourcis clavier

| Action | Touche |
|---|---|
| Ouvrir / Enregistrer / Enregistrer sous | Ctrl+O / Ctrl+S / Ctrl+Maj+S |
| Capture d'écran | Ctrl+Maj+X |
| Annuler / Rétablir | Ctrl+Z / Ctrl+Y |
| Sélection, Surligner, Souligner, Barrer | V, H, U, K |
| Texte, Note, Stylo, Rectangle, Ellipse, Flèche, Ligne | T, N, P, R, E, A, L |
| Supprimer l'annotation | Suppr |
| Zoom | Ctrl+molette, Ctrl+ / Ctrl− |
| Onglet suivant / Fermer l'onglet | Ctrl+Tab / Ctrl+W |

## Développement (Fedora)

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel librsvg2-devel gcc rpm-build
curl https://sh.rustup.rs -sSf | sh
npm install
npm run tauri dev                         # lancer en mode développement
npx tauri build --bundles rpm             # produire le .rpm
```

## Windows et macOS

Envoyez le projet sur GitHub puis, dans l'onglet **Actions**, lancez « Compiler SXM PDF »
(ou créez un tag `v1.0.0`). Le workflow `.github/workflows/build.yml` produit le `.msi`/`.exe`
Windows et le `.dmg` macOS, avec LibreOffice embarqué en privé (non enregistré dans le système).

## Vos données

Signatures, tampons, initiales, profils de lot et modèles de filigrane sont enregistrés dans
`~/.config/com.sxm.pdf/sxm-pdf-donnees.json` (Windows : `%APPDATA%\com.sxm.pdf\`, macOS :
`~/Library/Application Support/com.sxm.pdf/`), avec une copie de secours `.bak`.
Menu ⋯ > « Sauvegarder mes signatures et réglages » pour les transférer sur un autre ordinateur.

Fiabilité : toutes les écritures passent par une file unique (jamais deux à la fois) ; un échec
d'enregistrement affiche un bandeau rouge en bas de la fenêtre (Réessayer, Restaurer la copie de
secours, Détails) et un nouvel essai automatique est fait ; un fichier illisible au démarrage est
mis de côté (`sxm-pdf-donnees.illisible-….json`), jamais écrasé. Une sauvegarde importée est
entièrement vérifiée avant toute modification.

## Masquage (caviardage) : fonctionnement et limites

- Pendant l'édition, une zone masquée est une annotation : elle peut être déplacée ou supprimée,
  et le contenu d'origine est toujours présent **dans le document ouvert**.
- À l'**enregistrement**, à l'**envoi par mail**, à l'**impression** et au **traitement par lot**, chaque page
  contenant une zone masquée est convertie en image (≈180 dpi), la zone est noircie ou pixellisée,
  puis l'image remplace la page. Le texte, les images et les annotations d'origine de ces pages
  **n'existent plus** dans le fichier produit (vérifié par extraction de texte).
- Limites : les pages concernées ne sont plus sélectionnables ni recherchables ; le **flou** rend une
  zone illisible mais reste une pixellisation — pour des données très sensibles (IBAN, n° de sécurité
  sociale), utilisez le **noir** ; la recherche automatique ne trouve que le texte réel (pas les scans
  sans OCR) : vérifiez toujours le résultat ; les métadonnées du document (titre, auteur) ne sont pas modifiées.
- SXM PDF ne délivre pas de caviardage « certifié » au sens d'une norme : relisez le PDF produit
  avant de le transmettre.

## Mot de passe

Menu 🧰 Outils > Protéger par mot de passe (AES-256, restrictions d'impression, de copie et de modification).
Un PDF protégé demande son mot de passe à l'ouverture et reste protégé quand on l'enregistre.
Sur macOS, installer qpdf une fois : `brew install qpdf`.

## Licences

PDF.js (Apache 2.0), pdf-lib (MIT), Tauri (MIT/Apache 2.0), LibreOffice (MPL 2.0), qpdf (Apache 2.0), DejaVu Sans (licence Bitstream Vera, libre).
