-- 002_business_features
--
-- Adds GST-ready invoicing, payment tracking, numbering, branding and activity
-- history. This migration is additive:
--   * no tables or columns are dropped and no rows are deleted;
--   * money columns are widened (never narrowed);
--   * legacy columns (business_name, customer_name, total_amount, ...) are kept
--     and only used to fill canonical columns that are empty.
--
-- Two constraint changes deserve attention when reviewing:
--   1. invoices_invoice_number_key (globally unique invoice_number) is replaced
--      by the existing per-account unique index (user_id, invoice_number), so
--      two businesses can both have INV-2026-0001.
--   2. Foreign keys from invoices -> customers and payments -> invoices no
--      longer cascade deletes. Deleting a customer used to silently delete all
--      of their invoices; the database now refuses instead.
--
-- Legacy invoices that were marked "paid" without any payment record get one
-- payment row (source = 'migration') for their unpaid balance, so that revenue
-- figures, which are now based on recorded payments, keep matching what the
-- user previously recorded. These rows are clearly labelled.

-- ---------------------------------------------------------------------------
-- Consistent timestamps: legacy columns were "timestamp without time zone"
-- holding UTC values (Neon's default session time zone).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN ('users', 'businesses', 'customers', 'invoices', 'invoice_items', 'payments')
      AND column_name IN ('created_at', 'updated_at')
      AND data_type = 'timestamp without time zone'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',
      col.table_name, col.column_name, col.column_name
    );
  END LOOP;
END $$;

-- Copy values from legacy columns into canonical columns when the canonical one is empty.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'profile_image') THEN
    UPDATE users SET avatar_url = profile_image WHERE coalesce(avatar_url, '') = '' AND coalesce(profile_image, '') <> '';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'businesses' AND column_name = 'business_name') THEN
    UPDATE businesses SET name = business_name WHERE coalesce(name, '') = '' AND coalesce(business_name, '') <> '';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = 'customer_name') THEN
    UPDATE customers SET name = customer_name WHERE coalesce(name, '') = '' AND coalesce(customer_name, '') <> '';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'invoice_items' AND column_name = 'item_name') THEN
    UPDATE invoice_items SET description = item_name WHERE coalesce(description, '') = '' AND coalesce(item_name, '') <> '';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'invoice_items' AND column_name = 'tax_percent') THEN
    UPDATE invoice_items SET tax_rate = tax_percent WHERE coalesce(tax_rate, 0) = 0 AND coalesce(tax_percent, 0) <> 0;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'invoice_items' AND column_name = 'total') THEN
    UPDATE invoice_items SET line_total = total WHERE coalesce(line_total, 0) = 0 AND coalesce(total, 0) <> 0;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'invoices' AND column_name = 'total_amount') THEN
    UPDATE invoices SET total = total_amount WHERE coalesce(total, 0) = 0 AND coalesce(total_amount, 0) <> 0;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'invoices' AND column_name = 'tax_amount') THEN
    UPDATE invoices SET tax_total = tax_amount WHERE coalesce(tax_total, 0) = 0 AND coalesce(tax_amount, 0) <> 0;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'payments' AND column_name = 'payment_method') THEN
    UPDATE payments SET method = payment_method WHERE coalesce(method, '') = '' AND coalesce(payment_method, '') <> '';
  END IF;
END $$;

-- GST state codes, used to derive state_code from free-text state names.
CREATE TEMPORARY TABLE tmp_gst_states (code text, name text) ON COMMIT DROP;
INSERT INTO tmp_gst_states (code, name) VALUES
  ('01', 'jammu and kashmir'), ('02', 'himachal pradesh'), ('03', 'punjab'), ('04', 'chandigarh'),
  ('05', 'uttarakhand'), ('06', 'haryana'), ('07', 'delhi'), ('08', 'rajasthan'), ('09', 'uttar pradesh'),
  ('10', 'bihar'), ('11', 'sikkim'), ('12', 'arunachal pradesh'), ('13', 'nagaland'), ('14', 'manipur'),
  ('15', 'mizoram'), ('16', 'tripura'), ('17', 'meghalaya'), ('18', 'assam'), ('19', 'west bengal'),
  ('20', 'jharkhand'), ('21', 'odisha'), ('22', 'chhattisgarh'), ('23', 'madhya pradesh'), ('24', 'gujarat'),
  ('26', 'dadra and nagar haveli and daman and diu'), ('27', 'maharashtra'), ('29', 'karnataka'), ('30', 'goa'),
  ('31', 'lakshadweep'), ('32', 'kerala'), ('33', 'tamil nadu'), ('34', 'puducherry'),
  ('35', 'andaman and nicobar islands'), ('36', 'telangana'), ('37', 'andhra pradesh'), ('38', 'ladakh'),
  ('97', 'other territory');

