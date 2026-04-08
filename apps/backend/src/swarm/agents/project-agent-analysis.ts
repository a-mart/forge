import { complete, type Api, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import { normalizeProjectAgentInlineText } from "../project-agents.js";
import type { ConversationEntryEvent, ConversationMessageEvent } from "../types.js";

export interface ProjectAgentRecommendations {
  whenToUse: string;
  systemPrompt: string;
}

export interface AnalyzeSessionForPromotionOptions {
  conversationHistory: ConversationEntryEvent[];
  currentSystemPrompt: string;
  sessionAgentId?: string;
  sessionLabel?: string;
  displayName?: string;
  profileId?: string;
  sessionCwd?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  now?: () => number;
  completeFn?: typeof complete;
}

export const PROJECT_AGENT_ANALYSIS_SYSTEM_PROMPT = [
  "You are a senior prompt architect specializing in Forge project-agent promotion.",
  "Your task is to analyze a manager session and recommend how it should be promoted into a specialized project agent.",
  "",
  "You must return exactly one JSON object with two fields:",
  "- whenToUse: a concise routing directive for sibling manager sessions.",
  "- systemPrompt: a full replacement BASE manager prompt for this specialized role.",
  "",
  "Critical runtime facts:",
  "- The generated systemPrompt becomes the BASE TEMPLATE inside buildResolvedManagerPrompt().",
  "- Therefore it MUST include the core manager behavioral norms that the normal manager archetype carries.",
  "- That includes user communication through speak_to_user, delegation-first workflow, worker management, and manager coordination norms.",
  "- The runtime WILL automatically append specialist roster, project-agent directory, integration context, and memory-derived context.",
  "- Do NOT include specialist roster content, project-agent directory content, integration context, or memory blocks in the generated systemPrompt.",
  "- Think of the output as writing a custom manager archetype prompt for this specific role.",
  "",
  "Guidelines for whenToUse:",
  "- Maximum 280 characters.",
  "- Write as a routing directive such as 'Use for...' or 'Handles...'.",
  "- Be specific about domains, task types, subsystems, repositories, file paths, or expertise areas when supported by evidence.",
  "- Avoid vague generic wording.",
  "",
  "Guidelines for systemPrompt:",
  "- Write a complete manager base prompt for this specialization.",
  "- Include the essential manager norms: speak_to_user for user-facing communication, delegation-first execution, intentional worker management, and safe coordination.",
  "- Focus the unique parts on the observed domain ownership, expertise, conventions, validation habits, subsystem knowledge, decision boundaries, and escalation triggers.",
  "- Carry forward durable constraints or conventions that are actually evidenced in the transcript or current base prompt.",
  "- Do not invent authority, credentials, ownership, or repo facts that are not supported by evidence.",
  "- Do not add filler, motivational language, or generic boilerplate beyond the manager norms that must remain present.",
  "",
  "Return only valid JSON. Do not wrap it in prose."
].join("\n");

export async function analyzeSessionForPromotion(
  model: Model<Api>,
  options: AnalyzeSessionForPromotionOptions
): Promise<ProjectAgentRecommendations> {
  const invokeComplete = options.completeFn ?? complete;
  const response = await invokeComplete(
    model,
    {
      systemPrompt: PROJECT_AGENT_ANALYSIS_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          timestamp: options.now?.() ?? Date.now(),
          content: [{ type: "text", text: buildAnalysisUserPrompt(options) }]
        }
      ]
    },
    options.apiKey || options.headers
      ? {
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          ...(options.headers ? { headers: options.headers } : {})
        }
      : undefined
  );

  return parseRecommendations(response);
}

