import { html, mount, $, $$, on, debounce } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { store, getSettings } from "../lib/store.js";
import { navigate, setGuard, clearGuard } from "../lib/router.js";
import { statusPill, emptyState, toast, toastError, showFieldErrors, clearFieldErrors, withBusy } from "../lib/ui.js";
import { money, moneyUnits } from "../lib/format.js";
import { renderInvoiceDocument, fromDraft } from "../components/invoice-document.js";
import { openCustomerDialog, stateOptions } from "../components/customer-dialog.js";

const core = window.InvoiceCore;
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD"];
const TERMS = [
  { days: 0, label: "Due on receipt" },
  { days: 7, label: "Net 7" },
  { days: 15, label: "Net 15" },
  { days: 30, label: "Net 30" },
  { days: 45, label: "Net 45" },
  { days: 60, label: "Net 60" },
];

function treatmentOptions(selected, gstRegistered) {
  const options = [];
  if (gstRegistered || ["auto", "cgst_sgst", "igst"].includes(selected)) {
    options.push(
      ["auto", "GST – decide from place of supply"],
      ["cgst_sgst", "GST – CGST + SGST (intra-state)"],
      ["igst", "GST – IGST (inter-state / export)"]
    );
  }
  options.push(["none", gstRegistered ? "No GST on this invoice" : "No tax"], ["simple", "Other tax (single rate)"]);
  return options.map(([value, label]) => html`<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`);
}

function itemRow(item = {}, defaults = {}) {
  const qty = item.quantity ?? "1";
  const taxRate = item.tax_rate ?? defaults.tax_rate ?? "0";
  return html`<div class="line-item">
    <div class="li-head">
      <span class="li-num" aria-hidden="true"></span>
      <div class="li-desc" data-error-host>
        <input class="input" name="description" value="${item.description || ""}" maxlength="500" placeholder="Item or service description" aria-label="Description" autocomplete="off">
      </div>
      <div class="li-amount" data-line-amount aria-label="Line amount">—</div>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="remove-line" aria-label="Remove line" title="Remove line">${icon("trash", "icon-sm")}</button>
    </div>
    <div class="li-fields">
      <label class="li-field" data-error-host><span>Qty</span><input class="input num" name="quantity" value="${qty}" inputmode="decimal" autocomplete="off"></label>
      <label class="li-field" data-error-host><span>Unit</span><input class="input" name="unit" value="${item.unit || ""}" maxlength="20" placeholder="pcs, hrs" autocomplete="off"></label>
      <label class="li-field" data-error-host><span>Rate</span><input class="input num" name="unit_price" value="${item.unit_price ?? ""}" inputmode="decimal" placeholder="0.00" autocomplete="off"></label>
      <div class="li-field" data-error-host><span>Discount</span>
        <div class="input-group">
          <input class="input num" name="discount_value" value="${item.discount_value && Number(item.discount_value) ? item.discount_value : ""}" inputmode="decimal" placeholder="0" aria-label="Line discount" autocomplete="off">
          <select class="select" name="discount_type" aria-label="Discount type">
            <option value="percent" ${item.discount_type !== "amount" ? "selected" : ""}>%</option>
            <option value="amount" ${item.discount_type === "amount" ? "selected" : ""}>Amt</option>
          </select>
        </div>
      </div>
      <label class="li-field col-tax" data-error-host><span>Tax %</span><input class="input num" name="tax_rate" value="${taxRate}" inputmode="decimal" list="gstRates" autocomplete="off"></label>
      <label class="li-field" data-error-host><span>HSN/SAC</span><input class="input" name="hsn_sac" value="${item.hsn_sac || ""}" maxlength="8" inputmode="numeric" placeholder="Optional" autocomplete="off"></label>
    </div>
  </div>`;
}

