import { join } from "node:path";
import type { ObservabilityFacade } from "../observability/observability-types.js";
import { loadConfiguredSqliteDatabaseConstructor } from "../sqlite-database-loader.js";
import { backendSidebarPerfMetricManifest } from "../stats/sidebar-perf-metrics.js";
import { createSidebarPerfRegistry } from "../stats/sidebar-perf-registry.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import type { VersioningMutationSink } from "../versioning/versioning-types.js";
import { AgentDescriptorStore } from "./agents/agent-descriptor-store.js";
import {
  createLiveCompactionRuntimeSettingsProvider,
  type CompactionRuntimeSettingsProvider,
  type LiveCompactionRuntimeSettingsProvider,
} from "./compaction-runtime-settings-provider.js";
import { ConversationAttachmentService } from "./conversation-attachment-service.js";
import { ForgeExtensionHost } from "./forge-extension-host.js";
import { KnowledgeService } from "./knowledge-service.js";
import { KnowledgeV2SettingsService } from "./knowledge-v2-settings-service.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  inferSwarmModelPresetFromDescriptor,
  resolveModelDescriptorFromPreset,
} from "./model-presets.js";
import { FileBackedPromptRegistry, type PromptRegistry } from "./prompt-registry.js";
import { SecretsEnvService } from "./secrets-env-service.js";
import { SessionDescriptorFactory } from "./session-descriptor-factory.js";
import { DockerSecureExecutionBackend } from "./secure-sessions/execution/docker-secure-execution-backend.js";
import { BitwardenBwsSecretSource, BwsCommandClient } from "./secure-sessions/sources/bitwarden-bws-source.js";
import { ElectronSafeStorageClient } from "./secure-sessions/sources/electron-safe-storage-client.js";
import { LocalEncryptedSecretSource } from "./secure-sessions/sources/local-encrypted-source.js";
import { SecureSessionStore } from "./secure-sessions/storage/secure-session-store.js";
import {
  SessionPinCoordinator,
  type SessionPinCoordinatorHost,
} from "./session-pin-coordinator.js";
import { SkillFileService } from "./skill-file-service.js";
import { SkillMetadataService } from "./skill-metadata-service.js";
import { SwarmObservabilityCoordinator } from "./swarm-observability-coordinator.js";
import { getSecureSessionsDbPath } from "./storage/data-paths.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig, SwarmModelPreset } from "./types.js";

export interface SecureSessionsFoundation {
  storeFactory: () => Promise<SecureSessionStore>;
  cipher: ElectronSafeStorageClient;
  localSource: LocalEncryptedSecretSource;
  bitwardenSource: BitwardenBwsSecretSource;
  probeBitwarden: () => Promise<boolean>;
  execution: DockerSecureExecutionBackend;
}

/**
 * Constructor dependencies that are intentionally replaceable in tests or by
 * an embedding host. These are values, not a service locator: every optional
 * override has exactly one consumer in the returned foundation.
 */
export interface SwarmManagerFoundationOverrides {
  observability?: ObservabilityFacade;
  compactionRuntimeSettingsProvider?: CompactionRuntimeSettingsProvider;
  knowledgeV2SettingsService?: KnowledgeV2SettingsService;
  knowledgeService?: KnowledgeService;
}

export interface SwarmManagerFoundationOptions {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  now: () => string;
  versioningService?: VersioningMutationSink;
  getConfiguredManagerId: () => string | undefined;
  getRuntimeToken: (agentId: string) => number | undefined;
  sessionPins: SessionPinCoordinatorHost;
  logDebug: (message: string, details?: unknown) => void;
  overrides?: SwarmManagerFoundationOverrides;
}

export interface SwarmManagerFoundation {
  config: SwarmConfig;
  defaultModelPreset: SwarmModelPreset;
  compactionRuntimeSettingsProvider: CompactionRuntimeSettingsProvider;
  liveCompactionRuntimeSettingsProvider: LiveCompactionRuntimeSettingsProvider;
  knowledgeV2SettingsService: KnowledgeV2SettingsService;
  knowledgeService: KnowledgeService;
  promptRegistry: PromptRegistry;
  forgeExtensionHost: ForgeExtensionHost;
  sidebarPerfRecorder: SidebarPerfRecorder;
  descriptorStore: AgentDescriptorStore;
  conversationAttachmentService: ConversationAttachmentService;
  sessionDescriptorFactory: SessionDescriptorFactory;
  sessionPinCoordinator: SessionPinCoordinator;
  skillMetadataService: SkillMetadataService;
  skillFileService: SkillFileService;
  secretsEnvService: SecretsEnvService;
  secureSessions: SecureSessionsFoundation;
  observabilityCoordinator: SwarmObservabilityCoordinator;
}

/**
 * Builds the acyclic, low-level portion of the manager graph.
 *
 * Higher-level services are deliberately excluded. In particular this function
 * does not construct runtime, lifecycle, message, boot, or project-agent
 * coordinators, so it cannot conceal their dependency cycles. The two callbacks
 * that target later state (`getRuntimeToken` and pin-host runtime lookup) remain
 * lazy and are not invoked during composition.
 */
