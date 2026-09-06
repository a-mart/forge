import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../../../types.js";
import { ACTOR, COMPACT_ARCHIVE_COUNT, PROFILE, SESSION, TIME } from "./ids.js";

export const DEFAULT_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.5",
  thinkingLevel: "medium",
} as const;

export interface SyntheticAgentSpec {
  agentId: string;
  managerId: string;
  role: "manager" | "worker";
  profileId: string;
  displayName: string;
  sessionLabel?: string;
  cwd: string;
  archivedAt?: string;
  sessionPurpose?: AgentDescriptor["sessionPurpose"];
  sessionSurface?: AgentDescriptor["sessionSurface"];
  collab?: AgentDescriptor["collab"];
}

export interface SyntheticProfileSpec {
  profileId: string;
  displayName: string;
  defaultSessionAgentId: string;
  profileType?: "user" | "system";
  archivedAt?: string;
}

export function compactProfileSpecs(): SyntheticProfileSpec[] {
  return [
    {
      profileId: PROFILE.alpha,
      displayName: "Alpha Retrieval Project",
      defaultSessionAgentId: SESSION.ranking,
    },
    {
      profileId: PROFILE.beta,
      displayName: "Beta Outside Project",
      defaultSessionAgentId: SESSION.outside,
    },
    {
      profileId: PROFILE.cortex,
      displayName: "Cortex",
      defaultSessionAgentId: SESSION.cortex,
      profileType: "system",
    },
  ];
}

export function compactAgentSpecs(archiveCount: number): SyntheticAgentSpec[] {
  const archives: SyntheticAgentSpec[] = Array.from({ length: archiveCount }, (_, index) => ({
    agentId: SESSION.archive(index),
    managerId: SESSION.archive(index),
    role: "manager",
    profileId: PROFILE.alpha,
    displayName: `Archive ${index}`,
    sessionLabel: `Archive Session ${index}`,
    cwd: `/tmp/hrr/archive-${index}`,
    archivedAt: TIME.archive,
  }));
  return [
    ...archives,
    spec(SESSION.ranking, "Ranking Session"),
    spec(SESSION.errors, "Exact Errors Session"),
    spec(SESSION.multipart, "Multipart Session"),
    spec(SESSION.longtext, "Long Text Session"),
    spec(SESSION.oversized, "Oversized Session"),
    spec(SESSION.incomplete, "Incomplete EOF Session"),
    spec(SESSION.windows, "Window Session"),
    spec(SESSION.paging, "Paging Session"),
    spec(SESSION.branch, "Branch Session"),
    spec(SESSION.echo, "History Echo Session"),
    spec(SESSION.reset, "Reset Session"),
    spec(SESSION.worker, "Worker Owner Session"),
    {
      agentId: ACTOR.worker,
      managerId: SESSION.worker,
      role: "worker",
      profileId: PROFILE.alpha,
      displayName: "Lathe Worker",
      cwd: "/tmp/hrr/worker",
    },
    spec(SESSION.recent, "Recent Tail Session"),
    {
      agentId: SESSION.outside,
      managerId: SESSION.outside,
      role: "manager",
      profileId: PROFILE.beta,
      displayName: "Outside Session",
      sessionLabel: "Outside Project Session",
      cwd: "/tmp/hrr/outside",
    },
    {
      agentId: SESSION.cortex,
      managerId: SESSION.cortex,
      role: "manager",
      profileId: PROFILE.cortex,
      displayName: "Cortex Review",
      cwd: "/tmp/hrr/cortex",
      sessionPurpose: "cortex_review",
    },
    {
      agentId: SESSION.collab,
      managerId: SESSION.collab,
      role: "manager",
      profileId: PROFILE.alpha,
      displayName: "Collab Session",
      cwd: "/tmp/hrr/collab",
      sessionSurface: "collab",
      collab: { workspaceId: "ws-hrr", channelId: "ch-hrr" },
    },
  ];
}

export function giantAgentSpecs(archiveCount: number): SyntheticAgentSpec[] {
  return [
    ...compactAgentSpecs(archiveCount),
    spec(SESSION.giant, "Giant Tail Session"),
  ];
}

export function scaleAgentSpecs(sourceCount: number): SyntheticAgentSpec[] {
  const compact = compactAgentSpecs(COMPACT_ARCHIVE_COUNT);
  const seen = new Set(compact.map((agent) => agent.agentId));
  const extras: SyntheticAgentSpec[] = [];
  let index = 0;
  while (compact.length + extras.length < Math.max(sourceCount, compact.length)) {
    const agentId = SESSION.scale(index);
    index += 1;
    if (seen.has(agentId)) {
      continue;
    }
    extras.push({
      agentId,
      managerId: agentId,
      role: "manager",
      profileId: PROFILE.alpha,
      displayName: `Scale Source ${index - 1}`,
      sessionLabel: `Scale Session ${index - 1}`,
      cwd: `/tmp/hrr/scale-${index - 1}`,
    });
    seen.add(agentId);
  }
  if (!seen.has(SESSION.giant)) {
    extras.push(spec(SESSION.giant, "Scale Giant Session"));
  }
  return [...compact, ...extras];
}

export function toProfiles(specs: readonly SyntheticProfileSpec[]): ManagerProfile[] {
  return specs.map((spec) => ({
    profileId: spec.profileId,
    displayName: spec.displayName,
    defaultSessionAgentId: spec.defaultSessionAgentId,
    defaultModel: { ...DEFAULT_MODEL },
    createdAt: TIME.archive,
    updatedAt: TIME.archive,
    profileType: spec.profileType,
    archivedAt: spec.archivedAt,
  }));
}

export function toDescriptors(specs: readonly SyntheticAgentSpec[]): AgentDescriptor[] {
  return specs.map((spec) => ({
    agentId: spec.agentId,
    managerId: spec.managerId,
    displayName: spec.displayName,
    sessionLabel: spec.sessionLabel ?? spec.displayName,
    role: spec.role,
    status: "idle",
    createdAt: TIME.archive,
    updatedAt: TIME.archive,
    cwd: spec.cwd,
    model: { ...DEFAULT_MODEL },
    sessionFile: "/ignored-synthetic.jsonl",
    profileId: spec.profileId,
    archivedAt: spec.archivedAt,
    sessionPurpose: spec.sessionPurpose,
    sessionSurface: spec.sessionSurface,
    collab: spec.collab,
  }));
}

export function createHost(
  dataDir: string,
  agents: AgentDescriptor[],
  profiles: ManagerProfile[],
  loadDatabaseModule: () => Promise<unknown>,
) {
  return {
    config: { paths: { dataDir } } as Pick<SwarmConfig, "paths">,
    getAgent: (agentId: string) => agents.find((agent) => agent.agentId === agentId),
    listAgents: () => agents,
    listProfiles: () => profiles,
    loadDatabaseModule,
  };
}

function spec(agentId: string, displayName: string): SyntheticAgentSpec {
  return {
    agentId,
    managerId: agentId,
    role: "manager",
    profileId: PROFILE.alpha,
    displayName,
    sessionLabel: displayName,
    cwd: `/tmp/hrr/${agentId}`,
  };
}
