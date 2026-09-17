#!/usr/bin/env -S bun --no-env-file

import { serveLoreMcpStdio } from "./index.js";

try {
  const handle = serveLoreMcpStdio();
  const close = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
} catch (error) {
  console.error(error instanceof Error ? error.message : "Lore MCP failed to start");
  process.exitCode = 1;
}
