import { html, mount, $, $$, on, debounce, initials } from "./lib/dom.js";
import { api, setUnauthorizedHandler } from "./lib/api.js";
import { icon, GOOGLE_LOGO } from "./lib/icons.js";
import { store, loadBootstrap } from "./lib/store.js";
import { addRoute, match, navigate, startRouter, clearGuard } from "./lib/router.js";
import { toastError, statusPill, emptyState, setupMenus } from "./lib/ui.js";
import { money, date } from "./lib/format.js";

const app = document.getElementById("app");

addRoute("/", () => import("./pages/dashboard.js"));
addRoute("/invoices", () => import("./pages/invoices.js"));
addRoute("/invoices/new", () => import("./pages/invoice-editor.js"));
addRoute("/invoices/:id/edit", () => import("./pages/invoice-editor.js"));
addRoute("/invoices/:id", () => import("./pages/invoice-view.js"));
addRoute("/customers", () => import("./pages/customers.js"));
addRoute("/customers/:id", () => import("./pages/customer-view.js"));
addRoute("/payments", () => import("./pages/payments.js"));
addRoute("/overdue", () => import("./pages/overdue.js"));
addRoute("/reports", () => import("./pages/reports.js"));
addRoute("/settings", () => import("./pages/settings.js"));
addRoute("/profile", () => import("./pages/profile.js"));

const NAV = [
  { section: null, items: [{ path: "/", label: "Dashboard", icon: "dashboard" }] },
  {
    section: "Billing",
    items: [
      { path: "/invoices", label: "Invoices", icon: "invoice" },
      { path: "/payments", label: "Payments", icon: "wallet" },
      { path: "/overdue", label: "Overdue", icon: "clock", badge: "overdue" },
    ],
  },
  {
    section: "Business",
    items: [
      { path: "/customers", label: "Customers", icon: "users" },
      { path: "/reports", label: "Reports", icon: "chart" },
      { path: "/settings", label: "Business settings", icon: "settings" },
    ],
  },
];

