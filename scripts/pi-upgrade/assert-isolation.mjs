#!/usr/bin/env node
/**
 * Fail-closed isolation guardrails for Pi upgrade worktree instances.
 * Refuses production FORGE_DATA_DIR and production/dev ports.
 *
 * Never prints secret values. Safe to run in CI and local shells.
 */
import { homedir } from "node:os";
import { resolve, normalize } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";

const PRODUCTION_DATA_CANDIDATES = [
  resolve(homedir(), ".forge"),
  resolve(homedir(), "Library/Application Support/forge"),
];

/** Ports reserved for non-worktree Forge instances (dev + prod + common conflicts). */
const FORBIDDEN_BACKEND_PORTS = new Set([47187, 47287, 47387]);
const FORBIDDEN_UI_PORTS = new Set([47188, 47189, 47388]);

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function expandPath(value) {
  if (!value) return null;
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

export function assertIsolatedForgeDataDir(dataDir, { label = "FORGE_DATA_DIR" } = {}) {
  if (!dataDir || typeof dataDir !== "string" || !dataDir.trim()) {
    throw new Error(`${label} is required for isolated Pi upgrade instances`);
  }

  const expanded = expandPath(dataDir.trim());
  const normalized = normalize(expanded);
  const real = realpathOrNull(normalized) ?? normalized;

  for (const candidate of PRODUCTION_DATA_CANDIDATES) {
    const prodReal = realpathOrNull(candidate) ?? normalize(candidate);
    if (real === prodReal) {
      throw new Error(
        `${label} refuses production data path (${candidate}). Use a copied ~/.forge-worktree-* directory.`,
      );
    }
    if (real.startsWith(prodReal + "/") || real.startsWith(prodReal + "\\")) {
      throw new Error(`${label} refuses path inside production data (${candidate})`);
    }
  }

  // Also reject any path that is exactly $HOME/.forge or a symlink to it.
  if (normalized === resolve(homedir(), ".forge") || real === resolve(homedir(), ".forge")) {
    throw new Error(`${label} refuses ~/.forge`);
  }

  if (!existsSync(normalized)) {
    throw new Error(`${label} does not exist: ${normalized}`);
  }

  return { dataDir: normalized, realpath: real };
}

export function assertIsolatedBackendPort(port, { label = "FORGE_PORT" } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`${label} must be an integer port in 1024–65535 (got ${port})`);
  }
  if (FORBIDDEN_BACKEND_PORTS.has(n)) {
    throw new Error(
      `${label}=${n} is reserved for production/dev/conflicting Forge instances. Use a worktree offset port (e.g. 47687).`,
    );
  }
  return n;
}

export function assertIsolatedUiPort(port, { label = "UI_PORT" } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`${label} must be an integer port in 1024–65535 (got ${port})`);
  }
  if (FORBIDDEN_UI_PORTS.has(n)) {
    throw new Error(
      `${label}=${n} is reserved for production/dev Forge UI. Use a worktree offset port (e.g. 47688).`,
    );
  }
  return n;
}

export function assertViteWsUrlMatchesBackend(wsUrl, backendPort) {
  if (!wsUrl || typeof wsUrl !== "string") {
    throw new Error("VITE_FORGE_WS_URL is required so the UI does not fall back to production");
  }
  const expected = `ws://127.0.0.1:${backendPort}`;
  const expectedLocalhost = `ws://localhost:${backendPort}`;
  if (wsUrl !== expected && wsUrl !== expectedLocalhost) {
    throw new Error(
      `VITE_FORGE_WS_URL must be ${expected} (got ${wsUrl}). Without this, UI ports >47188 silently target production.`,
    );
  }
  return wsUrl;
}

export function assertAuthPresentWithoutReadingSecrets(dataDir) {
  const authPath = resolve(dataDir, "shared/config/auth/auth.json");
  if (!existsSync(authPath)) {
    throw new Error(`Isolated auth.json missing at ${authPath}`);
  }
  const mode = (statSync(authPath).mode & 0o777).toString(8);
  // Prefer 600; warn-style fail if world-readable.
  if (mode.endsWith("4") || mode.endsWith("5") || mode.endsWith("6") || mode.endsWith("7")) {
    if ((statSync(authPath).mode & 0o004) !== 0) {
      throw new Error(`Isolated auth.json is world-readable (mode ${mode}); refuse to continue`);
    }
  }
  return { authPath, mode };
}

export function assertIsolationEnv(env = process.env) {
  const data = assertIsolatedForgeDataDir(env.FORGE_DATA_DIR);
  const backendPort = assertIsolatedBackendPort(env.FORGE_PORT);
  const uiPort = env.FORGE_UI_PORT ? assertIsolatedUiPort(env.FORGE_UI_PORT) : backendPort + 1;
  assertIsolatedUiPort(uiPort);
  const wsUrl = assertViteWsUrlMatchesBackend(env.VITE_FORGE_WS_URL, backendPort);
  const auth = assertAuthPresentWithoutReadingSecrets(data.dataDir);

  return {
    dataDir: data.dataDir,
    dataRealpath: data.realpath,
    backendPort,
    uiPort,
    wsUrl,
    authMode: auth.mode,
    authPresent: true,
  };
}

function main() {
  const result = assertIsolationEnv(process.env);
  // Redacted proof only — never dump env secrets.
  console.log(
    JSON.stringify(
      {
        ok: true,
        dataDir: result.dataDir,
        backendPort: result.backendPort,
        uiPort: result.uiPort,
        wsUrl: result.wsUrl,
        authPresent: result.authPresent,
        authMode: result.authMode,
        refusedProductionData: true,
        refusedProductionPorts: true,
      },
      null,
      2,
    ),
  );
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("assert-isolation.mjs") ||
    process.argv[1].endsWith("assert-isolation.js"));

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
}
