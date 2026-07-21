# Ingestarr

## Bring your media home—safely.

**Project status: Early stage.** Ingestarr is under active development and is not yet a supported
production release.

Ingestarr is a local-first desktop app for photographers, videographers, and other content
creators who want a safer, more understandable way to move irreplaceable media from cameras, SD
cards, and other folders.

Before anything is copied, Ingestarr reviews the source and previews where the media will go. It
then organizes files by capture date and source, avoids copying files already recorded as verified,
copies new media through temporary files, and independently verifies each copy.

## Why Ingestarr?

- **Transfer with confidence.** Review file counts, estimated size, source identity, and the
  destination before starting.
- **Keep the workflow local.** Source analysis, metadata extraction, copying, verification, and
  catalog data stay on your computer.
- **Build an organized archive.** Capture metadata places media into predictable
  `year/date/source` folders while preserving original filenames.
- **Repeat ingests safely.** Previously verified files can be recognized and skipped, while live
  progress and per-file errors make each run understandable.

## Available today

The current desktop workflow includes:

- Source and destination folder selection with a review before ingest.
- Source recognition plus classification of new, known, ambiguous, and recoverable files.
- Photo and video metadata extraction, with safe filesystem or session-time fallbacks when capture
  metadata is unavailable.
- Capture-date and source-based destination organization.
- Duplicate-aware decisions that skip files only when an earlier verified copy is recorded.
- Temporary-file copying, independent SHA-256 hashes of source and destination, and no-replace
  promotion of verified files.
- Live file and byte progress, cancellation, persisted session records, and per-file error
  reporting.
- Date-grouped media summaries with photo, video, and source filters, paginated results, and
  lazy-loaded thumbnails.
- A sandboxed Electron renderer, a narrow typed preload API, runtime-validated IPC messages, and a
  content security policy.

## Planned

These capabilities are represented in project contracts or product direction, but are not
available through the current desktop workflow:

- Configurable destination folder templates.
- User-selectable collision policies such as prompt, skip, replace, and rename.
- Richer source history and session recovery controls.
- Configurable extension filters and broader format controls.
- More creator-focused workflow and interface polish.

Planned items are direction, not release commitments.

## How it works

1. **Review.** Choose a source and destination. Ingestarr scans the source, identifies familiar
   files, extracts metadata, and shows what it expects to transfer.
2. **Organize.** Each file receives a destination based on its capture date and source label, with a
   safe fallback when capture metadata is missing.
3. **Copy.** New or unresolved media is streamed into an exclusive temporary file. Files with a
   durable verified copy are skipped.
4. **Verify.** Ingestarr independently hashes the temporary copy with SHA-256, compares it with the
   source hash, and only then promotes it without replacing an existing destination file.

## Development

### Requirements

- Node.js 22.13.0 or newer
- pnpm 11
- macOS, Windows, or Linux for development (maker availability varies by host)

### Setup

```sh
pnpm install
pnpm --filter @ingestarr/desktop dev
```

### Commands

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm --filter @ingestarr/desktop dev
pnpm package
pnpm --filter @ingestarr/desktop make
```

Desktop `dev`, `package`, and `make` commands build required workspace packages automatically.
`pnpm check:clean-desktop` removes generated outputs and verifies that packaging can recreate them
from a clean artifact state.

### Workspace

- `apps/desktop`: Electron Forge application with Vite, React, and a typed preload boundary.
- `packages/shared-types`: Zod-backed contracts shared across process and package boundaries.
- `packages/ingest-core`: source scanning, classification, destination planning, copy verification,
  and ingest orchestration.
- `packages/metadata`: metadata normalization and photo/video thumbnail generation.
- `packages/storage`: SQLite-backed persistence and summary queries.
- `packages/platform`: host filesystem and manual-source adapters.

See [architecture](docs/architecture.md) and [design notes](docs/design.md) for boundary decisions,
and [acceptance and QA](docs/acceptance.md) for the acceptance matrix, limitations, recovery
behavior, and installation instructions.

## Project status

Ingestarr is an early-stage project. The repository contains a working desktop ingest workflow,
but there are no release downloads or production-support guarantees yet. Expect interfaces and
storage details to change as the project matures.
