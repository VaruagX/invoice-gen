const express = require("express");
const { query } = require("../db");
const { handle } = require("../lib/http");
const { getAssetSummary } = require("../lib/business");
const { overdueSql } = require("../lib/invoices");

const router = express.Router();

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, created_at: user.created_at };
}

router.get("/auth/me", (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/** Everything the client needs on start-up in one request. */
router.get(
  "/bootstrap",
  handle(async (req, res) => {
    const [assets, counts] = await Promise.all([
      getAssetSummary(req.user.id),
      query(
        `SELECT
           (SELECT count(*)::int FROM invoices WHERE user_id = $1) AS invoices,
           (SELECT count(*)::int FROM customers WHERE user_id = $1 AND archived_at IS NULL) AS customers,
           (SELECT count(*)::int FROM invoices i WHERE i.user_id = $1 AND ${overdueSql("i", "$2")}) AS overdue`,
        [req.user.id, req.today]
      ),
    ]);
    const b = req.business;
    res.json({
      user: publicUser(req.user),
      today: req.today,
      business: {
        name: b.name,
        currency: b.currency,
        timezone: b.timezone,
        gst_registered: b.gst_registered,
        gst_number: b.gst_number,
        state_code: b.state_code,
        default_tax_rate: b.default_tax_rate,
        default_payment_terms: b.default_payment_terms,
        round_off: b.round_off,
        brand_color: b.brand_color,
        has_logo: Boolean(assets.logo),
        logo_url: assets.logo?.url || "",
      },
      counts: counts.rows[0],
      setup: {
        profile_complete: Boolean(b.name && b.address && (b.state_code || b.state)),
      },
    });
  })
);

module.exports = router;
