import type {
  AgentDescriptor,
  ChoiceAnswer,
  ChoiceQuestion,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SpawnAgentInput
} from "./types.js";

export interface SwarmToolHost {
  listAgents(): AgentDescriptor[];
  getWorkerActivity(agentId: string): {
    currentTool: string | null;
    currentToolElapsedSec: number;
    toolCalls: number;
    errors: number;
    turns: number;
    idleSec: number;
  } | undefined;
  spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor>;
  killAgent(callerAgentId: string, targetAgentId: string): Promise<void>;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode
  ): Promise<SendMessageReceipt>;
  createSessionFromAgent(
    creatorAgentId: string,
    params: {
      sessionName: string;
      cwd?: string;
      model?: unknown;
      reasoningLevel?: unknown;
      systemPrompt?: string;
      initialMessage?: string;
    }
  ): Promise<{ sessionAgentId: string; sessionLabel: string; profileId: string }>;
  createAndPromoteProjectAgent?(
    creatorAgentId: string,
    params: {
      sessionName: string;
      handle?: string;
      whenToUse: string;
      systemPrompt: string;
    }
  ): Promise<{ agentId: string; handle: string }>;
  publishToUser(
    agentId: string,
    text: string,
    source?: "speak_to_user" | "system",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }>;
  requestUserChoice(
    agentId: string,
    questions: ChoiceQuestion[],
  ): Promise<ChoiceAnswer[]>;
}
