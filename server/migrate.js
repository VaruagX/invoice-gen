const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
// Arbitrary constant shared by every app instance so only one applies migrations at a time.
const MIGRATION_LOCK_KEY = 727079017;

function loadMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      return {
        id: file.replace(/\.sql$/, ""),
        file,
        sql,
        checksum: crypto.createHash("sha256").update(sql).digest("hex"),
      };
    });
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function migrationStatus(pool) {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = new Map(
      (await client.query("SELECT id, checksum, applied_at FROM schema_migrations")).rows.map((row) => [row.id, row])
    );
    return loadMigrations().map((migration) => {
      const row = applied.get(migration.id);
      return {
        id: migration.id,
        applied: Boolean(row),
        appliedAt: row ? row.applied_at : null,
        changedSinceApplied: Boolean(row && row.checksum !== migration.checksum),
      };
    });
  } finally {
    client.release();
  }
}

/**
 * Apply pending migrations. Each migration runs in its own transaction while
 * holding a transaction-scoped advisory lock (works through connection poolers).
 */
async function runMigrations(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  const appliedNow = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await ensureMigrationsTable(client);
    await client.query("COMMIT");

    for (const migration of loadMigrations()) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
        const existing = await client.query("SELECT checksum FROM schema_migrations WHERE id = $1", [migration.id]);
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== migration.checksum) {
            log(`[migrate] note: ${migration.file} was edited after it was applied; it will not be re-run.`);
          }
          await client.query("COMMIT");
          continue;
        }
        log(`[migrate] applying ${migration.file}`);
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [
          migration.id,
          migration.checksum,
        ]);
        await client.query("COMMIT");
        appliedNow.push(migration.id);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        error.message = `Migration ${migration.file} failed and was rolled back: ${error.message}`;
        throw error;
      }
    }
    return appliedNow;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { loadMigrations, migrationStatus, runMigrations };

if (require.main === module) {
  require("dotenv").config();
  const { pool } = require("./db");
  const command = process.argv[2] || "up";

  (async () => {
    if (command === "status") {
      const rows = await migrationStatus(pool);
      rows.forEach((row) => {
        const state = row.applied ? `applied ${new Date(row.appliedAt).toISOString()}` : "PENDING";
        console.log(`${row.id.padEnd(32)} ${state}${row.changedSinceApplied ? " (file changed since applied)" : ""}`);
      });
      if (!rows.some((row) => !row.applied)) console.log("Database schema is up to date.");
    } else if (command === "up") {
      const applied = await runMigrations(pool);
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "No pending migrations.");
    } else {
      console.error("Usage: node server/migrate.js [up|status]");
      process.exitCode = 1;
    }
  })()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
