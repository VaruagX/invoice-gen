const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const core = require("../../shared/invoice-core");
const { query, withTransaction } = require("../db");
const { handle, HttpError, badRequest } = require("../lib/http");
const { rules, validateBody } = require("../lib/validate");
const { getBusiness, getAssetSummary, detectImageType } = require("../lib/business");
const { logActivity } = require("../lib/activity");
const { previewNextNumber } = require("../lib/invoices");
const { rateLimit } = require("../middleware/security");

const router = express.Router();

const ASSET_KINDS = ["logo", "signature", "stamp"];
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const PREFIX_PATTERN = /^[A-Za-z0-9\-/_.#]*(\{(YYYY|YY|MM|FY)\}[A-Za-z0-9\-/_.#]*)*$/;
const TIMEZONES = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);
TIMEZONES.add("Asia/Kolkata");
TIMEZONES.add("UTC");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ASSET_BYTES, files: 1, fields: 5, parts: 6 },
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyPrefix: "upload",
  message: "Too many uploads. Please try again in a few minutes.",
});

const SETTINGS_SCHEMA = {
  name: ["Business name", rules.text(120, { required: true })],
  email: ["Email", rules.email()],
  phone: ["Phone", rules.phone()],
  website: ["Website", rules.url()],
  address: ["Address", rules.text(500)],
  city: ["City", rules.text(80)],
  state_code: ["State", rules.stateCode()],
  postal_code: ["PIN code", rules.text(12)],
  country: ["Country", rules.text(80)],
  gst_registered: ["GST registered", rules.bool()],
  gst_number: ["GSTIN", rules.gstin()],
  pan: ["PAN", rules.pan()],
  currency: ["Currency", rules.text(3, { upper: true })],
  default_tax_rate: ["Default GST rate", rules.rate()],
  default_payment_terms: ["Payment terms", rules.int(0, 365)],
  invoice_prefix: ["Invoice prefix", rules.text(24)],
  invoice_padding: ["Number length", rules.int(1, 8)],
  invoice_reset: ["Numbering reset", rules.oneOf(["never", "yearly", "financial_year"], "never")],
  receipt_prefix: ["Receipt prefix", rules.text(16)],
  default_notes: ["Default notes", rules.text(2000)],
  terms: ["Default terms", rules.text(4000)],
  default_payment_instructions: ["Payment instructions", rules.text(2000)],
  bank_account_name: ["Account holder name", rules.text(120)],
  bank_name: ["Bank name", rules.text(120)],
  bank_account_number: ["Account number", rules.text(34)],
  bank_ifsc: ["IFSC", rules.ifsc()],
  bank_branch: ["Branch", rules.text(120)],
  bank_details: ["Other bank details", rules.text(1000)],
  upi_id: ["UPI ID", rules.upi()],
  show_upi_qr: ["Show UPI QR", rules.bool()],
  signatory_name: ["Signatory name", rules.text(120)],
  signatory_title: ["Signatory title", rules.text(80)],
  show_signature_block: ["Signature block", rules.bool()],
  brand_color: ["Brand colour", rules.color()],
  timezone: ["Time zone", rules.text(64)],
  round_off: ["Round off totals", rules.bool()],
};

function serializeBusiness(business, assets) {
  return Object.assign({}, business, { assets });
}

router.get(
  "/business",
  handle(async (req, res) => {
    const [assets, nextNumber] = await Promise.all([
      getAssetSummary(req.user.id),
      previewNextNumber(req.user.id, req.business, req.today),
    ]);
    res.json(Object.assign(serializeBusiness(req.business, assets), { next_invoice_number: nextNumber }));
  })
);

router.put(
  "/business",
  handle(async (req, res) => {
    const value = validateBody(req.body, SETTINGS_SCHEMA);
    const errors = [];

    if (!/^[A-Z]{3}$/.test(value.currency || "")) errors.push({ field: "currency", message: "Currency must be a 3-letter code such as INR." });
    if (!TIMEZONES.has(value.timezone)) errors.push({ field: "timezone", message: "Choose a valid time zone." });
    if (!PREFIX_PATTERN.test(value.invoice_prefix)) {
      errors.push({ field: "invoice_prefix", message: "Prefix can use letters, digits, - / _ . # and the tokens {YYYY} {YY} {MM} {FY}." });
    }
    if (value.receipt_prefix && !/^[A-Za-z0-9\-/_.#]*$/.test(value.receipt_prefix)) {
      errors.push({ field: "receipt_prefix", message: "Receipt prefix can use letters, digits and - / _ . #" });
    }
    if (value.gst_registered && !value.gst_number) {
      errors.push({ field: "gst_number", message: "Enter your GSTIN, or turn off GST registration." });
    }
    if (value.gst_number) {
      const gstState = value.gst_number.slice(0, 2);
      if (!value.state_code && core.stateByCode(gstState)) value.state_code = gstState;
      else if (value.state_code && value.state_code !== gstState) {
        errors.push({ field: "state_code", message: `Your GSTIN belongs to state code ${gstState}, but a different state is selected.` });
      }
      if (value.pan && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]/.test(value.gst_number) && value.gst_number.slice(2, 12) !== value.pan) {
        errors.push({ field: "pan", message: "PAN does not match the PAN inside your GSTIN." });
      }
    }
    if (value.show_upi_qr && !value.upi_id) errors.push({ field: "upi_id", message: "Add a UPI ID to show a payment QR code." });

    let nextInvoiceNumber = null;
    if (req.body.next_invoice_number !== undefined && req.body.next_invoice_number !== "") {
      const parsed = rules.int(1, 999999999)(req.body.next_invoice_number, "Next invoice number");
      if (parsed.error) errors.push({ field: "next_invoice_number", message: parsed.error });
      else nextInvoiceNumber = parsed.value;
    }
    if (errors.length) throw badRequest(errors);

    value.state = value.state_code ? core.stateByCode(value.state_code).name : String(req.body.state || "").trim().slice(0, 80);

    await withTransaction(async (client) => {
      const columns = Object.keys(value);
      await client.query(
        `UPDATE businesses SET ${columns.map((column, i) => `${column} = $${i + 1}`).join(", ")}, updated_at = now()
         WHERE user_id = $${columns.length + 1}`,
        [...columns.map((column) => value[column]), req.user.id]
      );
      if (nextInvoiceNumber !== null) {
        const scope = core.sequenceScope(value.invoice_reset, req.today);
        await client.query(
          `INSERT INTO document_sequences (user_id, kind, scope, last_value) VALUES ($1, 'invoice', $2, $3)
           ON CONFLICT (user_id, kind, scope) DO UPDATE SET last_value = EXCLUDED.last_value, updated_at = now()`,
          [req.user.id, scope, nextInvoiceNumber - 1]
        );
      }
      await logActivity(client, req.user.id, {
        entityType: "business",
        action: "updated",
        summary: "Business settings updated",
      });
    });

    const business = await getBusiness(req.user.id);
    const [assets, nextNumber] = await Promise.all([
      getAssetSummary(req.user.id),
      previewNextNumber(req.user.id, business, core.todayIn(business.timezone)),
    ]);
    res.json(Object.assign(serializeBusiness(business, assets), { next_invoice_number: nextNumber }));
  })
);

