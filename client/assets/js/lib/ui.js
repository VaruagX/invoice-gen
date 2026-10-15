import { html, mount, $, $$, escapeHtml } from "./dom.js";
import { icon } from "./icons.js";
import { statusLabel } from "./format.js";

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message, { type = "success", title, timeout = 4200 } = {}) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const element = document.createElement("div");
  element.className = `toast toast-${type}`;
  element.setAttribute("role", type === "error" ? "alert" : "status");
  const iconName = type === "error" ? "alert" : type === "info" ? "info" : "checkCircle";
  mount(
    element,
    html`${icon(iconName)}
      <div class="toast-text">
        ${title ? html`<div class="toast-title">${title}</div>` : ""}
        <div class="${title ? "toast-message" : "toast-title"}">${message}</div>
      </div>
      <button class="toast-close" type="button" aria-label="Dismiss notification">${icon("x", "icon-sm")}</button>`
  );
  const remove = () => {
    element.classList.add("leaving");
    setTimeout(() => element.remove(), 180);
  };
  element.querySelector(".toast-close").addEventListener("click", remove);
  host.appendChild(element);
  if (timeout) setTimeout(remove, type === "error" ? timeout + 2500 : timeout);
}

export function toastError(error, fallback = "Something went wrong.") {
  if (error?.name === "AbortError") return;
  toast(error?.message || fallback, { type: "error" });
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

/**
 * Open a modal built on <dialog> (focus trap, Escape, backdrop for free).
 * `body` and `footer` are html`` fragments. onSubmit receives (form, close);
 * throwing keeps the dialog open.
 */
export function openModal({ title, description, body, footer, wide = false, onSubmit, onOpen, onClose, initialFocus }) {
  const dialog = document.createElement("dialog");
  dialog.className = `modal${wide ? " wide" : ""}`;
  const titleId = `modal-title-${Math.random().toString(36).slice(2)}`;
  dialog.setAttribute("aria-labelledby", titleId);
  mount(
    dialog,
    html`<form class="modal-form" method="dialog" novalidate>
      <div class="modal-header">
        <div>
          <h2 id="${titleId}">${title}</h2>
          ${description ? html`<p>${description}</p>` : ""}
        </div>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? html`<div class="modal-footer">${footer}</div>` : ""}
    </form>`
  );
  document.body.appendChild(dialog);
  const form = dialog.querySelector("form");
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
    onClose?.(value);
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close(undefined);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close(undefined);
  });
  $$("[data-close]", dialog).forEach((button) => button.addEventListener("click", () => close(undefined)));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!onSubmit) return close(true);
    const submit = event.submitter || form.querySelector("[type=submit]");
    await withBusy(submit, async () => {
      try {
        const result = await onSubmit(form, close, event.submitter);
        if (result !== false) close(result ?? true);
      } catch (error) {
        if (error?.errors?.length) showFieldErrors(form, error.errors);
        else toastError(error);
      }
    });
  });
  dialog.showModal();
  onOpen?.(dialog, close);
  const focusTarget = initialFocus ? dialog.querySelector(initialFocus) : form.querySelector("input:not([type=hidden]), select, textarea");
  focusTarget?.focus();
  return { dialog, form, close };
}

export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false, details }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: html`<p class="muted">${message}</p>${details || ""}`,
      footer: html`<button type="button" class="btn btn-secondary" data-close>Cancel</button>
        <button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${confirmLabel}</button>`,
      onSubmit: () => resolve(true),
      onClose: (value) => {
        if (value === undefined) resolve(false);
      },
      initialFocus: "[type=submit]",
    });
  });
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function clearFieldErrors(root) {
  $$(".field-error", root).forEach((el) => el.remove());
  $$("[aria-invalid]", root).forEach((el) => el.removeAttribute("aria-invalid"));
}

