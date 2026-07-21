/**
 * A deliberately simple, documented heuristic for flagging a card that is
 * likely experiencing a read/write slowdown, rather than an attempt to
 * precisely model USB/SD bus performance.
 *
 * - `BASELINE_BYTES_PER_SECOND` is a conservative floor (5 MB/s) below which
 *   almost any USB2/SD-class reader should be able to sustain sequential
 *   transfer; used when a source has no throughput history yet.
 * - Once a source has enough completed-session samples
 *   (`MINIMUM_SAMPLES_FOR_HISTORY`), a session is instead flagged when its
 *   throughput drops below `HISTORICAL_SLOWDOWN_RATIO` of that source's own
 *   historical average — catching a card/reader that has degraded relative
 *   to its own prior performance, even if still above the global baseline.
 */
export const BASELINE_BYTES_PER_SECOND = 5_000_000;
export const HISTORICAL_SLOWDOWN_RATIO = 0.5;
export const MINIMUM_SAMPLES_FOR_HISTORY = 3;

export interface ThroughputHeuristicInput {
  currentBytesPerSecond: number;
  historicalAverageBytesPerSecond: number | null;
  sampleCount: number;
}

export interface ThroughputHeuristicResult {
  isSlow: boolean;
  reason: 'below-baseline' | 'below-historical-average' | 'normal';
}

export function evaluateThroughput(input: ThroughputHeuristicInput): ThroughputHeuristicResult {
  const hasHistory =
    input.historicalAverageBytesPerSecond !== null &&
    input.sampleCount >= MINIMUM_SAMPLES_FOR_HISTORY;
  if (hasHistory) {
    const threshold = (input.historicalAverageBytesPerSecond as number) * HISTORICAL_SLOWDOWN_RATIO;
    return input.currentBytesPerSecond < threshold
      ? { isSlow: true, reason: 'below-historical-average' }
      : { isSlow: false, reason: 'normal' };
  }
  return input.currentBytesPerSecond < BASELINE_BYTES_PER_SECOND
    ? { isSlow: true, reason: 'below-baseline' }
    : { isSlow: false, reason: 'normal' };
}
