import { html } from "../lib/dom.js";
import { date } from "../lib/format.js";

const core = window.InvoiceCore;
const plain = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const amt = (units) => plain.format((units || 0) / 100);
const cur = (units, currency) => core.formatMoney(units || 0, currency);
const pct = (bp) => `${core.unitsToPlain(bp || 0)}%`;

function addressLines(party) {
  if (!party) return [];
  const state = party.state && party.state_code ? `${party.state} (${party.state_code})` : party.state;
  return [party.address, [party.city, state, party.postal_code].filter(Boolean).join(", "), party.country].filter((line) =>
    String(line || "").trim()
  );
}

function stateLabel(code) {
  const state = core.stateByCode(code);
  return state ? `${state.name} (${state.code})` : code || "—";
}

/** Normalise a saved invoice (API shape) into the document model. */
export function fromSaved(invoice, settings) {
  const u = (value) => core.toUnits(value);
  return {
    invoice_number: invoice.invoice_number,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    status: invoice.status,
    tax_type: invoice.tax_type,
    place_of_supply: invoice.place_of_supply,
    reverse_charge: invoice.reverse_charge,
    currency: invoice.currency,
    supplier: invoice.supplier,
    customer: invoice.customer,
    items: invoice.items.map((item) => ({
      description: item.description,
      hsn_sac: item.hsn_sac,
      unit: item.unit,
      quantity: core.toUnits(item.quantity, core.QTY_SCALE),
      unit_price: u(item.unit_price),
      discount_amount: u(item.discount_amount),
      discount_label: item.discount_type === "percent" && u(item.discount_value) > 0 ? `${core.unitsToPlain(u(item.discount_value))}%` : "",
      taxable: u(item.taxable_amount),
      tax_rate: u(item.tax_rate),
      tax_amount: u(item.tax_amount),
      line_total: u(item.line_total),
    })),
    totals: {
      subtotal: u(invoice.subtotal),
      discount_total: u(invoice.discount_total),
      taxable_total: u(invoice.taxable_total),
      cgst_total: u(invoice.cgst_total),
      sgst_total: u(invoice.sgst_total),
      igst_total: u(invoice.igst_total),
      tax_total: u(invoice.tax_total),
      round_off: u(invoice.round_off),
      total: u(invoice.total),
      paid_total: u(invoice.paid_total),
      balance_due: u(invoice.balance_due),
    },
    tax_summary: invoice.tax_summary.map((row) => ({
      hsn_sac: row.hsn_sac,
      rate: u(row.rate),
      taxable: u(row.taxable),
      cgst: u(row.cgst),
      sgst: u(row.sgst),
      igst: u(row.igst),
      tax: u(row.tax),
    })),
    amount_in_words: invoice.amount_in_words,
    notes: invoice.notes,
    terms: invoice.terms,
    payment_instructions: invoice.payment_instructions,
    cancel_reason: invoice.cancel_reason,
    settings,
    qr_url:
      settings?.show_upi_qr && settings.upi_id && invoice.currency === "INR" && u(invoice.balance_due) > 0 && invoice.status !== "cancelled"
        ? `/api/invoices/${encodeURIComponent(invoice.id)}/upi-qr.svg?b=${u(invoice.balance_due)}`
        : null,
    watermark: invoice.status === "draft" ? "DRAFT" : invoice.status === "cancelled" ? "CANCELLED" : null,
  };
}

