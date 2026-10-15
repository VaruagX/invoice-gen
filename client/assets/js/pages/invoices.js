import { html, mount, $, on, debounce } from "../lib/dom.js";
import { api, download } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { replaceQuery, navigate } from "../lib/router.js";
import { statusPill, emptyState, pagination, toast, toastError, confirmDialog, skeletonRows } from "../lib/ui.js";
import { money, date, plural } from "../lib/format.js";
import { openPaymentDialog } from "../components/payment-dialog.js";

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "open", label: "Unpaid (all)" },
  { value: "unpaid", label: "Unpaid" },
  { value: "partially_paid", label: "Partially paid" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
];

const SORTS = [
  { value: "issue_date:desc", label: "Newest first" },
  { value: "issue_date:asc", label: "Oldest first" },
  { value: "due_date:asc", label: "Due date (soonest)" },
  { value: "total:desc", label: "Amount (high to low)" },
  { value: "total:asc", label: "Amount (low to high)" },
  { value: "balance:desc", label: "Balance due (high to low)" },
  { value: "number:desc", label: "Invoice number" },
];

const FILTER_KEYS = ["status", "search", "customer_id", "from", "to", "date_field", "min_amount", "max_amount", "sort", "page"];

export function invoiceActionsMenu(inv) {
  const open = ["unpaid", "partially_paid"].includes(inv.status);
  return html`<div class="menu-wrap">
    <button type="button" class="btn btn-ghost btn-icon btn-sm" data-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${inv.invoice_number}">${icon("more")}</button>
    <div class="menu" role="menu" hidden>
      <a class="menu-item" role="menuitem" href="#/invoices/${inv.id}">${icon("eye")}View</a>
      ${inv.status !== "cancelled" ? html`<a class="menu-item" role="menuitem" href="#/invoices/${inv.id}/edit">${icon("edit")}Edit</a>` : ""}
      ${open ? html`<button type="button" class="menu-item" role="menuitem" data-action="inv-pay" data-id="${inv.id}">${icon("wallet")}Record payment</button>` : ""}
      <button type="button" class="menu-item" role="menuitem" data-action="inv-pdf" data-id="${inv.id}" data-number="${inv.invoice_number}">${icon("download")}Download PDF</button>
      <button type="button" class="menu-item" role="menuitem" data-action="inv-duplicate" data-id="${inv.id}">${icon("copy")}Duplicate</button>
      <div class="menu-sep"></div>
      <button type="button" class="menu-item danger" role="menuitem" data-action="inv-delete" data-id="${inv.id}" data-number="${inv.invoice_number}" data-status="${inv.status}">${icon("trash")}Delete</button>
    </div>
  </div>`;
}

/** Shared handlers for invoice row actions. `reload` refreshes the list afterwards. */
export function bindInvoiceActions(root, reload) {
  on(root, "click", "[data-action^='inv-']", async (el) => {
    const { action, id } = el.dataset;
    try {
      if (action === "inv-pdf") {
        await download(`/invoices/${id}/pdf`, `${el.dataset.number}.pdf`);
      } else if (action === "inv-pay") {
        const invoice = await api(`/invoices/${id}`);
        openPaymentDialog({ invoice, onSaved: reload });
      } else if (action === "inv-duplicate") {
        const copy = await api(`/invoices/${id}/duplicate`, { method: "POST" });
        toast(`Draft ${copy.invoice_number} created from the copy.`, { title: "Invoice duplicated" });
        navigate(`/invoices/${copy.id}/edit`);
      } else if (action === "inv-delete") {
        const draft = el.dataset.status === "draft";
        const ok = await confirmDialog({
          title: `Delete ${el.dataset.number}?`,
          message: draft
            ? "This draft will be permanently deleted."
            : "Deleting an issued invoice leaves a gap in your invoice numbering. Cancelling keeps a record instead. Invoices with payments can't be deleted.",
          confirmLabel: "Delete invoice",
          danger: true,
        });
        if (!ok) return;
        await api(`/invoices/${id}`, { method: "DELETE" });
        toast(`${el.dataset.number} deleted.`);
        window.dispatchEvent(new CustomEvent("invoice-studio:changed"));
        reload();
      }
    } catch (error) {
      toastError(error);
    }
  });
}