export function createSwarmManagerFoundation(
  options: SwarmManagerFoundationOptions,
): SwarmManagerFoundation {
  const defaultModelPreset =
    inferSwarmModelPresetFromDescriptor(options.config.defaultModel) ?? DEFAULT_SWARM_MODEL_PRESET;
  const config: SwarmConfig = {
    ...options.config,
    defaultModel: resolveModelDescriptorFromPreset(defaultModelPreset),
  };
  const overrides = options.overrides ?? {};
  const liveCompactionRuntimeSettingsProvider = createLiveCompactionRuntimeSettingsProvider();
  const compactionRuntimeSettingsProvider =
    overrides.compactionRuntimeSettingsProvider ?? liveCompactionRuntimeSettingsProvider;
  const knowledgeV2SettingsService =
    overrides.knowledgeV2SettingsService ??
    new KnowledgeV2SettingsService({ dataDir: config.paths.dataDir });
  const knowledgeService =
    overrides.knowledgeService ??
    new KnowledgeService({
      dataDir: config.paths.dataDir,
      settingsService: knowledgeV2SettingsService,
      versioning: options.versioningService,
      now: () => new Date(options.now()),
    });

  const resourcesDir = config.paths.resourcesDir ?? config.paths.rootDir;
  const promptRegistry = new FileBackedPromptRegistry({
    dataDir: config.paths.dataDir,
    repoDir: config.paths.rootDir,
    builtinArchetypesDir: join(
      resourcesDir,
      "apps",
      "backend",
      "src",
      "swarm",
      "archetypes",
      "builtins",
    ),
    builtinOperationalDir: join(
      resourcesDir,
      "apps",
      "backend",
      "src",
      "swarm",
      "operational",
      "builtins",
    ),
    versioning: options.versioningService,
  });
  const forgeExtensionHost = new ForgeExtensionHost({
    dataDir: config.paths.dataDir,
    now: options.now,
  });
  const sidebarPerfRecorder = createSidebarPerfRegistry({
    manifest: backendSidebarPerfMetricManifest,
  });
  const descriptorStore = new AgentDescriptorStore({
    dataDir: config.paths.dataDir,
    storeFilePath: config.paths.agentsStoreFile,
    configuredManagerId: options.getConfiguredManagerId(),
    logDebug: options.logDebug,
  });
  const conversationAttachmentService = new ConversationAttachmentService({
    dataDir: config.paths.dataDir,
    uploadsDir: config.paths.uploadsDir,
  });
  const sessionDescriptorFactory = new SessionDescriptorFactory(
    config.paths.dataDir,
    options.profiles,
    options.descriptors,
    options.now,
  );
  const sessionPinCoordinator = new SessionPinCoordinator({
    dataDir: config.paths.dataDir,
    now: options.now,
    host: options.sessionPins,
  });
  const skillMetadataService = new SkillMetadataService({ config });
  const skillFileService = new SkillFileService();
  const secretsEnvService = new SecretsEnvService({
    config,
    ensureSkillMetadataLoaded: () => skillMetadataService.ensureSkillMetadataLoaded(),
    getSkillMetadata: () => skillMetadataService.getSkillMetadata(),
  });
  const secureVaultCipher = new ElectronSafeStorageClient();
  const bitwardenClient = new BwsCommandClient();
  const secureSessions: SecureSessionsFoundation = {
    storeFactory: () =>
      SecureSessionStore.open(
        {
          dbPath: getSecureSessionsDbPath(config.paths.dataDir),
          loadDatabaseModule:
            config.remoteUpdateAwarenessModules?.loadDatabaseModule ??
            loadConfiguredSqliteDatabaseConstructor,
        },
        () => new Date(options.now()),
      ),
    cipher: secureVaultCipher,
    localSource: new LocalEncryptedSecretSource(secureVaultCipher),
    bitwardenSource: new BitwardenBwsSecretSource(secureVaultCipher, bitwardenClient),
    probeBitwarden: () => bitwardenClient.probe(),
    execution: new DockerSecureExecutionBackend({
      scope: config.paths.dataDir,
    }),
  };
  const observabilityCoordinator = new SwarmObservabilityCoordinator({
    service: overrides.observability,
    descriptors: options.descriptors,
    getRuntimeToken: options.getRuntimeToken,
  });

  return {
    config,
    defaultModelPreset,
    compactionRuntimeSettingsProvider,
    liveCompactionRuntimeSettingsProvider,
    knowledgeV2SettingsService,
    knowledgeService,
    promptRegistry,
    forgeExtensionHost,
    sidebarPerfRecorder,
    descriptorStore,
    conversationAttachmentService,
    sessionDescriptorFactory,
    sessionPinCoordinator,
    skillMetadataService,
    skillFileService,
    secretsEnvService,
    secureSessions,
    observabilityCoordinator,
  };
}
