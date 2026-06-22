export interface CompactionErrorClassification {
  code: string;
  status: number;
}

export function classifyCompactionErrorMessage(message: string): CompactionErrorClassification {
  const normalized = message.toLowerCase();

  if (normalized.includes("unknown target agent")) {
    return { code: "unknown_session", status: 404 };
  }

  if (normalized.includes("invalid") || normalized.includes("missing")) {
    return { code: "invalid_compaction_request", status: 400 };
  }

  if (normalized.includes("not running")) {
    return { code: "non_running_session", status: 409 };
  }

  if (normalized.includes("does not support") && normalized.includes("compaction")) {
    return { code: "compaction_unsupported", status: 409 };
  }

  if (
    normalized.includes("context recovery is already in progress") ||
    normalized.includes("already compacting") ||
    normalized.includes("already in progress")
  ) {
    return { code: "compaction_in_progress", status: 409 };
  }

  if (
    (normalized.includes("requires") && normalized.includes("to be idle")) ||
    normalized.includes("agent busy") ||
    normalized.includes("runtime busy")
  ) {
    return { code: "compaction_requires_idle", status: 409 };
  }

  if (normalized.includes("only supported") && normalized.includes("compaction")) {
    return { code: "compaction_unsupported", status: 409 };
  }

  return { code: "compaction_failed", status: 500 };
}