-- ---------------------------------------------------------------------------
-- Businesses: settings for GST, numbering, payments and branding.
-- ---------------------------------------------------------------------------
UPDATE businesses SET
  name = coalesce(name, ''), gst_number = upper(coalesce(gst_number, '')), email = coalesce(email, ''),
  phone = coalesce(phone, ''), address = coalesce(address, ''), city = coalesce(city, ''),
  state = coalesce(state, ''), postal_code = coalesce(postal_code, ''), country = coalesce(country, ''),
  website = coalesce(website, ''), bank_details = coalesce(bank_details, ''), terms = coalesce(terms, ''),
  logo_url = coalesce(logo_url, '');

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS pan text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS state_code text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS gst_registered boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS default_tax_rate numeric(5, 2) NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS default_payment_terms integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS invoice_prefix text NOT NULL DEFAULT 'INV-{YYYY}-',
  ADD COLUMN IF NOT EXISTS invoice_padding smallint NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS invoice_reset text NOT NULL DEFAULT 'never',
  ADD COLUMN IF NOT EXISTS receipt_prefix text NOT NULL DEFAULT 'RCPT-',
  ADD COLUMN IF NOT EXISTS default_notes text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS default_payment_instructions text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_account_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_account_number text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_ifsc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_branch text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS upi_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS show_upi_qr boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signatory_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS signatory_title text NOT NULL DEFAULT 'Authorised Signatory',
  ADD COLUMN IF NOT EXISTS show_signature_block boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS brand_color text NOT NULL DEFAULT '#2563eb',
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN IF NOT EXISTS round_off boolean NOT NULL DEFAULT false;

UPDATE businesses SET gst_registered = true WHERE gst_number <> '';
UPDATE businesses SET state_code = substring(gst_number FROM 1 FOR 2)
  WHERE state_code = '' AND gst_number ~ '^[0-9]{2}[0-9A-Z]{13}$';
UPDATE businesses b SET state_code = s.code
  FROM tmp_gst_states s WHERE b.state_code = '' AND lower(trim(b.state)) = s.name;

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_invoice_reset_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_invoice_reset_check
  CHECK (invoice_reset IN ('never', 'yearly', 'financial_year'));
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_invoice_padding_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_invoice_padding_check CHECK (invoice_padding BETWEEN 1 AND 8);

-- ---------------------------------------------------------------------------
-- Customers: CRM fields and safe archiving.
-- ---------------------------------------------------------------------------
UPDATE customers SET
  email = coalesce(email, ''), phone = coalesce(phone, ''), gst_number = upper(coalesce(gst_number, '')),
  address = coalesce(address, ''), city = coalesce(city, ''), state = coalesce(state, ''),
  postal_code = coalesce(postal_code, ''), country = coalesce(country, '');

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS company_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pan text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS state_code text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS shipping_address text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

UPDATE customers SET state_code = substring(gst_number FROM 1 FOR 2)
  WHERE state_code = '' AND gst_number ~ '^[0-9]{2}[0-9A-Z]{13}$';
UPDATE customers c SET state_code = s.code
  FROM tmp_gst_states s WHERE c.state_code = '' AND lower(trim(c.state)) = s.name;

-- ---------------------------------------------------------------------------
-- Invoices: wider money columns, GST and discount fields, snapshots.
-- ---------------------------------------------------------------------------
UPDATE invoices SET
  subtotal = coalesce(subtotal, 0), tax_total = coalesce(tax_total, 0), total = coalesce(total, 0),
  paid_total = coalesce(paid_total, 0), notes = coalesce(notes, ''), terms = coalesce(terms, ''),
  currency = coalesce(nullif(currency, ''), 'INR'), status = lower(coalesce(status, 'draft'));

