// Initialisation de PDF.js (doit être importé avant pdf_viewer.mjs).
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
globalThis.pdfjsLib = pdfjs;
// Sécurité : pdf.js ne génère jamais de code à partir d'un PDF (polices compilées sans eval).
// Compatible avec la politique de sécurité (CSP) de la fenêtre, qui interdit eval.
// Intégrité : pdf.js transfère les octets reçus à son worker, ce qui VIDE le tableau de l'appelant.
// On lui donne donc toujours sa propre copie : ainsi aucun appel (impression, export, aperçu…) ne peut
// vider la copie du document gardée en mémoire (t.bytes), d'où l'erreur « No PDF header found » en 1.3.1.
const ownCopy = (src) => (src?.data instanceof Uint8Array ? { ...src, data: src.data.slice() } : src);
const pdfjsLib = { ...pdfjs, getDocument: (src) => pdfjs.getDocument({ isEvalSupported: false, ...ownCopy(src) }) };
export { pdfjsLib };
