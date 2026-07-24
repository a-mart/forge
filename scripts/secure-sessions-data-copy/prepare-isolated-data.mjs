#!/usr/bin/env node

import {
  DEFAULT_ELECTRON_USER_DATA,
  DEFAULT_SOURCE,
  DEFAULT_TARGET,
  IsolationError,
  prepareIsolatedData,
} from "./isolation-lib.mjs";

function parseArgs(argv) {
  const options = {
    sourcePath: DEFAULT_SOURCE,
    targetPath: DEFAULT_TARGET,
    electronUserDataPath: DEFAULT_ELECTRON_USER_DATA,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source") {
      options.sourcePath = argv[++index];
    } else if (argument === "--target") {
      options.targetPath = argv[++index];
    } else if (argument === "--electron-user-data") {
      options.electronUserDataPath = argv[++index];
    } else {
      throw new IsolationError("Usage: prepare-isolated-data.mjs [--source PATH] [--target PATH] [--electron-user-data PATH]");
    }
  }
  if (!options.sourcePath || !options.targetPath || !options.electronUserDataPath) {
    throw new IsolationError("All path options require a value.");
  }
  return options;
}

try {
  const result = await prepareIsolatedData(parseArgs(process.argv.slice(2)));
  console.log(
    JSON.stringify({
      ok: true,
      status: result.status,
      sourcePath: result.manifest.sourcePath,
      targetPath: result.manifest.targetPath,
      sqliteBackupCount: result.manifest.sqliteBackupCount,
      quarantinedPathCount: result.manifest.quarantinedPathCount,
      secretsPrinted: false,
    }),
  );
} catch (error) {
  const message = error instanceof IsolationError ? error.message : "Isolated data preparation failed.";
  console.error(JSON.stringify({ ok: false, error: message, secretsPrinted: false }));
  process.exitCode = 1;
}
