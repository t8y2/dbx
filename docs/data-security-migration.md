# DBX Data Security Upgrade and Migration

This document records the DBX Secret Store, legacy-data migration, cross-device synchronization, and startup wizard design. It is intended for users troubleshooting an upgrade and for developers maintaining the implementation.

## Upgrade behavior

New DBX releases protect connection, plugin, AI, tunnel, and synchronization secrets through the Secret Store. On the first launch after an upgrade, DBX checks the active data directory. If data still requires conversion, the **Data Security Upgrade** wizard is shown before the main application.

This is a one-time operation. After a successful migration, later launches go directly to DBX. The migration backup remains available until the user confirms that connections work and explicitly deletes it.

## Key boundaries

DBX uses two independent key systems:

| Purpose | Source | Scope | Cross-device |
| --- | --- | --- | --- |
| Local storage key | Desktop platform store, Web managed data-dir key, or `DBX_SECRET_KEY(_FILE)` | Protects Secret Store values in the local `dbx.db` | Never copied by sync |
| Sync passphrase | Entered by the user during export/import | Protects sensitive fields in an encrypted sync package | Used with that package |

Local keys are never written to a sync file. Copying `dbx.db` to another computer is not a supported cross-device migration method; use encrypted export/import instead. Local values use the `dbxenc1` envelope, AES-256-GCM, and authenticated data bound to the namespace and field name. Sync packages use a separate crypto format and passphrase.

## Supported environments

Desktop builds use the platform credential store on macOS, Windows, and Linux.

`dbx-web` uses `${DBX_DATA_DIR}/.dbx/secret.key` by default, whether it runs in Docker, under systemd, or directly from the binary. The key is created with restricted permissions only when migration starts or the first sensitive value is written. It is part of the same recovery unit as `dbx.db`; back up and restore both files together. A key stored in the data directory does not protect against disclosure of the entire data volume.

Production deployments can require an externally managed key instead:

```text
DBX_SECRET_KEY_FILE=/run/secrets/dbx_secret_key
```

`DBX_SECRET_KEY` may also be supplied by a secret manager. Explicit configuration takes precedence over the managed data-dir key and never falls back when it is unreadable or invalid. Do not replace the key across restarts or upgrades while encrypted data exists.

Web, Docker, CLI, and MCP business operations remain blocked until migration is complete. CLI and standalone MCP only inspect existing key material; they do not create keys or migrate legacy data. `DATA_MIGRATION_REQUIRED` means the same data directory must first be opened in Desktop or Web and completed through the wizard.

## Migration state machine

Storage startup is split into three phases:

```text
open_unmigrated()
  -> open SQLite and initialize required schema without migrating data
inspect_data_migration()
  -> read-only scan of database, JSON files, and key providers
start_data_migration()/retry_data_migration()
  -> backup, migrate, verify, and record the final state
```

The `data_migrations` table uses the fixed migration ID `secret-store-v1`:

- `pending`: waiting for the user or an environment fix.
- `running`: backup or migration is in progress.
- `failed`: migration failed; source data and backup remain available for retry.
- `succeeded`: migration completed; later starts go directly to DBX.
- `not_required`: no legacy data needs migration.

Scan counts have an independent source fingerprint. State transitions invalidate old scan caches so pre-migration counts cannot make a successful migration appear pending.

## Migration workflow

### Preflight and backup

Preflight returns counts, statuses, non-sensitive key-source names, and file names only. It does not return passwords, tokens, private keys, or key paths. It checks connection, plugin, AI, tunnel, sync, and legacy JSON data plus key availability. If ciphertext already exists, preflight verifies that the selected key can decrypt it; it never creates a replacement key.

Before changing data DBX creates a restricted `dbx-secret-migration-<uuid>/` directory. It contains a consistent SQLite backup and any legacy JSON files that exist. SQLite backup APIs are used so WAL state is not lost. If backup creation fails, migration does not start.

### Migration and verification

Sensitive connection, plugin, AI, tunnel, WebDAV, and source-control fields are written through the target device's Secret Store. Public configuration JSON keeps only non-sensitive fields. Database changes are transactional; if a later JSON parse, write, or verification step fails, the database backup is restored.

Legacy JSON follows an import, verify, then rename sequence. A source file is renamed to `.bak` only after successful verification. Parse failures leave the original file untouched for repair and retry.

