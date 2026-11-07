// Initialisation de PDF.js (doit être importé avant pdf_viewer.mjs).
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
globalThis.pdfjsLib = pdfjs;
// Sécurité : pdf.js ne génère jamais de code à partir d'un PDF (polices compilées sans eval).
// Compatible avec la politique de sécurité (CSP) de la fenêtre, qui interdit eval.
const pdfjsLib = { ...pdfjs, getDocument: (src) => pdfjs.getDocument({ isEvalSupported: false, ...src }) };
export { pdfjsLib };
