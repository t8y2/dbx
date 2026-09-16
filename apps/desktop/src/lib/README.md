# Desktop Library Layout

`src/lib` is organized by product/runtime domain. Keep implementation modules inside a domain folder instead of adding new files at the root.

- `backend`: Tauri, HTTP, platform, storage, and transport bridges.
- `common`: generic helpers with no DBX feature ownership.
- `app`, `tabs`, `sidebar`, `connection`: shell, navigation, and connection UI state helpers.
- `database`, `metadata`, `schema`, `table`: relational database metadata, capabilities, DDL, and table-object helpers.
- `sql`, `sql/semantic`, `editor`, `query`, `history`, `savedSql`: SQL editing, execution, diagnostics, history, and saved SQL behavior.
  Keep fixed SQL completion statements and their database-specific variants in `sql/sqlSnippetTemplates.ts`; cross-check row-limiting families against `crates/dbx-core/src/sql_dialect/capabilities.rs` and authoritative dialect documentation, and never replace a user-customized built-in body with a generated default.
- `dataGrid`: result/grid rendering, editing, previews, pagination, and export helpers tied to the grid.
- `ai`, `mcp`: AI assistant and MCP configuration helpers.
- `redis`, `mongo`, `elasticsearch`, `etcd`, `kv`, `mq`, `nacos`, `zookeeper`, `webdav`: non-relational or service-specific helpers.
- `diagram`, `document`, `export`, `imports`: feature-specific utilities that are shared by more than one component.

Tests under `src/lib/__tests__` mirror the same domain folders. When moving a module, update both runtime imports and colocated tests so stale root-level aliases do not return.

## Schema Diff Metadata Guardrails

Schema comparison must filter disabled object types before loading metadata. Tables load columns and the relational metadata enabled by the compare options; views load DDL only.

Do not call column, index, foreign-key, or trigger metadata APIs for views. MySQL 5.7 can validate a `SQL SECURITY DEFINER` view during column discovery and return error 1143 when its definer account no longer exists, even though `SHOW CREATE VIEW` still succeeds. Keep view detection centralized in `schema/schemaDiffTableFilter.ts` and preserve the DDL-only plan in `schema/schemaDiffMetadataLoad.ts`.

Regression coverage belongs in:

- `src/lib/__tests__/schema/schemaDiffTableFilter.spec.ts`
- `src/lib/__tests__/schema/schemaDiffMetadataLoad.spec.ts`

## Schema Diff Deployment Safety

Schema Diff review and execution must preserve these invariants:

- Review groups preserve the original top-level object hierarchy. A modified table with dropped or rebuilt indexes, columns, foreign keys, or triggers appears once in the delete group at table level, while final SQL review lists the exact destructive operations.
- A table and its nested differences are one selection unit because the backend returns one aggregated `syncSql` block per table. Clearing a nested object must clear the table so hidden sibling DDL cannot execute.
- Final deploy SQL is scanned again after user edits. Any `DROP`, `TRUNCATE`, or `ALTER ... DROP` operation must be listed in the final confirmation.
- The core deploy endpoint rejects destructive Schema Diff SQL unless the request carries explicit destructive confirmation. UI classification is never the only safety boundary.

Regression coverage belongs in:

- `packages/app-tests/schemaDiff.test.ts`
- `crates/dbx-core/src/query.rs`
- `src-tauri/src/commands/query.rs`
