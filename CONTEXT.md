# DBX

DBX is a multi-database client. This glossary is the ubiquitous language for SQLite access; it is not a spec.

## SQLite access

**Local SQLite file**:
A SQLite database file that the DBX backend opens with rusqlite on the same machine that runs dbx-core.
_Avoid_: SQLite host, SQLite server

**Remote SQLite file**:
A SQLite database file whose bytes live on a different machine than the DBX backend. SQLite has no listen port, so this is not a TCP connection to SQLite.
_Avoid_: remote SQLite, SQLite over SSH tunnel, networked SQLite

**File host**:
The machine that must `open()` the remote SQLite file so POSIX locking and WAL interact correctly with other processes on that machine.
_Avoid_: SSH host, database host, bastion

**SQLite-compatible server**:
An HTTP service that speaks a SQLite-like protocol (Turso/libsql, rqlite, Cloudflare D1). Already supported; not a remote SQLite file.
_Avoid_: remote SQLite file, hosted SQLite file

**Shared writer**:
Another process on the file host may have the same SQLite file open while DBX is connected. DBX must not copy the file to another machine and write it back.

**SSH tunnel**:
Existing DBX transport: TCP port forwarding through SSH for network databases. It does not open a SQLite file.
_Avoid_: SSH file access, SQLite SSH

**SQLite worker**:
A short-lived process DBX starts on the file host via SSH. It opens the remote SQLite file with rusqlite. It is not a tunnel, not sqld, and not a permanent agent.
_Avoid_: SSH tunnel, SQLite agent, sqlite3 CLI

**Worker upload**:
Copying the SQLite worker executable onto the file host. This is a privileged, sensitive action. DBX must not do it silently.
_Avoid_: deploy agent, install binary, scp helper

**Worker consent**:
The user's explicit agreement to a worker upload. It names the file host, the destination path, and the worker digest. Remembered only for that final-hop identity plus that digest. A new digest requires a new agreement.
_Avoid_: SSH host-key trust, blanket permission

**Pre-placed worker**:
A SQLite worker binary already on the file host, referenced by an explicit filesystem path. DBX executes it and does not upload. v1 still requires that path to be the worker this DBX build ships (same digest).
_Avoid_: custom agent, arbitrary remote executable, system sqlite3

**Worker artifact**:
The official musl-static Linux binary (`amd64` / `arm64`) for the SQLite worker, published on the same Desktop `v*` tag through the existing GitHub/CNB/R2 mirrors and sha256 registry. It is not a JDBC/Agent driver and does not appear in Driver Manager.
_Avoid_: SQLite agent, SQLite driver, agents-v independent release

**Worker fetch**:
Copying that artifact onto the laptop (local cache) the first time a Test/Connect would upload, then verifying it against the digest baked into this DBX build. Fetch is not worker upload; upload still requires worker consent.
_Avoid_: driver install, silent scp, Driver Manager install

**Worker placement**:
How the SQLite worker binary exists on the file host. The user chooses one: persist (leave it after disconnect; default dest `~/.cache/dbx/sqlite-worker/<digest>`, editable), session (delete only the file this connection uploaded when it closes; default for new connections), or pre-placed (user uploaded it; DBX never writes or deletes it).
_Avoid_: agent install, silent cache, delete the digest-keyed persistent file

**Remote backup**:
A SQLite backup written as a new file on the file host. The UI must say it is a backup to the remote host. It is not a download of the live `.db` to the laptop.
_Avoid_: local backup, save database as, SFTP download

**Remote restore**:
Load from a SQLite file path on the file host into the currently open remote database. v1 does not import from the laptop. The live `.db` is not replaced as a raw file while shared writers may exist.
_Avoid_: local restore, open backup on laptop, overwrite the live file

**Worker budget (v1)**:
Hard caps for the SQLite worker: on-disk size ≤ 5 MiB, idle RSS ≤ 16 MiB, one process, idle CPU near zero, process exits when the connection closes. No leftover daemon or extra services.
_Avoid_: sidecar, resident agent

**Remote SQLite path**:
An absolute filesystem path to a SQLite file on the final SSH hop. It is entered as text, not via the local file picker.
_Avoid_: local file path, UNC path, sshfs mount

**Final SSH hop**:
The last machine in the SSH hop list. The SQLite worker runs there; the file path is a filesystem path on that machine, not on a bastion.
_Avoid_: SSH host, tunnel target