ALTER TABLE invoices
  ALTER COLUMN subtotal TYPE numeric(14, 2),
  ALTER COLUMN tax_total TYPE numeric(14, 2),
  ALTER COLUMN total TYPE numeric(14, 2),
  ALTER COLUMN paid_total TYPE numeric(14, 2),
  ALTER COLUMN subtotal SET NOT NULL, ALTER COLUMN subtotal SET DEFAULT 0,
  ALTER COLUMN tax_total SET NOT NULL, ALTER COLUMN tax_total SET DEFAULT 0,
  ALTER COLUMN total SET NOT NULL, ALTER COLUMN total SET DEFAULT 0,
  ALTER COLUMN paid_total SET NOT NULL, ALTER COLUMN paid_total SET DEFAULT 0,
  ALTER COLUMN notes SET NOT NULL, ALTER COLUMN notes SET DEFAULT '',
  ALTER COLUMN terms SET NOT NULL, ALTER COLUMN terms SET DEFAULT '',
  ALTER COLUMN currency SET NOT NULL, ALTER COLUMN currency SET DEFAULT 'INR',
  ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS tax_type text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS gst_treatment text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS place_of_supply text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reverse_charge boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discount_type text NOT NULL DEFAULT 'percent',
  ADD COLUMN IF NOT EXISTS discount_value numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS item_discount_total numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invoice_discount_amount numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_total numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxable_total numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cgst_total numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_total numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_total numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_off numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_off_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_instructions text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS customer_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS business_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS duplicated_from uuid;

-- Legacy invoices used a single, generic tax and had no discounts.
UPDATE invoices i SET
  taxable_total = i.subtotal,
  tax_type = CASE
    WHEN i.tax_total > 0 OR EXISTS (SELECT 1 FROM invoice_items it WHERE it.invoice_id = i.id AND it.tax_rate > 0)
    THEN 'simple' ELSE 'none' END
WHERE i.customer_snapshot IS NULL AND i.taxable_total = 0;
UPDATE invoices SET gst_treatment = tax_type WHERE customer_snapshot IS NULL;
UPDATE invoices SET issued_at = coalesce(created_at, now()) WHERE issued_at IS NULL AND status <> 'draft';

-- Invoice numbers are unique per account, not across all accounts.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_invoice_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_user_number_unique_idx ON invoices (user_id, invoice_number);

-- Deleting a customer must never delete their invoices.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_customer_id_fkey;
ALTER TABLE invoices ADD CONSTRAINT invoices_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE NO ACTION;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_duplicated_from_fkey;
ALTER TABLE invoices ADD CONSTRAINT invoices_duplicated_from_fkey
  FOREIGN KEY (duplicated_from) REFERENCES invoices(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Invoice items: HSN/SAC, discounts and per-line tax breakdown.
-- ---------------------------------------------------------------------------
UPDATE invoice_items SET
  description = coalesce(description, ''), quantity = coalesce(quantity, 1), price = coalesce(price, 0),
  tax_rate = coalesce(tax_rate, 0), line_total = coalesce(line_total, 0);

ALTER TABLE invoice_items
  ALTER COLUMN quantity TYPE numeric(14, 3),
  ALTER COLUMN price TYPE numeric(14, 2),
  ALTER COLUMN line_total TYPE numeric(14, 2),
  ALTER COLUMN description SET NOT NULL, ALTER COLUMN description SET DEFAULT '',
  ALTER COLUMN quantity SET NOT NULL, ALTER COLUMN quantity SET DEFAULT 1,
  ALTER COLUMN price SET NOT NULL, ALTER COLUMN price SET DEFAULT 0,
  ALTER COLUMN tax_rate SET NOT NULL, ALTER COLUMN tax_rate SET DEFAULT 0,
  ALTER COLUMN line_total SET NOT NULL, ALTER COLUMN line_total SET DEFAULT 0;

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hsn_sac text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS discount_type text NOT NULL DEFAULT 'percent',
  ADD COLUMN IF NOT EXISTS discount_value numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gross_amount numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invoice_discount_share numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxable_amount numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cgst_amount numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_amount numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_amount numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount numeric(14, 2) NOT NULL DEFAULT 0;

-- Legacy items: keep their stored line totals exactly; derive the breakdown.
-- UUID ids carry no order, so the physical insertion order (ctid) is used.
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY invoice_id ORDER BY ctid) - 1 AS pos
  FROM invoice_items
)
UPDATE invoice_items it SET
  position = ordered.pos,
  gross_amount = round(it.quantity * it.price, 2),
  taxable_amount = round(it.quantity * it.price, 2),
  tax_amount = CASE
    WHEN it.line_total >= round(it.quantity * it.price, 2) AND it.line_total > 0
      THEN it.line_total - round(it.quantity * it.price, 2)
    ELSE round(round(it.quantity * it.price, 2) * it.tax_rate / 100, 2)
  END
