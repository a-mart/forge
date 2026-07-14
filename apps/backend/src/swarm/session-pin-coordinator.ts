import { getSessionDir } from "./data-paths.js";
import {
  clearAllPins as clearAllSessionPins,
  formatPinnedMessagesForCompaction,
  loadPins,
  savePins,
  togglePin,
  type PinRegistry,
} from "./message-pins.js";
import type { SetPinnedContentOptions } from "./runtime-contracts.js";
import { collectConversationMessageIdsFromSessionFile } from "./session/conversation-timeline.js";
import type {
  AgentDescriptor,
  ConversationEntryEvent,
  ConversationMessageEvent,
} from "./types.js";

export type SessionPinOwner = AgentDescriptor & { role: "manager"; profileId: string };

export interface SessionPinRuntime {
  getSystemPrompt?(): string;
  setPinnedContent?(content: string | undefined, options?: SetPinnedContentOptions): void | Promise<void>;
}

export interface SessionPinCoordinatorHost {
  listSessions: () => SessionPinOwner[];
  requireSession: (agentId: string) => SessionPinOwner;
  requireBuilderSession: (agentId: string, action: string) => SessionPinOwner;
  assertMutable: (descriptor: SessionPinOwner) => void;
  getConversationHistory: (agentId: string) => ConversationEntryEvent[];
  getRuntime: (agentId: string) => SessionPinRuntime | undefined;
  patchDescriptor: (
    agentId: string,
    patch: (descriptor: AgentDescriptor) => AgentDescriptor,
  ) => Promise<AgentDescriptor>;
  setConversationMessagePinned: (agentId: string, messageId: string, pinned: boolean) => void;
  captureRuntimePromptMeta: (
    descriptor: SessionPinOwner,
    resolvedSystemPrompt?: string | null,
  ) => Promise<void>;
  emitMessagePinned: (agentId: string, messageId: string, pinned: boolean, timestamp: string) => void;
  emitAgentsSnapshot: () => void;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
}

export interface SessionPinCoordinatorOptions {
  dataDir: string;
  now: () => string;
  host: SessionPinCoordinatorHost;
}

export class SessionPinCoordinator {
  private readonly pinnedMessageIdsBySessionAgentId = new Map<string, Set<string>>();

  constructor(private readonly options: SessionPinCoordinatorOptions) {}

  hasPinnedContent(agentId: string): boolean {
    return this.pinnedMessageIdsBySessionAgentId.has(agentId);
  }

  getPinnedMessageIds(agentId: string): ReadonlySet<string> | undefined {
    return this.pinnedMessageIdsBySessionAgentId.get(agentId);
  }

  forget(agentId: string): void {
    this.pinnedMessageIdsBySessionAgentId.delete(agentId);
  }

  async preload(): Promise<void> {
    await Promise.all(this.options.host.listSessions().map(async (descriptor) => {
      const registry = await loadPins(this.getSessionDir(descriptor));
      this.setRegistry(descriptor.agentId, registry);
    }));
  }

  async syncPinnedContent(
    descriptor: SessionPinOwner,
    options?: {
      registry?: PinRegistry;
      runtime?: SessionPinRuntime;
      setPinnedContentOptions?: SetPinnedContentOptions;
    },
  ): Promise<PinRegistry> {
    const registry = options?.registry ?? await loadPins(this.getSessionDir(descriptor));
    this.setRegistry(descriptor.agentId, registry);

    const runtime = options?.runtime ?? this.options.host.getRuntime(descriptor.agentId);
    if (runtime?.setPinnedContent) {
      await runtime.setPinnedContent(
        formatPinnedMessagesForCompaction(registry),
        options?.setPinnedContentOptions,
      );
    }

    return registry;
  }

  async pinMessage(
    agentId: string,
    messageId: string,
    pinned: boolean,
  ): Promise<{ pinned: boolean; timestamp: string }> {
    const descriptor = this.options.host.requireSession(agentId);
    this.options.host.assertMutable(descriptor);
    const message = this.findPinnableMessage(agentId, messageId);

    if (pinned && !message) {
      throw new Error(`Message not found or not pinnable: ${messageId}`);
    }

    const registry = await togglePin(
      this.getSessionDir(descriptor),
      messageId,
      pinned,
      message
        ? {
            role: message.role,
            text: message.text,
            timestamp: message.timestamp,
            attachments: message.attachments,
          }
        : undefined,
    );

    await this.syncPinnedContent(descriptor, { registry });
    this.options.host.setConversationMessagePinned(agentId, messageId, pinned);

    const runtime = this.options.host.getRuntime(agentId);
    if (runtime) {
      await this.options.host.captureRuntimePromptMeta(descriptor, runtime.getSystemPrompt?.());
    }

    const timestamp = this.options.now();
    this.options.host.logDebug("message:pin", { agentId, messageId, pinned });
    return { pinned, timestamp };
  }

