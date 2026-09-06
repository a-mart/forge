import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { stat } from "node:fs/promises";

export interface ResourceSample {
  atMs: number;
  rssBytes: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  eventLoopP99Ns?: number;
  eventLoopMaxNs?: number;
}

export interface DiskUsage {
  indexBytes: number;
  walBytes: number;
  shmBytes: number;
  corpusBytes: number;
}

export class ResourceMonitor {
  private readonly histogram = monitorEventLoopDelay({ resolution: 10 });
  private readonly startedAt = performance.now();
  private readonly cpuStarted = process.cpuUsage();
  private samples: ResourceSample[] = [];
  private enabled = false;

  start(): void {
    this.histogram.enable();
    this.histogram.reset();
    this.enabled = true;
    this.samples = [this.capture()];
  }

  sample(): ResourceSample {
    const sample = this.capture();
    this.samples.push(sample);
    return sample;
  }

  stop(): { durationMs: number; samples: ResourceSample[]; eventLoopP99Ms: number; eventLoopMaxMs: number; cpuUserMs: number; cpuSystemMs: number; rssPeakBytes: number } {
    if (this.enabled) {
      this.sample();
      this.histogram.disable();
      this.enabled = false;
    }
    const cpu = process.cpuUsage(this.cpuStarted);
    const p99Ns = Number(this.histogram.percentile(99));
    const maxNs = Number(this.histogram.max);
    return {
      durationMs: performance.now() - this.startedAt,
      samples: this.samples,
      eventLoopP99Ms: p99Ns / 1e6,
      eventLoopMaxMs: maxNs / 1e6,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      rssPeakBytes: this.samples.reduce((peak, sample) => Math.max(peak, sample.rssBytes), 0),
    };
  }

  private capture(): ResourceSample {
    const cpu = process.cpuUsage();
    return {
      atMs: performance.now() - this.startedAt,
      rssBytes: process.memoryUsage().rss,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      eventLoopP99Ns: this.enabled ? Number(this.histogram.percentile(99)) : undefined,
      eventLoopMaxNs: this.enabled ? Number(this.histogram.max) : undefined,
    };
  }
}

export async function measureDisk(_dataDir: string, corpusBytes: number, indexPath: string): Promise<DiskUsage> {
  const indexBytes = await fileSize(indexPath);
  const walBytes = await fileSize(`${indexPath}-wal`);
  const shmBytes = await fileSize(`${indexPath}-shm`);
  return { indexBytes, walBytes, shmBytes, corpusBytes };
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

