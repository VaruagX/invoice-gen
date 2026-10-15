import { html, mount, $, on, debounce } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { replaceQuery, navigate } from "../lib/router.js";
import { emptyState, pagination, toastError, skeletonRows } from "../lib/ui.js";
import { money, plural } from "../lib/format.js";
import { openCustomerDialog } from "../components/customer-dialog.js";

const FILTERS = [
  { value: "active", label: "Active" },
  { value: "outstanding", label: "With balance due" },
  { value: "overdue", label: "Overdue" },
  { value: "gst", label: "GST registered" },
  { value: "archived", label: "Archived" },
];

const SORTS = [
  { value: "name", label: "Name (A–Z)" },
  { value: "recent", label: "Recently added" },
  { value: "outstanding", label: "Balance due" },
  { value: "invoiced", label: "Total invoiced" },
];

export async function render({ root, query, setTitle, isCurrent }) {
  setTitle("Customers");
  const state = {
    filter: FILTERS.some((f) => f.value === query.filter) ? query.filter : "active",
    search: query.search || "",
    sort: SORTS.some((s) => s.value === query.sort) ? query.sort : "name",
    page: Number(query.page) || 1,
  };

  mount(
    root,
    html`<div class="page-header">
      <div><h1>Customers</h1><p>Billing details, invoice history and balances for everyone you bill.</p></div>
      <div class="actions"><button type="button" class="btn btn-primary" data-action="add">${icon("plus")}Add customer</button></div>
    </div>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Filter customers">${FILTERS.map(
        (f) => html`<button type="button" class="chip" data-filter="${f.value}" aria-pressed="${String(f.value === state.filter)}">${f.label}</button>`
      )}</div>
    </div>
    <div class="toolbar">
      <div class="grow search-input">${icon("search")}
        <label class="sr-only" for="custSearch">Search customers</label>
        <input class="input" id="custSearch" type="search" placeholder="Name, company, email, phone or GSTIN" value="${state.search}">
      </div>
      <label class="sr-only" for="custSort">Sort</label>
      <select class="select" id="custSort">${SORTS.map((s) => html`<option value="${s.value}" ${s.value === state.sort ? "selected" : ""}>${s.label}</option>`)}</select>
    </div>
    <section class="card" id="custTable">${skeletonRows(6)}</section>`
  );

  const area = $("#custTable", root);
  let controller;

  const load = async () => {
    controller?.abort();
    controller = new AbortController();
    replaceQuery({ filter: state.filter === "active" ? "" : state.filter, search: state.search, sort: state.sort === "name" ? "" : state.sort, page: state.page > 1 ? state.page : "" });
    area.style.opacity = "0.6";
    try {
      const data = await api("/customers", {
        query: { filter: state.filter, search: state.search, sort: state.sort, page: state.page },
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (!data.items.length) {
        const filtered = state.search || state.filter !== "active";
        mount(
          area,
          filtered
            ? emptyState({ iconName: "search", title: "No customers match", text: "Try another search or filter.", actions: html`<button type="button" class="btn btn-secondary" data-reset>Clear filters</button>` })
            : emptyState({
                iconName: "users",
                title: "No customers yet",
                text: "Add customers once and pick them when you create invoices. GSTIN and state decide how GST is applied.",
                actions: html`<button type="button" class="btn btn-primary" data-action="add">${icon("plus")}Add customer</button>`,
              })
        );
        return;
      }
      mount(
        area,
        html`<div class="table-wrap"><table class="table responsive">
          <thead><tr><th>Customer</th><th>Contact</th><th>GSTIN</th><th class="num">Invoiced</th><th class="num">Paid</th><th class="num">Balance due</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${data.items.map(
            (c) => html`<tr>
              <td class="primary-cell"><a class="row-link" href="#/customers/${c.id}">${c.name}</a>
                ${c.company_name ? html`<span class="cell-sub">${c.company_name}</span>` : ""}
                ${c.archived_at ? html`<span class="tag">Archived</span>` : ""}</td>
              <td data-label="Contact">${c.email || c.phone ? html`${c.email}${c.email && c.phone ? html`<br>` : ""}<span class="muted">${c.phone}</span>` : html`<span class="faint">—</span>`}</td>
              <td data-label="GSTIN">${c.gst_number || html`<span class="faint">—</span>`}</td>
              <td data-label="Invoiced" class="num">${money(c.total_invoiced)}<span class="cell-sub">${plural(c.issued_count, "invoice")}</span></td>
              <td data-label="Paid" class="num">${money(c.total_paid)}</td>
              <td data-label="Balance due" class="num strong">${money(c.outstanding)}${c.overdue_count ? html`<span class="cell-sub" style="color:var(--danger)">${c.overdue_count} overdue</span>` : ""}</td>
              <td class="actions-cell"><div class="row-actions">
                ${c.archived_at ? "" : html`<a class="btn btn-ghost btn-sm" href="#/invoices/new?customer=${c.id}">${icon("plus", "icon-sm")}Invoice</a>`}
                <a class="btn btn-ghost btn-sm" href="#/customers/${c.id}">View</a>
              </div></td>
            </tr>`
          )}</tbody>
        </table></div>${pagination({ page: data.page, pageSize: data.page_size, total: data.total })}`
      );
    } catch (error) {
      if (error.name !== "AbortError") toastError(error);
    } finally {
      area.style.opacity = "1";
    }
  };

  on(root, "click", "[data-filter]", (chip) => {
    state.filter = chip.dataset.filter;
    state.page = 1;
    root.querySelectorAll("[data-filter]").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    load();
  });
  on(root, "click", "[data-reset]", () => {
    state.filter = "active";
    state.search = "";
    state.page = 1;
    $("#custSearch", root).value = "";
    root.querySelectorAll("[data-filter]").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.filter === "active")));
    load();
  });
  on(root, "click", "[data-action='add']", () => openCustomerDialog({ onSaved: (customer) => navigate(`/customers/${customer.id}`) }));
  on(root, "click", "[data-page]", (button) => {
    state.page = Number(button.dataset.page);
    load();
  });
  $("#custSearch", root).addEventListener(
    "input",
    debounce((event) => {
      state.search = event.target.value.trim();
      state.page = 1;
      load();
    }, 300)
  );
  $("#custSort", root).addEventListener("change", (event) => {
    state.sort = event.target.value;
    load();
  });

  await load();
  if (query.new === "1") openCustomerDialog({ onSaved: (customer) => navigate(`/customers/${customer.id}`) });
}
