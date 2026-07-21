export interface ProgressTelemetry {
  percent: number;
  etaSeconds: number | null;
  remainingBytes: number;
}

export function calculateProgressTelemetry(
  totalBytes: number,
  completedBytes: number,
  throughputBytesPerSecond: number,
): ProgressTelemetry {
  const safeTotal = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const safeCompleted =
    Number.isFinite(completedBytes) && completedBytes > 0 ? Math.min(completedBytes, safeTotal) : 0;
  const remainingBytes = Math.max(0, safeTotal - safeCompleted);
  const percent =
    safeTotal === 0 ? 0 : Math.max(0, Math.min(100, Math.round((safeCompleted / safeTotal) * 100)));
  const etaSeconds =
    remainingBytes === 0 ||
    !Number.isFinite(throughputBytesPerSecond) ||
    throughputBytesPerSecond <= 0
      ? null
      : Math.ceil(remainingBytes / throughputBytesPerSecond);
  return { percent, etaSeconds, remainingBytes };
}
