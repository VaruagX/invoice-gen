import { html, raw, mount, $, $$, on, formValues, debounce } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { store, getSettings, invalidateSettings } from "../lib/store.js";
import { setGuard, clearGuard, replaceQuery } from "../lib/router.js";
import { toast, toastError, showFieldErrors, clearFieldErrors, withBusy, confirmDialog } from "../lib/ui.js";
import { stateOptions } from "../components/customer-dialog.js";
import { renderInvoiceDocument } from "../components/invoice-document.js";

const core = window.InvoiceCore;

const TABS = [
  { id: "profile", label: "Business profile", icon: "building", fields: ["name", "email", "phone", "website", "address", "city", "state_code", "postal_code", "country"] },
  { id: "tax", label: "GST & tax", icon: "percent", fields: ["gst_registered", "gst_number", "pan", "default_tax_rate"] },
  { id: "invoices", label: "Invoice defaults", icon: "invoice", fields: ["invoice_prefix", "invoice_padding", "invoice_reset", "next_invoice_number", "receipt_prefix", "currency", "default_payment_terms", "timezone", "round_off", "default_notes", "terms", "default_payment_instructions"] },
  { id: "payments", label: "Bank & UPI", icon: "bank", fields: ["bank_account_name", "bank_name", "bank_account_number", "bank_ifsc", "bank_branch", "bank_details", "upi_id", "show_upi_qr"] },
  { id: "branding", label: "Branding & signature", icon: "palette", fields: ["brand_color", "signatory_name", "signatory_title", "show_signature_block"] },
];

const ASSETS = [
  { kind: "logo", label: "Logo", hint: "Shown at the top of invoices and receipts. PNG or JPG, up to 2 MB." },
  { kind: "signature", label: "Signature", hint: "Placed above the authorised signatory line. A PNG with a transparent background looks best." },
  { kind: "stamp", label: "Business stamp", hint: "Optional company seal shown next to the signature." },
];

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD"];

// `attrs` is only ever a static string written in this file, never user data.
function field(label, name, value, { type = "text", hint, optional, attrs = "", span } = {}) {
  return html`<div class="field${span ? " span-2" : ""}">
    <label for="s_${name}">${label}${optional ? html` <span class="optional">(optional)</span>` : ""}</label>
    <input class="input" id="s_${name}" name="${name}" type="${type}" value="${value ?? ""}" ${raw(attrs)}>
    ${hint ? html`<span class="hint">${hint}</span>` : ""}
  </div>`;
}

function textarea(label, name, value, { hint, rows = 3 } = {}) {
  return html`<div class="field span-2"><label for="s_${name}">${label}</label>
    <textarea class="textarea" id="s_${name}" name="${name}" rows="${rows}">${value || ""}</textarea>
    ${hint ? html`<span class="hint">${hint}</span>` : ""}</div>`;
}

function check(label, name, checked, help) {
  return html`<div class="field span-2"><label class="check"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}>
    <span class="check-text"><span>${label}</span>${help ? html`<small>${help}</small>` : ""}</span></label></div>`;
}

function timezoneOptions(selected) {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["Asia/Kolkata", "UTC"];
  if (!zones.includes(selected)) zones.unshift(selected);
  return zones.map((zone) => html`<option ${zone === selected ? "selected" : ""}>${zone}</option>`);
}

function assetRows(assets) {
  return ASSETS.map(
    (a) => html`<div class="asset-row">
      <div class="asset-thumb">${assets[a.kind] ? html`<img src="${assets[a.kind].url}" alt="${a.label}">` : icon("image")}</div>
      <div class="asset-text"><strong>${a.label}</strong><div class="muted small">${a.hint}</div></div>
      <div class="actions">
        <label class="btn btn-secondary btn-sm" tabindex="0" role="button">
          ${icon("upload", "icon-sm")}${assets[a.kind] ? "Replace" : "Upload"}
          <input type="file" accept="image/png,image/jpeg" data-upload="${a.kind}" class="sr-only">
        </label>
        ${assets[a.kind] ? html`<button type="button" class="btn btn-danger-ghost btn-sm" data-remove="${a.kind}">Remove</button>` : ""}
      </div>
    </div>`
  );
}

