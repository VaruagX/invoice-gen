const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { query, upsertGoogleUser } = require("./db");
const { googleCallbackUrl } = require("./config");

console.log("[auth] GoogleStrategy configured", {
  callbackURL: googleCallbackUrl,
  hasClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
  hasClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
});

// Keep auth module side-effect free except for strategy registration.
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: googleCallbackUrl,
      passReqToCallback: false,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        console.log("[auth] Google profile received", {
          googleId: profile.id,
          email: profile.emails?.[0]?.value,
        });

        const user = await upsertGoogleUser(profile);
        console.log("[auth] Google user upserted", {
          userId: user.id,
          email: user.email,
        });

        return done(null, user);
      } catch (error) {
        console.error("[auth] GoogleStrategy verify failed", error);
        return done(error);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  console.log("[auth] Serializing user into session", { userId: user.id });
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await query(
      "SELECT id, google_id, email, name, avatar_url, created_at FROM users WHERE id = $1",
      [id]
    );
    const user = result.rows[0] || false;
    console.log("[auth] Deserialized session user", {
      userId: id,
      found: Boolean(user),
    });
    done(null, user);
  } catch (error) {
    console.error("[auth] Failed to deserialize session user", error);
    done(error);
  }
});

module.exports = passport;
