const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../shared/invoice-core");

function calc(raw, taxType) {
  const { value, errors } = core.normalizeInvoiceInput(raw);
  assert.deepEqual(errors, []);
  return core.calculateInvoice(value, taxType);
}

test("parseDecimal parses exactly without floating point drift", () => {
  assert.equal(core.parseMoney("0.1"), 10);
  assert.equal(core.parseMoney("0.2"), 20);
  assert.equal(core.parseMoney("1,23,456.78"), 12345678);
  assert.equal(core.parseMoney(19.99), 1999);
  assert.equal(core.parseDecimal("2.5", 3), 2500);
  assert.equal(core.parseMoney("10.50"), 1050);
  assert.equal(core.parseMoney("10.500"), 1050, "trailing zeros beyond scale are allowed");
  assert.throws(() => core.parseMoney("10.555"), /at most 2 decimal places/);
  assert.throws(() => core.parseMoney("-1"), /cannot be negative/);
  assert.throws(() => core.parseMoney("abc"), /valid number/);
  assert.throws(() => core.parseMoney(""), /required/);
  assert.throws(() => core.parseMoney("1e5"), /valid number/);
  assert.equal(core.unitsToString(5), "0.05");
  assert.equal(core.unitsToString(-150), "-1.50");
  assert.equal(core.unitsToPlain(2500, 3), "2.5");
  assert.equal(core.toUnits("1234.50"), 123450);
  assert.equal(core.toUnits(null), 0);
});

test("simple line totals avoid the classic 0.1 + 0.2 problem", () => {
  const result = calc(
    {
      items: [
        { description: "A", quantity: "1", unit_price: "0.10" },
        { description: "B", quantity: "1", unit_price: "0.20" },
      ],
    },
    "none"
  );
  assert.equal(result.totals.subtotal, 30);
  assert.equal(result.totals.total, 30);
});

test("quantity × price rounds half up to the paisa", () => {
  // 3 × 33.335 cannot be entered (3 decimals); use fractional quantity instead.
  const result = calc({ items: [{ description: "Hours", quantity: "1.333", unit_price: "100.05" }] }, "none");
  // 1.333 × 100.05 = 133.36665 → 133.37
  assert.equal(result.items[0].gross_amount, 13337);
});

test("intra-state GST splits into equal CGST and SGST", () => {
  const result = calc({ items: [{ description: "Design", quantity: "1", unit_price: "1000", tax_rate: "18" }] }, "cgst_sgst");
  assert.equal(result.totals.taxable_total, 100000);
  assert.equal(result.totals.cgst_total, 9000);
  assert.equal(result.totals.sgst_total, 9000);
  assert.equal(result.totals.igst_total, 0);
  assert.equal(result.totals.tax_total, 18000);
  assert.equal(result.totals.total, 118000);
});

test("inter-state GST applies IGST only", () => {
  const result = calc({ items: [{ description: "Goods", quantity: "3", unit_price: "333.33", tax_rate: "12" }] }, "igst");
  // 999.99 × 12% = 119.9988 → 120.00
  assert.equal(result.totals.taxable_total, 99999);
  assert.equal(result.totals.igst_total, 12000);
  assert.equal(result.totals.cgst_total, 0);
  assert.equal(result.totals.total, 111999);
});

test("odd GST amounts round each half independently so CGST equals SGST", () => {
  const result = calc({ items: [{ description: "X", quantity: "1", unit_price: "0.55", tax_rate: "5" }] }, "cgst_sgst");
  // 0.55 × 2.5% = 0.01375 → 0.01 each
  assert.equal(result.totals.cgst_total, 1);
  assert.equal(result.totals.sgst_total, 1);
  assert.equal(result.totals.tax_total, 2);
});

test("item percentage and fixed discounts reduce the taxable value", () => {
  const result = calc(
    {
      items: [
        { description: "A", quantity: "2", unit_price: "500", discount_type: "percent", discount_value: "10", tax_rate: "18" },
        { description: "B", quantity: "1", unit_price: "300", discount_type: "amount", discount_value: "50", tax_rate: "18" },
      ],
    },
    "igst"
  );
  assert.equal(result.totals.subtotal, 130000);
  assert.equal(result.totals.item_discount_total, 15000);
  assert.equal(result.totals.taxable_total, 115000);
  assert.equal(result.totals.igst_total, 20700);
  assert.equal(result.totals.total, 135700);
});

