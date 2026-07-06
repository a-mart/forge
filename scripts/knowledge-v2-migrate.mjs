#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pnpm",
  ["--filter", "@forge/backend", "exec", "tsx", "scripts/knowledge-v2-migrate.ts", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
