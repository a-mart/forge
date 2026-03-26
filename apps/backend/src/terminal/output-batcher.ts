export interface OutputBatcherOptions {
  intervalMs: number;
  onFlush: (chunk: Buffer) => void | Promise<void>;
}

export class OutputBatcher {
  private readonly intervalMs: number;
  private readonly onFlush: (chunk: Buffer) => void | Promise<void>;
  private readonly chunks: Buffer[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private flushChain: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | null = null;

  constructor(options: OutputBatcherOptions) {
    this.intervalMs = options.intervalMs;
    this.onFlush = options.onFlush;
  }

  push(chunk: Buffer | string): void {
    if (this.stopped) {
      return;
    }

    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    if (this.timer) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => {
        console.warn(
          `[output-batcher] Flush error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    const nextFlush = this.flushChain.then(async () => {
      if (this.chunks.length === 0) {
        return;
      }

      const payload = Buffer.concat(this.chunks.splice(0, this.chunks.length));
      await this.onFlush(payload);
    });

    this.flushChain = nextFlush.catch(() => undefined);
    return nextFlush;
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.stopPromise = this.flush();
    return this.stopPromise;
  }
}
