const express = require("express");
const core = require("../../shared/invoice-core");
const { query, withTransaction } = require("../db");
const { handle, HttpError, badRequest, uuidParam, parsePagination, escapeLike, isUuid, safeFilename } = require("../lib/http");
const { logActivity } = require("../lib/activity");
const { loadAssetBuffers } = require("../lib/business");
const {
  listColumns,
  overdueSql,
  CUSTOMER_NAME_SQL,
  deriveStatus,
  previewNextNumber,
  createInvoice,
  updateInvoice,
  fetchInvoice,
  invoiceToInput,
} = require("../lib/invoices");
const { renderInvoicePdf } = require("../lib/pdf/invoice-pdf");
const { qrSvg } = require("../lib/pdf/base");
const { rateLimit } = require("../middleware/security");

const router = express.Router();
router.param("invoiceId", uuidParam("Invoice"));

const pdfLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, keyPrefix: "pdf", message: "Too many PDF downloads. Please wait a moment." });

/** Build WHERE clauses for invoice lists from query-string filters. */
function invoiceFilters(q, params) {
  const where = ["i.user_id = $1"];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const overdue = overdueSql("i", "$2");

  const status = String(q.status || "");
  if (status === "overdue") where.push(overdue);
  else if (status === "open") where.push("i.status IN ('unpaid', 'partially_paid')");
  else if (["unpaid", "partially_paid"].includes(status)) where.push(`i.status = ${add(status)} AND NOT ${overdue}`);
  else if (["draft", "paid", "cancelled"].includes(status)) where.push(`i.status = ${add(status)}`);

  if (q.customer_id && isUuid(q.customer_id)) where.push(`i.customer_id = ${add(q.customer_id)}`);

  const dateColumn = q.date_field === "due" ? "i.due_date" : "i.issue_date";
  if (core.isIsoDate(q.from)) where.push(`${dateColumn} >= ${add(q.from)}::date`);
  if (core.isIsoDate(q.to)) where.push(`${dateColumn} <= ${add(q.to)}::date`);

  const amount = (value) => {
    try {
      return value === undefined || value === "" ? null : core.unitsToString(core.parseMoney(value));
    } catch (error) {
      return null;
    }
  };
  const min = amount(q.min_amount);
  const max = amount(q.max_amount);
  if (min !== null) where.push(`i.total >= ${add(min)}::numeric`);
  if (max !== null) where.push(`i.total <= ${add(max)}::numeric`);

  const search = String(q.search || "").trim().slice(0, 100);
  if (search) {
    const p = add(`%${escapeLike(search)}%`);
    where.push(`(
      i.invoice_number ILIKE ${p} OR ${CUSTOMER_NAME_SQL} ILIKE ${p}
      OR COALESCE(i.customer_snapshot->>'company_name', c.company_name, '') ILIKE ${p}
      OR COALESCE(NULLIF(i.customer_snapshot->>'email', ''), c.email, '') ILIKE ${p}
      OR COALESCE(NULLIF(i.customer_snapshot->>'phone', ''), c.phone, '') ILIKE ${p}
      OR EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.user_id = i.user_id
                 AND (p.transaction_id ILIKE ${p} OR p.receipt_number ILIKE ${p}))
    )`);
  }
  return where;
}

const SORTS = {
  issue_date: "i.issue_date",
  due_date: "i.due_date",
  total: "i.total",
  balance: "(i.total - i.paid_total)",
  number: "i.invoice_number",
  created: "i.created_at",
  customer: `lower(${CUSTOMER_NAME_SQL})`,
};

router.get(
  "/invoices",
  handle(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const params = [req.user.id, req.today];
    const where = invoiceFilters(req.query, params);
    const sort = SORTS[req.query.sort] || SORTS.issue_date;
    const dir = req.query.dir === "asc" ? "ASC" : "DESC";
    const from = "FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id";
    const [rows, summary] = await Promise.all([
      query(
        `SELECT ${listColumns("$2")} ${from} WHERE ${where.join(" AND ")}
         ORDER BY ${sort} ${dir} NULLS LAST, i.created_at DESC, i.id
         LIMIT ${pageSize} OFFSET ${offset}`,
        params
      ),
      query(
        `SELECT count(*)::int AS count,
           COALESCE(sum(i.total) FILTER (WHERE i.status NOT IN ('draft', 'cancelled')), 0) AS total,
           COALESCE(sum(i.total - i.paid_total) FILTER (WHERE i.status IN ('unpaid', 'partially_paid')), 0) AS balance
         ${from} WHERE ${where.join(" AND ")} AND $2::date IS NOT NULL`,
        params
      ),
    ]);
    res.json({ items: rows.rows, total: summary.rows[0].count, summary: summary.rows[0], page, page_size: pageSize });
  })
);

