#!/usr/bin/env node

import {
  DEFAULT_ELECTRON_USER_DATA,
  DEFAULT_SOURCE,
  DEFAULT_TARGET,
  IsolationError,
  resetPreparedIsolation,
} from "./isolation-lib.mjs";

try {
  const result = await resetPreparedIsolation({
    dataPath: process.env.FORGE_DATA_DIR ?? DEFAULT_TARGET,
    sourcePath: process.env.FORGE_SOURCE_DATA_DIR ?? DEFAULT_SOURCE,
    electronUserDataPath:
      process.env.FORGE_ELECTRON_USER_DATA_DIR ?? DEFAULT_ELECTRON_USER_DATA,
  });
  console.log(JSON.stringify({
    ok: true,
    status: result.status,
    quarantinedPathCount: result.quarantinedPathCount,
    secretsPrinted: false,
  }));
} catch (error) {
  const message = error instanceof IsolationError
    ? error.message
    : "Isolated data reset failed.";
  console.error(JSON.stringify({ ok: false, error: message, secretsPrinted: false }));
  process.exitCode = 1;
}
