/**
 * Create a tenant in the database.
 *
 * A tenant is the root of the ownership hierarchy: it owns API keys, gates,
 * learned state, and routing events. This is a one-off operator step before
 * any keys or gates can be created.
 *
 * Prerequisite: DATABASE_URL points at a running Postgres whose schema has
 * already been migrated (see scripts/migrate.ts).
 *
 * Usage:
 *   npm run create:tenant -- <tenant-name>
 *   # or directly:
 *   node dist/scripts/create-tenant.js <tenant-name>
 *
 * Arguments:
 *   <tenant-name>   the name to assign the new tenant (required)
 *
 * Output: prints `Created tenant "<name>" (id: <uuid>)` to stdout.
 */

import { closeDb, initDb } from "../src/store/db.js";
import { createTenant } from "../src/store/tenants.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const name = process.argv[2];
if (!name) {
  console.error("Usage: npm run create:tenant -- <tenant-name>");
  process.exit(1);
}

initDb(url);

try {
  const tenant = await createTenant(name);
  console.log(`Created tenant "${tenant.name}" (id: ${tenant.id})`);
} finally {
  await closeDb();
}

process.exit(0);
