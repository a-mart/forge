import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";

import {
  COPY_SCHEMA_VERSION,
  DEFAULT_BACKEND_PORT,
  DEFAULT_UI_PORT,
  IsolationError,
  assertLaunchEnvironment,
  assertPreparedIsolation,
  getRepoRoot,
  loadDatabaseConstructor,
  prepareIsolatedData,
  resetPreparedIsolation,
} from "../isolation-lib.mjs";

const SYNTHETIC_SECRET = "synthetic-provider-secret-never-log";

async function writeJson(path, value, mode = 0o644) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-secure-copy-test-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const electronUserData = join(root, "electron-user-data");
  await mkdir(join(source, "shared/config/auth"), { recursive: true });
  await writeJson(
    join(source, "shared/config/auth/auth.json"),
    { openai: { access: SYNTHETIC_SECRET } },
    0o600,
  );
  await writeJson(
    join(source, "shared/config/auth/credential-pool.json"),
    { accounts: [{ token: SYNTHETIC_SECRET }] },
  );
  await writeJson(join(source, "shared/config/secrets.json"), { CURSOR_API_KEY: SYNTHETIC_SECRET });
  await writeJson(join(source, "shared/config/phoenix-observability.json"), {
    export: { enabled: true, endpoint: "http://127.0.0.1:6006/v1/traces" },
  });
  await writeJson(join(source, "shared/config/remote-build-settings.json"), { enabled: true });
  await writeJson(join(source, "shared/config/project-resources.json"), { trusted: true });
  await writeJson(join(source, "shared/config/telemetry.json"), { enabled: true });
  await writeJson(join(source, "shared/state/mobile-devices.json"), {
    devices: [{ token: SYNTHETIC_SECRET }],
  });
  await writeJson(join(source, "shared/config/collaboration/config.json"), { enabled: true });
  await writeJson(join(source, "profiles/profile/schedules/schedules.json"), {
    schedules: [{ id: "dangerous", enabled: true }],
  });
  await writeJson(join(source, "profiles/profile/sessions/session/goal.json"), {
    status: "active",
    objective: "synthetic",
  });
  await writeJson(join(source, "profiles/profile/sessions/session/terminals/terminal/meta.json"), {
    state: "running",
  });
  await writeJson(join(source, "extensions/test.json"), { enabled: true });
  await writeJson(join(source, "agent/manager/extensions/test.json"), { enabled: true });
  await mkdir(join(source, "profiles/profile/sessions/session"), { recursive: true });
  await writeFile(
    join(source, "profiles/profile/sessions/session/session.jsonl"),
    `${JSON.stringify({ type: "message", text: "retained synthetic session" })}\n`,
  );
  await mkdir(electronUserData, { recursive: true, mode: 0o700 });

  const Database = loadDatabaseConstructor();
  const databasePath = join(source, "shared/state/runtime.db");
  await mkdir(join(source, "shared/state"), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec("CREATE TABLE evidence (value TEXT NOT NULL)");
  database.prepare("INSERT INTO evidence (value) VALUES (?)").run("copied-through-backup");

  return { root, source, target, electronUserData, database };
}

async function sourceDigest(source) {
  const hash = createHash("sha256");
  for (const path of [
    "shared/config/auth/auth.json",
    "shared/config/auth/credential-pool.json",
    "shared/config/secrets.json",
    "profiles/profile/sessions/session/session.jsonl",
  ]) {
    hash.update(await readFile(join(source, path)));
  }
  return hash.digest("hex");
}

