const express = require("express");
const { query } = require("../db");
const { handle, escapeLike } = require("../lib/http");
const { CUSTOMER_NAME_SQL, overdueSql } = require("../lib/invoices");

const router = express.Router();

/** Global search across invoices, customers and payment references (account-scoped). */
router.get(
  "/search",
  handle(async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 100);
    if (q.length < 2) return res.json({ invoices: [], customers: [], payments: [] });
    const like = `%${escapeLike(q)}%`;
    const overdue = overdueSql("i", "$3");
    const [invoices, customers, payments] = await Promise.all([
      query(
        `SELECT i.id, i.invoice_number, i.total, i.currency, i.issue_date,
           CASE WHEN ${overdue} THEN 'overdue' ELSE i.status END AS display_status,
           ${CUSTOMER_NAME_SQL} AS customer_name
         FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
         WHERE i.user_id = $1 AND (
           i.invoice_number ILIKE $2 OR ${CUSTOMER_NAME_SQL} ILIKE $2
           OR COALESCE(NULLIF(i.customer_snapshot->>'email', ''), c.email, '') ILIKE $2
           OR COALESCE(NULLIF(i.customer_snapshot->>'phone', ''), c.phone, '') ILIKE $2
         )
         ORDER BY (i.invoice_number ILIKE $2) DESC, i.issue_date DESC LIMIT 6`,
        [req.user.id, like, req.today]
      ),
      query(
        `SELECT id, name, company_name, email, phone, archived_at FROM customers
         WHERE user_id = $1 AND (name ILIKE $2 OR company_name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2 OR gst_number ILIKE $2)
         ORDER BY archived_at NULLS FIRST, lower(name) LIMIT 6`,
        [req.user.id, like]
      ),
      query(
        `SELECT p.id, p.receipt_number, p.transaction_id AS reference, p.amount, p.payment_date, p.invoice_id,
           i.invoice_number, i.currency
         FROM payments p JOIN invoices i ON i.id = p.invoice_id AND i.user_id = p.user_id
         WHERE p.user_id = $1 AND (p.transaction_id ILIKE $2 OR p.receipt_number ILIKE $2)
         ORDER BY p.payment_date DESC LIMIT 4`,
        [req.user.id, like]
      ),
    ]);
    res.json({ invoices: invoices.rows, customers: customers.rows, payments: payments.rows });
  })
);

router.get(
  "/activity",
  handle(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
    const result = await query(
      `SELECT id, entity_type, entity_id, action, summary, created_at FROM activity_logs
       WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
       ORDER BY created_at DESC LIMIT $3`,
      [req.user.id, before, limit]
    );
    res.json(result.rows);
  })
);

module.exports = router;
