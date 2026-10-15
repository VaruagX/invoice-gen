import { confirmDialog } from "./ui.js";

/*
 * Hash router for the /dashboard single-page app: #/invoices/123?status=paid
 * Pages can register a guard (unsaved changes) that is checked before leaving.
 */

const routes = [];
let guard = null;
let currentHref = window.location.href;
let ignoreNext = false;
let renderHandler = () => {};

// Hashes used by the previous version of the app.
const LEGACY = {
  "#dashboard": "/",
  "#invoices": "/invoices",
  "#create-invoice": "/invoices/new",
  "#customers": "/customers",
  "#business": "/settings",
  "#profile": "/profile",
};

export function addRoute(pattern, loader) {
  const keys = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/\/:([a-z_]+)/gi, (_, key) => {
        keys.push(key);
        return "/([^/]+)";
      }) +
      "/?$"
  );
  routes.push({ regex, keys, loader, pattern });
}

export function parseHash(hash = window.location.hash) {
  if (LEGACY[hash]) return parseHash(`#${LEGACY[hash]}`);
  const value = hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart = ""] = value.split("?");
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  return { path, query };
}

export function match(path) {
  for (const route of routes) {
    const found = path.match(route.regex);
    if (found) {
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(found[i + 1]);
      });
      return { route, params };
    }
  }
  return null;
}

export function href(path, query) {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== "" && v !== undefined && v !== null)).toString() : "";
  return `#${path}${qs ? `?${qs}` : ""}`;
}

export function navigate(path, query) {
  const target = href(path, query);
  if (window.location.hash === target) {
    renderHandler(parseHash());
    return;
  }
  window.location.hash = target;
}

/** Update the query string in place without re-rendering the page. */
export function replaceQuery(query) {
  const { path } = parseHash();
  const url = `${window.location.pathname}${href(path, query)}`;
  history.replaceState(null, "", url);
  currentHref = window.location.href;
}

export function setGuard(fn) {
  guard = fn;
}

export function clearGuard() {
  guard = null;
}

export async function confirmLeave() {
  if (!guard || guard()) return true;
  return confirmDialog({
    title: "Discard unsaved changes?",
    message: "You have changes that haven't been saved. If you leave now they will be lost.",
    confirmLabel: "Discard changes",
    danger: true,
  });
}

export function startRouter(onRoute) {
  renderHandler = onRoute;
  window.addEventListener("hashchange", async () => {
    if (ignoreNext) {
      ignoreNext = false;
      return;
    }
    if (guard && !guard()) {
      const leave = await confirmLeave();
      if (!leave) {
        history.replaceState(null, "", currentHref);
        return;
      }
    }
    guard = null;
    currentHref = window.location.href;
    onRoute(parseHash());
  });
  window.addEventListener("beforeunload", (event) => {
    if (guard && !guard()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  const legacy = LEGACY[window.location.hash];
  if (legacy) history.replaceState(null, "", `${window.location.pathname}#${legacy}`);
  currentHref = window.location.href;
  onRoute(parseHash());
}
