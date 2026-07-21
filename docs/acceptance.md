# Acceptance and QA

This document records the v1 acceptance matrix, the quality gates that back it, known
limitations, recovery behavior, and installation instructions. It reflects the state of the
repository at the close of Phase 4 (hardening, packaging, and QA).

## How to reproduce the acceptance run

All commands run from the repository root unless noted.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm package
pnpm --filter @ingestarr/desktop smoke:native
pnpm --filter @ingestarr/desktop smoke:launch
```

`pnpm package` and the smoke scripts build and inspect a real packaged application for the host
platform. `smoke:launch` starts the packaged binary and waits for the main process to report
readiness, so it requires a host that can launch the Electron runtime (a headless or heavily
sandboxed environment can abort the GUI process with `SIGABRT`).

## Quality gates (host: macOS, arm64)

| Gate                                | Command                                         | Result                                                                     |
| ----------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Lint                                | `pnpm lint`                                     | Pass                                                                       |
| Types                               | `pnpm typecheck`                                | Pass                                                                       |
| Unit + integration + contract tests | `pnpm test`                                     | 361 passed, 1 skipped (46 files)                                           |
| Production package                  | `pnpm package`                                  | Pass (arm64/darwin artifact produced)                                      |
| Packaged native modules             | `pnpm --filter @ingestarr/desktop smoke:native` | Pass (sharp, better-sqlite3, bundled FFmpeg, third-party notices verified) |
| Packaged launch                     | `pnpm --filter @ingestarr/desktop smoke:launch` | Pass (main process reports `{"status":"ready"}`)                           |

The single skipped test is the macOS mounted-volume smoke, which only executes on a host with real
removable media attached.

## Acceptance matrix

Status legend: **Verified** — exercised by automated tests and/or the packaged smoke on the CI
host; **Configured** — implemented and unit/contract-tested, but the platform-native build was not
produced on this host.

| #   | Criterion                                                                                   | Evidence                                                                                                     | macOS    | Windows    | Linux      |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- | ---------- | ---------- |
| 1   | App packages and launches                                                                   | `pnpm package`, `smoke:native`, `smoke:launch`; Forge makers for ZIP (darwin), Squirrel (win32), Deb (linux) | Verified | Configured | Configured |
| 2   | Secure Electron shell (context isolation, sandbox, no node integration, CSP, validated IPC) | `window-options`, `content-security-policy`, `security`, `ipc`, `preload/api` tests                          | Verified | Verified   | Verified   |
| 3   | Source + destination selection with pre-ingest review                                       | renderer `App` tests, `ipc` handlers                                                                         | Verified | Verified   | Verified   |
| 4   | Deterministic scan, source identity, classification, destination planning                   | `scan-media`, `identify-source`, `classify-files`, `plan-destination`, `naming-template` tests               | Verified | Verified   | Verified   |
| 5   | Crash-safe copy, SHA-256 verification, no-replace atomic promotion, manifests, logs         | `copy-and-verify`, `manifest-writer`, `session-logger`, `run-ingest` tests                                   | Verified | Verified   | Verified   |
| 6   | Duplicate-aware skip only on a durable verified copy                                        | `run-ingest`, storage `repositories`/`storage` tests                                                         | Verified | Verified   | Verified   |
| 7   | Metadata extraction with timezone-aware capture-date normalization and safe fallbacks       | `exiftool-client`, `normalize-capture-date`, `classify-media-type`, `metadata` tests                         | Verified | Verified   | Verified   |
| 8   | Photo/RAW/video thumbnails with retry, timeout, abort, and atomic cache writes              | `thumbnail-service` tests, `smoke:native` (sharp + FFmpeg)                                                   | Verified | Configured | Configured |
| 9   | Date-grouped summary with photo/video/source filters, pagination, lazy thumbnails           | `summary-repository`, `summary-ipc`, `SummaryScreen`/`App` tests                                             | Verified | Verified   | Verified   |
| 10  | Mounted-source adapters for macOS, Windows, Linux                                           | `adapters`, `platform-adapter`, `macos-adapter.smoke` (host-gated) tests                                     | Verified | Configured | Configured |
| 11  | Source reconciliation, settings, cancellation, resume/recovery                              | `source-reconciliation`, `resume-session`, `settings`, controller/ingest-service tests                       | Verified | Verified   | Verified   |
| 12  | Versioned migrations with checksum/order verification and transactional application         | `migrations`, `storage` tests                                                                                | Verified | Verified   | Verified   |
| 13  | Bounded thumbnail cache (bounded/session policy, LRU eviction) and TTL metadata cache       | `ingest-service` cache eviction path, `settings` tests                                                       | Verified | Verified   | Verified   |

Cross-platform note: items marked **Configured** for Windows and Linux are implemented behind
platform adapters and validated by contract/unit tests, but the native installer artifacts
(`Squirrel`, `Deb`) and packaged GUI launch must still be produced and smoke-tested on their
respective hosts. The maker configuration in `apps/desktop/forge.config.ts` is in place for those
builds.

## Known limitations

- **Distribution blocker (GPL/FFmpeg).** The thumbnail pipeline bundles `ffmpeg-static`, which is
  GPL-3.0-or-later. Packaged artifacts must not be distributed until corresponding-source/source-
  offer compliance and required notices are automated and verified, or `ffmpeg-static` is replaced
  by an approved LGPL-compatible build. This applies to unsigned, internal, and CI artifacts. See
  [third-party media dependencies](third-party-media.md).
- **Unsigned artifacts.** Builds are not code-signed or notarized. macOS Gatekeeper and Windows
  SmartScreen will warn, and installation requires an explicit user override.
- **Windows/Linux builds are host-gated.** The acceptance run above was performed on macOS
  (arm64). Windows and Linux packaging and launch smoke must be run on those hosts.
- **Removable-media smoke is host-gated.** The macOS mounted-volume test only runs when real
  removable media is attached; it is skipped in headless CI.
- **Planned product features are not shipped.** Configurable destination templates, user-selectable
  collision policies (prompt/skip/replace/rename), configurable extension filters, and richer
  source-history controls are represented in contracts or direction but are not part of the current
  workflow. See the "Planned" section of the [README](../README.md).

## Recovery behavior

Ingestarr is designed so an interrupted or crashed run leaves durable, resumable state rather than
partial or corrupted output.

- **Atomic, no-replace promotion.** New media is streamed into an exclusive temporary file, hashed
  independently with SHA-256, compared against the source, and only then promoted. Verified files
  are never overwritten.
- **Authoritative session state.** Session and per-file status transitions are persisted in SQLite.
  Progress-callback, manifest-projection, and logging failures are isolated so they cannot corrupt
  authoritative state.
- **Fatal vs. recoverable errors.** `runIngest` classifies fatal conditions
  (`SOURCE_UNAVAILABLE`, `DATABASE_FAILED`) separately from per-file failures. Fatal errors stop the
  run with a resumable session; per-file failures are recorded and the run continues.
- **Cancellation.** Cancellation is cooperative via `AbortSignal` across scan, metadata, copy, and
  thumbnail generation, and resolves the session to a `cancelled` state.
- **Resume.** A previously created session can be recovered and re-verified on resume; files with a
  durable verified copy are recognized and skipped. Session recovery context (destination root and
  source identity) is persisted for reconnection.
- **Migration safety.** Migrations are applied in a transaction with recorded checksums; an
  unexpected, reordered, or altered applied migration aborts startup rather than mutating the
  schema.
- **Bounded caches.** The thumbnail cache is pruned by policy (bounded size with LRU eviction, or
  session-scoped), and the in-memory metadata cache is bounded by entry count and TTL.

## Installation

There are no signed release downloads yet. Install by building from source.

### Prerequisites

- Node.js 22.13.0 or newer
- pnpm 11
- Build host matching your target OS (maker availability varies by host)

### Build a packaged application

```sh
pnpm install
pnpm --filter @ingestarr/desktop package
```

The packaged application is written under `apps/desktop/out/`. Because artifacts are unsigned, your
OS may require an explicit override to run them (for example, right-click → Open on macOS).

### Build installers

```sh
pnpm --filter @ingestarr/desktop make
```

Makers are configured per platform in `apps/desktop/forge.config.ts`:

- macOS: `MakerZIP`
- Windows: `MakerSquirrel`
- Linux: `MakerDeb`

Run `make` on each target OS to produce that platform's installer. Do not distribute artifacts until
the FFmpeg/GPL distribution blocker above is resolved.

### Run from source (development)

```sh
pnpm install
pnpm --filter @ingestarr/desktop dev
```
