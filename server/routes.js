const passport = require("./auth");
const { googleCallbackUrl } = require("./config");

// Where the SPA should land after successful auth.
// This is intentionally `/` because this app serves the SPA from `/`.
const postAuthRedirect = "/";


function saveSessionAndRedirect(req, res, next, target) {
  req.session.save((error) => {
    if (error) {
      return next(error);
    }

    res.redirect(target);
  });
}

module.exports = (app) => {
  console.log("[auth] Routes mounted: /auth/google and /auth/google/callback");

  app.get("/auth/google", (req, res, next) => {
    console.log(`Starting Google OAuth flow. Callback URL: ${googleCallbackUrl}`);
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
        console.error("Google OAuth callback failed:", error);
        return next(error);
      }

      if (!user) {
        console.warn("Google OAuth did not return a user.", info || {});
        console.warn("[auth] Callback missing user. Redirecting to home.");
        return res.redirect("/" + "?auth=failed");
      }

      console.log("[auth] Google OAuth authenticated user", {
        userId: user && user.id,
        email: user && user.email,
      });

      req.logIn(user, (loginError) => {
        if (loginError) {
          console.error("Google OAuth login session failed:", loginError);
          return next(loginError);
        }

        // Redirect to a route that is guaranteed to exist.
        // This app serves the SPA from `/` and uses hash/history for internal pages.
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

        res.clearCookie("invoice.sid");
        res.redirect("/");
      });
    });
  });
};