test("prepares a source-immutable, quarantined, SQLite-consistent copy and is idempotent", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.database.close());
  const beforeDigest = await sourceDigest(fixture.source);

  const first = await prepareIsolatedData({
    sourcePath: fixture.source,
    targetPath: fixture.target,
    electronUserDataPath: fixture.electronUserData,
    now: () => new Date("2026-07-23T12:00:00.000Z"),
  });
  assert.equal(first.status, "prepared");
  assert.equal(first.manifest.schemaVersion, COPY_SCHEMA_VERSION);
  assert.equal(await sourceDigest(fixture.source), beforeDigest);

  assert.match(
    await readFile(join(fixture.target, "profiles/profile/sessions/session/session.jsonl"), "utf8"),
    /retained synthetic session/,
  );
  assert.equal(
    await readFile(join(fixture.target, "shared/config/auth/auth.json"), "utf8"),
    `${JSON.stringify({ openai: { access: SYNTHETIC_SECRET } })}\n`,
  );
  await assert.rejects(readFile(join(fixture.target, "profiles/profile/schedules/schedules.json")));
  assert.equal(
    JSON.parse(
      await readFile(
        join(
          fixture.target,
          ".secure-sessions-quarantine/files/profiles/profile/schedules/schedules.json",
        ),
        "utf8",
      ),
    ).schedules[0].id,
    "dangerous",
  );

  const Database = loadDatabaseConstructor();
  const copiedDatabase = new Database(join(fixture.target, "shared/state/runtime.db"), {
    readonly: true,
  });
  try {
    assert.equal(
      copiedDatabase.prepare("SELECT value FROM evidence").pluck().get(),
      "copied-through-backup",
    );
    assert.deepEqual(copiedDatabase.pragma("quick_check"), [{ quick_check: "ok" }]);
  } finally {
    copiedDatabase.close();
  }

  const manifestText = await readFile(join(fixture.target, ".secure-sessions-copy.json"), "utf8");
  assert.equal(manifestText.includes(SYNTHETIC_SECRET), false);
  const assertion = await assertPreparedIsolation({
    dataPath: fixture.target,
    sourcePath: fixture.source,
    electronUserDataPath: fixture.electronUserData,
    requireLaunchEnv: false,
  });
  assert.equal(assertion.dangerousAutomationActive, false);

  const second = await prepareIsolatedData({
    sourcePath: fixture.source,
    targetPath: fixture.target,
    electronUserDataPath: fixture.electronUserData,
  });
  assert.equal(second.status, "already-prepared");
  assert.equal(await sourceDigest(fixture.source), beforeDigest);
});

test("refuses to copy a source with an active runtime lock", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.database.close());
  await writeFile(join(fixture.source, "runtime.lock"), "synthetic lock\n");
  await assert.rejects(
    prepareIsolatedData({
      sourcePath: fixture.source,
      targetPath: fixture.target,
      electronUserDataPath: fixture.electronUserData,
    }),
    /runtime\.lock/,
  );
});

test("materializes regular-file symlinks so the target cannot alias the source", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.database.close());
  await symlink(
    join(fixture.source, "shared/config/auth/auth.json"),
    join(fixture.source, "shared/config/auth/alias.json"),
  );
  await prepareIsolatedData({
    sourcePath: fixture.source,
    targetPath: fixture.target,
    electronUserDataPath: fixture.electronUserData,
  });
  assert.equal(
    await readFile(join(fixture.target, "shared/config/auth/alias.json"), "utf8"),
    await readFile(join(fixture.source, "shared/config/auth/auth.json"), "utf8"),
  );
  await writeFile(join(fixture.target, "shared/config/auth/alias.json"), "target-only\n");
  assert.notEqual(
    await readFile(join(fixture.source, "shared/config/auth/auth.json"), "utf8"),
    "target-only\n",
  );
});

test("refuses source and target path overlap", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.database.close());
  await assert.rejects(
    prepareIsolatedData({
      sourcePath: fixture.source,
      targetPath: join(fixture.source, "nested"),
      electronUserDataPath: fixture.electronUserData,
    }),
    /overlap/,
  );
});

test("assertion fails closed when dangerous automation is reactivated", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.database.close());
  await prepareIsolatedData({
    sourcePath: fixture.source,
    targetPath: fixture.target,
    electronUserDataPath: fixture.electronUserData,
  });
  await writeJson(join(fixture.target, "shared/config/telemetry.json"), {
    enabled: true,
    credential: SYNTHETIC_SECRET,
  });
  await assert.rejects(
    assertPreparedIsolation({
      dataPath: fixture.target,
      sourcePath: fixture.source,
      electronUserDataPath: fixture.electronUserData,
      requireLaunchEnv: false,
    }),
    (error) => {
      assert.ok(error instanceof IsolationError);
      assert.equal(error.message.includes(SYNTHETIC_SECRET), false);
      return true;
    },
  );
});

