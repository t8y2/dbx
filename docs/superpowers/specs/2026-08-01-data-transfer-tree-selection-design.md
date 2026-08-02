# Data Transfer: Tree Object Selection and Transfer Modes Design

Date: 2026-08-01

## Summary

The data transfer dialog (`apps/desktop/src/components/transfer/DataTransferDialog.vue`) currently lets the user pick tables from a flat checkbox list and copy table **data** between connections. Non-table objects (views, stored procedures, functions, triggers, sequences, events) are only copied for PostgreSQL→PostgreSQL transfers, and then only as an all-or-nothing schema sweep performed after the table data copy.

This change turns the table picker into a tree that groups selectable objects by type (tables, views, stored procedures, functions, triggers, sequences, events), and adds an explicit transfer mode: **structure and data** (default), **structure only**, and **data only**. Non-table object DDL copying is implemented for PostgreSQL and PG-family databases (Kingbase, GaussDB, KWDB, OpenGauss), MySQL, Dameng, and Oracle. Cross-database-family object DDL copy is out of scope for the first version.

## Goals

- Select transfer content via a tree grouped by object type, with per-group select-all and object-level checkboxes.
- Support three transfer modes: structure and data, structure only, data only.
- Copy non-table object DDL for PostgreSQL/PG-family, MySQL, Dameng, and Oracle, within the same database family.
- Skip objects that already exist on the target side (by name), and report the skip count on completion.
- Preserve the existing table data transfer behavior (append/overwrite/upsert write modes, FK dependency ordering, ownership preview, target-table-name case handling).

## Non-goals

- Cross-family non-table object DDL transfer (e.g., MySQL view → PostgreSQL view). The tree disables non-table groups with a hint in that case.
- Object transfer for databases outside the supported family set (SQLite, ClickHouse, SQL Server, MongoDB, Hive, Spark, etc.).
- Editing object DDL inside the transfer dialog (users use the object source editor for that).
- Differential/sync behavior beyond "skip existing" (no replacement of changed objects).

## Existing Design to Reuse

- `crates/dbx-core/src/transfer.rs` — table data transfer core: `TransferRequest`, `transfer_table`, FK dependency sorting (`sort_tables_by_fk_dependency`), progress reporting (`TransferProgress`), DDL generation (`generate_create_table_ddl`), column type mapping (`map_column_type`).
- `crates/dbx-core/src/transfer.rs:5020` — `transfer_postgres_schema_objects`: existing PostgreSQL schema object DDL copy (views, materialized views, procedures, functions, sequences, triggers, types, packages, synonyms + ownership/grants/policies). Reused and extended with per-object selection filtering.
- `crates/dbx-core/src/object_source_sql.rs` — `build_executable_object_source_statements`, `ObjectSourceKind`, `EditableObjectSourceSqlInput`: per-database object source DDL machinery (already used by the PG object transfer).
- `crates/dbx-web/src/routes/transfer.rs` — transfer orchestration route, progress channel, per-object failure handling.
- `apps/desktop/src/lib/backend/api.ts` — `listObjects(connectionId, database, schema, objectTypes?, filter?, limit?, offset?, catalog?)` returning `ObjectInfo[]`; `TransferRequest` types.
- `apps/desktop/src/lib/database/databaseObjectCapabilities.ts` — per-database sidebar object kind lists.

## Design

### 1. Backend protocol (`crates/dbx-core/src/transfer.rs`, `crates/dbx-web/src/routes/transfer.rs`)

Extend `TransferRequest`:

```rust
#[serde(rename_all = "camelCase")]
pub enum TransferContent {
    #[default]
    StructureAndData,
    StructureOnly,
    DataOnly,
}

#[serde(rename_all = "SCREAMING_SNAKE_CASE")]  // matches SidebarObjectKind conventions
pub enum TransferObjectKind {
    Table, View, MaterializedView, Procedure, Function, Trigger, Sequence, Event,
}

pub struct TransferObjectSelection {
    pub object_type: TransferObjectKind,
    pub names: Vec<String>,
}
```

New fields on `TransferRequest`:

- `content: TransferContent` — defaults to `StructureAndData`. Replaces the `create_table` boolean (`create_table == (content != DataOnly)`); the field is kept for wire compatibility but the frontend stops sending it.
- `objects: Vec<TransferObjectSelection>` — non-table object selections. The table selection stays in the existing `tables: Vec<String>` field (also mirrored as a `TransferObjectKind::Table` entry when the tree sends it).

Validation (in the route, before transfer starts):

- `DataOnly` with non-empty `objects` → error "仅数据模式不传输非表对象".
- `StructureOnly` with empty `tables` and empty `objects` → error (nothing to do).
- Non-table objects are rejected when source and target database families differ (see family rules below).
- Non-table object names are validated like table names (non-empty, no NUL bytes).

`TransferMode` (append/overwrite/upsert) is unchanged; it only takes effect when the content includes data (`StructureAndData` or `DataOnly`).

### 2. Database family rules

| Family | Database types | Non-table object DDL support |
|---|---|---|
| mysql | mysql | yes (views, procedures, functions, triggers, events) |
| postgres | postgres, kingbase, gaussdb, kwdb, opengauss | yes |
| oracle | oracle, dameng, oceanbase-oracle | yes (views, procedures, functions, triggers, sequences) |
| other | everything else | no — tree groups disabled, backend rejects |

`is_same_transfer_family(source, target)` — a new pure function in `transfer.rs`, unit-tested. Cross-family transfers keep table data copy working exactly as today, with non-table groups disabled in the UI.

Object type availability per family (drives which tree groups render):

| Object kind | mysql | postgres family | oracle/dameng |
|---|---|---|---|
| TABLE | ✓ | ✓ | ✓ |
| VIEW | ✓ | ✓ | ✓ |
| MATERIALIZED_VIEW | ✗ | ✓ | ✓ |
| PROCEDURE | ✓ | ✓ | ✓ |
| FUNCTION | ✓ | ✓ | ✓ |
| TRIGGER | ✓ | ✓ | ✓ |
| SEQUENCE | ✗ (MariaDB only, first version: no) | ✓ | ✓ |
| EVENT | ✓ | ✗ | ✗ |

### 3. Object listing (backend)

Extend the existing `listObjects` path (per-database object listing in `crates/dbx-core/src/schema.rs` and the agent-side listing) so the transfer tree can fetch objects grouped by type:

- **PostgreSQL family**: already supported kinds (TABLE, VIEW, MATERIALIZED_VIEW, PROCEDURE, FUNCTION, SEQUENCE) via `pg_catalog`; add TRIGGER listing (`pg_trigger` join `pg_class`/`pg_namespace`, names of triggers in the schema).
- **MySQL**: add TRIGGER (`information_schema.TRIGGERS` filtered by `EVENT_OBJECT_SCHEMA`) and EVENT (`information_schema.EVENTS`); VIEW/PROCEDURE/FUNCTION listing already exists.
- **Oracle/Dameng**: add TRIGGER and SEQUENCE (`ALL_OBJECTS` filtered by `OBJECT_TYPE`); VIEW/PROCEDURE/FUNCTION listing already exists (Dameng already has `SYS.SYSOBJECTS`-based listing).

The `Event` kind is transfer-only: it is added to the backend `ObjectSourceKind`/listing mapping but not to the sidebar object capability lists (the sidebar does not gain new node types in this change).

### 4. Non-table object DDL copy (backend)

New `transfer_objects` flow in `crates/dbx-core/src/transfer.rs`, invoked from the route after table data transfer and after the existing PG schema-dependency step. Execution order:

1. tables (existing flow, FK sorted)
2. sequences
3. views, materialized views
4. functions
5. procedures
6. triggers
7. events

DDL fetching per family:

