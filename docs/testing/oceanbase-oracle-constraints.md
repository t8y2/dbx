# OceanBase Oracle constraint metadata

Issue: [#11415](https://github.com/t8y2/dbx/issues/11415), parent [#11412](https://github.com/t8y2/dbx/issues/11412).

The read-only Constraints tab uses the existing `list_constraints` protocol for primary key, unique and CHECK constraints. Foreign keys remain in their existing tab. Constraint editing is outside this change.

## Contract

- `columns` preserves `ALL_CONS_COLUMNS.POSITION` for composite keys. Primary and unique definitions quote every column identifier. CHECK text is returned without whitespace normalization or truncation.
- `enabled`, `valid`, `deferrable` and `initially_deferred` are nullable. Missing or unrecognized dictionary states remain unknown through Core and the UI. Existing explicit boolean responses from native Oracle and other drivers retain their meaning.
- The query starts at `ALL_TABLES` and joins the visible P/U/C constraints by owner and table. A visible table with no constraints returns `[]`; an inaccessible or missing table returns an error without disclosing whether it exists. Dictionary query failures propagate. Drivers without this metadata method return an unsupported error.
- Confirmed system-generated NOT NULL checks are omitted because the columns tab already shows nullability. Named CHECK constraints remain visible.

## Automated checks

With JDK 21, run from `agents/`:

```sh
./gradlew :common:test :oceanbase-oracle:test --no-daemon --max-workers=1
```

`OceanBaseOracleConstraintRpcTest` exercises the production JSON-RPC dispatcher, DTO serialization and OB JDBC implementation with the database boundary replaced. It covers composite keys, quoted names, multiline CHECK text, missing state/definition, visible empty tables, hidden tables, query errors and NOT NULL filtering. `CommonJavaCompatibilityTest` checks that an unsupported driver does not return an empty success.

The Rust wire test checks unknown and known states through serialization. Mounted component regressions cover unknown badges and persistent metadata errors.

## Live verification on 2026-10-09

OceanBase Oracle 4.2.5.7, Connector/J 2.4.18 and the built Java agent process passed 166 assertions. Two disposable schemas had only `CREATE SESSION` and `CREATE TABLE`; all fixture names included `11415`. The checks compared RPC output with dictionary values and covered:

- P/U/C definitions, composite column order, quoted names with spaces and mixed-case owners;
- enabled/disabled and validated/not-validated states, including `ENABLE NOVALIDATE`;
- generated NOT NULL filtering with an explicitly named CHECK retained;
- multiline and 947-character CHECK definitions;
- same-named objects in different schemas, individually granted SELECT/INSERT/UPDATE visibility, revoked access, nonexistent objects and a visible table without constraints.

All RPC fixture schemas were removed and their absence was read back. The engine rejected embedded double quotes in table, column and constraint names, and rejected larger CHECK expressions at its `check_expr` limit. Escaping is covered at the RPC boundary; those rejected DDL forms are not claimed as live supported cases. No additional OceanBase version or native Oracle instance has been certified by this run.
