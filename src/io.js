// Accès fichiers et commandes natives (Rust).
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export const isLinux = navigator.userAgent.includes("Linux");

export async function readFile(path) {
  const buf = await invoke("read_bytes", { path });
  return new Uint8Array(buf);
}

export async function writeFile(path, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  await invoke("write_bytes", data, { headers: { "x-path": encodeURIComponent(path) } });
}

export const baseName = (p) => p.split(/[\\/]/).pop();
export const stem = (p) => baseName(p).replace(/\.[^.]+$/, "");
export const dirName = (p) => p.replace(/[\\/][^\\/]*$/, "");
export const ext = (p) => (p.match(/\.([^.\\/]+)$/)?.[1] || "").toLowerCase();

export const OFFICE_EXT = ["doc", "docx", "odt", "rtf", "txt", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"];
export const IMAGE_EXT = ["png", "jpg", "jpeg"];

export const pickPdf = (multiple = true) =>
  open({ multiple, filters: [{ name: "PDF", extensions: ["pdf"] }] });
export const pickOffice = () =>
  open({ multiple: true, filters: [{ name: "Documents Office", extensions: OFFICE_EXT }] });
export const pickImages = (multiple = true) =>
  open({ multiple, filters: [{ name: "Images", extensions: IMAGE_EXT }] });
export const pickFolder = () => open({ directory: true });
export const savePath = (defaultPath, name = "PDF", extensions = ["pdf"]) =>
  save({ defaultPath, filters: [{ name, extensions }] });

export const officeConvert = (path, to = "pdf", infilter = null) =>
  invoke("office_convert", { path, to, infilter });
export const captureScreen = () => invoke("capture_screen");
export const startupArgs = () => invoke("startup_args");
export const pdfEncrypt = (input, output, o) =>
  invoke("pdf_encrypt", { input, output, userPw: o.user, ownerPw: o.owner, allowPrint: o.print, allowCopy: o.copy, allowModify: o.modify });
export const pdfDecrypt = (input, password) => invoke("pdf_decrypt", { input, password });
export const removeTemp = (path) => invoke("remove_temp", { path }).catch(() => {});
export const setDefaultPdf = () => invoke("set_default_pdf");

export const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
