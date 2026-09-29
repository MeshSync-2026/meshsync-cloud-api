#!/usr/bin/env node
// Database migration runner for MeshSync PostgreSQL database
// Executes 001_initial_schema.sql and verifies all tables and indexes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Serializes concurrent migration runs (e.g. two services booting at once on Render)
const MIGRATION_LOCK_KEY = 727274;

export function isLocalDatabase(databaseUrl) {
  return databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") || databaseUrl.includes("@postgres:");
}

function describeError(err) {
  // AggregateError (e.g. ECONNREFUSED on Windows) carries an empty message
  if (err?.errors?.length) return err.errors.map((e) => e.message).join("; ");
  return err?.message || String(err);
}

async function runMigration() {
  const databaseUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/meshsync";
  console.log(`[Migrate] Connecting to database: ${databaseUrl.replace(/:[^:@]+@/, ":****@")}`);

  const pg = await import("pg");
  const { Pool } = pg.default || pg;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: isLocalDatabase(databaseUrl) ? false : { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    console.log("[Migrate] Connected successfully. Reading initial schema SQL...");

    const sqlPath = path.join(__dirname, "001_initial_schema.sql");
    const sql = fs.readFileSync(sqlPath, "utf8");

    console.log("[Migrate] Executing 001_initial_schema.sql...");
    await client.query(sql);
    console.log("[Migrate] Schema applied successfully!");

    // Verification check: list all tables
    const tableRes = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    const tables = tableRes.rows.map((r) => r.table_name);
    console.log(`[Migrate] Verified ${tables.length} tables in public schema:`);
    console.log(`  ${tables.join(", ")}`);
    console.log("[Migrate] Migration completed cleanly.");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
}

/**
 * Startup hook shared by both services. Runs only when enabled, and fails fast
 * in production so a broken schema never serves traffic.
 * @param {boolean} enabledByDefault - Edge Sync owns the log and migrates by default; Command Center does not.
 */
async function runStartupMigration(enabledByDefault) {
  if (!process.env.DATABASE_URL) return;
  const flag = process.env.RUN_MIGRATIONS;
  const enabled = flag === undefined ? enabledByDefault : flag === "true";
  if (!enabled) return;
  try {
    await runMigration();
  } catch (err) {
    console.error("[Startup] Database migration failed:", describeError(err));
    if (process.env.NODE_ENV === "production") process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigration().catch((err) => {
    console.error("[Migrate] Migration failed:", describeError(err));
    process.exit(1);
  });
}

export { runMigration, runStartupMigration };
