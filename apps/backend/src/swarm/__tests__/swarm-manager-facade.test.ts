import { describe, expect, it, vi } from "vitest";
import { SwarmManagerFacade } from "../swarm-manager-facade.js";
import type { SwarmManagerFacadeServices } from "../swarm-manager-facade-services.js";
import type { AgentDescriptor } from "../types.js";

const NOW = "2026-07-14T16:00:00.000Z";

const INTERNAL_RUNTIME_CONTROL_MEMBERS = [
  "onAcceptedRuntimeSessionEvent",
  "recordManagerTurnWatchdogStatus",
  "recordManagerTurnWatchdogEvent",
  "recordManagerTurnWatchdogRuntimeError",
  "recordManagerTurnWatchdogTerminal",
  "consumePendingManualManagerStopNoticeIfApplicable",
  "stripManagerAbortErrorFromEvent",
  "checkForStalledWorkers",
  "handleStallNudge",
  "handleStallDetailedReport",
  "handleStallAutoKill",
  "finalizeWorkerIdleTurn",
  "getOrCreateWorkerWatchdogState",
  "clearWatchdogTimer",
  "removeWorkerFromWatchdogBatchQueues",
  "beginPendingTransientWorkerTerminatedError",
  "cancelPendingTransientWorkerTerminatedError",
  "hasPendingTransientWorkerTerminatedError",
  "workerWatchdogState",
  "workerStallState",
  "workerActivityState",
  "watchdogTimers",
  "watchdogTimerTokens",
  "watchdogBatchQueueByManager",
  "watchdogBatchTimersByManager",
] as const;

type InternalRuntimeControlMember = (typeof INTERNAL_RUNTIME_CONTROL_MEMBERS)[number];
type LeakedInternalRuntimeControlMember = Extract<
  InternalRuntimeControlMember,
  keyof SwarmManagerFacade
>;
const NO_INTERNAL_RUNTIME_CONTROL_MEMBERS: [LeakedInternalRuntimeControlMember] extends [never]
  ? true
  : false = true;

describe("SwarmManagerFacade", () => {
  it("does not re-expose runtime host plumbing or mutable worker-health state", () => {
    expect(NO_INTERNAL_RUNTIME_CONTROL_MEMBERS).toBe(true);
    const facadeMembers = Object.getOwnPropertyNames(SwarmManagerFacade.prototype);

    expect(
      facadeMembers.filter((member) =>
        INTERNAL_RUNTIME_CONTROL_MEMBERS.includes(member as InternalRuntimeControlMember),
      ),
    ).toEqual([]);
  });

  it("resolves services lazily, preserves EventEmitter behavior, and permits normal overrides", () => {
    const services = createServices();
    const facade = new TestFacade(services);
    expect(facade.serviceReads).toBe(0);

    const listener = vi.fn();
    facade.on("ready", listener);
    facade.emit("ready", "ok");
    expect(listener).toHaveBeenCalledWith("ok");

    expect(facade.listAgents()).toEqual([MANAGER]);
    expect(facade.serviceReads).toBe(1);

    class OverrideFacade extends TestFacade {
      override listAgents(): AgentDescriptor[] {
        return [];
      }
    }
    expect(new OverrideFacade(services).listAgents()).toEqual([]);
  });

  it("forwards configuration, skill, auth, and credential arguments exactly", async () => {
    const services = createServices();
    const facade = new TestFacade(services);

    await facade.updateSessionModel("session", "override", "fast", "high");
    await facade.listSkillFiles("skill", "references", { profileId: "profile" });
    await facade.updateSettingsAuth({ OPENAI_API_KEY: "redacted" });
    await facade.setCredentialPoolStrategy("openai", "round_robin");

    expect(services.configuration.updateSessionModel).toHaveBeenCalledWith(
      "session",
      "override",
      "fast",
      "high",
    );
    expect(services.configuration.listSkillFiles).toHaveBeenCalledWith(
      "skill",
      "references",
      { profileId: "profile" },
    );
    expect(services.configuration.updateSettingsAuth).toHaveBeenCalledWith({
      OPENAI_API_KEY: "redacted",
    });
    expect(services.configuration.setCredentialPoolStrategy).toHaveBeenCalledWith(
      "openai",
      "round_robin",
    );
  });

  it("preserves conversation fallback and extension session projection", async () => {
    const services = createServices();
    const facade = new TestFacade(services);

    expect(facade.getConversationHistory()).toEqual([{ type: "conversation_message" }]);
    await facade.buildForgeExtensionSettingsSnapshot({ cwdValues: ["/workspace"] });

    expect(services.conversation.projector.getConversationHistory).toHaveBeenCalledWith(
      "manager",
    );
    expect(services.extensions.buildSettingsSnapshot).toHaveBeenCalledWith({
      cwdValues: ["/workspace"],
      sessions: [MANAGER],
    });

    vi.mocked(services.registry.directory.resolvePreferredManagerId).mockReturnValue(undefined);
    expect(facade.getConversationHistoryWithDiagnostics()).toMatchObject({
      history: [],
      diagnostics: { detail: "missing_agent" },
    });
  });

  it("keeps Codex, Project Agent, and knowledge APIs on their focused owners", async () => {
    const services = createServices();
    const facade = new TestFacade(services);

    await facade.browseCodexMcpCatalog("manager");
    await facade.getProjectAgentReference("manager", "guide.md");
    await facade.searchKnowledge("manager", { query: "preference", scope: "all" });

    expect(services.codexPlugin.browseCatalog).toHaveBeenCalledWith("manager");
    expect(services.projectAgents.getReference).toHaveBeenCalledWith(
      "manager",
      "guide.md",
    );
    expect(services.knowledge.searchKnowledge).toHaveBeenCalledWith("manager", {
      query: "preference",
      scope: "all",
    });
  });

  it("preserves runtime callback wiring and terminal hook ownership", async () => {
    const services = createServices();
    const facade = new TestFacade(services);
    const hooks = {
      suspendProfileTerminals: vi.fn(async () => undefined),
      restoreProfileTerminals: vi.fn(async () => undefined),
    };

    await facade.maybeRecoverWorkerWithSpecialistFallback(
      "worker",
      "failed",
      "prompt_start",
      7,
    );
    const recoveryInput = vi.mocked(
      services.runtime.specialists.maybeRecoverWorkerWithSpecialistFallback,
    ).mock.calls[0]![0];
    recoveryInput.handleRuntimeStatus(7, "worker", "idle", 0);
    await recoveryInput.handleRuntimeAgentEnd(7, "worker");
    facade.setTerminalArchiveHooks(hooks);

    expect(services.runtime.lifecycle.handleRuntimeStatus).toHaveBeenCalledWith(
      7,
      "worker",
      "idle",
      0,
      undefined,
    );
    expect(services.runtime.lifecycle.handleRuntimeAgentEnd).toHaveBeenCalledWith(7, "worker");
    expect(services.host.setTerminalArchiveHooks).toHaveBeenCalledWith(hooks);
  });

  it("projects Codex transport diagnostics without exposing raw agent ids", () => {
    const services = createServices();
    const facade = new TestFacade(services);

    const diagnostics = facade.getCodexTransportDebugDiagnostics();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        agentId: "manager",
        agentIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        runtimeAvailable: false,
        websocketStatsStatus: "runtime_inactive",
        directPiSessionStatsStatus: "runtime_inactive",
      }),
    ]);
  });
});

