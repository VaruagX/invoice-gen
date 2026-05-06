const { Pool } = require("pg");

const rawConnectionString = process.env.DATABASE_URL || process.env.DATABSE_URL;

if (!rawConnectionString) {
  throw new Error("DATABASE_URL is required to connect to Neon PostgreSQL.");
}

function normalizeConnectionString(value) {
  const url = new URL(value);
  if (url.searchParams.get("sslmode") === "require" && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}

const connectionString = normalizeConnectionString(rawConnectionString);

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id TEXT UNIQUE,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT DEFAULT '',
      gst_number TEXT DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      city TEXT DEFAULT '',
      state TEXT DEFAULT '',
      postal_code TEXT DEFAULT '',
      country TEXT DEFAULT '',
      website TEXT DEFAULT '',
      bank_details TEXT DEFAULT '',
      terms TEXT DEFAULT '',
      logo_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id)
    );

    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      gst_number TEXT DEFAULT '',
      address TEXT DEFAULT '',
      city TEXT DEFAULT '',
      state TEXT DEFAULT '',
      postal_code TEXT DEFAULT '',
      country TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      invoice_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
      due_date DATE,
      currency TEXT NOT NULL DEFAULT 'INR',
      notes TEXT DEFAULT '',
      terms TEXT DEFAULT '',
      subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
      tax_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
      total NUMERIC(12, 2) NOT NULL DEFAULT 0,
      paid_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, invoice_number),
      CHECK (status IN ('draft', 'pending', 'paid', 'overdue'))
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity NUMERIC(12, 2) NOT NULL DEFAULT 1,
      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      tax_rate NUMERIC(6, 2) NOT NULL DEFAULT 0,
      line_total NUMERIC(12, 2) NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(12, 2) NOT NULL,
      method TEXT DEFAULT '',
      transaction_id TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS google_id TEXT,
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS name TEXT,
      ADD COLUMN IF NOT EXISTS avatar_url TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    ALTER TABLE businesses
      ADD COLUMN IF NOT EXISTS name TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS gst_number TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS state TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS postal_code TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS country TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS website TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS bank_details TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS terms TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS business_id UUID,
      ADD COLUMN IF NOT EXISTS name TEXT,
      ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS gst_number TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS state TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS postal_code TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS country TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS invoice_number TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft',
      ADD COLUMN IF NOT EXISTS issue_date DATE DEFAULT CURRENT_DATE,
      ADD COLUMN IF NOT EXISTS due_date DATE,
      ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR',
      ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS terms TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_total NUMERIC(12, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total NUMERIC(12, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS paid_total NUMERIC(12, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    ALTER TABLE invoice_items
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS quantity NUMERIC(12, 2) DEFAULT 1,
      ADD COLUMN IF NOT EXISTS price NUMERIC(12, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS line_total NUMERIC(12, 2) DEFAULT 0;

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS user_id UUID,
      ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2),
      ADD COLUMN IF NOT EXISTS method TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS transaction_id TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
  `);

  await query(`
    ALTER TABLE businesses ALTER COLUMN business_name DROP NOT NULL;
    ALTER TABLE customers ALTER COLUMN customer_name DROP NOT NULL;
    ALTER TABLE invoice_items ALTER COLUMN item_name DROP NOT NULL;
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (email);
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_unique_idx ON users (google_id) WHERE google_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS businesses_user_id_unique_idx ON businesses (user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_user_number_unique_idx ON invoices (user_id, invoice_number);
  `);
}

async function upsertGoogleUser(profile) {
  const email = profile.emails?.[0]?.value;
  if (!email) {
    throw new Error("Google account did not provide an email address.");
  }

  const avatar = profile.photos?.[0]?.value || "";
  const result = await query(
    `
      INSERT INTO users (google_id, email, name, avatar_url, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (email)
      DO UPDATE SET
        google_id = EXCLUDED.google_id,
        name = EXCLUDED.name,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = NOW()
      RETURNING id, google_id, email, name, avatar_url, created_at
    `,
    [profile.id, email, profile.displayName || email, avatar]
  );

  const user = result.rows[0];
  await query(
    `
      INSERT INTO businesses (user_id, name, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [user.id, `${user.name}'s Business`, user.email]
  );

  return user;
}

module.exports = {
  pool,
  query,
  initDb,
  upsertGoogleUser,
};
