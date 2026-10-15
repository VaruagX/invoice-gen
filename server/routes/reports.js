const express = require("express");
const core = require("../../shared/invoice-core");
const { query } = require("../db");
const { handle, HttpError, badRequest, escapeLike, safeFilename } = require("../lib/http");
const { overdueSql, CUSTOMER_NAME_SQL } = require("../lib/invoices");
const { toCsv } = require("../lib/csv");
const { renderReportPdf } = require("../lib/pdf/report-pdf");
const { rateLimit } = require("../middleware/security");

const router = express.Router();
const exportLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, keyPrefix: "report", message: "Too many report exports. Please wait a moment." });

const FROM_INVOICES = "FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id";

function sumColumn(rows, key) {
  return core.unitsToString(rows.reduce((sum, row) => sum + core.toUnits(row[key]), 0));
}

function totalsFor(rows, keys) {
  return Object.fromEntries(keys.map((key) => [key, sumColumn(rows, key)]));
}

/** Optional text search on invoice number / customer; returns SQL and pushes the parameter. */
function searchClause(search, params) {
  if (!search) return "";
  params.push(`%${escapeLike(search)}%`);
  const p = `$${params.length}`;
  return ` AND (i.invoice_number ILIKE ${p} OR ${CUSTOMER_NAME_SQL} ILIKE ${p})`;
}