router.get(
  "/invoices/next-number",
  handle(async (req, res) => {
    const date = core.isIsoDate(req.query.issue_date) ? req.query.issue_date : req.today;
    res.json({ invoice_number: await previewNextNumber(req.user.id, req.business, date) });
  })
);

const OVERDUE_BUCKETS = {
  "1-30": [1, 30],
  "31-60": [31, 60],
  "61-90": [61, 90],
  "90+": [91, null],
};

router.get(
  "/invoices/overdue",
  handle(async (req, res) => {
    const params = [req.user.id, req.today];
    const overdue = overdueSql("i", "$2");
    const where = ["i.user_id = $1", overdue];
    const bucket = OVERDUE_BUCKETS[req.query.bucket];
    if (bucket) {
      params.push(bucket[0]);
      where.push(`($2::date - i.due_date) >= $${params.length}`);
      if (bucket[1]) {
        params.push(bucket[1]);
        where.push(`($2::date - i.due_date) <= $${params.length}`);
      }
    }
    if (req.query.customer_id && isUuid(req.query.customer_id)) {
      params.push(req.query.customer_id);
      where.push(`i.customer_id = $${params.length}`);
    }
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) {
      params.push(`%${escapeLike(search)}%`);
      where.push(`(i.invoice_number ILIKE $${params.length} OR ${CUSTOMER_NAME_SQL} ILIKE $${params.length})`);
    }
    const sort = { amount: "(i.total - i.paid_total) DESC", days: "i.due_date ASC", due: "i.due_date DESC" }[req.query.sort] ||
      "(i.total - i.paid_total) DESC";
    const from = "FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id";
    const [rows, buckets] = await Promise.all([
      query(
        `SELECT ${listColumns("$2")}, i.customer_id
         ${from} WHERE ${where.join(" AND ")}
         ORDER BY ${sort}, i.id LIMIT 500`,
        params
      ),
      query(
        `SELECT
           CASE WHEN $2::date - i.due_date <= 30 THEN '1-30'
                WHEN $2::date - i.due_date <= 60 THEN '31-60'
                WHEN $2::date - i.due_date <= 90 THEN '61-90'
                ELSE '90+' END AS bucket,
           count(*)::int AS count,
           COALESCE(sum(i.total - i.paid_total), 0) AS amount
         FROM invoices i WHERE i.user_id = $1 AND ${overdue}
         GROUP BY 1`,
        [req.user.id, req.today]
      ),
    ]);
    const summary = Object.keys(OVERDUE_BUCKETS).map((key) => {
      const row = buckets.rows.find((b) => b.bucket === key);
      return { bucket: key, count: row ? row.count : 0, amount: row ? row.amount : "0.00" };
    });
    res.json({ items: rows.rows, buckets: summary, today: req.today });
  })
);

router.post(
  "/invoices",
  handle(async (req, res) => {
    const id = await createInvoice({ userId: req.user.id, business: req.business, body: req.body || {} });
    res.status(201).json(await fetchInvoice(req.user.id, id, req.today));
  })
);

router.get(
  "/invoices/:invoiceId",
  handle(async (req, res) => {
    const invoice = await fetchInvoice(req.user.id, req.params.invoiceId, req.today);
    if (!invoice) throw new HttpError(404, "Invoice not found");
    const activity = await query(
      `SELECT id, action, summary, created_at FROM activity_logs
       WHERE user_id = $1 AND (
         (entity_type = 'invoice' AND entity_id = $2)
         OR (entity_type = 'payment' AND metadata->>'invoice_id' = $2::text)
       )
       ORDER BY created_at DESC LIMIT 30`,
      [req.user.id, req.params.invoiceId]
    );
    invoice.activity = activity.rows;
    res.json(invoice);
  })
);

router.put(
  "/invoices/:invoiceId",
  handle(async (req, res) => {
    await updateInvoice({ userId: req.user.id, business: req.business, invoiceId: req.params.invoiceId, body: req.body || {} });
    res.json(await fetchInvoice(req.user.id, req.params.invoiceId, req.today));
  })
);

