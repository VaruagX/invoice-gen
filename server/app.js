const crypto = require("crypto");
const path = require("path");
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const PgSession = require("connect-pg-simple")(session);
const passport = require("./auth");
const apiRouter = require("./api");
const { pool } = require("./db");
const { appUrl, isProduction } = require("./config");
const { securityHeaders, csrfGuard } = require("./middleware/security");

const CLIENT_DIR = path.join(__dirname, "../client");
const SHARED_DIR = path.join(__dirname, "../shared");
const UPLOADS_DIR = path.join(__dirname, "../uploads");

const sessionCookieConfig = {
  httpOnly: true,
  sameSite: "lax",
  secure: isProduction,
  maxAge: 1000 * 60 * 60 * 24 * 7,
};

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // config.js already refuses to start in production without SESSION_SECRET.
  console.warn("[server] SESSION_SECRET is not set; using a random secret (sessions reset on restart).");
  return crypto.randomBytes(32).toString("hex");
}

function errorResponse(error) {
  // Map database errors to safe, useful messages.
  switch (error.code) {
    case "23505":
      return { status: 409, message: "That record already exists." };
    case "23503":
      return { status: 409, message: "This record is linked to other records and can't be changed that way." };
    case "22P02":
    case "22007":
    case "22008":
      return { status: 400, message: "Some of the submitted values are not valid." };
    case "23514":
      return { status: 422, message: "The submitted values break a business rule. Please check the amounts." };
    default:
      break;
  }
  if (error.type === "entity.parse.failed") return { status: 400, message: "The request body is not valid JSON." };
  if (error.type === "entity.too.large") return { status: 413, message: "The request is too large." };
  const status = Number(error.status || error.statusCode) || 500;
  return { status, message: error.expose || status < 500 ? error.message : "Something went wrong. Please try again." };
}

/**
 * Build the Express application.
 * `testAuth` is only passed by the automated test suite to sign requests in
 * without Google; the production entry point (server.js) never sets it.
 */
function createApp({ testAuth } = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.set("query parser", "simple");
  app.disable("x-powered-by");

  app.use(securityHeaders({ isProduction }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(cors({ origin: appUrl, credentials: true }));

  app.use(
    session({
      name: "invoice.sid",
      store: new PgSession({ pool, createTableIfMissing: true }),
      secret: sessionSecret(),
      resave: false,
      saveUninitialized: false,
      proxy: isProduction,
      unset: "destroy",
      cookie: sessionCookieConfig,
    })
  );

  app.use(passport.initialize());
  app.use(passport.session());
  if (typeof testAuth === "function") app.use(testAuth);

  app.get("/healthz", (req, res) => res.type("text").send("ok"));

  require("./routes")(app);
  app.use("/api", csrfGuard({ allowedOrigins: [appUrl] }), apiRouter);

  const staticOptions = { index: false, maxAge: 0, fallthrough: true };
  app.use("/assets", express.static(path.join(CLIENT_DIR, "assets"), staticOptions));
  app.use("/shared", express.static(SHARED_DIR, staticOptions));
  // Logos uploaded by earlier versions were stored on disk.
  app.use("/uploads", express.static(UPLOADS_DIR, { index: false, dotfiles: "deny" }));

  const sendIndex = (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(CLIENT_DIR, "index.html"));
  };

  app.get("/", (req, res, next) => {
    if (req.isAuthenticated && req.isAuthenticated()) return res.redirect("/dashboard");
    next();
  });
  app.get("/", sendIndex);

  app.get(["/dashboard", "/dashboard/*"], (req, res) => {
    if (!req.isAuthenticated()) return res.redirect("/");
    sendIndex(req, res);
  });

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/auth/") || req.path.startsWith("/assets/")) return next();
    sendIndex(req, res);
  });

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const { status, message } = errorResponse(error);
    if (status >= 500) {
      console.error(`[error] ${req.method} ${req.path}:`, error.message, error.stack?.split("\n").slice(1, 4).join(" | "));
    }
    if (req.path.startsWith("/auth/") && req.method === "GET") {
      return res.redirect("/?auth=failed");
    }
    const body = { error: message };
    if (Array.isArray(error.errors)) body.errors = error.errors;
    if (typeof error.code === "string" && /^[A-Z_]+$/.test(error.code)) body.code = error.code;
    if (Array.isArray(error.duplicates)) body.duplicates = error.duplicates;
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp, sessionCookieConfig };
