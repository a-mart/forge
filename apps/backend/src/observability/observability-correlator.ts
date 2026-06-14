export interface ObservabilityCorrelationCounters {
  spansStarted: number;
  spansEnded: number;
  contentTruncations: number;
  redactionMatches: number;
  correlationMisses: number;
  correlationEvictions: number;
}

export class ObservabilityCorrelator {
  private readonly counters: ObservabilityCorrelationCounters = {
    spansStarted: 0,
    spansEnded: 0,
    contentTruncations: 0,
    redactionMatches: 0,
    correlationMisses: 0,
    correlationEvictions: 0,
  };

  incrementSpanStarted(): void {
    this.counters.spansStarted += 1;
  }

  incrementSpanEnded(): void {
    this.counters.spansEnded += 1;
  }

  recordRedaction(stats: { redactionMatches?: number; contentTruncations?: number }): void {
    this.counters.redactionMatches += stats.redactionMatches ?? 0;
    this.counters.contentTruncations += stats.contentTruncations ?? 0;
  }

  recordCorrelationMiss(): void {
    this.counters.correlationMisses += 1;
  }

  recordCorrelationEviction(): void {
    this.counters.correlationEvictions += 1;
  }

  getCounters(): ObservabilityCorrelationCounters {
    return { ...this.counters };
  }
}
