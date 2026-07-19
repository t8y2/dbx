# DBX Database Test Environments

This directory contains reproducible Docker Compose environments for manual database verification. Each versioned recipe uses a pinned image, a named volume, a loopback-only port binding, a health check, and initialization data or smoke data created during verification.

Run commands from the repository root:

```bash
make db-list
make db DB=mysql@8.4
make db-verify DB=postgresql@17.4
make db-down DB=postgresql@17.4
```

Every network recipe uses the standard database port plus one on the host. The default password is `123456`, and the default database is `dbx`; Redis uses DB 0 and the `dbx:` key prefix. Container names follow `dbx-<product>-<version>`. Versions of the same database share the default host port, so use `DB_PORT` when running them concurrently. `DB_PORT` and `DB_PASSWORD` override the default host port and password. Ports bind to `127.0.0.1` by default. To allow remote access explicitly, set `DB_BIND_ADDRESS=0.0.0.0`, choose a strong `DB_PASSWORD`, and protect the host with firewall rules. `make db-reset` deletes the named volume and therefore requires `CONFIRM=1`:

```bash
make db-reset DB=redis@7.4 CONFIRM=1
```

The primary Make targets are `db-list`, `db`, `db-verify`, `db-down`, `db-reset`, and `db-check`. Run `make db` to print one copyable start command for every recipe. `make db-completion` prints Bash, Zsh, and PowerShell completion setup; the scripts in `completion/` dynamically complete recipe selectors. The targets avoid POSIX-shell conditionals and work with GNU Make in PowerShell, Git Bash, or WSL. For diagnosis, use the lower-level `pnpm db:env -- info|status|logs|shell <product> <version>` commands.

## Recipe layout

```text
<product>/<version>/
├── recipe.json   # connection fields and smoke commands
├── compose.yaml  # Docker Compose environment
└── init/         # data initialized with the environment
```

Redis does not support the image initialization-directory convention; its `init/README.md` documents the smoke key that `verify` creates and reads. Run `make db-check` after adding or editing a recipe. It verifies the recipe structure and standardized container name, then asks Docker Compose to validate each Compose file.
