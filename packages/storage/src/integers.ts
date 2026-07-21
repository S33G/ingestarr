const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);

export function toSqliteInteger(value: number): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Expected a safe integer, received ${String(value)}`);
  }
  if (value < 0) {
    throw new RangeError(`Expected a non-negative integer, received ${String(value)}`);
  }
  return BigInt(value);
}

export function fromSqliteInteger(value: bigint | number): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`SQLite integer exceeds the JavaScript safe integer range: ${value}`);
    }
    if (value < 0) {
      throw new RangeError(`Expected a non-negative SQLite integer, received ${value}`);
    }
    return value;
  }

  if (value < 0n) {
    throw new RangeError(`Expected a non-negative SQLite integer, received ${value}`);
  }
  if (value > maximumSafeInteger) {
    throw new RangeError(`SQLite integer exceeds the JavaScript safe integer range: ${value}`);
  }
  return Number(value);
}
