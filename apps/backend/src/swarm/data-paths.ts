import { join } from "node:path";

export interface MemoryPathDescriptor {
  agentId: string;
  role: "manager" | "worker";
  profileId?: string;
  managerId: string;
}

export interface MemoryPathParentDescriptor {
  profileId?: string;
}

// ── Directory roots ────────────────────────────────────────────────────────────

export function getProfilesDir(dataDir: string): string {
  return join(dataDir, "profiles");
}

export function getProfileDir(dataDir: string, profileId: string): string {
  return join(getProfilesDir(dataDir), sanitizePathSegment(profileId));
}

export function getSharedDir(dataDir: string): string {
  return join(dataDir, "shared");
}

export function getSharedConfigDir(dataDir: string): string {
  return join(getSharedDir(dataDir), "config");
}

export function getSharedCacheDir(dataDir: string): string {
  return join(getSharedDir(dataDir), "cache");
}

export function getSharedStateDir(dataDir: string): string {
  return join(getSharedDir(dataDir), "state");
}

// ── Profile-level paths ────────────────────────────────────────────────────────

export function getProfilePiDir(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "pi");
}

export function getProfilePiExtensionsDir(dataDir: string, profileId: string): string {
  return join(getProfilePiDir(dataDir, profileId), "extensions");
}

export function getProfilePiSkillsDir(dataDir: string, profileId: string): string {
  return join(getProfilePiDir(dataDir, profileId), "skills");
}

export function getProfilePiPromptsDir(dataDir: string, profileId: string): string {
  return join(getProfilePiDir(dataDir, profileId), "prompts");
}

export function getProfilePiThemesDir(dataDir: string, profileId: string): string {
  return join(getProfilePiDir(dataDir, profileId), "themes");
}

export function getProfileMemoryPath(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "memory.md");
}

export function getProfileMergeAuditLogPath(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "merge-audit.log");
}

export function getProfileUnreadStatePath(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "unread-state.json");
}

export function getProfileReferenceDir(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "reference");
}

export function getProfileReferencePath(dataDir: string, profileId: string, fileName: string): string {
  return join(getProfileReferenceDir(dataDir, profileId), sanitizePathSegment(fileName));
}

// ── Session-level paths ────────────────────────────────────────────────────────

export function getSessionsDir(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "sessions");
}

export function getSessionDir(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionsDir(dataDir, profileId), sanitizePathSegment(sessionAgentId));
}

export function getSessionMemoryPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "memory.md");
}

export function getRootSessionMemoryPath(dataDir: string, profileId: string): string {
  return getSessionMemoryPath(dataDir, profileId, profileId);
}

export function getSessionFilePath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "session.jsonl");
}

export function getSessionFeedbackPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "feedback.jsonl");
}

export function getSessionMetaPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "meta.json");
}

export function getSessionTerminalsDir(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "terminals");
}

function getTerminalDir(dataDir: string, profileId: string, sessionAgentId: string, terminalId: string): string {
  return join(getSessionTerminalsDir(dataDir, profileId, sessionAgentId), sanitizePathSegment(terminalId));
}

export function getTerminalMetaPath(
  dataDir: string,
  profileId: string,
  sessionAgentId: string,
  terminalId: string
): string {
  return join(getTerminalDir(dataDir, profileId, sessionAgentId, terminalId), "meta.json");
}

export function getTerminalSnapshotPath(
  dataDir: string,
  profileId: string,
  sessionAgentId: string,
  terminalId: string
): string {
  return join(getTerminalDir(dataDir, profileId, sessionAgentId, terminalId), "snapshot.vt");
}

export function getTerminalLogPath(
  dataDir: string,
  profileId: string,
  sessionAgentId: string,
  terminalId: string
): string {
  return join(getTerminalDir(dataDir, profileId, sessionAgentId, terminalId), "delta.ndjson");
}

// ── Worker-level paths ─────────────────────────────────────────────────────────

export function getWorkersDir(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "workers");
}

export function getWorkerSessionFilePath(
  dataDir: string,
  profileId: string,
  sessionAgentId: string,
  workerId: string
): string {
  return join(getWorkersDir(dataDir, profileId, sessionAgentId), `${sanitizePathSegment(workerId)}.jsonl`);
}

// ── Profile-scoped config paths ────────────────────────────────────────────────

export function getProfileIntegrationsDir(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "integrations");
}

export function getProfileSchedulesDir(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "schedules");
}

export function getProfileScheduleFilePath(dataDir: string, profileId: string): string {
  return join(getProfileSchedulesDir(dataDir, profileId), "schedules.json");
}

export function getProfileSlashCommandsPath(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "slash-commands.json");
}

// ── Shared paths ────────────────────────────────────────────────────────────────

export function getSharedIntegrationsDir(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "integrations");
}

export function getSharedKnowledgeDir(dataDir: string): string {
  return join(getSharedDir(dataDir), "knowledge");
}

export function getProfileKnowledgeDir(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), "profiles");
}

export function getProfileKnowledgePath(dataDir: string, profileId: string): string {
  return join(getProfileKnowledgeDir(dataDir), `${sanitizePathSegment(profileId)}.md`);
}

export function getCommonKnowledgePath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), "common.md");
}

export function getCortexNotesPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".cortex-notes.md");
}

export function getCortexWorkerPromptsPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".cortex-worker-prompts.md");
}

export function getCortexReviewLogPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".cortex-review-log.jsonl");
}

export function getCortexPromotionManifestsDir(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".cortex-promotion-manifests");
}

