import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAgentsStoreFilePath,
  getLegacyAgentMemoryPath,
  getLegacyAuthDirPath,
  getLegacyAuthFilePath,
  getLegacyMemoryDirPath,
  getLegacySecretsFilePath,
  getLegacySessionFilePath,
  getLegacySessionsDirPath,
  getProfileDir,
  getProfileIntegrationsDir,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getProfilePiDir,
  getProjectAgentConfigPath,
  getProjectAgentDir,
  getProjectAgentPromptPath,
  getProjectAgentReferenceDir,
  getProjectAgentsDir,
  getProfilePiExtensionsDir,
  getProfilePiSkillsDir,
  getProfilePiPromptsDir,
  getProfilePiThemesDir,
  getProfileKnowledgeDir,
  getProfileKnowledgePath,
  getProfileReferenceDir,
  getProfileReferencePath,
  getProfileScheduleFilePath,
  getProfileSchedulesDir,
  getProfilesDir,
  getRootSessionMemoryPath,
  getSessionDir,
  getSessionFilePath,
  getSessionFeedbackPath,
  getSessionMemoryPath,
  getSessionMetaPath,
  getSessionsDir,
  getCommonKnowledgePath,
  getCortexAutoReviewSettingsPath,
  getCortexNotesPath,
  getCortexPromotionManifestsDir,
  getCortexReviewLockPath,
  getCortexReviewLogPath,
  getCortexReviewRunsPath,
  getSharedAuthDir,
  getSharedAuthFilePath,
  getSharedCacheDir,
  getSharedCacheGeneratedDir,
  getSharedConfigDir,
  getSharedDir,
  getSharedIntegrationsDir,
  getSharedKnowledgeDir,
  getSharedSecretsFilePath,
  getSharedStateDir,
  getSharedStatsCachePath,
  getSwarmDir,
  getTelemetryConfigPath,
  getUploadsDir,
  getWorkerSessionFilePath,
  getWorkersDir,
  resolveMemoryFilePath,
  sanitizePathSegment
} from "../data-paths.js";

const DATA_DIR = join(tmpdir(), "forge-data");
const PROFILE_ID = "feature-manager";
const ROOT_SESSION_ID = "feature-manager";
const NON_ROOT_SESSION_ID = "feature-manager--s2";
const WORKER_ID = "backend-impl";

