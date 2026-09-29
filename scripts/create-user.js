#!/usr/bin/env node
// Creates an active authority_user (Commander or Dispatcher) in Postgres.
// Usage:
//   DATABASE_URL=postgres://... node scripts/create-user.js <username> <password> <COMMANDER|DISPATCHER> [full name]
// The Postgres schema does not auto-seed users, so the first Commander must be
// created this way; that Commander can then approve Dispatcher sign-ups via the API.

import { createPgPool } from "../packages/shared/src/db.js";
import { hashPassword } from "../packages/shared/src/auth.js";

const [username, password, role, ...nameParts] = process.argv.slice(2);
const fullName = nameParts.join(" ") || username;

if (!username || !password || !["COMMANDER", "DISPATCHER"].includes(role)) {
  console.error("Usage: node scripts/create-user.js <username> <password> <COMMANDER|DISPATCHER> [full name]");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required (point it at Supabase or local Postgres).");
  process.exit(1);
}

const pool = createPgPool(databaseUrl);
try {
  const result = await pool.query(
    `INSERT INTO authority_user (username, password_hash, full_name, clearance_level, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       clearance_level = EXCLUDED.clearance_level,
       is_active = true
     RETURNING id, username, full_name, clearance_level, is_active`,
    [username, hashPassword(password), fullName, role]
  );
  const user = result.rows[0];
  console.log(`[create-user] ${role} '${user.username}' ready (id=${user.id}, active=${user.is_active})`);
} finally {
  await pool.end().catch(() => {});
}
