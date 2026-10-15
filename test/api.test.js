/*
 * Integration tests: the real Express app against a disposable local
 * PostgreSQL database. Run with:
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/invoice_test npm test
 *
 * The suite wipes the target database, so it refuses to run unless the URL
 * points at localhost and the database name contains "test".
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const TEST_URL = process.env.TEST_DATABASE_URL;
let skipReason = null;
if (!TEST_URL) skipReason = "TEST_DATABASE_URL not set";
else {
  const url = new URL(TEST_URL);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    skipReason = "TEST_DATABASE_URL must point to a local database whose name contains 'test'";
  }
}

const opts = { skip: skipReason || false, concurrency: false };

let server;
let baseUrl;
let db;
const users = {};

async function call(user, method, path, body, extraHeaders = {}) {
  const headers = { "x-requested-with": "fetch", ...extraHeaders };
  if (user) headers["x-test-user"] = user;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(baseUrl + path, { method, headers, body: payload, redirect: "manual" });
  const type = response.headers.get("content-type") || "";
  let data = null;
  if (type.includes("application/json")) data = await response.json();
  else if (type.includes("pdf") || type.includes("image")) data = Buffer.from(await response.arrayBuffer());
  else data = await response.text();
  return { status: response.status, data, headers: response.headers };
}

const get = (user, path) => call(user, "GET", path);
const post = (user, path, body) => call(user, "POST", path, body ?? {});
const put = (user, path, body) => call(user, "PUT", path, body);
const del = (user, path) => call(user, "DELETE", path);

function pdfPageCount(buffer) {
  // Page objects may sit inside compressed object streams; inflate every stream and count.
  let text = buffer.toString("latin1");
  const streams = text.split("stream\n").slice(1);
  for (const chunk of streams) {
    const end = chunk.indexOf("\nendstream");
    try {
      text += zlib.inflateSync(Buffer.from(chunk.slice(0, end), "latin1")).toString("latin1");
    } catch (error) {
      // Not a deflate stream (fonts, images).
    }
  }
  return (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

const today = () => require("../shared/invoice-core").todayIn("Asia/Kolkata");
const addDays = (n) => require("../shared/invoice-core").addDays(today(), n);

function settings(overrides = {}) {
  return Object.assign(
    {
      name: "Alpha Traders",
      email: "billing@alpha.test",
      phone: "+91 98200 00000",
      website: "alpha.test",
      address: "12 Market Road",
      city: "Pune",
      state_code: "27",
      postal_code: "411001",
      country: "India",
      gst_registered: true,
      gst_number: "27AAPFU0939F1ZV",
      pan: "AAPFU0939F",
      currency: "INR",
      default_tax_rate: "18",
      default_payment_terms: 15,
      invoice_prefix: "INV-{YYYY}-",
      invoice_padding: 4,
      invoice_reset: "never",
      receipt_prefix: "RCPT-",
      default_notes: "Thank you for your business.",
      terms: "Payment due within 15 days.",
      default_payment_instructions: "Pay by UPI or bank transfer.",
      bank_account_name: "Alpha Traders",
      bank_name: "Test Bank",
      bank_account_number: "000123456789",
      bank_ifsc: "TEST0001234",
      bank_branch: "Pune",
      bank_details: "",
      upi_id: "alpha@testbank",
      show_upi_qr: true,
      signatory_name: "A. Owner",
      signatory_title: "Authorised Signatory",
      show_signature_block: true,
      brand_color: "#2563eb",
      timezone: "Asia/Kolkata",
      round_off: false,
    },
    overrides
  );
}

function invoiceBody(customerId, overrides = {}) {
  return Object.assign(
    {
      customer_id: customerId,
      issue_date: today(),
      due_date: addDays(15),
      gst_treatment: "auto",
      discount_type: "percent",
      discount_value: "0",
      items: [{ description: "Consulting", hsn_sac: "998311", quantity: "2", unit_price: "1000", tax_rate: "18" }],
      notes: "",
      terms: "",
      payment_instructions: "",
      action: "draft",
    },
    overrides
  );
}

test.before(async () => {
  if (skipReason) return;
  process.env.DATABASE_URL = TEST_URL;
  process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";
  process.env.SESSION_SECRET = crypto.randomBytes(16).toString("hex");
  process.env.NODE_ENV = "test";

  db = require("../server/db");
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.initDb();

  for (const key of ["A", "B", "C"]) {
    const result = await db.query(
      "INSERT INTO users (google_id, email, name) VALUES ($1, $2, $3) RETURNING id, email, name, avatar_url, created_at",
      [`google-${key}`, `${key.toLowerCase()}@example.test`, `User ${key}`]
    );
    users[key] = result.rows[0];
    await db.query("INSERT INTO businesses (user_id, name, email) VALUES ($1, $2, $3)", [users[key].id, `${key} Business`, users[key].email]);
  }

  const { createApp } = require("../server/app");
  const app = createApp({
    testAuth: (req, res, next) => {
      const key = req.get("x-test-user");
      if (key && users[key]) req.user = users[key];
      next();
    },
  });
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await db.pool.end();
});

const state = {};

test("API requires authentication and blocks requests without the CSRF header", opts, async () => {
  assert.equal((await get(null, "/api/bootstrap")).status, 401);
  const blocked = await call("A", "POST", "/api/customers", { name: "X" }, { "x-requested-with": "" });
  assert.equal(blocked.status, 403);
  const crossSite = await call("A", "POST", "/api/customers", { name: "X" }, { origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  const health = await get(null, "/healthz");
  assert.equal(health.status, 200);
  assert.match(health.headers.get("content-security-policy"), /script-src 'self'/);
});

test("business settings validate GST details", opts, async () => {
  const bad = await put("A", "/api/business", settings({ gst_number: "27AAPFU0939F1ZX" }));
  assert.equal(bad.status, 422);
  assert.equal(bad.data.errors[0].field, "gst_number");

  const mismatch = await put("A", "/api/business", settings({ state_code: "29" }));
  assert.equal(mismatch.status, 422);
  assert.match(mismatch.data.errors.map((e) => e.message).join(" "), /state code 27/);

  const ok = await put("A", "/api/business", settings());
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.state, "Maharashtra");
  assert.equal(ok.data.gst_registered, true);
  assert.match(ok.data.next_invoice_number, /^INV-\d{4}-0001$/);

  // Account C stays non-GST.
  const c = await put("C", "/api/business", settings({ name: "C Shop", gst_registered: false, gst_number: "", pan: "", state_code: "29", upi_id: "", show_upi_qr: false }));
  assert.equal(c.status, 200, JSON.stringify(c.data));
});

test("customers: create, validate, detect duplicates", opts, async () => {
  const invalid = await post("A", "/api/customers", { name: "", email: "nope" });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.data.errors.map((e) => e.field).sort(), ["email", "name"]);

  const local = await post("A", "/api/customers", {
    name: "Mumbai Client",
    company_name: "Local Pvt Ltd",
    email: "local@client.test",
    phone: "9820012345",
    state_code: "27",
    address: "Andheri",
  });
  assert.equal(local.status, 201, JSON.stringify(local.data));
  state.localCustomer = local.data;

  const remote = await post("A", "/api/customers", {
    name: "Bengaluru Client",
    email: "remote@client.test",
    phone: "9900011111",
    gst_number: "29AAPFU0939F1ZT".replace(/.$/, ""),
  });
  // A GSTIN with a wrong check digit must be rejected.
  assert.equal(remote.status, 422);

  const remoteOk = await post("A", "/api/customers", { name: "Bengaluru Client", email: "remote@client.test", phone: "9900011111", state_code: "29" });
  assert.equal(remoteOk.status, 201);
  state.remoteCustomer = remoteOk.data;

  const dup = await post("A", "/api/customers", { name: "Another", email: "LOCAL@client.test" });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, "DUPLICATE_CUSTOMER");
  const forced = await post("A", "/api/customers", { name: "Another", email: "local@client.test", allow_duplicate: true });
  assert.equal(forced.status, 201);
  state.extraCustomer = forced.data;

  const injection = await post("A", "/api/customers", { name: "=HYPERLINK(\"http://x\")", email: "inj@client.test" });
  assert.equal(injection.status, 201);
  state.injectionCustomer = injection.data;
});

test("invoices apply CGST+SGST or IGST from the place of supply and ignore client totals", opts, async () => {
  const local = await post("A", "/api/invoices", Object.assign(invoiceBody(state.localCustomer.id), { total: "1", subtotal: "1" }));
  assert.equal(local.status, 201, JSON.stringify(local.data));
  assert.equal(local.data.tax_type, "cgst_sgst");
  assert.equal(local.data.subtotal, "2000.00");
  assert.equal(local.data.cgst_total, "180.00");
  assert.equal(local.data.sgst_total, "180.00");
  assert.equal(local.data.total, "2360.00");
  assert.equal(local.data.status, "draft");
  assert.equal(local.data.customer.name, "Mumbai Client");
  assert.equal(local.data.amount_in_words, "Rupees Two Thousand Three Hundred Sixty Only");
  state.localInvoice = local.data;

  const remote = await post("A", "/api/invoices", invoiceBody(state.remoteCustomer.id, {
    discount_type: "amount",
    discount_value: "100",
    items: [
      { description: "Widget", quantity: "3", unit_price: "333.33", tax_rate: "12", discount_type: "percent", discount_value: "10" },
      { description: "Service", quantity: "1", unit_price: "500", tax_rate: "18" },
    ],
    round_off: true,
    action: "issue",
  }));
  assert.equal(remote.status, 201, JSON.stringify(remote.data));
  assert.equal(remote.data.tax_type, "igst");
  assert.equal(remote.data.status, "unpaid");
  // gross 999.99 + 500 = 1499.99; item discount 100.00 -> net 1399.99; invoice discount 100
  assert.equal(remote.data.subtotal, "1499.99");
  assert.equal(remote.data.item_discount_total, "100.00");
  assert.equal(remote.data.taxable_total, "1299.99");
  const core = require("../shared/invoice-core");
  const sumLines = remote.data.items.reduce((s, i) => s + core.toUnits(i.line_total), 0);
  assert.equal(core.toUnits(remote.data.total), sumLines + core.toUnits(remote.data.round_off));
  assert.equal(core.toUnits(remote.data.total) % 100, 0, "round off produces whole rupees");
  state.remoteInvoice = remote.data;
});

test("invoice validation errors are reported per field", opts, async () => {
  const bad = await post("A", "/api/invoices", invoiceBody(state.localCustomer.id, {
    due_date: addDays(-30),
    items: [{ description: "X", quantity: "-1", unit_price: "abc", tax_rate: "18" }],
  }));
  assert.equal(bad.status, 422);
  const fields = bad.data.errors.map((e) => e.field);
  assert.ok(fields.includes("due_date"));
  assert.ok(fields.includes("items.0.quantity"));
  assert.ok(fields.includes("items.0.unit_price"));

  const noItems = await post("A", "/api/invoices", invoiceBody(state.localCustomer.id, { items: [] }));
  assert.equal(noItems.status, 422);
});

test("non-GST businesses cannot issue GST invoices but can issue plain invoices", opts, async () => {
  const gst = await post("C", "/api/invoices", invoiceBody(null, { gst_treatment: "auto" }));
  assert.equal(gst.status, 422);
  assert.equal(gst.data.errors[0].field, "gst_treatment");
  const plain = await post("C", "/api/invoices", invoiceBody(null, { gst_treatment: "none" }));
  assert.equal(plain.status, 201);
  assert.equal(plain.data.tax_total, "0.00");
  assert.equal(plain.data.total, "2000.00");
  assert.equal(plain.data.invoice_number.endsWith("0001"), true, "numbering is per account");
});

test("concurrent invoice creation produces unique sequential numbers", opts, async () => {
  const results = await Promise.all(
    Array.from({ length: 15 }, () => post("A", "/api/invoices", invoiceBody(state.localCustomer.id)))
  );
  results.forEach((r) => assert.equal(r.status, 201, JSON.stringify(r.data)));
  const numbers = results.map((r) => r.data.invoice_number);
  assert.equal(new Set(numbers).size, 15);
  const seqs = numbers.map((n) => Number(n.split("-").pop())).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 15 }, (_, i) => i + 3));
  state.bulkInvoices = results.map((r) => r.data);
});

test("custom invoice numbers must be unique within the account only", opts, async () => {
  const first = await post("A", "/api/invoices", invoiceBody(state.localCustomer.id, { invoice_number: "CUSTOM-1" }));
  assert.equal(first.status, 201);
  const again = await post("A", "/api/invoices", invoiceBody(state.localCustomer.id, { invoice_number: "CUSTOM-1" }));
  assert.equal(again.status, 422);
  const otherAccount = await post("C", "/api/invoices", invoiceBody(null, { gst_treatment: "none", invoice_number: "CUSTOM-1" }));
  assert.equal(otherAccount.status, 201);
  state.customInvoice = first.data;
});

test("editing recalculates on the server", opts, async () => {
  const updated = await put("A", `/api/invoices/${state.localInvoice.id}`, invoiceBody(state.localCustomer.id, {
    items: [
      { description: "Consulting", quantity: "1", unit_price: "1000", tax_rate: "18" },
      { description: "Travel", quantity: "1", unit_price: "250.50", tax_rate: "5" },
    ],
    total: "999999",
    action: "issue",
  }));
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.status, "unpaid");
  // taxable 1250.50; 1000 → 90+90; 250.50 × 2.5% = 6.2625 → 6.26 each
  assert.equal(updated.data.cgst_total, "96.26");
  assert.equal(updated.data.total, "1443.02");
  assert.equal(updated.data.invoice_number, state.localInvoice.invoice_number, "number never changes on edit");
  state.localInvoice = updated.data;
});

test("payments: drafts blocked, partial, overpayment, multiple payments, void", opts, async () => {
  const draft = state.bulkInvoices[0];
  const onDraft = await post("A", `/api/invoices/${draft.id}/payments`, { amount: "10", method: "cash", payment_date: today() });
  assert.equal(onDraft.status, 409);

  const id = state.localInvoice.id;
  const future = await post("A", `/api/invoices/${id}/payments`, { amount: "10", method: "cash", payment_date: addDays(2) });
  assert.equal(future.status, 422);
  const noMethod = await post("A", `/api/invoices/${id}/payments`, { amount: "10", payment_date: today() });
  assert.equal(noMethod.status, 422);

  const partial = await post("A", `/api/invoices/${id}/payments`, { amount: "443.02", method: "upi", reference: "UPI-REF-42", payment_date: today() });
  assert.equal(partial.status, 201, JSON.stringify(partial.data));
  assert.equal(partial.data.invoice.status, "partially_paid");
  assert.equal(partial.data.invoice.balance_due, "1000.00");
  assert.match(partial.data.invoice.payments[0].receipt_number, /^RCPT-0001$/);

  const over = await post("A", `/api/invoices/${id}/payments`, { amount: "1000.01", method: "cash", payment_date: today() });
  assert.equal(over.status, 422);
  assert.match(over.data.error, /more than the balance due/);

  const rest = await post("A", `/api/invoices/${id}/payments`, { amount: "1000", method: "bank_transfer", payment_date: today() });
  assert.equal(rest.status, 201);
  assert.equal(rest.data.invoice.status, "paid");
  assert.equal(rest.data.invoice.balance_due, "0.00");
  assert.equal(rest.data.invoice.payments.length, 2);

  const extra = await post("A", `/api/invoices/${id}/payments`, { amount: "1", method: "cash", payment_date: today() });
  assert.equal(extra.status, 409);

  const lowerTotal = await put("A", `/api/invoices/${id}`, invoiceBody(state.localCustomer.id));
  assert.equal(lowerTotal.status, 200, "raising/keeping the total above payments is allowed");
  const tooLow = await put("A", `/api/invoices/${id}`, invoiceBody(state.localCustomer.id, { items: [{ description: "Tiny", quantity: "1", unit_price: "1" }] }));
  assert.equal(tooLow.status, 422);
  assert.match(tooLow.data.error, /less than the/);

  const paymentId = rest.data.payment_id;
  const noReason = await post("A", `/api/payments/${paymentId}/void`, {});
  assert.equal(noReason.status, 422);
  const voided = await post("A", `/api/payments/${paymentId}/void`, { reason: "Cheque bounced" });
  assert.equal(voided.status, 200);
  assert.equal(voided.data.invoice.status, "partially_paid");
  assert.equal(voided.data.invoice.payments.find((p) => p.id === paymentId).void_reason, "Cheque bounced");
  const twice = await post("A", `/api/payments/${paymentId}/void`, { reason: "again" });
  assert.equal(twice.status, 409);
  state.paidPartially = voided.data.invoice;
  state.paymentId = partial.data.payment_id;
});

test("concurrent payments cannot exceed the balance", opts, async () => {
  const invoice = state.bulkInvoices[1];
  const issued = await post("A", `/api/invoices/${invoice.id}/issue`);
  assert.equal(issued.status, 200);
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      post("A", `/api/invoices/${invoice.id}/payments`, { amount: issued.data.total, method: "cash", payment_date: today() })
    )
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  const after = await get("A", `/api/invoices/${invoice.id}`);
  assert.equal(after.data.paid_total, issued.data.total);
});

test("mark as paid records a validated payment for the full balance", opts, async () => {
  const invoice = state.bulkInvoices[2];
  await post("A", `/api/invoices/${invoice.id}/issue`);
  const missing = await post("A", `/api/invoices/${invoice.id}/mark-paid`, {});
  assert.equal(missing.status, 422);
  const ok = await post("A", `/api/invoices/${invoice.id}/mark-paid`, { method: "cash", payment_date: today() });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.invoice.status, "paid");
  assert.equal(ok.data.invoice.payments[0].amount, invoice.total);
});

test("overdue is derived from due date and balance", opts, async () => {
  const past = await post("A", "/api/invoices", invoiceBody(state.remoteCustomer.id, {
    issue_date: addDays(-60),
    due_date: addDays(-45),
    action: "issue",
  }));
  assert.equal(past.status, 201);
  assert.equal(past.data.display_status, "overdue");
  assert.equal(past.data.days_overdue, 45);

  const partly = await post("A", "/api/invoices", invoiceBody(state.remoteCustomer.id, {
    issue_date: addDays(-10),
    due_date: addDays(-5),
    action: "issue",
  }));
  await post("A", `/api/invoices/${partly.data.id}/payments`, { amount: "100", method: "cash", payment_date: today() });

  const paidPast = await post("A", "/api/invoices", invoiceBody(state.remoteCustomer.id, {
    issue_date: addDays(-40),
    due_date: addDays(-35),
    action: "issue",
  }));
  await post("A", `/api/invoices/${paidPast.data.id}/mark-paid`, { method: "upi", payment_date: today() });

  const cancelledPast = await post("A", "/api/invoices", invoiceBody(state.remoteCustomer.id, {
    issue_date: addDays(-40),
    due_date: addDays(-35),
    action: "issue",
  }));
  const cancel = await post("A", `/api/invoices/${cancelledPast.data.id}/cancel`, { reason: "Raised in error" });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.status, "cancelled");

  const overdue = await get("A", "/api/invoices/overdue");
  const ids = overdue.data.items.map((i) => i.id);
  assert.ok(ids.includes(past.data.id));
  assert.ok(ids.includes(partly.data.id), "partially paid invoices can be overdue");
  assert.ok(!ids.includes(paidPast.data.id), "fully paid is never overdue");
  assert.ok(!ids.includes(cancelledPast.data.id), "cancelled is never overdue");
  const partlyRow = overdue.data.items.find((i) => i.id === partly.data.id);
  assert.equal(core().toUnits(partlyRow.balance_due), core().toUnits(partly.data.total) - 10000);
  const bucket = await get("A", "/api/invoices/overdue?bucket=31-60");
  assert.deepEqual(bucket.data.items.map((i) => i.id), [past.data.id]);
  assert.equal(overdue.data.buckets.find((b) => b.bucket === "31-60").count, 1);

  const filtered = await get("A", "/api/invoices?status=overdue");
  assert.equal(filtered.data.total, 2);
  state.overdueInvoice = past.data;
});

function core() {
  return require("../shared/invoice-core");
}

test("invoice list filters, search, sort and pagination", opts, async () => {
  const page1 = await get("A", "/api/invoices?page=1&page_size=5&sort=total&dir=desc");
  assert.equal(page1.status, 200);
  assert.equal(page1.data.items.length, 5);
  assert.ok(page1.data.total > 15);
  const totals = page1.data.items.map((i) => core().toUnits(i.total));
  assert.deepEqual([...totals].sort((a, b) => b - a), totals);
  const page2 = await get("A", "/api/invoices?page=2&page_size=5&sort=total&dir=desc");
  assert.equal(new Set([...page1.data.items, ...page2.data.items].map((i) => i.id)).size, 10);

  const byPhone = await get("A", "/api/invoices?search=99000");
  assert.ok(byPhone.data.items.length > 0);
  assert.ok(byPhone.data.items.every((i) => i.customer_name === "Bengaluru Client"));

  const byReference = await get("A", "/api/invoices?search=UPI-REF-42");
  assert.deepEqual(byReference.data.items.map((i) => i.id), [state.localInvoice.id]);

  const drafts = await get("A", "/api/invoices?status=draft");
  assert.ok(drafts.data.items.every((i) => i.status === "draft"));

  const byCustomer = await get("A", `/api/invoices?customer_id=${state.remoteCustomer.id}`);
  assert.ok(byCustomer.data.items.every((i) => i.customer_id === state.remoteCustomer.id));

  const range = await get("A", `/api/invoices?from=${addDays(-61)}&to=${addDays(-59)}`);
  assert.deepEqual(range.data.items.map((i) => i.id), [state.overdueInvoice.id]);

  const amount = await get("A", "/api/invoices?min_amount=2000&max_amount=2400");
  assert.ok(amount.data.items.every((i) => core().toUnits(i.total) >= 200000 && core().toUnits(i.total) <= 240000));

  const search = await get("A", "/api/search?q=Bengaluru");
  assert.ok(search.data.customers.length === 1);
  assert.ok(search.data.invoices.length > 0);
});

test("deletion and cancellation rules protect financial history", opts, async () => {
  const withPayment = state.paidPartially;
  const del1 = await del("A", `/api/invoices/${withPayment.id}`);
  assert.equal(del1.status, 409);
  assert.equal(del1.data.code, "INVOICE_HAS_PAYMENTS");
  const cancel = await post("A", `/api/invoices/${withPayment.id}/cancel`, {});
  assert.equal(cancel.status, 409);

  const draft = state.bulkInvoices[5];
  const ok = await del("A", `/api/invoices/${draft.id}`);
  assert.equal(ok.status, 204);
  assert.equal((await get("A", `/api/invoices/${draft.id}`)).status, 404);

  const custDelete = await del("A", `/api/customers/${state.localCustomer.id}`);
  assert.equal(custDelete.status, 409);
  assert.equal(custDelete.data.code, "CUSTOMER_HAS_INVOICES");
  const archive = await post("A", `/api/customers/${state.extraCustomer.id}/archive`);
  assert.equal(archive.status, 200);
  const options = await get("A", "/api/customers/options");
  assert.ok(!options.data.some((c) => c.id === state.extraCustomer.id));
  const unused = await del("A", `/api/customers/${state.extraCustomer.id}`);
  assert.equal(unused.status, 204);

  const archivedInvoice = await post("A", `/api/customers/${state.remoteCustomer.id}/archive`);
  assert.equal(archivedInvoice.status, 200);
  const blocked = await post("A", "/api/invoices", invoiceBody(state.remoteCustomer.id));
  assert.equal(blocked.status, 422);
  await post("A", `/api/customers/${state.remoteCustomer.id}/restore`);
});

test("duplicate creates a new draft with a new number", opts, async () => {
  const dup = await post("A", `/api/invoices/${state.remoteInvoice.id}/duplicate`);
  assert.equal(dup.status, 201, JSON.stringify(dup.data));
  assert.equal(dup.data.status, "draft");
  assert.notEqual(dup.data.invoice_number, state.remoteInvoice.invoice_number);
  assert.equal(dup.data.total, state.remoteInvoice.total);
  assert.equal(dup.data.duplicated_from, state.remoteInvoice.id);
  assert.equal(dup.data.payments.length, 0);
});

test("dashboard figures come from recorded data", opts, async () => {
  const dash = await get("A", "/api/dashboard?range=30d");
  assert.equal(dash.status, 200, JSON.stringify(dash.data));
  const payments = await db.query("SELECT COALESCE(sum(amount),0) AS s FROM payments WHERE user_id = $1 AND voided_at IS NULL AND payment_date >= $2", [users.A.id, addDays(-29)]);
  assert.equal(core().toUnits(dash.data.cards.collected), core().toUnits(payments.rows[0].s));
  const open = await db.query("SELECT COALESCE(sum(total - paid_total),0) AS s FROM invoices WHERE user_id = $1 AND status IN ('unpaid','partially_paid')", [users.A.id]);
  assert.equal(core().toUnits(dash.data.cards.outstanding), core().toUnits(open.rows[0].s));
  assert.equal(dash.data.cards.overdue_invoices, 2);
  assert.equal(dash.data.series.length, 30);
  const seriesCollected = dash.data.series.reduce((s, b) => s + core().toUnits(b.collected), 0);
  assert.equal(seriesCollected, core().toUnits(dash.data.cards.collected));
  assert.ok(dash.data.recent_activity.length > 0);
  assert.ok(dash.data.insights.top_customers.length > 0);

  const months = await get("A", "/api/dashboard?range=12m");
  assert.equal(months.data.series.length, 12);
  const custom = await get("A", `/api/dashboard?range=custom&from=${addDays(-10)}&to=${today()}`);
  assert.equal(custom.data.series.length, 11);
  const badCustom = await get("A", `/api/dashboard?range=custom&from=${today()}&to=${addDays(-1)}`);
  assert.equal(badCustom.status, 422);

  const empty = await get("B", "/api/dashboard");
  assert.equal(empty.data.has_data, false);
  assert.equal(empty.data.cards.collected, "0");
});

test("reports, CSV export and tax summary", opts, async () => {
  const list = await get("A", "/api/reports");
  assert.equal(list.data.length, 8);
  for (const report of list.data) {
    const r = await get("A", `/api/reports/${report.key}?from=${addDays(-90)}&to=${today()}`);
    assert.equal(r.status, 200, `${report.key}: ${JSON.stringify(r.data)}`);
    assert.ok(Array.isArray(r.data.rows));
  }
  const tax = await get("A", `/api/reports/tax-summary?from=${addDays(-90)}&to=${today()}`);
  const issued = await db.query(
    "SELECT COALESCE(sum(tax_total),0) AS s FROM invoices WHERE user_id = $1 AND status NOT IN ('draft','cancelled') AND issue_date >= $2",
    [users.A.id, addDays(-90)]
  );
  assert.equal(core().toUnits(tax.data.totals.total_tax), core().toUnits(issued.rows[0].s));

  const payments = await get("A", `/api/reports/payments?from=${addDays(-90)}&to=${today()}`);
  assert.ok(payments.data.rows.every((row) => row.method !== "upi"), "methods are labelled");

  const csv = await call("A", "GET", `/api/reports/customer-revenue?from=${addDays(-90)}&to=${today()}&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.data, /Customer,Invoices,Invoiced,Collected,Outstanding/);

  await post("A", "/api/invoices", invoiceBody(state.injectionCustomer.id, { action: "issue" }));
  const csv2 = await call("A", "GET", `/api/reports/customer-revenue?from=${addDays(-90)}&to=${today()}&format=csv`);
  assert.match(csv2.data, /"'=HYPERLINK\(""http:\/\/x""\)"/);

  const pdf = await call("A", "GET", `/api/reports/revenue?format=pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 4).toString(), "%PDF");
});

test("PDF invoices and receipts render, including multi-page invoices", opts, async () => {
  const pdf = await get("A", `/api/invoices/${state.paidPartially.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-type"), /application\/pdf/);
  assert.match(pdf.headers.get("content-disposition"), /attachment; filename="INV-\d{4}-\d{4}\.pdf"/);
  assert.equal(pdf.data.subarray(0, 4).toString(), "%PDF");

  const items = Array.from({ length: 70 }, (_, i) => ({
    description: `Line item ${i + 1} with a reasonably long description that wraps onto a second line in the table`,
    hsn_sac: "998311",
    quantity: "1",
    unit_price: "10",
    tax_rate: i % 2 ? "18" : "5",
  }));
  const big = await post("A", "/api/invoices", invoiceBody(state.localCustomer.id, { items, notes: "Note ".repeat(80), terms: "Term ".repeat(80) }));
  assert.equal(big.status, 201);
  const bigPdf = await get("A", `/api/invoices/${big.data.id}/pdf`);
  assert.equal(bigPdf.status, 200);
  assert.ok(pdfPageCount(bigPdf.data) >= 3, `expected a multi-page PDF, got ${pdfPageCount(bigPdf.data)}`);

  const receipt = await get("A", `/api/payments/${state.paymentId}/receipt`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.data.subarray(0, 4).toString(), "%PDF");

  const qr = await get("A", `/api/invoices/${state.paidPartially.id}/upi-qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.data.toString(), /^<svg/);
});

test("reminder text is prepared with contact links", opts, async () => {
  const r = await get("A", `/api/invoices/${state.overdueInvoice.id}/reminder`);
  assert.equal(r.status, 200);
  assert.match(r.data.subject, /Payment reminder/);
  assert.match(r.data.body, /45 days ago/);
  assert.match(r.data.whatsapp_url, /^https:\/\/wa\.me\/919900011111\?text=/);
  assert.match(r.data.mailto_url, /^mailto:remote%40client\.test/);
});

test("image uploads are validated by content and size", opts, async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "logo.png");
  const ok = await call("A", "POST", "/api/business/assets/logo", form);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.ok(ok.data.assets.logo.url);

  const fake = new FormData();
  fake.append("file", new Blob([Buffer.from("<svg onload=alert(1)>")], { type: "image/png" }), "evil.png");
  const rejected = await call("A", "POST", "/api/business/assets/signature", fake);
  assert.equal(rejected.status, 422);

  const huge = new FormData();
  huge.append("file", new Blob([Buffer.concat([png, Buffer.alloc(2.5 * 1024 * 1024)])], { type: "image/png" }), "big.png");
  const tooBig = await call("A", "POST", "/api/business/assets/stamp", huge);
  assert.equal(tooBig.status, 422);

  const served = await get("A", "/api/business/assets/logo");
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal((await get("B", "/api/business/assets/logo")).status, 404, "assets are per account");

  const withLogo = await get("A", `/api/invoices/${state.localInvoice.id}/pdf`);
  assert.equal(withLogo.status, 200);
});

test("accounts are isolated from each other", opts, async () => {
  const invoiceId = state.localInvoice.id;
  assert.equal((await get("B", `/api/invoices/${invoiceId}`)).status, 404);
  assert.equal((await get("B", `/api/invoices/${invoiceId}/pdf`)).status, 404);
  assert.equal((await put("B", `/api/invoices/${invoiceId}`, invoiceBody(null, { gst_treatment: "none" }))).status, 404);
  assert.equal((await del("B", `/api/invoices/${invoiceId}`)).status, 404);
  assert.equal((await post("B", `/api/invoices/${invoiceId}/payments`, { amount: "1", method: "cash", payment_date: today() })).status, 404);
  assert.equal((await post("B", `/api/invoices/${invoiceId}/duplicate`)).status, 404);
  assert.equal((await post("B", `/api/payments/${state.paymentId}/void`, { reason: "steal" })).status, 404);
  assert.equal((await get("B", `/api/payments/${state.paymentId}/receipt`)).status, 404);
  assert.equal((await get("B", `/api/customers/${state.localCustomer.id}`)).status, 404);
  assert.equal((await put("B", `/api/customers/${state.localCustomer.id}`, { name: "Hijack" })).status, 404);

  const borrowCustomer = await post("B", "/api/invoices", invoiceBody(state.localCustomer.id, { gst_treatment: "none" }));
  assert.equal(borrowCustomer.status, 422, "cannot attach another account's customer");

  assert.equal((await get("B", "/api/customers")).data.total, 0);
  assert.equal((await get("B", "/api/invoices")).data.total, 0);
  assert.equal((await get("B", "/api/payments")).data.total, 0);
  const search = await get("B", `/api/search?q=${encodeURIComponent(state.localInvoice.invoice_number)}`);
  assert.equal(search.data.invoices.length, 0);
  const report = await get("B", "/api/reports/payments");
  assert.equal(report.data.rows.length, 0);
  assert.equal((await get("B", "/api/invoices/not-a-uuid")).status, 404);
  assert.equal((await get("B", "/api/customers/00000000-0000-0000-0000-000000000000")).status, 404);
});
