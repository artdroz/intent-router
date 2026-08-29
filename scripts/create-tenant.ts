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
