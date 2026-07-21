import { describe, expect, it } from 'vitest';

import { calculateProgressTelemetry } from './progress';

describe('progress telemetry', () => {
  it('calculates bounded progress and ETA without dividing by zero', () => {
    expect(calculateProgressTelemetry(0, 0, 0)).toEqual({
      percent: 0,
      etaSeconds: null,
      remainingBytes: 0,
    });
    expect(calculateProgressTelemetry(100, 25, 0)).toEqual({
      percent: 25,
      etaSeconds: null,
      remainingBytes: 75,
    });
    expect(calculateProgressTelemetry(100, 25, 10)).toEqual({
      percent: 25,
      etaSeconds: 8,
      remainingBytes: 75,
    });
    expect(calculateProgressTelemetry(100, 150, 10).percent).toBe(100);
  });
});
