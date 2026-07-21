export interface LogSink {
  write(line: string): Promise<void>;
}

/**
 * Fans a single write out to multiple sinks, e.g. the per-session text log
 * plus an optional per-card `.ingestarr` event log. A failure in one sink
 * cannot suppress the others; failures are surfaced via `Promise.allSettled`
 * and rejected only if every sink failed, so callers relying on
 * `onSinkError` (see `createSessionLogger`) still observe a single logical
 * write per event.
 */
export function combineLogSinks(...sinks: LogSink[]): LogSink {
  return {
    async write(line) {
      const results = await Promise.allSettled(sinks.map((sink) => sink.write(line)));
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure !== undefined && results.every((result) => result.status === 'rejected')) {
        throw failure.reason;
      }
    },
  };
}

export interface SessionLogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  phase: string;
  message: string;
  sourceId?: string;
  sourcePath?: string;
  destinationPath?: string;
  bytes?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SessionLoggerOptions {
  sessionId: string;
  structuredSink: LogSink;
  textSink: LogSink;
  now?: () => string;
  redactPaths?: boolean;
  onSinkError?: (error: unknown, sink: 'structured' | 'text') => void;
}

export interface SessionLogger {
  log(event: SessionLogEvent): Promise<void>;
}

export function createSessionLogger(options: SessionLoggerOptions): SessionLogger {
  const now = options.now ?? (() => new Date().toISOString());
  const notifySinkError = (error: unknown, sink: 'structured' | 'text'): void => {
    try {
      options.onSinkError?.(error, sink);
    } catch {
      // Diagnostics observers must never affect ingest or logging callers.
    }
  };
  return {
    async log(event) {
      const timestamp = now();
      const sourcePath =
        event.sourcePath === undefined
          ? undefined
          : options.redactPaths === true
            ? '[redacted]'
            : event.sourcePath;
      const destinationPath =
        event.destinationPath === undefined
          ? undefined
          : options.redactPaths === true
            ? '[redacted]'
            : event.destinationPath;
      const record = {
        timestamp,
        sessionId: options.sessionId,
        level: event.level,
        phase: event.phase,
        message: event.message,
        ...(event.sourceId === undefined ? {} : { sourceId: event.sourceId }),
        ...(sourcePath === undefined ? {} : { sourcePath }),
        ...(destinationPath === undefined ? {} : { destinationPath }),
        ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      };
      const textPaths = [sourcePath, destinationPath].filter(
        (value): value is string => value !== undefined,
      );
      const text = `${timestamp} [${event.level.toUpperCase()}] ${event.phase} ${event.message}${
        event.bytes === undefined ? '' : ` (${String(event.bytes)} bytes)`
      }${textPaths.length === 0 ? '' : ` ${textPaths.join(' -> ')}`}\n`;
      const writes = await Promise.allSettled([
        options.structuredSink.write(`${JSON.stringify(record)}\n`),
        options.textSink.write(text),
      ]);
      if (writes[0]?.status === 'rejected') {
        notifySinkError(writes[0].reason, 'structured');
      }
      if (writes[1]?.status === 'rejected') {
        notifySinkError(writes[1].reason, 'text');
      }
    },
  };
}
