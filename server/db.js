const { Pool, types } = require("pg");

// Return DATE columns as plain "YYYY-MM-DD" strings. Parsing them into JS Dates
// shifts the day when the server's time zone is ahead of UTC (e.g. IST).
types.setTypeParser(1082, (value) => value);

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
const isLocalDatabase = ["localhost", "127.0.0.1", "::1"].includes(new URL(rawConnectionString).hostname);

const pool = new Pool({
  connectionString,
  ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
  max: Number(process.env.DATABASE_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on("error", (error) => {
  console.error("[db] Idle client error:", error.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

/** Run fn(client) inside a transaction; rolls back on any error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function initDb() {
  const { runMigrations, migrationStatus } = require("./migrate");
  if (process.env.AUTO_MIGRATE === "false") {
    const pending = (await migrationStatus(pool)).filter((row) => !row.applied);
    if (pending.length) {
      throw new Error(
        `Database has pending migrations (${pending.map((row) => row.id).join(", ")}). Run "npm run migrate" first.`
      );
    }
    return;
  }
  const applied = await runMigrations(pool);
  if (applied.length) console.log(`[db] Applied migrations: ${applied.join(", ")}`);
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
  withTransaction,
  initDb,
  upsertGoogleUser,
};
