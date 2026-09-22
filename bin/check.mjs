#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// node --check accepts one script, not an expanded list of scripts.
for (const directory of ["bin", "src", "test"]) {
  for (const name of readdirSync(new URL(`../${directory}/`, import.meta.url))) {
    if (!name.endsWith(".mjs")) continue;
    const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(`../${directory}/${name}`, import.meta.url))], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