router.post(
  "/invoices/:invoiceId/duplicate",
  handle(async (req, res) => {
    const source = await fetchInvoice(req.user.id, req.params.invoiceId, req.today);
    if (!source) throw new HttpError(404, "Invoice not found");
    const input = invoiceToInput(source);
    const termDays =
      source.due_date && source.issue_date ? core.daysBetween(source.issue_date, source.due_date) : req.business.default_payment_terms;
    const body = Object.assign(input, {
      issue_date: req.today,
      due_date: core.addDays(req.today, Math.max(termDays, 0)),
      action: "draft",
    });
    const id = await createInvoice({
      userId: req.user.id,
      business: req.business,
      body,
      extraColumns: { duplicated_from: source.id },
    });
    res.status(201).json(await fetchInvoice(req.user.id, id, req.today));
  })
);

router.post(
  "/invoices/:invoiceId/issue",
  handle(async (req, res) => {
    await withTransaction(async (client) => {
      const invoice = (
        await client.query("SELECT * FROM invoices WHERE id = $1 AND user_id = $2 FOR UPDATE", [req.params.invoiceId, req.user.id])
      ).rows[0];
      if (!invoice) throw new HttpError(404, "Invoice not found");
      if (invoice.status !== "draft") throw new HttpError(409, "Only draft invoices can be issued.");
      const status = deriveStatus(core.toUnits(invoice.paid_total), core.toUnits(invoice.total));
      await client.query("UPDATE invoices SET status = $1, issued_at = now(), updated_at = now() WHERE id = $2", [status, invoice.id]);
      await logActivity(client, req.user.id, {
        entityType: "invoice",
        entityId: invoice.id,
        action: "issued",
        summary: `Invoice ${invoice.invoice_number} issued`,
      });
    });
    res.json(await fetchInvoice(req.user.id, req.params.invoiceId, req.today));
  })
);

router.post(
  "/invoices/:invoiceId/cancel",
  handle(async (req, res) => {
    const reason = String(req.body?.reason || "").trim();
    if (reason.length > 300) throw badRequest([{ field: "reason", message: "Reason must be 300 characters or fewer." }]);
    await withTransaction(async (client) => {
      const invoice = (
        await client.query("SELECT * FROM invoices WHERE id = $1 AND user_id = $2 FOR UPDATE", [req.params.invoiceId, req.user.id])
      ).rows[0];
      if (!invoice) throw new HttpError(404, "Invoice not found");
      if (invoice.status === "cancelled") throw new HttpError(409, "This invoice is already cancelled.");
      if (invoice.status === "draft") throw new HttpError(409, "Draft invoices can simply be deleted.");
      if (core.toUnits(invoice.paid_total) > 0) {
        throw new HttpError(409, "This invoice has recorded payments. Void those payments before cancelling it.");
      }
      await client.query(
        "UPDATE invoices SET status = 'cancelled', cancelled_at = now(), cancel_reason = $1, updated_at = now() WHERE id = $2",
        [reason, invoice.id]
      );
      await logActivity(client, req.user.id, {
        entityType: "invoice",
        entityId: invoice.id,
        action: "cancelled",
        summary: `Invoice ${invoice.invoice_number} cancelled${reason ? `: ${reason}` : ""}`,
      });
    });
    res.json(await fetchInvoice(req.user.id, req.params.invoiceId, req.today));
  })
);

router.post(
  "/invoices/:invoiceId/restore",
  handle(async (req, res) => {
    await withTransaction(async (client) => {
      const invoice = (
        await client.query("SELECT * FROM invoices WHERE id = $1 AND user_id = $2 FOR UPDATE", [req.params.invoiceId, req.user.id])
      ).rows[0];
      if (!invoice) throw new HttpError(404, "Invoice not found");
      if (invoice.status !== "cancelled") throw new HttpError(409, "Only cancelled invoices can be restored.");
      const status = deriveStatus(core.toUnits(invoice.paid_total), core.toUnits(invoice.total));
      await client.query(
        "UPDATE invoices SET status = $1, cancelled_at = NULL, cancel_reason = '', updated_at = now() WHERE id = $2",
        [status, invoice.id]
      );
      await logActivity(client, req.user.id, {
        entityType: "invoice",
        entityId: invoice.id,
        action: "restored",
        summary: `Invoice ${invoice.invoice_number} restored`,
      });
    });
    res.json(await fetchInvoice(req.user.id, req.params.invoiceId, req.today));
  })
);

