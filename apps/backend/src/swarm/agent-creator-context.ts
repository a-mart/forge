import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getSessionMetaPath, getSessionsDir } from "./data-paths.js";
import { listProjectAgents } from "./project-agents.js";
import type { AgentDescriptor } from "./types.js";

export interface AgentCreatorContextSources {
  projectCwd: string | null;
  existingAgents: AgentCreatorExistingAgentEntry[];
  recentSessions: AgentCreatorRecentSessionEntry[];
}

export interface AgentCreatorExistingAgentEntry {
  handle: string;
  whenToUse: string;
}

export interface AgentCreatorRecentSessionEntry {
  sessionId: string;
  label: string;
}

interface RecentSessionCandidate {
  sessionId: string;
  label: string;
  mtime: number;
}

export const MAX_RECENT_SESSION_COUNT = 20;
export const EXISTING_AGENTS_SECTION_CHAR_BUDGET = 1_400;
export const RECENT_SESSIONS_SECTION_CHAR_BUDGET = 1_000;
export const MAX_AGENT_CREATOR_CONTEXT_MESSAGE_CHARS = 3_200;

const SESSION_SCAN_BATCH_SIZE = 8;
const SEED_CONTEXT_CLOSING_TAG = "</agent_creator_seed_context>";

export async function gatherAgentCreatorContext(
  dataDir: string,
  profileId: string,
  descriptors: Iterable<AgentDescriptor>,
  creatorAgentId: string
): Promise<AgentCreatorContextSources> {
  const descriptorList = Array.from(descriptors);
  const creatorDescriptor = descriptorList.find((descriptor) => descriptor.agentId === creatorAgentId);
  const [existingAgentsResult, recentSessionsResult] = await Promise.allSettled([
    getExistingProjectAgentsSummary(descriptorList, profileId, creatorAgentId),
    scanRecentSessions(dataDir, profileId, creatorAgentId)
  ]);

  return {
    projectCwd: creatorDescriptor?.cwd ?? null,
    existingAgents: existingAgentsResult.status === "fulfilled" ? existingAgentsResult.value : [],
    recentSessions: recentSessionsResult.status === "fulfilled" ? recentSessionsResult.value : []
  };
}

export function formatAgentCreatorContextMessage(sources: AgentCreatorContextSources): string {
  const message = [
    "<agent_creator_seed_context>",
    `projectCwd: ${sources.projectCwd ?? "(unknown)"}`,
    "This is lightweight seed context only. Explore the project directly before interviewing the user.",
    "",
    formatExistingProjectAgentsSection(sources.existingAgents),
    "",
    formatRecentSessionsSection(sources.recentSessions),
    SEED_CONTEXT_CLOSING_TAG
  ].join("\n");

  return truncateSeedContextToBudget(message, MAX_AGENT_CREATOR_CONTEXT_MESSAGE_CHARS);
}

async function getExistingProjectAgentsSummary(
  descriptors: Iterable<AgentDescriptor>,
  profileId: string,
  excludeAgentId: string
): Promise<AgentCreatorExistingAgentEntry[]> {
  return listProjectAgents(descriptors, profileId, { excludeAgentId }).map((agent) => ({
    handle: agent.projectAgent.handle,
    whenToUse: agent.projectAgent.whenToUse
  }));
}

export async function scanRecentSessions(
  dataDir: string,
  profileId: string,
  excludeAgentId: string
): Promise<AgentCreatorRecentSessionEntry[]> {
  const sessionsDir = getSessionsDir(dataDir, profileId);

  let entries: Dirent[];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessionDirs = entries.filter((entry) => entry.isDirectory() && entry.name !== excludeAgentId);
  const candidates: RecentSessionCandidate[] = [];

  for (let index = 0; index < sessionDirs.length; index += SESSION_SCAN_BATCH_SIZE) {
    const batch = sessionDirs.slice(index, index + SESSION_SCAN_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((entry) => readRecentSessionCandidate(dataDir, profileId, sessionsDir, entry))
    );

    for (const candidate of batchResults) {
      if (!candidate) {
        continue;
      }

      candidates.push(candidate);
      candidates.sort((left, right) => right.mtime - left.mtime);
      if (candidates.length > MAX_RECENT_SESSION_COUNT) {
        candidates.length = MAX_RECENT_SESSION_COUNT;
      }
    }
  }

  return candidates.map((candidate) => ({
    sessionId: candidate.sessionId,
    label: candidate.label
  }));
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
    const block = `- @${agent.handle}: ${agent.whenToUse}`;
    const separatorLength = lines.length > 1 ? 1 : 0;
    if (sectionChars + separatorLength + block.length > EXISTING_AGENTS_SECTION_CHAR_BUDGET) {
      break;
    }

    lines.push(block);
    sectionChars += separatorLength + block.length;
    includedCount += 1;
  }

  if (includedCount === 0) {
    lines.push("Project agents exist, but their routing summaries exceeded the context budget.");
  } else if (includedCount < existingAgents.length) {
    lines.push(
      `- (${existingAgents.length - includedCount} additional project agents omitted to stay within context budget)`
    );
  }

  lines.push("</existing_project_agents>");
  return lines.join("\n");
}

function formatRecentSessionsSection(recentSessions: AgentCreatorRecentSessionEntry[]): string {
  const lines = ["<recent_sessions>"];

  if (recentSessions.length === 0) {
    lines.push("No recent sessions found.");
    lines.push("</recent_sessions>");
    return lines.join("\n");
  }

  let sectionChars = 0;
  let includedCount = 0;

  for (const session of recentSessions) {
    const block = `- ${session.label} (sessionId: ${session.sessionId})`;
    const separatorLength = lines.length > 1 ? 1 : 0;
    if (sectionChars + separatorLength + block.length > RECENT_SESSIONS_SECTION_CHAR_BUDGET) {
      break;
    }

    lines.push(block);
    sectionChars += separatorLength + block.length;
    includedCount += 1;
  }

  if (includedCount === 0) {
    lines.push("Recent sessions exist, but their labels exceeded the context budget.");
  } else if (includedCount < recentSessions.length) {
    lines.push(
      `- (${recentSessions.length - includedCount} additional recent sessions omitted to stay within context budget)`
    );
  }

  lines.push("</recent_sessions>");
  return lines.join("\n");
}

async function readRecentSessionCandidate(
  dataDir: string,
  profileId: string,
  sessionsDir: string,
  entry: Dirent
): Promise<RecentSessionCandidate | null> {
  const metaPath = getSessionMetaPath(dataDir, profileId, entry.name);
  const sessionDirPath = join(sessionsDir, entry.name);
  const [metaStatResult, dirStatResult, metaResult] = await Promise.allSettled([
    stat(metaPath),
    stat(sessionDirPath),
    readFile(metaPath, "utf8")
  ]);

  if (metaStatResult.status !== "fulfilled" && dirStatResult.status !== "fulfilled") {
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

  const mtime =
    metaStatResult.status === "fulfilled"
      ? metaStatResult.value.mtimeMs
      : dirStatResult.status === "fulfilled"
        ? dirStatResult.value.mtimeMs
        : 0;

  return {
    sessionId: entry.name,
    label,
    mtime
  };
}

function truncateSeedContextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const suffix = `…\n${SEED_CONTEXT_CLOSING_TAG}`;
  const available = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, available).trimEnd()}${suffix}`;
}
