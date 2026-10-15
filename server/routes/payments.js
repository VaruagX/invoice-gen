const express = require("express");
const core = require("../../shared/invoice-core");
const { query } = require("../db");
const { handle, HttpError, uuidParam, parsePagination, escapeLike, isUuid, safeFilename } = require("../lib/http");
const { recordPayment, voidPayment, METHODS } = require("../lib/payments");
const { fetchInvoice, CUSTOMER_NAME_SQL } = require("../lib/invoices");
const { loadAssetBuffers } = require("../lib/business");
const { renderReceiptPdf } = require("../lib/pdf/receipt-pdf");
const { rateLimit } = require("../middleware/security");

const router = express.Router();
router.param("invoiceId", uuidParam("Invoice"));
router.param("paymentId", uuidParam("Payment"));

const pdfLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, keyPrefix: "receipt", message: "Too many downloads. Please wait a moment." });

const PAYMENT_COLUMNS = `
  p.id, p.receipt_number, p.amount, p.method, p.transaction_id AS reference, p.notes, p.payment_date, p.source,
  p.voided_at, p.void_reason, p.created_at, p.invoice_id, i.invoice_number, i.currency, i.issue_date,
  i.total AS invoice_total, i.paid_total AS invoice_paid_total, i.customer_id,
  ${CUSTOMER_NAME_SQL} AS customer_name,
  COALESCE(NULLIF(i.customer_snapshot->>'company_name', ''), c.company_name, '') AS customer_company`;

const PAYMENT_FROM = `FROM payments p
  JOIN invoices i ON i.id = p.invoice_id AND i.user_id = p.user_id
  LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id`;

router.get(
  "/payments",
  handle(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const params = [req.user.id];
    const where = ["p.user_id = $1"];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (req.query.include_voided !== "1") where.push("p.voided_at IS NULL");
    if (METHODS.includes(req.query.method)) where.push(`p.method = ${add(req.query.method)}`);
    if (core.isIsoDate(req.query.from)) where.push(`p.payment_date >= ${add(req.query.from)}::date`);
    if (core.isIsoDate(req.query.to)) where.push(`p.payment_date <= ${add(req.query.to)}::date`);
    if (req.query.customer_id && isUuid(req.query.customer_id)) where.push(`i.customer_id = ${add(req.query.customer_id)}`);
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) {
      const p = add(`%${escapeLike(search)}%`);
      where.push(`(i.invoice_number ILIKE ${p} OR ${CUSTOMER_NAME_SQL} ILIKE ${p} OR p.transaction_id ILIKE ${p} OR p.receipt_number ILIKE ${p})`);
    }
    const [rows, summary] = await Promise.all([
      query(
        `SELECT ${PAYMENT_COLUMNS} ${PAYMENT_FROM} WHERE ${where.join(" AND ")}
         ORDER BY p.payment_date DESC, p.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
        params
      ),
      query(
        `SELECT count(*)::int AS count, COALESCE(sum(p.amount) FILTER (WHERE p.voided_at IS NULL), 0) AS amount
         ${PAYMENT_FROM} WHERE ${where.join(" AND ")}`,
        params
      ),
    ]);
    res.json({ items: rows.rows, total: summary.rows[0].count, amount: summary.rows[0].amount, page, page_size: pageSize });
  })
);

/** Issued invoices with a balance, for the "Record payment" picker. */
router.get(
  "/payments/open-invoices",
  handle(async (req, res) => {
    const params = [req.user.id];
    let filter = "";
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) {
      params.push(`%${escapeLike(search)}%`);
      filter = `AND (i.invoice_number ILIKE $2 OR ${CUSTOMER_NAME_SQL} ILIKE $2)`;
    }
    const result = await query(
      `SELECT i.id, i.invoice_number, i.currency, i.total, i.paid_total, (i.total - i.paid_total) AS balance_due, i.due_date,
         ${CUSTOMER_NAME_SQL} AS customer_name
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
       WHERE i.user_id = $1 AND i.status IN ('unpaid', 'partially_paid') ${filter}
       ORDER BY i.due_date NULLS LAST, i.issue_date LIMIT 50`,
      params
    );
    res.json(result.rows);
  })
);

router.get(
  "/invoices/:invoiceId/payments",
  handle(async (req, res) => {
    const invoice = await fetchInvoice(req.user.id, req.params.invoiceId, req.today);
    if (!invoice) throw new HttpError(404, "Invoice not found");
    res.json(invoice.payments);
  })
);

router.post(
  "/invoices/:invoiceId/payments",
  handle(async (req, res) => {
    const result = await recordPayment({
      userId: req.user.id,
      business: req.business,
      invoiceId: req.params.invoiceId,
      body: req.body || {},
      today: req.today,
    });
    res.status(201).json({ payment_id: result.paymentId, invoice: await fetchInvoice(req.user.id, req.params.invoiceId, req.today) });
  })
);

/** "Mark as paid" records a payment for the full balance, with method and date supplied by the user. */
router.post(
  "/invoices/:invoiceId/mark-paid",
  handle(async (req, res) => {
    const invoice = await fetchInvoice(req.user.id, req.params.invoiceId, req.today);
    if (!invoice) throw new HttpError(404, "Invoice not found");
    const body = Object.assign({}, req.body || {}, { amount: invoice.balance_due });
    const result = await recordPayment({
      userId: req.user.id,
      business: req.business,
      invoiceId: invoice.id,
      body,
      today: req.today,
    });
    res.status(201).json({ payment_id: result.paymentId, invoice: await fetchInvoice(req.user.id, invoice.id, req.today) });
  })
);

router.post(
  "/payments/:paymentId/void",
  handle(async (req, res) => {
    const result = await voidPayment({ userId: req.user.id, paymentId: req.params.paymentId, reason: req.body?.reason });
    res.json({ invoice: await fetchInvoice(req.user.id, result.invoiceId, req.today) });
  })
);

router.get(
  "/payments/:paymentId/receipt",
  pdfLimiter,
  handle(async (req, res) => {
    const result = await query(`SELECT ${PAYMENT_COLUMNS} ${PAYMENT_FROM} WHERE p.id = $1 AND p.user_id = $2`, [
      req.params.paymentId,
      req.user.id,
    ]);
    const payment = result.rows[0];
    if (!payment) throw new HttpError(404, "Payment not found");
    const assets = await loadAssetBuffers(req.user.id, req.business);
    const buffer = await renderReceiptPdf({ payment, business: req.business, assets });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader(
      "Content-Disposition",
      `${req.query.inline ? "inline" : "attachment"}; filename="${safeFilename(payment.receipt_number || "receipt", "receipt")}.pdf"`
    );
    res.send(buffer);
  })
);

module.exports = router;
