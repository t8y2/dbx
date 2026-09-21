# GitLab Snippets Implementation Plan

> For agentic workers: implement and verify each task in this worktree.

**Goal:** Support encrypted DBX configuration snapshots in private personal GitLab Snippets on self-managed HTTP or HTTPS instances.

**Architecture:** Extend the existing snippet sync client with GitLab-specific REST paths and payloads, keeping snapshot encryption and legacy migration shared. Scope locally saved token, snippet ID, and cleanup state by canonical instance URL; expose the URL in Desktop settings and command/API contracts.

**Tech Stack:** Rust (dbx-core, Tauri, Axum), Vue/TypeScript, Vitest.

**Spec:** https://github.com/t8y2/dbx/issues/9699

## Global Constraints

- Personal Snippets only, not Repository Files API or automatic merging.
- Accept HTTP for trusted internal instances with a clear token transport warning; reject URLs with credentials, query, or fragment.
- Keep existing GitHub/Gitee state keys and snapshot formats unchanged.
- Preserve migration protections and never persist a token in the snapshot.

## Review Focus

- URL variants of one instance map to one local account; different instances never share secrets or cleanup state.
- Malformed or cross-origin IDs/redirects must not leak the token.
- New GitLab snippet must be private and only its `dbx-sync.json` content restored.
- An encrypted existing snippet must decrypt before update; plaintext migration creates a new snippet.
- Invalid token/permissions and missing snippet ID should have actionable errors.

### Task 1: Core provider and state

**Files:** `crates/dbx-core/src/persistence/cloud_sync.rs`

- [x] Add tests for canonical URL, scoped credentials/state, GitLab create/update/read/migration HTTP contract and invalid IDs.
- [x] Add GitLab provider, validated instance URL, request builder and payload/read paths.
- [x] Run focused Rust tests; preserve existing provider tests.

### Task 2: Desktop and API contracts

**Files:** `src-tauri/src/commands/cloud_sync.rs`, `crates/dbx-web/src/routes/cloud_sync.rs`, `apps/desktop/src/lib/backend/{tauri,http}.ts`, `apps/desktop/src/components/editor/EditorSettingsDialog.vue`, `apps/desktop/src/i18n/locales/{en,zh-CN}.ts`

- [x] Propagate instance URL to settings/ID operations without changing older provider behavior.
- [x] Add GitLab option and instance field; refresh saved state on instance changes.
- [x] Run typecheck and targeted frontend checks.

### Task 3: Documentation and delivery

**Files:** `docs/content/docs/cloud-sync.{cn.mdx,mdx}`

- [x] Document token scope, HTTPS URL, private snippets, encryption, manual sync and migration.
- [x] Run format, focused tests and diff review.
- Push only the feature branch to the fork and open a PR with `Fixes #9699`.
