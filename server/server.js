require("dotenv").config();

const { initDb } = require("./db");
const { appUrl, googleCallbackUrl, isProduction, port } = require("./config");
const { createApp, sessionCookieConfig } = require("./app");

console.log("[server] boot", {
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  appUrl,
  googleCallbackUrl,
  trustProxy: 1,
  sessionCookie: sessionCookieConfig,
  production: isProduction,
});

const app = createApp();

initDb()
  .then(() => {
    const server = app.listen(port, () => {
      console.log(`Server running on ${appUrl}`);
      console.log(`Google OAuth callback URL: ${googleCallbackUrl}`);
    });

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use. Stop the existing server or set PORT to another value.`);
        process.exit(1);
      }
      console.error("Server failed to start:", error);
      process.exit(1);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error.message);
    process.exit(1);
  });