router.delete(
  "/invoices/:invoiceId",
  handle(async (req, res) => {
    await withTransaction(async (client) => {
      const invoice = (
        await client.query("SELECT * FROM invoices WHERE id = $1 AND user_id = $2 FOR UPDATE", [req.params.invoiceId, req.user.id])
      ).rows[0];
      if (!invoice) throw new HttpError(404, "Invoice not found");
      const payments = await client.query("SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1", [invoice.id]);
      if (payments.rows[0].n > 0) {
        throw new HttpError(
          409,
          "This invoice has payment records, so it can't be deleted. Cancel it instead to keep the financial history.",
          { code: "INVOICE_HAS_PAYMENTS" }
        );
      }
      await client.query("DELETE FROM invoice_items WHERE invoice_id = $1", [invoice.id]);
      await client.query("DELETE FROM invoices WHERE id = $1 AND user_id = $2", [invoice.id, req.user.id]);
      await logActivity(client, req.user.id, {
        entityType: "invoice",
        entityId: invoice.id,
        action: "deleted",
        summary: `${invoice.status === "draft" ? "Draft" : "Invoice"} ${invoice.invoice_number} deleted (${core.formatAmount(
          invoice.total,
          invoice.currency
        )})`,
        metadata: { invoice_number: invoice.invoice_number, total: invoice.total, status: invoice.status },
      });
    });
    res.status(204).end();
  })
);

router.get(
  "/invoices/:invoiceId/pdf",
  pdfLimiter,
  handle(async (req, res) => {
    const invoice = await fetchInvoice(req.user.id, req.params.invoiceId, req.today);
    if (!invoice) throw new HttpError(404, "Invoice not found");
    const assets = await loadAssetBuffers(req.user.id, req.business);
    const buffer = await renderInvoicePdf({ invoice, business: req.business, assets });
    const filename = `${safeFilename(invoice.invoice_number, "invoice")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename="${filename}"`);
    res.send(buffer);
  })
);

router.get(
  "/invoices/:invoiceId/upi-qr.svg",
  handle(async (req, res) => {
    const invoice = await fetchInvoice(req.user.id, req.params.invoiceId, req.today);
    if (!invoice) throw new HttpError(404, "Invoice not found");
    const balance = core.toUnits(invoice.balance_due);
    if (!req.business.upi_id || balance <= 0 || invoice.currency !== "INR") throw new HttpError(404, "No UPI payment due");
    const link = core.upiLink({
      upiId: req.business.upi_id,
      payeeName: invoice.supplier?.name || req.business.name,
      amountUnits: balance,
      note: invoice.invoice_number,
    });
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(qrSvg(link));
  })
);

function whatsappNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return "";
}

/** Prepare (not send) a payment reminder the user can copy, email or share. */
router.get(
  "/invoices/:invoiceId/reminder",
  handle(async (req, res) => {
    const invoice = await fetchInvoice(req.user.id, req.params.invoiceId, req.today);
    if (!invoice) throw new HttpError(404, "Invoice not found");
    const b = req.business;
    const currency = invoice.currency;
    const name = invoice.customer?.name || "there";
    const fmtDate = (iso) => {
      const [y, m, d] = iso.split("-").map(Number);
      return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
    };
    const dueText = invoice.due_date
      ? invoice.is_overdue
        ? `was due on ${fmtDate(invoice.due_date)} (${invoice.days_overdue} day${invoice.days_overdue === 1 ? "" : "s"} ago)`
        : `is due on ${fmtDate(invoice.due_date)}`
      : "is due";
    const payLines = [];
    if (b.upi_id) payLines.push(`UPI: ${b.upi_id}`);
    if (b.bank_account_number) {
      payLines.push(
        `Bank transfer: ${[b.bank_account_name, b.bank_name, `A/c ${b.bank_account_number}`, b.bank_ifsc && `IFSC ${b.bank_ifsc}`]
          .filter(Boolean)
          .join(", ")}`
      );
    }
    const subject = `Payment reminder: Invoice ${invoice.invoice_number} (${core.formatAmount(invoice.balance_due, currency)} due)`;
    const body = [
      `Dear ${name},`,
      "",
      `This is a friendly reminder that invoice ${invoice.invoice_number} dated ${fmtDate(invoice.issue_date)} for ${core.formatAmount(
        invoice.total,
        currency
      )} ${dueText}. The outstanding balance is ${core.formatAmount(invoice.balance_due, currency)}.`,
      ...(payLines.length ? ["", "You can pay using:", ...payLines] : []),
      "",
      "If you have already paid, please share the payment reference so we can update our records.",
      "",
      "Thank you,",
      b.name || "",
      b.phone || "",
    ]
      .join("\n")
      .trim();
    const email = invoice.customer?.email || "";
    const phone = invoice.customer?.phone || "";
    const wa = whatsappNumber(phone);
    res.json({
      subject,
      body,
      email,
      phone,
      mailto_url: email ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : "",
      whatsapp_url: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(body)}` : "",
    });
  })
);

module.exports = router;
