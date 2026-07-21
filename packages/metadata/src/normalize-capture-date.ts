import {
  normalizedCaptureSchema,
  type CaptureAtSource,
  type CaptureOffsetSource,
  type CaptureTimezoneKind,
  type NormalizedCapture,
} from '@ingestarr/shared-types';

export const captureDateTagPriority = [
  'DateTimeOriginal',
  'CreateDate',
  'QuickTimeCreateDate',
  'CreationDate',
  'ContentCreateDate',
  'TrackCreateDate',
  'MediaCreateDate',
] as const;

export type CaptureDateTag = (typeof captureDateTagPriority)[number];
export type { CaptureAtSource, CaptureOffsetSource, CaptureTimezoneKind };

export interface CaptureDateCandidates extends Partial<Record<CaptureDateTag, string>> {
  OffsetTimeOriginal?: string;
  OffsetTimeDigitized?: string;
  TimeZone?: string;
  DateTimeOriginalOffset?: string;
  CreateDateOffset?: string;
}

export type NormalizedCaptureDate = NormalizedCapture;

interface ParsedCameraDate {
  value: string;
  day: string;
  timezoneKind: 'utc' | 'offset' | 'floating';
  offsetMinutes: number | null;
  offsetSource: CaptureOffsetSource | null;
  offsetRaw: string | null;
}

const CAMERA_DATE =
  /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i;
const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;

function validCalendarDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (
    year < 1900 ||
    year > 2200 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function parseOffset(value: string | undefined): { text: string; minutes: number } | undefined {
  if (value === undefined) return undefined;
  const match = OFFSET.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return undefined;
  const total = (hours * 60 + minutes) * (match[1] === '-' ? -1 : 1);
  return { text: `${match[1]}${match[2]}:${match[3]}`, minutes: total };
}

function separateOffset(
  tag: CaptureDateTag,
  candidates: CaptureDateCandidates,
): { value: string; source: CaptureOffsetSource } | undefined {
  if (tag === 'DateTimeOriginal' && candidates.OffsetTimeOriginal !== undefined) {
    return { value: candidates.OffsetTimeOriginal, source: 'OffsetTimeOriginal' };
  }
  if (tag === 'DateTimeOriginal' && candidates.DateTimeOriginalOffset !== undefined) {
    return { value: candidates.DateTimeOriginalOffset, source: 'ExifDateTime' };
  }
  if (tag === 'CreateDate' && candidates.OffsetTimeDigitized !== undefined) {
    return { value: candidates.OffsetTimeDigitized, source: 'OffsetTimeDigitized' };
  }
  if (tag === 'CreateDate' && candidates.CreateDateOffset !== undefined) {
    return { value: candidates.CreateDateOffset, source: 'ExifDateTime' };
  }
  return candidates.TimeZone === undefined
    ? undefined
    : { value: candidates.TimeZone, source: 'TimeZone' };
}

function parseCameraDate(
  raw: string,
  separate: { value: string; source: CaptureOffsetSource } | undefined,
): ParsedCameraDate | undefined {
  const match = CAMERA_DATE.exec(raw.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    !validCalendarDate(year, month, day, hour, minute, second)
  ) {
    return undefined;
  }
  const calendarDay = `${match[1]}-${match[2]}-${match[3]}`;
  const fraction = match[7] === undefined ? '' : `.${match[7]}`;
  const base = `${calendarDay}T${match[4]}:${match[5]}:${match[6]}${fraction}`;
  const inlineZone = match[8]?.toUpperCase();
  if (inlineZone === 'Z') {
    return {
      value: `${base}Z`,
      day: calendarDay,
      timezoneKind: 'utc',
      offsetMinutes: 0,
      offsetSource: 'inline',
      offsetRaw: inlineZone,
    };
  }
  const offset = parseOffset(inlineZone ?? separate?.value);
  if (inlineZone !== undefined && offset === undefined) return undefined;
  if (offset !== undefined) {
    return {
      value: `${base}${offset.text}`,
      day: calendarDay,
      timezoneKind: 'offset',
      offsetMinutes: offset.minutes,
      offsetSource: inlineZone === undefined ? (separate?.source ?? null) : 'inline',
      offsetRaw: inlineZone ?? separate?.value ?? null,
    };
  }
  return {
    value: base,
    day: calendarDay,
    timezoneKind: 'floating',
    offsetMinutes: null,
    offsetSource: null,
    offsetRaw: null,
  };
}

function fallback(instant: string, source: CaptureAtSource): NormalizedCaptureDate | undefined {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const value = parsed.toISOString();
  return normalizedCaptureSchema.parse({
    captureAt: value,
    captureAtSource: source,
    captureAtRaw: instant,
    captureTimezoneKind: 'fallback',
    captureOffsetMinutes: 0,
    captureOffsetSource: null,
    captureOffsetRaw: null,
    captureDay: value.slice(0, 10),
  });
}

export function normalizeCaptureDate(input: {
  candidates: CaptureDateCandidates;
  modifiedAt: string;
  sessionStartedAt: string;
}): NormalizedCaptureDate {
  for (const tag of captureDateTagPriority) {
    const raw = input.candidates[tag];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = parseCameraDate(raw, separateOffset(tag, input.candidates));
    if (parsed === undefined) continue;
    return normalizedCaptureSchema.parse({
      captureAt: parsed.value,
      captureAtSource: tag,
      captureAtRaw: raw,
      captureTimezoneKind: parsed.timezoneKind,
      captureOffsetMinutes: parsed.offsetMinutes,
      captureOffsetSource: parsed.offsetSource,
      captureOffsetRaw: parsed.offsetRaw,
      captureDay: parsed.day,
    });
  }
  const normalizedFallback =
    fallback(input.modifiedAt, 'filesystem-modifiedAt') ??
    fallback(input.sessionStartedAt, 'session-start');
  if (normalizedFallback === undefined) {
    throw new Error('A valid filesystem or session fallback timestamp is required');
  }
  return normalizedFallback;
}
