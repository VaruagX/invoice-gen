-- 001_baseline
--
-- Creates the original Invoice Studio tables on a fresh database, matching the
-- structure the production Neon database already has (UUID primary keys).
-- Every statement is idempotent, so on an existing database this migration only
-- fills in anything an earlier version of initDb() would have added.
--
-- Nothing in this file drops tables, drops columns or deletes rows.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users'
      AND column_name = 'id' AND data_type <> 'uuid'
  ) THEN
    RAISE EXCEPTION 'users.id is not a UUID column. This database was created with integer IDs and needs a manual migration; no changes were made.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id text UNIQUE,
  email text NOT NULL UNIQUE,
  name text,
  avatar_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text DEFAULT '',
  gst_number text DEFAULT '',
  email text DEFAULT '',
  phone text DEFAULT '',
  address text DEFAULT '',
  city text DEFAULT '',
  state text DEFAULT '',
  postal_code text DEFAULT '',
  country text DEFAULT '',
  website text DEFAULT '',
  bank_details text DEFAULT '',
  terms text DEFAULT '',
  logo_url text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid,
  name text,
  email text DEFAULT '',
  phone text DEFAULT '',
  gst_number text DEFAULT '',
  address text DEFAULT '',
  city text DEFAULT '',
  state text DEFAULT '',
  postal_code text DEFAULT '',
  country text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id),
  invoice_number text NOT NULL,
  status text DEFAULT 'draft',
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  currency text DEFAULT 'INR',
  notes text DEFAULT '',
  terms text DEFAULT '',
  subtotal numeric(12, 2) DEFAULT 0,
  tax_total numeric(12, 2) DEFAULT 0,
  total numeric(12, 2) DEFAULT 0,
  paid_total numeric(12, 2) DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE,
  description text,
  quantity numeric(12, 2) DEFAULT 1,
  price numeric(12, 2) DEFAULT 0,
  tax_rate numeric(6, 2) DEFAULT 0,
  line_total numeric(12, 2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE,
  user_id uuid,
  amount numeric(12, 2),
  method text DEFAULT '',
  transaction_id text DEFAULT '',
  notes text DEFAULT '',
  paid_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- Columns that earlier versions of initDb() added to pre-existing tables.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_id text,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS name text DEFAULT '',
  ADD COLUMN IF NOT EXISTS gst_number text DEFAULT '',
  ADD COLUMN IF NOT EXISTS email text DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone text DEFAULT '',
  ADD COLUMN IF NOT EXISTS address text DEFAULT '',
  ADD COLUMN IF NOT EXISTS city text DEFAULT '',
  ADD COLUMN IF NOT EXISTS state text DEFAULT '',
  ADD COLUMN IF NOT EXISTS postal_code text DEFAULT '',
  ADD COLUMN IF NOT EXISTS country text DEFAULT '',
  ADD COLUMN IF NOT EXISTS website text DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_details text DEFAULT '',
  ADD COLUMN IF NOT EXISTS terms text DEFAULT '',
  ADD COLUMN IF NOT EXISTS logo_url text DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS email text DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone text DEFAULT '',
  ADD COLUMN IF NOT EXISTS gst_number text DEFAULT '',
  ADD COLUMN IF NOT EXISTS address text DEFAULT '',
  ADD COLUMN IF NOT EXISTS city text DEFAULT '',
  ADD COLUMN IF NOT EXISTS state text DEFAULT '',
  ADD COLUMN IF NOT EXISTS postal_code text DEFAULT '',
  ADD COLUMN IF NOT EXISTS country text DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS notes text DEFAULT '',
  ADD COLUMN IF NOT EXISTS terms text DEFAULT '',
  ADD COLUMN IF NOT EXISTS subtotal numeric(12, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_total numeric(12, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total numeric(12, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_total numeric(12, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS quantity numeric(12, 2) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS price numeric(12, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate numeric(6, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_total numeric(12, 2) DEFAULT 0;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS amount numeric(12, 2),
  ADD COLUMN IF NOT EXISTS method text DEFAULT '',
  ADD COLUMN IF NOT EXISTS transaction_id text DEFAULT '',
  ADD COLUMN IF NOT EXISTS notes text DEFAULT '',
  ADD COLUMN IF NOT EXISTS paid_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Legacy columns from the very first schema were NOT NULL; the app no longer writes them.
DO $$
DECLARE
  legacy record;
BEGIN
  FOR legacy IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.is_nullable = 'NO'
      AND (c.table_name, c.column_name) IN (
        ('businesses', 'business_name'),
        ('customers', 'customer_name'),
        ('invoice_items', 'item_name')
      )
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', legacy.table_name, legacy.column_name);
  END LOOP;
END $$;

-- Required by ON CONFLICT clauses in the application.
CREATE UNIQUE INDEX IF NOT EXISTS businesses_user_id_unique_idx ON businesses (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_user_number_unique_idx ON invoices (user_id, invoice_number);
