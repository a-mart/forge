import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getProjectAgentDir,
  resolveMemoryFilePath,
  sanitizePathSegment
} from "../data-paths.js";

const DATA_DIR = join(tmpdir(), "forge-data");
const PROFILE_ID = "feature-manager";
const ROOT_SESSION_ID = "feature-manager";
const NON_ROOT_SESSION_ID = "feature-manager--s2";
const WORKER_ID = "backend-impl";

describe("data-paths", () => {
  it("resolveMemoryFilePath routes root sessions to root-session working memory", () => {
    expect(
      resolveMemoryFilePath(DATA_DIR, {
        agentId: ROOT_SESSION_ID,
        role: "manager",
        profileId: PROFILE_ID,
        managerId: ROOT_SESSION_ID
      })
    ).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "sessions", PROFILE_ID, "memory.md"));
  });

  it("resolveMemoryFilePath routes non-root sessions to session memory", () => {
    expect(
      resolveMemoryFilePath(DATA_DIR, {
        agentId: NON_ROOT_SESSION_ID,
        role: "manager",
        profileId: PROFILE_ID,
        managerId: NON_ROOT_SESSION_ID
      })
    ).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "sessions", NON_ROOT_SESSION_ID, "memory.md"));
  });

  it("resolveMemoryFilePath routes workers to root-session working memory when parent is root session", () => {
    expect(
      resolveMemoryFilePath(
        DATA_DIR,
        {
          agentId: WORKER_ID,
          role: "worker",
          managerId: ROOT_SESSION_ID
        },
        { profileId: PROFILE_ID }
      )
    ).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "sessions", PROFILE_ID, "memory.md"));
  });

  it("resolveMemoryFilePath routes workers to non-root session memory", () => {
    expect(
      resolveMemoryFilePath(
        DATA_DIR,
        {
          agentId: WORKER_ID,
          role: "worker",
          managerId: NON_ROOT_SESSION_ID
        },
        { profileId: PROFILE_ID }
      )
    ).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "sessions", NON_ROOT_SESSION_ID, "memory.md"));
  });

  it("sanitizePathSegment rejects traversal and path-unsafe input", () => {
    expect(sanitizePathSegment(" feature-manager ")).toBe("feature-manager");

    expect(() => sanitizePathSegment("../etc/passwd")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("..\\evil")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("nested/segment")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("nested\\segment")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment(`bad${String.fromCharCode(0)}id`)).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("CON")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("NUL")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("COM1")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("LPT1")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("aux.txt")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("bad:name")).toThrow(/Invalid path segment/);
    expect(() => sanitizePathSegment("bad*name")).toThrow(/Invalid path segment/);
  });

  it("getProjectAgentDir rejects traversal handles", () => {
    expect(() => getProjectAgentDir(DATA_DIR, PROFILE_ID, "../escape")).toThrow(/Invalid path segment/);
  });
});
