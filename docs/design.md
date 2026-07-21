# Milestone 0 design notes

## Contract strategy

Zod schemas are the source of truth for runtime validation and TypeScript types. Objects crossing a
trust boundary are strict so accidental or malicious fields are rejected. Discriminated unions make
copy results, progress events, and application errors exhaustive for consumers.

Dates use ISO 8601 strings and byte counts use non-negative integers. Paths remain strings because
normalization and host-specific semantics belong to later platform work.

## IPC strategy

The initial bridge exposes only `health()`. The renderer cannot access `ipcRenderer`, channel names,
or generic invoke/send methods. The main process validates the empty health request before returning
a schema-validated response.

## Packaging strategy

Electron Forge drives development and packaging through its Vite plugin. The configuration builds
separate main, preload, and renderer targets, enables automatic native dependency unpacking, and
provides ZIP, Squirrel, and Debian makers as a small cross-platform starting set. Maker execution is
host-dependent; `forge package` is the portable build validation used by this milestone.

## Deferred work

Milestone 0 does not select a database, scan media, read metadata, match sources, or copy files.
Those decisions require their own tests and design work in later milestones.
