# Composants tiers distribués avec SXM PDF

## DejaVu Sans Bold (police des filigranes)

| | |
|---|---|
| Fichier | `public/fonts/DejaVuSans-Bold.ttf` (embarqué dans l'application) |
| Version | 2.37 (champ `fontversion` 155320) |
| Origine | Projet DejaVu Fonts — https://dejavu-fonts.github.io/ — copie prise du paquet Debian `fonts-dejavu-core` 2.37-8, fichier non modifié |
| SHA-256 | `5c1247acef7f2b8522a31742c76d6adcb5569bacc0be7ceaa4dc39dd252ce895` |
| Licence | Licence Bitstream Vera + licence Arev ; modifications DejaVu dans le domaine public |
| Texte complet | `public/licenses/DejaVu-LICENSE.txt` (copie officielle, tag `version_2_37` du dépôt dejavu-fonts) |

**Usage commercial** : autorisé. La licence permet de reproduire, distribuer et vendre la police
*« as part of a larger software package »*, ce qui est le cas de SXM PDF. Conditions respectées :
- le texte de licence et les mentions de copyright sont fournis avec l'application ;
- la police n'est ni modifiée ni renommée, et elle n'est pas vendue seule ;
- les noms Bitstream, Gnome, Tavmjong Bah et Arev ne sont pas utilisés pour promouvoir SXM PDF.

Dans les PDF produits, seuls les caractères utilisés sont intégrés (sous-ensemble), ce qui est
l'usage normal d'incorporation d'une police.

## Autres composants

| Composant | Licence | Usage |
|---|---|---|
| PDF.js (Mozilla) | Apache 2.0 | affichage des PDF |
| pdf-lib, @pdf-lib/fontkit | MIT | écriture des PDF, polices |
| Tauri | MIT / Apache 2.0 | application de bureau |
| Lucide | ISC | icônes |
| LibreOffice (facultatif) | MPL 2.0 | conversions Office |
| qpdf (facultatif) | Apache 2.0 | chiffrement |
