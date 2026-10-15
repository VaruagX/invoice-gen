const express = require("express");
const core = require("../../shared/invoice-core");
const { query, withTransaction } = require("../db");
const { handle, HttpError, badRequest, uuidParam, parsePagination, escapeLike } = require("../lib/http");
const { rules, validateBody } = require("../lib/validate");
const { logActivity } = require("../lib/activity");
const { overdueSql } = require("../lib/invoices");

const router = express.Router();
router.param("customerId", uuidParam("Customer"));

const CUSTOMER_SCHEMA = {
  name: ["Customer name", rules.text(120, { required: true })],
  company_name: ["Company name", rules.text(160)],
  email: ["Email", rules.email()],
  phone: ["Phone", rules.phone()],
  gst_number: ["GSTIN", rules.gstin()],
  pan: ["PAN", rules.pan()],
  address: ["Billing address", rules.text(500)],
  shipping_address: ["Shipping address", rules.text(500)],
  city: ["City", rules.text(80)],
  state_code: ["State", rules.stateCode()],
  postal_code: ["PIN code", rules.text(12)],
  country: ["Country", rules.text(80)],
  notes: ["Notes", rules.text(2000)],
};

const CUSTOMER_COLUMNS = `c.id, c.name, c.company_name, c.email, c.phone, c.gst_number, c.pan, c.address,
  c.shipping_address, c.city, c.state, c.state_code, c.postal_code, c.country, c.notes, c.archived_at,
  c.created_at, c.updated_at`;

function statsJoin(todayParam) {
  const overdue = overdueSql("i", todayParam);
  return `LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS invoice_count,
      count(*) FILTER (WHERE i.status NOT IN ('draft', 'cancelled'))::int AS issued_count,
      COALESCE(sum(i.total) FILTER (WHERE i.status NOT IN ('draft', 'cancelled')), 0) AS total_invoiced,
      COALESCE(sum(i.paid_total) FILTER (WHERE i.status <> 'cancelled'), 0) AS total_paid,
      COALESCE(sum(i.total - i.paid_total) FILTER (WHERE i.status IN ('unpaid', 'partially_paid')), 0) AS outstanding,
      count(*) FILTER (WHERE ${overdue})::int AS overdue_count,
      COALESCE(sum(i.total - i.paid_total) FILTER (WHERE ${overdue}), 0) AS overdue_amount,
      max(i.issue_date) FILTER (WHERE i.status <> 'draft') AS last_invoice_date
    FROM invoices i WHERE i.customer_id = c.id AND i.user_id = c.user_id
  ) s ON true`;
}

function cleanCustomer(body) {
  const value = validateBody(body, CUSTOMER_SCHEMA);
  const errors = [];
  if (value.gst_number) {
    const gstState = value.gst_number.slice(0, 2);
    if (!value.state_code && core.stateByCode(gstState)) value.state_code = gstState;
    else if (value.state_code && value.state_code !== gstState) {
      errors.push({ field: "state_code", message: `This GSTIN is registered in state code ${gstState}; the selected state is different.` });
    }
  }
  if (errors.length) throw badRequest(errors);
  value.state = value.state_code ? core.stateByCode(value.state_code).name : String(body.state || "").trim().slice(0, 80);
  return value;
}

async function findDuplicates(userId, value, excludeId) {
  const result = await query(
    `SELECT id, name, company_name, email, phone, gst_number FROM customers
     WHERE user_id = $1 AND archived_at IS NULL AND ($5::uuid IS NULL OR id <> $5::uuid)
       AND ((lower(name) = lower($2))
         OR ($3 <> '' AND lower(email) = lower($3))
         OR ($4 <> '' AND upper(gst_number) = $4))
     LIMIT 5`,
    [userId, value.name, value.email, value.gst_number, excludeId || null]
  );
  return result.rows;
}

