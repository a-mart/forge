import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { getSessionMemoryPath, getSessionMetaPath, getSessionsDir } from "./data-paths.js";
import { getProjectAgentPublicName, listProjectAgents } from "./project-agents.js";
import type { AgentDescriptor } from "./types.js";

export interface AgentCreatorContextSources {
  existingAgents: AgentCreatorExistingAgentEntry[];
  sessionMemories: AgentCreatorSessionMemoryEntry[];
}

export interface AgentCreatorExistingAgentEntry {
  handle: string;
  displayName: string;
  whenToUse: string;
  systemPromptExcerpt: string;
}

export interface AgentCreatorSessionMemoryEntry {
  sessionId: string;
  label: string;
  excerpt: string;
}

interface SessionMemoryCandidate {
  sessionId: string;
  label: string;
  mtime: number;
  memoryPath: string;
  size: number;
}

export const MAX_SESSION_SCAN_COUNT = 20;
export const PER_SESSION_CHAR_BUDGET = 800;
export const GLOBAL_SESSION_MEMORIES_BUDGET = 10_000;
export const EXISTING_AGENTS_SECTION_CHAR_BUDGET = 3_000;
export const MAX_AGENT_CREATOR_CONTEXT_MESSAGE_CHARS = 16_000;
export const SYSTEM_PROMPT_EXCERPT_LENGTH = 200;

const SESSION_SCAN_BATCH_SIZE = 8;
const PRIORITY_SECTION_HEADERS = [
  "## Project Facts",
  "## Decisions",
  "## Open Follow-ups",
  "## Learnings",
  "## User Preferences"
] as const;
const PLACEHOLDER_LINE_RE = /^-\s*\(none yet\)\s*$/;

export async function gatherAgentCreatorContext(
  dataDir: string,
  profileId: string,
  descriptors: Iterable<AgentDescriptor>,
  creatorAgentId: string
): Promise<AgentCreatorContextSources> {
  const [existingAgentsResult, sessionMemoriesResult] = await Promise.allSettled([
    getExistingProjectAgentsSummary(descriptors, profileId, creatorAgentId),
    scanRecentSessionMemories(dataDir, profileId, creatorAgentId)
  ]);

  return {
    existingAgents: existingAgentsResult.status === "fulfilled" ? existingAgentsResult.value : [],
    sessionMemories: sessionMemoriesResult.status === "fulfilled" ? sessionMemoriesResult.value : []
  };
}

export function formatAgentCreatorContextMessage(sources: AgentCreatorContextSources): string {
  const message = [
    formatExistingProjectAgentsSection(sources.existingAgents),
    "",
    formatRecentSessionContextSection(sources.sessionMemories)
  ].join("\n");

  return truncateToBudget(message, MAX_AGENT_CREATOR_CONTEXT_MESSAGE_CHARS);
}

async function getExistingProjectAgentsSummary(
  descriptors: Iterable<AgentDescriptor>,
  profileId: string,
  excludeAgentId: string
): Promise<AgentCreatorExistingAgentEntry[]> {
  return listProjectAgents(descriptors, profileId, { excludeAgentId }).map((agent) => ({
    handle: agent.projectAgent.handle,
    displayName: getProjectAgentPublicName(agent),
    whenToUse: agent.projectAgent.whenToUse,
    systemPromptExcerpt: agent.projectAgent.systemPrompt
      ? extractFirstUsefulParagraph(agent.projectAgent.systemPrompt, SYSTEM_PROMPT_EXCERPT_LENGTH)
      : ""
  }));
}

export async function scanRecentSessionMemories(
  dataDir: string,
  profileId: string,
  excludeAgentId: string
): Promise<AgentCreatorSessionMemoryEntry[]> {
  const sessionsDir = getSessionsDir(dataDir, profileId);

  let entries: Dirent[];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessionDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name !== excludeAgentId)
    .sort((left, right) => right.name.localeCompare(left.name));
  const candidates: SessionMemoryCandidate[] = [];

  for (let index = 0; index < sessionDirs.length; index += SESSION_SCAN_BATCH_SIZE) {
    const batch = sessionDirs.slice(index, index + SESSION_SCAN_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((entry) => readSessionMemoryCandidate(dataDir, profileId, entry))
    );

    for (const candidate of batchResults) {
      if (!candidate || candidate.size <= 0) {
        continue;
      }

      candidates.push(candidate);
      candidates.sort((left, right) => right.mtime - left.mtime);
      if (candidates.length > MAX_SESSION_SCAN_COUNT) {
        candidates.length = MAX_SESSION_SCAN_COUNT;
      }
    }
  }

  const results: AgentCreatorSessionMemoryEntry[] = [];
  let totalChars = 0;

  for (const candidate of candidates) {
    if (totalChars >= GLOBAL_SESSION_MEMORIES_BUDGET) {
      break;
    }

    try {
      const raw = await readFile(candidate.memoryPath, "utf8");
      const excerpt = extractStructuredMemoryContent(raw, PER_SESSION_CHAR_BUDGET);
      if (!excerpt) {
        continue;
      }

      const remainingBudget = GLOBAL_SESSION_MEMORIES_BUDGET - totalChars;
      const trimmedExcerpt = excerpt.slice(0, Math.min(excerpt.length, remainingBudget)).trim();
      if (trimmedExcerpt.length < 20) {
        continue;
      }

      results.push({
        sessionId: candidate.sessionId,
        label: candidate.label,
        excerpt: trimmedExcerpt
      });
      totalChars += trimmedExcerpt.length;
    } catch {
      // Ignore unreadable memory files so one bad session does not block the rest.
    }
  }

  return results;
}

