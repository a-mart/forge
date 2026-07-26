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

// ── Integration paths ─────────────────────────────────────────────────────────

export function getIntegrationsDir(dataDir: string): string {
  return join(dataDir, "integrations");
}

export function getExternalChromeIntegrationDir(dataDir: string): string {
  return join(getIntegrationsDir(dataDir), "external-chrome");
}

export function getExternalChromeExtensionDir(dataDir: string): string {
  return join(getExternalChromeIntegrationDir(dataDir), "extension");
}

export function getExternalChromeExtensionPayloadsDir(dataDir: string): string {
  return join(getExternalChromeExtensionDir(dataDir), "payloads");
}

export function getExternalChromeExtensionCurrentPath(dataDir: string): string {
  return join(getExternalChromeExtensionDir(dataDir), "current.json");
}

export function getExternalChromeNativeHostDir(dataDir: string): string {
  return join(getExternalChromeIntegrationDir(dataDir), "native-host");
}

export function getExternalChromeNativeHostExecutablePath(
  dataDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  return join(
    getExternalChromeNativeHostDir(dataDir),
    `forge-external-chrome-native-host${platform === "win32" ? ".exe" : ""}`
  );
}

export function getExternalChromeNativeHostManifestsDir(dataDir: string): string {
  return join(getExternalChromeIntegrationDir(dataDir), "native-host-manifests");
}

export function getExternalChromeNativeHostManifestPath(dataDir: string): string {
  return join(getExternalChromeNativeHostManifestsDir(dataDir), "com.forge.external_chrome.json");
}

export function getExternalChromeStateDir(dataDir: string): string {
  return join(getExternalChromeIntegrationDir(dataDir), "state");
}

export function getExternalChromeAuthDir(dataDir: string): string {
  return join(getExternalChromeIntegrationDir(dataDir), "auth");
}

export function getExternalChromeRunDir(dataDir: string): string {
  return join(getExternalChromeIntegrationDir(dataDir), "run");
}

export function getExternalChromeDeploymentDir(dataDir: string): string {
  return join(getExternalChromeIntegrationDir(dataDir), "deployment");
}

export function getExternalChromeDeploymentLockPath(dataDir: string): string {
  return join(getExternalChromeIntegrationDir(dataDir), "deploy.lock");
}

export function getExternalChromeInstallStatePath(dataDir: string): string {
  return join(getExternalChromeStateDir(dataDir), "install.json");
}

export function getExternalChromePreviousStatePath(dataDir: string): string {
  return join(getExternalChromeStateDir(dataDir), "previous.json");
}

export function getExternalChromeDeploymentJournalPath(dataDir: string): string {
  return join(getExternalChromeDeploymentDir(dataDir), "journal.json");
}

export function getExternalChromeAuthKeyPath(dataDir: string): string {
  return join(getExternalChromeAuthDir(dataDir), "native-messaging.key");
}

export function getExternalChromeRendezvousPath(dataDir: string): string {
  return join(getExternalChromeRunDir(dataDir), "rendezvous.json");
}

// ── Profile-level paths ────────────────────────────────────────────────────────

export function getGlobalForgeExtensionsDir(dataDir: string): string {
  return join(dataDir, "extensions");
}

export function getProfileForgeExtensionsDir(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "extensions");
}

export function getProjectLocalForgeExtensionsDir(cwd: string): string {
  return join(cwd, ".forge", "extensions");
}

export function getProjectForgeSkillsDir(forgeDir: string): string {
  return join(forgeDir, "skills");
}

export function getProjectForgeSpecialistsDir(forgeDir: string): string {
  return join(forgeDir, "specialists");
}

export function getProjectForgeReferenceDir(forgeDir: string): string {
  return join(forgeDir, "reference");
}

export function getProjectForgeProjectAgentsDir(forgeDir: string): string {
  return join(forgeDir, "project-agents");
}

export function getProjectForgeExtensionsDir(forgeDir: string): string {
  return join(forgeDir, "extensions");
}

export function getProjectForgePiExtensionsDir(forgeDir: string): string {
  return join(forgeDir, "pi", "extensions");
}

export function getProjectForgePiSettingsPath(forgeDir: string): string {
  return join(forgeDir, "pi", "settings.json");
}

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

export function getSessionTurnLedgerPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "turns.jsonl");
}

export function getSessionFeedbackPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "feedback.jsonl");
}

export function getSessionMetaPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "meta.json");
}

export function getSessionPlanPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "plan.json");
}

export function getSessionPlanHistoryPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "plan-history.ndjson");
}

export function getSessionPlanUsagePath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "plan-usage.ndjson");
}

export function getSessionGoalPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "goal.json");
}

export function getSessionGoalHistoryPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "goal-history.ndjson");
}

export function getSessionBrowserStatePath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "browser.json");
}

export function getSessionBrowserArtifactsDir(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "artifacts", "browser");
}

export function getSessionContextDir(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "context");
}

export function getSessionContextPromptPath(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionContextDir(dataDir, profileId, sessionAgentId), "prompt.md");
}

export function getSessionReferenceDir(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionDir(dataDir, profileId, sessionAgentId), "reference");
}

/**
 * Legacy collaboration channel reference-doc location.
 * Keep only for read fallback and non-destructive migration to getSessionReferenceDir().
 */
export function getSessionContextReferenceDir(dataDir: string, profileId: string, sessionAgentId: string): string {
  return join(getSessionContextDir(dataDir, profileId, sessionAgentId), "reference");
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

// ── Project agent paths ────────────────────────────────────────────────────────

export function getProjectAgentsDir(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "project-agents");
}

