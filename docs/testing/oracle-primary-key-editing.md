# Oracle primary-key editing (#6973)

Development checkpoint only. The tests below have been written but have not been
run under the current development-first delivery schedule. Oracle database,
desktop/Web GUI, compilation, and integrated acceptance are pending.

## Production path

The existing structure editor's Constraints tab opens `OraclePrimaryKeyEditor`.
Both HTTP and Tauri call the same Core preview/apply implementation. The Core
reads the real constraint name, key order, supporting-index inventory and states;
the frontend never supplies executable DDL. Apply re-reads the plan and rejects
an obsolete revision before writing. Read-only connection enforcement remains in
the Core query path. Production confirmation uses the existing structure-editor
confirmation mechanism.

Candidate columns must exist and pass NULL/duplicate probes before the old key
can be dropped. Existing references are refused without implicit cascading.
The dependency inventory uses DBA_CONSTRAINTS: ALL_CONSTRAINTS is filtered by
visibility and cannot establish the absence of cross-schema references. A
missing grant/query error is a blocking error, not an empty dependency list.

The replacement index is built first. The old constraint is dropped with KEEP
INDEX, and the replacement key is attached to the new index. The original index
is retained by default and can therefore continue to enforce its original
uniqueness. The user can explicitly request removal of that index after the new
key is installed. This reads its DBMS_METADATA definition and rejects indexes
used by other constraints; apply rechecks before dropping it. On removal of the
whole key, the same explicit index disposition applies.

DDL is not transactional. Every attempted step is returned with its actual
result. Dictionary readback determines success; unknown readback never becomes
success. When the key is absent after a failure, recovery SQL reconstructs the
original constraint and, if actually absent, its original index. Recovery is
displayed for review, never silently executed. A failed operation requires a new
preview. Concurrent database changes can still cause a later DDL statement to
fail; the UI must show the completed steps rather than claim rollback.

Oracle references: [ALTER TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ALTER-TABLE.html)
and [ALL_CONSTRAINTS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_CONSTRAINTS.html).
Engine semantics are not established by SQL generation tests alone.

## Written behavior suites (not run)

- Core `schema::oracle_constraint_change::tests`: ordered replacement, quoted
  identifiers, NULL/duplicate/dependency/permission/incomplete-result rejection,
  stale preview, pre-index failure, failed replacement and recovery, retry,
  complete removal, existing add behavior, explicit old-index removal.
- `OraclePrimaryKeyEditor.spec.ts`: mounted component selection/order, real
  backend-plan presentation, cancellation, production confirmation cancellation,
  partial result/recovery, blocked preflight and disabled parent state.

## Deferred real-environment acceptance

Use disposable #6973 accounts/tables only. Record database version, driver,
commit, process artifacts and each dictionary readback. Cover an empty table and
a populated table, single-to-composite, compound key reduction/reordering,
complete removal, NULL/duplicate candidates, quoted names, self/cross-schema
references and missing catalog grants. Verify the old unique index is retained
when requested and removed only when explicitly selected and unused by other
constraints. Verify recovery after a later DDL failure, including the index
existence check. Repeat through the actual structure editor in Oracle; OceanBase
Oracle enablement belongs to #11439 and requires separate engine evidence.