/** Build the document model from the editor's live calculation. */
export function fromDraft({ calc, form, settings, customer, invoiceNumber, paidUnits = 0, status = "draft" }) {
  const tax = calc.tax_type;
  const summaryInput = calc.items.map((item) => ({
    hsn_sac: item.hsn_sac,
    tax_rate: core.unitsToString(item.tax_rate),
    taxable_amount: core.unitsToString(item.taxable_amount),
    cgst_amount: core.unitsToString(item.cgst_amount),
    sgst_amount: core.unitsToString(item.sgst_amount),
    igst_amount: core.unitsToString(item.igst_amount),
    tax_amount: core.unitsToString(item.tax_amount),
  }));
  const total = calc.totals.total;
  return {
    invoice_number: invoiceNumber,
    issue_date: form.issue_date,
    due_date: form.due_date,
    status,
    tax_type: tax,
    place_of_supply: form.place_of_supply,
    reverse_charge: calc.reverse_charge,
    currency: form.currency,
    supplier: {
      name: settings.name,
      address: settings.address,
      city: settings.city,
      state: settings.state,
      state_code: settings.state_code,
      postal_code: settings.postal_code,
      country: settings.country,
      gst_number: settings.gst_number,
      pan: settings.pan,
      phone: settings.phone,
      email: settings.email,
      website: settings.website,
    },
    customer,
    items: calc.items.map((item) => ({
      description: item.description,
      hsn_sac: item.hsn_sac,
      unit: item.unit,
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_amount: item.discount_amount,
      discount_label: item.discount_type === "percent" && item.discount_value > 0 ? `${core.unitsToPlain(item.discount_value)}%` : "",
      taxable: item.taxable_amount,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      line_total: item.line_total,
    })),
    totals: Object.assign({}, calc.totals, { paid_total: paidUnits, balance_due: Math.max(total - paidUnits, 0) }),
    tax_summary: core.taxSummary(summaryInput, tax),
    amount_in_words: core.amountInWords(total, form.currency),
    notes: form.notes,
    terms: form.terms,
    payment_instructions: form.payment_instructions,
    settings,
    qr_placeholder: settings.show_upi_qr && settings.upi_id && form.currency === "INR" && total > 0,
    watermark: status === "draft" ? "DRAFT" : null,
  };
}

