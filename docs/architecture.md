# Architecture

## Boundaries

The desktop application follows Electron's process separation:

1. The main process owns windows, native capabilities, and IPC handlers.
2. The sandboxed preload exposes a deliberately small `window.ingestarr` API.
3. The React renderer has no Node.js access and cannot call arbitrary IPC channels.
4. Every value crossing IPC is parsed with a schema from `@ingestarr/shared-types`.

The package dependency direction is toward contracts and abstractions:

```text
desktop ───────────────┐
ingest-core ───────────┤
metadata ──────────────┼──> shared-types
storage ───────────────┤
platform ──────────────┘
```

Feature packages remain placeholders in Milestone 0. Later implementations should keep file-system
and operating-system access in `platform`, persistence in `storage`, metadata tools in `metadata`,
and workflow policy in `ingest-core`.

## Security baseline

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- context bridge API restricted to named capabilities
- strict request and response validation
- renderer Content Security Policy
- ASAR packaging with native modules automatically unpacked

New IPC capabilities must add request and response schemas, a typed map entry, a main handler, a
preload method, and tests for validation and API surface area.
