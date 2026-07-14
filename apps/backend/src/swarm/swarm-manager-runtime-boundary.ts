import type { ArchiveLastUsedHydrator } from "./archive/archive-last-used-hydrator.js";
import type { ArchiveService } from "./archive/archive-service.js";
import type { AgentDirectory } from "./agent-directory.js";
import type { CodexDirectSidecarCoordinator } from "./codex-app-server/codex-direct-sidecar-coordinator.js";
import type { CodexPluginDelegationCoordinator } from "./codex-app-server/codex-plugin-delegation-coordinator.js";
import type { ConversationProjector } from "./conversation-projector.js";
import type { SessionGoalCoordinator } from "./goals/session-goal-coordinator.js";
import type { KnowledgeMemoryCoordinator } from "./knowledge-memory-coordinator.js";
import type { ProjectAgentCoordinator } from "./project-agent-coordinator.js";
import type { PromptRegistry } from "./prompt-registry.js";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.js";
import type { SessionProvisioner } from "./session-provisioner.js";
import type { SwarmBootCoordinator } from "./swarm-boot-coordinator.js";
import type { SwarmChoiceService } from "./swarm-choice-service.js";
import type { SwarmConfigurationCoordinator } from "./swarm-configuration-coordinator.js";
import type { SwarmCortexService } from "./swarm-cortex-service.js";
import type { SwarmEventCoordinator } from "./swarm-event-coordinator.js";
import type { SwarmProjectAgentService } from "./swarm-project-agent-service.js";
import type { SwarmRuntimeLifecycleCoordinator } from "./swarm-runtime-lifecycle-coordinator.js";
import type { SwarmSessionMetaService } from "./swarm-session-meta-service.js";
import type { SwarmSessionService } from "./swarm-session-service.js";
import type { TurnContextCoordinator } from "./turn-context-coordinator.js";
import type {
  CodexPluginDelegationTurnContext,
  CodexPluginRetryAuthorizationContext,
} from "./codex-app-server/codex-plugin-delegation-coordinator.js";
import type { CodexMcpToolGateEvaluation } from "./codex-app-server/codex-mcp-tool-gate.js";
import type { ProjectExecutableTrustCoordinator } from "./project-executable-trust-coordinator.js";
import type { SwarmAgentLifecycleService } from "./swarm-agent-lifecycle-service.js";

export interface SwarmManagerRuntimeBoundServices {
  conversation: ConversationProjector;
  configuration: SwarmConfigurationCoordinator;
  knowledge: KnowledgeMemoryCoordinator;
  cortex: SwarmCortexService;
  directory: AgentDirectory;
  eventCoordinator: SwarmEventCoordinator;
  sessionMeta: SwarmSessionMetaService;
  choices: SwarmChoiceService;
  provisioner: SessionProvisioner;
  sessionService: SwarmSessionService;
  archiveHydrator: ArchiveLastUsedHydrator;
  archive: ArchiveService;
  projectAgentService: SwarmProjectAgentService;
  projectAgents: ProjectAgentCoordinator;
  codexDirect: CodexDirectSidecarCoordinator;
  codexPlugin: CodexPluginDelegationCoordinator;
  promptRegistry: PromptRegistry;
}

export interface SwarmManagerRuntimeCompositionOverrides {
  interruptExternalThreadSidecarTurn?: (agentId: string) => Promise<void>;
  terminateExternalThreadSidecarTurn?: (agentId: string) => Promise<void>;
}

export interface SwarmManagerCompletedRuntimeComposition {
  turnContext: TurnContextCoordinator<
    CodexMcpToolGateEvaluation,
    CodexPluginDelegationTurnContext,
    CodexPluginRetryAuthorizationContext
  >;
  runtimeLifecycle: SwarmRuntimeLifecycleCoordinator;
  goals: SessionGoalCoordinator;
  lifecycle: SwarmAgentLifecycleService;
  projectExecutableTrust: ProjectExecutableTrustCoordinator;
  sessionLifecycle: SessionLifecycleCoordinator;
  boot: SwarmBootCoordinator;
}
