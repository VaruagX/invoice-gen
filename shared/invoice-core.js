/*
 * Invoice Studio shared core.
 *
 * Loaded by the browser (window.InvoiceCore) for the live editor preview and by
 * the server (require) for validation, persistence, PDFs and reports, so every
 * total is produced by the same code.
 *
 * Money is handled as integer minor units (paise). Quantities use 3 decimal
 * places, rates use 2 decimal places. Products go through BigInt so there is no
 * floating point anywhere in the calculation path.
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  else root.InvoiceCore = core;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MONEY_SCALE = 2;
  const QTY_SCALE = 3;
  const RATE_SCALE = 2;
  // ₹1,000 crore per amount keeps every integer comfortably inside Number.MAX_SAFE_INTEGER.
  const MAX_MONEY_UNITS = 1000000000000; // 10,00,00,00,000.00
  const MAX_QTY_UNITS = 1000000000000; // 1,00,00,00,000.000

  const TAX_TYPES = ["none", "simple", "cgst_sgst", "igst"];
  const GST_TREATMENTS = ["auto", "cgst_sgst", "igst", "none", "simple"];
  const DISCOUNT_TYPES = ["percent", "amount"];
  const INVOICE_STATUSES = ["draft", "unpaid", "partially_paid", "paid", "cancelled"];
  const PAYMENT_METHODS = [
    { value: "upi", label: "UPI" },
    { value: "bank_transfer", label: "Bank transfer" },
    { value: "cash", label: "Cash" },
    { value: "card", label: "Card" },
    { value: "cheque", label: "Cheque" },
    { value: "other", label: "Other" },
  ];
  const COMMON_GST_RATES = ["0", "0.25", "3", "5", "12", "18", "28", "40"];

  // GST state / union territory codes (first two digits of a GSTIN).
  const STATES = [
    { code: "01", name: "Jammu and Kashmir" },
    { code: "02", name: "Himachal Pradesh" },
    { code: "03", name: "Punjab" },
    { code: "04", name: "Chandigarh" },
    { code: "05", name: "Uttarakhand" },
    { code: "06", name: "Haryana" },
    { code: "07", name: "Delhi" },
    { code: "08", name: "Rajasthan" },
    { code: "09", name: "Uttar Pradesh" },
    { code: "10", name: "Bihar" },
    { code: "11", name: "Sikkim" },
    { code: "12", name: "Arunachal Pradesh" },
    { code: "13", name: "Nagaland" },
    { code: "14", name: "Manipur" },
    { code: "15", name: "Mizoram" },
    { code: "16", name: "Tripura" },
    { code: "17", name: "Meghalaya" },
    { code: "18", name: "Assam" },
    { code: "19", name: "West Bengal" },
    { code: "20", name: "Jharkhand" },
    { code: "21", name: "Odisha" },
    { code: "22", name: "Chhattisgarh" },
    { code: "23", name: "Madhya Pradesh" },
    { code: "24", name: "Gujarat" },
    { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
    { code: "27", name: "Maharashtra" },
    { code: "29", name: "Karnataka" },
    { code: "30", name: "Goa" },
    { code: "31", name: "Lakshadweep" },
    { code: "32", name: "Kerala" },
    { code: "33", name: "Tamil Nadu" },
    { code: "34", name: "Puducherry" },
    { code: "35", name: "Andaman and Nicobar Islands" },
    { code: "36", name: "Telangana" },
    { code: "37", name: "Andhra Pradesh" },
    { code: "38", name: "Ladakh" },
    { code: "97", name: "Other Territory" },
    { code: "96", name: "Outside India (export)" },
  ];

  class ValidationError extends Error {
    constructor(message, field) {
      super(message);
      this.name = "ValidationError";
      this.field = field || null;
    }
  }

  // ---------------------------------------------------------------------------
  // Decimal helpers
  // ---------------------------------------------------------------------------

  function pow10(scale) {
    return 10 ** scale;
  }

  /**
   * Parse a user-supplied decimal into integer units (value × 10^scale).
   * Accepts numbers or strings ("1,250.5"). Throws ValidationError on bad input.
   */
  function parseDecimal(value, scale, options) {
    const opts = options || {};
    const label = opts.label || "Value";
    if (value === null || value === undefined || value === "") {
      if (opts.defaultUnits !== undefined) return opts.defaultUnits;
      throw new ValidationError(`${label} is required.`, opts.field);
    }
    let text = typeof value === "number" ? String(value) : String(value).trim().replace(/,/g, "");
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) {
      throw new ValidationError(`${label} must be a valid number.`, opts.field);
    }
    let negative = false;
    if (text.startsWith("-")) {
      negative = true;
      text = text.slice(1);
    }
    const [intPart, fracPartRaw = ""] = text.split(".");
    const fracPart = fracPartRaw.replace(/0+$/, "");
    if (fracPart.length > scale) {
      throw new ValidationError(
        `${label} can have at most ${scale} decimal place${scale === 1 ? "" : "s"}.`,
        opts.field
      );
    }
    const digits = (intPart || "0") + fracPart.padEnd(scale, "0");
    const trimmed = digits.replace(/^0+(?=\d)/, "");
    if (trimmed.length > 16) throw new ValidationError(`${label} is too large.`, opts.field);
    let units = Number(trimmed);
    if (negative && units !== 0) units = -units;
    if (units < 0 && !opts.allowNegative) {
      throw new ValidationError(`${label} cannot be negative.`, opts.field);
    }
    if (opts.min !== undefined && units < opts.min) {
      throw new ValidationError(opts.minMessage || `${label} is too small.`, opts.field);
    }
    if (opts.max !== undefined && units > opts.max) {
      throw new ValidationError(opts.maxMessage || `${label} is too large.`, opts.field);
    }
    return units;
  }

  function parseMoney(value, options) {
    return parseDecimal(value, MONEY_SCALE, Object.assign({ max: MAX_MONEY_UNITS }, options));
  }

  /** Convert integer units back to a fixed decimal string ("1234.50"). */
  function unitsToString(units, scale) {
    const s = scale === undefined ? MONEY_SCALE : scale;
    const negative = units < 0;
    const abs = String(Math.abs(Math.trunc(units))).padStart(s + 1, "0");
    const intPart = abs.slice(0, abs.length - s);
    const frac = s ? "." + abs.slice(abs.length - s) : "";
    return (negative ? "-" : "") + intPart + frac;
  }

  /** Same as unitsToString but drops trailing zeros ("2.500" → "2.5"). */
  function unitsToPlain(units, scale) {
    const text = unitsToString(units, scale);
    return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
  }

  /** Money string or number from the database → integer paise. */
  function toUnits(value, scale) {
    if (value === null || value === undefined || value === "") return 0;
    const s = scale === undefined ? MONEY_SCALE : scale;
    const text = String(value).trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      const n = Number(value);
      return Number.isFinite(n) ? Math.round(n * pow10(s)) : 0;
    }
    const negative = text.startsWith("-");
    const [i, f = ""] = text.replace("-", "").split(".");
    // Round half up on extra digits (database values never exceed the scale, this is defensive).
    let units = Number(i + f.slice(0, s).padEnd(s, "0"));
    if (f.length > s && Number(f[s]) >= 5) units += 1;
    return negative ? -units : units;
  }

  /** Round numer/denom half away from zero. Arguments are BigInt. */
  function divRound(numer, denom) {
    const negative = numer < 0n !== denom < 0n;
    const n = numer < 0n ? -numer : numer;
    const d = denom < 0n ? -denom : denom;
    const q = (n * 2n + d) / (d * 2n);
    return negative ? -q : q;
  }

  /** amount × rate% where rate is in basis points (18% = 1800). */
  function percentOf(amountUnits, rateBp, divisor) {
    return Number(divRound(BigInt(amountUnits) * BigInt(rateBp), BigInt(10000 * (divisor || 1))));
  }

  // ---------------------------------------------------------------------------
  // Invoice input normalisation (shared validation)
  // ---------------------------------------------------------------------------

  function cleanText(value, max) {
    const text = value === null || value === undefined ? "" : String(value).trim();
    return max ? text.slice(0, max) : text;
  }

  /** A completely empty editor row (ignored rather than rejected). */
  function isBlankItem(rawItem) {
    const item = rawItem || {};
    return (
      !cleanText(item.description) &&
      (item.unit_price === undefined || item.unit_price === null || item.unit_price === "" || Number(item.unit_price) === 0) &&
      !cleanText(item.hsn_sac)
    );
  }

  /**
   * Validate and normalise raw invoice form/API input. Returns
   * { value, errors } where errors is a list of { field, message }.
   */
  function normalizeInvoiceInput(raw) {
    const input = raw || {};
    const errors = [];
    const attempt = (fn, fallback) => {
      try {
        return fn();
      } catch (error) {
        if (error instanceof ValidationError) {
          errors.push({ field: error.field, message: error.message });
          return fallback;
        }
        throw error;
      }
    };

    const rawItems = Array.isArray(input.items) ? input.items : [];
    const items = [];
    rawItems.forEach((rawItem, index) => {
      const item = rawItem || {};
      const n = index + 1;
      const description = cleanText(item.description, 500);
      if (isBlankItem(item)) return; // Ignore completely empty editor rows.
      if (!description) {
        errors.push({ field: `items.${index}.description`, message: `Line ${n}: description is required.` });
      }
      const hsn = cleanText(item.hsn_sac, 8).toUpperCase();
      if (hsn && !/^\d{4,8}$/.test(hsn)) {
        errors.push({ field: `items.${index}.hsn_sac`, message: `Line ${n}: HSN/SAC must be 4 to 8 digits.` });
      }
      const quantity = attempt(
        () =>
          parseDecimal(item.quantity, QTY_SCALE, {
            label: `Line ${n} quantity`,
            field: `items.${index}.quantity`,
            min: 1,
            minMessage: `Line ${n}: quantity must be greater than zero.`,
            max: MAX_QTY_UNITS,
          }),
        0
      );
      const unitPrice = attempt(
        () =>
          parseMoney(item.unit_price ?? item.price, {
            label: `Line ${n} unit price`,
            field: `items.${index}.unit_price`,
          }),
        0
      );
      const discountType = DISCOUNT_TYPES.includes(item.discount_type) ? item.discount_type : "percent";
      const discountValue = attempt(
        () =>
          discountType === "percent"
            ? parseDecimal(item.discount_value, RATE_SCALE, {
                label: `Line ${n} discount`,
                field: `items.${index}.discount_value`,
                defaultUnits: 0,
                max: 10000,
                maxMessage: `Line ${n}: discount cannot exceed 100%.`,
              })
            : parseMoney(item.discount_value, {
                label: `Line ${n} discount`,
                field: `items.${index}.discount_value`,
                defaultUnits: 0,
              }),
        0
      );
      const taxRate = attempt(
        () =>
          parseDecimal(item.tax_rate, RATE_SCALE, {
            label: `Line ${n} tax rate`,
            field: `items.${index}.tax_rate`,
            defaultUnits: 0,
            max: 10000,
            maxMessage: `Line ${n}: tax rate cannot exceed 100%.`,
          }),
        0
      );
      items.push({
        source_index: index,
        description,
        hsn_sac: hsn,
        unit: cleanText(item.unit, 20),
        quantity,
        unit_price: unitPrice,
        discount_type: discountType,
        discount_value: discountValue,
        tax_rate: taxRate,
      });
    });

    if (!items.length && !errors.length) {
      errors.push({ field: "items", message: "Add at least one line item." });
    }
    if (items.length > 200) {
      errors.push({ field: "items", message: "An invoice can have at most 200 line items." });
    }

    const discountType = DISCOUNT_TYPES.includes(input.discount_type) ? input.discount_type : "percent";
    const discountValue = attempt(
      () =>
        discountType === "percent"
          ? parseDecimal(input.discount_value, RATE_SCALE, {
              label: "Invoice discount",
              field: "discount_value",
              defaultUnits: 0,
              max: 10000,
              maxMessage: "Invoice discount cannot exceed 100%.",
            })
          : parseMoney(input.discount_value, {
              label: "Invoice discount",
              field: "discount_value",
              defaultUnits: 0,
            }),
      0
    );

    const gstTreatment = GST_TREATMENTS.includes(input.gst_treatment) ? input.gst_treatment : "none";
    const placeOfSupply = cleanText(input.place_of_supply, 2);
    if (placeOfSupply && !stateByCode(placeOfSupply)) {
      errors.push({ field: "place_of_supply", message: "Choose a valid place of supply." });
    }

    return {
      value: {
        items,
        discount_type: discountType,
        discount_value: discountValue,
        gst_treatment: gstTreatment,
        place_of_supply: placeOfSupply,
        reverse_charge: input.reverse_charge === true || input.reverse_charge === "true" || input.reverse_charge === "on",
        round_off: input.round_off === true || input.round_off === "true" || input.round_off === "on",
      },
      errors,
    };
  }

  /**
   * Work out the tax type actually applied to an invoice.
   * "auto" compares the supplier's state with the place of supply.
   */
  function resolveTaxType(gstTreatment, businessStateCode, placeOfSupply) {
    switch (gstTreatment) {
      case "cgst_sgst":
      case "igst":
      case "none":
      case "simple":
        return gstTreatment;
      case "auto": {
        if (!businessStateCode || !placeOfSupply) return null; // Undetermined.
        if (placeOfSupply === "96") return "igst"; // Exports are inter-state supplies.
        return businessStateCode === placeOfSupply ? "cgst_sgst" : "igst";
      }
      default:
        return "none";
    }
  }

  // ---------------------------------------------------------------------------
  // Calculation
  // ---------------------------------------------------------------------------

  /**
   * Compute every line and invoice total from normalised input.
   * @param {object} input normalised invoice (see normalizeInvoiceInput)
   * @param {string} taxType one of TAX_TYPES (already resolved)
   */
  function calculateInvoice(input, taxType) {
    const type = TAX_TYPES.includes(taxType) ? taxType : "none";
    const isGst = type === "cgst_sgst" || type === "igst";
    const reverseCharge = Boolean(input.reverse_charge) && isGst;
    const errors = [];

    const lines = input.items.map((item, index) => {
      const gross = Number(divRound(BigInt(item.quantity) * BigInt(item.unit_price), BigInt(pow10(QTY_SCALE))));
      const row = item.source_index === undefined ? index : item.source_index;
      if (gross > MAX_MONEY_UNITS) {
        errors.push({ field: `items.${row}.unit_price`, message: `Line ${row + 1}: amount is too large.` });
      }
      let discount = 0;
      if (item.discount_type === "percent") discount = percentOf(gross, item.discount_value);
      else discount = item.discount_value;
      if (discount > gross) {
        errors.push({
          field: `items.${row}.discount_value`,
          message: `Line ${row + 1}: discount cannot be more than the line amount.`,
        });
        discount = gross;
      }
      return Object.assign({}, item, {
        gross_amount: gross,
        discount_amount: discount,
        net_amount: gross - discount,
      });
    });

    const netTotal = lines.reduce((sum, line) => sum + line.net_amount, 0);
    let invoiceDiscount = 0;
    if (input.discount_type === "percent") invoiceDiscount = percentOf(netTotal, input.discount_value);
    else invoiceDiscount = input.discount_value;
    if (invoiceDiscount > netTotal) {
      errors.push({ field: "discount_value", message: "Invoice discount cannot be more than the amount after item discounts." });
      invoiceDiscount = netTotal;
    }

    // Spread the invoice discount over lines in proportion to their net amounts
    // (largest remainder), so taxable values always add up exactly.
    const shares = lines.map(() => 0);
    if (invoiceDiscount > 0 && netTotal > 0) {
      const big = BigInt(invoiceDiscount);
      const total = BigInt(netTotal);
      let allocated = 0;
      const remainders = lines.map((line, index) => {
        const exact = big * BigInt(line.net_amount);
        const floor = exact / total;
        shares[index] = Number(floor);
        allocated += shares[index];
        return { index, remainder: exact % total };
      });
      let left = invoiceDiscount - allocated;
      remainders.sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index));
      for (let i = 0; left > 0 && i < remainders.length; i += 1, left -= 1) shares[remainders[i].index] += 1;
    }

    const totals = {
      subtotal: 0,
      item_discount_total: 0,
      invoice_discount_amount: invoiceDiscount,
      discount_total: 0,
      taxable_total: 0,
      cgst_total: 0,
      sgst_total: 0,
      igst_total: 0,
      tax_total: 0,
      round_off: 0,
      total: 0,
    };

    const items = lines.map((line, index) => {
      const taxable = line.net_amount - shares[index];
      let cgst = 0;
      let sgst = 0;
      let igst = 0;
      let tax = 0;
      if (type === "cgst_sgst") {
        cgst = percentOf(taxable, line.tax_rate, 2);
        sgst = cgst;
        tax = cgst + sgst;
      } else if (type === "igst") {
        igst = percentOf(taxable, line.tax_rate);
        tax = igst;
      } else if (type === "simple") {
        tax = percentOf(taxable, line.tax_rate);
      }
      totals.subtotal += line.gross_amount;
      totals.item_discount_total += line.discount_amount;
      totals.taxable_total += taxable;
      totals.cgst_total += cgst;
      totals.sgst_total += sgst;
      totals.igst_total += igst;
      totals.tax_total += tax;
      return {
        position: index,
        description: line.description,
        hsn_sac: line.hsn_sac,
        unit: line.unit,
        quantity: line.quantity,
        unit_price: line.unit_price,
        discount_type: line.discount_type,
        discount_value: line.discount_value,
        tax_rate: type === "none" ? 0 : line.tax_rate,
        gross_amount: line.gross_amount,
        discount_amount: line.discount_amount,
        invoice_discount_share: shares[index],
        taxable_amount: taxable,
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: igst,
        tax_amount: tax,
        line_total: taxable + tax,
      };
    });

    totals.discount_total = totals.item_discount_total + totals.invoice_discount_amount;
    // Under reverse charge the recipient pays the GST to the government, so it is
    // shown on the invoice but not collected by the supplier.
    const beforeRound = totals.taxable_total + (reverseCharge ? 0 : totals.tax_total);
    if (input.round_off) {
      const rounded = Number(divRound(BigInt(beforeRound), 100n)) * 100;
      totals.round_off = rounded - beforeRound;
    }
    totals.total = beforeRound + totals.round_off;
    if (totals.total > MAX_MONEY_UNITS) errors.push({ field: "items", message: "Invoice total is too large." });

    return {
      tax_type: type,
      reverse_charge: reverseCharge,
      items,
      totals,
      errors,
    };
  }

  /** Group computed items into a tax summary (by HSN/SAC + rate when HSN codes are present). */
  function taxSummary(items, taxType) {
    if (taxType === "none") return [];
    const byHsn = items.some((item) => item.hsn_sac);
    const groups = new Map();
    items.forEach((item) => {
      const rate = toUnits(item.tax_rate, RATE_SCALE);
      const key = (byHsn ? item.hsn_sac || "-" : "") + "|" + rate;
      const group = groups.get(key) || {
        hsn_sac: byHsn ? item.hsn_sac || "" : "",
        rate,
        taxable: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        tax: 0,
      };
      group.taxable += toUnits(item.taxable_amount);
      group.cgst += toUnits(item.cgst_amount);
      group.sgst += toUnits(item.sgst_amount);
      group.igst += toUnits(item.igst_amount);
      group.tax += toUnits(item.tax_amount);
      groups.set(key, group);
    });
    return Array.from(groups.values()).sort((a, b) => a.rate - b.rate || a.hsn_sac.localeCompare(b.hsn_sac));
  }

  // ---------------------------------------------------------------------------
  // Indian formatting helpers
  // ---------------------------------------------------------------------------

  const ONES = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
  ];
  const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function twoDigits(n) {
    if (n < 20) return ONES[n];
    return (TENS[Math.floor(n / 10)] + " " + ONES[n % 10]).trim();
  }

  function threeDigits(n) {
    const hundred = Math.floor(n / 100);
    const rest = n % 100;
    return [hundred ? ONES[hundred] + " Hundred" : "", rest ? twoDigits(rest) : ""].filter(Boolean).join(" ");
  }

  /** Integer → words using the Indian numbering system (lakh, crore). */
  function numberToWordsIndian(value) {
    let n = Math.floor(Math.abs(Number(value) || 0));
    if (n === 0) return "Zero";
    const parts = [];
    const crore = Math.floor(n / 10000000);
    n %= 10000000;
    const lakh = Math.floor(n / 100000);
    n %= 100000;
    const thousand = Math.floor(n / 1000);
    n %= 1000;
    if (crore) parts.push(numberToWordsIndian(crore) + " Crore");
    if (lakh) parts.push(twoDigits(lakh) + " Lakh");
    if (thousand) parts.push(twoDigits(thousand) + " Thousand");
    if (n) parts.push(threeDigits(n));
    return parts.join(" ");
  }

  function amountInWords(units, currency) {
    const cur = (currency || "INR").toUpperCase();
    const abs = Math.abs(Math.trunc(units));
    const whole = Math.floor(abs / 100);
    const fraction = abs % 100;
    if (cur === "INR") {
      let text = "Rupees " + numberToWordsIndian(whole);
      if (fraction) text += " and " + twoDigits(fraction) + " Paise";
      return text + " Only";
    }
    let text = cur + " " + numberToWordsIndian(whole);
    if (fraction) text += " and " + String(fraction).padStart(2, "0") + "/100";
    return text + " Only";
  }

  const formatterCache = {};
  function moneyFormatter(currency) {
    const cur = (currency || "INR").toUpperCase();
    if (!formatterCache[cur]) {
      try {
        formatterCache[cur] = new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: cur,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      } catch (error) {
        formatterCache[cur] = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
    }
    return formatterCache[cur];
  }

  /** Format integer minor units as currency, e.g. 12345678 → "₹1,23,456.78". */
  function formatMoney(units, currency) {
    return moneyFormatter(currency).format((Number(units) || 0) / 100);
  }

  /** Format a database money string ("1234.50") as currency. */
  function formatAmount(value, currency) {
    return formatMoney(toUnits(value), currency);
  }

  function formatQuantity(units) {
    const plain = unitsToPlain(units, QTY_SCALE);
    const [i, f] = plain.split(".");
    return Number(i).toLocaleString("en-IN") + (f ? "." + f : "");
  }

  // ---------------------------------------------------------------------------
  // GST identifiers and states
  // ---------------------------------------------------------------------------

  function stateByCode(code) {
    return STATES.find((state) => state.code === String(code || "")) || null;
  }

  function stateByName(name) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) return null;
    return STATES.find((state) => state.name.toLowerCase() === needle) || null;
  }

  const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  /** Validate a GSTIN's structure and checksum. Returns an error message or null. */
  function gstinError(value) {
    const gstin = String(value || "").trim().toUpperCase();
    if (!gstin) return null;
    if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(gstin)) return "GSTIN must be 15 characters (for example 27ABCDE1234F1Z5).";
    let sum = 0;
    for (let i = 0; i < 14; i += 1) {
      const product = GSTIN_CHARS.indexOf(gstin[i]) * (i % 2 === 0 ? 1 : 2);
      sum += Math.floor(product / 36) + (product % 36);
    }
    const check = GSTIN_CHARS[(36 - (sum % 36)) % 36];
    if (check !== gstin[14]) return "GSTIN check digit does not match. Please re-check the number.";
    return null;
  }

  function panError(value) {
    const pan = String(value || "").trim().toUpperCase();
    if (!pan) return null;
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) ? null : "PAN must be 10 characters (for example ABCDE1234F).";
  }

  // ---------------------------------------------------------------------------
  // Dates and numbering
  // ---------------------------------------------------------------------------

  /** Today's date (YYYY-MM-DD) in the given IANA time zone. */
  function todayIn(timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: timeZone || "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch (error) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function isIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const date = new Date(value + "T00:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function addDays(isoDate, days) {
    const date = new Date(isoDate + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return date.toISOString().slice(0, 10);
  }

  function daysBetween(fromIso, toIso) {
    return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86400000);
  }

  /** Financial year label for a date, e.g. 2026-10-15 → "2026-27" (April–March). */
  function financialYear(isoDate) {
    const year = Number(isoDate.slice(0, 4));
    const month = Number(isoDate.slice(5, 7));
    const start = month >= 4 ? year : year - 1;
    return start + "-" + String((start + 1) % 100).padStart(2, "0");
  }

  /** Sequence scope for a reset policy: "" (never), "2026" (yearly) or "FY2026-27". */
  function sequenceScope(resetPolicy, isoDate) {
    if (resetPolicy === "yearly") return isoDate.slice(0, 4);
    if (resetPolicy === "financial_year") return "FY" + financialYear(isoDate);
    return "";
  }

  /** Expand an invoice number template. Tokens: {YYYY} {YY} {MM} {FY}. */
  function formatDocumentNumber(prefix, sequence, padding, isoDate) {
    const date = isoDate || todayIn();
    const fy = financialYear(date);
    const expanded = String(prefix || "")
      .replace(/\{YYYY\}/g, date.slice(0, 4))
      .replace(/\{YY\}/g, date.slice(2, 4))
      .replace(/\{MM\}/g, date.slice(5, 7))
      .replace(/\{FY\}/g, fy);
    return expanded + String(sequence).padStart(Math.min(Math.max(Number(padding) || 0, 1), 8), "0");
  }

  function upiLink({ upiId, payeeName, amountUnits, note, currency }) {
    if (!upiId) return "";
    const params = [
      ["pa", upiId],
      ["pn", payeeName || ""],
      ["am", amountUnits > 0 ? unitsToString(amountUnits) : ""],
      ["cu", currency || "INR"],
      ["tn", note || ""],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => k + "=" + encodeURIComponent(v));
    return "upi://pay?" + params.join("&");
  }

  function statusLabel(status) {
    return (
      {
        draft: "Draft",
        unpaid: "Unpaid",
        partially_paid: "Partially paid",
        paid: "Paid",
        cancelled: "Cancelled",
        overdue: "Overdue",
      }[status] || String(status || "")
    );
  }

  function paymentMethodLabel(method) {
    const found = PAYMENT_METHODS.find((item) => item.value === method);
    return found ? found.label : method ? String(method) : "Other";
  }

  function taxTypeLabel(type) {
    return (
      {
        none: "No tax",
        simple: "Tax",
        cgst_sgst: "CGST + SGST",
        igst: "IGST",
      }[type] || ""
    );
  }

  return {
    MONEY_SCALE,
    QTY_SCALE,
    RATE_SCALE,
    MAX_MONEY_UNITS,
    TAX_TYPES,
    GST_TREATMENTS,
    DISCOUNT_TYPES,
    INVOICE_STATUSES,
    PAYMENT_METHODS,
    COMMON_GST_RATES,
    STATES,
    ValidationError,
    parseDecimal,
    parseMoney,
    unitsToString,
    unitsToPlain,
    toUnits,
    divRound,
    percentOf,
    isBlankItem,
    normalizeInvoiceInput,
    resolveTaxType,
    calculateInvoice,
    taxSummary,
    numberToWordsIndian,
    amountInWords,
    formatMoney,
    formatAmount,
    formatQuantity,
    stateByCode,
    stateByName,
    gstinError,
    panError,
    todayIn,
    isIsoDate,
    addDays,
    daysBetween,
    financialYear,
    sequenceScope,
    formatDocumentNumber,
    upiLink,
    statusLabel,
    paymentMethodLabel,
    taxTypeLabel,
  };
});
