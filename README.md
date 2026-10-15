# Invoice Studio

Invoice management for small businesses: GST-ready invoices, payment tracking, overdue follow-up, customer records and reports.

- **Frontend:** HTML, CSS and vanilla JavaScript (ES modules, no build step) in `client/`
- **Backend:** Node.js + Express in `server/`
- **Database:** PostgreSQL (Neon in production)
- **Auth:** Google OAuth via Passport, sessions stored in PostgreSQL
- **PDF:** PDFKit with the bundled Inter font (so ₹ renders correctly)

## Quick start

```bash
npm install
cp .env.example .env      # then fill in real values
npm run migrate:status    # see which migrations would run
npm start                 # http://localhost:8000
```

`npm start` applies pending migrations before it starts listening (set `AUTO_MIGRATE=false` to require running `npm run migrate` yourself first).

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string (`DATABSE_URL` is also accepted for older `.env` files) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | Google OAuth credentials |
| `SESSION_SECRET` | yes in production | Long random string used to sign session cookies |
| `PORT` | no | Defaults to `8000` |
| `NODE_ENV` | no | `production` enables secure cookies and HSTS |
| `APP_URL` | no | Public URL of the app (used for CORS/CSRF origin checks) |
| `GOOGLE_CALLBACK_URL` | no | Explicit OAuth callback URL (defaults to `APP_URL/auth/google/callback`) |
| `AUTO_MIGRATE` | no | `false` stops the server from applying migrations on boot |
| `DATABASE_POOL_MAX` | no | Max database connections (default 10) |
| `TEST_DATABASE_URL` | tests only | Local, disposable database for `npm test` |

## Database migrations

Migrations live in `server/migrations/` and are tracked in a `schema_migrations` table. Each runs in its own transaction under an advisory lock, so a failed migration is rolled back completely and two app instances can't apply the same migration twice.

```bash
npm run migrate:status   # list applied / pending migrations
npm run migrate          # apply pending migrations
```

- `001_baseline.sql` creates the original tables on an empty database (matching the existing production structure, UUID keys). On an existing database it is effectively a no-op.
- `002_business_features.sql` adds GST fields, discounts, payment tracking, numbering, branding images and activity history. It **never drops tables, columns or rows**. Points worth reviewing before running it on production:
  - The global unique constraint on `invoice_number` is replaced by the existing per-account unique index, so different accounts can use the same number.
  - Deleting a customer or invoice no longer cascades to invoices/payments; the app blocks deletion and offers archive/cancel instead.
  - Statuses become `draft`, `unpaid`, `partially_paid`, `paid`, `cancelled`. Legacy `pending`/`overdue` become `unpaid`; "overdue" is now calculated from the due date.
  - Invoices previously marked **paid without any payment record** get one payment row for the unpaid balance, labelled *"Recorded automatically during the upgrade"* with `source = 'migration'`, so collected-revenue figures keep matching what was recorded before.
  - Legacy `timestamp` columns are converted to `timestamptz` (values were stored in UTC).
  - Invoice numbering continues after the highest number already used by each account.

**Recommended for production:** take a Neon branch or backup first, run `npm run migrate:status`, then `npm run migrate`, then deploy.

## Commands

```bash
npm start                # production server
npm run dev              # restart on file changes (node --watch)
npm run migrate          # apply migrations
npm run migrate:status   # show migration state
npm test                 # unit + API tests (see below)
```

## Tests

```bash
createdb invoice_test   # any local PostgreSQL 13+
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/invoice_test npm test
```

- `test/invoice-core.test.js` – money parsing, rounding, discounts, CGST/SGST/IGST, reverse charge, round-off, amount in words, GSTIN/PAN checks, numbering.
- `test/api.test.js` – the real Express app against PostgreSQL: GST resolution, server-side recalculation, concurrent invoice numbering, partial/multiple/concurrent payments, overdue logic, deletion rules, reports/CSV, PDFs, uploads and cross-account isolation.

The API suite **wipes the database it points at**, so it refuses to run unless `TEST_DATABASE_URL` is on localhost and the database name contains `test`. Without `TEST_DATABASE_URL` the API tests are skipped.

## Project layout

```
client/                    Single-page app served at /dashboard
  assets/css/styles.css    Design system and responsive/print styles
  assets/js/app.js         Shell, routing, global search
  assets/js/lib/           Safe templating, API client, UI kit, router
  assets/js/components/    Invoice document, charts, payment & customer dialogs
  assets/js/pages/         One module per page
shared/invoice-core.js     Calculation engine shared by browser and server
server/
  server.js                Entry point (boot, migrations, listen)
  app.js                   Express app: security headers, sessions, routes
  auth.js, routes.js       Google OAuth (unchanged flow)
  api.js                   /api router: auth, account scoping, rate limits
  routes/                  dashboard, business, customers, invoices, payments, reports, search
  lib/                     invoices, payments, validation, CSV, PDF rendering
  migrations/              SQL migrations
  assets/fonts/            Inter (SIL Open Font License, see OFL.txt)
test/                      node:test suites
```

## How key rules work

- **Money** is calculated in integer paise (BigInt for products), so there are no floating-point errors. The browser preview and the server use the same `shared/invoice-core.js`; the server always recalculates and ignores totals sent by the client.
- **GST**: "Auto" compares the business state with the place of supply (CGST + SGST within a state, IGST otherwise or for exports). Unregistered businesses can't issue GST invoices. Reverse-charge invoices show GST but exclude it from the amount payable. These follow the details entered; the app does not verify GSTINs with the GST portal or guarantee compliance for every transaction.
- **Numbering** is allocated inside the save transaction from a row-locked counter, with optional reset per calendar or financial year.
- **Payments** are recorded, never deleted: a wrong payment is *voided* with a reason. Payments can't exceed the balance due, and an invoice becomes paid only when recorded payments cover the total. Invoice Studio does not collect money; the optional UPI QR code only pre-fills the customer's UPI app.
- **Overdue** = issued, past due date (in the business time zone) and balance > 0 — including partially paid invoices, never paid or cancelled ones.
- **Security**: every query is scoped to the signed-in account; record IDs from another account return 404. State-changing API calls require an `X-Requested-With` header and a same-origin `Origin` (CSRF protection). Strict Content-Security-Policy, rate limiting on auth/API/uploads/exports, image uploads verified by file signature and stored in the database.
