# MySQL TLS Diagnostics Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Fix Preferred TLS fallback and explain legacy TLS / REQUIRE SSL failures without weakening strict modes.

**Architecture:** Extend the existing error classifier and preserve the first TLS failure until all plaintext retries finish. Add specialized frontend hints before the generic TLS path, using existing i18n resources.

**Tech Stack:** Rust, mysql_async 0.37 with rustls, Tokio, TypeScript, Vitest, vue-i18n.

**Spec:** `docs/specs/970-mysql-tls-diagnostics/spec.md`

## Global Constraints

- Preserve Required, Verify CA, Verify Identity, client-certificate, Disabled, and URL alias behavior.
- Keep the legacy-EOF retry and preserve both errors only when plaintext fallback actually occurred and failed.
- Do not diagnose REQUIRE SSL from 1045 alone or recommend SSH as satisfying REQUIRE SSL.
- No TLS backend/runtime dependency/account changes. Do not touch the user's original checkout.
- Follow CONTRIBUTING.md: fork branch, PR to t8y2/dbx main, tests and explicit limitations.

## Review Focus

- Exact reported rustls error triggers fallback only in permitted modes.
- Plaintext failure after TLS and legacy-EOF retry retains the first error.
- Successful fallback yields a working pool without diagnostic errors.
- Disabled aliases, ordinary 1045, missing-password, and non-MySQL failures retain accurate guidance.
- Translation rendering remains valid and specific hints do not append misleading generic advice.

### Task 1: MySQL retry diagnostics

**Files:** `crates/dbx-driver-mysql/src/mysql.rs` (production and existing tests), `crates/dbx-driver-mysql/Cargo.toml` and `Cargo.lock` (test-only direct reference to existing rustls).

**Interfaces:** Retain public `connect` and `connect_with_ca_cert` signatures, `mysql_error_should_retry_without_ssl(&str) -> bool`, and `ssl_fallback_url(&str) -> Option<String>`.

- [x] Add failing tests for the exact reported classifier input and wire-protocol tests through `connect` for Preferred fallback failure/success and strict modes; test the final legacy-EOF retry result.
- [x] Run `cargo test -p dbx-driver-mysql --lib --locked mysql_tls_`; expect regressions to fail for missing fallback/error preservation.
- [x] Recognize only the exact rustls incompatibility variant; store the initial error when fallback starts, assign the legacy-EOF result rather than returning early, and combine errors at the end.
- [x] Run `cargo test -p dbx-driver-mysql --lib --locked`; expect all non-ignored driver tests to pass.
- [x] Commit the driver change and regression tests.

### Task 2: Actionable localized hints

**Files:** `apps/desktop/src/lib/connection/connectionErrorHints.ts`, its existing `__tests__/connectionErrorHints.spec.ts`, and `apps/desktop/src/i18n/locales/*.ts`.

**Interfaces:** Keep `appendConnectionErrorHints(config, message, t): string`. Add `connection.mysqlUnsupportedTlsVersionHint` and `connection.mysqlDisabledTlsAccessDeniedHint`.

- [x] Add failing table-driven tests for exact legacy-version errors, combined fallback errors, Disabled aliases with 1045/28000, ordinary authentication errors, empty passwords, non-MySQL errors, and duplicate hint prevention.
- [x] Run `pnpm exec vitest run apps/desktop/src/lib/connection/__tests__/connectionErrorHints.spec.ts`; expect the new hint cases to fail.
- [x] Add specific hint routing and translations; preserve existing missing-password/certificate priority and native error details.
- [x] Run the focused tests, the i18n suite, and `pnpm test`; expect green, or document unrelated failures individually.
- [x] Commit localized hints and tests.

### Task 3: Verification and submission

**Files:** This plan and Spec; no new production interfaces.

- [x] Run formatting checks, TypeScript checking, complete MySQL crate tests, and frontend suite; record exact outcomes and any environment limitations.
- [x] Request a fresh whole-branch code review; address important findings with RED/GREEN tests.
- [x] Verify issue ownership, fork destination, upstream main base, diff scope, and clean status. Push a codex/ branch to caichangqing1120/dbx and create/attach a PR against t8y2/dbx main. Do not merge, deploy, or close the issue.

Submitted: https://github.com/t8y2/dbx/pull/13294 (head `caichangqing1120:codex/fix-13265-mysql-tls-diagnostics`, base `t8y2:main`). Remote CI is separate from the local checks in `verification.md`.

## Self-review

Verification evidence: `verification.md`. One independent-review P2 was fixed with RED/GREEN coverage.

All acceptance requirements map to Tasks 1/2; Task 3 covers delivery. Existing
mode guards remain authoritative. Tests must include the production connection
flow rather than only testing string helpers. Approved scope is unchanged.
