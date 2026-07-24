#!/usr/bin/env node

import {
  DEFAULT_BACKEND_PORT,
  DEFAULT_ELECTRON_USER_DATA,
  DEFAULT_SOURCE,
  DEFAULT_TARGET,
  DEFAULT_UI_PORT,
  IsolationError,
  assertPreparedIsolation,
} from "./isolation-lib.mjs";

function optionalNumber(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return Number(value);
}

try {
  const result = await assertPreparedIsolation({
    dataPath: process.env.FORGE_DATA_DIR ?? DEFAULT_TARGET,
    sourcePath: process.env.FORGE_SOURCE_DATA_DIR ?? DEFAULT_SOURCE,
    electronUserDataPath:
      process.env.FORGE_ELECTRON_USER_DATA_DIR ?? DEFAULT_ELECTRON_USER_DATA,
    backendPort: optionalNumber(process.env.FORGE_PORT, DEFAULT_BACKEND_PORT),
    uiPort: optionalNumber(process.env.FORGE_UI_PORT, DEFAULT_UI_PORT),
    env: process.env,
    requireLaunchEnv: process.argv.includes("--data-only") === false,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof IsolationError ? error.message : "Isolation assertion failed.";
  console.error(JSON.stringify({ ok: false, error: message, secretsPrinted: false }));
  process.exitCode = 1;
}