export function extractTranscriptSummary(
  history: ConversationEntryEvent[],
  maxChars = 30_000
): string {
  const transcriptEntries = history.filter(isTranscriptConversationMessage);
  if (transcriptEntries.length === 0 || maxChars <= 0) {
    return "";
  }

  const lines = transcriptEntries.map(formatTranscriptEntry);
  const selected: string[] = [];
  let totalChars = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const separatorLength = selected.length > 0 ? 2 : 0;
    const projectedLength = totalChars + separatorLength + line.length;

    if (projectedLength <= maxChars) {
      selected.unshift(line);
      totalChars = projectedLength;
      continue;
    }

    if (selected.length === 0) {
      selected.unshift(truncateTranscriptLine(line, maxChars));
    }
    break;
  }

  if (selected.length === 0) {
    return "";
  }

  const omittedCount = transcriptEntries.length - selected.length;
  if (omittedCount > 0) {
    selected.unshift(`(${omittedCount} earlier transcript messages omitted)`);
  }

  return selected.join("\n\n");
}

export function parseRecommendations(message: AssistantMessage): ProjectAgentRecommendations {
  const text = message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();

  if (!text) {
    throw new Error("Failed to parse project agent recommendations: empty response");
  }

  const parsed = parseJsonObject(text);
  if (!parsed) {
    throw new Error("Failed to parse project agent recommendations: no valid JSON object found in response");
  }

  const whenToUse = typeof parsed.whenToUse === "string" ? normalizeProjectAgentInlineText(parsed.whenToUse) : "";
  const systemPrompt = typeof parsed.systemPrompt === "string" ? parsed.systemPrompt.trim() : "";

  if (!whenToUse) {
    throw new Error("Failed to parse project agent recommendations: missing whenToUse");
  }

  if (!systemPrompt) {
    throw new Error("Failed to parse project agent recommendations: missing systemPrompt");
  }

  return {
    whenToUse: whenToUse.slice(0, 280),
    systemPrompt
  };
}

function buildAnalysisUserPrompt(options: AnalyzeSessionForPromotionOptions): string {
  const sections = ["Analyze this Forge manager session for possible promotion into a specialized project agent."];

  if (options.sessionLabel) {
    sections.push(`Session label: ${options.sessionLabel}`);
  }
  if (options.displayName && options.displayName !== options.sessionLabel) {
    sections.push(`Display name: ${options.displayName}`);
  }
  if (options.sessionAgentId) {
    sections.push(`Session agent ID: ${options.sessionAgentId}`);
  }
  if (options.profileId) {
    sections.push(`Profile ID: ${options.profileId}`);
  }
  if (options.sessionCwd) {
    sections.push(`Working directory: ${options.sessionCwd}`);
  }

  const transcriptSummary = extractTranscriptSummary(options.conversationHistory);
  sections.push(
    "",
    "Transcript summary (most recent relevant transcript messages only):",
    transcriptSummary || "(No relevant transcript messages found.)",
    "",
    "Current base manager prompt (context for durable norms and conventions):",
    options.currentSystemPrompt.trim() || "(empty)",
    "",
    "Infer the session's durable specialization from this evidence and return the JSON object exactly as instructed."
  );

  return sections.join("\n");
}

function isTranscriptConversationMessage(entry: ConversationEntryEvent): entry is ConversationMessageEvent {
  return (
    entry.type === "conversation_message" &&
    (entry.source === "user_input" || entry.source === "speak_to_user" || entry.source === "project_agent_input")
  );
}

function formatTranscriptEntry(entry: ConversationMessageEvent): string {
  const normalizedText = entry.text.replace(/\r\n/g, "\n").trim();
  const label = getTranscriptLabel(entry);
  return `${label}: ${normalizedText}`;
}

function getTranscriptLabel(entry: ConversationMessageEvent): string {
  if (entry.source === "user_input") {
    return "User";
  }

  if (entry.source === "project_agent_input") {
    const fromDisplayName = entry.projectAgentContext?.fromDisplayName?.trim();
    return fromDisplayName ? `Project agent (${fromDisplayName})` : "Project agent";
  }

  return "Assistant";
}

function truncateTranscriptLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) {
    return line;
  }

  if (maxChars <= 1) {
    return line.slice(0, maxChars);
  }

  return `${line.slice(0, Math.max(0, maxChars - 1))}…`;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  for (const candidate of getJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function* getJsonCandidates(text: string): Iterable<string> {
  const trimmed = text.trim();
  if (trimmed) {
    yield trimmed;
  }

  const fencedMatches = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (candidate) {
      yield candidate;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1).trim();
    if (candidate) {
      yield candidate;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
