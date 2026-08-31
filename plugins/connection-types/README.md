# Connection type descriptors

`plugins/connection-types/*.yaml` is the source of truth for DBX connection type registration. It covers SQL databases, document and vector stores, key-value and configuration services, message queues, MQTT brokers, and generic JDBC targets. `profiles/catalog.yaml` contains the frontend connection-picker profiles that bind product names and defaults to those stable connection types.

Each descriptor defines the stable `dbType` ID, generated Rust variant, display label, runtime and MCP modes, Agent driver mapping, connection defaults, optional SQL dialect binding, connection form kind, and product capabilities. `dbType` and `DatabaseType` retain their historical names for serialized API compatibility even though some targets are not databases. SQL syntax, DDL templates, type catalogs, and metadata-query details remain in `plugins/dialects/*.yaml`.

Connection types may contain multiple runtime profiles when they share the same DBX connection model and management surface. For example, Kafka, RocketMQ, and RabbitMQ are profiles of `mq.yaml`; MQTT remains a separate connection type because it has a different protocol, configuration model, and UI workflow.

Set `specializedSurface: true` only when the product uses a dedicated management surface that is not represented by the shared capability matrix. Otherwise at least one product capability must be enabled.

Driver store entries also declare their stable display order in YAML. Use `driverStoreOrder` for the descriptor's primary Agent and `storeOrder` for visible profiles or managed drivers. Orders must be positive and unique across effective driver keys.

Normal Vite development/build, frontend typecheck, and frontend tests regenerate derived files automatically. The explicit command remains available for troubleshooting or refreshing generated files without starting another tool:

```bash
pnpm generate:connection-types
```

The generator updates these derived files:

- `crates/dbx-core/assets/database-drivers.manifest.json`
- `apps/desktop/src/types/generated/databaseTypes.ts`
- `apps/desktop/src/types/generated/connectionProfiles.ts`

Cargo reads the same YAML descriptors in `crates/dbx-core/build.rs` to generate `DatabaseType` and the embedded Rust manifest. Do not edit the generated JSON or TypeScript type list directly.

`pnpm generate:connection-types` validates the YAML and rewrites the committed JSON and TypeScript derivatives. Vite also watches the descriptor directory during development and regenerates after YAML changes. `pnpm check:connection-types` performs the same validation without modifying files, and `pnpm check` runs that read-only check automatically in CI so stale committed derivatives still fail verification.

A compatible product profile usually needs only a catalog entry and icon. A connection type still needs code when its protocol, authentication, connection fields, metadata provider, query executor, or UI workflow differs from an existing implementation. `formKind` selects a finite coded connection form; it is not an arbitrary YAML form engine. Protocol-compatible products should bind to an existing dialect and reuse the nearest connector or Agent before introducing another independent implementation.
