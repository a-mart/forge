import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getControlPidFilePath,
  getControlRestartFilePath,
  readControlPidFromFile
} from "../reboot/control-pid.js";

describe("control-pid helper", () => {
  it("returns a stable hashed pid-file path per repo root + port", () => {
    const first = getControlPidFilePath("/repo/one", 47187);
    const second = getControlPidFilePath("/repo/one", 47187);
    const differentPort = getControlPidFilePath("/repo/one", 47587);
    const differentRepo = getControlPidFilePath("/repo/two", 47187);

    expect(first).toBe(second);
    expect(first).toMatch(/swarm-prod-daemon-[0-9a-f]{10}\.pid$/);
    expect(differentPort).not.toBe(first);
    expect(differentRepo).not.toBe(first);
  });

  it("derives matching restart-file paths for the same repo root + port", () => {
    const pidFile = getControlPidFilePath("/repo/one", 47187);
    const restartFile = getControlRestartFilePath("/repo/one", 47187);

    expect(restartFile.replace(/\.restart$/, ".pid")).toBe(pidFile);
  });

  it("reads pid files safely", async () => {
    const missingPath = join(tmpdir(), `swarm-prod-daemon-missing-${process.pid}-${Date.now()}.pid`);
    expect(await readControlPidFromFile(missingPath)).toBeNull();

    const pidFile = join(tmpdir(), `swarm-prod-daemon-read-${process.pid}-${Date.now()}.pid`);
    await writeFile(pidFile, "12345\n", "utf8");

    try {
      expect(await readControlPidFromFile(pidFile)).toBe(12345);
      await writeFile(pidFile, "nope\n", "utf8");
      expect(await readControlPidFromFile(pidFile)).toBeNull();
    } finally {
      await rm(pidFile, { force: true });
    }
  });
});
