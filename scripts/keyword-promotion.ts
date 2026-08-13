import { closeDb, initDb } from "../src/store/db.js";
import { promoteKeyword } from "../src/routing/service.js";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(1); }

initDb(url);

try {
  await promoteKeyword();
  console.log("Keyword promotion complete.");
} finally {
  await closeDb();
}

process.exit(0);