import { describe, expect, it } from 'vitest';

import { evaluateThroughput } from './throughput-heuristic.js';

describe('evaluateThroughput', () => {
  it('flags a card as slow when well below a conservative baseline and history is insufficient', () => {
    expect(
      evaluateThroughput({
        currentBytesPerSecond: 1_000_000,
        historicalAverageBytesPerSecond: null,
        sampleCount: 1,
      }),
    ).toEqual({ isSlow: true, reason: 'below-baseline' });
  });

  it('does not flag a first sample that clears the conservative baseline', () => {
    expect(
      evaluateThroughput({
        currentBytesPerSecond: 20_000_000,
        historicalAverageBytesPerSecond: null,
        sampleCount: 1,
      }),
    ).toEqual({ isSlow: false, reason: 'normal' });
  });

  it('flags a large drop relative to a source own historical average', () => {
    expect(
      evaluateThroughput({
        currentBytesPerSecond: 4_000_000,
        historicalAverageBytesPerSecond: 20_000_000,
        sampleCount: 5,
      }),
    ).toEqual({ isSlow: true, reason: 'below-historical-average' });
  });

  it('does not flag throughput that is close to the historical average', () => {
    expect(
      evaluateThroughput({
        currentBytesPerSecond: 18_000_000,
        historicalAverageBytesPerSecond: 20_000_000,
        sampleCount: 5,
      }),
    ).toEqual({ isSlow: false, reason: 'normal' });
  });

  it('falls back to the baseline check until enough samples have accumulated', () => {
    expect(
      evaluateThroughput({
        currentBytesPerSecond: 15_000_000,
        historicalAverageBytesPerSecond: 20_000_000,
        sampleCount: 2,
      }),
    ).toEqual({ isSlow: false, reason: 'normal' });
    expect(
      evaluateThroughput({
        currentBytesPerSecond: 1_000_000,
        historicalAverageBytesPerSecond: 20_000_000,
        sampleCount: 2,
      }),
    ).toEqual({ isSlow: true, reason: 'below-baseline' });
  });
});