test("repeat-run reset quarantines regenerated automation without touching the source", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.database.close());
  const beforeDigest = await sourceDigest(fixture.source);
  await prepareIsolatedData({
    sourcePath: fixture.source,
    targetPath: fixture.target,
    electronUserDataPath: fixture.electronUserData,
  });
  await writeJson(join(fixture.target, "profiles/profile/schedules/schedules.json"), {
    schedules: [{ id: "regenerated", enabled: true }],
  });
  await writeJson(join(fixture.target, "shared/config/telemetry.json"), {
    enabled: true,
  });

  const reset = await resetPreparedIsolation({
    dataPath: fixture.target,
    sourcePath: fixture.source,
    electronUserDataPath: fixture.electronUserData,
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.equal(reset.status, "reset");
  assert.deepEqual(reset.quarantinedPaths.sort(), [
    "profiles/profile/schedules/schedules.json",
    "shared/config/telemetry.json",
  ]);
  assert.equal(await sourceDigest(fixture.source), beforeDigest);
  await assertPreparedIsolation({
    dataPath: fixture.target,
    sourcePath: fixture.source,
    electronUserDataPath: fixture.electronUserData,
    requireLaunchEnv: false,
  });
});

test("assertion rejects credential permissions that are not private", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.database.close());
  await prepareIsolatedData({
    sourcePath: fixture.source,
    targetPath: fixture.target,
    electronUserDataPath: fixture.electronUserData,
  });
  await chmod(join(fixture.target, "shared/config/secrets.json"), 0o644);
  await assert.rejects(
    assertPreparedIsolation({
      dataPath: fixture.target,
      sourcePath: fixture.source,
      electronUserDataPath: fixture.electronUserData,
      requireLaunchEnv: false,
    }),
    /credential file/,
  );
});

test("launch environment is exact and refuses Collaboration bootstrap credentials", async () => {
  const dataPath = "/tmp/forge-secure-copy-data";
  const electronUserDataPath = "/tmp/forge-secure-copy-electron";
  const env = {
    FORGE_RUNTIME_TARGET: "builder",
    FORGE_HOST: "127.0.0.1",
    FORGE_PORT: String(DEFAULT_BACKEND_PORT),
    FORGE_UI_PORT: String(DEFAULT_UI_PORT),
    FORGE_DATA_DIR: dataPath,
    FORGE_ELECTRON_DEV_SERVER_URL: `http://127.0.0.1:${DEFAULT_UI_PORT}`,
    FORGE_ELECTRON_USER_DATA_DIR: electronUserDataPath,
    VITE_FORGE_WS_URL: `ws://127.0.0.1:${DEFAULT_BACKEND_PORT}`,
    FORGE_TELEMETRY: "false",
    FORGE_CORTEX_ENABLED: "false",
    FORGE_TERMINAL_ENABLED: "false",
    FORGE_SKILL_SHARE_DISABLED: "true",
    FORGE_REMOTE_PROJECTS_ENABLED: "false",
    FORGE_REMOTE_PROJECTS_TERMINALS_ENABLED: "false",
    FORGE_VERSIONING_ENABLED: "false",
    FORGE_DEBUG: "false",
  };
  assert.doesNotThrow(() =>
    assertLaunchEnvironment(env, {
      dataPath,
      electronUserDataPath,
    }),
  );
  assert.throws(
    () =>
      assertLaunchEnvironment(
        { ...env, FORGE_ADMIN_PASSWORD: SYNTHETIC_SECRET },
        { dataPath, electronUserDataPath },
      ),
    (error) => {
      assert.ok(error instanceof IsolationError);
      assert.equal(error.message.includes(SYNTHETIC_SECRET), false);
      return true;
    },
  );
});

test("launch harness check-only validates a prepared fixture without printing credentials", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.database.close());
  await prepareIsolatedData({
    sourcePath: fixture.source,
    targetPath: fixture.target,
    electronUserDataPath: fixture.electronUserData,
  });
  const result = spawnSync(
    "bash",
    [
      join(
        getRepoRoot(),
        "scripts/secure-sessions-data-copy/launch-electron.sh",
      ),
      "--check-only",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FORGE_SOURCE_DATA_DIR: fixture.source,
        FORGE_DATA_DIR: fixture.target,
        FORGE_ELECTRON_USER_DATA_DIR: fixture.electronUserData,
        FORGE_ADMIN_EMAIL: "",
        FORGE_ADMIN_PASSWORD: "",
        FORGE_COLLABORATION_AUTH_SECRET: "",
        FORGE_COLLABORATION_BASE_URL: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"launchStarted":false/);
  assert.equal(result.stdout.includes(SYNTHETIC_SECRET), false);
  assert.equal(result.stderr.includes(SYNTHETIC_SECRET), false);
});
