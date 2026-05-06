const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { query, upsertGoogleUser } = require("./db");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:
        process.env.GOOGLE_CALLBACK_URL ||
        `${process.env.APP_URL || `http://localhost:${process.env.PORT || 8000}`}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await upsertGoogleUser(profile);
        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const result = await query(
      "SELECT id, google_id, email, name, avatar_url, created_at FROM users WHERE id = $1",
      [id]
    );
    done(null, result.rows[0] || false);
  } catch (error) {
    done(error);
  }
});

module.exports = passport;