  async clearAllPins(agentId: string): Promise<void> {
    const descriptor = this.options.host.requireBuilderSession(agentId, "clear Builder pins");
    this.options.host.assertMutable(descriptor);
    const previouslyPinnedMessageIds = await clearAllSessionPins(this.getSessionDir(descriptor));

    const emptyRegistry: PinRegistry = { version: 1, pins: {} };
    await this.syncPinnedContent(descriptor, { registry: emptyRegistry });

    const runtime = this.options.host.getRuntime(agentId);
    if (runtime) {
      await this.options.host.captureRuntimePromptMeta(descriptor, runtime.getSystemPrompt?.());
    }

    if (previouslyPinnedMessageIds.length === 0) {
      return;
    }

    for (const messageId of previouslyPinnedMessageIds) {
      this.options.host.setConversationMessagePinned(agentId, messageId, false);
      this.options.host.emitMessagePinned(agentId, messageId, false, this.options.now());
    }
    this.options.host.logDebug("message:clear_all_pins", {
      agentId,
      clearedCount: previouslyPinnedMessageIds.length,
    });
  }

  async clearForConversationReset(descriptor: SessionPinOwner): Promise<void> {
    const emptyRegistry: PinRegistry = { version: 1, pins: {} };
    await savePins(this.getSessionDir(descriptor), emptyRegistry);
    await this.syncPinnedContent(descriptor, {
      registry: emptyRegistry,
      setPinnedContentOptions: { suppressRecycle: true },
    });
  }

  async copyPinsForFork(
    sourceDescriptor: SessionPinOwner,
    forkedDescriptor: SessionPinOwner,
  ): Promise<void> {
    const sourceRegistry = await loadPins(this.getSessionDir(sourceDescriptor));
    if (Object.keys(sourceRegistry.pins).length === 0) {
      this.setRegistry(forkedDescriptor.agentId, { version: 1, pins: {} });
      return;
    }

    const forkedMessageIds = await collectConversationMessageIdsFromSessionFile(forkedDescriptor.sessionFile);
    const filteredRegistry: PinRegistry = {
      version: 1,
      pins: Object.fromEntries(
        Object.entries(sourceRegistry.pins).filter(([messageId]) => forkedMessageIds.has(messageId)),
      ),
    };

    if (Object.keys(filteredRegistry.pins).length > 0) {
      await savePins(this.getSessionDir(forkedDescriptor), filteredRegistry);
    }
    this.setRegistry(forkedDescriptor.agentId, filteredRegistry);
  }

  async pinSession(agentId: string, pinned: boolean): Promise<{ pinnedAt: string | null }> {
    const descriptor = this.options.host.requireBuilderSession(agentId, "pin Builder sessions");
    this.options.host.assertMutable(descriptor);

    const updatedDescriptor = await this.options.host.patchDescriptor(agentId, (current) => {
      if (pinned) {
        current.pinnedAt = current.pinnedAt ?? this.options.now();
      } else {
        delete current.pinnedAt;
      }
      return current;
    });
    this.options.host.emitAgentsSnapshot();
    return { pinnedAt: updatedDescriptor.pinnedAt ?? null };
  }

  private setRegistry(agentId: string, registry: PinRegistry): void {
    const pinnedMessageIds = Object.keys(registry.pins);
    if (pinnedMessageIds.length === 0) {
      this.pinnedMessageIdsBySessionAgentId.delete(agentId);
      return;
    }
    this.pinnedMessageIdsBySessionAgentId.set(agentId, new Set(pinnedMessageIds));
  }

  private findPinnableMessage(
    agentId: string,
    messageId: string,
  ): (ConversationMessageEvent & { role: "user" | "assistant" }) | undefined {
    return this.options.host.getConversationHistory(agentId).find(
      (entry): entry is ConversationMessageEvent & { role: "user" | "assistant" } => (
        entry.type === "conversation_message"
        && entry.id === messageId
        && (entry.role === "user" || entry.role === "assistant")
      ),
    );
  }

  private getSessionDir(descriptor: { agentId: string; profileId?: string }): string {
    return getSessionDir(
      this.options.dataDir,
      descriptor.profileId ?? descriptor.agentId,
      descriptor.agentId,
    );
  }
}