export function invoiceTable(rows, { showCustomer = true } = {}) {
  return html`<div class="table-wrap"><table class="table responsive">
    <thead><tr>
      <th>Invoice</th>${showCustomer ? html`<th>Customer</th>` : ""}<th>Issued</th><th>Due</th>
      <th class="num">Amount</th><th class="num">Balance</th><th>Status</th><th><span class="sr-only">Actions</span></th>
    </tr></thead>
    <tbody>${rows.map(
      (inv) => html`<tr>
        <td class="primary-cell"><a class="row-link" href="#/invoices/${inv.id}">${inv.invoice_number}</a></td>
        ${showCustomer
          ? html`<td data-label="Customer">${inv.customer_name || html`<span class="faint">No customer</span>`}${inv.customer_company ? html`<span class="cell-sub">${inv.customer_company}</span>` : ""}</td>`
          : ""}
        <td data-label="Issued" class="nowrap">${date(inv.issue_date)}</td>
        <td data-label="Due" class="nowrap">${date(inv.due_date)}${inv.is_overdue ? html`<span class="cell-sub" style="color:var(--danger)">${plural(inv.days_overdue, "day")} overdue</span>` : ""}</td>
        <td data-label="Amount" class="num strong">${money(inv.total, inv.currency)}</td>
        <td data-label="Balance" class="num">${["unpaid", "partially_paid"].includes(inv.status) ? money(inv.balance_due, inv.currency) : html`<span class="faint">—</span>`}</td>
        <td data-label="Status">${statusPill(inv.display_status)}</td>
        <td class="actions-cell"><div class="row-actions">${invoiceActionsMenu(inv)}</div></td>
      </tr>`
    )}</tbody>
  </table></div>`;
}