class TestFacade extends SwarmManagerFacade {
  serviceReads = 0;

  constructor(private readonly facadeServices: SwarmManagerFacadeServices) {
    super();
  }

  protected getFacadeServices(): SwarmManagerFacadeServices {
    this.serviceReads += 1;
    return this.facadeServices;
  }
}

const MANAGER: AgentDescriptor = {
  agentId: "manager",
  displayName: "Manager",
  role: "manager",
  managerId: "manager",
  profileId: "profile",
  status: "idle",
  createdAt: NOW,
  updatedAt: NOW,
  cwd: "/workspace",
  model: { provider: "openai-codex", modelId: "gpt-5" },
  sessionFile: "/data/manager.jsonl",
};

function createServices(): SwarmManagerFacadeServices {
  const configuration = {
    updateSessionModel: vi.fn(async () => undefined),
    listSkillFiles: vi.fn(async () => ({})),
    updateSettingsAuth: vi.fn(async () => undefined),
    setCredentialPoolStrategy: vi.fn(async () => undefined),
  };
  const services = {
    interactions: {},
    sessions: {},
    pins: {},
    projectAgents: {
      getReference: vi.fn(async () => "reference"),
      notifyProjectAgentsChanged: vi.fn(async () => undefined),
    },
    profileBookkeeping: { reorderProfiles: vi.fn(async () => undefined) },
    knowledge: {
      searchKnowledge: vi.fn(async () => []),
      listCortexConsolidationRuns: vi.fn(async () => []),
    },
    agents: { notifySpecialistRosterChanged: vi.fn(async () => undefined) },
    codexPlugin: { browseCatalog: vi.fn(async () => ({})) },
    messages: {},
    userMessages: {},
    boot: { boot: vi.fn(async () => undefined) },
    recovery: {
      dismiss: vi.fn(() => null),
      getSnapshot: vi.fn(() => null),
      resume: vi.fn(async () => null),
    },
    configuration,
    registry: {
      directory: {
        listAgents: vi.fn(() => [MANAGER]),
        sortedDescriptors: vi.fn(() => [MANAGER]),
        resolvePreferredManagerId: vi.fn(() => "manager"),
      },
      descriptorMutations: {},
    },
    runtime: {
      controller: {},
      lifecycle: {
        handleRuntimeStatus: vi.fn(),
        handleRuntimeAgentEnd: vi.fn(async () => undefined),
      },
      specialists: {
        maybeRecoverWorkerWithSpecialistFallback: vi.fn(async () => true),
      },
      turns: {},
      assistantOutput: {},
      activeTools: {},
      runtimes: new Map(),
    },
    events: {},
    conversation: {
      projector: {
        getConversationHistory: vi.fn(() => [{ type: "conversation_message" }]),
        getConversationHistoryWithDiagnostics: vi.fn(() => ({ history: [], diagnostics: {} })),
      },
      sidebarPerf: {},
    },
    collaboration: {},
    trust: {},
    codexDirect: {},
    observability: {},
    extensions: { buildSettingsSnapshot: vi.fn(async () => ({})) },
    host: {
      config: { paths: { dataDir: "/data" } },
      setTerminalArchiveHooks: vi.fn(),
      logDebug: vi.fn(),
    },
  };

  return services as unknown as SwarmManagerFacadeServices;
}
