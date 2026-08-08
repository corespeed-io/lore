import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const databaseUrl = process.env.DATABASE_URL;
const requestedPath = process.env.LORE_BACKUP_PATH;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!requestedPath) throw new Error("LORE_BACKUP_PATH is required");

const backupPath = resolve(requestedPath);
await mkdir(dirname(backupPath), { recursive: true });
for (const path of [backupPath, `${backupPath}.manifest.json`]) {
  try {
    await stat(path);
    throw new Error(`Refusing to overwrite existing backup artifact ${path}`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}
const dumpUrl = new URL(databaseUrl);
const dumpPassword = decodeURIComponent(dumpUrl.password);
dumpUrl.password = "";

await new Promise((resolveProcess, reject) => {
  const child = spawn(
    "pg_dump",
    ["--format=custom", "--no-owner", "--file", backupPath, dumpUrl.toString()],
    {
      env: { ...process.env, ...(dumpPassword ? { PGPASSWORD: dumpPassword } : {}) },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolveProcess() : reject(new Error(`pg_dump exited with status ${code}`)),
  );
});
await chmod(backupPath, 0o600);

const hash = createHash("sha256");
for await (const chunk of createReadStream(backupPath)) hash.update(chunk);
const backupStats = await stat(backupPath);
const manifest = {
  format: "lore-postgres-backup-v1",
  createdAt: new Date().toISOString(),
  bytes: backupStats.size,
  sha256: hash.digest("hex"),
  restoreRequiresTrustedInput: true,
};
await writeFile(`${backupPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify({ backupPath, manifestPath: `${backupPath}.manifest.json`, ...manifest }),
);
