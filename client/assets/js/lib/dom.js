/*
 * Safe HTML templating. Every interpolated value is escaped unless it is the
 * result of another html`` call (or raw()), so user data can never inject markup.
 */

class SafeHtml {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (ch) => ESCAPES[ch]);
}

function toHtml(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(toHtml).join("");
  if (value === null || value === undefined || value === false || value === true) return "";
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += toHtml(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Trusted markup only (icons, pre-escaped strings). Never pass user data. */
export function raw(value) {
  return new SafeHtml(String(value));
}

export function mount(element, content) {
  element.innerHTML = toHtml(content);
  return element;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/** Delegate events: on(root, "click", "[data-action]", (el, event) => ...). */
export function on(root, type, selector, handler, options) {
  const listener = (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(target, event);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

export function debounce(fn, wait = 250) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/** Read a form into a plain object (checkboxes become booleans). */
export function formValues(form) {
  const data = {};
  for (const element of form.elements) {
    if (!element.name || element.disabled || element.type === "file") continue;
    if (element.type === "checkbox") data[element.name] = element.checked;
    else if (element.type === "radio") {
      if (element.checked) data[element.name] = element.value;
    } else data[element.name] = element.value;
  }
  return data;
}

export function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}