const REPORTS = {
  revenue: {
    title: "Revenue report",
    note: "Invoiced = invoices issued in the month (excluding drafts and cancelled). Collected = payments recorded in the month, whichever month the invoice was issued.",
    columns: [
      { key: "month", label: "Month", type: "text" },
      { key: "invoices", label: "Invoices issued", type: "number" },
      { key: "invoiced", label: "Invoiced", type: "money" },
      { key: "collected", label: "Collected", type: "money" },
      { key: "outstanding", label: "Still unpaid from month", type: "money" },
    ],
    async run({ userId, from, to }) {
      const result = await query(
        `WITH months AS (
           SELECT generate_series(date_trunc('month', $2::date), $3::date, '1 month')::date AS m
         ), inv AS (
           SELECT date_trunc('month', issue_date)::date AS m, count(*)::int AS invoices, sum(total) AS invoiced,
             sum(total - paid_total) FILTER (WHERE status IN ('unpaid', 'partially_paid')) AS outstanding
           FROM invoices WHERE user_id = $1 AND status NOT IN ('draft', 'cancelled') AND issue_date BETWEEN $2::date AND $3::date
           GROUP BY 1
         ), pay AS (
           SELECT date_trunc('month', payment_date)::date AS m, sum(amount) AS collected
           FROM payments WHERE user_id = $1 AND voided_at IS NULL AND payment_date BETWEEN $2::date AND $3::date
           GROUP BY 1
         )
         SELECT to_char(months.m, 'Mon YYYY') AS month, COALESCE(inv.invoices, 0) AS invoices,
           COALESCE(inv.invoiced, 0) AS invoiced, COALESCE(pay.collected, 0) AS collected,
           COALESCE(inv.outstanding, 0) AS outstanding
         FROM months LEFT JOIN inv USING (m) LEFT JOIN pay USING (m) ORDER BY months.m`,
        [userId, from, to]
      );
      const rows = result.rows;
      return {
        rows,
        totals: Object.assign(totalsFor(rows, ["invoiced", "collected", "outstanding"]), {
          invoices: rows.reduce((sum, row) => sum + row.invoices, 0),
        }),
      };
    },
  },

  "paid-invoices": {
    title: "Paid invoices",
    note: "Invoices issued in the period that are fully paid.",
    columns: [
      { key: "invoice_number", label: "Invoice", type: "text" },
      { key: "customer", label: "Customer", type: "text" },
      { key: "issue_date", label: "Issued", type: "date" },
      { key: "last_payment", label: "Last payment", type: "date" },
      { key: "total", label: "Amount", type: "money" },
    ],
    async run({ userId, from, to, search }) {
      const params = [userId, from, to];
      const result = await query(
        `SELECT i.invoice_number, ${CUSTOMER_NAME_SQL} AS customer, i.issue_date, i.total,
           (SELECT max(payment_date) FROM payments p WHERE p.invoice_id = i.id AND p.voided_at IS NULL) AS last_payment
         ${FROM_INVOICES}
         WHERE i.user_id = $1 AND i.status = 'paid' AND i.issue_date BETWEEN $2::date AND $3::date${searchClause(search, params)}
         ORDER BY i.issue_date, i.invoice_number`,
        params
      );
      return { rows: result.rows, totals: totalsFor(result.rows, ["total"]) };
    },
  },

  outstanding: {
    title: "Outstanding invoices",
    note: "All issued invoices with a balance due as of today, regardless of the selected dates.",
    ignoresRange: true,
    columns: [
      { key: "invoice_number", label: "Invoice", type: "text" },
      { key: "customer", label: "Customer", type: "text" },
      { key: "issue_date", label: "Issued", type: "date" },
      { key: "due_date", label: "Due", type: "date" },
      { key: "total", label: "Total", type: "money" },
      { key: "paid", label: "Paid", type: "money" },
      { key: "balance", label: "Balance", type: "money" },
      { key: "days_overdue", label: "Days overdue", type: "number" },
    ],
    async run({ userId, today, search }) {
      const params = [userId, today];
      const overdue = overdueSql("i", "$2");
      const result = await query(
        `SELECT i.invoice_number, ${CUSTOMER_NAME_SQL} AS customer, i.issue_date, i.due_date, i.total,
           i.paid_total AS paid, (i.total - i.paid_total) AS balance,
           CASE WHEN ${overdue} THEN ($2::date - i.due_date) ELSE 0 END AS days_overdue
         ${FROM_INVOICES}
         WHERE i.user_id = $1 AND i.status IN ('unpaid', 'partially_paid')${searchClause(search, params)}
         ORDER BY i.due_date NULLS LAST, i.issue_date`,
        params
      );
      return { rows: result.rows, totals: totalsFor(result.rows, ["total", "paid", "balance"]) };
    },
  },

  overdue: {
    title: "Overdue invoices",
    note: "Issued invoices past their due date with a balance remaining, as of today.",
    ignoresRange: true,
    columns: [
      { key: "invoice_number", label: "Invoice", type: "text" },
      { key: "customer", label: "Customer", type: "text" },
      { key: "contact", label: "Contact", type: "text" },
      { key: "due_date", label: "Due", type: "date" },
      { key: "days_overdue", label: "Days overdue", type: "number" },
      { key: "balance", label: "Balance", type: "money" },
    ],
    async run({ userId, today, search }) {
      const params = [userId, today];
      const result = await query(
        `SELECT i.invoice_number, ${CUSTOMER_NAME_SQL} AS customer,
           concat_ws(' · ', NULLIF(COALESCE(NULLIF(i.customer_snapshot->>'phone', ''), c.phone, ''), ''),
                            NULLIF(COALESCE(NULLIF(i.customer_snapshot->>'email', ''), c.email, ''), '')) AS contact,
           i.due_date, ($2::date - i.due_date) AS days_overdue, (i.total - i.paid_total) AS balance
         ${FROM_INVOICES}
         WHERE i.user_id = $1 AND ${overdueSql("i", "$2")}${searchClause(search, params)}
         ORDER BY ($2::date - i.due_date) DESC`,
        params
      );
      return { rows: result.rows, totals: totalsFor(result.rows, ["balance"]) };
    },
  },

  "customer-revenue": {
    title: "Customer-wise revenue",
    note: "Invoiced = invoices issued in the period. Collected = payments recorded in the period. Outstanding = current balance on all their invoices.",
    columns: [
      { key: "customer", label: "Customer", type: "text" },
      { key: "invoices", label: "Invoices", type: "number" },
      { key: "invoiced", label: "Invoiced", type: "money" },
      { key: "collected", label: "Collected", type: "money" },
      { key: "outstanding", label: "Outstanding", type: "money" },
    ],
    async run({ userId, from, to, search }) {
      const params = [userId, from, to];
      let filter = "";
      if (search) {
        params.push(`%${escapeLike(search)}%`);
        filter = ` AND (c.name ILIKE $4 OR c.company_name ILIKE $4)`;
      }
      const result = await query(
        `SELECT c.name || CASE WHEN c.company_name <> '' THEN ' (' || c.company_name || ')' ELSE '' END AS customer,
           COALESCE(inv.invoices, 0) AS invoices, COALESCE(inv.invoiced, 0) AS invoiced,
           COALESCE(pay.collected, 0) AS collected, COALESCE(open.outstanding, 0) AS outstanding
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS invoices, sum(total) AS invoiced FROM invoices i
           WHERE i.customer_id = c.id AND i.user_id = $1 AND i.status NOT IN ('draft', 'cancelled')
             AND i.issue_date BETWEEN $2::date AND $3::date
         ) inv ON true
         LEFT JOIN LATERAL (
           SELECT sum(p.amount) AS collected FROM payments p JOIN invoices i ON i.id = p.invoice_id
           WHERE i.customer_id = c.id AND p.user_id = $1 AND p.voided_at IS NULL AND p.payment_date BETWEEN $2::date AND $3::date
         ) pay ON true
         LEFT JOIN LATERAL (
           SELECT sum(total - paid_total) AS outstanding FROM invoices i
           WHERE i.customer_id = c.id AND i.user_id = $1 AND i.status IN ('unpaid', 'partially_paid')
         ) open ON true
         WHERE c.user_id = $1${filter}
           AND (COALESCE(inv.invoices, 0) > 0 OR COALESCE(pay.collected, 0) > 0 OR COALESCE(open.outstanding, 0) > 0)
         ORDER BY COALESCE(inv.invoiced, 0) DESC, lower(c.name)`,
        params
      );
      return {
        rows: result.rows,
        totals: Object.assign(totalsFor(result.rows, ["invoiced", "collected", "outstanding"]), {
          invoices: result.rows.reduce((sum, row) => sum + row.invoices, 0),
        }),
      };
    },
  },

  "monthly-summary": {
    title: "Monthly invoice summary",
    note: "Invoices by month of issue. Cancelled invoices are counted separately and excluded from amounts.",
    columns: [
      { key: "month", label: "Month", type: "text" },
      { key: "issued", label: "Issued", type: "number" },
      { key: "paid", label: "Fully paid", type: "number" },
      { key: "cancelled", label: "Cancelled", type: "number" },
      { key: "discounts", label: "Discounts", type: "money" },
      { key: "taxable", label: "Taxable value", type: "money" },
      { key: "tax", label: "Tax", type: "money" },
      { key: "total", label: "Invoice total", type: "money" },
    ],
    async run({ userId, from, to }) {
      const result = await query(
        `WITH months AS (
           SELECT generate_series(date_trunc('month', $2::date), $3::date, '1 month')::date AS m
         ), inv AS (
           SELECT date_trunc('month', issue_date)::date AS m,
             count(*) FILTER (WHERE status NOT IN ('draft', 'cancelled'))::int AS issued,
             count(*) FILTER (WHERE status = 'paid')::int AS paid,
             count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
             COALESCE(sum(discount_total) FILTER (WHERE status NOT IN ('draft', 'cancelled')), 0) AS discounts,
             COALESCE(sum(taxable_total) FILTER (WHERE status NOT IN ('draft', 'cancelled')), 0) AS taxable,
             COALESCE(sum(tax_total) FILTER (WHERE status NOT IN ('draft', 'cancelled')), 0) AS tax,
             COALESCE(sum(total) FILTER (WHERE status NOT IN ('draft', 'cancelled')), 0) AS total
           FROM invoices WHERE user_id = $1 AND issue_date BETWEEN $2::date AND $3::date
           GROUP BY 1
         )
         SELECT to_char(months.m, 'Mon YYYY') AS month, COALESCE(issued, 0) AS issued, COALESCE(paid, 0) AS paid,
           COALESCE(cancelled, 0) AS cancelled, COALESCE(discounts, 0) AS discounts, COALESCE(taxable, 0) AS taxable,
           COALESCE(tax, 0) AS tax, COALESCE(total, 0) AS total
         FROM months LEFT JOIN inv USING (m) ORDER BY months.m`,
        [userId, from, to]
      );
      const rows = result.rows;
      const count = (key) => rows.reduce((sum, row) => sum + row[key], 0);
      return {
        rows,
        totals: Object.assign(totalsFor(rows, ["discounts", "taxable", "tax", "total"]), {
          issued: count("issued"),
          paid: count("paid"),
          cancelled: count("cancelled"),
        }),
      };
    },
  },

  payments: {
    title: "Payment history",
    note: "Payments recorded in the period (voided payments excluded). Payment tracking is a record of money received, not a payment gateway.",
    columns: [
      { key: "payment_date", label: "Date", type: "date" },
      { key: "receipt_number", label: "Receipt", type: "text" },
      { key: "invoice_number", label: "Invoice", type: "text" },
      { key: "customer", label: "Customer", type: "text" },
      { key: "method", label: "Method", type: "text" },
      { key: "reference", label: "Reference", type: "text" },
      { key: "amount", label: "Amount", type: "money" },
    ],
    async run({ userId, from, to, search }) {
      const params = [userId, from, to];
      let filter = "";
      if (search) {
        params.push(`%${escapeLike(search)}%`);
        filter = ` AND (i.invoice_number ILIKE $4 OR ${CUSTOMER_NAME_SQL} ILIKE $4 OR p.transaction_id ILIKE $4 OR p.receipt_number ILIKE $4)`;
      }
      const result = await query(
        `SELECT p.payment_date, p.receipt_number, i.invoice_number, ${CUSTOMER_NAME_SQL} AS customer, p.method,
           p.transaction_id AS reference, p.amount
         FROM payments p JOIN invoices i ON i.id = p.invoice_id AND i.user_id = p.user_id
         LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
         WHERE p.user_id = $1 AND p.voided_at IS NULL AND p.payment_date BETWEEN $2::date AND $3::date${filter}
         ORDER BY p.payment_date, p.created_at`,
        params
      );
      const rows = result.rows.map((row) => Object.assign(row, { method: core.paymentMethodLabel(row.method) }));
      return { rows, totals: totalsFor(rows, ["amount"]) };
    },
  },

  "tax-summary": {
    title: "Tax summary",
    note: "Summary of tax on invoices issued in the period (excluding drafts and cancelled), based on saved invoice data. This is not a GST return; please verify figures before filing.",
    columns: [
      { key: "tax_type", label: "Tax type", type: "text" },
      { key: "reverse_charge", label: "Reverse charge", type: "text" },
      { key: "rate", label: "Rate", type: "percent" },
      { key: "invoices", label: "Invoices", type: "number" },
      { key: "taxable", label: "Taxable value", type: "money" },
      { key: "cgst", label: "CGST", type: "money" },
      { key: "sgst", label: "SGST", type: "money" },
      { key: "igst", label: "IGST", type: "money" },
      { key: "other_tax", label: "Other tax", type: "money" },
      { key: "total_tax", label: "Total tax", type: "money" },
    ],
    async run({ userId, from, to, search }) {
      const params = [userId, from, to];
      const result = await query(
        `SELECT i.tax_type, i.reverse_charge, it.tax_rate AS rate, count(DISTINCT i.id)::int AS invoices,
           sum(it.taxable_amount) AS taxable, sum(it.cgst_amount) AS cgst, sum(it.sgst_amount) AS sgst,
           sum(it.igst_amount) AS igst,
           sum(CASE WHEN i.tax_type = 'simple' THEN it.tax_amount ELSE 0 END) AS other_tax,
           sum(it.tax_amount) AS total_tax
         FROM invoice_items it
         JOIN invoices i ON i.id = it.invoice_id
         LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
         WHERE i.user_id = $1 AND i.status NOT IN ('draft', 'cancelled') AND i.issue_date BETWEEN $2::date AND $3::date
           ${searchClause(search, params)}
         GROUP BY i.tax_type, i.reverse_charge, it.tax_rate
         ORDER BY i.tax_type, i.reverse_charge, it.tax_rate`,
        params
      );
      const rows = result.rows.map((row) =>
        Object.assign(row, {
          tax_type: core.taxTypeLabel(row.tax_type),
          reverse_charge: row.reverse_charge ? "Yes" : "No",
          rate: core.unitsToPlain(core.toUnits(row.rate)),
        })
      );
      return { rows, totals: totalsFor(rows, ["taxable", "cgst", "sgst", "igst", "other_tax", "total_tax"]) };
    },
  },
};

