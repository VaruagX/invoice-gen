const express = require("express");
const core = require("../../shared/invoice-core");
const { query } = require("../db");
const { handle, badRequest } = require("../lib/http");
const { listColumns, overdueSql, CUSTOMER_NAME_SQL } = require("../lib/invoices");

const router = express.Router();

function monthStart(iso, monthsBack) {
  const date = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - monthsBack);
  return date.toISOString().slice(0, 10);
}

/** Resolve the dashboard period and the equally long period before it. */
function resolvePeriod(q, today) {
  const range = ["7d", "30d", "3m", "6m", "12m", "custom"].includes(q.range) ? q.range : "30d";
  let from;
  let to = today;
  let bucket = "day";
  switch (range) {
    case "7d":
      from = core.addDays(today, -6);
      break;
    case "30d":
      from = core.addDays(today, -29);
      break;
    case "3m":
      from = monthStart(today, 2);
      bucket = "month";
      break;
    case "6m":
      from = monthStart(today, 5);
      bucket = "month";
      break;
    case "12m":
      from = monthStart(today, 11);
      bucket = "month";
      break;
    default: {
      if (!core.isIsoDate(q.from) || !core.isIsoDate(q.to)) {
        throw badRequest([{ field: "from", message: "Choose a valid start and end date." }]);
      }
      if (q.from > q.to) throw badRequest([{ field: "to", message: "End date must be on or after the start date." }]);
      if (core.daysBetween(q.from, q.to) > 3660) throw badRequest([{ field: "from", message: "Choose a range of 10 years or less." }]);
      from = q.from;
      to = q.to;
      bucket = core.daysBetween(from, to) <= 62 ? "day" : "month";
    }
  }
  const length = core.daysBetween(from, to) + 1;
  const previousTo = core.addDays(from, -1);
  const previousFrom = core.addDays(previousTo, -(length - 1));
  return { range, from, to, bucket, previous_from: previousFrom, previous_to: previousTo, days: length };
}