export async function render({ root, query, setTitle, isCurrent }) {
  setTitle("Business settings");
  let s = await getSettings({ refresh: true });
  if (!isCurrent()) return;
  let tab = TABS.some((t) => t.id === query.tab) ? query.tab : "profile";

  mount(
    root,
    html`<div class="page-header">
      <div><h1>Business settings</h1><p>These details appear on your invoices, receipts and reminders.</p></div>
    </div>
    <div class="settings-layout">
      <nav class="settings-nav" role="tablist" aria-label="Settings sections">${TABS.map(
        (t) => html`<button type="button" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" data-tab="${t.id}" aria-selected="${String(t.id === tab)}">${icon(t.icon)}${t.label}</button>`
      )}</nav>
      <form id="settingsForm" novalidate>
        <section class="card" role="tabpanel" id="panel-profile" aria-labelledby="tab-profile" data-panel="profile">
          <div class="card-header"><div><h2>Business profile</h2><p>Your legal or trading name and address as they should appear on invoices.</p></div></div>
          <div class="card-body form-grid">
            ${field("Business or shop name", "name", s.name, { attrs: 'required maxlength="120"', span: true })}
            ${field("Email", "email", s.email, { type: "email", optional: true, attrs: 'maxlength="254"' })}
            ${field("Phone", "phone", s.phone, { type: "tel", optional: true, attrs: 'maxlength="20"' })}
            ${field("Website", "website", s.website, { optional: true, attrs: 'maxlength="200" placeholder="example.com"' })}
            <div class="field"><label for="s_state_code">State</label><select class="select" id="s_state_code" name="state_code">${stateOptions(s.state_code)}</select>
              <span class="hint">Decides CGST + SGST vs IGST on GST invoices.</span></div>
            ${textarea("Address", "address", s.address, { rows: 2 })}
            ${field("City", "city", s.city, { attrs: 'maxlength="80"' })}
            ${field("PIN code", "postal_code", s.postal_code, { attrs: 'maxlength="12" inputmode="numeric"' })}
            ${field("Country", "country", s.country || "India", { attrs: 'maxlength="80"' })}
          </div>
        </section>

        <section class="card" role="tabpanel" id="panel-tax" aria-labelledby="tab-tax" data-panel="tax">
          <div class="card-header"><div><h2>GST & tax</h2><p>Invoice Studio calculates GST from your settings; please confirm the treatment that applies to your business.</p></div></div>
          <div class="card-body form-grid">
            ${check("This business is registered under GST", "gst_registered", s.gst_registered, "Enables tax invoices with CGST/SGST or IGST. Unregistered businesses issue invoices without GST.")}
            ${field("GSTIN", "gst_number", s.gst_number, { attrs: 'maxlength="15" style="text-transform:uppercase" placeholder="27ABCDE1234F1Z5"', hint: "The first two digits must match your state." })}
            ${field("PAN", "pan", s.pan, { optional: true, attrs: 'maxlength="10" style="text-transform:uppercase"' })}
            <div class="field"><label for="s_default_tax_rate">Default GST rate for new lines (%)</label>
              <input class="input" id="s_default_tax_rate" name="default_tax_rate" value="${core.unitsToPlain(core.toUnits(s.default_tax_rate))}" inputmode="decimal" list="settingsRates">
              <datalist id="settingsRates">${core.COMMON_GST_RATES.map((r) => html`<option value="${r}"></option>`)}</datalist>
              <span class="hint">You can change the rate on each line.</span></div>
            <div class="span-2 callout">${icon("info", "icon-sm")}<span>Generated invoices follow the details you enter. Invoice Studio does not verify GSTINs with the GST portal or guarantee legal compliance for every transaction.</span></div>
          </div>
        </section>

        <section class="card" role="tabpanel" id="panel-invoices" aria-labelledby="tab-invoices" data-panel="invoices">
          <div class="card-header"><div><h2>Invoice defaults</h2><p>Numbering and the text pre-filled on new invoices.</p></div></div>
          <div class="card-body">
            <div class="form-section">
              <div class="form-section-title"><h3>Invoice numbering</h3><p>Numbers are assigned by the server when an invoice is saved, so two invoices can never share a number.</p></div>
              <div class="form-grid">
                ${field("Prefix", "invoice_prefix", s.invoice_prefix, { attrs: 'maxlength="24"', hint: "Tokens: {YYYY} year, {YY} short year, {MM} month, {FY} financial year (2026-27)." })}
                <div class="field"><label for="s_invoice_padding">Number length</label>
                  <select class="select" id="s_invoice_padding" name="invoice_padding">${[3, 4, 5, 6].map((n) => html`<option value="${n}" ${Number(s.invoice_padding) === n ? "selected" : ""}>${n} digits</option>`)}</select></div>
                <div class="field"><label for="s_invoice_reset">Restart numbering</label>
                  <select class="select" id="s_invoice_reset" name="invoice_reset">
                    <option value="never" ${s.invoice_reset === "never" ? "selected" : ""}>Never (continuous)</option>
                    <option value="financial_year" ${s.invoice_reset === "financial_year" ? "selected" : ""}>Every financial year (1 April)</option>
                    <option value="yearly" ${s.invoice_reset === "yearly" ? "selected" : ""}>Every calendar year</option>
                  </select></div>
                ${field("Next number", "next_invoice_number", "", { type: "number", optional: true, attrs: 'min="1" step="1" placeholder="Keep current"', hint: "Only change this when moving from another system." })}
                <div class="field span-2"><span class="label">Next invoice will be</span><div class="customer-summary"><strong id="numberExample">${s.next_invoice_number}</strong></div></div>
                ${field("Receipt prefix", "receipt_prefix", s.receipt_prefix, { attrs: 'maxlength="16"' })}
              </div>
            </div>
            <div class="form-section">
              <div class="form-section-title"><h3>Defaults</h3></div>
              <div class="form-grid">
                <div class="field"><label for="s_currency">Default currency</label><select class="select" id="s_currency" name="currency">${CURRENCIES.map((c) => html`<option ${c === s.currency ? "selected" : ""}>${c}</option>`)}</select></div>
                ${field("Default payment terms (days)", "default_payment_terms", s.default_payment_terms, { type: "number", attrs: 'min="0" max="365"' })}
                <div class="field"><label for="s_timezone">Business time zone</label><select class="select" id="s_timezone" name="timezone">${timezoneOptions(s.timezone)}</select>
                  <span class="hint">Used to decide "today" for due dates and overdue invoices.</span></div>
                ${check("Round invoice totals to the nearest rupee by default", "round_off", s.round_off)}
                ${textarea("Default customer notes", "default_notes", s.default_notes, { rows: 2 })}
                ${textarea("Default payment instructions", "default_payment_instructions", s.default_payment_instructions, { rows: 2 })}
                ${textarea("Default terms and conditions", "terms", s.terms, { rows: 3 })}
              </div>
            </div>
          </div>
        </section>

        <section class="card" role="tabpanel" id="panel-payments" aria-labelledby="tab-payments" data-panel="payments">
          <div class="card-header"><div><h2>Bank & UPI</h2><p>Printed on invoices so customers know how to pay you.</p></div></div>
          <div class="card-body form-grid">
            ${field("Account holder name", "bank_account_name", s.bank_account_name, { optional: true })}
            ${field("Bank name", "bank_name", s.bank_name, { optional: true })}
            ${field("Account number", "bank_account_number", s.bank_account_number, { optional: true, attrs: 'maxlength="34" inputmode="numeric"' })}
            ${field("IFSC", "bank_ifsc", s.bank_ifsc, { optional: true, attrs: 'maxlength="11" style="text-transform:uppercase"' })}
            ${field("Branch", "bank_branch", s.bank_branch, { optional: true })}
            ${field("UPI ID", "upi_id", s.upi_id, { optional: true, attrs: 'placeholder="yourname@okbank"' })}
            ${check("Show a UPI payment QR code on invoices", "show_upi_qr", s.show_upi_qr, "The QR contains your UPI ID and the balance due. Scanning it opens the customer's UPI app; you still record the payment here once you receive it.")}
            ${textarea("Other payment details", "bank_details", s.bank_details, { rows: 2, hint: "Anything else to print, e.g. SWIFT code for international transfers." })}
          </div>
        </section>

        <section class="card" role="tabpanel" id="panel-branding" aria-labelledby="tab-branding" data-panel="branding">
          <div class="card-header"><div><h2>Branding & signature</h2><p>Images upload immediately; other changes apply when you save.</p></div></div>
          <div class="card-body">
            <div id="assetRows">${assetRows(s.assets)}</div>
            <div class="form-grid" style="margin-top:16px">
              <div class="field"><label for="s_brand_color">Accent colour</label>
                <div style="display:flex;gap:8px;align-items:center"><input class="color-input" type="color" id="s_brand_color" name="brand_color" value="${s.brand_color}"><span class="muted small">Used for headings and table accents.</span></div></div>
              <div></div>
              ${field("Authorised signatory name", "signatory_name", s.signatory_name, { optional: true })}
              ${field("Signatory title", "signatory_title", s.signatory_title)}
              ${check("Show the signature block on invoices", "show_signature_block", s.show_signature_block)}
            </div>
            <h3 style="margin:20px 0 10px">Preview</h3>
            <p class="muted small" style="margin-bottom:10px">A sample invoice using your current (unsaved) settings. The line item is illustrative only.</p>
            <div id="brandPreview"></div>
          </div>
        </section>

        <div class="sticky-actions">
          <span class="status-text" id="settingsStatus">All changes saved</span>
          <button type="submit" class="btn btn-primary" data-busy-label="Saving">Save settings</button>
        </div>
      </form>
    </div>`
  );

  const form = $("#settingsForm", root);
  const showTab = (id) => {
    tab = id;
    $$("[data-panel]", root).forEach((panel) => {
      panel.hidden = panel.dataset.panel !== id;
    });
    $$("[data-tab]", root).forEach((button) => button.setAttribute("aria-selected", String(button.dataset.tab === id)));
    replaceQuery(id === "profile" ? {} : { tab: id });
    if (id === "branding") updatePreview();
  };

  const snapshot = () => JSON.stringify(formValues(form));
  let baseline = snapshot();
  let dirty = false;
  setGuard(() => !dirty);

  const currentSettings = () => {
    const values = formValues(form);
    return Object.assign({}, s, values, { state: core.stateByCode(values.state_code)?.name || "", assets: s.assets });
  };

  const updatePreview = debounce(() => {
    if (tab !== "branding") return;
    const current = currentSettings();
    const gst = current.gst_registered && current.state_code;
    const taxType = gst ? "cgst_sgst" : "none";
    const { value } = core.normalizeInvoiceInput({ items: [{ description: "Sample item (preview only)", quantity: "1", unit_price: "1000", tax_rate: gst ? current.default_tax_rate || "18" : "0" }] });
    const calc = core.calculateInvoice(value, taxType);
    const t = calc.totals;
    mount(
      $("#brandPreview", root),
      renderInvoiceDocument(
        {
          invoice_number:
            current.invoice_prefix === s.invoice_prefix && Number(current.invoice_padding) === Number(s.invoice_padding)
              ? s.next_invoice_number
              : core.formatDocumentNumber(current.invoice_prefix, 1, current.invoice_padding, store.today),
          issue_date: store.today,
          due_date: core.addDays(store.today, Number(current.default_payment_terms) || 0),
          status: "draft",
          tax_type: taxType,
          place_of_supply: current.state_code,
          reverse_charge: false,
          currency: current.currency,
          supplier: current,
          customer: { name: "Customer name", address: "Customer address" },
          items: calc.items.map((item) => ({ ...item, taxable: item.taxable_amount, discount_label: "" })),
          totals: { ...t, paid_total: 0, balance_due: t.total },
          tax_summary: [],
          amount_in_words: core.amountInWords(t.total, current.currency),
          notes: current.default_notes,
          terms: current.terms,
          payment_instructions: current.default_payment_instructions,
          settings: current,
          qr_placeholder: current.show_upi_qr && current.upi_id,
          watermark: null,
        },
        { compact: true }
      )
    );
  }, 150);

  const updateNumberExample = () => {
    const values = formValues(form);
    if (!values.next_invoice_number) {
      $("#numberExample", root).textContent =
        values.invoice_prefix === s.invoice_prefix && Number(values.invoice_padding) === Number(s.invoice_padding) && values.invoice_reset === s.invoice_reset
          ? s.next_invoice_number
          : `${core.formatDocumentNumber(values.invoice_prefix, 1, values.invoice_padding, store.today)} (sequence continues after saving)`;
      return;
    }
    $("#numberExample", root).textContent = core.formatDocumentNumber(values.invoice_prefix, Number(values.next_invoice_number) || 1, values.invoice_padding, store.today);
  };

  form.addEventListener("input", () => {
    dirty = snapshot() !== baseline;
    $("#settingsStatus", root).textContent = dirty ? "Unsaved changes" : "All changes saved";
    updateNumberExample();
    updatePreview();
  });
  form.addEventListener("change", () => form.dispatchEvent(new Event("input")));
  on(root, "click", "[data-tab]", (button) => showTab(button.dataset.tab));

  const refreshAssets = (assets) => {
    s.assets = assets;
    invalidateSettings();
    mount($("#assetRows", root), assetRows(assets));
    updatePreview();
  };

  on(root, "change", "[data-upload]", async (input) => {
    const file = input.files[0];
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      toast("Please choose a PNG or JPEG image.", { type: "error" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast("Images must be 2 MB or smaller.", { type: "error" });
      return;
    }
    const data = new FormData();
    data.append("file", file);
    try {
      const result = await api(`/business/assets/${input.dataset.upload}`, { method: "POST", body: data });
      refreshAssets(result.assets);
      toast(`${ASSETS.find((a) => a.kind === input.dataset.upload).label} updated.`);
    } catch (error) {
      toastError(error);
    }
  });
  on(root, "keydown", "label[role=button]", (label, event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      label.querySelector("input").click();
    }
  });
  on(root, "click", "[data-remove]", async (button) => {
    const ok = await confirmDialog({ title: "Remove image?", message: "It will no longer appear on invoices.", confirmLabel: "Remove", danger: true });
    if (!ok) return;
    try {
      const result = await api(`/business/assets/${button.dataset.remove}`, { method: "DELETE" });
      refreshAssets(result.assets);
      toast("Image removed.");
    } catch (error) {
      toastError(error);
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    const values = formValues(form);
    const button = event.submitter || form.querySelector("[type=submit]");
    await withBusy(button, async () => {
      try {
        s = await api("/business", { method: "PUT", body: values });
        store.settings = s;
        Object.assign(store.business || {}, { name: s.name, currency: s.currency, gst_registered: s.gst_registered, state_code: s.state_code, timezone: s.timezone });
        store.setup.profile_complete = Boolean(s.name && s.address && s.state_code);
        $("#s_next_invoice_number", root).value = "";
        baseline = snapshot();
        dirty = false;
        clearGuard();
        setGuard(() => !dirty);
        $("#settingsStatus", root).textContent = "All changes saved";
        updateNumberExample();
        toast("Business settings saved.");
      } catch (error) {
        if (error.errors?.length) {
          const firstField = error.errors[0].field;
          const owner = TABS.find((t) => t.fields.includes(firstField));
          if (owner && owner.id !== tab) showTab(owner.id);
          showFieldErrors(form, error.errors);
          toast(error.message, { type: "error" });
        } else toastError(error);
      }
    });
  });

  showTab(tab);
  updateNumberExample();
}
