# Oracle Data Pump (.dmp) Export & Import

DBX can drive Oracle's native Data Pump directly through the database server — no local Oracle client installation is required. The .dmp and log files are written **by the database server** into an Oracle `DIRECTORY` object, not onto the machine running DBX.

## Requirements

- An **Oracle agent connection** (the default `oracle` driver profile; `oracle-oci` also works).
- Oracle Database **11g or newer**.
- `READ` + `WRITE` privilege on the target `DIRECTORY` object:

  ```sql
  GRANT READ, WRITE ON DIRECTORY data_pump_dir TO your_user;
  ```

- Exporting or importing **another user's schema** additionally requires the `EXP_FULL_DATABASE` / `IMP_FULL_DATABASE` role.

## Exporting

1. Right-click an Oracle connection or schema in the sidebar → **Export as .dmp (Data Pump)...**
2. Pick a `DIRECTORY` object (the server-side path is shown next to it) and a dump file name.
3. Choose the mode:
   - **Schemas** — one or more schemas (comma-separated), or
   - **Tables** — one or more tables, qualify as `SCHEMA.TABLE` for other users' tables.
4. Optionally enable compression (`COMPRESSION=ALL`).
5. Start the export and watch the progress; cancel cleanly stops the server-side job (`STOP_JOB`), leaving no residual master table.

## Importing

1. Right-click → **Import from .dmp (Data Pump)...**
2. Select the `DIRECTORY` + dump file that already exists **on the server**.
3. Optionally remap the source schema onto a different target (`REMAP_SCHEMA`) and choose the table-exists action:

   | Action | Behavior |
   |---|---|
   | `SKIP` | Leave existing tables untouched (default) |
   | `REPLACE` | Drop and recreate them |
   | `TRUNCATE` | Empty them, then load |
   | `APPEND` | Keep rows, add the dumped rows |

Importing goes through the production-context guard on production-flagged connections.

## Troubleshooting

The dialog reports precise causes before and during a run:

- **DIRECTORY does not exist** — check the name in `ALL_DIRECTORIES`.
- **Missing READ/WRITE** — run the `GRANT` above (ask your DBA).
- **Cross-schema denied** — export/import your own schema, or ask for the full-export/import role.
- **Dump file already exists** — Data Pump never overwrites; pick a new file name.
- **`COMPLETED WITH ERRORS`** — shown as a warning list with the server error text; fix and rerun.

A lease protects against orphaned jobs: if the app dies mid-task, the agent stops the server-side job automatically.
