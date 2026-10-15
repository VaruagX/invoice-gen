import { html, mount, $, debounce, formValues } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { openModal, toast, showFieldErrors, clearFieldErrors } from "../lib/ui.js";
import { money, date } from "../lib/format.js";
import { store } from "../lib/store.js";

const core = window.InvoiceCore;

function methodOptions(selected = "upi") {
  return core.PAYMENT_METHODS.map(
    (method) => html`<option value="${method.value}" ${method.value === selected ? "selected" : ""}>${method.label}</option>`
  );
}

/**
 * Record a payment. Pass `invoice` (with id, invoice_number, balance_due,
 * currency) or omit it to choose from open invoices. `markPaid` records the
 * full balance via the mark-paid endpoint.
 */
export function openPaymentDialog({ invoice = null, markPaid = false, onSaved } = {}) {
  let selected = invoice;

  const invoicePicker = html`<div class="field" id="invoicePickerField">
    <label for="paymentInvoiceSearch">Invoice</label>
    <input class="input" id="paymentInvoiceSearch" type="search" placeholder="Search by invoice number or customer" autocomplete="off">
    <select class="select" id="paymentInvoice" name="invoice_id" data-field="invoice_id" size="5" aria-label="Open invoices"></select>
    <span class="hint">Only issued invoices with a balance due are listed.</span>
  </div>`;

  const { dialog, form } = openModal({
    title: markPaid ? "Mark invoice as paid" : "Record payment",
    description: markPaid
      ? "This records a payment for the full balance due. The invoice is marked paid once the balance reaches zero."
      : "Record money you've received. This updates the invoice balance; it doesn't collect the payment.",
    body: html`<div class="stack-sm">
      ${selected ? "" : invoicePicker}
      <div id="paymentInvoiceSummary"></div>
      <div class="form-grid">
        <div class="field">
          <label for="paymentAmount">Amount received</label>
          <div class="input-group">
            <span class="input-prefix">${selected?.currency || "INR"}</span>
            <input class="input num" id="paymentAmount" name="amount" inputmode="decimal" autocomplete="off" ${markPaid ? "readonly" : ""} required>
          </div>
        </div>
        <div class="field">
          <label for="paymentDate">Payment date</label>
          <input class="input" id="paymentDate" name="payment_date" type="date" max="${store.today}" value="${store.today}" required>
        </div>
        <div class="field">
          <label for="paymentMethod">Method</label>
          <select class="select" id="paymentMethod" name="method">${methodOptions()}</select>
        </div>
        <div class="field">
          <label for="paymentReference">Reference <span class="optional">(optional)</span></label>
          <input class="input" id="paymentReference" name="reference" maxlength="100" placeholder="UTR, cheque no., transaction ID">
        </div>
        <div class="field span-2">
          <label for="paymentNotes">Notes <span class="optional">(optional)</span></label>
          <textarea class="textarea" id="paymentNotes" name="notes" maxlength="500" rows="2"></textarea>
        </div>
      </div>
      <p class="hint muted small" id="paymentRemaining" aria-live="polite"></p>
    </div>`,
    footer: html`<button type="button" class="btn btn-secondary" data-close>Cancel</button>
      <button type="submit" class="btn btn-primary" data-busy-label="Saving">${markPaid ? "Mark as paid" : "Record payment"}</button>`,
    onSubmit: async (formEl) => {
      clearFieldErrors(formEl);
      if (!selected) {
        showFieldErrors(formEl, [{ field: "invoice_id", message: "Choose the invoice this payment is for." }]);
        return false;
      }
      const values = formValues(formEl);
      const body = {
        amount: values.amount,
        payment_date: values.payment_date,
        method: values.method,
        reference: values.reference,
        notes: values.notes,
      };
      const result = await api(`/invoices/${selected.id}/${markPaid ? "mark-paid" : "payments"}`, { method: "POST", body });
      toast(
        result.invoice.status === "paid"
          ? `${selected.invoice_number} is now fully paid.`
          : `Payment recorded. ${money(result.invoice.balance_due, result.invoice.currency)} still due.`,
        { title: "Payment saved" }
      );
      window.dispatchEvent(new CustomEvent("invoice-studio:changed"));
      onSaved?.(result);
      return true;
    },
  });

  const amountInput = $("#paymentAmount", dialog);
  const summary = $("#paymentInvoiceSummary", dialog);
  const remaining = $("#paymentRemaining", dialog);

  const updateRemaining = () => {
    if (!selected) return;
    const balance = core.toUnits(selected.balance_due);
    let paying = 0;
    try {
      paying = core.parseMoney(amountInput.value || "0");
    } catch (error) {
      remaining.textContent = "";
      return;
    }
    const left = balance - paying;
    remaining.textContent =
      left < 0
        ? `That's ${core.formatMoney(-left, selected.currency)} more than the balance due.`
        : left === 0
          ? "This payment settles the invoice in full."
          : `${core.formatMoney(left, selected.currency)} will remain due after this payment.`;
  };

  const select = (inv) => {
    selected = inv;
    mount(
      summary,
      html`<div class="callout callout-info">
        <div><strong>${inv.invoice_number}</strong>${inv.customer_name ? ` · ${inv.customer_name}` : ""}<br>
        Balance due <strong>${money(inv.balance_due, inv.currency)}</strong>${inv.due_date ? ` · due ${date(inv.due_date)}` : ""}</div>
      </div>`
    );
    amountInput.value = core.unitsToString(core.toUnits(inv.balance_due));
    form.querySelector(".input-prefix").textContent = inv.currency || "INR";
    updateRemaining();
  };

  amountInput.addEventListener("input", updateRemaining);
  if (selected) select(selected);
  else {
    const search = $("#paymentInvoiceSearch", dialog);
    const list = $("#paymentInvoice", dialog);
    let options = [];
    const load = debounce(async () => {
      options = await api("/payments/open-invoices", { query: { search: search.value.trim() } });
      mount(
        list,
        options.length
          ? options.map(
              (inv) => html`<option value="${inv.id}">${inv.invoice_number} · ${inv.customer_name || "No customer"} · ${money(inv.balance_due, inv.currency)} due</option>`
            )
          : html`<option disabled>No open invoices found</option>`
      );
    }, 200);
    search.addEventListener("input", load);
    list.addEventListener("change", () => {
      const inv = options.find((option) => option.id === list.value);
      if (inv) select(inv);
    });
    load();
    search.focus();
  }
  if (selected && !markPaid) amountInput.select();
}
