# Background Database Backups

DBX schedules MySQL and PostgreSQL SQL backups in a shared Rust worker. The
desktop window and browser display persisted state; neither needs to keep a
JavaScript timer alive. Backup options, table filters, gzip compression,
per-database snapshots, cancellation, and successful-run retention also apply
to background runs.

## Desktop

Open **Settings > Database Backup**. Enable **Background backups after closing
DBX** to continue after quitting the application. Without this option, closing
DBX stops its worker and cancels any active backup. With it enabled, an active
backup continues in the same independent process after the window closes.

| Platform | Automatic startup | Default lifetime |
| --- | --- | --- |
| Windows | Per-user Task Scheduler task `dbx-backup-<data-directory hash>` | While the user is signed in |
| macOS | `~/Library/LaunchAgents/app.dbx.dbx-backup-<hash>.plist` | While the user is signed in |
| Linux | `systemd --user` unit `dbx-backup-<hash>.service` | While the user manager is running |

No administrator service is installed automatically. A powered-off or sleeping
computer cannot run backups. Login agents are not a promise of execution after
logout. On Linux, administrators can enable lingering for the service account
with `loginctl enable-linger USER`. For unattended hosts, the Web/container
deployment is usually simpler than keeping a desktop login session alive.

The background toggle removes automatic startup when disabled. Disable it before
uninstalling DBX or moving a portable executable. Opening DBX again refreshes the
registered executable path. Existing backup SQL files are never removed by
disabling the worker or deleting a schedule.

For a custom process supervisor (including non-systemd Linux), the installed
desktop executable has a headless entrypoint:

```text
dbx --backup-worker --data-dir /absolute/path/to/existing/dbx-data
```

Windows PowerShell example:

```powershell
& 'G:\Applications\DBX\dbx.exe' --backup-worker --data-dir 'G:\DBX-data'
```

Use the existing data directory containing `dbx.db`, and the same account that
saved the connections. The headless entrypoint does not initialize a WebView or
open an HTTP port. Run one supervised worker per data directory; a filesystem
lock also prevents an overlapping desktop/helper instance from executing the
same queue. Do not place the SQLite state database on a network filesystem or
share it between independent hosts as a high-availability scheduler.

## Web And Containers

The `dbx-web` process executes schedules whether browsers are connected or not.
In **Settings > Database Backup**, destinations are server paths, not paths on
the browser's computer. `DBX_BACKUP_ROOT` restricts all destinations to a
server-owned directory. Without this variable, standalone Web uses
`DBX_DATA_DIR/backups`. The Docker image uses `/app/backups`.

Persist both application data and backup output:

```yaml
services:
  dbx:
    image: t8y2/dbx:latest
    ports:
      - "4224:4224"
    environment:
      DBX_BACKUP_ROOT: /app/backups
    volumes:
      - dbx-data:/app/data
      - dbx-backups:/app/backups
    restart: unless-stopped
    stop_grace_period: 90s

volumes:
  dbx-data:
  dbx-backups:
```

Create any additional destination subdirectories inside the mounted root on the
server before selecting them. The root must be writable by the DBX service
account. Keep Web authentication enabled. Download and restore operations use
the same authenticated session as other DBX APIs. Restoration copies the chosen
backup into DBX's temporary SQL-file workspace and then uses the existing SQL
execution confirmation dialog; it does not modify the retained backup.

Use a single container replica for each data volume. Container restart and
browser refresh do not erase schedules. SIGTERM requests cancellation and
persists the outcome before shutdown; allow the configured grace period.

## Timing, Credentials, And Recovery

- Each schedule stores an IANA time zone. Legacy desktop schedules migrate with
  the browser's current zone, retaining the old storage keys as a fallback.
- Hourly schedules use elapsed time. Daily and weekly schedules use the saved
  zone. A repeated autumn time runs once at its first occurrence; a missing
  spring-forward time runs at the first valid minute after the gap.
- After downtime, one catch-up job is queued, rather than replaying every missed
  interval. An already active schedule is never queued again.
- Only connection IDs are stored in backup plans. Every job reloads saved
  credentials from the existing connection store and uses separate connection
  pools. Temporary connections and unsaved passwords cannot run unattended.
  SSH keys, certificates, tunnels, and destination volumes must be available to
  the worker's account without an interactive prompt.
- On an unclean worker exit, queued jobs remain queued. In-progress jobs become
  failed with an interruption message. Files recorded before the interruption
  remain visible as potentially incomplete; they are not reported as successful.
- Retention deletes only recorded files of older successful runs of that plan.
  Failed runs remain available for diagnosis and manual cleanup. Custom filename
  collisions fail instead of overwriting an earlier backup.
- State lives in `database-backups/state.db` alongside `dbx.db`. Back up both
  databases together with the connection store when migrating a DBX instance.
- Headless worker warnings are recorded in `database-backups/worker.log`.
  Files whose creation could not be confirmed after a crash require manual
  inspection before deletion; DBX does not delete an unverified file automatically.

## Verification

```text
cargo test -p dbx-core --no-default-features --features sqlite-bundled --lib scheduled_backup
pnpm exec vitest run apps/desktop/src/composables/__tests__/useScheduledDatabaseBackups.spec.ts apps/desktop/src/components/backup/__tests__/ScheduledDatabaseBackupSettings.spec.ts apps/desktop/src/lib/__tests__/backup/scheduledDatabaseBackup.spec.ts
```

The ignored MySQL integration test uses `DBX_LIVE_SQL_FILE_MYSQL_HOST`, `PORT`,
`USER`, and `PASSWORD` environment variables. It creates a UUID-named test
database, exercises a saved connection, filtered gzip backups and retention, and
drops only that test database afterward. Enable it explicitly with
`-- --include-ignored` on a disposable/local endpoint.
