const passport = require("./auth");

module.exports = (app) => {
  app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", {
      failureRedirect: "/",
    }),
    (req, res) => {
      res.redirect("/dashboard");
    }
  );

  app.get("/logout", (req, res) => {
    req.logout(() => {
      res.redirect("/");
    });
  });
};
