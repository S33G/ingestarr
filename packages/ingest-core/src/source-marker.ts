/**
 * Writes and reads a small identity marker directly onto a source volume itself (e.g. an SD
 * card's own filesystem), at `<mountPath>/.ingestarr/card.json`. Once present, this marker is
 * the durable, authoritative identity of that physical card: unlike the OS-reported platform
 * volume id (which some readers/OSes don't expose consistently) or the fallback fingerprint
 * heuristic (a similarity guess over label/capacity/file listing), the marker was written by
 * this app the first time the card was named, so reading it back is unambiguous — no confidence
 * score, no "may already be known as" guessing.
 *
 * A human-readable, append-only event log lives alongside it at
 * `<mountPath>/.ingestarr/events.log`, satisfying the plain "a folder with a log of events" ask
 * directly on the card the user is looking at, separate from the per-card log the app may also
 * keep on the destination/archive side (which records ingest history, not card identity).
 */
export interface SourceMarker {
  schemaVersion: 1;
  sourceId: string;
  nickname: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceMarkerFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, text: string): Promise<void>;
  appendFile(path: string, text: string): Promise<void>;
  readFile(path: string): Promise<string>;
}

export interface SourceMarkerPathOptions {
  join?: (...segments: string[]) => string;
}

const defaultJoin = (...segments: string[]): string => segments.join('/');

export function sourceMarkerDirectory(
  mountPath: string,
  options: SourceMarkerPathOptions = {},
): string {
  const join = options.join ?? defaultJoin;
  return join(mountPath, '.ingestarr');
}

export function sourceMarkerPath(mountPath: string, options: SourceMarkerPathOptions = {}): string {
  return (options.join ?? defaultJoin)(sourceMarkerDirectory(mountPath, options), 'card.json');
}

export function sourceEventLogPath(
  mountPath: string,
  options: SourceMarkerPathOptions = {},
): string {
  return (options.join ?? defaultJoin)(sourceMarkerDirectory(mountPath, options), 'events.log');
}

/**
 * Best-effort writer left to the caller: this deliberately does not swallow errors itself, so
 * that callers can choose their own "never block the primary action" handling (matching the
 * existing pattern used for the destination-side per-card log), while still allowing callers
 * that *do* want to surface a failure to do so.
 */
export async function writeSourceMarker(
  fileSystem: SourceMarkerFileSystem,
  mountPath: string,
  marker: Omit<SourceMarker, 'schemaVersion'>,
  options: SourceMarkerPathOptions = {},
): Promise<void> {
  const directoryPath = sourceMarkerDirectory(mountPath, options);
  await fileSystem.mkdir(directoryPath, { recursive: true });
  const payload: SourceMarker = { schemaVersion: 1, ...marker };
  await fileSystem.writeFile(sourceMarkerPath(mountPath, options), `${JSON.stringify(payload, null, 2)}\n`);
}

/** Appends one line to the on-card human-readable event log. Directory creation is lazy and
 * shared with `writeSourceMarker`'s directory, but this can be called independently (e.g. for
 * ingest-session events after the marker already exists). */
export async function appendSourceEventLog(
  fileSystem: SourceMarkerFileSystem,
  mountPath: string,
  line: string,
  options: SourceMarkerPathOptions = {},
): Promise<void> {
  await fileSystem.mkdir(sourceMarkerDirectory(mountPath, options), { recursive: true });
  await fileSystem.appendFile(sourceEventLogPath(mountPath, options), line);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Validates a parsed marker payload, rejecting anything that doesn't match the shape this
 * version of the app writes. Older/newer schema versions and corrupt/malformed JSON are all
 * treated the same way by the caller: as "no marker", falling back to existing reconciliation. */
export function parseSourceMarker(raw: unknown): SourceMarker | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) return undefined;
  if (!isNonEmptyString(candidate.sourceId)) return undefined;
  if (candidate.nickname !== null && !isNonEmptyString(candidate.nickname)) return undefined;
  if (!isNonEmptyString(candidate.createdAt) || !isNonEmptyString(candidate.updatedAt)) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    sourceId: candidate.sourceId,
    nickname: candidate.nickname as string | null,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

/**
 * Reads the on-card marker back, if any. Never throws: a missing file, an unreadable device, or
 * corrupt/malformed JSON are all reported the same way (`undefined`) so callers can treat "no
 * usable marker" uniformly and fall back to the existing platform-id/fingerprint reconciliation
 * path, which remains necessary for cards that predate this feature or were never named through
 * this app.
 */
export async function readSourceMarker(
  fileSystem: Pick<SourceMarkerFileSystem, 'readFile'>,
  mountPath: string,
  options: SourceMarkerPathOptions = {},
): Promise<SourceMarker | undefined> {
  try {
    const text = await fileSystem.readFile(sourceMarkerPath(mountPath, options));
    return parseSourceMarker(JSON.parse(text));
  } catch {
    return undefined;
  }
}
