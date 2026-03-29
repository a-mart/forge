export type VersioningMutationSource =
  | "profile-memory-merge"
  | "prompt-save"
  | "prompt-delete"
  | "reference-doc"
  | "reference-index"
  | "legacy-knowledge-migration"
  | "api-write-file"
  | "api-write-file-restore"
  | "agent-write-tool"
  | "agent-edit-tool"
  | "bootstrap"
  | "reconcile";

export interface VersioningMutation {
  path: string;
  action: "write" | "delete";
  source: VersioningMutationSource;
  profileId?: string;
  sessionId?: string;
  promptCategory?: "archetype" | "operational";
  promptId?: string;
  agentId?: string;
  reviewRunId?: string;
}

export interface VersioningMutationSink {
  isTrackedPath(path: string): boolean;
  recordMutation(mutation: VersioningMutation): Promise<boolean>;
  flushPending(reason: string): Promise<void>;
  reconcileNow(reason: string): Promise<void>;
}