describe("data-paths", () => {
  it("resolves all hierarchy path helpers", () => {
    expect(getProfilesDir(DATA_DIR)).toBe(join(DATA_DIR, "profiles"));
    expect(getProfileDir(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID));
    expect(getSharedDir(DATA_DIR)).toBe(join(DATA_DIR, "shared"));
    expect(getSharedConfigDir(DATA_DIR)).toBe(join(DATA_DIR, "shared", "config"));
    expect(getSharedCacheDir(DATA_DIR)).toBe(join(DATA_DIR, "shared", "cache"));
    expect(getSharedStateDir(DATA_DIR)).toBe(join(DATA_DIR, "shared", "state"));

    expect(getProfileMemoryPath(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "memory.md"));
    expect(getProfileMergeAuditLogPath(DATA_DIR, PROFILE_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "merge-audit.log")
    );
    expect(getProfileReferenceDir(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "reference"));
    expect(getProfileReferencePath(DATA_DIR, PROFILE_ID, "index.md")).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "reference", "index.md")
    );
    expect(getProfilePiDir(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "pi"));
    expect(getProfilePiExtensionsDir(DATA_DIR, PROFILE_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "pi", "extensions")
    );
    expect(getProfilePiSkillsDir(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "pi", "skills"));
    expect(getProfilePiPromptsDir(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "pi", "prompts"));
    expect(getProfilePiThemesDir(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "pi", "themes"));

    expect(getSessionsDir(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "sessions"));
    expect(getSessionDir(DATA_DIR, PROFILE_ID, NON_ROOT_SESSION_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "sessions", NON_ROOT_SESSION_ID)
    );
    expect(getSessionMemoryPath(DATA_DIR, PROFILE_ID, NON_ROOT_SESSION_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "sessions", NON_ROOT_SESSION_ID, "memory.md")
    );
    expect(getRootSessionMemoryPath(DATA_DIR, PROFILE_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "sessions", PROFILE_ID, "memory.md")
    );
    expect(getSessionFilePath(DATA_DIR, PROFILE_ID, NON_ROOT_SESSION_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "sessions", NON_ROOT_SESSION_ID, "session.jsonl")
    );
    expect(getSessionFeedbackPath(DATA_DIR, PROFILE_ID, NON_ROOT_SESSION_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "sessions", NON_ROOT_SESSION_ID, "feedback.jsonl")
    );
    expect(getSessionMetaPath(DATA_DIR, PROFILE_ID, NON_ROOT_SESSION_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "sessions", NON_ROOT_SESSION_ID, "meta.json")
    );

    expect(getWorkersDir(DATA_DIR, PROFILE_ID, NON_ROOT_SESSION_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "sessions", NON_ROOT_SESSION_ID, "workers")
    );
    expect(getProjectAgentsDir(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "project-agents"));
    expect(getProjectAgentDir(DATA_DIR, PROFILE_ID, "release-notes")).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "project-agents", "release-notes")
    );
    expect(getProjectAgentConfigPath(DATA_DIR, PROFILE_ID, "release-notes")).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "project-agents", "release-notes", "config.json")
    );
    expect(getProjectAgentPromptPath(DATA_DIR, PROFILE_ID, "release-notes")).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "project-agents", "release-notes", "prompt.md")
    );
    expect(getProjectAgentReferenceDir(DATA_DIR, PROFILE_ID, "release-notes")).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "project-agents", "release-notes", "reference")
    );
    expect(getWorkerSessionFilePath(DATA_DIR, PROFILE_ID, NON_ROOT_SESSION_ID, WORKER_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "sessions", NON_ROOT_SESSION_ID, "workers", `${WORKER_ID}.jsonl`)
    );

    expect(getProfileIntegrationsDir(DATA_DIR, PROFILE_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "integrations")
    );
    expect(getProfileSchedulesDir(DATA_DIR, PROFILE_ID)).toBe(join(DATA_DIR, "profiles", PROFILE_ID, "schedules"));
    expect(getProfileScheduleFilePath(DATA_DIR, PROFILE_ID)).toBe(
      join(DATA_DIR, "profiles", PROFILE_ID, "schedules", "schedules.json")
    );

    expect(getSharedIntegrationsDir(DATA_DIR)).toBe(join(DATA_DIR, "shared", "config", "integrations"));
    expect(getSharedKnowledgeDir(DATA_DIR)).toBe(join(DATA_DIR, "shared", "knowledge"));
    expect(getProfileKnowledgeDir(DATA_DIR)).toBe(join(DATA_DIR, "shared", "knowledge", "profiles"));
    expect(getProfileKnowledgePath(DATA_DIR, PROFILE_ID)).toBe(
      join(DATA_DIR, "shared", "knowledge", "profiles", `${PROFILE_ID}.md`)
    );
    expect(getCommonKnowledgePath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "knowledge", "common.md"));
    expect(getCortexNotesPath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "knowledge", ".cortex-notes.md"));
    expect(getCortexReviewLogPath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "knowledge", ".cortex-review-log.jsonl"));
    expect(getCortexReviewRunsPath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "knowledge", ".cortex-review-runs.json"));
    expect(getCortexPromotionManifestsDir(DATA_DIR)).toBe(join(DATA_DIR, "shared", "knowledge", ".cortex-promotion-manifests"));
    expect(getCortexReviewLockPath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "knowledge", ".cortex-lock.json"));
    expect(getSharedAuthDir(DATA_DIR)).toBe(join(DATA_DIR, "shared", "config", "auth"));
    expect(getSharedAuthFilePath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "config", "auth", "auth.json"));
    expect(getSharedSecretsFilePath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "config", "secrets.json"));
    expect(getCortexAutoReviewSettingsPath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "config", "cortex-auto-review.json"));
    expect(getSharedCacheGeneratedDir(DATA_DIR)).toBe(join(DATA_DIR, "shared", "cache", "generated"));
    expect(getSharedStatsCachePath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "cache", "stats-cache.json"));
    expect(getTelemetryConfigPath(DATA_DIR)).toBe(join(DATA_DIR, "shared", "config", "telemetry.json"));

    expect(getUploadsDir(DATA_DIR)).toBe(join(DATA_DIR, "uploads"));
    expect(getSwarmDir(DATA_DIR)).toBe(join(DATA_DIR, "swarm"));
    expect(getAgentsStoreFilePath(DATA_DIR)).toBe(join(DATA_DIR, "swarm", "agents.json"));
  });

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

  it("legacy compat helpers resolve flat paths", () => {
    expect(getLegacyMemoryDirPath(DATA_DIR)).toBe(join(DATA_DIR, "memory"));
    expect(getLegacyAgentMemoryPath(DATA_DIR, NON_ROOT_SESSION_ID)).toBe(
      join(DATA_DIR, "memory", `${NON_ROOT_SESSION_ID}.md`)
    );
    expect(getLegacySessionsDirPath(DATA_DIR)).toBe(join(DATA_DIR, "sessions"));
    expect(getLegacySessionFilePath(DATA_DIR, NON_ROOT_SESSION_ID)).toBe(
      join(DATA_DIR, "sessions", `${NON_ROOT_SESSION_ID}.jsonl`)
    );
    expect(getLegacyAuthDirPath(DATA_DIR)).toBe(join(DATA_DIR, "auth"));
    expect(getLegacyAuthFilePath(DATA_DIR)).toBe(join(DATA_DIR, "auth", "auth.json"));
    expect(getLegacySecretsFilePath(DATA_DIR)).toBe(join(DATA_DIR, "secrets.json"));
  });
});
