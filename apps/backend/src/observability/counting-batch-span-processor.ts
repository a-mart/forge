import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";

const EXPORT_SUCCESS_CODE = 0;

export interface CountingBatchSpanProcessorOptions {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMs: number;
  exportTimeoutMs: number;
}

export interface CountingBatchSpanProcessorCounters {
  accepted: number;
  droppedQueueFull: number;
  exportSucceeded: number;
  exportFailed: number;
  lastSuccessfulExportAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

export class CountingBatchSpanProcessor implements SpanProcessor {
  private readonly queue: ReadableSpan[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private shutdownStarted = false;
  private readonly counters: CountingBatchSpanProcessorCounters = {
    accepted: 0,
    droppedQueueFull: 0,
    exportSucceeded: 0,
    exportFailed: 0,
    lastSuccessfulExportAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
  };

  constructor(
    private readonly exporter: SpanExporter,
    private readonly options: CountingBatchSpanProcessorOptions,
  ) {}

  onStart(_span: Span, _parentContext: Context): void {
    // No-op. The processor only queues ended spans.
  }

  onEnd(span: ReadableSpan): void {
    if (this.shutdownStarted) {
      this.counters.droppedQueueFull += 1;
      return;
    }

    if (this.queue.length >= this.options.maxQueueSize) {
      this.counters.droppedQueueFull += 1;
      return;
    }

    this.queue.push(span);
    this.counters.accepted += 1;
    this.scheduleFlush();
  }

  async forceFlush(): Promise<void> {
    await this.flushQueue();
    if (this.exporter.forceFlush) {
      try {
        await this.exporter.forceFlush();
      } catch (error) {
        this.recordExportFailure(error);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) {
      return;
    }

    this.shutdownStarted = true;
    this.clearTimer();
    await this.forceFlush();
    try {
      await this.exporter.shutdown();
    } catch (error) {
      this.recordExportFailure(error);
    }
  }

  getCounters(): CountingBatchSpanProcessorCounters {
    return { ...this.counters };
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.shutdownStarted) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushQueue();
    }, this.options.scheduledDelayMs);
    this.flushTimer.unref?.();
  }

  private clearTimer(): void {
    if (!this.flushTimer) {
      return;
    }

    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async flushQueue(): Promise<void> {
    this.clearTimer();
    if (this.flushPromise) {
      await this.flushPromise;
      if (this.queue.length === 0) {
        return;
      }
    }

    this.flushPromise = this.drainQueue().finally(() => {
      this.flushPromise = null;
      if (!this.shutdownStarted && this.queue.length > 0) {
        this.scheduleFlush();
      }
    });

    await this.flushPromise;
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.options.maxExportBatchSize);
      await this.exportBatch(batch);
    }
  }

  private async exportBatch(batch: ReadableSpan[]): Promise<void> {
    try {
      const result = await this.exportWithTimeout(batch);
      if (result.ok) {
        this.counters.exportSucceeded += 1;
        this.counters.lastSuccessfulExportAt = new Date().toISOString();
      } else {
        this.recordExportFailure(result.error);
      }
    } catch (error) {
      this.recordExportFailure(error);
    }
  }

  private exportWithTimeout(batch: ReadableSpan[]): Promise<{ ok: boolean; error?: unknown }> {
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        resolve({ ok: false, error: new Error(`Phoenix export timed out after ${this.options.exportTimeoutMs}ms`) });
      }, this.options.exportTimeoutMs);
      timeout.unref?.();

      try {
        this.exporter.export(batch, (result) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timeout);
          resolve({ ok: result.code === EXPORT_SUCCESS_CODE, error: result.error });
        });
      } catch (error) {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        resolve({ ok: false, error });
      }
    });
  }

  private recordExportFailure(error: unknown): void {
    this.counters.exportFailed += 1;
    this.counters.lastErrorAt = new Date().toISOString();
    this.counters.lastErrorMessage = error instanceof Error ? error.message : String(error);
  }
}