export async function render({ root, params, query, setTitle, isCurrent }) {
  const editing = Boolean(params.id);
  const [settings, customers, invoice] = await Promise.all([
    getSettings(),
    api("/customers/options"),
    editing ? api(`/invoices/${params.id}`) : Promise.resolve(null),
  ]);
  if (!isCurrent()) return;

  if (invoice && invoice.status === "cancelled") {
    setTitle(`Edit ${invoice.invoice_number}`);
    mount(
      root,
      html`<div class="card">${emptyState({
        iconName: "ban",
        title: "This invoice is cancelled",
        text: "Restore it from the invoice page before making changes.",
        actions: html`<a class="btn btn-primary" href="#/invoices/${invoice.id}">Open invoice</a>`,
      })}</div>`
    );
    return;
  }

  setTitle(editing ? `Edit ${invoice.invoice_number}` : "New invoice");
  const gstRegistered = Boolean(settings.gst_registered);
  const defaultRate = gstRegistered ? core.unitsToPlain(core.toUnits(settings.default_tax_rate)) : "0";
  const defaults = { tax_rate: defaultRate };
  const today = store.today;
  const presetCustomer = !editing && query.customer ? customers.find((c) => c.id === query.customer) : null;
  const initialCustomer = editing ? invoice.customer_id : presetCustomer?.id || "";
  const initialCustomerRecord = customers.find((c) => c.id === initialCustomer);

  const form0 = editing
    ? {
        customer_id: invoice.customer_id || "",
        issue_date: invoice.issue_date,
        due_date: invoice.due_date || "",
        currency: invoice.currency,
        gst_treatment: invoice.gst_treatment,
        place_of_supply: invoice.place_of_supply,
        reverse_charge: invoice.reverse_charge,
        round_off: invoice.round_off_enabled,
        discount_type: invoice.discount_type,
        discount_value: core.toUnits(invoice.discount_value) ? invoice.discount_value : "",
        notes: invoice.notes,
        terms: invoice.terms,
        payment_instructions: invoice.payment_instructions,
        items: invoice.items.map((item) => ({
          description: item.description,
          hsn_sac: item.hsn_sac,
          unit: item.unit,
          quantity: core.unitsToPlain(core.toUnits(item.quantity, core.QTY_SCALE), core.QTY_SCALE),
          unit_price: item.unit_price,
          discount_type: item.discount_type,
          discount_value: core.toUnits(item.discount_value) ? core.unitsToPlain(core.toUnits(item.discount_value)) : "",
          tax_rate: core.unitsToPlain(core.toUnits(item.tax_rate)),
        })),
      }
    : {
        customer_id: initialCustomer,
        issue_date: today,
        due_date: core.addDays(today, settings.default_payment_terms ?? 15),
        currency: settings.currency || "INR",
        gst_treatment: gstRegistered ? "auto" : "none",
        place_of_supply: initialCustomerRecord?.state_code || settings.state_code || "",
        reverse_charge: false,
        round_off: Boolean(settings.round_off),
        discount_type: "percent",
        discount_value: "",
        notes: settings.default_notes || "",
        terms: settings.terms || "",
        payment_instructions: settings.default_payment_instructions || "",
        items: [{}],
      };
  const termDays = form0.due_date ? core.daysBetween(form0.issue_date, form0.due_date) : 0;
  const nextNumber = editing ? null : (await api("/invoices/next-number", { query: { issue_date: today } })).invoice_number;
  if (!isCurrent()) return;

  mount(
    root,
    html`<div class="page-header">
      <div>
        <a class="back-link" href="${editing ? `#/invoices/${invoice.id}` : "#/invoices"}">${icon("chevronLeft", "icon-sm")}${editing ? invoice.invoice_number : "Invoices"}</a>
        <div class="page-title-row"><h1>${editing ? `Edit ${invoice.invoice_number}` : "New invoice"}</h1>${editing ? statusPill(invoice.display_status) : ""}</div>
        <p>Totals and tax update as you type. The server recalculates everything when you save.</p>
      </div>
    </div>
    <datalist id="gstRates">${core.COMMON_GST_RATES.map((rate) => html`<option value="${rate}"></option>`)}</datalist>
    <form id="invoiceForm" novalidate autocomplete="off">
      <div class="editor">
        <div class="stack">
          <section class="card">
            <div class="card-header"><div><h2>Customer & dates</h2></div></div>
            <div class="card-body form-grid">
              <div class="field span-2">
                <label for="customerSelect">Customer</label>
                <div style="display:flex;gap:8px">
                  <select class="select" id="customerSelect" name="customer_id" data-field="customer_id">
                    <option value="">No customer (walk-in)</option>
                    ${customers.map((c) => html`<option value="${c.id}" ${c.id === form0.customer_id ? "selected" : ""}>${c.name}${c.company_name ? ` — ${c.company_name}` : ""}</option>`)}
                    ${editing && invoice.customer_id && !customers.some((c) => c.id === invoice.customer_id)
                      ? html`<option value="${invoice.customer_id}" selected>${invoice.customer?.name || "Archived customer"} (archived)</option>`
                      : ""}
                  </select>
                  <button type="button" class="btn btn-secondary" data-action="new-customer">${icon("plus")}<span class="hide-sm">New</span></button>
                </div>
                <div id="customerSummary"></div>
              </div>
              <div class="field">
                <label for="invoiceNumber">Invoice number</label>
                ${editing
                  ? html`<input class="input" id="invoiceNumber" value="${invoice.invoice_number}" readonly aria-describedby="numberHint"><span class="hint" id="numberHint">Invoice numbers don't change after creation.</span>`
                  : html`<input class="input" id="invoiceNumber" name="invoice_number" data-field="invoice_number" maxlength="40" placeholder="${nextNumber}" aria-describedby="numberHint"><span class="hint" id="numberHint">Leave blank to use the next number automatically.</span>`}
              </div>
              <div class="field">
                <label for="currency">Currency</label>
                <select class="select" id="currency" name="currency" data-field="currency">${CURRENCIES.map((c) => html`<option ${c === form0.currency ? "selected" : ""}>${c}</option>`)}</select>
              </div>
              <div class="field">
                <label for="issueDate">Invoice date</label>
                <input class="input" type="date" id="issueDate" name="issue_date" data-field="issue_date" value="${form0.issue_date}" required>
              </div>
              <div class="field">
                <label for="terms">Payment terms</label>
                <select class="select" id="termsSelect">
                  ${TERMS.map((t) => html`<option value="${t.days}" ${t.days === termDays ? "selected" : ""}>${t.label}</option>`)}
                  <option value="custom" ${TERMS.some((t) => t.days === termDays) ? "" : "selected"}>Custom date</option>
                </select>
              </div>
              <div class="field">
                <label for="dueDate">Due date</label>
                <input class="input" type="date" id="dueDate" name="due_date" data-field="due_date" value="${form0.due_date}">
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-header"><div><h2>Line items</h2><p>Press Enter in the last field to add a line, or Ctrl/⌘ + Enter anywhere.</p></div></div>
            <div class="card-body" data-error-host>
              <div class="line-items" id="itemsBody">${form0.items.map((item) => itemRow(item, defaults))}</div>
              <input type="hidden" data-field="items">
              <button type="button" class="btn btn-secondary btn-sm" data-action="add-line" style="margin-top:8px">${icon("plus", "icon-sm")}Add line</button>
            </div>
          </section>

          <section class="card">
            <div class="card-header"><div><h2>Tax & discount</h2></div></div>
            <div class="card-body form-grid">
              <div class="field span-2">
                <label for="gstTreatment">Tax treatment</label>
                <select class="select" id="gstTreatment" name="gst_treatment" data-field="gst_treatment">${treatmentOptions(form0.gst_treatment, gstRegistered)}</select>
              </div>
              <div class="field">
                <label for="placeOfSupply">Place of supply</label>
                <select class="select" id="placeOfSupply" name="place_of_supply" data-field="place_of_supply">${stateOptions(form0.place_of_supply, { placeholder: "Select state" })}</select>
              </div>
              <div class="field" style="align-content:end">
                <label class="check"><input type="checkbox" name="reverse_charge" id="reverseCharge" ${form0.reverse_charge ? "checked" : ""}>
                  <span class="check-text"><span>Reverse charge applies</span><small>Recipient pays the GST to the government</small></span></label>
              </div>
              <div class="span-2 tax-hint" id="taxHint" aria-live="polite"></div>
              <div class="field">
                <label for="discountValue">Invoice discount <span class="optional">(before tax)</span></label>
                <div class="input-group">
                  <input class="input num" id="discountValue" name="discount_value" data-field="discount_value" value="${form0.discount_value}" inputmode="decimal" placeholder="0">
                  <select class="select" id="discountType" name="invoice_discount_type" aria-label="Invoice discount type" style="min-width:110px">
                    <option value="percent" ${form0.discount_type !== "amount" ? "selected" : ""}>%</option>
                    <option value="amount" ${form0.discount_type === "amount" ? "selected" : ""}>Amount</option>
                  </select>
                </div>
              </div>
              <div class="field" style="align-content:end">
                <label class="check"><input type="checkbox" name="round_off" ${form0.round_off ? "checked" : ""}>
                  <span class="check-text"><span>Round total to nearest rupee</span><small>Adds a round-off line</small></span></label>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-header"><div><h2>Notes & terms</h2><p>Printed on the invoice.</p></div></div>
            <div class="card-body form-grid">
              <div class="field span-2"><label for="notes">Customer notes</label><textarea class="textarea" id="notes" name="notes" data-field="notes" maxlength="2000" rows="2">${form0.notes}</textarea></div>
              <div class="field span-2"><label for="payInstr">Payment instructions</label><textarea class="textarea" id="payInstr" name="payment_instructions" data-field="payment_instructions" maxlength="2000" rows="2">${form0.payment_instructions}</textarea></div>
              <div class="field span-2"><label for="termsText">Terms and conditions</label><textarea class="textarea" id="termsText" name="terms" data-field="terms" maxlength="4000" rows="3">${form0.terms}</textarea></div>
            </div>
          </section>
        </div>

        <aside class="editor-preview" aria-label="Invoice preview">
          <section class="card">
            <div class="card-header"><h2>Summary</h2><span class="muted small" id="taxTypeLabel"></span></div>
            <div class="card-body"><div class="totals" id="totalsPanel"></div></div>
          </section>
          <div id="docPreview"></div>
        </aside>
      </div>

      <div class="sticky-actions">
        <span class="status-text" id="saveStatus">No changes yet</span>
        <a class="btn btn-ghost" href="${editing ? `#/invoices/${invoice.id}` : "#/invoices"}">Cancel</a>
        ${!editing || invoice.status === "draft"
          ? html`<button type="submit" class="btn btn-secondary" data-submit="${editing ? "save" : "draft"}" data-busy-label="Saving">Save draft</button>
              <button type="submit" class="btn btn-primary" data-submit="issue" data-busy-label="Saving">${icon("send", "icon-sm")}Save & issue</button>`
          : html`<button type="submit" class="btn btn-primary" data-submit="save" data-busy-label="Saving">Save changes</button>`}
      </div>
    </form>`
  );

  const form = $("#invoiceForm", root);
  const itemsBody = $("#itemsBody", form);
  const customerSelect = $("#customerSelect", form);
  let posTouched = editing;
  let attempted = false;
  const touched = new Set();
  const paidUnits = editing ? core.toUnits(invoice.paid_total) : 0;

  const collect = () => {
    const rows = $$(".line-item", itemsBody).map((row) => ({
      row,
      item: Object.fromEntries(
        ["description", "hsn_sac", "unit", "quantity", "unit_price", "discount_value", "discount_type", "tax_rate"].map((name) => [
          name,
          row.querySelector(`[name="${name}"]`).value.trim(),
        ])
      ),
    }));
    const sent = rows.filter(({ item }) => !core.isBlankItem(item));
    // Align field names with the payload so server errors land on the right inputs.
    rows.forEach(({ row }) => row.querySelectorAll("[name]").forEach((input) => input.removeAttribute("data-field")));
    sent.forEach(({ row }, index) => {
      row.querySelectorAll("[name]").forEach((input) => input.setAttribute("data-field", `items.${index}.${input.name}`));
    });
    return {
      rows,
      sent,
      body: {
        customer_id: customerSelect.value,
        invoice_number: editing ? undefined : $("#invoiceNumber", form).value.trim(),
        issue_date: $("#issueDate", form).value,
        due_date: $("#dueDate", form).value,
        currency: $("#currency", form).value,
        gst_treatment: $("#gstTreatment", form).value,
        place_of_supply: $("#placeOfSupply", form).value,
        reverse_charge: $("#reverseCharge", form).checked,
        round_off: form.querySelector('[name="round_off"]').checked,
        discount_type: $("#discountType", form).value,
        discount_value: $("#discountValue", form).value.trim(),
        items: sent.map(({ item }) => item),
        notes: $("#notes", form).value,
        terms: $("#termsText", form).value,
        payment_instructions: $("#payInstr", form).value,
      },
    };
  };

  const snapshot = () => JSON.stringify(collect().body);
  let baseline = snapshot();
  let dirty = false;
  setGuard(() => !dirty);

  const currentCustomer = () => {
    const id = customerSelect.value;
    if (!id) return null;
    const record = customers.find((c) => c.id === id);
    if (editing && id === invoice.customer_id && invoice.customer) return Object.assign({}, invoice.customer, record ? { state_code: record.state_code } : {});
    return record ? Object.assign({ address: "", city: "", state: core.stateByCode(record.state_code)?.name || "" }, record) : null;
  };

  const validate = (body, calc, normalized) => {
    const errors = [...normalized.errors, ...calc.errors];
    if (!body.issue_date) errors.push({ field: "issue_date", message: "Invoice date is required." });
    if (body.due_date && body.issue_date && body.due_date < body.issue_date) errors.push({ field: "due_date", message: "Due date cannot be before the invoice date." });
    if (["auto", "cgst_sgst", "igst"].includes(body.gst_treatment) && !gstRegistered) {
      errors.push({ field: "gst_treatment", message: "Add your GSTIN in Business Settings to charge GST, or choose a non-GST option." });
    }
    if (body.gst_treatment === "auto" && (!settings.state_code || !body.place_of_supply)) {
      errors.push({ field: "place_of_supply", message: settings.state_code ? "Choose the place of supply." : "Set your business state in Business Settings to apply GST automatically." });
    }
    if (paidUnits > calc.totals.total) {
      errors.push({ field: "items", message: `Total can't be less than the ${moneyUnits(paidUnits, body.currency)} already received.` });
    }
    return errors;
  };

  const renderPreview = debounce((calc, body) => {
    const customer = currentCustomer();
    mount(
      $("#docPreview", root),
      renderInvoiceDocument(
        fromDraft({
          calc,
          form: body,
          settings,
          customer,
          invoiceNumber: editing ? invoice.invoice_number : body.invoice_number || nextNumber,
          paidUnits,
          status: editing ? invoice.status : "draft",
        }),
        { compact: true }
      )
    );
  }, 120);

  const recalc = () => {
    const { body, rows, sent } = collect();
    const normalized = core.normalizeInvoiceInput(body);
    const taxType = core.resolveTaxType(body.gst_treatment, settings.state_code, body.place_of_supply) || "none";
    const calc = core.calculateInvoice(normalized.value, taxType);
    const currency = body.currency;

    rows.forEach(({ row }) => {
      row.querySelector("[data-line-amount]").textContent = "—";
    });
    sent.forEach(({ row }, index) => {
      const item = calc.items[index];
      if (item) row.querySelector("[data-line-amount]").textContent = moneyUnits(item.line_total, currency);
    });

    $$(".col-tax", form).forEach((cell) => {
      cell.hidden = taxType === "none";
    });

    // Tax explanation.
    const from = core.stateByCode(settings.state_code);
    const to = core.stateByCode(body.place_of_supply);
    let hint;
    if (body.gst_treatment === "auto") {
      hint = !from
        ? "Set your business state in Business Settings so GST can be worked out automatically."
        : !to
          ? "Choose the place of supply to work out GST."
          : taxType === "cgst_sgst"
            ? `Intra-state supply (${from.name} → ${to.name}): CGST + SGST, each at half the GST rate.`
            : `Inter-state supply (${from.name} → ${to.name}): IGST at the full GST rate.`;
    } else if (taxType === "cgst_sgst") hint = "CGST + SGST will be charged, each at half the line's GST rate.";
    else if (taxType === "igst") hint = "IGST will be charged at the full GST rate (inter-state supplies and exports).";
    else if (taxType === "simple") hint = "A single tax is charged at each line's rate and shown as “Tax”.";
    else hint = gstRegistered ? "No GST will be charged on this invoice." : "This invoice has no tax. Add a GSTIN in Business Settings if you are GST registered.";
    mount($("#taxHint", form), html`${icon("info", "icon-sm")}<span>${hint} Please confirm the correct treatment for your transaction.</span>`);
    $("#reverseCharge", form).disabled = !(taxType === "cgst_sgst" || taxType === "igst");
    $("#taxTypeLabel", root).textContent = core.taxTypeLabel(taxType);

    // Customer summary.
    const customer = currentCustomer();
    mount(
      $("#customerSummary", form),
      customer
        ? html`<div class="customer-summary" style="margin-top:8px">
            <strong>${customer.name}</strong>
            <span class="muted">${[customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact details"}</span>
            <span class="muted">${customer.gst_number ? `GSTIN ${customer.gst_number}` : "No GSTIN"} · ${core.stateByCode(customer.state_code)?.name || "State not set"}</span>
          </div>`
        : ""
    );

    // Totals.
    const t = calc.totals;
    const isGst = taxType === "cgst_sgst" || taxType === "igst";
    mount(
      $("#totalsPanel", root),
      html`<div class="totals-row"><span>Subtotal</span><span>${moneyUnits(t.subtotal, currency)}</span></div>
        ${t.discount_total ? html`<div class="totals-row"><span>Discount</span><span>− ${moneyUnits(t.discount_total, currency)}</span></div>` : ""}
        ${taxType !== "none" ? html`<div class="totals-row"><span>${isGst ? "Taxable amount" : "Net amount"}</span><span>${moneyUnits(t.taxable_total, currency)}</span></div>` : ""}
        ${taxType === "cgst_sgst" ? html`<div class="totals-row"><span>CGST</span><span>${moneyUnits(t.cgst_total, currency)}</span></div><div class="totals-row"><span>SGST</span><span>${moneyUnits(t.sgst_total, currency)}</span></div>` : ""}
        ${taxType === "igst" ? html`<div class="totals-row"><span>IGST</span><span>${moneyUnits(t.igst_total, currency)}</span></div>` : ""}
        ${taxType === "simple" ? html`<div class="totals-row"><span>Tax</span><span>${moneyUnits(t.tax_total, currency)}</span></div>` : ""}
        ${calc.reverse_charge ? html`<div class="totals-row"><span>GST payable by recipient</span><span>− ${moneyUnits(t.tax_total, currency)}</span></div>` : ""}
        ${t.round_off ? html`<div class="totals-row"><span>Round off</span><span>${moneyUnits(t.round_off, currency)}</span></div>` : ""}
        <div class="totals-row total"><span>Total</span><span>${moneyUnits(t.total, currency)}</span></div>
        ${paidUnits ? html`<div class="totals-row"><span>Amount paid</span><span>${moneyUnits(paidUnits, currency)}</span></div>
          <div class="totals-row balance"><span>Balance due</span><span>${moneyUnits(Math.max(t.total - paidUnits, 0), currency)}</span></div>` : ""}`
    );

    const errors = validate(body, calc, normalized);
    if (attempted) showFieldErrors(form, errors, { focus: false });
    else showFieldErrors(form, errors.filter((e) => touched.has(e.field)), { focus: false });
    renderPreview(calc, body);

    dirty = snapshot() !== baseline;
    $("#saveStatus", form).textContent = dirty ? "Unsaved changes" : editing ? "No unsaved changes" : "Not saved yet";
    return { body, calc, errors };
  };

  const addLine = (focus = true) => {
    itemsBody.insertAdjacentHTML("beforeend", String(itemRow({}, defaults)));
    recalc();
    if (focus) $$(".line-item", itemsBody).at(-1).querySelector('[name="description"]').focus();
  };

  const syncDue = () => {
    const terms = $("#termsSelect", form).value;
    const issue = $("#issueDate", form).value;
    if (terms !== "custom" && core.isIsoDate(issue)) $("#dueDate", form).value = core.addDays(issue, Number(terms));
  };

  form.addEventListener("input", recalc);
  form.addEventListener("change", (event) => {
    if (event.target.id === "termsSelect" || event.target.id === "issueDate") syncDue();
    if (event.target.id === "dueDate") {
      const days = core.daysBetween($("#issueDate", form).value, event.target.value);
      $("#termsSelect", form).value = TERMS.some((t) => t.days === days) ? String(days) : "custom";
    }
    if (event.target.id === "placeOfSupply") posTouched = true;
    if (event.target === customerSelect && !posTouched) {
      const customer = customers.find((c) => c.id === customerSelect.value);
      $("#placeOfSupply", form).value = customer?.state_code || settings.state_code || "";
    }
    recalc();
  });
  form.addEventListener("focusout", (event) => {
    const field = event.target.getAttribute?.("data-field");
    if (field && event.target.value !== "") {
      touched.add(field);
      recalc();
    }
  });

  on(form, "click", "[data-action]", (el) => {
    if (el.dataset.action === "add-line") addLine();
    if (el.dataset.action === "remove-line") {
      const rows = $$(".line-item", itemsBody);
      if (rows.length === 1) {
        rows[0].querySelectorAll("input").forEach((input) => {
          input.value = input.name === "quantity" ? "1" : input.name === "tax_rate" ? defaultRate : "";
        });
      } else el.closest(".line-item").remove();
      recalc();
    }
    if (el.dataset.action === "new-customer") {
      openCustomerDialog({
        onSaved: (customer) => {
          customers.push(customer);
          customerSelect.insertAdjacentHTML("beforeend", String(html`<option value="${customer.id}">${customer.name}${customer.company_name ? ` — ${customer.company_name}` : ""}</option>`));
          customerSelect.value = customer.id;
          if (!posTouched) $("#placeOfSupply", form).value = customer.state_code || settings.state_code || "";
          recalc();
        },
      });
    }
  });

  form.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      addLine();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      form.querySelector("[data-submit]")?.click();
      return;
    }
    if (event.key === "Enter" && event.target.matches("input:not([type=checkbox])")) {
      event.preventDefault();
      const row = event.target.closest(".line-item");
      if (row && event.target.name === "tax_rate" && row === $$(".line-item", itemsBody).at(-1)) {
        addLine();
        return;
      }
      const focusables = $$("input:not([type=hidden]):not([readonly]), select, textarea, button", form).filter((el) => !el.disabled && el.offsetParent);
      const next = focusables[focusables.indexOf(event.target) + 1];
      next?.focus();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter || form.querySelector("[data-submit]");
    const action = button?.dataset.submit || "save";
    attempted = true;
    const { body, errors } = recalc();
    if (errors.length) {
      showFieldErrors(form, errors);
      toast(`Please fix ${errors.length === 1 ? "the highlighted field" : `${errors.length} highlighted fields`} before saving.`, { type: "error" });
      return;
    }
    body.action = action;
    await withBusy(button, async () => {
      form.querySelectorAll("[data-submit]").forEach((b) => {
        b.disabled = true;
      });
      try {
        const saved = await api(editing ? `/invoices/${invoice.id}` : "/invoices", { method: editing ? "PUT" : "POST", body });
        dirty = false;
        baseline = snapshot();
        clearGuard();
        toast(
          action === "issue" ? `${saved.invoice_number} is ready to send.` : editing ? `${saved.invoice_number} saved.` : `Draft ${saved.invoice_number} saved.`,
          { title: action === "issue" ? "Invoice issued" : "Saved" }
        );
        window.dispatchEvent(new CustomEvent("invoice-studio:changed"));
        navigate(`/invoices/${saved.id}`);
      } catch (error) {
        if (error.errors?.length) {
          clearFieldErrors(form);
          showFieldErrors(form, error.errors);
          toast(error.message, { type: "error" });
        } else toastError(error);
      } finally {
        form.querySelectorAll("[data-submit]").forEach((b) => {
          b.disabled = false;
        });
      }
    });
  });

  recalc();
  baseline = snapshot();
  dirty = false;
  $("#saveStatus", form).textContent = editing ? "No unsaved changes" : "Not saved yet";
  if (!editing && !initialCustomer) customerSelect.focus();
}

export { money };
