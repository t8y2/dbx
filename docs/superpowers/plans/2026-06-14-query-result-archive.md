# Query Result Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `.dbxresults` export/import so a query tab's saved execution-result runs can be restored later.

**Architecture:** Add a focused archive codec around the existing tab-result-cache snapshot codec. The query store exposes bytes-in/bytes-out methods, while Vue components handle file dialogs, browser download/upload, and toasts.

**Tech Stack:** Vue 3, Pinia, TypeScript, MessagePack via `@msgpack/msgpack`, existing DBX tab-result-cache snapshot codec, Vitest.

---

### Task 1: Archive Codec

**Files:**
- Create: `apps/desktop/src/lib/queryResultArchive.ts`
- Test: `packages/app-tests/queryResultArchive.test.ts`

- [ ] Write failing tests for encoding/decoding a query result archive with multiple runs, rejecting invalid bytes, and producing a binary payload smaller than equivalent JSON for repeated rows.
- [ ] Run `pnpm vitest run packages/app-tests/queryResultArchive.test.ts` and confirm it fails because the module does not exist.
- [ ] Implement `encodeQueryResultArchive`, `decodeQueryResultArchive`, `defaultQueryResultArchiveFileName`, and archive metadata types.
- [ ] Run `pnpm vitest run packages/app-tests/queryResultArchive.test.ts` and confirm it passes.
- [ ] Commit `feat(query): add result archive codec`.

### Task 2: Query Store Import/Export

**Files:**
- Modify: `apps/desktop/src/stores/queryStore.ts`
- Test: `packages/app-tests/queryStore.test.ts`

- [ ] Write a failing store test that exports a query tab with two result runs and imports the archive into a new tab with the active run restored.
- [ ] Run the focused test and confirm it fails because store archive methods do not exist.
- [ ] Add `exportResultArchive(tabId)` and `importResultArchive(bytes)` to the query store. Export should read evicted cache payloads when needed. Import should create a new query tab and project the active archived run into the result grid.
- [ ] Run the focused store test and confirm it passes.
- [ ] Commit `feat(query): restore result archives`.

### Task 3: UI Actions

**Files:**
- Modify: `apps/desktop/src/components/layout/ContentArea.vue`
- Modify: `apps/desktop/src/components/layout/EditorToolbar.vue`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/i18n/locales/en.ts`
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts`

- [ ] Add an import icon button to the query editor toolbar and wire it to App.
- [ ] Add an export button to the result pane when query output exists.
- [ ] Implement Tauri save/open using `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs`; implement browser fallback using Blob download and an `<input type="file">`.
- [ ] Add English and Simplified Chinese UI strings.
- [ ] Run `pnpm typecheck` and confirm it passes.
- [ ] Commit `feat(query): add result archive actions`.

### Task 4: Final Verification

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm vitest run packages/app-tests/queryResultArchive.test.ts packages/app-tests/queryStore.test.ts packages/app-tests/openTabsPersistence.test.ts packages/app-tests/tabResultCache.test.ts packages/app-tests/tabPresentation.test.ts`.
- [ ] Run `pnpm build`.
- [ ] Confirm `git status --short` is clean after commits.