function defaultFrom(today) {
  // Start of the current Indian financial year (1 April).
  const year = Number(today.slice(0, 4));
  const start = Number(today.slice(5, 7)) >= 4 ? year : year - 1;
  return `${start}-04-01`;
}

router.get("/reports", (req, res) => {
  res.json(Object.entries(REPORTS).map(([key, report]) => ({ key, title: report.title, note: report.note, ignores_range: Boolean(report.ignoresRange) })));
});

router.get(
  "/reports/:type",
  (req, res, next) => (req.query.format === "csv" || req.query.format === "pdf" ? exportLimiter(req, res, next) : next()),
  handle(async (req, res) => {
    const definition = REPORTS[req.params.type];
    if (!definition) throw new HttpError(404, "Report not found");
    const from = core.isIsoDate(req.query.from) ? req.query.from : defaultFrom(req.today);
    const to = core.isIsoDate(req.query.to) ? req.query.to : req.today;
    if (from > to) throw badRequest([{ field: "to", message: "End date must be on or after the start date." }]);
    if (core.daysBetween(from, to) > 3660) throw badRequest([{ field: "from", message: "Choose a range of 10 years or less." }]);
    const search = String(req.query.search || "").trim().slice(0, 100);
    const result = await definition.run({ userId: req.user.id, from, to, today: req.today, search });
    const report = {
      key: req.params.type,
      title: definition.title,
      note: definition.note,
      columns: definition.columns,
      rows: result.rows,
      totals: result.totals,
      meta: {
        from: definition.ignoresRange ? null : from,
        to: definition.ignoresRange ? req.today : to,
        today: req.today,
        currency: req.business.currency || "INR",
        ignores_range: Boolean(definition.ignoresRange),
      },
    };
    const filename = safeFilename(`${req.params.type}-${definition.ignoresRange ? req.today : `${from}-to-${to}`}`, "report");
    if (req.query.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
      return res.send(toCsv(report.columns, report.rows, report.totals));
    }
    if (req.query.format === "pdf") {
      const buffer = await renderReportPdf({ report, business: req.business });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
      return res.send(buffer);
    }
    res.json(report);
  })
);

module.exports = router;
