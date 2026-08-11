import { initDb, closeDb } from "../src/store/db.js";
import {
  createApiKey, disableApiKey, enableApiKey, extendApiKey,
  transferKey, renameApiKey, listKeys,
} from "../src/auth/api-keys.js";

const DATABASE_URL = process.env.DATABASE_URL!;
const [, , command, ...args] = process.argv;

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main() {
  initDb(DATABASE_URL);
  try {
    switch (command) {
    case "create": {
      const name = flag("name");
      const days = flag("expires");
      if (!name) throw new Error("--name is required");
      const key = await createApiKey({ name, expiresInDays: days ? Number(days) : undefined });
      console.log(key);
      break;
    }
    case "disable": {
      const name = flag("name"); if (!name) throw new Error("--name is required");
      await disableApiKey(name);
      console.log(`Key "${name}" disabled.`);
      break;
    }
    case "enable": {
      const name = flag("name"); if (!name) throw new Error("--name is required");
      await enableApiKey(name);
      console.log(`Key "${name}" enabled.`);
      break;
    }
    case "extend": {
      const name = flag("name");
      const days = flag("days");
      if (!name) throw new Error("--name is required");
      if (!days) throw new Error("--days is required");
      await extendApiKey(name, Number(days));
      console.log(`Key "${name}" extended by ${days} days.`);
      break;
    }
    case "rename": {
      const oldName = flag("old");
      const newName = flag("new");
      if (!oldName) throw new Error("--old is required");
      if (!newName) throw new Error("--new is required");
      await renameApiKey(oldName, newName);
      console.log(`Key "${oldName}" renamed to "${newName}".`);
      break;
    }
    case "transfer": {
      const from = flag("from");
      const to = flag("to");
      if (!from) throw new Error("--from is required");
      if (!to) throw new Error("--to is required");
      await transferKey(from, to);
      console.log(`Resources transferred from "${from}" to "${to}". (Source disabled)`);
      break;
    }
    case "list": {
      const keys = await listKeys();
      for (const k of keys) {
        console.log(`${k.prefix}…  ${k.name}  enabled=${k.enabled}  expires=${k.expiresAt ?? "never"}`);
      }
      break;
    }
    default:
      console.log("npx tsx scripts/manage-keys.ts <command> [flags]");
      console.log("  create   --name <name> [--expires <days>]");
      console.log("  disable  --name <name>");
      console.log("  enable   --name <name>");
      console.log("  extend   --name <name> --days <days>");
      console.log("  rename   --old <name> --new <name>");
      console.log("  transfer --from <name> --to <name>");
      console.log("  list");
  }
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
