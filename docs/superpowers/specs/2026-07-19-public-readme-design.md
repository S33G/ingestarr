# Public README design

## Goal

Present Ingestarr as an appealing open-source desktop app for photographers, videographers, and
other content creators while accurately distinguishing the working application from its broader
product direction.

## Audience and positioning

Lead with the creator problem: transferring irreplaceable media from cameras, SD cards, and other
removable storage should be safe, understandable, and repeatable. Position Ingestarr as a
local-first ingest workflow that reviews media before transfer, organizes it using capture
metadata, avoids verified duplicates, and independently verifies copied files.

The README must state that the project is early-stage. Features exercised by the current desktop
workflow belong under "Available today"; settings and workflows represented only by lower-level
contracts or future intent belong under "Planned."

## Structure

1. Project title, concise creator-focused tagline, and early-stage badge.
2. A short overview explaining the review, organize, copy, and verify workflow.
3. "Why Ingestarr?" benefits focused on confidence, privacy, organization, and repeatability.
4. "Available today" feature list grounded in current implementation.
5. "Planned" feature list describing the intended product direction without release promises.
6. A four-step "How it works" section.
7. Development requirements, setup, commands, and workspace architecture.
8. Project status and links to architecture and design notes.

## Feature claims

Available features may include:

- Local-first desktop operation.
- Source and destination folder selection with a review before ingest.
- Source recognition and classification of new, known, ambiguous, and recoverable files.
- EXIF and video metadata extraction with safe timestamp fallbacks.
- Capture-date and source-based destination organization.
- Duplicate-aware transfer decisions.
- Temporary-file copying, SHA-256 source/destination verification, and no-replace promotion.
- Live progress, cancellation, durable session state, and per-file errors.
- Date-grouped media summaries, photo/video filtering, and lazy-loaded thumbnails.
- A sandboxed Electron renderer, narrow typed IPC surface, runtime validation, and content security
  policy.

Planned features should be limited to credible extensions already represented in project contracts,
such as configurable destination templates, collision policies, extension filters, richer source
history, recovery controls, and broader creator workflow polish.

## Tone and presentation

Use confident, plain language and short sections. Prefer benefits over implementation jargon in the
opening half, then provide technical detail for contributors. Avoid unsupported claims, release
dates, download instructions for artifacts that do not exist, and decorative badges that cannot
report real repository state. A screenshot should not be referenced until a repository asset
exists.

## Validation

Review every current-feature claim against the application and package source. Check Markdown
formatting and repository links. Since this change is documentation-only, no application behavior
or automated test changes are required.