router.get(
  "/dashboard",
  handle(async (req, res) => {
    const userId = req.user.id;
    const today = req.today;
    const period = resolvePeriod(req.query, today);
    const overdue = overdueSql("i", "$2");
    const seriesStart = period.bucket === "month" ? `${period.from.slice(0, 7)}-01` : period.from;
    const twelveMonthsAgo = monthStart(today, 11);

    const [statusRows, previousRows, collected, current, series, recent, activity, topCustomers, bestMonths, daysToPay, anyInvoice] =
      await Promise.all([
        query(
          `SELECT CASE WHEN ${overdue} THEN 'overdue' ELSE i.status END AS status,
             count(*)::int AS count, COALESCE(sum(i.total), 0) AS amount, COALESCE(sum(i.total - i.paid_total), 0) AS balance
           FROM invoices i WHERE i.user_id = $1 AND i.issue_date BETWEEN $3::date AND $4::date
           GROUP BY 1`,
          [userId, today, period.from, period.to]
        ),
        query(
          `SELECT count(*)::int AS count, COALESCE(sum(total), 0) AS amount
           FROM invoices WHERE user_id = $1 AND status NOT IN ('draft', 'cancelled')
             AND issue_date BETWEEN $2::date AND $3::date`,
          [userId, period.previous_from, period.previous_to]
        ),
        query(
          `SELECT
             COALESCE(sum(amount) FILTER (WHERE payment_date BETWEEN $2::date AND $3::date), 0) AS collected,
             COALESCE(sum(amount) FILTER (WHERE payment_date BETWEEN $4::date AND $5::date), 0) AS previous_collected
           FROM payments WHERE user_id = $1 AND voided_at IS NULL AND payment_date BETWEEN $4::date AND $3::date`,
          [userId, period.from, period.to, period.previous_from, period.previous_to]
        ),
        query(
          `SELECT
             COALESCE(sum(i.total - i.paid_total) FILTER (WHERE i.status IN ('unpaid', 'partially_paid')), 0) AS outstanding,
             count(*) FILTER (WHERE i.status IN ('unpaid', 'partially_paid'))::int AS open_invoices,
             COALESCE(sum(i.total - i.paid_total) FILTER (WHERE ${overdue}), 0) AS overdue_amount,
             count(*) FILTER (WHERE ${overdue})::int AS overdue_invoices,
             max($2::date - i.due_date) FILTER (WHERE ${overdue}) AS oldest_overdue_days
           FROM invoices i WHERE i.user_id = $1`,
          [userId, today]
        ),
        query(
          `WITH buckets AS (
             SELECT generate_series($2::date, $3::date, ('1 ' || $4)::interval)::date AS bucket
           ), inv AS (
             SELECT date_trunc($4, issue_date)::date AS bucket, sum(total) AS invoiced, count(*)::int AS invoices
             FROM invoices WHERE user_id = $1 AND status NOT IN ('draft', 'cancelled')
               AND issue_date BETWEEN $5::date AND $3::date
             GROUP BY 1
           ), pay AS (
             SELECT date_trunc($4, payment_date)::date AS bucket, sum(amount) AS collected
             FROM payments WHERE user_id = $1 AND voided_at IS NULL AND payment_date BETWEEN $5::date AND $3::date
             GROUP BY 1
           )
           SELECT b.bucket, COALESCE(inv.invoiced, 0) AS invoiced, COALESCE(inv.invoices, 0) AS invoices,
             COALESCE(pay.collected, 0) AS collected
           FROM buckets b LEFT JOIN inv USING (bucket) LEFT JOIN pay USING (bucket)
           ORDER BY b.bucket`,
          [userId, seriesStart, period.to, period.bucket, period.from]
        ),
        query(
          `SELECT ${listColumns("$2")}
           FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
           WHERE i.user_id = $1 ORDER BY i.created_at DESC LIMIT 6`,
          [userId, today]
        ),
        query(
          `SELECT id, entity_type, entity_id, action, summary, created_at FROM activity_logs
           WHERE user_id = $1 ORDER BY created_at DESC LIMIT 8`,
          [userId]
        ),
        query(
          `SELECT i.customer_id, max(${CUSTOMER_NAME_SQL}) AS name, count(*)::int AS invoices,
             sum(i.total) AS invoiced, sum(i.paid_total) AS paid, sum(i.total - i.paid_total) AS outstanding
           FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
           WHERE i.user_id = $1 AND i.customer_id IS NOT NULL AND i.status NOT IN ('draft', 'cancelled')
             AND i.issue_date BETWEEN $2::date AND $3::date
           GROUP BY i.customer_id ORDER BY sum(i.total) DESC LIMIT 5`,
          [userId, period.from, period.to]
        ),
        query(
          `SELECT date_trunc('month', payment_date)::date AS month, sum(amount) AS collected
           FROM payments WHERE user_id = $1 AND voided_at IS NULL AND payment_date >= $2::date
           GROUP BY 1 ORDER BY sum(amount) DESC LIMIT 3`,
          [userId, twelveMonthsAgo]
        ),
        query(
          `SELECT round(avg(last_paid - issue_date))::int AS days, count(*)::int AS invoices FROM (
             SELECT i.issue_date, max(p.payment_date) AS last_paid
             FROM invoices i JOIN payments p ON p.invoice_id = i.id AND p.voided_at IS NULL AND p.source = 'manual'
             WHERE i.user_id = $1 AND i.status = 'paid' AND i.issue_date >= $2::date
             GROUP BY i.id, i.issue_date
           ) x`,
          [userId, twelveMonthsAgo]
        ),
        query("SELECT EXISTS (SELECT 1 FROM invoices WHERE user_id = $1) AS any", [userId]),
      ]);

    const byStatus = Object.fromEntries(statusRows.rows.map((row) => [row.status, row]));
    const count = (status) => byStatus[status]?.count || 0;
    const sumUnits = (statuses, field) => statuses.reduce((sum, status) => sum + core.toUnits(byStatus[status]?.[field]), 0);
    const issuedStatuses = ["unpaid", "partially_paid", "overdue", "paid"];
    const invoicedUnits = sumUnits(issuedStatuses, "amount");
    const issuedCount = issuedStatuses.reduce((sum, status) => sum + count(status), 0);

    res.json({
      period: Object.assign({ today }, period),
      has_data: anyInvoice.rows[0].any,
      cards: {
        total_invoices: issuedCount,
        previous_total_invoices: previousRows.rows[0].count,
        paid_invoices: count("paid"),
        unpaid_invoices: count("unpaid") + count("partially_paid") + count("overdue"),
        partially_paid_invoices: count("partially_paid"),
        draft_invoices: count("draft"),
        invoiced: core.unitsToString(invoicedUnits),
        previous_invoiced: previousRows.rows[0].amount,
        collected: collected.rows[0].collected,
        previous_collected: collected.rows[0].previous_collected,
        outstanding: current.rows[0].outstanding,
        open_invoices: current.rows[0].open_invoices,
        overdue_invoices: current.rows[0].overdue_invoices,
        overdue_amount: current.rows[0].overdue_amount,
      },
      series: series.rows,
      status_overview: ["draft", "unpaid", "partially_paid", "overdue", "paid", "cancelled"].map((status) => ({
        status,
        count: count(status),
        amount: byStatus[status]?.amount || "0.00",
        balance: byStatus[status]?.balance || "0.00",
      })),
      recent_invoices: recent.rows,
      recent_activity: activity.rows,
      insights: {
        top_customers: topCustomers.rows,
        best_months: bestMonths.rows,
        average_invoice: issuedCount ? core.unitsToString(Math.round(invoicedUnits / issuedCount)) : null,
        average_days_to_pay: daysToPay.rows[0].invoices ? daysToPay.rows[0].days : null,
        paid_invoices_measured: daysToPay.rows[0].invoices,
        outstanding: current.rows[0].outstanding,
        open_invoices: current.rows[0].open_invoices,
        oldest_overdue_days: current.rows[0].oldest_overdue_days,
      },
    });
  })
);

module.exports = router;
