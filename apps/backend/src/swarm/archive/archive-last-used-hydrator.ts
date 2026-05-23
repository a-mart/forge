import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";
import { CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";

export interface ArchiveLastUsedHydratorDeps {
  getAgent(agentId: string): AgentDescriptor | undefined;
  listSessions(): AgentDescriptor[];
  listProfiles(): ManagerProfile[];
  patchDescriptor(agentId: string, patch: Partial<AgentDescriptor>): Promise<AgentDescriptor>;
  warn?: (message: string, details?: unknown) => void;
}

export interface ArchiveLastUsedHydrationResult {
  scannedSessionCount: number;
  hydratedSessionCount: number;
}

export class ArchiveLastUsedHydrator {
  constructor(private readonly deps: ArchiveLastUsedHydratorDeps) {}

  async hydrateSessionIfMissing(agentId: string): Promise<ArchiveLastUsedHydrationResult> {
    const session = this.deps.getAgent(agentId);
    if (!isHydratableSession(session)) {
      return emptyResult();
    }

    return this.hydrateSessionsIfMissing([session]);
  }

  async hydrateProfileSessionsIfMissing(profileId: string): Promise<ArchiveLastUsedHydrationResult> {
    const sessions = this.deps.listSessions().filter(
      (session) => session.role === "manager" && session.profileId === profileId && !session.lastUserMessageAt,
    );

    return this.hydrateSessionsIfMissing(sessions);
  }

  async hydrateArchivedRowsIfMissing(): Promise<ArchiveLastUsedHydrationResult> {
    const archivedProfileIds = new Set(
      this.deps.listProfiles()
        .filter((profile) => Boolean(profile.archivedAt))
        .map((profile) => profile.profileId),
    );

    const sessions = this.deps.listSessions().filter((session) => {
      if (session.role !== "manager" || session.lastUserMessageAt) return false;
      if (session.archivedAt) return true;
      return Boolean(session.profileId && archivedProfileIds.has(session.profileId));
    });

    return this.hydrateSessionsIfMissing(sessions);
  }

  private async hydrateSessionsIfMissing(sessions: AgentDescriptor[]): Promise<ArchiveLastUsedHydrationResult> {
    let scannedSessionCount = 0;
    let hydratedSessionCount = 0;

    for (const session of sessions) {
      if (!isHydratableSession(session)) continue;
      scannedSessionCount += 1;
      const lastUserMessageAt = await this.findLastUserMessageAt(session);
      if (!lastUserMessageAt) continue;

      const current = this.deps.getAgent(session.agentId);
      if (!isHydratableSession(current)) continue;
      if (current.lastUserMessageAt && current.lastUserMessageAt.localeCompare(lastUserMessageAt) >= 0) continue;

      await this.deps.patchDescriptor(session.agentId, { lastUserMessageAt });
      hydratedSessionCount += 1;
    }

    return { scannedSessionCount, hydratedSessionCount };
  }

  private async findLastUserMessageAt(session: AgentDescriptor): Promise<string | undefined> {
    try {
      await access(session.sessionFile);
    } catch {
      return undefined;
    }

    let lastUserMessageAt: string | undefined;
    const reader = createInterface({
      input: createReadStream(session.sessionFile, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    try {
      for await (const line of reader) {
        const timestamp = extractUserInputTimestamp(line);
        if (timestamp && (!lastUserMessageAt || timestamp.localeCompare(lastUserMessageAt) > 0)) {
          lastUserMessageAt = timestamp;
        }
      }
    } catch (error) {
      this.deps.warn?.("archive_last_used:scan_failed", {
        agentId: session.agentId,
        sessionFile: session.sessionFile,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    return lastUserMessageAt;
  }
}

function emptyResult(): ArchiveLastUsedHydrationResult {
  return { scannedSessionCount: 0, hydratedSessionCount: 0 };
}

function isHydratableSession(session: AgentDescriptor | undefined): session is AgentDescriptor {
  return Boolean(session && session.role === "manager" && !session.lastUserMessageAt && session.sessionFile);
}

function extractUserInputTimestamp(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  if (parsed.type !== "custom" || parsed.customType !== CONVERSATION_ENTRY_TYPE) return undefined;
  const data = parsed.data;
  if (!isRecord(data)) return undefined;
  if (data.type !== "conversation_message") return undefined;
  if (data.role !== "user" || data.source !== "user_input") return undefined;
  return typeof data.timestamp === "string" && data.timestamp.trim().length > 0 ? data.timestamp : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
