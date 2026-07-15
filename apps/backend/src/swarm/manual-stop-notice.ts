export const MANUAL_MANAGER_STOP_NOTICE = "Session stopped.";

export const MANUAL_MANAGER_STOP_TIMEOUT_NOTICE =
  "Forge could not confirm this session stopped cleanly. Restart Forge before sending another message to this session; new input is blocked to protect its history.";

export function formatWorkerStopTimeoutNotice(workerIds: string[]): string {
  const label = workerIds.length === 1
    ? `worker \`${workerIds[0]}\``
    : `workers ${workerIds.map((workerId) => `\`${workerId}\``).join(", ")}`;
  return `Forge could not confirm ${label} stopped cleanly. Restart Forge before sending another message to ${workerIds.length === 1 ? "this worker" : "these workers"}; new input is blocked to protect session history.`;
}
