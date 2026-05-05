import type { AgentDescriptor, AgentsStoreFile, ManagerProfile } from "../../types.js";
import {
  extractDescriptorAgentId,
  isRecord,
  validateAgentDescriptor
} from "../../swarm-manager-utils.js";
import { cloneDescriptorForPersistence, cloneProfile } from "./descriptor-clone.js";
import { normalizeDescriptorPaths } from "./descriptor-path-resolver.js";

interface DecodeStoreOptions {
  dataDir: string;
  storeFilePath: string;
  logDebug?: (message: string, details?: unknown) => void;
  warn?: (message: string) => void;
}

export interface DecodeStoreResult {
  store: AgentsStoreFile;
  normalizedPathCount: number;
  skippedDescriptorCount: number;
}

export function decodeAgentsStoreFile(raw: string, options: DecodeStoreOptions): DecodeStoreResult {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.agents)) {
    return {
      store: { agents: [], profiles: [] },
      normalizedPathCount: 0,
      skippedDescriptorCount: 0
    };
  }

  const validAgents: AgentDescriptor[] = [];
  let normalizedPathCount = 0;
  let skippedDescriptorCount = 0;
  const warn = options.warn ?? console.warn;

  for (const [index, candidate] of parsed.agents.entries()) {
    const validated = validateAgentDescriptor(candidate);
    if (typeof validated === "string") {
      skippedDescriptorCount += 1;
      const maybeAgentId = extractDescriptorAgentId(candidate);
      const descriptorHint = maybeAgentId ? `agentId=${maybeAgentId}` : `index=${index}`;
      warn(`[swarm] Skipping invalid descriptor (${descriptorHint}) in ${options.storeFilePath}: ${validated}`);
      continue;
    }

    const normalizedDescriptor = normalizeDescriptorPaths(validated, options.dataDir);
    if (normalizedDescriptor !== validated) {
      normalizedPathCount += 1;
    }

    validAgents.push(normalizedDescriptor);
  }

  if (normalizedPathCount > 0) {
    options.logDebug?.("Normalized legacy descriptor sessionFile paths during store load", {
      normalizedPathCount,
      dataDir: options.dataDir
    });
  }

  return {
    store: {
      agents: validAgents,
      profiles: Array.isArray(parsed.profiles) ? (parsed.profiles as ManagerProfile[]).map(cloneProfile) : []
    },
    normalizedPathCount,
    skippedDescriptorCount
  };
}

export function encodeAgentsStoreFile(store: AgentsStoreFile): string {
  return `${JSON.stringify({
    agents: store.agents.map(cloneDescriptorForPersistence),
    profiles: (store.profiles ?? []).map(cloneProfile)
  }, null, 2)}\n`;
}
