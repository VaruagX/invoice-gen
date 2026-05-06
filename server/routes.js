const passport = require("./auth");
const { googleCallbackUrl } = require("./config");

function saveSessionAndRedirect(req, res, next, target) {
  req.session.save((error) => {
    if (error) {
      return next(error);
    }

    res.redirect(target);
  });
}

module.exports = (app) => {
  app.get("/auth/google", (req, res, next) => {
    console.log(`Starting Google OAuth flow. Callback URL: ${googleCallbackUrl}`);
    passport.authenticate("google", { scope: ["profile", "email"] })(
      req,
      res,
      next
    );
  });

  app.get("/auth/google/callback", (req, res, next) => {
    passport.authenticate("google", (error, user, info) => {
      if (error) {
        console.error("Google OAuth callback failed:", error);
        return next(error);
      }

      if (!user) {
        console.warn("Google OAuth did not return a user.", info || {});
        return res.redirect("/?auth=failed");
      }

      req.logIn(user, (loginError) => {
        if (loginError) {
          console.error("Google OAuth login session failed:", loginError);
          return next(loginError);
        }

        saveSessionAndRedirect(req, res, next, "/dashboard");
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
