// État partagé : onglets ouverts, outil actif, raccourcis DOM.
import { getCurrentWindow } from "@tauri-apps/api/window";

export const $ = (s) => document.querySelector(s);
export const $$ = (s) => [...document.querySelectorAll(s)];
export const appWindow = getCurrentWindow();

export const state = {
  tabs: [], active: null,
  tool: "select",
  hlColor: "#facc15", // couleur des surlignages
  pending: null, // élément à placer au prochain clic (signature, tampon, image)
};
export const DRAW_TOOLS = ["redact", "hlarea", "lasso", "ink", "rect", "ellipse", "arrow", "line", "text", "note"];
export const MARK_TOOLS = ["highlight", "underline", "strike"];
export const tab = () => state.tabs.find((t) => t.id === state.active);
export const opt = () => ({
  color: $("#color").value, width: +$("#width").value, size: +$("#fontsize").value,
});
