# Desktop Library Layout

`src/lib` is organized by product/runtime domain. Keep implementation modules inside a domain folder instead of adding new files at the root.

- `backend`: Tauri, HTTP, platform, storage, and transport bridges.
- `common`: generic helpers with no DBX feature ownership.
- `app`, `tabs`, `sidebar`, `connection`: shell, navigation, and connection UI state helpers.
- `database`, `metadata`, `schema`, `table`: relational database metadata, capabilities, DDL, and table-object helpers.
- `sql`, `sql/semantic`, `editor`, `query`, `history`, `savedSql`: SQL editing, execution, diagnostics, history, and saved SQL behavior.
- `dataGrid`: result/grid rendering, editing, previews, pagination, and export helpers tied to the grid.
- `ai`, `mcp`: AI assistant and MCP configuration helpers.
- `redis`, `mongo`, `elasticsearch`, `etcd`, `kv`, `mq`, `nacos`, `zookeeper`, `webdav`: non-relational or service-specific helpers.
- `diagram`, `document`, `export`, `imports`: feature-specific utilities that are shared by more than one component.

Tests under `src/lib/__tests__` mirror the same domain folders. When moving a module, update both runtime imports and colocated tests so stale root-level aliases do not return.
