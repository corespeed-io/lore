#!/usr/bin/env -S bun --no-env-file

import { runLoreCli } from "./index.js";

process.exitCode = await runLoreCli(process.argv.slice(2));