function renderLogin() {
  const failed = new URLSearchParams(window.location.search).get("auth") === "failed";
  document.title = "Sign in · Invoice Studio";
  mount(
    app,
    html`<main class="login">
      <section class="login-card">
        <div class="login-hero">
          <div class="brand"><span class="brand-mark">IS</span><span>Invoice Studio</span></div>
          <div>
            <h1>Invoicing that keeps your business paid.</h1>
            <p>Create GST-ready invoices, record payments, and follow up on overdue bills from one clear workspace.</p>
          </div>
          <ul class="login-points">
            <li>${icon("invoice")}<span>Professional PDF invoices with CGST/SGST or IGST, HSN/SAC and amount in words</span></li>
            <li>${icon("wallet")}<span>Partial and multiple payments with receipts and an audit trail</span></li>
            <li>${icon("chart")}<span>Dashboards and reports built from your real records</span></li>
          </ul>
        </div>
        <div class="login-panel">
          <h2 style="font-size:22px">Sign in to your workspace</h2>
          <p class="muted">Use your Google account. Your invoices, customers and payments are private to your account.</p>
          ${failed
            ? html`<div class="callout callout-danger" role="alert">${icon("alert")}<span>Google sign-in didn't complete. Please try again.</span></div>`
            : ""}
          <a class="google-button" href="/auth/google">${GOOGLE_LOGO}<span>Continue with Google</span></a>
          <p class="faint small">By continuing you agree to keep your account details secure. Invoice Studio records payments you enter; it does not process payments.</p>
        </div>
      </section>
    </main>`
  );
}

function navLink(item) {
  const badge = item.badge === "overdue" && store.counts.overdue ? html`<span class="badge" aria-label="${store.counts.overdue} overdue">${store.counts.overdue}</span>` : "";
  return html`<a class="nav-link" href="#${item.path}" data-path="${item.path}">${icon(item.icon)}<span>${item.label}</span>${badge}</a>`;
}

function renderShell() {
  const user = store.user;
  mount(
    app,
    html`<div class="app">
      <aside class="sidebar" id="sidebar" aria-label="Main navigation">
        <a class="brand" href="#/"><span class="brand-mark">IS</span><span>Invoice Studio</span></a>
        <a class="btn btn-primary btn-block" href="#/invoices/new">${icon("plus")}<span>New invoice</span></a>
        ${NAV.map(
          (group) => html`${group.section ? html`<div class="nav-section">${group.section}</div>` : ""}
            <nav class="nav">${group.items.map(navLink)}</nav>`
        )}
        <div class="sidebar-footer">
          <a class="nav-link" href="#/profile" data-path="/profile">${icon("user")}<span>Profile</span></a>
          <a class="nav-link" href="/logout">${icon("logout")}<span>Sign out</span></a>
          <div class="user-chip">
            ${user.avatar_url
              ? html`<img class="avatar" src="${user.avatar_url}" alt="" referrerpolicy="no-referrer">`
              : html`<span class="avatar">${initials(user.name)}</span>`}
            <div><div class="name">${user.name}</div><div class="email">${user.email}</div></div>
          </div>
        </div>
      </aside>
      <div class="scrim" id="scrim"></div>
      <div class="workspace">
        <header class="topbar">
          <button class="btn btn-ghost btn-icon menu-button" type="button" id="menuButton" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">${icon("menu")}</button>
          <div class="global-search" role="search">
            ${icon("search")}
            <label class="sr-only" for="globalSearch">Search invoices, customers and payment references</label>
            <input id="globalSearch" type="search" autocomplete="off" placeholder="Search invoices, customers, references…"
              role="combobox" aria-expanded="false" aria-controls="searchResults" aria-autocomplete="list">
            <span class="kbd" aria-hidden="true">/</span>
            <div class="search-results" id="searchResults" role="listbox" hidden></div>
          </div>
          <div class="topbar-actions">
            <a class="btn btn-primary hide-sm" href="#/invoices/new">${icon("plus")}<span>New invoice</span></a>
          </div>
        </header>
        <main class="content" id="content" tabindex="-1"></main>
      </div>
    </div>`
  );
  setupShell();
}

function setSidebar(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#scrim").classList.toggle("open", open);
  $("#menuButton").setAttribute("aria-expanded", String(open));
}

function setupShell() {
  $("#menuButton").addEventListener("click", () => setSidebar(!$("#sidebar").classList.contains("open")));
  $("#scrim").addEventListener("click", () => setSidebar(false));
  setupGlobalSearch();
  document.addEventListener("keydown", (event) => {
    const typing = event.target.closest("input, textarea, select, [contenteditable]");
    if ((event.key === "/" && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) {
      event.preventDefault();
      $("#globalSearch").focus();
    }
  });
}

function setupGlobalSearch() {
  const input = $("#globalSearch");
  const panel = $("#searchResults");
  let items = [];
  let active = -1;
  let controller;

  const close = () => {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };

  const highlight = (index) => {
    active = index;
    $$(".search-item", panel).forEach((el, i) => el.setAttribute("aria-selected", String(i === index)));
    const el = $$(".search-item", panel)[index];
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", el.id);
    }
  };

  const go = (target) => {
    close();
    input.value = "";
    navigate(target);
  };

  const run = debounce(async (q) => {
    controller?.abort();
    if (q.length < 2) return close();
    controller = new AbortController();
    try {
      const data = await api("/search", { query: { q }, signal: controller.signal });
      items = [
        ...data.invoices.map((inv) => ({ group: "Invoices", target: `/invoices/${inv.id}`, row: inv, type: "invoice" })),
        ...data.customers.map((c) => ({ group: "Customers", target: `/customers/${c.id}`, row: c, type: "customer" })),
        ...data.payments.map((p) => ({ group: "Payment references", target: `/invoices/${p.invoice_id}`, row: p, type: "payment" })),
      ];
      let lastGroup = null;
      mount(
        panel,
        items.length
          ? items.map((item, i) => {
              const header = item.group !== lastGroup ? html`<div class="search-group" role="presentation">${item.group}</div>` : "";
              lastGroup = item.group;
              const r = item.row;
              let body;
              if (item.type === "invoice") {
                body = html`<span><strong>${r.invoice_number}</strong> <span class="meta">${r.customer_name || "No customer"} · ${date(r.issue_date)}</span></span>
                  <span class="actions">${statusPill(r.display_status)}<span class="num">${money(r.total, r.currency)}</span></span>`;
              } else if (item.type === "customer") {
                body = html`<span><strong>${r.name}</strong> <span class="meta">${[r.company_name, r.email || r.phone].filter(Boolean).join(" · ")}</span></span>
                  ${r.archived_at ? html`<span class="tag">Archived</span>` : ""}`;
              } else {
                body = html`<span><strong>${r.reference || r.receipt_number}</strong> <span class="meta">${r.receipt_number} · ${r.invoice_number} · ${date(r.payment_date)}</span></span>
                  <span class="num">${money(r.amount, r.currency)}</span>`;
              }
              return html`${header}<button type="button" class="search-item" role="option" id="search-opt-${i}" data-index="${i}" aria-selected="false">${body}</button>`;
            })
          : html`<div class="empty" style="padding:24px">${icon("search")}<p>No matches for “${q}”. Try an invoice number, customer name, phone or payment reference.</p></div>`
      );
      panel.hidden = false;
      input.setAttribute("aria-expanded", "true");
      active = -1;
    } catch (error) {
      if (error.name !== "AbortError") toastError(error);
    }
  }, 220);

  input.addEventListener("input", () => run(input.value.trim()));
  input.addEventListener("keydown", (event) => {
    if (panel.hidden) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlight(Math.min(items.length - 1, active + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlight(Math.max(0, active - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[active >= 0 ? active : 0];
      if (item) go(item.target);
    } else if (event.key === "Escape") {
      close();
    }
  });
  on(panel, "click", ".search-item", (el) => go(items[Number(el.dataset.index)].target));
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".global-search")) close();
  });
}

let renderToken = 0;

async function renderRoute({ path, query }) {
  const content = $("#content");
  if (!content) return;
  const token = ++renderToken;
  setSidebar(false);
  $$(".nav-link[data-path]").forEach((link) => {
    const linkPath = link.dataset.path;
    const active = linkPath === "/" ? path === "/" : path === linkPath || path.startsWith(`${linkPath}/`);
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  const found = match(path);
  clearGuard();
  if (!found) {
    document.title = "Not found · Invoice Studio";
    mount(content, html`<div class="page card">${emptyState({ iconName: "search", title: "Page not found", text: "That page doesn't exist.", actions: html`<a class="btn btn-primary" href="#/">Go to dashboard</a>` })}</div>`);
    return;
  }

  try {
    const module = await found.route.loader();
    if (token !== renderToken) return;
    const page = document.createElement("div");
    page.className = "page";
    content.replaceChildren(page);
    setupMenus(page);
    window.scrollTo({ top: 0 });
    await module.render({
      root: page,
      params: found.params,
      query,
      isCurrent: () => token === renderToken,
      setTitle: (title) => {
        document.title = `${title} · Invoice Studio`;
      },
    });
  } catch (error) {
    if (token !== renderToken) return;
    console.error(error);
    mount(
      content,
      html`<div class="page card">${emptyState({
        iconName: "alert",
        title: error.status === 404 ? "Not found" : "Couldn't load this page",
        text: error.message || "Please try again.",
        actions: html`<button class="btn btn-secondary" type="button" id="retryPage">Try again</button><a class="btn btn-ghost" href="#/">Dashboard</a>`,
      })}</div>`
    );
    $("#retryPage")?.addEventListener("click", () => renderRoute({ path, query }));
  }
}

/** Refresh the counts shown in the sidebar (overdue badge). */
export async function refreshCounts() {
  try {
    const data = await api("/bootstrap");
    store.counts = data.counts;
    const link = $('.nav-link[data-path="/overdue"]');
    if (link) {
      link.querySelector(".badge")?.remove();
      const overdue = Number(store.counts.overdue) || 0;
      if (overdue) link.insertAdjacentHTML("beforeend", `<span class="badge" aria-label="${overdue} overdue">${overdue}</span>`);
    }
  } catch (error) {
    // Non-critical.
  }
}
window.addEventListener("invoice-studio:changed", refreshCounts);

async function init() {
  setUnauthorizedHandler(() => {
    window.location.href = "/";
  });
  try {
    await loadBootstrap();
  } catch (error) {
    if (error.status === 401) {
      if (window.location.pathname !== "/") history.replaceState(null, "", `/${window.location.search}`);
      renderLogin();
      return;
    }
    mount(app, html`<main class="login"><section class="card" style="max-width:460px">${emptyState({ iconName: "alert", title: "Can't reach Invoice Studio", text: error.message, actions: html`<button class="btn btn-primary" type="button">Retry</button>` })}</section></main>`);
    app.querySelector("button")?.addEventListener("click", () => window.location.reload());
    return;
  }
  if (!window.location.pathname.startsWith("/dashboard")) {
    history.replaceState(null, "", `/dashboard${window.location.hash}`);
  }
  renderShell();
  startRouter(renderRoute);
}

init();
