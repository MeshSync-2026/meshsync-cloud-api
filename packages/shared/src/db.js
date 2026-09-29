// Shared PostgreSQL connection helper for both services and the migration runner.
// Remote databases (Supabase) require SSL; local/docker Postgres does not.

import pg from "pg";

export function isLocalDatabase(databaseUrl) {
  return databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") || databaseUrl.includes("@postgres:");
}

export function createPgPool(databaseUrl) {
  return new pg.Pool({
    connectionString: databaseUrl,
    ssl: isLocalDatabase(databaseUrl) ? false : { rejectUnauthorized: false },
  });
}
