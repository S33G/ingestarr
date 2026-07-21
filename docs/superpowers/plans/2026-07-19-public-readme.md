# Public README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the milestone-oriented README with an accurate, polished public introduction for content creators and contributors.

**Architecture:** This is a documentation-only change. `README.md` will lead with user benefits, separate current and planned capabilities, explain the ingest workflow, and retain contributor setup and workspace details.

**Tech Stack:** Markdown, pnpm monorepo documentation

## Global Constraints

- Clearly label Ingestarr as early-stage software.
- Separate available capabilities from planned work.
- Ground every available-feature claim in the current source.
- Do not imply that release downloads or production support exist.
- Do not add dependencies or change application behavior.

---

### Task 1: Rewrite the public README

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes: Current desktop workflow and package capabilities documented in the source tree.
- Produces: A public-facing project overview plus contributor setup and architecture reference.

- [ ] **Step 1: Replace milestone copy with creator-focused positioning**

Open with the tagline “Bring your media home—safely,” explain the local-first review, organize,
copy, and verify workflow, and add an early-stage project badge.

- [ ] **Step 2: Document benefits and available capabilities**

Add concise sections covering local processing, pre-ingest review, metadata-aware organization,
duplicate awareness, SHA-256 verification, durable progress, media summaries, and the hardened
Electron boundary.

- [ ] **Step 3: Separate planned features**

List configurable organization templates, collision policies, richer source history and recovery,
broader format controls, and creator-focused workflow polish under an explicitly labeled roadmap
section.

- [ ] **Step 4: Retain contributor documentation**

Include Node.js 22.13.0+, pnpm 11, install/development commands, package descriptions, and links to
the architecture and design documents.

- [ ] **Step 5: Validate documentation**

Run:

```sh
pnpm exec prettier --check README.md docs/superpowers/specs/2026-07-19-public-readme-design.md docs/superpowers/plans/2026-07-19-public-readme.md
```

Expected: all three Markdown files pass Prettier validation. Review links and claims against source.
