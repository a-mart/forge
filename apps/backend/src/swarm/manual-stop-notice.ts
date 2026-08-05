export const MANUAL_MANAGER_STOP_NOTICE = "Session stopped.";

export const MANUAL_MANAGER_STOP_INCOMPLETE_NOTICE =
  "Forge could not confirm this session stopped cleanly. Stop or start this session again to retry cleanup; new input remains blocked until cleanup succeeds.";

export function formatWorkerStopIncompleteNotice(workerIds: string[]): string {
  const label = workerIds.length === 1
    ? `worker \`${workerIds[0]}\``
    : `workers ${workerIds.map((workerId) => `\`${workerId}\``).join(", ")}`;
  return `Forge could not confirm ${label} stopped cleanly. Stop or start ${workerIds.length === 1 ? "this worker" : "these workers"} again to retry cleanup; new input remains blocked until cleanup succeeds.`;
}