FROM ordered
WHERE ordered.id = it.id AND it.gross_amount = 0 AND it.taxable_amount = 0;

UPDATE invoice_items SET line_total = taxable_amount + tax_amount WHERE line_total = 0 AND taxable_amount + tax_amount > 0;

-- ---------------------------------------------------------------------------
-- Payments: auditable records with receipts and voiding instead of deletion.
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_date date,
  ADD COLUMN IF NOT EXISTS receipt_number text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE payments p SET user_id = i.user_id FROM invoices i WHERE p.invoice_id = i.id AND p.user_id IS NULL;
UPDATE payments SET
  amount = coalesce(amount, 0),
  transaction_id = coalesce(transaction_id, ''),
  notes = coalesce(notes, ''),
  payment_date = coalesce(payment_date, (paid_at AT TIME ZONE 'Asia/Kolkata')::date, (created_at AT TIME ZONE 'Asia/Kolkata')::date, CURRENT_DATE),
  method = CASE
    WHEN lower(coalesce(method, '')) IN ('upi') THEN 'upi'
    WHEN lower(coalesce(method, '')) IN ('cash') THEN 'cash'
    WHEN lower(coalesce(method, '')) IN ('card', 'credit card', 'debit card') THEN 'card'
    WHEN lower(coalesce(method, '')) IN ('cheque', 'check') THEN 'cheque'
    WHEN lower(coalesce(method, '')) IN ('bank', 'bank transfer', 'bank_transfer', 'neft', 'rtgs', 'imps') THEN 'bank_transfer'
    ELSE 'other'
  END;

ALTER TABLE payments
  ALTER COLUMN amount TYPE numeric(14, 2),
  ALTER COLUMN amount SET NOT NULL,
  ALTER COLUMN payment_date SET NOT NULL,
  ALTER COLUMN payment_date SET DEFAULT CURRENT_DATE,
  ALTER COLUMN method SET NOT NULL, ALTER COLUMN method SET DEFAULT 'other',
  ALTER COLUMN transaction_id SET NOT NULL, ALTER COLUMN transaction_id SET DEFAULT '',
  ALTER COLUMN notes SET NOT NULL, ALTER COLUMN notes SET DEFAULT '';

-- Invoices previously marked paid without a payment record.
INSERT INTO payments (invoice_id, user_id, amount, method, payment_date, paid_at, transaction_id, notes, source)
SELECT
  i.id,
  i.user_id,
  i.total - coalesce(existing.amount, 0),
  'other',
  greatest(i.issue_date, (coalesce(i.updated_at, i.created_at, now()) AT TIME ZONE 'Asia/Kolkata')::date),
  coalesce(i.updated_at, now()),
  '',
  'Recorded automatically during the upgrade: this invoice was marked as paid before payment tracking was available.',
  'migration'
FROM invoices i
LEFT JOIN (SELECT invoice_id, sum(amount) AS amount FROM payments GROUP BY invoice_id) existing ON existing.invoice_id = i.id
WHERE i.status = 'paid' AND i.user_id IS NOT NULL AND i.total - coalesce(existing.amount, 0) > 0;

-- Receipt numbers for existing payments.
WITH numbered AS (
  SELECT p.id, b.receipt_prefix,
    row_number() OVER (PARTITION BY p.user_id ORDER BY p.payment_date, p.created_at, p.id) AS n
  FROM payments p
  LEFT JOIN businesses b ON b.user_id = p.user_id
  WHERE p.receipt_number IS NULL
)
UPDATE payments p SET receipt_number = coalesce(numbered.receipt_prefix, 'RCPT-') || lpad(numbered.n::text, 4, '0')
FROM numbered WHERE numbered.id = p.id;