test("invoice-level discount is allocated across lines and sums exactly", () => {
  const result = calc(
    {
      items: [
        { description: "A", quantity: "1", unit_price: "100", tax_rate: "5" },
        { description: "B", quantity: "1", unit_price: "100", tax_rate: "18" },
        { description: "C", quantity: "1", unit_price: "100", tax_rate: "18" },
      ],
      discount_type: "amount",
      discount_value: "100",
    },
    "igst"
  );
  const shares = result.items.map((item) => item.invoice_discount_share);
  assert.equal(shares.reduce((a, b) => a + b, 0), 10000);
  assert.deepEqual(shares, [3334, 3333, 3333]);
  assert.equal(result.totals.taxable_total, 20000);
  assert.equal(result.totals.discount_total, 10000);
  // Line taxes: 66.66 × 5% = 3.333 → 3.33; 66.67 × 18% = 12.0006 → 12.00 (×2)
  assert.equal(result.totals.igst_total, 333 + 1200 + 1200);
});

test("percentage invoice discount", () => {
  const result = calc(
    { items: [{ description: "A", quantity: "1", unit_price: "999.99" }], discount_type: "percent", discount_value: "12.5" },
    "none"
  );
  // 999.99 × 12.5% = 124.99875 → 125.00
  assert.equal(result.totals.invoice_discount_amount, 12500);
  assert.equal(result.totals.total, 87499);
});

test("discount larger than the line amount is reported", () => {
  const { value } = core.normalizeInvoiceInput({
    items: [{ description: "A", quantity: "1", unit_price: "10", discount_type: "amount", discount_value: "20" }],
  });
  const result = core.calculateInvoice(value, "none");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /cannot be more than the line amount/);
});

test("validation rejects zero quantities, negative prices, huge rates and missing descriptions", () => {
  const { errors } = core.normalizeInvoiceInput({
    items: [
      { description: "A", quantity: "0", unit_price: "10" },
      { description: "B", quantity: "1", unit_price: "-5" },
      { description: "C", quantity: "1", unit_price: "5", tax_rate: "101" },
      { description: "", quantity: "1", unit_price: "5" },
      { description: "D", quantity: "1", unit_price: "5", hsn_sac: "12" },
    ],
  });
  const messages = errors.map((e) => e.message).join("\n");
  assert.match(messages, /Line 1: quantity must be greater than zero/);
  assert.match(messages, /Line 2 unit price cannot be negative/);
  assert.match(messages, /Line 3: tax rate cannot exceed 100%/);
  assert.match(messages, /Line 4: description is required/);
  assert.match(messages, /Line 5: HSN\/SAC must be 4 to 8 digits/);
});

test("empty editor rows are ignored and an invoice needs at least one item", () => {
  const { errors } = core.normalizeInvoiceInput({ items: [{ description: "", quantity: "1", unit_price: "" }] });
  assert.deepEqual(errors.map((e) => e.field), ["items"]);
});

test("zero-value items are permitted", () => {
  const result = calc({ items: [{ description: "Free sample", quantity: "1", unit_price: "0" }] }, "none");
  assert.equal(result.totals.total, 0);
});

test("round off to nearest rupee", () => {
  const up = calc({ items: [{ description: "A", quantity: "1", unit_price: "100.50" }], round_off: true }, "none");
  assert.equal(up.totals.round_off, 50);
  assert.equal(up.totals.total, 10100);
  const down = calc({ items: [{ description: "A", quantity: "1", unit_price: "100.49" }], round_off: true }, "none");
  assert.equal(down.totals.round_off, -49);
  assert.equal(down.totals.total, 10000);
});

test("reverse charge shows GST but excludes it from the amount payable", () => {
  const result = calc(
    { items: [{ description: "Legal services", quantity: "1", unit_price: "1000", tax_rate: "18" }], reverse_charge: true },
    "cgst_sgst"
  );
  assert.equal(result.reverse_charge, true);
  assert.equal(result.totals.tax_total, 18000);
  assert.equal(result.totals.total, 100000);
});

test("reverse charge is ignored for non-GST invoices", () => {
  const result = calc({ items: [{ description: "A", quantity: "1", unit_price: "10", tax_rate: "10" }], reverse_charge: true }, "simple");
  assert.equal(result.reverse_charge, false);
  assert.equal(result.totals.total, 1100);
});

test("no-tax invoices zero out tax rates", () => {
  const result = calc({ items: [{ description: "A", quantity: "1", unit_price: "10", tax_rate: "18" }] }, "none");
  assert.equal(result.items[0].tax_rate, 0);
  assert.equal(result.totals.tax_total, 0);
});