/** Show server/client validation errors next to the matching inputs. */
export function showFieldErrors(root, errors, { focus = true } = {}) {
  clearFieldErrors(root);
  let first = null;
  const unplaced = [];
  errors.forEach(({ field, message }) => {
    const input = field ? root.querySelector(`[data-field="${CSS.escape(field)}"], [name="${CSS.escape(field)}"]`) : null;
    if (!input) {
      unplaced.push(message);
      return;
    }
    input.setAttribute("aria-invalid", "true");
    const container = input.closest("[data-error-host]") || input.closest(".field") || input.parentElement;
    if (!container.querySelector(`.field-error[data-for="${CSS.escape(field)}"]`)) {
      const note = document.createElement("div");
      note.className = "field-error";
      note.dataset.for = field;
      note.textContent = message;
      container.appendChild(note);
    }
    first = first || input;
  });
  if (unplaced.length) toast(unplaced.join(" "), { type: "error" });
  if (focus && first) {
    first.focus({ preventScroll: false });
    first.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

/** Disable a button and show a spinner while fn runs (prevents double submits). */
export async function withBusy(button, fn) {
  if (button?.dataset.busy === "true") return undefined;
  const label = button?.innerHTML;
  if (button) {
    button.dataset.busy = "true";
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(button.dataset.busyLabel || button.textContent.trim())}</span>`;
  }
  try {
    return await fn();
  } finally {
    if (button && button.isConnected) {
      button.innerHTML = label;
      button.disabled = false;
      delete button.dataset.busy;
    }
  }
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export function statusPill(status) {
  return html`<span class="pill pill-${status}">${statusLabel(status)}</span>`;
}

export function emptyState({ iconName = "invoice", title, text, actions }) {
  return html`<div class="empty">
    <div class="empty-icon">${icon(iconName)}</div>
    <h3>${title}</h3>
    ${text ? html`<p>${text}</p>` : ""}
    ${actions ? html`<div class="actions">${actions}</div>` : ""}
  </div>`;
}

export function skeletonRows(count = 5) {
  return html`<div class="card-body">${Array.from({ length: count }, (_, i) =>
    html`<span class="skeleton skeleton-line" style="width:${[92, 80, 86, 70, 90, 76][i % 6]}%"></span>`
  )}</div>`;
}

export function pageSkeleton() {
  return html`<div class="page" aria-busy="true">
    <div class="page-header"><div style="width:240px"><span class="skeleton skeleton-line" style="width:60%"></span><span class="skeleton" style="height:28px;width:100%"></span></div></div>
    <div class="kpi-grid" style="margin-bottom:20px">${Array.from({ length: 6 }, () => html`<div class="card kpi"><span class="skeleton skeleton-line" style="width:50%"></span><span class="skeleton" style="height:26px;width:70%"></span></div>`)}</div>
    <div class="card">${skeletonRows(6)}</div>
  </div>`;
}

export function pagination({ page, pageSize, total }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return html``;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return html`<nav class="pagination" aria-label="Pagination">
    <span>Showing <strong>${start}–${end}</strong> of <strong>${total}</strong></span>
    <div class="actions">
      <button type="button" class="btn btn-secondary btn-sm" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>${icon("chevronLeft", "icon-sm")} Previous</button>
      <span>Page ${page} of ${pages}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Next ${icon("chevronRight", "icon-sm")}</button>
    </div>
  </nav>`;
}

/** Wire dropdown menus: [data-menu-toggle] toggles the next .menu sibling. */
export function setupMenus(root) {
  root.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-menu-toggle]");
    if (toggle && root.contains(toggle)) {
      event.stopPropagation();
      const menu = toggle.parentElement.querySelector(".menu");
      const open = menu.hidden;
      closeAllMenus();
      menu.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector(".menu-item")?.focus();
      return;
    }
    if (event.target.closest(".menu-item")) closeAllMenus();
  });
}

export function closeAllMenus() {
  $$(".menu").forEach((menu) => {
    menu.hidden = true;
    const toggle = menu.parentElement.querySelector("[data-menu-toggle]");
    toggle?.setAttribute("aria-expanded", "false");
  });
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) closeAllMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAllMenus();
});

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
  return Promise.resolve();
}

export { $ };
