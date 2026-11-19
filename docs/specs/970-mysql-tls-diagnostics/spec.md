# MySQL TLS fallback diagnostics

Issue: https://github.com/t8y2/dbx/issues/13265

Approval: the user approved the P0 proposal in this conversation on 2026-10-23
and authorized claim, implementation, verification, and a PR to upstream main.

## Scope and acceptance

- Recognize rustls `ServerDoesNotSupportTls12Or13` in the existing Preferred
  plaintext fallback classifier. Preserve existing aliases and fallback guards.
- Required, Verify CA, Verify Identity, and client-certificate connections must
  never downgrade. Disabled must not attempt TLS.
- If fallback fails, preserve both the original TLS error and the final plaintext
  error, including the result of the existing legacy-EOF retry. Successful
  fallback must still return a usable pool.
- Give TLS-version-specific guidance instead of the generic disable-TLS hint:
  the built-in MySQL driver supports TLS 1.2/1.3, legacy-only servers require
  server TLS upgrades or a compatible client/proxy, REQUIRE SSL can reject
  plaintext with 1045, and SSH alone does not satisfy REQUIRE SSL.
- Disabled-mode 1045/28000 with a supplied password gets a conditional REQUIRE
  SSL explanation, never a definitive diagnosis. Keep the original error and
  suggest checking SHOW GRANTS from a working administrator session.
- Preserve missing-password priority, certificate-specific hints, non-MySQL
  behavior, generic TLS hints, and existing URL/queue/authentication contracts.
- Add tests against production functions and the real connection entry point;
  mock only the remote wire-protocol boundary. No external database is required.

## Non-goals

No TLS 1.0/1.1 support, TLS backend switch, diagnostic UI, runtime dependency changes, server
account changes, deployment, auto-merge, or automatic issue closure.

Test setup may directly reference the already locked rustls dependency to
initialize the same crypto provider used by the application entry points.