export function getCortexReviewLockPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".cortex-lock.json");
}

export function getCortexReviewRunsPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".cortex-review-runs.json");
}

export function getSharedAuthDir(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "auth");
}

export function getSharedAuthFilePath(dataDir: string): string {
  return join(getSharedAuthDir(dataDir), "auth.json");
}

export function getSharedSecretsFilePath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "secrets.json");
}

export function getSharedPlaywrightDashboardSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "playwright-dashboard.json");
}

export function getCortexAutoReviewSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "cortex-auto-review.json");
}

export function getSharedMobileDevicesPath(dataDir: string): string {
  return join(getSharedStateDir(dataDir), "mobile-devices.json");
}

export function getSharedMobileNotificationPreferencesPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "mobile-notification-prefs.json");
}

export function getTerminalSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "terminal-settings.json");
}

export function getSharedModelOverridesPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "model-overrides.json");
}

export function getGlobalSlashCommandsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "slash-commands.json");
}

export function getSharedCacheGeneratedDir(dataDir: string): string {
  return join(getSharedCacheDir(dataDir), "generated");
}

export function getSharedStatsCachePath(dataDir: string): string {
  return join(getSharedCacheDir(dataDir), "stats-cache.json");
}

// ── Unchanged global paths ─────────────────────────────────────────────────────

export function getUploadsDir(dataDir: string): string {
  return join(dataDir, "uploads");
}

export function getSwarmDir(dataDir: string): string {
  return join(dataDir, "swarm");
}

export function getAgentsStoreFilePath(dataDir: string): string {
  return join(getSwarmDir(dataDir), "agents.json");
}

// ── Unified memory path resolver ───────────────────────────────────────────────

/**
 * Resolves the correct memory file path for any agent based on role and
 * ownership. This is the single entry point that replaces the old
 * `getAgentMemoryPath(dataDir, agentId)` function.
 */
export function resolveMemoryFilePath(
  dataDir: string,
  descriptor: MemoryPathDescriptor,
  parentDescriptor?: MemoryPathParentDescriptor
): string {
  if (descriptor.role === "manager") {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const isRootSession = descriptor.agentId === profileId;

    if (isRootSession) {
      // Root sessions now have their own working memory, separate from canonical profile memory.
      return getRootSessionMemoryPath(dataDir, profileId);
    }

    // Non-root sessions have their own session memory.
    return getSessionMemoryPath(dataDir, profileId, descriptor.agentId);
  }

  // Workers: resolve to their owning session's working memory.
  // Workers do NOT get their own memory file.
  // The memory owner is the managerId (which is the session agent).
  // We need the parent's profileId to build the path.
  const parentProfileId = parentDescriptor?.profileId ?? descriptor.managerId;
  const isParentRootSession = descriptor.managerId === parentProfileId;

  if (isParentRootSession) {
    return getRootSessionMemoryPath(dataDir, parentProfileId);
  }

  return getSessionMemoryPath(dataDir, parentProfileId, descriptor.managerId);
}

// ── Path segment sanitization ───────────────────────────────────────────────────

/**
 * Sanitize a string for safe use as a single filesystem path segment.
 * Rejects path separators, traversal sequences, null bytes, and control chars.
 */
export function sanitizePathSegment(segment: string): string {
  const trimmed = segment.trim();

  if (trimmed.length === 0) {
    throw new Error(`Invalid path segment: "${segment}"`);
  }

  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`Invalid path segment: "${segment}"`);
  }

  if (/[\\/]/.test(trimmed)) {
    throw new Error(`Invalid path segment: "${segment}"`);
  }

  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    throw new Error(`Invalid path segment: "${segment}"`);
  }

  if (/[<>:"|?*]/.test(trimmed)) {
    throw new Error(`Invalid path segment: "${segment}"`);
  }

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) {
    throw new Error(`Invalid path segment: "${segment}"`);
  }

  if (/[.\s]$/.test(trimmed)) {
    throw new Error(`Invalid path segment: "${segment}"`);
  }

  return trimmed;
}

// ── Legacy compatibility (to be removed after migration) ───────────────────────

/** @deprecated Use profile/session hierarchy helpers instead. */
export function getLegacyMemoryDirPath(dataDir: string): string {
  return join(dataDir, "memory");
}

/** @deprecated Use resolveMemoryFilePath() instead. */
export function getLegacyAgentMemoryPath(dataDir: string, agentId: string): string {
  return join(getLegacyMemoryDirPath(dataDir), `${sanitizePathSegment(agentId)}.md`);
}

/** @deprecated Use profile/session hierarchy helpers instead. */
export function getLegacySessionsDirPath(dataDir: string): string {
  return join(dataDir, "sessions");
}

/** @deprecated Use getSessionFilePath() or getWorkerSessionFilePath() instead. */
export function getLegacySessionFilePath(dataDir: string, agentId: string): string {
  return join(getLegacySessionsDirPath(dataDir), `${sanitizePathSegment(agentId)}.jsonl`);
}

/** @deprecated Use shared auth helpers instead. */
export function getLegacyAuthDirPath(dataDir: string): string {
  return join(dataDir, "auth");
}

/** @deprecated Use getSharedAuthFilePath() instead. */
export function getLegacyAuthFilePath(dataDir: string): string {
  return join(getLegacyAuthDirPath(dataDir), "auth.json");
}

/** @deprecated Use getSharedSecretsFilePath() instead. */
export function getLegacySecretsFilePath(dataDir: string): string {
  return join(dataDir, "secrets.json");
}