router.get(
  "/customers",
  handle(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const params = [req.user.id, req.today];
    const where = ["c.user_id = $1"];
    const filter = String(req.query.filter || "active");
    if (filter === "archived") where.push("c.archived_at IS NOT NULL");
    else if (filter !== "all") where.push("c.archived_at IS NULL");
    if (filter === "outstanding") where.push("s.outstanding > 0");
    if (filter === "overdue") where.push("s.overdue_count > 0");
    if (filter === "gst") where.push("c.gst_number <> ''");
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) {
      params.push(`%${escapeLike(search)}%`);
      const p = `$${params.length}`;
      where.push(`(c.name ILIKE ${p} OR c.company_name ILIKE ${p} OR c.email ILIKE ${p} OR c.phone ILIKE ${p} OR c.gst_number ILIKE ${p})`);
    }
    const sorts = {
      name: "lower(c.name) ASC",
      recent: "c.created_at DESC",
      outstanding: "s.outstanding DESC, lower(c.name) ASC",
      invoiced: "s.total_invoiced DESC, lower(c.name) ASC",
    };
    const order = sorts[req.query.sort] || sorts.name;
    const result = await query(
      `SELECT ${CUSTOMER_COLUMNS}, s.*, count(*) OVER() AS full_count
       FROM customers c ${statsJoin("$2")}
       WHERE ${where.join(" AND ")}
       ORDER BY ${order}, c.id
       LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );
    res.json({
      items: result.rows.map(({ full_count, ...row }) => row),
      total: Number(result.rows[0]?.full_count || 0),
      page,
      page_size: pageSize,
    });
  })
);

/** Lightweight list for pickers (invoice editor, payment dialog). */
router.get(
  "/customers/options",
  handle(async (req, res) => {
    const search = String(req.query.search || "").trim().slice(0, 100);
    const params = [req.user.id];
    let filter = "";
    if (search) {
      params.push(`%${escapeLike(search)}%`);
      filter = `AND (name ILIKE $2 OR company_name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)`;
    }
    const result = await query(
      `SELECT id, name, company_name, email, phone, gst_number, state_code
       FROM customers WHERE user_id = $1 AND archived_at IS NULL ${filter}
       ORDER BY lower(name) LIMIT 1000`,
      params
    );
    res.json(result.rows);
  })
);

router.post(
  "/customers",
  handle(async (req, res) => {
    const value = cleanCustomer(req.body);
    if (!req.body.allow_duplicate) {
      const duplicates = await findDuplicates(req.user.id, value, null);
      if (duplicates.length) {
        throw new HttpError(409, "A similar customer already exists.", { code: "DUPLICATE_CUSTOMER", duplicates });
      }
    }
    const id = await withTransaction(async (client) => {
      const columns = Object.keys(value);
      const inserted = await client.query(
        `INSERT INTO customers (user_id, business_id, ${columns.join(", ")})
         VALUES ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(", ")}) RETURNING id`,
        [req.user.id, req.business.id, ...columns.map((column) => value[column])]
      );
      await logActivity(client, req.user.id, {
        entityType: "customer",
        entityId: inserted.rows[0].id,
        action: "created",
        summary: `Customer ${value.name} added`,
      });
      return inserted.rows[0].id;
    });
    res.status(201).json(await loadCustomer(req.user.id, id, req.today));
  })
);

async function loadCustomer(userId, id, today) {
  const result = await query(
    `SELECT ${CUSTOMER_COLUMNS}, s.* FROM customers c ${statsJoin("$3")} WHERE c.id = $1 AND c.user_id = $2`,
    [id, userId, today]
  );
  return result.rows[0] || null;
}

router.get(
  "/customers/:customerId",
  handle(async (req, res) => {
    const customer = await loadCustomer(req.user.id, req.params.customerId, req.today);
    if (!customer) throw new HttpError(404, "Customer not found");
    const activity = await query(
      `SELECT a.id, a.action, a.summary, a.created_at FROM activity_logs a
       WHERE a.user_id = $1 AND (
         (a.entity_type = 'customer' AND a.entity_id = $2)
         OR (a.entity_type = 'invoice' AND a.entity_id IN (SELECT id FROM invoices WHERE customer_id = $2 AND user_id = $1))
       )
       ORDER BY a.created_at DESC LIMIT 12`,
      [req.user.id, req.params.customerId]
    );
    res.json(Object.assign(customer, { activity: activity.rows }));
  })
);

router.put(
  "/customers/:customerId",
  handle(async (req, res) => {
    const value = cleanCustomer(req.body);
    if (!req.body.allow_duplicate) {
      const duplicates = await findDuplicates(req.user.id, value, req.params.customerId);
      if (duplicates.length) {
        throw new HttpError(409, "A similar customer already exists.", { code: "DUPLICATE_CUSTOMER", duplicates });
      }
    }
    await withTransaction(async (client) => {
      const columns = Object.keys(value);
      const updated = await client.query(
        `UPDATE customers SET ${columns.map((column, i) => `${column} = $${i + 1}`).join(", ")}, updated_at = now()
         WHERE id = $${columns.length + 1} AND user_id = $${columns.length + 2} RETURNING id`,
        [...columns.map((column) => value[column]), req.params.customerId, req.user.id]
      );
      if (!updated.rows[0]) throw new HttpError(404, "Customer not found");
      await logActivity(client, req.user.id, {
        entityType: "customer",
        entityId: req.params.customerId,
        action: "updated",
        summary: `Customer ${value.name} updated`,
      });
    });
    res.json(await loadCustomer(req.user.id, req.params.customerId, req.today));
  })
);

async function setArchived(req, res, archived) {
  await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE customers SET archived_at = ${archived ? "now()" : "NULL"}, updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING name`,
      [req.params.customerId, req.user.id]
    );
    if (!updated.rows[0]) throw new HttpError(404, "Customer not found");
    await logActivity(client, req.user.id, {
      entityType: "customer",
      entityId: req.params.customerId,
      action: archived ? "archived" : "restored",
      summary: `Customer ${updated.rows[0].name} ${archived ? "archived" : "restored"}`,
    });
  });
  res.json(await loadCustomer(req.user.id, req.params.customerId, req.today));
}

router.post("/customers/:customerId/archive", handle((req, res) => setArchived(req, res, true)));
router.post("/customers/:customerId/restore", handle((req, res) => setArchived(req, res, false)));

router.delete(
  "/customers/:customerId",
  handle(async (req, res) => {
    await withTransaction(async (client) => {
      const customer = (
        await client.query("SELECT id, name FROM customers WHERE id = $1 AND user_id = $2 FOR UPDATE", [
          req.params.customerId,
          req.user.id,
        ])
      ).rows[0];
      if (!customer) throw new HttpError(404, "Customer not found");
      const invoices = await client.query("SELECT count(*)::int AS n FROM invoices WHERE customer_id = $1 AND user_id = $2", [
        customer.id,
        req.user.id,
      ]);
      if (invoices.rows[0].n > 0) {
        throw new HttpError(
          409,
          `${customer.name} has ${invoices.rows[0].n} invoice${invoices.rows[0].n === 1 ? "" : "s"} and can't be deleted. Archive the customer instead to hide them while keeping their history.`,
          { code: "CUSTOMER_HAS_INVOICES" }
        );
      }
      await client.query("DELETE FROM customers WHERE id = $1 AND user_id = $2", [customer.id, req.user.id]);
      await logActivity(client, req.user.id, {
        entityType: "customer",
        entityId: null,
        action: "deleted",
        summary: `Customer ${customer.name} deleted`,
      });
    });
    res.status(204).end();
  })
);

module.exports = router;
