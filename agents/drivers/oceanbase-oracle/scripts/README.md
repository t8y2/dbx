# OceanBase Oracle partition DDL verification

Build with JDK 21 from the repository root:

```sh
./agents/gradlew -p agents :common:test :oceanbase-oracle:test :oceanbase-oracle:shadowJar
```

Set `OB_HOST`, `OB_PORT` (default 2881), `OB_TENANT`, and `OB_PASSWORD` in your environment. `OB_PASSWORD` is the SYS password for a **disposable Oracle tenant**. Then run:

```sh
pnpm exec tsx --tsconfig apps/desktop/tsconfig.json agents/drivers/oceanbase-oracle/scripts/verify-partition-ddl.ts
```

The script starts the built agent over JSON-RPC, creates three isolated `DBX7055_` schemas, and replays eight tables into two of them: once with storage options omitted and once with full DDL. It checks partition and subpartition counts, keys and bounds, column metadata, defaults, comments, LOCAL indexes, and primary/check/foreign-key enforcement. It also covers quoted identifiers and a global temporary table whose internal session index must not be exported.

DDL files and `verification.json` are written under `agents/drivers/oceanbase-oracle/build/partition-ddl-evidence` (override with `OB_TEST_OUTPUT`). Schemas are intentionally retained for manual DBX inspection; their exact names are printed in the report. Remove only those test schemas with `DROP USER "<reported name>" CASCADE` after disconnecting their sessions. No credentials are written to evidence files.

## UI verification

Install the built agent as described in the root CONTRIBUTING.md and use the current frontend. Expand a partitioned table's Partitions and Subpartitions groups. Open its DDL and check that **Omit storage attributes** is enabled by default. Copy and export the script, turn the switch off, and repeat. Partition clauses, constraints, LOCAL indexes, defaults and comments must remain in both outputs. Changing the option does not re-fetch or overwrite the cached original. In the structure editor the switch is disabled while DDL has unsaved edits.

The preference applies only to OceanBase Oracle and removes these known table options: `COMPRESS FOR ARCHIVE [HIGH|LOW]`, `NOCOMPRESS`, `REPLICA_NUM`, `BLOCK_SIZE`, `TABLET_SIZE`, `PCTFREE`, and `USE_BLOOM_FILTER`. Unknown options and partition clauses are preserved.

## Verified environment

The script passed against OceanBase 4.2.5.7 in Oracle mode, with RANGE, LIST, HASH and RANGE/LIST tables, compound partition keys, constraints, defaults/comments and temporary tables. It uses `DBMS_METADATA.GET_DDL` supported by the [OceanBase 4.2.5 documentation](https://www.oceanbase.com/docs/common-oceanbase-database-cn-1000000001503693). Separate native index DDL and comments are appended because this version's TABLE result omits them.
