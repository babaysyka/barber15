import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const schema = resolve(dirname(fileURLToPath(import.meta.url)), "../../../prisma/schema.prisma");

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:5432/barber";
}
if (!process.env.DIRECT_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

const cli = require.resolve("prisma/build/index.js");
const result = spawnSync(process.execPath, [cli, "generate", `--schema=${schema}`], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
