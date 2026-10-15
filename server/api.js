const express = require("express");
const core = require("../shared/invoice-core");
const { getBusiness } = require("./lib/business");
const { HttpError } = require("./lib/http");
const { rateLimit } = require("./middleware/security");

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user) return next();
  return res.status(401).json({ error: "Authentication required" });
}

/** Load the signed-in user's business once per request; every query is scoped by req.user.id. */
async function loadAccount(req, res, next) {
  try {
    req.business = await getBusiness(req.user.id);
    req.today = core.todayIn(req.business.timezone);
    next();
  } catch (error) {
    next(error);
  }
}

router.use(requireAuth);
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    keyPrefix: "api",
    message: "You're making requests very quickly. Please wait a moment.",
  })
);
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyPrefix: "api-write",
  message: "Too many changes in a short time. Please wait a moment and try again.",
});
router.use((req, res, next) => {
  if (["GET", "HEAD"].includes(req.method)) return next();
  return writeLimiter(req, res, next);
});
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(loadAccount);

router.use(require("./routes/account"));
router.use(require("./routes/dashboard"));
router.use(require("./routes/business"));
router.use(require("./routes/customers"));
router.use(require("./routes/invoices"));
router.use(require("./routes/payments"));
router.use(require("./routes/reports"));
router.use(require("./routes/search"));

router.use((req, res, next) => next(new HttpError(404, "Not found")));

module.exports = router;
module.exports.requireAuth = requireAuth;
