import { html, mount, $, on, debounce } from "../lib/dom.js";
import { api, download } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { replaceQuery } from "../lib/router.js";
import { emptyState, pagination, toast, toastError, openModal, skeletonRows } from "../lib/ui.js";
import { money, date, plural, methodLabel } from "../lib/format.js";
import { openPaymentDialog } from "../components/payment-dialog.js";

const core = window.InvoiceCore;

export async function render({ root, query, setTitle, isCurrent }) {
  setTitle("Payments");
  const state = {
    search: query.search || "",
    method: query.method || "",
    from: query.from || "",
    to: query.to || "",
    include_voided: query.include_voided === "1",
    page: Number(query.page) || 1,
  };

  mount(
    root,
    html`<div class="page-header">
      <div><h1>Payments</h1><p>Money received against your invoices. Recording a payment updates the invoice balance automatically.</p></div>
      <div class="actions"><button type="button" class="btn btn-primary" data-action="record">${icon("plus")}Record payment</button></div>
    </div>
    <div class="toolbar">
      <div class="grow search-input">${icon("search")}
        <label class="sr-only" for="paySearch">Search payments</label>
        <input class="input" id="paySearch" type="search" placeholder="Invoice, customer, reference or receipt number" value="${state.search}">
      </div>
      <label class="sr-only" for="payMethod">Method</label>
      <select class="select" id="payMethod"><option value="">All methods</option>${core.PAYMENT_METHODS.map(
        (m) => html`<option value="${m.value}" ${m.value === state.method ? "selected" : ""}>${m.label}</option>`
      )}</select>
      <label class="sr-only" for="payFrom">From</label><input class="input" type="date" id="payFrom" value="${state.from}" aria-label="From date">
      <label class="sr-only" for="payTo">To</label><input class="input" type="date" id="payTo" value="${state.to}" aria-label="To date">
      <label class="check" style="align-items:center"><input type="checkbox" id="payVoided" ${state.include_voided ? "checked" : ""}><span>Show voided</span></label>
    </div>
    <div class="result-summary" id="paySummary" aria-live="polite"></div>
    <section class="card" id="payTable">${skeletonRows(6)}</section>`
  );

  const area = $("#payTable", root);
  let controller;
  const load = async () => {
    controller?.abort();
    controller = new AbortController();
    const params = { search: state.search, method: state.method, from: state.from, to: state.to, include_voided: state.include_voided ? "1" : "", page: state.page };
    replaceQuery({ ...params, page: state.page > 1 ? state.page : "" });
    area.style.opacity = "0.6";
    try {
      const data = await api("/payments", { query: params, signal: controller.signal });
      if (!isCurrent()) return;
      mount($("#paySummary", root), data.total ? html`<span><strong>${plural(data.total, "payment")}</strong></span><span>Received <strong>${money(data.amount)}</strong></span>` : "");
      const filtered = state.search || state.method || state.from || state.to;
      mount(
        area,
        data.items.length
          ? html`<div class="table-wrap"><table class="table responsive">
              <thead><tr><th>Date</th><th>Receipt</th><th>Invoice</th><th>Customer</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>${data.items.map(
                (p) => html`<tr>
                  <td class="primary-cell nowrap"><strong>${date(p.payment_date)}</strong>${p.voided_at ? html` <span class="pill pill-voided">Voided</span>` : ""}</td>
                  <td data-label="Receipt">${p.receipt_number || "—"}</td>
                  <td data-label="Invoice"><a href="#/invoices/${p.invoice_id}">${p.invoice_number}</a></td>
                  <td data-label="Customer">${p.customer_name || html`<span class="faint">—</span>`}</td>
                  <td data-label="Method">${methodLabel(p.method)}${p.source === "migration" ? html`<span class="cell-sub">Recorded during upgrade</span>` : ""}</td>
                  <td data-label="Reference">${p.reference || html`<span class="faint">—</span>`}</td>
                  <td data-label="Amount" class="num strong" style="${p.voided_at ? "text-decoration:line-through;color:var(--faint)" : ""}">${money(p.amount, p.currency)}</td>
                  <td class="actions-cell"><div class="row-actions">
                    <button type="button" class="btn btn-ghost btn-sm" data-action="receipt" data-id="${p.id}" data-number="${p.receipt_number || "receipt"}">${icon("receipt", "icon-sm")}Receipt</button>
                    ${p.voided_at ? "" : html`<button type="button" class="btn btn-danger-ghost btn-sm" data-action="void" data-id="${p.id}" data-amount="${p.amount}" data-currency="${p.currency}">Void</button>`}
                  </div></td>
                </tr>`
              )}</tbody>
            </table></div>${pagination({ page: data.page, pageSize: data.page_size, total: data.total })}`
          : filtered
            ? emptyState({ iconName: "search", title: "No payments match", text: "Try a different search, method or date range." })
            : emptyState({
                iconName: "wallet",
                title: "No payments recorded yet",
                text: "When a customer pays, record it here or from the invoice. Partial payments are supported.",
                actions: html`<button type="button" class="btn btn-primary" data-action="record">${icon("plus")}Record payment</button>`,
              })
      );
    } catch (error) {
      if (error.name !== "AbortError") toastError(error);
    } finally {
      area.style.opacity = "1";
    }
  };

  $("#paySearch", root).addEventListener("input", debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }, 300));
  $("#payMethod", root).addEventListener("change", (e) => { state.method = e.target.value; state.page = 1; load(); });
  $("#payFrom", root).addEventListener("change", (e) => { state.from = e.target.value; state.page = 1; load(); });
  $("#payTo", root).addEventListener("change", (e) => { state.to = e.target.value; state.page = 1; load(); });
  $("#payVoided", root).addEventListener("change", (e) => { state.include_voided = e.target.checked; state.page = 1; load(); });
  on(root, "click", "[data-page]", (b) => { state.page = Number(b.dataset.page); load(); });
  on(root, "click", "[data-action]", async (el) => {
    try {
      if (el.dataset.action === "record") openPaymentDialog({ onSaved: load });
      else if (el.dataset.action === "receipt") await download(`/payments/${el.dataset.id}/receipt`, `${el.dataset.number}.pdf`);
      else if (el.dataset.action === "void") {
        openModal({
          title: `Void payment of ${money(el.dataset.amount, el.dataset.currency)}?`,
          description: "It stays in the history marked as voided, and the invoice balance goes back up.",
          body: html`<div class="field"><label for="voidReason">Reason</label><input class="input" id="voidReason" name="reason" maxlength="300" required placeholder="e.g. Entered twice"></div>`,
          footer: html`<button type="button" class="btn btn-secondary" data-close>Keep payment</button><button type="submit" class="btn btn-danger">Void payment</button>`,
          onSubmit: async (form) => {
            await api(`/payments/${el.dataset.id}/void`, { method: "POST", body: { reason: form.reason.value } });
            toast("Payment voided.");
            window.dispatchEvent(new CustomEvent("invoice-studio:changed"));
            load();
          },
        });
      }
    } catch (error) {
      toastError(error);
    }
  });
  await load();
}
