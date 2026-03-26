import { accessSync, chmodSync, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const backendPackageJsonPath = join(workspaceRoot, "apps/backend/package.json");

let nodePtyPackageJsonPath;
try {
  const backendRequire = createRequire(backendPackageJsonPath);
  nodePtyPackageJsonPath = backendRequire.resolve("node-pty/package.json");
} catch {
  process.exit(0);
}

const nodePtyDir = dirname(nodePtyPackageJsonPath);
const helperCandidates = [
  join(nodePtyDir, "prebuilds", "darwin-arm64", "spawn-helper"),
  join(nodePtyDir, "prebuilds", "darwin-x64", "spawn-helper"),
  join(nodePtyDir, "build", "Release", "spawn-helper"),
];

let fixedCount = 0;
for (const helperPath of helperCandidates) {
  try {
    accessSync(helperPath, fsConstants.F_OK);
  } catch {
    continue;
  }

  try {
    accessSync(helperPath, fsConstants.X_OK);
    continue;
  } catch {
    // Missing execute bit; repair below.
  }

  try {
    chmodSync(helperPath, 0o755);
    fixedCount += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[postinstall] Failed to mark node-pty spawn-helper executable at ${helperPath}: ${message}`);
  }
}

if (fixedCount > 0) {
  console.log(`[postinstall] Marked ${fixedCount} node-pty spawn-helper binary file(s) as executable.`);
}