export function getProjectAgentBackupsDir(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "project-agent-backups");
}

export function getProjectAgentBackupDir(
  dataDir: string,
  profileId: string,
  agentId: string,
  handle: string,
  timestamp: string
): string {
  const safeTimestamp = timestamp.replace(/[^0-9A-Za-z._-]/g, "-");
  return join(
    getProjectAgentBackupsDir(dataDir, profileId),
    `${sanitizePathSegment(agentId)}-${sanitizePathSegment(handle)}-${safeTimestamp}`
  );
}

export function getProjectAgentDir(dataDir: string, profileId: string, handle: string): string {
  return join(getProjectAgentsDir(dataDir, profileId), sanitizePathSegment(handle));
}

export function getProjectAgentConfigPath(dataDir: string, profileId: string, handle: string): string {
  return join(getProjectAgentDir(dataDir, profileId, handle), "config.json");
}

export function getProjectAgentPromptPath(dataDir: string, profileId: string, handle: string): string {
  return join(getProjectAgentDir(dataDir, profileId, handle), "prompt.md");
}

export function getProjectAgentReferenceDir(dataDir: string, profileId: string, handle: string): string {
  return join(getProjectAgentDir(dataDir, profileId, handle), "reference");
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

export function getSharedKnowledgeDir(dataDir: string): string {
  return join(getSharedDir(dataDir), "knowledge");
}

export function getKnowledgeEntriesDir(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), "entries");
}

export function getKnowledgeArchiveDir(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), "archive");
}

export function getKnowledgeLegacyArchiveDir(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".archive");
}

export function getKnowledgeReferenceDir(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), "reference");
}

export function getKnowledgeIndexPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), "INDEX.md");
}

export function getProfileKnowledgeV2Dir(dataDir: string, profileId: string): string {
  return join(getProfileDir(dataDir, profileId), "knowledge");
}

export function getProfileKnowledgeEntriesDir(dataDir: string, profileId: string): string {
  return join(getProfileKnowledgeV2Dir(dataDir, profileId), "entries");
}

export function getProfileKnowledgeArchiveDir(dataDir: string, profileId: string): string {
  return join(getProfileKnowledgeV2Dir(dataDir, profileId), "archive");
}

export function getProfileKnowledgeIndexPath(dataDir: string, profileId: string): string {
  return join(getProfileKnowledgeV2Dir(dataDir, profileId), "INDEX.md");
}

export function getKnowledgeMigrationLockPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".knowledge-v2-migration.lock.json");
}

export function getKnowledgeMigrationManifestPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".knowledge-v2-migration-manifest.json");
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

export function getCortexReviewLogPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".cortex-review-log.jsonl");
}

export function getCortexConsolidationRunsPath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".cortex-consolidation-runs.json");
}

export function getCortexPromotionManifestsDir(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ".cortex-promotion-manifests");
}

export function getSharedAuthDir(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "auth");
}

export function getSharedAuthFilePath(dataDir: string): string {
  return join(getSharedAuthDir(dataDir), "auth.json");
}

export function getCliAccessFilePath(dataDir: string): string {
  return join(getSharedAuthDir(dataDir), "cli-access.json");
}

export function getStreamDeckAccessFilePath(dataDir: string): string {
  return join(getSharedAuthDir(dataDir), "stream-deck-access.json");
}

export function getLegacyCliAccessFilePath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "cli-access.json");
}

export function getSharedCollaborationConfigDir(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "collaboration");
}

export function getCollaborationAuthDbPath(dataDir: string): string {
  return join(getSharedCollaborationConfigDir(dataDir), "auth.db");
}

export function getRemoteUpdateAwarenessDbPath(dataDir: string): string {
  return join(getSharedStateDir(dataDir), "remote-update-awareness.db");
}

export function getSecureSessionsDbPath(dataDir: string): string {
  return join(getSharedStateDir(dataDir), "secure-sessions.db");
}

export function getCollaborationAuthSecretPath(dataDir: string): string {
  return join(getSharedCollaborationConfigDir(dataDir), "auth-secret.key");
}

export function getSharedSecretsFilePath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "secrets.json");
}

export function getProjectResourceSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "project-resources.json");
}

export function getBuilderSidebarOrderPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "builder-sidebar-order.json");
}

export function getPhoenixObservabilitySettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "phoenix-observability.json");
}

export function getCortexAutoReviewSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "cortex-auto-review.json");
}

export function getKnowledgeV2SettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "knowledge-v2.json");
}

export function getCompactionSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "compaction-settings.json");
}

export function getModelCacheVisualizationSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "model-cache-visualization.json");
}

export function getRepositorySettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "repository-settings.json");
}

export function getProjectAgentSharingStorePath(dataDir: string): string {
  return join(getSharedStateDir(dataDir), "project-agent-shares.json");
}

export function getSharedMobileDevicesPath(dataDir: string): string {
  return join(getSharedStateDir(dataDir), "mobile-devices.json");
}

export function getSharedMobileNotificationPreferencesPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "mobile-notification-prefs.json");
}

export function getNotificationSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "notification-settings.json");
}

export function getRemoteBuildSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "remote-build-settings.json");
}

export function getTerminalSettingsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "terminal-settings.json");
}

export function getSharedModelOverridesPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "model-overrides.json");
}

export function getOpenRouterModelsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "openrouter-models.json");
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

export function getSharedTokenAnalyticsCachePath(dataDir: string): string {
  return join(getSharedCacheDir(dataDir), "token-analytics-cache.json");
}

export function getTelemetryConfigPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "telemetry.json");
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