- **PostgreSQL family**: reuse `get_postgres_schema_object_sources_for_transfer` + `get_postgres_materialized_view_sources_for_transfer` + new `get_postgres_trigger_sources_for_transfer`-style queries, filtered by the selected names. Existing schema rewrite (`rewrite_postgres_routine_schema`) and `build_executable_object_source_statements` apply. The current "transfer everything in the schema" behavior becomes "transfer only selected objects"; when the request carries no object selection the step is skipped entirely (no behavior surprise for table-only transfers).
- **MySQL**: VIEW/PROCEDURE/FUNCTION DDL via `SHOW CREATE` (existing `mysql_object_source_sql`); TRIGGER DDL assembled from `information_schema.TRIGGERS` (`CREATE TRIGGER` with ACTION_TIMING/EVENT_MANIPULATION/EVENT_OBJECT_TABLE/ACTION_STATEMENT — the per-table trigger query at `crates/dbx-core/src/db/mysql.rs:4239` is the basis); EVENT DDL assembled from `information_schema.EVENTS`; strip `DEFINER=` clauses; rewrite the schema qualifier from source schema to target schema when they differ.
- **Oracle/Dameng**: fetch DDL via `DBMS_METADATA.GET_DDL('<TYPE>', '<name>')` (the existing object-source machinery already implements per-type metadata DDL for these databases; reuse those code paths where possible); rewrite schema qualifiers; execute per statement.

Target-side existence check, per object, immediately before executing its DDL:

- **PostgreSQL family**: `SELECT 1 FROM pg_class/pg_proc ...` by schema+name.
- **MySQL**: `information_schema` lookups (VIEWS, ROUTINES, TRIGGERS, EVENTS).
- **Oracle/Dameng**: `ALL_OBJECTS` (or `SYS.SYSOBJECTS` for Dameng) by schema+name.

Existing objects are skipped and counted; the count is included in the final summary progress message ("skipped N existing objects"). Failed objects follow the existing pattern: recorded in the failure list, transfer continues, final status reflects the failures.

Progress: reuse `TransferProgress` with `table = "schema object: <name>"` (already the convention used by the PG object transfer). The `DataOnly` mode skips the whole object-DDL step.

### 5. Frontend (`apps/desktop/src/components/transfer/DataTransferDialog.vue`)

- Replace the flat table list with a tree:
  - Top-level groups rendered from the source database family capability table (tables, views, materialized views, procedures, functions, triggers, sequences, events as applicable).
  - Group header checkbox = select all / clear group; per-object checkboxes; expand/collapse per group; a search filter box filters object names across groups.
  - Groups that cannot be transferred (cross-family, unsupported kind, or `DataOnly` mode) are rendered disabled with a tooltip explaining why.
  - Table selection stays in `tables`; non-table selections serialize into `objects`.
- Transfer mode selector: 结构和数据 / 仅结构 / 仅数据 (i18n keys in the `transfer.*` namespace).
  - `DataOnly`: non-table groups disabled ("仅数据模式不传输非表对象"); table group enabled.
  - `StructureOnly`: data write mode (append/overwrite/upsert) selector hidden/disabled; ownership preview and target-table-name case options only apply when data is copied (ownership preview only relevant with `StructureAndData`; keep the existing behavior for that mode).
  - The `createTable` checkbox is removed.
- Load object lists per group from `listObjects` with the per-kind object type filter; loading states per group; error states surface inline.

### 6. Error handling

- Validation errors from the route are shown inline in the dialog (existing error display pattern).
- Per-object DDL failures: existing `failed_tables` mechanism extended to carry object entries; final status `Error` with the failure list, transfer continues for remaining objects.
- Cancellation: existing `transfer_id` cancellation checks are threaded through the object-DDL loop (mirroring the PG object transfer loop).

### 7. Testing

Backend unit tests (`crates/dbx-core/src/transfer.rs` test module + `crates/dbx-core/tests/live_postgres_transfer.rs`):

- `is_same_transfer_family` matrix.
- Request validation (DataOnly + objects, cross-family objects).
- Per-family object DDL statement generation (MySQL `SHOW CREATE` handling with DEFINER stripping; schema rewriting).
- Target existence check SQL per family.
- Live PG transfer: object filtering by selection, skip-existing behavior, `StructureOnly` (no data rows copied), `DataOnly` (no DDL executed).

Frontend tests (`apps/desktop/src/components/transfer/__tests__/`):

- Tree group rendering per database family.
- Group select-all, object toggle, search filtering.
- Disable rules: `DataOnly` mode, cross-family, unsupported kinds.
- Request serialization (`tables` + `objects` + `content`).
