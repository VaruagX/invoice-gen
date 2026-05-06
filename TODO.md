# OAuth Fix Plan - Invoice Generator

- [x] Step 1: Fix `/auth/google/callback` redirect target (avoid missing routes) and add detailed callback logging.

- [x] Step 2: Ensure login flow always redirects to an existing SPA route (`/` + hash or `/dashboard` only if exists). Add success/failure debug logs.

- [x] Step 3: Harden Passport GoogleStrategy configuration (callbackURL selection + safer options) and add authentication error logging.

- [x] Step 4: Refactor config logic so callback URL switching uses `NODE_ENV`, `PORT`, and `process.env.GOOGLE_CALLBACK_URL` without conflicts.

- [x] Step 5: Fix express-session + cookie settings for Render compatibility (trust proxy, secure, sameSite) and ensure session save works.

- [ ] Step 6: Cleanup/remove broken localhost fallback logic and any duplicate auth routing.
- [ ] Step 7: Validate frontend behavior (login button uses `/auth/google` only; remove any leftover hardcoded URLs if present).
- [ ] Step 8: Verify locally + production: no redirect_uri_mismatch, no 404 callback, session persists after login.

