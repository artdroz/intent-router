import { initDb, closeDb } from "../src/store/db.js";
import {
  createApiKey, disableApiKey, enableApiKey, extendApiKey,
  transferGates, renameApiKey, listKeys,
} from "../src/auth/api-keys.js";

const DATABASE_URL = process.env.DATABASE_URL!;
const [, , command, ...args] = process.argv;

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function requireFlag(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  initDb(DATABASE_URL);
  try {
    switch (command) {
    case "create": {
      const tenant = requireFlag("tenant");
      const name = requireFlag("name");
      const days = flag("expires");
      const key = await createApiKey({
        tenantId: tenant,
        name,
        expiresInDays: days ? Number(days) : undefined,
      });
      console.log(key);
      break;
    }
    case "disable": {
      const tenant = requireFlag("tenant");
      const name = requireFlag("name");
      await disableApiKey(tenant, name);
      console.log(`Key "${name}" disabled.`);
      break;
    }
    case "enable": {
      const tenant = requireFlag("tenant");
      const name = requireFlag("name");
      await enableApiKey(tenant, name);
      console.log(`Key "${name}" enabled.`);
      break;
    }
    case "extend": {
      const tenant = requireFlag("tenant");
      const name = requireFlag("name");
      const days = requireFlag("days");
      await extendApiKey(tenant, name, Number(days));
      console.log(`Key "${name}" extended by ${days} days.`);
      break;
    }
    case "rename": {
      const tenant = requireFlag("tenant");
      const oldName = requireFlag("old");
      const newName = requireFlag("new");
      await renameApiKey(tenant, oldName, newName);
      console.log(`Key "${oldName}" renamed to "${newName}".`);
      break;
    }
    case "transfer": {
      const from = requireFlag("from");
      const to = requireFlag("to");
      await transferGates(from, to);
      console.log(`Resources transferred from "${from}" to "${to}".`);
      break;
    }
    case "list": {
      const tenant = requireFlag("tenant");
      const keys = await listKeys(tenant);
      for (const k of keys) {
        console.log(`${k.prefix}…  ${k.name}  enabled=${k.enabled}  expires=${k.expiresAt ?? "never"}`);
      }
      break;
    }
    default:
      console.log("node dist/scripts/manage-keys.js <command> [flags]");
      console.log("  create   --tenant <id> --name <name> [--expires <days>]");
      console.log("  disable  --tenant <id> --name <name>");
      console.log("  enable   --tenant <id> --name <name>");
      console.log("  extend   --tenant <id> --name <name> --days <days>");
      console.log("  rename   --tenant <id> --old <name> --new <name>");
      console.log("  transfer --from <tenant-id> --to <tenant-id>");
      console.log("  list     --tenant <id>");
  }
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