router.get(
  "/business/numbering/preview",
  handle(async (req, res) => {
    const prefix = String(req.query.prefix ?? req.business.invoice_prefix);
    const padding = Math.min(Math.max(parseInt(req.query.padding, 10) || req.business.invoice_padding, 1), 8);
    if (!PREFIX_PATTERN.test(prefix)) throw badRequest([{ field: "invoice_prefix", message: "Invalid prefix." }]);
    res.json({ example: core.formatDocumentNumber(prefix, 1, padding, req.today) });
  })
);

async function storeAsset(req, res, kind) {
  if (!ASSET_KINDS.includes(kind)) throw new HttpError(404, "Not found");
  if (!req.file) throw badRequest([{ field: kind, message: "Choose an image to upload." }]);
  const mime = detectImageType(req.file.buffer);
  if (!mime) throw badRequest([{ field: kind, message: "Only PNG or JPEG images are supported." }]);
  const checksum = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO business_assets (user_id, kind, mime_type, data, byte_size, checksum, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id, kind) DO UPDATE SET
         mime_type = EXCLUDED.mime_type, data = EXCLUDED.data, byte_size = EXCLUDED.byte_size,
         checksum = EXCLUDED.checksum, updated_at = now()`,
      [req.user.id, kind, mime, req.file.buffer, req.file.size, checksum]
    );
    await logActivity(client, req.user.id, { entityType: "business", action: "asset_uploaded", summary: `Business ${kind} updated` });
  });
  res.status(201).json({ assets: await getAssetSummary(req.user.id) });
}

function uploadSingle(field) {
  return (req, res, next) =>
    upload.single(field)(req, res, (error) => {
      if (!error) return next();
      if (error.code === "LIMIT_FILE_SIZE") return next(badRequest([{ field, message: "Image must be 2 MB or smaller." }]));
      return next(badRequest([{ field, message: "Upload failed. Choose a single PNG or JPEG image." }]));
    });
}

router.post(
  "/business/assets/:kind",
  uploadLimiter,
  (req, res, next) => (ASSET_KINDS.includes(req.params.kind) ? uploadSingle("file")(req, res, next) : next(new HttpError(404, "Not found"))),
  handle((req, res) => storeAsset(req, res, req.params.kind))
);

// Backwards-compatible logo endpoint used by earlier versions of the client.
router.post("/business/logo", uploadLimiter, uploadSingle("logo"), handle((req, res) => storeAsset(req, res, "logo")));

router.get(
  "/business/assets/:kind",
  handle(async (req, res) => {
    if (!ASSET_KINDS.includes(req.params.kind)) throw new HttpError(404, "Not found");
    const result = await query("SELECT mime_type, data FROM business_assets WHERE user_id = $1 AND kind = $2", [
      req.user.id,
      req.params.kind,
    ]);
    if (!result.rows[0]) throw new HttpError(404, "Not found");
    res.setHeader("Content-Type", result.rows[0].mime_type);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Disposition", "inline");
    res.send(result.rows[0].data);
  })
);

router.delete(
  "/business/assets/:kind",
  handle(async (req, res) => {
    if (!ASSET_KINDS.includes(req.params.kind)) throw new HttpError(404, "Not found");
    await withTransaction(async (client) => {
      await client.query("DELETE FROM business_assets WHERE user_id = $1 AND kind = $2", [req.user.id, req.params.kind]);
      if (req.params.kind === "logo") {
        await client.query("UPDATE businesses SET logo_url = '' WHERE user_id = $1", [req.user.id]);
      }
      await logActivity(client, req.user.id, {
        entityType: "business",
        action: "asset_removed",
        summary: `Business ${req.params.kind} removed`,
      });
    });
    res.json({ assets: await getAssetSummary(req.user.id) });
  })
);

module.exports = router;
