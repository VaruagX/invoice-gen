const core = require("../../shared/invoice-core");
const { query, withTransaction } = require("../db");
const { HttpError, badRequest, isUuid } = require("./http");
const { logActivity } = require("./activity");
const { businessSnapshot, customerSnapshot } = require("./business");
const { rules } = require("./validate");

const S = core.unitsToString;

/** SQL condition for "past due with money outstanding". todayParam is a date parameter. */
function overdueSql(alias, todayParam) {
  return `(${alias}.status IN ('unpaid', 'partially_paid') AND ${alias}.due_date IS NOT NULL AND ${alias}.due_date < ${todayParam}::date AND ${alias}.total > ${alias}.paid_total)`;
}

const CUSTOMER_NAME_SQL = "COALESCE(NULLIF(i.customer_snapshot->>'name', ''), c.name, '')";

/** Columns for invoice list rows. Expects aliases i (invoices) and c (customers). */
function listColumns(todayParam) {
  const overdue = overdueSql("i", todayParam);
  return `
    i.id, i.invoice_number, i.status, i.issue_date, i.due_date, i.currency, i.total, i.paid_total,
    (i.total - i.paid_total) AS balance_due, i.customer_id, i.tax_type, i.taxable_total, i.tax_total,
    ${CUSTOMER_NAME_SQL} AS customer_name,
    COALESCE(NULLIF(i.customer_snapshot->>'company_name', ''), c.company_name, '') AS customer_company,
    COALESCE(NULLIF(i.customer_snapshot->>'email', ''), c.email, '') AS customer_email,
    COALESCE(NULLIF(i.customer_snapshot->>'phone', ''), c.phone, '') AS customer_phone,
    ${overdue} AS is_overdue,
    CASE WHEN ${overdue} THEN (${todayParam}::date - i.due_date) ELSE 0 END AS days_overdue,
    CASE WHEN ${overdue} THEN 'overdue' ELSE i.status END AS display_status,
    i.created_at, i.updated_at`;
}

function deriveStatus(paidUnits, totalUnits) {
  if (paidUnits >= totalUnits) return "paid";
  if (paidUnits > 0) return "partially_paid";
  return "unpaid";
}

/** Recompute paid_total from non-voided payments and update the payment status. */
async function refreshPaymentState(client, invoiceId) {
  const result = await client.query(
    `UPDATE invoices i SET
       paid_total = s.paid,
       status = CASE
         WHEN i.status IN ('draft', 'cancelled') THEN i.status
         WHEN s.paid >= i.total THEN 'paid'
         WHEN s.paid > 0 THEN 'partially_paid'
         ELSE 'unpaid'
       END,
       updated_at = now()
     FROM (SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = $1 AND voided_at IS NULL) s
     WHERE i.id = $1
     RETURNING i.status, i.paid_total, i.total`,
    [invoiceId]
  );
  return result.rows[0];
}

/**
 * Allocate the next document number inside the caller's transaction. The
 * upsert row-locks the counter until commit, so concurrent requests queue up
 * and can never receive the same value. Numbers already taken (for example a
 * manually entered invoice number) are skipped.
 */
async function allocateNumber(client, userId, business, kind, isoDate) {
  const scope = kind === "invoice" ? core.sequenceScope(business.invoice_reset, isoDate) : "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query(
      `INSERT INTO document_sequences (user_id, kind, scope, last_value) VALUES ($1, $2, $3, 1)
       ON CONFLICT (user_id, kind, scope)
       DO UPDATE SET last_value = document_sequences.last_value + 1, updated_at = now()
       RETURNING last_value`,
      [userId, kind, scope]
    );
    const sequence = result.rows[0].last_value;
    if (kind === "invoice") {
      const number = core.formatDocumentNumber(business.invoice_prefix, sequence, business.invoice_padding, isoDate);
      const taken = await client.query("SELECT 1 FROM invoices WHERE user_id = $1 AND invoice_number = $2", [userId, number]);
      if (!taken.rows.length) return number;
    } else {
      const number = core.formatDocumentNumber(business.receipt_prefix || "RCPT-", sequence, 4, isoDate);
      const taken = await client.query("SELECT 1 FROM payments WHERE user_id = $1 AND receipt_number = $2", [userId, number]);
      if (!taken.rows.length) return number;
    }
  }
  throw new HttpError(409, "Could not allocate a unique number. Please review your numbering settings.");
}