Verification confirms that legacy plaintext columns are empty, all encrypted values can be decrypted with the current device key, public JSON contains no sensitive fields, `save_password=false` connections do not regain passwords, and legacy JSON is renamed only after success.

## Wizard and restart behavior

The wizard has three steps: **Review and confirm**, **Migrate data**, and **Complete and backup**. It explains the upgrade, creates a restricted backup, verifies the result, and provides retry, redacted diagnostics, and explicit backup cleanup.

The current session shows the completion page after a successful migration. After closing and reopening DBX, a `succeeded` or `not_required` state goes directly to the main application. Keeping a backup does not block later starts. The wizard includes a language selector for all currently supported locales.

## Cross-device synchronization

Cross-device sync never copies DPAPI, Keychain, Secret Service, or a local DEK. A Windows-to-Mac flow is:

1. Read secrets from the source device's local Secret Store.
2. Separate public configuration from sensitive payload.
3. Derive a transport key from the user-provided sync passphrase using Argon2id.
4. Encrypt the sensitive payload with AES-256-GCM.
5. Decrypt it on the destination device with the same passphrase.
6. Re-encrypt each secret with the destination device's local Secret Store.

Import can restore metadata only or restore secrets as well. Wrong passphrases, ID conflicts, and field failures do not commit a partial import.

## Compatibility and recovery

- New users perform only a lightweight scan and receive no migration backup.
- Older databases and JSON files can be upgraded without installing an intermediate version.
- Older sync package versions remain readable according to their compatibility rules.
- Failed migrations keep the original data and backup and can be retried.
- Successful migration backups remain until the user explicitly cleans them up.
- Direct `dbx.db` copying is not a supported cross-platform migration path.

## Troubleshooting

### The wizard appears again

Confirm that the installed build includes the migration-cache fix. Export the redacted diagnostic and inspect `state`, `needsMigration`, `errorCode`, `backupPath`, and `counts`. If the state is `succeeded` but counts still show legacy values, the next status scan invalidates the stale cache.

### Key unavailable

Allow DBX Desktop to access the platform credential store. For Web/Docker, confirm that `${DBX_DATA_DIR}/.dbx/secret.key` is present with the data volume, or that an explicitly configured `DBX_SECRET_KEY_FILE` is readable. Do not delete or replace the key used to encrypt an existing database.

### Migration failed

The source data is retained. Fix the issue shown by the wizard and choose **Retry migration**. Export only the redacted diagnostic; do not upload `dbx.db`, WAL files, or migration backup directories.

## Implementation map

| Module | Responsibility |
| --- | --- |
| `crates/dbx-core/src/persistence/secret_codec.rs` | Local encryption, key providers, and key parsing |
| `crates/dbx-core/src/persistence/storage.rs` | Migration state, preflight, backup, migration, and verification |
| `crates/dbx-core/src/persistence/cloud_sync.rs` | Encrypted cross-device export/import |
| `src-tauri/src/migration_gate.rs` | Desktop business-command gate |
| `crates/dbx-web/src/routes/migration.rs` | Web/Docker migration API |
| `crates/dbx-web/src/main.rs` | Web migration gate |
| `apps/desktop/src/StartupGate.vue` | Desktop startup routing and blocking |
| `apps/desktop/src/components/migration/SecurityMigrationWizard.vue` | Wizard UI, locale switch, and diagnostics |
| `apps/desktop/src/stores/migrationStore.ts` | Wizard state and action orchestration |

## Testing and acceptance

Migration frontend tests cover successful restart behavior, migration failure and retry, status failures, backup cleanup failures, diagnostic export fallback, and locale resources.

Recommended checks:

```bash
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
pnpm exec vitest run apps/desktop/src/stores/migrationStore.spec.ts apps/desktop/src/components/migration/SecurityMigrationWizard.spec.ts
git diff --check
```

Rust tests should cover authenticated encryption, migration-cache invalidation, transaction rollback, JSON rename ordering, safe backup cleanup, and Tauri/Web startup gates. Manual smoke testing should include macOS, Windows, Linux, Docker restarts with a fixed key, failed migrations, and Windows-to-Mac encrypted sync.

## Maintenance policy

The wizard UI may be reduced in later releases, but the `secret-store-v1` engine, legacy schema detection, old ciphertext reading, old sync-package compatibility, and failure recovery must remain. Users may upgrade directly from a much older release.
