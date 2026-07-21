import { describe, expect, it } from 'vitest';

import { RollingThroughput } from './progress-throughput';

describe('rolling ingest throughput', () => {
  it('uses only samples inside the rolling window', () => {
    const throughput = new RollingThroughput(10_000);
    throughput.record(0, 0);
    throughput.record(11_000, 15_000);
    throughput.record(20_000, 25_000);

    expect(throughput.bytesPerSecond()).toBeCloseTo(1_111.11, 1);
  });

  it('returns zero without a positive sampling interval', () => {
    const throughput = new RollingThroughput(10_000);
    throughput.record(1_000, 500);
    expect(throughput.bytesPerSecond()).toBe(0);
  });
});