/** Preview of the next invoice number (not reserved). */
async function previewNextNumber(userId, business, isoDate) {
  const scope = core.sequenceScope(business.invoice_reset, isoDate);
  const result = await query(
    "SELECT last_value FROM document_sequences WHERE user_id = $1 AND kind = 'invoice' AND scope = $2",
    [userId, scope]
  );
  const next = (result.rows[0]?.last_value || 0) + 1;
  return core.formatDocumentNumber(business.invoice_prefix, next, business.invoice_padding, isoDate);
}

const INVOICE_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-/_.#]{0,39}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Validate the non-item parts of an invoice payload. */
function validateMeta(body, business, { creating }) {
  const errors = [];
  const pick = (field, label, rule) => {
    const result = rule(body[field], label);
    if (result.error) errors.push({ field, message: result.error });
    return result.value;
  };
  const value = {
    issue_date: pick("issue_date", "Invoice date", rules.date({ required: true })),
    due_date: pick("due_date", "Due date", rules.date()),
    notes: pick("notes", "Notes", rules.text(2000)),
    terms: pick("terms", "Terms and conditions", rules.text(4000)),
    payment_instructions: pick("payment_instructions", "Payment instructions", rules.text(2000)),
    action: ["issue", "draft", "save"].includes(body.action) ? body.action : creating ? "draft" : "save",
  };
  const currency = String(body.currency || business.currency || "INR").trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) errors.push({ field: "currency", message: "Currency must be a 3-letter code such as INR." });
  value.currency = currency;

  const customerId = body.customer_id ? String(body.customer_id) : "";
  if (customerId && !isUuid(customerId)) errors.push({ field: "customer_id", message: "Choose a customer from your list." });
  value.customer_id = customerId || null;

  if (value.issue_date && value.due_date && value.due_date < value.issue_date) {
    errors.push({ field: "due_date", message: "Due date cannot be before the invoice date." });
  }
  if (creating && body.invoice_number) {
    const number = String(body.invoice_number).trim();
    if (!INVOICE_NUMBER_PATTERN.test(number)) {
      errors.push({
        field: "invoice_number",
        message: "Invoice number can use letters, digits and - / _ . # (up to 40 characters).",
      });
    }
    value.invoice_number = number;
  }
  return { value, errors };
}

/**
 * Validate and compute an invoice from a request body. Returns the computed
 * invoice plus the customer it belongs to. Throws 422 with all field errors.
 */
async function buildInvoice(client, { userId, business, body, existing }) {
  const meta = validateMeta(body || {}, business, { creating: !existing });
  const input = core.normalizeInvoiceInput(body || {});
  const errors = [...meta.errors, ...input.errors];

  let customer = null;
  if (meta.value.customer_id) {
    customer = (
      await client.query("SELECT * FROM customers WHERE id = $1 AND user_id = $2", [meta.value.customer_id, userId])
    ).rows[0];
    if (!customer) {
      errors.push({ field: "customer_id", message: "That customer could not be found." });
    } else if (customer.archived_at && existing?.customer_id !== customer.id) {
      errors.push({ field: "customer_id", message: "This customer is archived. Restore them before billing them again." });
    }
  }

  const placeOfSupply = input.value.place_of_supply || customer?.state_code || business.state_code || "";
  const treatment = input.value.gst_treatment;
  if (["auto", "cgst_sgst", "igst"].includes(treatment) && !business.gst_registered) {
    errors.push({
      field: "gst_treatment",
      message: "Your business is not set up as GST registered. Add your GSTIN in Business Settings, or choose a non-GST option.",
    });
  }
  let taxType = core.resolveTaxType(treatment, business.state_code, placeOfSupply);
  if (!taxType) {
    errors.push({
      field: "place_of_supply",
      message: "To apply GST automatically, set your business state in Business Settings and choose a place of supply.",
    });
    taxType = "none";
  }

  const calc = core.calculateInvoice(Object.assign({}, input.value, { place_of_supply: placeOfSupply }), taxType);
  errors.push(...calc.errors);
  if (errors.length) throw badRequest(errors);

  return { meta: meta.value, input: input.value, placeOfSupply, treatment, calc, customer };
}