-- Payments must not disappear when an invoice is deleted: the app voids them instead.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_invoice_id_fkey;
ALTER TABLE payments ADD CONSTRAINT payments_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE NO ACTION;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_user_id_fkey;
ALTER TABLE payments ADD CONSTRAINT payments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;

-- ---------------------------------------------------------------------------
-- Statuses: payment state is derived from recorded payments; "overdue" is
-- computed from the due date at query time instead of being stored.
-- ---------------------------------------------------------------------------
UPDATE invoices i SET paid_total = coalesce((
  SELECT sum(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.voided_at IS NULL
), 0);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
UPDATE invoices SET status = CASE
  WHEN status = 'draft' AND paid_total = 0 THEN 'draft'
  WHEN status IN ('cancelled', 'canceled', 'void') THEN 'cancelled'
  WHEN paid_total >= total THEN 'paid'
  WHEN paid_total > 0 THEN 'partially_paid'
  ELSE 'unpaid'
END;
UPDATE invoices SET issued_at = coalesce(created_at, now()) WHERE issued_at IS NULL AND status <> 'draft';

ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'unpaid', 'partially_paid', 'paid', 'cancelled'));
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_tax_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_tax_type_check CHECK (tax_type IN ('none', 'simple', 'cgst_sgst', 'igst'));
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_gst_treatment_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_gst_treatment_check
  CHECK (gst_treatment IN ('auto', 'none', 'simple', 'cgst_sgst', 'igst'));
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_discount_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_discount_type_check CHECK (discount_type IN ('percent', 'amount'));
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_amounts_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_amounts_check
  CHECK (total >= 0 AND paid_total >= 0 AND paid_total <= total) NOT VALID;

ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_discount_type_check;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_discount_type_check CHECK (discount_type IN ('percent', 'amount'));
ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_amounts_check;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_amounts_check
  CHECK (quantity >= 0 AND price >= 0 AND tax_rate >= 0 AND tax_rate <= 100) NOT VALID;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_amount_check;
ALTER TABLE payments ADD CONSTRAINT payments_amount_check CHECK (amount > 0) NOT VALID;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('cash', 'bank_transfer', 'upi', 'card', 'cheque', 'other'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_source_check;
ALTER TABLE payments ADD CONSTRAINT payments_source_check CHECK (source IN ('manual', 'migration'));

-- ---------------------------------------------------------------------------
-- Server-side document numbering (concurrency safe via row locks).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_sequences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('invoice', 'receipt')),
  scope text NOT NULL DEFAULT '',
  last_value integer NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, scope)
);

-- Continue numbering after the highest number already used by each account.
INSERT INTO document_sequences (user_id, kind, scope, last_value)
SELECT user_id, 'invoice', '', least(max(substring(invoice_number FROM '([0-9]+)$')::numeric), 2000000000)::integer
FROM invoices
WHERE user_id IS NOT NULL AND invoice_number ~ '[0-9]+$'
GROUP BY user_id
ON CONFLICT (user_id, kind, scope) DO NOTHING;

INSERT INTO document_sequences (user_id, kind, scope, last_value)
SELECT user_id, 'receipt', '', count(*)
FROM payments WHERE user_id IS NOT NULL
GROUP BY user_id
ON CONFLICT (user_id, kind, scope) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS payments_user_receipt_unique_idx
  ON payments (user_id, receipt_number) WHERE receipt_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Branding images (logo, signature, stamp) stored in the database so they
-- survive redeploys on hosts with ephemeral disks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_assets (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('logo', 'signature', 'stamp')),
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
  data bytea NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  checksum text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

-- ---------------------------------------------------------------------------
-- Activity history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes for account-scoped queries.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS invoices_user_issue_date_idx ON invoices (user_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS invoices_user_status_due_idx ON invoices (user_id, status, due_date);
CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_position_idx ON invoice_items (invoice_id, position);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS payments_user_date_idx ON payments (user_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS customers_user_name_idx ON customers (user_id, lower(name));
CREATE INDEX IF NOT EXISTS customers_user_email_idx ON customers (user_id, lower(email));
CREATE INDEX IF NOT EXISTS activity_logs_user_created_idx ON activity_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_logs_entity_idx ON activity_logs (user_id, entity_type, entity_id, created_at DESC);
