import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendImmediateCustomEntry } from "../session/immediate-custom-entry-writer.js";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function buildSessionHeader(cwd: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "session-header",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd
  });
}

describe("appendImmediateCustomEntry", () => {
  it("creates a missing session file with a header and custom entry", async () => {
    const root = await createTempDir("immediate-entry-writer-");
    const sessionFile = join(root, "sessions", "manager.jsonl");

    const result = await appendImmediateCustomEntry({
      sessionFile,
      cwd: root,
      customType: "swarm_model_change_continuity_request",
      data: { hello: "world" },
      now: () => "2026-01-02T00:00:00.000Z"
    });

    expect(result.headerCreated).toBe(true);
    expect(result.parentId).toBeNull();

    const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);

    const header = JSON.parse(lines[0] ?? "{}");
    expect(header.type).toBe("session");
    expect(header.cwd).toBe(root);

    const entry = JSON.parse(lines[1] ?? "{}");
    expect(entry.type).toBe("custom");
    expect(entry.customType).toBe("swarm_model_change_continuity_request");
    expect(entry.parentId).toBeNull();
    expect(entry.data).toEqual({ hello: "world" });
  });

  it("appends to a valid session file using the current leaf entry id as parent when available", async () => {
    const root = await createTempDir("immediate-entry-writer-");
    const sessionFile = join(root, "manager.jsonl");
    writeFileSync(
      sessionFile,
      [
        buildSessionHeader(root),
        JSON.stringify({
          type: "custom",
          customType: "swarm_conversation_entry",
          id: "entry-1",
          parentId: null,
          data: { text: "existing" },
          timestamp: "2026-01-01T00:00:01.000Z"
        })
      ].join("\n"),
      "utf8"
    );

    const result = await appendImmediateCustomEntry({
      sessionFile,
      cwd: root,
      customType: "swarm_model_change_continuity_applied",
      data: { ok: true },
      now: () => "2026-01-02T00:00:00.000Z"
    });

    expect(result.headerCreated).toBe(false);
    expect(result.parentId).toBe("entry-1");

    const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(3);

    const appended = JSON.parse(lines[2] ?? "{}");
    expect(appended.parentId).toBe("entry-1");
    expect(appended.customType).toBe("swarm_model_change_continuity_applied");
  });

  it("fails without mutating a non-empty file that has an invalid header", async () => {
    const root = await createTempDir("immediate-entry-writer-");
    const sessionFile = join(root, "manager.jsonl");
    const original = '{"type":"not-session","id":"bad"}\n';
    writeFileSync(sessionFile, original, "utf8");

    await expect(
      appendImmediateCustomEntry({
        sessionFile,
        cwd: root,
        customType: "swarm_model_change_continuity_request",
        data: { requestId: "req-1" }
      })
    ).rejects.toThrow(/invalid session header/i);

    expect(readFileSync(sessionFile, "utf8")).toBe(original);
  });

  it("fails without mutating a corrupted file whose trailing line cannot be parsed safely", async () => {
    const root = await createTempDir("immediate-entry-writer-");
    const sessionFile = join(root, "manager.jsonl");
    const original = `${buildSessionHeader(root)}\n{"type":"custom","id":"entry-1"}\n{not-json`;
    writeFileSync(sessionFile, original, "utf8");

    await expect(
      appendImmediateCustomEntry({
        sessionFile,
        cwd: root,
        customType: "swarm_model_change_continuity_request",
        data: { requestId: "req-1" }
      })
    ).rejects.toThrow(/invalid trailing session line/i);

    expect(readFileSync(sessionFile, "utf8")).toBe(original);
  });

  it("uses append-only single-line writes when multiple entries are written concurrently", async () => {
    const root = await createTempDir("immediate-entry-writer-");
    const sessionFile = join(root, "manager.jsonl");
    writeFileSync(sessionFile, `${buildSessionHeader(root)}\n`, "utf8");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendImmediateCustomEntry({
          sessionFile,
          cwd: root,
          customType: "swarm_model_change_continuity_request",
          data: { requestId: `req-${index}` },
          now: () => `2026-01-02T00:00:0${index}.000Z`
        })
      )
    );

    const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(9);

    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line);
      expect(parsed.type).toBe("custom");
      expect(parsed.customType).toBe("swarm_model_change_continuity_request");
    }
  });

  it("fails without mutating the target when the session path is not appendable", async () => {
    const root = await createTempDir("immediate-entry-writer-");
    const sessionFile = join(root, "manager.jsonl");
    mkdirSync(sessionFile, { recursive: true });

    await expect(
      appendImmediateCustomEntry({
        sessionFile,
        cwd: root,
        customType: "swarm_model_change_continuity_request",
        data: { requestId: "req-1" }
      })
    ).rejects.toThrow();
  });
});
