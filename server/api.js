const express = require("express");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const path = require("path");
const { query } = require("./db");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "../uploads"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `logo-${req.user.id}-${Date.now()}${ext || ".png"}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image uploads are allowed."));
    }
    cb(null, true);
  },
});

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: "Authentication required" });
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeStatus(status) {
  const allowed = new Set(["draft", "pending", "paid", "overdue"]);
  return allowed.has(String(status).toLowerCase()) ? String(status).toLowerCase() : "draft";
}

function calculateItems(items = []) {
  let subtotal = 0;
  let taxTotal = 0;
  const normalized = items
    .filter((item) => String(item.description || "").trim())
    .map((item) => {
      const quantity = Math.max(toNumber(item.quantity), 0);
      const price = Math.max(toNumber(item.price), 0);
      const taxRate = Math.max(toNumber(item.tax_rate ?? item.taxRate), 0);
      const base = quantity * price;
      const tax = base * (taxRate / 100);
      subtotal += base;
      taxTotal += tax;
      return {
        description: String(item.description).trim(),
        quantity,
        price,
        tax_rate: taxRate,
        line_total: base + tax,
      };
    });

  return {
    items: normalized,
    subtotal,
    tax_total: taxTotal,
    total: subtotal + taxTotal,
  };
}

async function getBusinessId(userId) {
  const result = await query("SELECT id FROM businesses WHERE user_id = $1 LIMIT 1", [userId]);
  if (result.rows[0]) return result.rows[0].id;
  const created = await query(
    "INSERT INTO businesses (user_id) VALUES ($1) RETURNING id",
    [userId]
  );
  return created.rows[0].id;
}

async function getNextInvoiceNumber(userId) {
  const result = await query("SELECT COUNT(*)::int AS count FROM invoices WHERE user_id = $1", [userId]);
  const next = (result.rows[0]?.count || 0) + 1;
  return `INV-${new Date().getFullYear()}-${String(next).padStart(4, "0")}`;
}

async function fetchInvoice(userId, invoiceId) {
  const invoiceResult = await query(
    `
      SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
        c.gst_number AS customer_gst_number, c.address AS customer_address, c.city AS customer_city,
        c.state AS customer_state, c.postal_code AS customer_postal_code, c.country AS customer_country,
        b.name AS business_name, b.email AS business_email, b.phone AS business_phone,
        b.gst_number AS business_gst_number, b.address AS business_address, b.city AS business_city,
        b.state AS business_state, b.postal_code AS business_postal_code, b.country AS business_country,
        b.logo_url AS business_logo_url, b.website AS business_website, b.bank_details AS business_bank_details
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id
      LEFT JOIN businesses b ON b.id = i.business_id
      WHERE i.user_id = $1 AND i.id = $2
    `,
    [userId, invoiceId]
  );

  const invoice = invoiceResult.rows[0];
  if (!invoice) return null;

  const [items, payments] = await Promise.all([
    query("SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id", [invoiceId]),
    query("SELECT * FROM payments WHERE invoice_id = $1 ORDER BY paid_at DESC", [invoiceId]),
  ]);

  return { ...invoice, items: items.rows, payments: payments.rows };
}

router.use(requireAuth);

router.get("/auth/me", (req, res) => {
  res.json({ user: req.user });
});

router.get("/dashboard/stats", async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [stats, monthly, recent] = await Promise.all([
      query(
        `
          SELECT
            COUNT(*)::int AS total_invoices,
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_invoices,
            COUNT(*) FILTER (WHERE status IN ('pending', 'overdue'))::int AS pending_invoices,
            COALESCE(SUM(total) FILTER (WHERE status = 'paid'), 0)::float AS revenue,
            COALESCE(SUM(total), 0)::float AS billed
          FROM invoices
          WHERE user_id = $1
        `,
        [userId]
      ),
      query(
        `
          SELECT TO_CHAR(DATE_TRUNC('month', issue_date), 'Mon') AS month,
            COALESCE(SUM(total), 0)::float AS total
          FROM invoices
          WHERE user_id = $1 AND issue_date >= CURRENT_DATE - INTERVAL '11 months'
          GROUP BY DATE_TRUNC('month', issue_date)
          ORDER BY DATE_TRUNC('month', issue_date)
        `,
        [userId]
      ),
      query(
        `
          SELECT i.id, i.invoice_number, i.status, i.issue_date, i.due_date, i.total,
            c.name AS customer_name
          FROM invoices i
          LEFT JOIN customers c ON c.id = i.customer_id
          WHERE i.user_id = $1
          ORDER BY i.created_at DESC
          LIMIT 6
        `,
        [userId]
      ),
    ]);

    res.json({ stats: stats.rows[0], monthly: monthly.rows, recent: recent.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/business", async (req, res, next) => {
  try {
    await getBusinessId(req.user.id);
    const result = await query("SELECT * FROM businesses WHERE user_id = $1 LIMIT 1", [req.user.id]);
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.put("/business", async (req, res, next) => {
  try {
    const businessId = await getBusinessId(req.user.id);
    const body = req.body;
    const result = await query(
      `
        UPDATE businesses SET
          name = $1, gst_number = $2, email = $3, phone = $4, address = $5,
          city = $6, state = $7, postal_code = $8, country = $9, website = $10,
          bank_details = $11, terms = $12, updated_at = NOW()
        WHERE id = $13 AND user_id = $14
        RETURNING *
      `,
      [
        body.name || "",
        body.gst_number || "",
        body.email || "",
        body.phone || "",
        body.address || "",
        body.city || "",
        body.state || "",
        body.postal_code || "",
        body.country || "",
        body.website || "",
        body.bank_details || "",
        body.terms || "",
        businessId,
        req.user.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post("/business/logo", upload.single("logo"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Logo image is required" });
    const logoUrl = `/uploads/${req.file.filename}`;
    await getBusinessId(req.user.id);
    const result = await query(
      "UPDATE businesses SET logo_url = $1, updated_at = NOW() WHERE user_id = $2 RETURNING *",
      [logoUrl, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/customers", async (req, res, next) => {
  try {
    const search = `%${String(req.query.search || "").trim()}%`;
    const result = await query(
      `
        SELECT * FROM customers
        WHERE user_id = $1 AND ($2 = '%%' OR name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)
        ORDER BY created_at DESC
      `,
      [req.user.id, search]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post("/customers", async (req, res, next) => {
  try {
    if (!String(req.body.name || "").trim()) {
      return res.status(400).json({ error: "Customer name is required" });
    }
    const businessId = await getBusinessId(req.user.id);
    const result = await query(
      `
        INSERT INTO customers
          (user_id, business_id, name, email, phone, gst_number, address, city, state, postal_code, country)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `,
      [
        req.user.id,
        businessId,
        req.body.name.trim(),
        req.body.email || "",
        req.body.phone || "",
        req.body.gst_number || "",
        req.body.address || "",
        req.body.city || "",
        req.body.state || "",
        req.body.postal_code || "",
        req.body.country || "",
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.put("/customers/:id", async (req, res, next) => {
  try {
    if (!String(req.body.name || "").trim()) {
      return res.status(400).json({ error: "Customer name is required" });
    }
    const result = await query(
      `
        UPDATE customers SET
          name = $1, email = $2, phone = $3, gst_number = $4, address = $5,
          city = $6, state = $7, postal_code = $8, country = $9, updated_at = NOW()
        WHERE id = $10 AND user_id = $11
        RETURNING *
      `,
      [
        req.body.name.trim(),
        req.body.email || "",
        req.body.phone || "",
        req.body.gst_number || "",
        req.body.address || "",
        req.body.city || "",
        req.body.state || "",
        req.body.postal_code || "",
        req.body.country || "",
        req.params.id,
        req.user.id,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Customer not found" });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.delete("/customers/:id", async (req, res, next) => {
  try {
    await query("DELETE FROM customers WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get("/invoices/next-number", async (req, res, next) => {
  try {
    res.json({ invoice_number: await getNextInvoiceNumber(req.user.id) });
  } catch (error) {
    next(error);
  }
});

router.get("/invoices", async (req, res, next) => {
  try {
    const search = `%${String(req.query.search || "").trim()}%`;
    const status = String(req.query.status || "");
    const from = req.query.from || null;
    const to = req.query.to || null;
    const result = await query(
      `
        SELECT i.*, c.name AS customer_name
        FROM invoices i
        LEFT JOIN customers c ON c.id = i.customer_id
        WHERE i.user_id = $1
          AND ($2 = '%%' OR i.invoice_number ILIKE $2 OR c.name ILIKE $2)
          AND ($3 = '' OR i.status = $3)
          AND ($4::date IS NULL OR i.issue_date >= $4::date)
          AND ($5::date IS NULL OR i.issue_date <= $5::date)
        ORDER BY i.created_at DESC
      `,
      [req.user.id, search, status, from, to]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.get("/invoices/:id", async (req, res, next) => {
  try {
    const invoice = await fetchInvoice(req.user.id, req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    res.json(invoice);
  } catch (error) {
    next(error);
  }
});

router.post("/invoices", async (req, res, next) => {
  try {
    const businessId = await getBusinessId(req.user.id);
    const customerId = req.body.customer_id || null;
    const totals = calculateItems(req.body.items);
    if (!totals.items.length) return res.status(400).json({ error: "At least one invoice item is required" });
    const invoiceNumber = req.body.invoice_number || (await getNextInvoiceNumber(req.user.id));

    const created = await query(
      `
        INSERT INTO invoices
          (user_id, business_id, customer_id, invoice_number, status, issue_date, due_date, currency, notes, terms, subtotal, tax_total, total)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `,
      [
        req.user.id,
        businessId,
        customerId,
        invoiceNumber,
        normalizeStatus(req.body.status || "pending"),
        req.body.issue_date || new Date().toISOString().slice(0, 10),
        req.body.due_date || null,
        req.body.currency || "INR",
        req.body.notes || "",
        req.body.terms || "",
        totals.subtotal,
        totals.tax_total,
        totals.total,
      ]
    );

    for (const item of totals.items) {
      await query(
        "INSERT INTO invoice_items (invoice_id, description, quantity, price, tax_rate, line_total) VALUES ($1, $2, $3, $4, $5, $6)",
        [created.rows[0].id, item.description, item.quantity, item.price, item.tax_rate, item.line_total]
      );
    }

    res.status(201).json(await fetchInvoice(req.user.id, created.rows[0].id));
  } catch (error) {
    next(error);
  }
});

router.put("/invoices/:id", async (req, res, next) => {
  try {
    const existing = await fetchInvoice(req.user.id, req.params.id);
    if (!existing) return res.status(404).json({ error: "Invoice not found" });

    const customerId = req.body.customer_id || null;
    const totals = calculateItems(req.body.items);
    if (!totals.items.length) return res.status(400).json({ error: "At least one invoice item is required" });

    await query(
      `
        UPDATE invoices SET
          customer_id = $1, invoice_number = $2, status = $3, issue_date = $4,
          due_date = $5, currency = $6, notes = $7, terms = $8,
          subtotal = $9, tax_total = $10, total = $11, updated_at = NOW()
        WHERE id = $12 AND user_id = $13
      `,
      [
        customerId,
        req.body.invoice_number || existing.invoice_number,
        normalizeStatus(req.body.status || existing.status),
        req.body.issue_date || existing.issue_date,
        req.body.due_date || null,
        req.body.currency || "INR",
        req.body.notes || "",
        req.body.terms || "",
        totals.subtotal,
        totals.tax_total,
        totals.total,
        req.params.id,
        req.user.id,
      ]
    );

    await query("DELETE FROM invoice_items WHERE invoice_id = $1", [req.params.id]);
    for (const item of totals.items) {
      await query(
        "INSERT INTO invoice_items (invoice_id, description, quantity, price, tax_rate, line_total) VALUES ($1, $2, $3, $4, $5, $6)",
        [req.params.id, item.description, item.quantity, item.price, item.tax_rate, item.line_total]
      );
    }

    res.json(await fetchInvoice(req.user.id, req.params.id));
  } catch (error) {
    next(error);
  }
});

router.delete("/invoices/:id", async (req, res, next) => {
  try {
    await query("DELETE FROM invoices WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post("/invoices/:id/payments", async (req, res, next) => {
  try {
    const invoice = await fetchInvoice(req.user.id, req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    const amount = Math.max(toNumber(req.body.amount || invoice.total), 0);
    if (!amount) return res.status(400).json({ error: "Payment amount is required" });

    await query(
      "INSERT INTO payments (invoice_id, user_id, amount, method, transaction_id, notes, paid_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        req.params.id,
        req.user.id,
        amount,
        req.body.method || "Manual",
        req.body.transaction_id || "",
        req.body.notes || "",
        req.body.paid_at || new Date(),
      ]
    );

    const paid = await query(
      "SELECT COALESCE(SUM(amount), 0)::float AS paid_total FROM payments WHERE invoice_id = $1",
      [req.params.id]
    );
    const paidTotal = paid.rows[0].paid_total;
    await query(
      "UPDATE invoices SET paid_total = $1, status = CASE WHEN $1 >= total THEN 'paid' ELSE status END, updated_at = NOW() WHERE id = $2 AND user_id = $3",
      [paidTotal, req.params.id, req.user.id]
    );

    res.status(201).json(await fetchInvoice(req.user.id, req.params.id));
  } catch (error) {
    next(error);
  }
});

router.post("/invoices/:id/mark-paid", async (req, res, next) => {
  try {
    const invoice = await fetchInvoice(req.user.id, req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    const due = Math.max(toNumber(invoice.total) - toNumber(invoice.paid_total), 0);
    if (due > 0) {
      await query(
        "INSERT INTO payments (invoice_id, user_id, amount, method, notes) VALUES ($1, $2, $3, $4, $5)",
        [req.params.id, req.user.id, due, "Manual", "Marked paid"]
      );
    }
    await query(
      "UPDATE invoices SET status = 'paid', paid_total = total, updated_at = NOW() WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    res.json(await fetchInvoice(req.user.id, req.params.id));
  } catch (error) {
    next(error);
  }
});

router.get("/invoices/:id/pdf", async (req, res, next) => {
  try {
    const invoice = await fetchInvoice(req.user.id, req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const doc = new PDFDocument({ size: "A4", margin: 48 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${invoice.invoice_number}.pdf"`);
    doc.pipe(res);

    doc.fontSize(26).fillColor("#111827").text("Invoice", 48, 48);
    doc.fontSize(11).fillColor("#6b7280").text(invoice.invoice_number, 48, 82);
    doc.fontSize(10).text(`Status: ${invoice.status.toUpperCase()}`, 430, 54, { align: "right" });
    doc.text(`Issue: ${new Date(invoice.issue_date).toLocaleDateString()}`, 430, 72, { align: "right" });
    if (invoice.due_date) doc.text(`Due: ${new Date(invoice.due_date).toLocaleDateString()}`, 430, 90, { align: "right" });

    doc.moveTo(48, 122).lineTo(545, 122).strokeColor("#e5e7eb").stroke();
    doc.fillColor("#111827").fontSize(12).text(invoice.business_name || "Business", 48, 148);
    doc.fillColor("#6b7280").fontSize(9).text([invoice.business_address, invoice.business_city, invoice.business_state, invoice.business_country].filter(Boolean).join(", "), 48, 166, { width: 220 });
    if (invoice.business_gst_number) doc.text(`GST: ${invoice.business_gst_number}`, 48, 202);

    doc.fillColor("#111827").fontSize(12).text("Bill To", 330, 148);
    doc.fillColor("#6b7280").fontSize(9).text(invoice.customer_name || "Customer", 330, 166);
    doc.text([invoice.customer_address, invoice.customer_city, invoice.customer_state, invoice.customer_country].filter(Boolean).join(", "), 330, 184, { width: 215 });
    if (invoice.customer_email) doc.text(invoice.customer_email, 330, 220);

    let y = 270;
    doc.roundedRect(48, y - 14, 497, 28, 8).fill("#f3f4f6");
    doc.fillColor("#374151").fontSize(9).text("Item", 60, y - 5, { width: 210 });
    doc.text("Qty", 292, y - 5, { width: 50, align: "right" });
    doc.text("Price", 350, y - 5, { width: 70, align: "right" });
    doc.text("Tax", 428, y - 5, { width: 45, align: "right" });
    doc.text("Total", 478, y - 5, { width: 55, align: "right" });
    y += 28;

    invoice.items.forEach((item) => {
      doc.fillColor("#111827").fontSize(9).text(item.description, 60, y, { width: 210 });
      doc.fillColor("#4b5563").text(Number(item.quantity).toFixed(2), 292, y, { width: 50, align: "right" });
      doc.text(Number(item.price).toFixed(2), 350, y, { width: 70, align: "right" });
      doc.text(`${Number(item.tax_rate).toFixed(2)}%`, 428, y, { width: 45, align: "right" });
      doc.text(Number(item.line_total).toFixed(2), 478, y, { width: 55, align: "right" });
      y += 26;
    });

    y += 12;
    doc.moveTo(320, y).lineTo(545, y).strokeColor("#e5e7eb").stroke();
    y += 16;
    doc.fillColor("#4b5563").text("Subtotal", 350, y, { width: 90 });
    doc.text(Number(invoice.subtotal).toFixed(2), 455, y, { width: 78, align: "right" });
    y += 18;
    doc.text("Tax", 350, y, { width: 90 });
    doc.text(Number(invoice.tax_total).toFixed(2), 455, y, { width: 78, align: "right" });
    y += 22;
    doc.fillColor("#111827").fontSize(14).text("Total", 350, y, { width: 90 });
    doc.text(`${invoice.currency} ${Number(invoice.total).toFixed(2)}`, 420, y, { width: 113, align: "right" });

    if (invoice.notes) {
      doc.fillColor("#111827").fontSize(11).text("Notes", 48, 700);
      doc.fillColor("#6b7280").fontSize(9).text(invoice.notes, 48, 718, { width: 300 });
    }

    doc.end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
