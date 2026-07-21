export class RemoteUpdateAwarenessCoordinator {
  private readonly inFlight = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  private stopping = false;

  run<T>(monitorKey: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping) {
      return Promise.reject(new Error("Remote update awareness coordinator is stopping"));
    }

    const existing = this.inFlight.get(monitorKey);
    if (existing) {
      return existing.promise as Promise<T>;
    }

    const controller = new AbortController();
    const promise = operation(controller.signal).finally(() => {
      const current = this.inFlight.get(monitorKey);
      if (current?.promise === promise) {
        this.inFlight.delete(monitorKey);
      }
    });
    this.inFlight.set(monitorKey, { controller, promise });
    return promise;
  }

  cancel(monitorKey: string): void {
    this.inFlight.get(monitorKey)?.controller.abort();
  }

  get activeMonitorCount(): number {
    return this.inFlight.size;
  }

  async stop(): Promise<void> {
    if (this.stopping && this.inFlight.size === 0) {
      return;
    }
    this.stopping = true;
    const pending = [...this.inFlight.values()];
    for (const entry of pending) {
      entry.controller.abort();
    }
    await Promise.allSettled(pending.map((entry) => entry.promise));
  }
}
