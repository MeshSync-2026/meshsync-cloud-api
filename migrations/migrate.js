#!/usr/bin/env node
// Database migration runner for MeshSync PostgreSQL database
// Executes 001_initial_schema.sql and verifies all tables and indexes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runMigration() {
  const databaseUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/meshsync";
  console.log(`[Migrate] Connecting to database: ${databaseUrl.replace(/:[^:@]+@/, ":****@")}`);

  let pg;
  try {
    pg = await import("pg");
  } catch {
    console.error("[Migrate] 'pg' package is required to run migrations against PostgreSQL.");
    console.error("[Migrate] Run 'npm install pg' to install.");
    process.exit(1);
  }

  const { Pool } = pg.default || pg;
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const client = await pool.connect();
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

    client.release();
    await pool.end();
    console.log("[Migrate] Migration completed cleanly.");
  } catch (err) {
    console.error("[Migrate] Migration failed:", err.message);
    await pool.end();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration();
}

export { runMigration };
