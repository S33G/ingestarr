import { z } from 'zod';

export const captureAtSourceSchema = z.enum([
  'DateTimeOriginal',
  'CreateDate',
  'QuickTimeCreateDate',
  'CreationDate',
  'ContentCreateDate',
  'TrackCreateDate',
  'MediaCreateDate',
  'filesystem-modifiedAt',
  'session-start',
]);
export type CaptureAtSource = z.infer<typeof captureAtSourceSchema>;

export const captureTimezoneKindSchema = z.enum(['utc', 'offset', 'floating', 'fallback']);
export type CaptureTimezoneKind = z.infer<typeof captureTimezoneKindSchema>;

export const captureOffsetSourceSchema = z.enum([
  'inline',
  'OffsetTimeOriginal',
  'OffsetTimeDigitized',
  'TimeZone',
  'ExifDateTime',
]);
export type CaptureOffsetSource = z.infer<typeof captureOffsetSourceSchema>;

const dateTimeComponents =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/;

function validGregorianComponents(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): boolean {
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function validGregorianDateTime(value: string): boolean {
  const match = dateTimeComponents.exec(value);
  if (match === null) return false;
  return validGregorianComponents(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    return validGregorianComponents(year ?? 0, month ?? 0, day ?? 0);
  }, 'captureDay must be a valid calendar date');
const floatingDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/;
const offsetDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?[+-]\d{2}:\d{2}$/;
const utcDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const offsetToken = /(?:Z|([+-])(\d{2}):(\d{2}))$/;

function parseOffsetMinutes(value: string | null): number | undefined {
  if (value === null) return undefined;
  const match = offsetToken.exec(value.trim());
  if (match === null) return undefined;
  if (match[0] === 'Z') return 0;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return undefined;
  return (hours * 60 + minutes) * (match[1] === '-' ? -1 : 1);
}

function issue(context: z.RefinementCtx, path: string, message: string): void {
  context.addIssue({ code: 'custom', path: [path], message });
}

export const captureAtSchema = z
  .string()
  .min(1)
  .refine(
    validGregorianDateTime,
    'captureAt must be an ISO date-time with UTC, explicit offset, or no timezone',
  );

export const normalizedCaptureSchema = z
  .strictObject({
    captureAt: z.string().min(1),
    captureAtSource: captureAtSourceSchema,
    captureAtRaw: z.string().min(1),
    captureTimezoneKind: captureTimezoneKindSchema,
    captureOffsetMinutes: z.number().int().min(-840).max(840).nullable(),
    captureOffsetSource: captureOffsetSourceSchema.nullable(),
    captureOffsetRaw: z.string().min(1).nullable(),
    captureDay: calendarDaySchema,
  })
  .superRefine((capture, context) => {
    if (!validGregorianDateTime(capture.captureAt)) {
      issue(context, 'captureAt', 'captureAt must contain valid Gregorian date/time components');
    }
    const fallbackSource =
      capture.captureAtSource === 'filesystem-modifiedAt' ||
      capture.captureAtSource === 'session-start';
    if ((capture.captureTimezoneKind === 'fallback') !== fallbackSource) {
      issue(context, 'captureTimezoneKind', 'fallback timezone kind and source must agree');
    }
    if (capture.captureTimezoneKind === 'floating') {
      if (!floatingDateTime.test(capture.captureAt)) {
        issue(context, 'captureAt', 'floating captureAt must not contain a timezone');
      }
      if (
        capture.captureOffsetMinutes !== null ||
        capture.captureOffsetSource !== null ||
        capture.captureOffsetRaw !== null
      ) {
        issue(context, 'captureOffsetMinutes', 'floating capture dates cannot contain an offset');
      }
    } else if (capture.captureTimezoneKind === 'offset') {
      if (!offsetDateTime.test(capture.captureAt)) {
        issue(context, 'captureAt', 'offset captureAt must contain an explicit offset');
      }
      if (
        capture.captureOffsetMinutes === null ||
        capture.captureOffsetSource === null ||
        capture.captureOffsetRaw === null
      ) {
        issue(context, 'captureOffsetMinutes', 'offset capture dates require offset provenance');
      }
    } else if (capture.captureTimezoneKind === 'utc') {
      if (!utcDateTime.test(capture.captureAt) || capture.captureOffsetMinutes !== 0) {
        issue(context, 'captureAt', 'UTC capture dates require a Z value and zero offset');
      }
      if (capture.captureOffsetSource === null || capture.captureOffsetRaw === null) {
        issue(context, 'captureOffsetSource', 'UTC capture dates require offset provenance');
      }
    } else {
      if (
        !utcDateTime.test(capture.captureAt) ||
        capture.captureOffsetMinutes !== 0 ||
        capture.captureOffsetSource !== null ||
        capture.captureOffsetRaw !== null
      ) {
        issue(context, 'captureAt', 'fallback captures require a UTC instant without offset tags');
      }
    }
    if (capture.captureTimezoneKind === 'offset' || capture.captureTimezoneKind === 'utc') {
      if (parseOffsetMinutes(capture.captureAt) !== capture.captureOffsetMinutes) {
        issue(context, 'captureAt', 'captureAt offset must equal captureOffsetMinutes');
      }
      if (parseOffsetMinutes(capture.captureOffsetRaw) !== capture.captureOffsetMinutes) {
        issue(context, 'captureOffsetRaw', 'raw offset must equal captureOffsetMinutes');
      }
    }
    if (capture.captureTimezoneKind === 'fallback') {
      if (capture.captureAt.slice(0, 10) !== capture.captureDay) {
        issue(context, 'captureDay', 'fallback captureDay must be the UTC instant day');
      }
    } else if (capture.captureAt.slice(0, 10) !== capture.captureDay) {
      issue(context, 'captureDay', 'camera captureDay must preserve the literal calendar day');
    }
  });
export type NormalizedCapture = z.infer<typeof normalizedCaptureSchema>;

export const ingestMetadataSchema = normalizedCaptureSchema
  .safeExtend({
    cameraMake: z.string().min(1).nullable(),
    cameraModel: z.string().min(1).nullable(),
    lensModel: z.string().min(1).nullable(),
    mimeType: z.string().min(1).nullable(),
    mediaType: z.enum(['photo', 'video', 'unknown']),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    durationSeconds: z.number().nonnegative().finite().nullable(),
    gpsPresent: z.boolean(),
    warnings: z.array(z.string().min(1)),
    degradation: z.strictObject({ message: z.string().min(1) }).optional(),
  })
  .strict();
export type IngestMetadata = z.infer<typeof ingestMetadataSchema>;
