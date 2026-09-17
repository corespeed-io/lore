import { chmod, copyFile, mkdir } from "node:fs/promises";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "dbmate";

const extension = platform === "win32" ? ".exe" : "";
const source = resolveBinary();
const workerDirectory = fileURLToPath(new URL("../../.worker", import.meta.url));
const target = fileURLToPath(new URL(`../../.worker/dbmate${extension}`, import.meta.url));

await mkdir(workerDirectory, { recursive: true });
await copyFile(source, target);
await chmod(target, 0o755);
console.log(`copied dbmate ${platform}-${arch} binary to ${target}`);
