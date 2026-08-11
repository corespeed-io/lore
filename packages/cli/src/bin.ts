#!/usr/bin/env node

import { runLoreCli } from "./index.js";

process.exitCode = await runLoreCli(process.argv.slice(2));
