import { describe, expect, it, vi } from "vitest";
import { ConversationProjector } from "../conversation-projector.js";
import { SessionDescriptorFactory } from "../session-descriptor-factory.js";
import { SessionPinCoordinator } from "../session-pin-coordinator.js";
import {
  createSwarmManagerSessionComposition,
} from "../swarm-manager-session-composition.js";
import type { SwarmConfig } from "../types.js";

function config(): SwarmConfig {
  return {
    host: "127.0.0.1",
    port: 47187,
    debug: false,
    isDesktop: false,
    runtimeTarget: "builder",
    cortexEnabled: false,
    allowNonManagerSubscriptions: false,
    managerDisplayName: "Manager",
    defaultModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" },
    defaultCwd: "/tmp",
    cwdAllowlistRoots: ["/tmp"],
    paths: {
      rootDir: "/tmp/forge-root",
      dataDir: "/tmp/forge-data",
      agentsStoreFile: "/tmp/forge-data/swarm/agents.json",
      uploadsDir: "/tmp/forge-data/uploads",
      sharedAuthFile: "/tmp/forge-data/shared/config/auth/auth.json",
      managerAgentDir: "/tmp/forge-root/manager-agent",
    } as SwarmConfig["paths"],
  };
}

describe("createSwarmManagerSessionComposition", () => {
  it("constructs the session domain in dependency order without invoking late capabilities", () => {
    const late = vi.fn((..._args: unknown[]): never => {
      throw new Error("late session-domain capability was invoked during composition");
    });
    const descriptors = new Map();
    const profiles = new Map();
    const runtimes = new Map();
    const now = () => "2026-07-13T12:00:00.000Z";
    const conversations = new ConversationProjector({
      descriptors,
      runtimes,
      conversationEntriesByAgentId: new Map(),
      now,
      emitServerEvent: late,
      logDebug: late,
      getPinnedMessageIds: () => undefined,
    });
    const pins = new SessionPinCoordinator({
      dataDir: "/tmp/forge-data",
      now,
      host: {
        listSessions: late,
        requireSession: late,
        requireBuilderSession: late,
        assertMutable: late,
        getConversationHistory: late,
        getRuntime: late,
        patchDescriptor: late,
        setConversationMessagePinned: late,
        captureRuntimePromptMeta: late,
        emitMessagePinned: late,
        emitAgentsSnapshot: late,
        logDebug: late,
      },
    });

    const composition = createSwarmManagerSessionComposition({
      state: { config: config(), descriptors, profiles, runtimes, now },
      services: {
        directory: { sortedDescriptors: late, listProfiles: late },
        descriptorFactory: new SessionDescriptorFactory(
          "/tmp/forge-data",
          profiles,
          descriptors,
          now,
        ),
        pins,
        conversations,
      },
      provisioner: {
        descriptorMutations: {
          upsertDescriptor: late,
          deleteDescriptor: late,
          upsertProfile: late,
          deleteProfile: late,
        },
        ensureProfilePiDirectories: late,
        ensureSessionFileParentDirectory: late,
        ensureAgentMemoryFile: late,
        getAgentMemoryPath: late,
        writeInitialSessionMeta: late,
        runRuntimeShutdown: late,
        detachRuntime: late,
        clearAgentTurnState: late,
        deleteManagerSessionFile: late,
        logDebug: late,
      },
      sessions: {
        getRequiredSessionDescriptor: late,
        getOrCreateRuntimeForDescriptor: late,
        stopSessionInternal: late,
        assertSessionIsDeletable: late,
        saveStore: late,
        writeInitialSessionMeta: late,
        notifyProjectAgentsChanged: late,
        emitSessionLifecycle: late,
        emitAgentsSnapshot: late,
        emitProfilesSnapshot: late,
        emitConversationReset: late,
        injectAgentCreatorContext: late,
        cancelAllPendingChoicesForAgent: late,
        clearPinsForConversationReset: late,
        captureSessionRuntimePromptMeta: late,
        appendSessionRenameHistoryEntry: late,
        clearSessionPlan: late,
        writeForkedSessionMemoryHeader: late,
        logDebug: late,
        now,
      },
      projectAgents: {
        getRequiredSessionDescriptor: late,
        assertSessionSupportsProjectAgent: late,
        getOrCreateRuntimeForDescriptor: late,
        upsertDescriptorInLiveMaps: late,
        captureSessionRuntimePromptMeta: late,
        saveStore: late,
        emitSessionLifecycle: late,
        emitAgentsSnapshot: late,
        emitProfilesSnapshot: late,
        emitSessionProjectAgentUpdated: late,
        notifyProjectAgentsChanged: late,
        logDebug: late,
      },
      sharing: { logDebug: late },
      projectAgentWorkflows: {
        access: {
          getRequiredBuilderSession: late,
          assertDescriptorNotEffectivelyArchived: late,
          assertSessionSupportsProjectAgent: late,
        },
        prompt: {
          getConversationHistory: late,
          buildResolvedManagerPrompt: late,
          resolveLiveSystemPrompt: late,
          readPersistedSystemPrompt: late,
        },
        runtime: { hasRuntime: late, recycleManager: late },
        persistence: { upsertDescriptorInLiveMaps: late, saveStore: late },
        events: { emitAgentsSnapshot: late, emitSessionProjectAgentUpdated: late },
        notifyProjectAgentsChanged: late,
        listSessionsForProfile: late,
        getPiModelsJsonPath: late,
        logDebug: late,
      },
      archive: {
        hydration: { patchDescriptor: late, warn: late },
        operations: {
          patchDescriptor: late,
          patchProfile: late,
          stopSessionForArchive: late,
          onProfileArchiveStopError: late,
        },
      },
    });

    expect(composition.provisioner).toBeDefined();
    expect(composition.archiveService).toBeDefined();
    expect(composition.sessionService).toBeDefined();
    expect(composition.projectAgentCoordinator).toBeDefined();
    expect(late).not.toHaveBeenCalled();
  });
});
