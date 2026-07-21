import { sanitizeDestinationSegment, type DestinationPlatform } from './destination-segment.js';
import type { LogSink } from './session-logger.js';

export interface CardEventLogFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  appendFile(path: string, text: string): Promise<void>;
}

/**
 * Builds the append-only per-card event log path:
 * `<destinationRoot>/.ingestarr/<sanitized card identifier>.log`.
 */
export function cardEventLogPath(
  destinationRoot: string,
  cardIdentifier: string,
  options: { platform?: DestinationPlatform; join?: (...segments: string[]) => string } = {},
): string {
  const join = options.join ?? ((...segments: string[]) => segments.join('/'));
  const safeName = sanitizeDestinationSegment(cardIdentifier, options.platform);
  return join(destinationRoot, '.ingestarr', `${safeName}.log`);
}

/**
 * Creates a crash-safe, append-only text `LogSink` for one card's plain-text
 * event log. The `.ingestarr` directory is created lazily on first write so
 * that enabling the setting never fails destination selection up front.
 */
export function createCardEventLogSink(
  fileSystem: CardEventLogFileSystem,
  destinationRoot: string,
  cardIdentifier: string,
  options: { platform?: DestinationPlatform; join?: (...segments: string[]) => string } = {},
): LogSink {
  const join = options.join ?? ((...segments: string[]) => segments.join('/'));
  const logPath = cardEventLogPath(destinationRoot, cardIdentifier, options);
  const directoryPath = join(destinationRoot, '.ingestarr');
  let directoryReady: Promise<unknown> | undefined;
  return {
    async write(line) {
      directoryReady ??= fileSystem.mkdir(directoryPath, { recursive: true });
      await directoryReady;
      await fileSystem.appendFile(logPath, line);
    },
  };
}