export async function render({ root, query, setTitle, isCurrent }) {
  setTitle("Invoices");
  const state = Object.fromEntries(FILTER_KEYS.map((key) => [key, query[key] || ""]));
  state.sort = state.sort || "issue_date:desc";
  state.page = Number(state.page) || 1;
  const advancedOpen = Boolean(state.from || state.to || state.min_amount || state.max_amount || state.customer_id);

  const customers = await api("/customers/options").catch(() => []);
  if (!isCurrent()) return;

  mount(
    root,
    html`<div class="page-header">
      <div><h1>Invoices</h1><p>Search, filter and manage every invoice you've issued.</p></div>
      <div class="actions"><a class="btn btn-primary" href="#/invoices/new">${icon("plus")}Create invoice</a></div>
    </div>
    <div class="tabs" role="tablist" aria-label="Filter by status">${STATUS_TABS.map(
      (tab) => html`<button type="button" class="tab" role="tab" data-status="${tab.value}" aria-selected="${String(tab.value === state.status)}">${tab.label}</button>`
    )}</div>
    <div class="toolbar">
      <div class="grow search-input">
        ${icon("search")}
        <label class="sr-only" for="invSearch">Search invoices</label>
        <input class="input" id="invSearch" type="search" placeholder="Invoice number, customer, email, phone or payment reference" value="${state.search}">
      </div>
      <label class="sr-only" for="invSort">Sort</label>
      <select class="select" id="invSort">${SORTS.map((s) => html`<option value="${s.value}" ${s.value === state.sort ? "selected" : ""}>${s.label}</option>`)}</select>
      <button type="button" class="btn btn-secondary" id="toggleFilters" aria-expanded="${String(advancedOpen)}" aria-controls="advancedFilters">${icon("filter")}Filters</button>
      <button type="button" class="btn btn-ghost" id="clearFilters">Clear</button>
    </div>
    <div class="filter-panel" id="advancedFilters" ${advancedOpen ? "" : "hidden"}>
      <div class="field"><label for="fCustomer">Customer</label>
        <select class="select" id="fCustomer"><option value="">All customers</option>${customers.map(
          (c) => html`<option value="${c.id}" ${c.id === state.customer_id ? "selected" : ""}>${c.name}${c.company_name ? ` (${c.company_name})` : ""}</option>`
        )}</select></div>
      <div class="field"><label for="fDateField">Date type</label>
        <select class="select" id="fDateField"><option value="">Invoice date</option><option value="due" ${state.date_field === "due" ? "selected" : ""}>Due date</option></select></div>
      <div class="field"><label for="fFrom">From</label><input class="input" type="date" id="fFrom" value="${state.from}"></div>
      <div class="field"><label for="fTo">To</label><input class="input" type="date" id="fTo" value="${state.to}"></div>
      <div class="field"><label for="fMin">Min amount</label><input class="input" id="fMin" inputmode="decimal" value="${state.min_amount}" placeholder="0"></div>
      <div class="field"><label for="fMax">Max amount</label><input class="input" id="fMax" inputmode="decimal" value="${state.max_amount}" placeholder="Any"></div>
    </div>
    <div class="result-summary" id="invSummary" aria-live="polite"></div>
    <section class="card" id="invTable">${skeletonRows(8)}</section>`
  );

  const table = $("#invTable", root);
  let controller;

  const load = async () => {
    controller?.abort();
    controller = new AbortController();
    const [sort, dir] = state.sort.split(":");
    const params = {
      status: state.status,
      search: state.search,
      customer_id: state.customer_id,
      from: state.from,
      to: state.to,
      date_field: state.date_field,
      min_amount: state.min_amount,
      max_amount: state.max_amount,
      sort,
      dir,
      page: state.page,
    };
    replaceQuery({ ...params, sort: state.sort === "issue_date:desc" ? "" : state.sort, dir: "", page: state.page > 1 ? state.page : "" });
    table.style.opacity = "0.6";
    try {
      const data = await api("/invoices", { query: params, signal: controller.signal });
      if (!isCurrent()) return;
      const filtered = Object.entries(params).some(([key, value]) => !["sort", "dir", "page"].includes(key) && value);
      mount(
        $("#invSummary", root),
        data.total
          ? html`<span><strong>${plural(data.total, "invoice")}</strong></span>
              <span>Invoiced <strong>${money(data.summary.total)}</strong></span>
              <span>Outstanding <strong>${money(data.summary.balance)}</strong></span>`
          : ""
      );
      mount(
        table,
        data.items.length
          ? html`${invoiceTable(data.items)}${pagination({ page: data.page, pageSize: data.page_size, total: data.total })}`
          : filtered
            ? emptyState({
                iconName: "search",
                title: "No invoices match these filters",
                text: "Try a different search or clear the filters.",
                actions: html`<button type="button" class="btn btn-secondary" data-clear>Clear filters</button>`,
              })
            : emptyState({
                title: "No invoices yet",
                text: "Create your first invoice — totals, GST and the PDF are calculated for you.",
                actions: html`<a class="btn btn-primary" href="#/invoices/new">${icon("plus")}Create invoice</a>`,
              })
      );
    } catch (error) {
      if (error.name !== "AbortError") toastError(error);
    } finally {
      table.style.opacity = "1";
    }
  };

  const reset = () => {
    Object.assign(state, { status: "", search: "", customer_id: "", from: "", to: "", date_field: "", min_amount: "", max_amount: "", page: 1 });
    $("#invSearch", root).value = "";
    ["#fCustomer", "#fDateField", "#fFrom", "#fTo", "#fMin", "#fMax"].forEach((id) => {
      $(id, root).value = "";
    });
    root.querySelectorAll("[data-status]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.status === "")));
    load();
  };

  on(root, "click", "[data-status]", (tab) => {
    state.status = tab.dataset.status;
    state.page = 1;
    root.querySelectorAll("[data-status]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    load();
  });
  const searchChanged = debounce(() => {
    state.search = $("#invSearch", root).value.trim();
    state.page = 1;
    load();
  }, 300);
  $("#invSearch", root).addEventListener("input", searchChanged);
  $("#invSort", root).addEventListener("change", (event) => {
    state.sort = event.target.value;
    load();
  });
  $("#toggleFilters", root).addEventListener("click", (event) => {
    const panel = $("#advancedFilters", root);
    panel.hidden = !panel.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
  });
  $("#clearFilters", root).addEventListener("click", reset);
  on(root, "click", "[data-clear]", reset);
  const filterMap = { "#fCustomer": "customer_id", "#fDateField": "date_field", "#fFrom": "from", "#fTo": "to", "#fMin": "min_amount", "#fMax": "max_amount" };
  Object.entries(filterMap).forEach(([id, key]) => {
    $(id, root).addEventListener(
      id === "#fMin" || id === "#fMax" ? "input" : "change",
      debounce((event) => {
        state[key] = event.target.value.trim();
        state.page = 1;
        load();
      }, 350)
    );
  });
  on(root, "click", "[data-page]", (button) => {
    state.page = Number(button.dataset.page);
    load();
    root.scrollIntoView({ behavior: "smooth" });
  });
  bindInvoiceActions(root, load);

  await load();
}
