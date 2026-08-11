import { chmod, copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extension = platform === "win32" ? ".exe" : "";
const dbmateRequire = createRequire(require.resolve("dbmate"));
const source = dbmateRequire.resolve(`@dbmate/${platform}-${arch}/bin/dbmate${extension}`);
const workerDirectory = fileURLToPath(new URL("../.worker", import.meta.url));
const target = fileURLToPath(new URL(`../.worker/dbmate${extension}`, import.meta.url));

await mkdir(workerDirectory, { recursive: true });
await copyFile(source, target);
await chmod(target, 0o755);
console.log(`copied dbmate ${platform}-${arch} binary to ${target}`);
