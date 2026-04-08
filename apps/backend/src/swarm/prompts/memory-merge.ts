import { complete, type Api, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import type { PromptRegistry } from "./prompt-registry.js";

export const MEMORY_MERGE_SYSTEM_PROMPT = [
  "You are a memory file editor. You receive two memory files and must produce one consolidated memory file.",
  "",
  "Rules:",
  "- Preserve the existing markdown structure and section headers from the base profile memory.",
  "- Integrate new facts, decisions, preferences, and follow-ups from the session memory.",
  "- Deduplicate repeated information.",
  "- If session memory contradicts base memory, prefer session memory because it is newer.",
  "- Remove stale or completed follow-ups that session memory explicitly marks as completed.",
  "- Output ONLY the final merged markdown content.",
  "- Do not include explanations.",
  "- Do not include code fences."
].join("\n");

export interface ExecuteLLMMergeOptions {
  systemPrompt?: string;
  promptRegistry?: Pick<PromptRegistry, "resolve">;
  profileId?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  now?: () => number;
  completeFn?: typeof complete;
}

export function buildMemoryMergeUserPrompt(profileContent: string, sessionContent: string): string {
  const normalizedProfile = profileContent.trimEnd();
  const normalizedSession = sessionContent.trimEnd();

  return [
    "Profile memory (base):",
    "----- BEGIN PROFILE MEMORY -----",
    normalizedProfile,
    "----- END PROFILE MEMORY -----",
    "",
    "Session memory (new updates):",
    "----- BEGIN SESSION MEMORY -----",
    normalizedSession,
    "----- END SESSION MEMORY -----"
  ].join("\n");
}

export function extractMergedMemoryText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function stripWrappingCodeFence(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n?```$/);

  if (!fencedMatch) {
    return trimmed;
  }

  return fencedMatch[1].trim();
}

export async function executeLLMMerge(
  model: Model<Api>,
  profileContent: string,
  sessionContent: string,
  options?: ExecuteLLMMergeOptions
): Promise<string> {
  const mergePrompt = buildMemoryMergeUserPrompt(profileContent, sessionContent);
  const invokeComplete = options?.completeFn ?? complete;
  const resolvedPromptFromRegistry = options?.promptRegistry
    ? await options.promptRegistry.resolve("operational", "memory-merge", options.profileId)
    : undefined;
  const systemPrompt = options?.systemPrompt ?? resolvedPromptFromRegistry ?? MEMORY_MERGE_SYSTEM_PROMPT;

  const response = await invokeComplete(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          timestamp: options?.now?.() ?? Date.now(),
          content: [{ type: "text", text: mergePrompt }]
        }
      ]
    },
    options?.apiKey || options?.headers
      ? {
          ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
          ...(options?.headers ? { headers: options.headers } : {})
        }
      : undefined
  );

  const mergedContent = stripWrappingCodeFence(extractMergedMemoryText(response));
  if (mergedContent.trim().length === 0) {
    throw new Error("LLM merge returned empty content");
  }

  return mergedContent;
}

export async function executeLLMMergeWithFallback(
  model: Model<Api>,
  profileContent: string,
  sessionContent: string,
  options: ExecuteLLMMergeOptions & { fallback: () => string }
): Promise<{ mergedContent: string; usedFallback: boolean; errorMessage?: string }> {
  try {
    const mergedContent = await executeLLMMerge(model, profileContent, sessionContent, options);
    return {
      mergedContent,
      usedFallback: false
    };
  } catch (error) {
    return {
      mergedContent: options.fallback(),
      usedFallback: true,
      errorMessage: toErrorMessage(error)
    };
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
