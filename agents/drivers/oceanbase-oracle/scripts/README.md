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

## Sequence, synonym and DBLink verification (#2549)

`verify-schema-objects.ts` is a separate integration check. The partition result above is not evidence that this new check has passed. It uses the built agent over JSON-RPC and the frontend's production DBLink SQL builder. It creates two uniquely named `DBX2549_` users, checks sequence/synonym discovery and source, replays and changes a synonym target, and creates, lists, tests and explicitly removes an OB DBLink. OceanBase 4.2.5 exposes links created with `CREATE DATABASE LINK` tenant-wide and reports them as `OWNER=PUBLIC`; the script verifies that a second user can list, test and use the link but cannot manage it through `USER_DB_LINKS`. It verifies that reading sequence DDL does not consume a value, and that changing sequence options with `ALTER SEQUENCE` does not restart the counter. The Rust source-to-edit-SQL transformation has separate unit tests; this script does not invoke the Rust application backend.

Use only an explicitly disposable Oracle tenant. In addition to the environment variables above, set `OB_TEST_DISPOSABLE=1`. `OB_LINK_HOST` optionally supplies the database-server-reachable remote endpoint (for an isolated single-node self-link test, `127.0.0.1:2881`); otherwise the script uses `OB_HOST:OB_PORT`. Supply the SYS password locally through the environment, never in source or a command committed to Git.

```sh
pnpm exec tsx --tsconfig apps/desktop/tsconfig.json agents/drivers/oceanbase-oracle/scripts/verify-schema-objects.ts
cargo test -p dbx-sql oceanbase_sequence_edit
```

Unlike the partition verifier, this script attempts to remove both fixture users in `finally`. It never drops an existing user with the same name after a failed CREATE. Inspect `agents/drivers/oceanbase-oracle/build/schema-object-evidence/verification.json` (or `OB_TEST_OUTPUT`) for the executed checks, errors and any cleanup needed. There must be no errors before calling the integration check passed. A cleanup error is also a test failure. No credentials are written to evidence files. Literal `CREATE PUBLIC DATABASE LINK`, reverse links, OCI connectivity and complete desktop-client acceptance are outside the successful path. OceanBase 4.2.5.7 rejects the Oracle-style `PUBLIC` keyword with ORA-00900; its accepted `CREATE DATABASE LINK` syntax already creates a tenant-visible public link.

The sequence viewer retains CREATE DDL for copying; editing changes only supported options through ALTER, without DROP/RESTART or replaying START WITH. Dictionary `LAST_NUMBER` is a cache-allocation boundary, not session CURRVAL. Synonym source uses CREATE OR REPLACE with quoted dictionary names. The DBLink manager uses the OceanBase `HOST` syntax and OB/OCI protocol selection. Existing OB links are never automatically dropped to update credentials or endpoints: create/test a replacement and explicitly remove the old link. Native Oracle's credential-update path is unchanged.
