import type { SwarmAgentRuntime } from "../runtime-contracts.js";
import type {
  AgentDescriptor,
  ConversationMessageEvent,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "../types.js";
import {
  getProjectAgentPublicName,
  type ProjectAgentDirectoryEntry
} from "./project-agent-registry.js";
export {
  findProjectAgentByHandle,
  getProjectAgentHandleCollisionError,
  getProjectAgentPublicName,
  listProjectAgents,
  normalizeProjectAgentHandle,
  type ListProjectAgentsOptions,
  type ProjectAgentDescriptor,
  type ProjectAgentDirectoryEntry
} from "./project-agent-registry.js";

export const PROJECT_AGENT_DIRECTORY_MAX_ENTRIES = 12;

export function normalizeProjectAgentInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function generateProjectAgentDirectoryBlock(entries: ProjectAgentDirectoryEntry[]): string {
  if (entries.length === 0) {
    return "Project agents in this profile — none configured.";
  }

  // Cap prompt growth here so profiles with many promoted sessions do not linearly inflate
  // every manager prompt. The summary line preserves discoverability without listing all entries.
  const visibleEntries = entries.slice(0, PROJECT_AGENT_DIRECTORY_MAX_ENTRIES);
  const hiddenCount = Math.max(0, entries.length - visibleEntries.length);

  const lines = [
    "Project agents in this profile — use `send_message_to_agent` for async cross-session coordination.",
    ...visibleEntries.map((entry) => {
      const displayName = normalizeProjectAgentInlineText(entry.displayName) || entry.agentId;
      const whenToUse = normalizeProjectAgentInlineText(entry.whenToUse);
      return `- ${displayName} (\`@${entry.handle}\`, agentId: \`${entry.agentId}\`): ${whenToUse}`;
    }),
    ...(hiddenCount > 0 ? [`(+${hiddenCount} more project agents not shown)`] : []),
    "These are peer manager sessions in the same profile, not workers. Workers do not have this directory."
  ];

  return lines.join("\n");
}

export const PROJECT_AGENT_MESSAGES_PER_MINUTE = 6;
const PROJECT_AGENT_RATE_LIMIT_WINDOW_MS = 60_000;
const PROJECT_AGENT_RATE_LIMIT_ERROR =
  "Project-agent messaging rate limit exceeded for this session. Batch your message or involve the user before continuing.";

interface DeliverProjectAgentMessageDependencies {
  now: () => string;
  getOrCreateRuntimeForDescriptor: (descriptor: AgentDescriptor) => Promise<SwarmAgentRuntime>;
  emitConversationMessage: (event: ConversationMessageEvent) => void;
  markSessionActivity?: (agentId: string, timestamp?: string) => void;
  rateLimitBuckets: Map<string, number[]>;
}

interface DeliverProjectAgentMessageOptions {
  sender: AgentDescriptor;
  target: AgentDescriptor;
  message: string;
  delivery: RequestedDeliveryMode;
}

export function formatProjectAgentRuntimeMessage(context: {
  fromAgentId: string;
  fromDisplayName: string;
}, message: string): string {
  return `[projectAgentContext] ${JSON.stringify(context)}\n\n${message}`;
}

export async function deliverProjectAgentMessage(
  deps: DeliverProjectAgentMessageDependencies,
  options: DeliverProjectAgentMessageOptions
): Promise<SendMessageReceipt> {
  const sender = assertManagerSession(options.sender, "sender");
  const target = assertManagerSession(options.target, "target");

  if (!target.projectAgent && target.creatorAgentId !== sender.agentId) {
    throw new Error(`Target session is not promoted to a project agent: ${target.agentId}`);
  }

  const senderProfileId = sender.profileId ?? sender.agentId;
  const targetProfileId = target.profileId ?? target.agentId;
  if (senderProfileId !== targetProfileId) {
    throw new Error("Project-agent messaging is only allowed between manager sessions in the same profile.");
  }

  enforceProjectAgentRateLimit(deps.rateLimitBuckets, sender.agentId, Date.now());

  const timestamp = deps.now();
  const projectAgentContext = {
    fromAgentId: sender.agentId,
    fromDisplayName: getProjectAgentPublicName(sender)
  };

  const runtime = await deps.getOrCreateRuntimeForDescriptor(target);
  const receipt = await runtime.sendMessage(
    formatProjectAgentRuntimeMessage(projectAgentContext, options.message),
    options.delivery
  );

  deps.emitConversationMessage({
    type: "conversation_message",
    agentId: target.agentId,
    role: "user",
    text: options.message,
    timestamp,
    source: "project_agent_input",
    projectAgentContext
  });
  deps.markSessionActivity?.(target.agentId, timestamp);

  return receipt;
}

function assertManagerSession(
  descriptor: AgentDescriptor,
  roleLabel: "sender" | "target"
): AgentDescriptor & { role: "manager" } {
  if (descriptor.role !== "manager") {
    throw new Error(`Project-agent delivery requires the ${roleLabel} to be a manager session.`);
  }

  return descriptor as AgentDescriptor & { role: "manager" };
}

function enforceProjectAgentRateLimit(
  buckets: Map<string, number[]>,
  senderAgentId: string,
  nowMs: number
): void {
  const cutoff = nowMs - PROJECT_AGENT_RATE_LIMIT_WINDOW_MS;
  const activeTimestamps = (buckets.get(senderAgentId) ?? []).filter((timestamp) => timestamp > cutoff);

  if (activeTimestamps.length >= PROJECT_AGENT_MESSAGES_PER_MINUTE) {
    buckets.set(senderAgentId, activeTimestamps);
    throw new Error(PROJECT_AGENT_RATE_LIMIT_ERROR);
  }

  activeTimestamps.push(nowMs);
  buckets.set(senderAgentId, activeTimestamps);
}
