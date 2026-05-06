require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const passport = require("./auth");
const cors = require("cors");
const path = require("path");
const apiRouter = require("./api");
const { initDb, pool } = require("./db");

const app = express();
const PORT = Number(process.env.PORT || 8000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: APP_URL,
    credentials: true,
  })
);

// Session
app.use(
  session({
    store: new PgSession({
      pool,
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "fallback_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

// Passport
app.use(passport.initialize());
app.use(passport.session());

// Routes
require("./routes")(app);
app.use("/api", apiRouter);
app.use("/assets", express.static(path.join(__dirname, "../client/assets")));
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

app.get("/", (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.redirect("/dashboard");
  }
  next();
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

app.get(["/dashboard", "/dashboard/*"], (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({
    error: error.message || "Something went wrong",
  });
});

initDb().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Server running on ${APP_URL}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. Stop the existing server or set PORT to another value.`
      );
      process.exit(1);
    }
    console.error("Server failed to start:", error);
    process.exit(1);
  });
}).catch((error) => {
  console.error("Database initialization failed:", error);
  process.exit(1);
});