export function renderInvoiceDocument(doc, { compact = false } = {}) {
  const s = doc.settings || {};
  const accent = /^#[0-9a-f]{6}$/i.test(s.brand_color || "") ? s.brand_color : "#2563eb";
  const isGst = doc.tax_type === "cgst_sgst" || doc.tax_type === "igst";
  const hasTax = doc.tax_type !== "none";
  const hasDiscount = doc.items.some((item) => item.discount_amount > 0);
  const t = doc.totals;
  const currency = doc.currency || "INR";
  const logo = s.assets?.logo?.url;
  const supplier = doc.supplier || {};
  const customer = doc.customer;
  const ids = [supplier.gst_number && `GSTIN: ${supplier.gst_number}`, supplier.pan && `PAN: ${supplier.pan}`].filter(Boolean);
  const bank = [
    ["Account name", s.bank_account_name],
    ["Bank", s.bank_name],
    ["Account no.", s.bank_account_number],
    ["IFSC", s.bank_ifsc],
    ["Branch", s.bank_branch],
    ["UPI ID", s.upi_id],
  ].filter(([, value]) => value);
  const showPayment = bank.length || s.bank_details || doc.payment_instructions || doc.qr_url || doc.qr_placeholder;

  return html`<div class="doc-frame${compact ? " compact" : ""}">
    <article class="doc" style="--doc-accent:${accent}" aria-label="Invoice ${doc.invoice_number || "preview"}">
      ${doc.watermark ? html`<div class="doc-watermark${doc.watermark === "CANCELLED" ? " danger" : ""}" aria-hidden="true">${doc.watermark}</div>` : ""}
      <header class="doc-head">
        <div class="doc-supplier">
          ${logo ? html`<img class="doc-logo" src="${logo}" alt="${supplier.name || "Business"} logo">` : ""}
          <strong>${supplier.name || "Your business name"}</strong>
          ${addressLines(supplier).map((line) => html`<div class="doc-muted">${line}</div>`)}
          ${ids.length ? html`<div style="font-weight:600;margin-top:2px">${ids.join("   ")}</div>` : ""}
          <div class="doc-muted">${[supplier.phone, supplier.email, supplier.website].filter(Boolean).join(" · ")}</div>
        </div>
        <div>
          <h2 class="doc-title">${isGst ? "TAX INVOICE" : "INVOICE"}</h2>
          <dl class="doc-meta">
            <dt>Invoice no.</dt><dd>${doc.invoice_number || "Assigned on save"}</dd>
            <dt>Invoice date</dt><dd>${date(doc.issue_date)}</dd>
            <dt>Due date</dt><dd>${doc.due_date ? date(doc.due_date) : "On receipt"}</dd>
            ${isGst && doc.place_of_supply ? html`<dt>Place of supply</dt><dd>${stateLabel(doc.place_of_supply)}</dd>` : ""}
            ${isGst ? html`<dt>Reverse charge</dt><dd>${doc.reverse_charge ? "Yes" : "No"}</dd>` : ""}
          </dl>
        </div>
      </header>
      <div class="doc-rule"></div>
      <section class="doc-parties">
        <div>
          <div class="doc-section-label">Bill to</div>
          ${customer
            ? html`<div style="font-weight:600;font-size:1.1em">${customer.name}</div>
                ${customer.company_name ? html`<div>${customer.company_name}</div>` : ""}
                ${addressLines(customer).map((line) => html`<div class="doc-muted">${line}</div>`)}
                ${customer.gst_number ? html`<div style="font-weight:600">GSTIN: ${customer.gst_number}</div>` : ""}
                <div class="doc-muted">${[customer.phone, customer.email].filter(Boolean).join(" · ")}</div>`
            : html`<div class="doc-muted">No customer selected</div>`}
        </div>
        ${customer?.shipping_address
          ? html`<div><div class="doc-section-label">Ship to</div><div style="font-weight:600">${customer.name}</div><div class="doc-muted pre">${customer.shipping_address}</div></div>`
          : ""}
      </section>
      <div class="doc-table-wrap">
        <table class="doc-table">
          <thead>
            <tr>
              <th style="width:28px">#</th>
              <th>Item / description</th>
              <th class="r">Qty</th>
              <th class="r">Rate</th>
              ${hasDiscount ? html`<th class="r">Discount</th>` : ""}
              ${hasTax ? html`<th class="r">${isGst ? "Taxable value" : "Net"}</th><th class="r">${isGst ? "GST" : "Tax"}</th>` : ""}
              <th class="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${doc.items.length
              ? doc.items.map(
                  (item, i) => html`<tr>
                    <td>${i + 1}</td>
                    <td>${item.description}${item.hsn_sac ? html`<span class="sub">HSN/SAC: ${item.hsn_sac}</span>` : ""}</td>
                    <td class="r">${core.formatQuantity(item.quantity)}${item.unit ? html`<span class="sub">${item.unit}</span>` : ""}</td>
                    <td class="r">${amt(item.unit_price)}</td>
                    ${hasDiscount ? html`<td class="r">${item.discount_amount ? amt(item.discount_amount) : "–"}${item.discount_label ? html`<span class="sub">${item.discount_label}</span>` : ""}</td>` : ""}
                    ${hasTax ? html`<td class="r">${amt(item.taxable)}</td><td class="r">${amt(item.tax_amount)}<span class="sub">${pct(item.tax_rate)}</span></td>` : ""}
                    <td class="r">${amt(item.line_total)}</td>
                  </tr>`
                )
              : html`<tr><td colspan="8" class="doc-muted" style="text-align:center;padding:18px">Add line items to see them here</td></tr>`}
          </tbody>
        </table>
      </div>
      <section class="doc-bottom">
        <div>
          <div class="doc-section-label">Amount in words</div>
          <div class="doc-words">${doc.amount_in_words}</div>
          ${doc.reverse_charge ? html`<p class="doc-muted" style="margin-top:6px">Tax is payable on reverse charge basis by the recipient; GST shown is not included in the amount payable.</p>` : ""}
          ${doc.status === "cancelled" ? html`<p style="margin-top:6px;color:#b42318;font-weight:600">This invoice was cancelled${doc.cancel_reason ? `: ${doc.cancel_reason}` : "."}</p>` : ""}
        </div>
        <div class="doc-totals">
          <div><span class="doc-muted">Subtotal</span><span>${cur(t.subtotal, currency)}</span></div>
          ${t.discount_total ? html`<div><span class="doc-muted">Discount</span><span>− ${cur(t.discount_total, currency)}</span></div>` : ""}
          ${hasTax ? html`<div><span class="doc-muted">${isGst ? "Taxable amount" : "Net amount"}</span><span>${cur(t.taxable_total, currency)}</span></div>` : ""}
          ${doc.tax_type === "cgst_sgst"
            ? html`<div><span class="doc-muted">CGST</span><span>${cur(t.cgst_total, currency)}</span></div><div><span class="doc-muted">SGST</span><span>${cur(t.sgst_total, currency)}</span></div>`
            : doc.tax_type === "igst"
              ? html`<div><span class="doc-muted">IGST</span><span>${cur(t.igst_total, currency)}</span></div>`
              : doc.tax_type === "simple"
                ? html`<div><span class="doc-muted">Tax</span><span>${cur(t.tax_total, currency)}</span></div>`
                : ""}
          ${doc.reverse_charge ? html`<div><span class="doc-muted">GST payable by recipient</span><span>− ${cur(t.tax_total, currency)}</span></div>` : ""}
          ${t.round_off ? html`<div><span class="doc-muted">Round off</span><span>${cur(t.round_off, currency)}</span></div>` : ""}
          <div class="doc-grand"><span>Total</span><span>${cur(t.total, currency)}</span></div>
          ${t.paid_total
            ? html`<div><span class="doc-muted">Amount paid</span><span>${cur(t.paid_total, currency)}</span></div>
                <div style="font-weight:700"><span>Balance due</span><span>${cur(t.balance_due, currency)}</span></div>`
            : ""}
        </div>
      </section>
      ${isGst && doc.tax_summary.length
        ? html`<section class="doc-block">
            <div class="doc-section-label">Tax summary</div>
            <div class="doc-table-wrap"><table class="doc-table">
              <thead><tr>
                ${doc.tax_summary.some((r) => r.hsn_sac) ? html`<th>HSN/SAC</th>` : ""}
                <th>Rate</th><th class="r">Taxable value</th>
                ${doc.tax_type === "cgst_sgst" ? html`<th class="r">CGST</th><th class="r">SGST</th>` : html`<th class="r">IGST</th>`}
                <th class="r">Total tax</th>
              </tr></thead>
              <tbody>
                ${doc.tax_summary.map(
                  (row) => html`<tr>
                    ${doc.tax_summary.some((r) => r.hsn_sac) ? html`<td>${row.hsn_sac || "–"}</td>` : ""}
                    <td>${pct(row.rate)}</td><td class="r">${amt(row.taxable)}</td>
                    ${doc.tax_type === "cgst_sgst" ? html`<td class="r">${amt(row.cgst)}</td><td class="r">${amt(row.sgst)}</td>` : html`<td class="r">${amt(row.igst)}</td>`}
                    <td class="r">${amt(row.tax)}</td>
                  </tr>`
                )}
              </tbody>
            </table></div>
          </section>`
        : ""}
      ${showPayment
        ? html`<section class="doc-block doc-payment">
            <div>
              <div class="doc-section-label">Payment details</div>
              ${bank.length ? html`<dl class="doc-kv">${bank.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>` : ""}
              ${s.bank_details ? html`<div class="pre" style="margin-top:6px">${s.bank_details}</div>` : ""}
              ${doc.payment_instructions ? html`<div style="margin-top:8px"><strong>Payment instructions</strong><div class="pre">${doc.payment_instructions}</div></div>` : ""}
            </div>
            ${doc.qr_url
              ? html`<div class="doc-qr"><img src="${doc.qr_url}" alt="UPI payment QR code for ${cur(t.balance_due, currency)} to ${s.upi_id}"><div style="font-weight:600">Scan to pay with any UPI app</div><div class="doc-muted">${cur(t.balance_due, currency)} to ${s.upi_id}</div></div>`
              : doc.qr_placeholder
                ? html`<div class="doc-qr"><div class="qr-placeholder">UPI QR code is added to the saved invoice</div></div>`
                : ""}
          </section>`
        : ""}
      ${doc.notes ? html`<section class="doc-block"><div class="doc-section-label">Notes</div><div class="pre">${doc.notes}</div></section>` : ""}
      ${doc.terms ? html`<section class="doc-block"><div class="doc-section-label">Terms and conditions</div><div class="pre">${doc.terms}</div></section>` : ""}
      ${s.show_signature_block
        ? html`<section class="doc-signature">
            <div style="font-weight:600">For ${supplier.name || ""}</div>
            <div class="sig-images">
              ${s.assets?.stamp ? html`<img src="${s.assets.stamp.url}" alt="Business stamp">` : ""}
              ${s.assets?.signature ? html`<img src="${s.assets.signature.url}" alt="Authorised signature">` : ""}
            </div>
            <div class="sig-line">
              ${s.signatory_name ? html`<div style="font-weight:600">${s.signatory_name}</div>` : ""}
              <div class="doc-muted">${s.signatory_title || "Authorised Signatory"}</div>
            </div>
          </section>`
        : ""}
    </article>
  </div>`;
}
