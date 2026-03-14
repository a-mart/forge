import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findCandidateControlPidFiles,
  getControlPidFilePath,
  readControlPidFromFile
} from "../reboot/control-pid.js";

describe("control-pid helper", () => {
  it("returns a stable hashed pid-file path per repo root", () => {
    const first = getControlPidFilePath("/repo/one");
    const second = getControlPidFilePath("/repo/one");
    const third = getControlPidFilePath("/repo/two");

    expect(first).toBe(second);
    expect(first).toMatch(/swarm-prod-daemon-[0-9a-f]{10}\.pid$/);
    expect(third).not.toBe(first);
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

  it("finds matching candidate pid files in tmpdir", async () => {
    const candidateA = join(tmpdir(), `swarm-prod-daemon-test-${process.pid}-${Date.now()}-a.pid`);
    const candidateB = join(tmpdir(), `swarm-prod-daemon-test-${process.pid}-${Date.now()}-b.pid`);
    await writeFile(candidateA, "1\n", "utf8");
    await writeFile(candidateB, "2\n", "utf8");

    try {
      const candidates = await findCandidateControlPidFiles();
      expect(candidates).toContain(candidateA);
      expect(candidates).toContain(candidateB);
    } finally {
      await rm(candidateA, { force: true });
      await rm(candidateB, { force: true });
    }
  });
});
