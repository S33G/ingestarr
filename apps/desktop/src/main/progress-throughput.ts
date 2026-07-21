interface ThroughputSample {
  atMs: number;
  completedBytes: number;
}

export class RollingThroughput {
  readonly #windowMs: number;
  readonly #samples: ThroughputSample[] = [];

  constructor(windowMs = 15_000) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('Throughput window must be positive.');
    }
    this.#windowMs = windowMs;
  }

  record(atMs: number, completedBytes: number): void {
    if (!Number.isFinite(atMs) || !Number.isFinite(completedBytes) || completedBytes < 0) return;
    this.#samples.push({ atMs, completedBytes });
    const cutoff = atMs - this.#windowMs;
    while (this.#samples.length > 1 && this.#samples[0]!.atMs < cutoff) {
      this.#samples.shift();
    }
  }

  bytesPerSecond(): number {
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    if (first === undefined || last === undefined || last.atMs <= first.atMs) return 0;
    return Math.max(
      0,
      (last.completedBytes - first.completedBytes) / ((last.atMs - first.atMs) / 1_000),
    );
  }
}
