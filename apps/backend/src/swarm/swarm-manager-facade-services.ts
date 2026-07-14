import type { AgentMessageDispatcher } from "./agent-message-dispatcher.js";
import type { AgentDirectory } from "./agent-directory.js";
import type { AssistantOutputRouter } from "./assistant-output-router.js";
import type { CodexDirectSidecarCoordinator } from "./codex-app-server/codex-direct-sidecar-coordinator.js";
import type { CodexPluginDelegationCoordinator } from "./codex-app-server/codex-plugin-delegation-coordinator.js";
import type { CollaborationStorageProvisioner } from "./collaboration-storage-provisioner.js";
import type { ConversationProjector } from "./conversation-projector.js";
import type { ForgeExtensionHost } from "./forge-extension-host.js";
import type { SessionGoalCoordinator } from "./goals/session-goal-coordinator.js";
import type { KnowledgeMemoryCoordinator } from "./knowledge-memory-coordinator.js";
import type { ProfileSessionBookkeepingCoordinator } from "./profile-session-bookkeeping-coordinator.js";
import type { ProjectAgentCoordinator } from "./project-agent-coordinator.js";
import type { ProjectExecutableTrustCoordinator } from "./project-executable-trust-coordinator.js";
import type { RestartRecoveryCoordinator } from "./restart-recovery-coordinator.js";
import type { SessionInteractionCoordinator } from "./session-interaction-coordinator.js";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.js";
import type { SessionPinCoordinator } from "./session-pin-coordinator.js";
import type { SessionActiveToolsState } from "./session-active-tools.js";
import type { SwarmAgentLifecycleService } from "./swarm-agent-lifecycle-service.js";
import type { SwarmBootCoordinator } from "./swarm-boot-coordinator.js";
import type { SwarmConfigurationCoordinator } from "./swarm-configuration-coordinator.js";
import type { SwarmEventCoordinator } from "./swarm-event-coordinator.js";
import type { SwarmObservabilityCoordinator } from "./swarm-observability-coordinator.js";
import type { SwarmRuntimeController } from "./swarm-runtime-controller.js";
import type { SwarmRuntimeLifecycleCoordinator } from "./swarm-runtime-lifecycle-coordinator.js";
import type { SwarmSessionMetaService } from "./swarm-session-meta-service.js";
import type { SwarmSpecialistFallbackManager } from "./swarm-specialist-fallback-manager.js";
import type { TurnContextCoordinator } from "./turn-context-coordinator.js";
import type { UserMessageCoordinator } from "./user-message-coordinator.js";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import type { VersioningMutationSink } from "../versioning/versioning-types.js";
import type { SwarmConfig } from "./types.js";

export interface TerminalArchiveHooks {
  suspendProfileTerminals(profileId: string): Promise<unknown>;
  restoreProfileTerminals(profileId: string): Promise<unknown>;
}

export interface SwarmManagerFacadeRuntimeServices {
  controller: Pick<
    SwarmRuntimeController,
    "listRuntimeExtensionSnapshots" | "updateWorkerActivity"
  >;
  lifecycle: Pick<
    SwarmRuntimeLifecycleCoordinator,
    | "getWorkerActivity"
    | "handleRuntimeAgentEnd"
    | "handleRuntimeError"
    | "handleRuntimeSessionEvent"
    | "handleRuntimeStatus"
  >;
  specialists: Pick<
    SwarmSpecialistFallbackManager,
    "maybeRecoverWorkerWithSpecialistFallback" | "resolveSpecialistFallbackModelForDescriptor"
  >;
  turns: Pick<
    TurnContextCoordinator<unknown, unknown, unknown>,
    "afterRuntimeEventProjection" | "beforeRuntimeEventProjection" | "getActiveTurnId"
  >;
  assistantOutput: Pick<
    AssistantOutputRouter,
    "deliverTerminalObligationBackstop" | "resolveManagerFinalRoute" | "resolveManagerFinalTarget"
  >;
  activeTools: Pick<SessionActiveToolsState, "buildSnapshotEvent">;
  runtimes: ReadonlyMap<string, SwarmAgentRuntime>;
}

export interface SwarmManagerFacadeHostServices {
  config: SwarmConfig;
  versioningService?: VersioningMutationSink;
  setTerminalArchiveHooks(hooks?: TerminalArchiveHooks): void;
  logDebug(message: string, details?: unknown): void;
}

export interface SwarmManagerSessionFacadeServices {
  interactions: SessionInteractionCoordinator;
  goals: Pick<
    SessionGoalCoordinator,
    "control" | "create" | "get" | "getSnapshotEvent" | "update"
  >;
  sessions: SessionLifecycleCoordinator;
  pins: SessionPinCoordinator;
  projectAgents: ProjectAgentCoordinator;
  profileBookkeeping: ProfileSessionBookkeepingCoordinator;
  knowledge: KnowledgeMemoryCoordinator;
  agents: Pick<
    SwarmAgentLifecycleService,
    "notifySpecialistRosterChanged" | "resumeWorker" | "stopWorker"
  >;
  codexPlugin: CodexPluginDelegationCoordinator;
  messages: Pick<AgentMessageDispatcher<unknown>, "sendMessage">;
  userMessages: UserMessageCoordinator;
}

export interface SwarmManagerFacadeServices extends SwarmManagerSessionFacadeServices {
  boot: Pick<SwarmBootCoordinator, "boot">;
  recovery: Pick<RestartRecoveryCoordinator, "dismiss" | "getSnapshot" | "resume">;
  configuration: SwarmConfigurationCoordinator;
  registry: {
    directory: AgentDirectory;
  };
  runtime: SwarmManagerFacadeRuntimeServices;
  events: Pick<
    SwarmEventCoordinator,
    "emitModelCacheObservation" | "getAgentsSnapshotVersion" | "getProfilesSnapshotVersion"
  >;
  conversation: {
    projector: Pick<
      ConversationProjector,
      "getConversationHistory" | "getConversationHistoryWithDiagnostics"
    >;
    sidebarPerf: SidebarPerfRecorder;
  };
  collaboration: CollaborationStorageProvisioner;
  trust: ProjectExecutableTrustCoordinator;
  codexDirect: Pick<CodexDirectSidecarCoordinator, "isSidecarDescriptor">;
  observability: SwarmObservabilityCoordinator;
  persistence: Pick<SwarmSessionMetaService, "flushPendingTurnSeqPersists">;
  extensions: Pick<
    ForgeExtensionHost,
    "buildSettingsSnapshot" | "dispatchVersioningCommit"
  >;
  host: SwarmManagerFacadeHostServices;
}
