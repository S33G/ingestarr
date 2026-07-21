import Database from 'better-sqlite3';

export interface DatabaseConnection {
  readonly database: Database.Database;
  readonly journalMode: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  busyTimeoutMs?: number;
  databaseFactory?: (path: string) => Database.Database;
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseConnection {
  const database = options.databaseFactory?.(path) ?? new Database(path);
  database.defaultSafeIntegers(true);
  database.pragma('foreign_keys = ON');
  database.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
  const journalMode = String(database.pragma('journal_mode = WAL', { simple: true }));

  return {
    database,
    journalMode,
    close() {
      if (database.open) {
        database.close();
      }
    },
  };
}
