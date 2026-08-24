# Remote SQLite files are opened by an SSH worker on the file host

A remote SQLite file has no listen port, and copying it to the laptop would break shared writers (WAL/SHM). v1 therefore starts a short-lived SQLite worker on the file host over SSH (Linux amd64/arm64), and the Desktop app talks to that worker. We rejected TCP SSH tunnels, SFTP round-trip copies, a permanent agent, and user-run sqld. v1 is Desktop-only and does not support SQLCipher or loadable extensions on the remote file.

## Considered Options

- **SSH tunnel to a port** — SQLite is not a network database; the existing tunnel layer cannot open a file.
- **SFTP copy / sshfs** — Looks like a local file, but locks and WAL do not work across hosts; write-back can corrupt a live app database.
- **Permanent agent or sqld on the file host** — Correct locking, extra install and ops the user does not have today.
- **SSH ephemeral worker (chosen)** — Same locking as a process on the file host; uses SSH the user already has; costs a helper binary and SSH exec/SFTP, and fails on hosts that forbid exec or writing a cache dir.

Worker upload is a privileged action: Desktop shows the file host, destination path, and worker digest, and waits for worker consent before writing bytes. Consent is remembered only for that final-hop identity plus that digest; a new digest asks again. If the user refuses upload, connect fails unless they give a pre-placed worker path; that path must still match this DBX build's worker digest.

v1 worker budget is a hard cap, not a goal: on-disk ≤ 5 MiB, idle RSS ≤ 16 MiB, one process, idle CPU near zero, exit when the connection closes, no leftover daemon or extra services.

Worker placement is a user choice, not a hidden cache policy: persist (default dest `~/.cache/dbx/sqlite-worker/<digest>`, editable), session (delete only the file this connection uploaded; default for new connections), or pre-placed (no upload, no delete). Worker consent still applies to any upload; it is shown on the first Test or Connect that would actually upload.

v1 features on a remote SQLite file: query, object tree, table data edit, DDL, remote backup, and restore from a path on the file host. The UI must state that backup is to the remote host. Restore must not replace the live `.db` as a raw file. SQLCipher, loadable extensions, local file picker, laptop import/export, and downloading the live database are out.

Worker distribution reuses the existing GitHub/CNB/R2 + sha256 registry plumbing, not Driver Manager. Artifacts are musl-static `dbx-sqlite-worker-linux-{amd64,arm64}` on the same Desktop `v*` tag (protocol-locked digest, not `agents-v*`). The installer does not embed them. The first Test/Connect that would upload fetches the matching artifact to a laptop cache, verifies the digest baked into this build, then asks for worker consent. Pre-placed workers use the same published files; air-gapped hosts skip fetch and require a pre-placed path. SQLite worker is not listed as a JDBC/Agent driver.

In the product, this stays a SQLite connection (not a new database type). The file path is an absolute path on the final SSH hop; existing SSH hop lists are reused. The local file picker is disabled while SSH is on.
