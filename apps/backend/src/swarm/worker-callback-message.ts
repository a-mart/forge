const ACTIONABLE_STATUS_PATTERN = /^status:\s*(done|partial|blocked)\b/i;

export type WorkerCallbackIntent = "done" | "partial" | "blocked";

export const WORKER_CALLBACK_RUNTIME_PREFIX = "SYSTEM: [workerCallback]";

export function getActionableWorkerCallbackIntent(message: string): WorkerCallbackIntent | null {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const firstNonEmptyLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstNonEmptyLine) {
    return null;
  }

  const match = ACTIONABLE_STATUS_PATTERN.exec(firstNonEmptyLine);
  const status = match?.[1]?.toLowerCase();
  if (status === "done" || status === "partial" || status === "blocked") {
    return status;
  }

  return null;
}

export function isActionableWorkerCallbackMessage(message: string): boolean {
  return getActionableWorkerCallbackIntent(message) !== null;
}

export function formatActionableWorkerCallbackRuntimeMessage(options: {
  fromAgentId: string;
  message: string;
}): string {
  const intent = getActionableWorkerCallbackIntent(options.message);
  if (!intent) {
    return options.message;
  }

  const header = `${WORKER_CALLBACK_RUNTIME_PREFIX} ${JSON.stringify({
    fromAgentId: options.fromAgentId,
    intent,
  })}`;
  return `${header}\n${options.message.trim()}`;
}