async function insertItems(client, invoiceId, items) {
  if (!items.length) return;
  const columns = [
    "invoice_id", "position", "description", "hsn_sac", "unit", "quantity", "price", "discount_type",
    "discount_value", "tax_rate", "gross_amount", "discount_amount", "invoice_discount_share",
    "taxable_amount", "cgst_amount", "sgst_amount", "igst_amount", "tax_amount", "line_total",
  ];
  const params = [];
  const rows = items.map((item) => {
    const values = [
      invoiceId,
      item.position,
      item.description,
      item.hsn_sac,
      item.unit,
      S(item.quantity, core.QTY_SCALE),
      S(item.unit_price),
      item.discount_type,
      S(item.discount_value),
      S(item.tax_rate),
      S(item.gross_amount),
      S(item.discount_amount),
      S(item.invoice_discount_share),
      S(item.taxable_amount),
      S(item.cgst_amount),
      S(item.sgst_amount),
      S(item.igst_amount),
      S(item.tax_amount),
      S(item.line_total),
    ];
    const placeholders = values.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  await client.query(`INSERT INTO invoice_items (${columns.join(", ")}) VALUES ${rows.join(", ")}`, params);
}

function invoiceRecordValues(built, business) {
  const { meta, input, placeOfSupply, treatment, calc, customer } = built;
  const t = calc.totals;
  return {
    customer_id: customer ? customer.id : null,
    issue_date: meta.issue_date,
    due_date: meta.due_date,
    currency: meta.currency,
    notes: meta.notes,
    terms: meta.terms,
    payment_instructions: meta.payment_instructions,
    gst_treatment: treatment,
    tax_type: calc.tax_type,
    place_of_supply: calc.tax_type === "none" && !placeOfSupply ? "" : placeOfSupply,
    reverse_charge: calc.reverse_charge,
    round_off_enabled: Boolean(input.round_off),
    discount_type: input.discount_type,
    discount_value: S(input.discount_value),
    subtotal: S(t.subtotal),
    item_discount_total: S(t.item_discount_total),
    invoice_discount_amount: S(t.invoice_discount_amount),
    discount_total: S(t.discount_total),
    taxable_total: S(t.taxable_total),
    cgst_total: S(t.cgst_total),
    sgst_total: S(t.sgst_total),
    igst_total: S(t.igst_total),
    tax_total: S(t.tax_total),
    round_off: S(t.round_off),
    total: S(t.total),
    customer_snapshot: customer ? JSON.stringify(customerSnapshot(customer)) : null,
    business_snapshot: JSON.stringify(businessSnapshot(business)),
  };
}

async function createInvoice({ userId, business, body, extraColumns = {} }) {
  return withTransaction(async (client) => {
    const built = await buildInvoice(client, { userId, business, body, existing: null });
    const values = invoiceRecordValues(built, business);
    const total = built.calc.totals.total;
    const status = built.meta.action === "issue" ? deriveStatus(0, total) : "draft";

    let invoiceNumber = built.meta.invoice_number;
    if (invoiceNumber) {
      const taken = await client.query("SELECT 1 FROM invoices WHERE user_id = $1 AND invoice_number = $2", [userId, invoiceNumber]);
      if (taken.rows.length) {
        throw badRequest([{ field: "invoice_number", message: `Invoice number ${invoiceNumber} is already used.` }]);
      }
    } else {
      invoiceNumber = await allocateNumber(client, userId, business, "invoice", values.issue_date);
    }

    const record = Object.assign(values, extraColumns, {
      user_id: userId,
      business_id: business.id,
      invoice_number: invoiceNumber,
      status,
      issued_at: status === "draft" ? null : new Date(),
    });
    const columns = Object.keys(record);
    const inserted = await client.query(
      `INSERT INTO invoices (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      columns.map((column) => record[column])
    );
    const invoiceId = inserted.rows[0].id;
    await insertItems(client, invoiceId, built.calc.items);

    const who = built.customer ? ` for ${built.customer.name}` : "";
    await logActivity(client, userId, {
      entityType: "invoice",
      entityId: invoiceId,
      action: extraColumns.duplicated_from ? "duplicated" : status === "draft" ? "created" : "issued",
      summary: extraColumns.duplicated_from
        ? `Invoice ${invoiceNumber} created as a copy${who}`
        : `Invoice ${invoiceNumber} ${status === "draft" ? "saved as draft" : "created"}${who}`,
      metadata: { invoice_number: invoiceNumber, total: values.total },
    });
    return invoiceId;
  });
}

async function updateInvoice({ userId, business, invoiceId, body }) {
  return withTransaction(async (client) => {
    const existing = (
      await client.query("SELECT * FROM invoices WHERE id = $1 AND user_id = $2 FOR UPDATE", [invoiceId, userId])
    ).rows[0];
    if (!existing) throw new HttpError(404, "Invoice not found");
    if (existing.status === "cancelled") {
      throw new HttpError(409, "This invoice is cancelled. Restore it before making changes.");
    }
    const built = await buildInvoice(client, { userId, business, body, existing });
    const values = invoiceRecordValues(built, business);
    const total = built.calc.totals.total;
    const paid = core.toUnits(existing.paid_total);
    if (paid > total) {
      throw badRequest([
        {
          field: "items",
          message: `The new total (${core.formatMoney(total, values.currency)}) is less than the ${core.formatMoney(
            paid,
            values.currency
          )} already received. Void a payment first or adjust the items.`,
        },
      ]);
    }

    let status = existing.status;
    let issuedAt = existing.issued_at;
    let action = "updated";
    if (existing.status === "draft") {
      if (built.meta.action === "issue") {
        status = deriveStatus(paid, total);
        issuedAt = new Date();
        action = "issued";
      }
    } else {
      status = deriveStatus(paid, total);
    }

    const record = Object.assign(values, { status, issued_at: issuedAt, updated_at: new Date() });
    const columns = Object.keys(record);
    await client.query(
      `UPDATE invoices SET ${columns.map((column, i) => `${column} = $${i + 1}`).join(", ")}
       WHERE id = $${columns.length + 1} AND user_id = $${columns.length + 2}`,
      [...columns.map((column) => record[column]), invoiceId, userId]
    );
    await client.query("DELETE FROM invoice_items WHERE invoice_id = $1", [invoiceId]);
    await insertItems(client, invoiceId, built.calc.items);

    const changes = [];
    if (existing.total !== values.total) {
      changes.push(`total ${core.formatAmount(existing.total, values.currency)} → ${core.formatAmount(values.total, values.currency)}`);
    }
    await logActivity(client, userId, {
      entityType: "invoice",
      entityId: invoiceId,
      action,
      summary: `Invoice ${existing.invoice_number} ${action === "issued" ? "issued" : "updated"}${changes.length ? ` (${changes.join(", ")})` : ""}`,
      metadata: { invoice_number: existing.invoice_number, previous_total: existing.total, total: values.total },
    });
    return invoiceId;
  });
}

/** Full invoice with items, payments, customer and supplier details. */
async function fetchInvoice(userId, invoiceId, today, db = { query }) {
  if (!isUuid(invoiceId)) return null;
  const overdue = overdueSql("i", "$3");
  const invoice = (
    await db.query(
      `SELECT i.*, (i.total - i.paid_total) AS balance_due, ${overdue} AS is_overdue,
         CASE WHEN ${overdue} THEN ($3::date - i.due_date) ELSE 0 END AS days_overdue,
         CASE WHEN ${overdue} THEN 'overdue' ELSE i.status END AS display_status
       FROM invoices i WHERE i.id = $1 AND i.user_id = $2`,
      [invoiceId, userId, today]
    )
  ).rows[0];
  if (!invoice) return null;

  const items = await db.query(
    `SELECT id, position, description, hsn_sac, unit, quantity, price AS unit_price, discount_type, discount_value,
       tax_rate, gross_amount, discount_amount, invoice_discount_share, taxable_amount, cgst_amount, sgst_amount,
       igst_amount, tax_amount, line_total
     FROM invoice_items WHERE invoice_id = $1 ORDER BY position, id`,
    [invoiceId]
  );
  const payments = await db.query(
    `SELECT id, receipt_number, amount, method, transaction_id AS reference, notes, payment_date, source,
       voided_at, void_reason, created_at
     FROM payments WHERE invoice_id = $1 AND user_id = $2
     ORDER BY payment_date DESC, created_at DESC`,
    [invoiceId, userId]
  );
  let liveCustomer = null;
  if (invoice.customer_id) {
    liveCustomer = (
      await db.query("SELECT * FROM customers WHERE id = $1 AND user_id = $2", [invoice.customer_id, userId])
    ).rows[0];
  }
  let supplier = invoice.business_snapshot;
  if (!supplier) {
    const business = (await db.query("SELECT * FROM businesses WHERE user_id = $1", [userId])).rows[0];
    supplier = businessSnapshot(business || {});
  }

  const nextPaymentDue =
    ["unpaid", "partially_paid"].includes(invoice.status) && invoice.due_date ? invoice.due_date : null;

  const { business_snapshot: _b, customer_snapshot: snapshot, user_id: _u, ...rest } = invoice;
  return Object.assign(rest, {
    customer: snapshot || customerSnapshot(liveCustomer),
    customer_record: liveCustomer
      ? { id: liveCustomer.id, name: liveCustomer.name, archived: Boolean(liveCustomer.archived_at) }
      : null,
    supplier,
    items: items.rows,
    payments: payments.rows,
    tax_summary: core.taxSummary(items.rows, invoice.tax_type).map((row) => ({
      hsn_sac: row.hsn_sac,
      rate: S(row.rate),
      taxable: S(row.taxable),
      cgst: S(row.cgst),
      sgst: S(row.sgst),
      igst: S(row.igst),
      tax: S(row.tax),
    })),
    amount_in_words: core.amountInWords(core.toUnits(invoice.total), invoice.currency),
    next_payment_due: nextPaymentDue,
  });
}

/** Raw editor input reconstructed from a saved invoice (used for duplication). */
function invoiceToInput(invoice) {
  return {
    customer_id: invoice.customer_id,
    currency: invoice.currency,
    gst_treatment: invoice.gst_treatment,
    place_of_supply: invoice.place_of_supply,
    reverse_charge: invoice.reverse_charge,
    round_off: invoice.round_off_enabled,
    discount_type: invoice.discount_type,
    discount_value: invoice.discount_value,
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
      discount_value: item.discount_value,
      tax_rate: item.tax_rate,
    })),
  };
}

module.exports = {
  overdueSql,
  listColumns,
  CUSTOMER_NAME_SQL,
  deriveStatus,
  refreshPaymentState,
  allocateNumber,
  previewNextNumber,
  createInvoice,
  updateInvoice,
  fetchInvoice,
  invoiceToInput,
};