export function extractStructuredMemoryContent(raw: string, maxChars: number): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const nonPlaceholderLines = trimmed.split(/\r?\n/).filter((line) => {
    const normalized = line.trim();
    if (!normalized) {
      return false;
    }
    if (normalized.startsWith("#")) {
      return false;
    }
    if (normalized.startsWith("<!--") || normalized.endsWith("-->")) {
      return false;
    }
    if (PLACEHOLDER_LINE_RE.test(normalized)) {
      return false;
    }
    return true;
  });

  if (nonPlaceholderLines.length === 0) {
    return null;
  }

  const extracted: string[] = [];
  let charCount = 0;

  for (const sectionHeader of PRIORITY_SECTION_HEADERS) {
    const sectionContent = extractSection(trimmed, sectionHeader);
    if (!sectionContent) {
      continue;
    }

    const usefulLines = sectionContent
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => {
        const normalized = line.trim();
        return normalized.length > 0 && !PLACEHOLDER_LINE_RE.test(normalized);
      });

    if (usefulLines.length === 0) {
      continue;
    }

    const sectionText = usefulLines.join("\n");
    const separatorLength = extracted.length > 0 ? 1 : 0;
    const remaining = maxChars - charCount - separatorLength;
    if (remaining <= 0) {
      break;
    }

    const capped = sectionText.slice(0, remaining).trimEnd();
    if (!capped) {
      continue;
    }

    extracted.push(capped);
    charCount += capped.length + separatorLength;
  }

  if (extracted.length === 0) {
    return null;
  }

  return extracted.join("\n");
}

function extractSection(text: string, header: string): string | null {
  const headerIndex = text.indexOf(header);
  if (headerIndex === -1) {
    return null;
  }

  const contentStart = text.indexOf("\n", headerIndex);
  if (contentStart === -1) {
    return null;
  }

  const nextHeaderIndex = text.indexOf("\n## ", contentStart + 1);
  const sectionEnd = nextHeaderIndex === -1 ? text.length : nextHeaderIndex;
  return text.slice(contentStart + 1, sectionEnd).trim();
}

function extractFirstUsefulParagraph(text: string, maxChars: number): string {
  const usefulLines: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (usefulLines.length > 0) {
        break;
      }
      continue;
    }

    usefulLines.push(trimmed);
  }

  const paragraph = usefulLines.join(" ");
  if (paragraph.length <= maxChars) {
    return paragraph;
  }

  return `${paragraph.slice(0, maxChars - 1)}…`;
}

function formatExistingProjectAgentsSection(existingAgents: AgentCreatorExistingAgentEntry[]): string {
  const lines = ["<existing_project_agents>"];

  if (existingAgents.length === 0) {
    lines.push("No project agents configured in this profile yet.");
    lines.push("</existing_project_agents>");
    return lines.join("\n");
  }

  let sectionChars = 0;
  let includedCount = 0;

  for (const agent of existingAgents) {
    const block = formatExistingProjectAgentBlock(agent);
    const separatorLength = lines.length > 1 ? 1 : 0;
    if (sectionChars + separatorLength + block.length > EXISTING_AGENTS_SECTION_CHAR_BUDGET) {
      break;
    }

    lines.push(block);
    sectionChars += separatorLength + block.length;
    includedCount += 1;
  }

  if (includedCount === 0) {
    lines.push("Project agents exist, but their summaries exceeded the context budget.");
  } else if (includedCount < existingAgents.length) {
    lines.push(
      `- (${existingAgents.length - includedCount} additional project agents omitted to stay within context budget)`
    );
  }

  lines.push("</existing_project_agents>");
  return lines.join("\n");
}

function formatExistingProjectAgentBlock(agent: AgentCreatorExistingAgentEntry): string {
  const lines = [`- ${agent.displayName} (@${agent.handle})`];
  lines.push(`  whenToUse: ${agent.whenToUse}`);
  if (agent.systemPromptExcerpt) {
    lines.push(`  systemPromptFocus: ${agent.systemPromptExcerpt}`);
  }
  return lines.join("\n");
}

function formatRecentSessionContextSection(sessionMemories: AgentCreatorSessionMemoryEntry[]): string {
  const lines = ["<recent_session_context>"];

  if (sessionMemories.length === 0) {
    lines.push("No recent session memories with usable content found.");
  } else {
    for (const memory of sessionMemories) {
      lines.push(`Session \"${memory.label}\":\n${memory.excerpt}`);
    }
  }

  lines.push("</recent_session_context>");
  return lines.join("\n");
}

async function readSessionMemoryCandidate(
  dataDir: string,
  profileId: string,
  entry: Dirent
): Promise<SessionMemoryCandidate | null> {
  const memoryPath = getSessionMemoryPath(dataDir, profileId, entry.name);
  const metaPath = getSessionMetaPath(dataDir, profileId, entry.name);
  const [memoryStatResult, metaResult] = await Promise.allSettled([
    stat(memoryPath),
    readFile(metaPath, "utf8")
  ]);

  if (memoryStatResult.status !== "fulfilled") {
    return null;
  }

  let label = entry.name;
  if (metaResult.status === "fulfilled") {
    try {
      const parsed = JSON.parse(metaResult.value) as { label?: unknown };
      if (typeof parsed.label === "string" && parsed.label.trim().length > 0) {
        label = parsed.label.trim();
      }
    } catch {
      // Ignore malformed meta files and fall back to the session id.
    }
  }

  return {
    sessionId: entry.name,
    label,
    mtime: memoryStatResult.value.mtimeMs,
    memoryPath,
    size: memoryStatResult.value.size
  };
}

function truncateToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
