const passport = require("./auth");
const { googleCallbackUrl, isProduction } = require("./config");

// Where the SPA should land after successful auth.
// This is intentionally `/` because this app serves the SPA from `/`.
const postAuthRedirect = "/";

function saveSessionAndRedirect(req, res, next, target) {
  req.session.save((error) => {
    if (error) {
      console.error("[auth] Failed to save session before redirect", error);
      return next(error);
    }

    console.log("[auth] Session saved. Redirecting after login.", {
      sessionID: req.sessionID,
      target,
      isAuthenticated: Boolean(req.isAuthenticated && req.isAuthenticated()),
    });
    res.redirect(target);
  });
}

module.exports = (app) => {
  console.log("[auth] Routes mounted: /auth/google and /auth/google/callback");

  app.get("/auth/google", (req, res, next) => {
    console.log("[auth] Starting Google OAuth flow", {
      callbackURL: googleCallbackUrl,
      sessionID: req.sessionID,
      secureRequest: req.secure,
      forwardedProto: req.get("x-forwarded-proto"),
    });
    passport.authenticate("google", { scope: ["profile", "email"] })(
      req,
      res,
      next
    );
  });

  app.get("/auth/google/callback", (req, res, next) => {
    console.log("[auth] Callback hit", {
      originalUrl: req.originalUrl,
      query: req.query,
      sessionHasId: Boolean(req.session && req.sessionID),
      isAuthenticated: Boolean(req.isAuthenticated && req.isAuthenticated()),
      googleCallbackUrl,
    });

    passport.authenticate("google", (error, user, info) => {
      if (error) {
        console.error("[auth] Google OAuth callback failed", error);
        return next(error);
      }

      if (!user) {
        console.warn("[auth] Google OAuth did not return a user", info || {});
        console.warn("[auth] Callback missing user. Redirecting to home.");
        return res.redirect("/" + "?auth=failed");
      }

      console.log("[auth] Google OAuth authenticated user", {
        userId: user && user.id,
        email: user && user.email,
      });

      req.logIn(user, (loginError) => {
        if (loginError) {
          console.error("[auth] Google OAuth login session failed", loginError);
          return next(loginError);
        }

        saveSessionAndRedirect(req, res, next, postAuthRedirect);
      });
    })(req, res, next);
  });

  app.get("/logout", (req, res, next) => {
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
        console.log("[auth] User logged out. Redirecting to home.");
        res.redirect("/");
      });
    });
  });
};
