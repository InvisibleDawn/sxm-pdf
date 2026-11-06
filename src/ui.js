// Petits outils d'interface : notifications, fenêtres modales, attente.

export function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  document.getElementById("toasts").appendChild(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

/** Ouvre une fenêtre modale. build(modal, close) remplit le contenu. */
export function modal(build, { cls = "" } = {}) {
  return new Promise((resolve) => {
    const bg = el("div", { class: "modal-bg" });
    const box = el("div", { class: "modal " + cls });
    bg.appendChild(box);
    const close = (v) => {
      bg.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key !== "Escape" || document.getElementById("modal-root").lastElementChild !== bg) return;
      e.stopPropagation(); close(null);
    };
    document.addEventListener("keydown", onKey, true);
    bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(null); });
    document.getElementById("modal-root").appendChild(bg);
    build(box, close);
  });
}

/** Demande un texte (remplace window.prompt, peu fiable dans la WebView Linux). */
export function askText(title, initial = "", { multiline = false, placeholder = "", password = false, text = "" } = {}) {
  return modal((m, close) => {
    const input = multiline
      ? el("textarea", { rows: 5, style: "width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--panel2);resize:vertical;user-select:text", placeholder })
      : el("input", { type: password ? "password" : "text", placeholder, style: "flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel2);user-select:text" });
    input.value = initial;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (!multiline || e.ctrlKey)) close(input.value);
    });
    m.append(
      el("h2", {}, title),
      text ? el("p", {}, text) : null,
      input,
      el("div", { class: "row end" },
        el("button", { class: "btn", onclick: () => close(null) }, "Annuler"),
        el("button", { class: "btn accent", onclick: () => close(input.value) }, "Valider"))
    );
    setTimeout(() => input.focus(), 30);
  });
}

export function confirmBox(title, text, okLabel = "Oui", cancelLabel = "Annuler", third = null) {
  return modal((m, close) => {
    m.append(el("h2", {}, title), el("p", {}, text));
    const row = el("div", { class: "row end" });
    if (third) row.append(el("button", { class: "btn", onclick: () => close("third") }, third));
    row.append(
      el("button", { class: "btn", onclick: () => close(false) }, cancelLabel),
      el("button", { class: "btn accent", onclick: () => close(true) }, okLabel));
    m.append(row);
  });
}

export async function busy(label, fn) {
  const txt = el("div", {}, "⏳ " + label);
  const b = el("div", { class: "busy" }, txt);
  document.body.appendChild(b);
  try { return await fn((l) => (txt.textContent = "⏳ " + l)); } finally { b.remove(); }
}