test("auto GST resolves from supplier state and place of supply", () => {
  assert.equal(core.resolveTaxType("auto", "27", "27"), "cgst_sgst");
  assert.equal(core.resolveTaxType("auto", "27", "29"), "igst");
  assert.equal(core.resolveTaxType("auto", "27", "96"), "igst");
  assert.equal(core.resolveTaxType("auto", "", "29"), null);
  assert.equal(core.resolveTaxType("igst", "27", "27"), "igst");
  assert.equal(core.resolveTaxType("none", "27", "27"), "none");
});

test("tax summary groups by HSN and rate", () => {
  const result = calc(
    {
      items: [
        { description: "A", hsn_sac: "998314", quantity: "1", unit_price: "100", tax_rate: "18" },
        { description: "B", hsn_sac: "998314", quantity: "1", unit_price: "50", tax_rate: "18" },
        { description: "C", hsn_sac: "4901", quantity: "1", unit_price: "10", tax_rate: "5" },
      ],
    },
    "cgst_sgst"
  );
  const toStrings = result.items.map((i) => ({
    hsn_sac: i.hsn_sac,
    tax_rate: core.unitsToString(i.tax_rate),
    taxable_amount: core.unitsToString(i.taxable_amount),
    cgst_amount: core.unitsToString(i.cgst_amount),
    sgst_amount: core.unitsToString(i.sgst_amount),
    igst_amount: core.unitsToString(i.igst_amount),
    tax_amount: core.unitsToString(i.tax_amount),
  }));
  const summary = core.taxSummary(toStrings, "cgst_sgst");
  assert.equal(summary.length, 2);
  const eighteen = summary.find((s) => s.rate === 1800);
  assert.equal(eighteen.taxable, 15000);
  assert.equal(eighteen.cgst, 1350);
});

test("amount in words uses the Indian numbering system", () => {
  assert.equal(core.numberToWordsIndian(0), "Zero");
  assert.equal(core.numberToWordsIndian(105), "One Hundred Five");
  assert.equal(core.numberToWordsIndian(123456), "One Lakh Twenty Three Thousand Four Hundred Fifty Six");
  assert.equal(core.numberToWordsIndian(10000000), "One Crore");
  assert.equal(core.numberToWordsIndian(2147483647), "Two Hundred Fourteen Crore Seventy Four Lakh Eighty Three Thousand Six Hundred Forty Seven");
  assert.equal(core.amountInWords(11800050), "Rupees One Lakh Eighteen Thousand and Fifty Paise Only");
  assert.equal(core.amountInWords(100), "Rupees One Only");
});

test("currency formatting uses Indian digit grouping", () => {
  assert.equal(core.formatMoney(12345678), "₹1,23,456.78");
  assert.equal(core.formatAmount("1000000.5"), "₹10,00,000.50");
});

test("GSTIN and PAN validation", () => {
  assert.equal(core.gstinError("27AAPFU0939F1ZV"), null);
  assert.match(core.gstinError("27AAPFU0939F1ZX"), /check digit/);
  assert.match(core.gstinError("27AAPF"), /15 characters/);
  assert.equal(core.gstinError(""), null);
  assert.equal(core.panError("AAPFU0939F"), null);
  assert.match(core.panError("AAPF0939F"), /10 characters/);
});

test("document numbering templates and financial years", () => {
  assert.equal(core.formatDocumentNumber("INV-{YYYY}-", 7, 4, "2026-10-15"), "INV-2026-0007");
  assert.equal(core.formatDocumentNumber("{FY}/", 12, 3, "2027-02-01"), "2026-27/012");
  assert.equal(core.financialYear("2026-03-31"), "2025-26");
  assert.equal(core.financialYear("2026-04-01"), "2026-27");
  assert.equal(core.sequenceScope("never", "2026-10-15"), "");
  assert.equal(core.sequenceScope("yearly", "2026-10-15"), "2026");
  assert.equal(core.sequenceScope("financial_year", "2026-10-15"), "FY2026-27");
});

test("date helpers", () => {
  assert.equal(core.isIsoDate("2026-02-29"), false);
  assert.equal(core.isIsoDate("2028-02-29"), true);
  assert.equal(core.addDays("2026-12-25", 15), "2027-01-09");
  assert.equal(core.daysBetween("2026-10-01", "2026-10-15"), 14);
  assert.match(core.todayIn("Asia/Kolkata"), /^\d{4}-\d{2}-\d{2}$/);
});

test("UPI link encodes payment intent fields", () => {
  const link = core.upiLink({ upiId: "shop@okbank", payeeName: "My Shop", amountUnits: 123450, note: "INV-2026-0001" });
  assert.equal(link, "upi://pay?pa=shop%40okbank&pn=My%20Shop&am=1234.50&cu=INR&tn=INV-2026-0001");
});
