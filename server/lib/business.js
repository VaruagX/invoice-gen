const fs = require("fs");
const path = require("path");
const core = require("../../shared/invoice-core");
const { query } = require("../db");

const UPLOADS_DIR = path.resolve(__dirname, "../../uploads");

const BUSINESS_COLUMNS = `
  id, user_id, name, gst_number, pan, email, phone, address, city, state, state_code, postal_code,
  country, website, bank_details, terms, logo_url, gst_registered, currency, default_tax_rate,
  default_payment_terms, invoice_prefix, invoice_padding, invoice_reset, receipt_prefix, default_notes,
  default_payment_instructions, bank_account_name, bank_name, bank_account_number, bank_ifsc, bank_branch,
  upi_id, show_upi_qr, signatory_name, signatory_title, show_signature_block, brand_color, timezone,
  round_off, created_at, updated_at
`;

/** Load (creating if needed) the business profile that belongs to a user. */
async function getBusiness(userId, db = { query }) {
  let result = await db.query(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE user_id = $1 LIMIT 1`, [userId]);
  if (!result.rows[0]) {
    await db.query(
      `INSERT INTO businesses (user_id, name) VALUES ($1, '') ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    result = await db.query(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE user_id = $1 LIMIT 1`, [userId]);
  }
  const business = result.rows[0];
  if (!business.state_code) {
    business.state_code =
      (core.stateByCode(String(business.gst_number || "").slice(0, 2)) && String(business.gst_number).slice(0, 2)) ||
      core.stateByName(business.state)?.code ||
      "";
  }
  return business;
}

/** Which branding images exist for the account (without loading the bytes). */
async function getAssetSummary(userId) {
  const result = await query(
    "SELECT kind, mime_type, byte_size, updated_at FROM business_assets WHERE user_id = $1",
    [userId]
  );
  const summary = {};
  result.rows.forEach((row) => {
    summary[row.kind] = {
      url: `/api/business/assets/${row.kind}?v=${new Date(row.updated_at).getTime()}`,
      size: row.byte_size,
    };
  });
  return summary;
}

/** Load branding image bytes for PDF rendering, falling back to a legacy uploaded logo file. */
async function loadAssetBuffers(userId, business) {
  const result = await query("SELECT kind, data FROM business_assets WHERE user_id = $1", [userId]);
  const assets = {};
  result.rows.forEach((row) => {
    assets[row.kind] = row.data;
  });
  if (!assets.logo && business?.logo_url && business.logo_url.startsWith("/uploads/")) {
    // Only read files inside the uploads directory, whatever the stored path says.
    const filePath = path.resolve(UPLOADS_DIR, path.basename(business.logo_url));
    if (filePath.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(filePath)) {
      try {
        const buffer = fs.readFileSync(filePath);
        if (detectImageType(buffer)) assets.logo = buffer;
      } catch (error) {
        // A missing or unreadable legacy logo should never block a PDF.
      }
    }
  }
  return assets;
}

/** Identify PNG / JPEG content from magic bytes. */
function detectImageType(buffer) {
  if (!buffer || buffer.length < 8) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  return null;
}

/** Fields captured on an invoice so it keeps showing the supplier details it was issued with. */
function businessSnapshot(business) {
  return {
    name: business.name || "",
    gst_number: business.gst_number || "",
    pan: business.pan || "",
    email: business.email || "",
    phone: business.phone || "",
    website: business.website || "",
    address: business.address || "",
    city: business.city || "",
    state: business.state || "",
    state_code: business.state_code || "",
    postal_code: business.postal_code || "",
    country: business.country || "",
  };
}

function customerSnapshot(customer) {
  if (!customer) return null;
  return {
    name: customer.name || "",
    company_name: customer.company_name || "",
    email: customer.email || "",
    phone: customer.phone || "",
    gst_number: customer.gst_number || "",
    pan: customer.pan || "",
    address: customer.address || "",
    city: customer.city || "",
    state: customer.state || "",
    state_code: customer.state_code || "",
    postal_code: customer.postal_code || "",
    country: customer.country || "",
    shipping_address: customer.shipping_address || "",
  };
}

module.exports = {
  UPLOADS_DIR,
  getBusiness,
  getAssetSummary,
  loadAssetBuffers,
  detectImageType,
  businessSnapshot,
  customerSnapshot,
};
