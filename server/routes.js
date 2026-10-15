const passport = require("./auth");
const { googleCallbackUrl, isProduction } = require("./config");
const { rateLimit } = require("./middleware/security");

// Where the SPA should land after successful auth.
// This is intentionally `/` because this app serves the SPA from `/`.
const postAuthRedirect = "/";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyPrefix: "auth",
  key: (req) => req.ip,
  message: "Too many sign-in attempts. Please wait a few minutes and try again.",
});

function saveSessionAndRedirect(req, res, next, target) {
  req.session.save((error) => {
    if (error) {
      console.error("[auth] Failed to save session before redirect", error.message);
      return next(error);
    }

    console.log("[auth] Session saved. Redirecting after login.");
    res.redirect(target);
  });
}

function logout(req, res, next) {
  req.logout((logoutError) => {
    if (logoutError) {
      return next(logoutError);
    }

    req.session.destroy((sessionError) => {
      if (sessionError) {
        return next(sessionError);
      }

      res.clearCookie("invoice.sid", {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
      });
      res.redirect("/");
    });
  });
}

module.exports = (app) => {
  console.log("[auth] Routes mounted: /auth/google and /auth/google/callback");

  app.get("/auth/google", authLimiter, (req, res, next) => {
    console.log("[auth] Starting Google OAuth flow", { callbackURL: googleCallbackUrl });
    passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
  });

  app.get("/auth/google/callback", authLimiter, (req, res, next) => {
    passport.authenticate("google", (error, user, info) => {
      if (error) {
        console.error("[auth] Google OAuth callback failed:", error.message);
        return next(error);
      }

      if (!user) {
        console.warn("[auth] Google OAuth did not return a user", info?.message || "");
        return res.redirect("/" + "?auth=failed");
      }

      req.logIn(user, (loginError) => {
        if (loginError) {
          console.error("[auth] Google OAuth login session failed:", loginError.message);
          return next(loginError);
        }

        saveSessionAndRedirect(req, res, next, postAuthRedirect);
      });
    })(req, res, next);
  });

  // GET is kept for existing links; a cross-site page cannot trigger it.
  app.get("/logout", (req, res, next) => {
    if (req.get("sec-fetch-site") === "cross-site") return res.redirect("/");
    logout(req, res, next);
  });

  app.post("/logout", (req, res, next) => {
    if (req.get("sec-fetch-site") === "cross-site") return res.status(403).end();
    logout(req, res, next);
  });
};
