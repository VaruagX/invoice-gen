import { html, mount, $, on, debounce } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { replaceQuery } from "../lib/router.js";
import { emptyState, toastError, skeletonRows } from "../lib/ui.js";
import { money, date, plural } from "../lib/format.js";
import { openPaymentDialog } from "../components/payment-dialog.js";
import { openReminder } from "./invoice-view.js";

const BUCKETS = [
  { value: "", label: "All overdue" },
  { value: "1-30", label: "1–30 days" },
  { value: "31-60", label: "31–60 days" },
  { value: "61-90", label: "61–90 days" },
  { value: "90+", label: "90+ days" },
];

export async function render({ root, query, setTitle, isCurrent }) {
  setTitle("Overdue invoices");
  const state = {
    bucket: BUCKETS.some((b) => b.value === query.bucket) ? query.bucket : "",
    sort: ["amount", "days"].includes(query.sort) ? query.sort : "amount",
    search: query.search || "",
  };

  mount(
    root,
    html`<div class="page-header">
      <div><h1>Overdue invoices</h1><p>Issued invoices past their due date with money still owed — including partially paid ones.</p></div>
    </div>
    <div class="kpi-grid" id="bucketCards" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:16px"></div>
    <div class="toolbar">
      <div class="grow search-input">${icon("search")}
        <label class="sr-only" for="odSearch">Search overdue invoices</label>
        <input class="input" id="odSearch" type="search" placeholder="Invoice number or customer" value="${state.search}">
      </div>
      <label class="sr-only" for="odSort">Sort</label>
      <select class="select" id="odSort">
        <option value="amount" ${state.sort === "amount" ? "selected" : ""}>Highest balance first</option>
        <option value="days" ${state.sort === "days" ? "selected" : ""}>Most days overdue first</option>
      </select>
    </div>
    <section class="card" id="odTable">${skeletonRows(5)}</section>`
  );

  const area = $("#odTable", root);
  let rows = [];
  let controller;

  const load = async () => {
    controller?.abort();
    controller = new AbortController();
    replaceQuery({ bucket: state.bucket, sort: state.sort === "amount" ? "" : state.sort, search: state.search });
    area.style.opacity = "0.6";
    try {
      const data = await api("/invoices/overdue", { query: state, signal: controller.signal });
      if (!isCurrent()) return;
      rows = data.items;
      const all = data.buckets.reduce((acc, b) => ({ count: acc.count + b.count, amount: acc.amount + window.InvoiceCore.toUnits(b.amount) }), { count: 0, amount: 0 });
      mount(
        $("#bucketCards", root),
        BUCKETS.map((b) => {
          const info = b.value ? data.buckets.find((x) => x.bucket === b.value) : { count: all.count, amount: window.InvoiceCore.unitsToString(all.amount) };
          return html`<button type="button" class="card kpi" data-bucket="${b.value}" aria-pressed="${String(b.value === state.bucket)}"
            style="text-align:left;cursor:pointer;${b.value === state.bucket ? "border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-ring)" : ""}">
            <span class="kpi-label">${b.label}</span>
            <span class="kpi-value">${money(info.amount)}</span>
            <span class="kpi-sub">${plural(info.count, "invoice")}</span>
          </button>`;
        })
      );
      mount(
        area,
        rows.length
          ? html`<div class="table-wrap"><table class="table responsive">
              <thead><tr><th>Invoice</th><th>Customer & contact</th><th>Due</th><th class="num">Days overdue</th><th class="num">Balance</th><th><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>${rows.map(
                (inv, i) => html`<tr>
                  <td class="primary-cell"><a class="row-link" href="#/invoices/${inv.id}">${inv.invoice_number}</a><span class="cell-sub">${money(inv.total, inv.currency)} total${inv.status === "partially_paid" ? " · partially paid" : ""}</span></td>
                  <td data-label="Customer">${inv.customer_name || html`<span class="faint">No customer</span>`}
                    <span class="cell-sub">${inv.customer_phone ? html`<a href="tel:${inv.customer_phone.replace(/[^+\d]/g, "")}">${inv.customer_phone}</a>` : ""}${inv.customer_phone && inv.customer_email ? " · " : ""}${inv.customer_email ? html`<a href="mailto:${inv.customer_email}">${inv.customer_email}</a>` : ""}${!inv.customer_phone && !inv.customer_email ? "No contact details" : ""}</span></td>
                  <td data-label="Due" class="nowrap">${date(inv.due_date)}</td>
                  <td data-label="Days overdue" class="num"><strong style="color:var(--danger)">${inv.days_overdue}</strong></td>
                  <td data-label="Balance" class="num strong">${money(inv.balance_due, inv.currency)}</td>
                  <td class="actions-cell"><div class="row-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="pay" data-index="${i}">${icon("wallet", "icon-sm")}Record payment</button>
                    <button type="button" class="btn btn-ghost btn-sm" data-action="remind" data-index="${i}">${icon("mail", "icon-sm")}Reminder</button>
                  </div></td>
                </tr>`
              )}</tbody>
            </table></div>`
          : emptyState({
              iconName: "checkCircle",
              title: state.bucket || state.search ? "Nothing overdue here" : "No overdue invoices",
              text: state.bucket || state.search ? "No invoices match this filter." : "Every issued invoice is either paid or not yet due. Nice work.",
            })
      );
    } catch (error) {
      if (error.name !== "AbortError") toastError(error);
    } finally {
      area.style.opacity = "1";
    }
  };

  on(root, "click", "[data-bucket]", (button) => {
    state.bucket = button.dataset.bucket;
    load();
  });
  on(root, "click", "[data-action]", (el) => {
    const inv = rows[Number(el.dataset.index)];
    if (!inv) return;
    if (el.dataset.action === "pay") openPaymentDialog({ invoice: inv, onSaved: load });
    if (el.dataset.action === "remind") openReminder(inv);
  });
  $("#odSearch", root).addEventListener("input", debounce((e) => { state.search = e.target.value.trim(); load(); }, 300));
  $("#odSort", root).addEventListener("change", (e) => { state.sort = e.target.value; load(); });
  await load();
}
