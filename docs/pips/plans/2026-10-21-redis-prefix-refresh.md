# Redis Prefix Refresh Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this session. Follow TDD and run a fresh whole-change review after verification.

**Goal:** Refresh a Redis key-prefix node without reloading the database tree.

**Architecture:** Add a node action to the existing RedisKeyBrowser. Scan the literal prefix with an independent cursor, buffer bounded passes, and replace only that prefix after the scan completes. Preserve unrelated rows, selection and expansion; invalidate stale requests through the existing scan generation.

**Tech Stack:** Vue 3, TypeScript, existing Redis SCAN API, Vitest/happy-dom, Playwright.

**Spec:** https://github.com/t8y2/dbx/issues/13028 (user-authorized implementation; no separate requirement package).

## Global Constraints

- Preserve Redis API signatures, main SCAN cursor and existing tree conventions.
- Reuse the existing 50-iteration / 500-key subtree interaction budgets; never scan a large prefix to exhaustion automatically.
- A bounded partial scan offers explicit continuation on the same node; no deletion until completion. Errors keep the previous tree and allow retry.
- Honor literal prefix escaping, configured key separator, search and connection key scope.
- Reuse translated Refresh / Load more labels; do not add dependencies or change lockfiles.
- Work only in the isolated worktree. No commit, push, PR or issue closure without further authorization.

## Review Focus

- Empty complete scans remove expired keys, not neighboring prefixes.
- Failed or incomplete scans do not delete still-unscanned keys.
- Duplicate clicks, old subtree fills, database switches and KeepAlive deactivation cannot publish stale results.
- Pending refresh does not alter the main cursor; explicit continuation stays bounded even after the main scan is exhausted.
- Selection, expanded descendants, scope filtering and refreshed metadata remain consistent.

### Task 1: Prefix Refresh Behavior And UI

**Files:** `apps/desktop/src/components/redis/RedisKeyBrowser.vue`, `apps/desktop/src/components/redis/RedisKeyBrowser.subtreeFill.spec.ts`.

**Interfaces:** Add `refreshGroupSubtree(group: RedisKeyTreeGroupNode): Promise<void>` and a generation-owned buffered prefix scan. Consume `redisScanKeysBatch`, `redisScanValues`, `redisGroupSubtreePattern` and existing tree/index helpers without backend changes.

- [x] Add mounted-component regressions for replacement/addition, empty results, metadata, preserved siblings/selection/expansion, failures, bounded continuation, literal prefixes and stale requests.
- [x] Run the new tests and confirm the missing node refresh action fails first.
- [x] Add the inline accessible refresh/loading action and matching group context-menu action, preserving existing styles.
- [x] Implement independent bounded scanning, atomic scoped replacement, selection/TTL cleanup and generation cancellation.
- [x] Run the Redis component and helper suites; inspect actual pass/fail results.

### Task 2: Verification And Review

**Files:** The same component/tests; this plan tracks execution evidence.

- [x] Run `pnpm test`, `pnpm typecheck`, CI-format/lint checks and offline i18n completeness; distinguish baseline failures.
- [x] Validate the real component in a browser at desktop/narrow widths and light/dark themes; capture screenshots and close task-owned sessions.
- [x] Obtain a fresh whole-change review; fix important findings with failing regressions first.
- [x] Report local implementation, verification gaps and claim status separately from remote delivery.

## Execution Evidence

- Base: `origin/main` at `eeab128d7`; isolated branch `codex/redis-prefix-refresh-13028`.
- Claim: `/claim` accepted by dbx-bot; assignee is `caichangqing1120`.
- Pre-flight: frontend-only change, existing issue is the requirement source, no SE review gate applies. Current checkout's unrelated untracked files are untouched.
- Baseline: original subtree component suite passed 12/12. Initial feature regressions failed because the node action was missing. Cached-search and unrelated-subtree-cursor regressions also reproduced failures before their fixes.
- Task 1: focused suite passed 29/29, including 17 new cases. No commit made: user authorization covers implementation and claim, not Git delivery.
- Final review: fresh read-only reviewer identified stale buffered records after confirmed mutations and stale metadata in a surviving selected viewer. Four regressions reproduced these failures before fixes; all 29 focused cases then passed. No declined findings or deferred minors.
- Type check: default Node heap exhausted at approximately 4 GB; `NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck` passed without diagnostics.
- First full run: 1,925 files passed, one file failed; 25,526 tests passed and one CSS fallback test timed out at 10 seconds. Its isolated rerun passed 38/38. Final full run uses `CI=1 pnpm test` (repository CI's four-worker setting).
- Final full run: `CI=1 pnpm test` exited 0; 1,926/1,926 files and 25,531/25,531 tests passed in 294.76 seconds. This includes the final review fixes and all 29 prefix/subtree component tests. Test output contains unrelated fixture network-refusal logs and Node SQLite experimental warnings, not unhandled test failures.
- Format: both changed source files pass oxfmt; whole-source check reports the unchanged baseline `apps/desktop/src/components/mqtt/__tests__/MqttAdminConsolePublishTopic.spec.ts`. Its working-tree blob and HEAD blob both equal `3a10f0fdcc1a7a6d1aa4e0805fd4b38f97840bcf`; unrelated formatting was not changed.
- Lint passed with existing repository warnings. Connection-type generation validation and offline i18n dry-run passed; no new locale keys or lockfile changes.
- Browser: actual RedisKeyBrowser and existing components/styles, HTTP boundary mocked with controlled Redis data. Verified expired removal, new key display, preserved expanded sibling, context-menu refresh and bounded explicit continuation. Captured 1440x900 light, 820x800 dark, 390x844 narrow, and continuation screenshots under the task visualization directory. Final DOM check: refreshed key present, expired key absent, sibling present, zero alerts; browser console had zero errors.
- Browser cleanup: owned Playwright session `dbx13028` closed, its daemon/process absent; Vite stopped, temporary preview sources removed, browser logs moved to `/tmp/dbx-13028-browser-logs`. User-owned browser sessions were not touched.
- Not covered: Windows desktop runtime and a live Redis server; backend API and server code are unchanged. Redis SCAN remains non-snapshot under external concurrent writes.
- Initial delivery checkpoint: issue remained open and assigned to `caichangqing1120`; local changes retained on `codex/redis-prefix-refresh-13028`. No commit, push, PR, release or issue closure had been performed.
- Delivery authorization: user subsequently confirmed committing, pushing to `caichangqing1120/dbx` and creating a PR targeting `t8y2/dbx:main`. Merge, release and worktree cleanup remain out of scope.
- Upstream refresh: `origin/main` advanced to `b9690840a`, including the fix for the baseline MQTT formatting issue. Rebase and revalidation precede push; current verification results belong in the PR description.
- PR screenshots: `../assets/redis-prefix-refresh-13028.png` shows completed prefix refresh with the unrelated group still expanded; `../assets/redis-prefix-refresh-13028-continue.png` shows explicit bounded continuation.
