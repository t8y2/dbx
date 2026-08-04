# Data Transfer: Tree Object Selection and Transfer Modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the data transfer dialog's flat table picker into a type-grouped object tree (tables/views/procedures/functions/triggers/sequences/events) with three transfer modes (structure+data / structure only / data only), and copy non-table object DDL for PostgreSQL-family, MySQL, and Oracle/Dameng.

**Architecture:** Backend `TransferRequest` gains `content` (TransferContent) and `objects` (Vec<TransferObjectSelection>); a new family-aware object transfer executor (`transfer_schema_objects`) runs after table data transfer, checking target existence per object (skip + count) and executing DDL in dependency order (sequences → views → functions → procedures → triggers → events). Frontend `DataTransferDialog.vue` swaps the flat list for an `ObjectSelectionTree` group component and a three-way content mode selector.

**Tech Stack:** Rust (dbx-core, dbx-web), Vue 3 + TypeScript + Vitest (apps/desktop), i18n locales.

**Branch:** create `feature/data-transfer-tree-selection` from current HEAD. The `docs/superpowers/` directory is git-ignored and never committed.

**Spec:** `docs/superpowers/specs/2026-08-01-data-transfer-tree-selection-design.md` (local, untracked).

---

## Task 0: Branch setup

- [ ] **Step 1: Create the feature branch**

```bash
cd /d/git-clone-project/dbx && git checkout -b feature/data-transfer-tree-selection
```

Expected: switched to new branch. Note: it will carry the committed dameng-drop-schema fix (75238cde3) forward.

---

## Task 1: Backend protocol — TransferContent / TransferObjectKind / TransferObjectSelection

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs` (after `TransferMode` definition, ~line 67; and `TransferRequest` struct at line 80)

- [ ] **Step 1: Write the failing test** — add a `#[cfg(test)] mod protocol_tests` at the end of `transfer.rs` asserting serde round-trips and defaults:

```rust
#[cfg(test)]
mod transfer_protocol_tests {
    use super::*;

    #[test]
    fn transfer_content_defaults_to_structure_and_data() {
        let request: TransferRequest = serde_json::from_value(serde_json::json!({
            "transferId": "t1", "sourceConnectionId": "s", "sourceDatabase": "db",
            "sourceSchema": "public", "targetConnectionId": "t", "targetDatabase": "db",
            "targetSchema": "public", "tables": ["a"], "createTable": true,
            "mode": "append", "targetTableNameCase": "preserve", "batchSize": 1000
        })).unwrap();
        assert_eq!(request.content, TransferContent::StructureAndData);
        assert!(request.objects.is_empty());
    }

    #[test]
    fn transfer_request_serializes_new_fields_camel_case() {
        let request = TransferRequest {
            transfer_id: "t1".into(), source_connection_id: "s".into(),
            source_database: "db".into(), source_schema: "public".into(), source_catalog: None,
            target_connection_id: "t".into(), target_database: "db".into(),
            target_schema: "public".into(), target_catalog: None,
            tables: vec!["a".into()], create_table: true,
            mode: TransferMode::Append, target_table_name_case: TransferTableNameCase::Preserve,
            ownership_policy: TransferOwnershipPolicy::Preserve, batch_size: 1000,
            content: TransferContent::StructureOnly,
            objects: vec![TransferObjectSelection {
                object_type: TransferObjectKind::View,
                names: vec!["v1".into()],
            }],
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["content"], "structureOnly");
        assert_eq!(json["objects"][0]["objectType"], "VIEW");
        assert_eq!(json["objects"][0]["names"][0], "v1");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core transfer_protocol_tests 2>&1 | tail -5`
Expected: FAIL — `content`/`objects` fields and enums do not exist yet.

- [ ] **Step 3: Implement the protocol types** — insert after the `TransferMode` enum (line ~67):

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferContent {
    #[default]
    StructureAndData,
    StructureOnly,
    DataOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TransferObjectKind {
    Table,
    View,
    MaterializedView,
    Procedure,
    Function,
    Trigger,
    Sequence,
    Event,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct TransferObjectSelection {
    pub object_type: TransferObjectKind,
    pub names: Vec<String>,
}
```

Add to `TransferRequest` (after `tables`, keeping `create_table` for wire compatibility):

```rust
    #[serde(default)]
    pub content: TransferContent,
    #[serde(default)]
    pub objects: Vec<TransferObjectSelection>,
```

Note: `TransferRequest` is constructed in tests (`transfer.rs:5364` area uses `create_table: true`) and in `crates/dbx-core/tests/live_postgres_transfer.rs` — all construction sites need the two new fields added. Fix compile errors by adding `content: TransferContent::default(), objects: Vec::new(),` wherever a literal is built.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core transfer_protocol_tests 2>&1 | tail -5`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): add content and object selection protocol fields"
```

---

## Task 2: Transfer object families and per-family kind tables

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs`

- [ ] **Step 1: Write the failing test** (module `transfer_family_tests`):

```rust
#[test]
fn same_family_matrix() {
    // postgres family
    assert!(is_same_transfer_family(&DatabaseType::Postgres, &DatabaseType::Kingbase));
    assert!(is_same_transfer_family(&DatabaseType::Gaussdb, &DatabaseType::OpenGauss));
    // oracle family
    assert!(is_same_transfer_family(&DatabaseType::Oracle, &DatabaseType::Dameng));
    assert!(is_same_transfer_family(&DatabaseType::OceanbaseOracle, &DatabaseType::Dameng));
    // mysql
    assert!(is_same_transfer_family(&DatabaseType::Mysql, &DatabaseType::Mysql));
    // cross family
    assert!(!is_same_transfer_family(&DatabaseType::Mysql, &DatabaseType::Postgres));
    assert!(!is_same_transfer_family(&DatabaseType::Mysql, &DatabaseType::SqlServer));
}

#[test]
fn object_kinds_per_family() {
    let mysql = transfer_object_kinds(&DatabaseType::Mysql);
    assert!(mysql.contains(&TransferObjectKind::Event));
    assert!(!mysql.contains(&TransferObjectKind::Sequence));
    let pg = transfer_object_kinds(&DatabaseType::Postgres);
    assert!(pg.contains(&TransferObjectKind::Sequence));
    assert!(!pg.contains(&TransferObjectKind::Event));
    let dm = transfer_object_kinds(&DatabaseType::Dameng);
    assert!(dm.contains(&TransferObjectKind::Trigger));
    assert!(dm.contains(&TransferObjectKind::Sequence));
    assert!(transfer_object_kinds(&DatabaseType::Sqlite).is_empty());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core transfer_family_tests 2>&1 | tail -5`
Expected: FAIL — functions undefined.

- [ ] **Step 3: Implement** — add near the top of `transfer.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferObjectFamily { Mysql, Postgres, Oracle }

pub fn transfer_object_family(db_type: &DatabaseType) -> Option<TransferObjectFamily> {
    match db_type {
        DatabaseType::Mysql => Some(TransferObjectFamily::Mysql),
        DatabaseType::Postgres
        | DatabaseType::Kingbase
        | DatabaseType::Gaussdb
        | DatabaseType::Kwdb
        | DatabaseType::OpenGauss => Some(TransferObjectFamily::Postgres),
        DatabaseType::Oracle | DatabaseType::Dameng | DatabaseType::OceanbaseOracle => {
            Some(TransferObjectFamily::Oracle)
        }
        _ => None,
    }
}

pub fn is_same_transfer_family(a: &DatabaseType, b: &DatabaseType) -> bool {
    match (transfer_object_family(a), transfer_object_family(b)) {
        (Some(fa), Some(fb)) => fa == fb,
        _ => false,
    }
}

pub fn transfer_object_kinds(db_type: &DatabaseType) -> Vec<TransferObjectKind> {
    use TransferObjectKind::*;
    match transfer_object_family(db_type) {
        Some(TransferObjectFamily::Mysql) => {
            vec![Table, View, Procedure, Function, Trigger, Event]
        }
        Some(TransferObjectFamily::Postgres) => {
            vec![Table, View, MaterializedView, Procedure, Function, Trigger, Sequence]
        }
        Some(TransferObjectFamily::Oracle) => {
            vec![Table, View, MaterializedView, Procedure, Function, Trigger, Sequence]
        }
        None => Vec::new(),
    }
}
```

Check `DatabaseType` variant names in `crates/dbx-core/src/models/connection.rs` (OceanbaseOracle may be `OceanbaseOracle` — verify; `Kwdb`/`Gaussdb` exist per `build_drop_schema_sql` match at line 583).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core transfer_family_tests 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): add object transfer families and per-family kind tables"
```

---

## Task 3: Request validation for content and objects

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs` (extend `validate_transfer_target_table_names` area — add a new `validate_transfer_request`)

- [ ] **Step 1: Write the failing test**:

```rust
#[test]
fn validates_content_and_object_rules() {
    let base = TransferRequest {
        transfer_id: "t".into(), source_connection_id: "s".into(), source_database: "db".into(),
        source_schema: "public".into(), source_catalog: None, target_connection_id: "t".into(),
        target_database: "db".into(), target_schema: "public".into(), target_catalog: None,
        tables: vec!["a".into()], create_table: true, mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        ownership_policy: TransferOwnershipPolicy::Preserve, batch_size: 1000,
        content: TransferContent::DataOnly, objects: Vec::new(),
    };
    assert!(validate_transfer_request(&base).is_ok());

    let with_objects = TransferRequest {
        objects: vec![TransferObjectSelection { object_type: TransferObjectKind::View, names: vec!["v".into()] }],
        ..base.clone()
    };
    // DataOnly + objects → error
    assert!(validate_transfer_request(&with_objects).is_err());

    let structure_only = TransferRequest { content: TransferContent::StructureOnly, ..base.clone() };
    assert!(validate_transfer_request(&structure_only).is_ok());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core validates_content_and_object_rules 2>&1 | tail -5`
Expected: FAIL — function undefined.

- [ ] **Step 3: Implement**:

```rust
pub fn validate_transfer_request(request: &TransferRequest) -> Result<(), String> {
    validate_transfer_target_table_names(request)?;
    if matches!(request.content, TransferContent::DataOnly) && !request.objects.is_empty() {
        return Err("仅数据模式不传输非表对象".to_string());
    }
    for selection in &request.objects {
        if selection.names.is_empty() {
            return Err(format!("Object selection for {:?} is empty", selection.object_type));
        }
        for name in &selection.names {
            if name.trim().is_empty() || name.contains('\0') {
                return Err(format!("Invalid object name: {name:?}"));
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core validates_content_and_object_rules 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): validate transfer content and object selections"
```

---

## Task 4: Target-side object existence check SQL (per family)

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs`

- [ ] **Step 1: Write the failing test**:

```rust
#[test]
fn builds_target_existence_check_sql_per_family() {
    let mysql = target_object_exists_sql(&DatabaseType::Mysql, "shop", "v1", &TransferObjectKind::View).unwrap();
    assert!(mysql.contains("information_schema.TABLES"));
    assert!(mysql.contains("TABLE_TYPE = 'VIEW'"));
    let mysql_ev = target_object_exists_sql(&DatabaseType::Mysql, "shop", "e1", &TransferObjectKind::Event).unwrap();
    assert!(mysql_ev.contains("information_schema.EVENTS"));
    let mysql_tr = target_object_exists_sql(&DatabaseType::Mysql, "shop", "t1", &TransferObjectKind::Trigger).unwrap();
    assert!(mysql_tr.contains("information_schema.TRIGGERS"));
    let pg = target_object_exists_sql(&DatabaseType::Postgres, "public", "v1", &TransferObjectKind::View).unwrap();
    assert!(pg.contains("pg_class"));
    let orc = target_object_exists_sql(&DatabaseType::Oracle, "HR", "SEQ1", &TransferObjectKind::Sequence).unwrap();
    assert!(orc.contains("ALL_OBJECTS"));
    assert!(target_object_exists_sql(&DatabaseType::Sqlite, "m", "x", &TransferObjectKind::View).is_err());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core builds_target_existence_check_sql 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement**:

```rust
/// Returns a SQL statement selecting 1 row when `name` exists in `schema`
/// on the target side; None-kind support per family mirrors
/// `transfer_object_kinds`.
pub fn target_object_exists_sql(
    db_type: &DatabaseType,
    schema: &str,
    name: &str,
    kind: &TransferObjectKind,
) -> Result<String, String> {
    let schema = quote_string_literal(schema);
    let name = quote_string_literal(name);
    let q = |literal: &str| literal.to_string();
    let sql = match (transfer_object_family(db_type), kind) {
        (Some(TransferObjectFamily::Mysql), TransferObjectKind::Table | TransferObjectKind::View) => format!(
            "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = {schema} AND TABLE_NAME = {name} \
             AND TABLE_TYPE {} 'VIEW'",
            if matches!(kind, TransferObjectKind::View) { "=" } else { "<>" }
        ),
        (Some(TransferObjectFamily::Mysql), TransferObjectKind::Procedure | TransferObjectKind::Function) => format!(
            "SELECT 1 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = {schema} AND ROUTINE_NAME = {name} \
             AND ROUTINE_TYPE = {}",
            q(if matches!(kind, TransferObjectKind::Procedure) { "'PROCEDURE'" } else { "'FUNCTION'" })
        ),
        (Some(TransferObjectFamily::Mysql), TransferObjectKind::Trigger) => format!(
            "SELECT 1 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = {schema} AND TRIGGER_NAME = {name}"
        ),
        (Some(TransferObjectFamily::Mysql), TransferObjectKind::Event) => format!(
            "SELECT 1 FROM information_schema.EVENTS WHERE EVENT_SCHEMA = {schema} AND EVENT_NAME = {name}"
        ),
        (Some(TransferObjectFamily::Postgres), TransferObjectKind::View | TransferObjectKind::MaterializedView) => format!(
            "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {schema} AND c.relname = {name} AND c.relkind {}",
            if matches!(kind, TransferObjectKind::MaterializedView) { "= 'm'" } else { "= 'v'" }
        ),
        (Some(TransferObjectFamily::Postgres), TransferObjectKind::Table) => format!(
            "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {schema} AND c.relname = {name} AND c.relkind = 'r'"
        ),
        (Some(TransferObjectFamily::Postgres), TransferObjectKind::Procedure | TransferObjectKind::Function) => format!(
            "SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = {schema} AND p.proname = {name}"
        ),
        (Some(TransferObjectFamily::Postgres), TransferObjectKind::Sequence) => format!(
            "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {schema} AND c.relname = {name} AND c.relkind = 'S'"
        ),
        (Some(TransferObjectFamily::Postgres), TransferObjectKind::Trigger) => format!(
            "SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {schema} AND t.tgname = {name} AND NOT t.tgisinternal"
        ),
        (Some(TransferObjectFamily::Oracle), TransferObjectKind::View
        | TransferObjectKind::MaterializedView
        | TransferObjectKind::Procedure
        | TransferObjectKind::Function
        | TransferObjectKind::Trigger
        | TransferObjectKind::Sequence) => format!(
            "SELECT 1 FROM ALL_OBJECTS WHERE OWNER = {schema} AND OBJECT_NAME = {name} AND OBJECT_TYPE = {}",
            q(match kind {
                TransferObjectKind::View => "'VIEW'",
                TransferObjectKind::MaterializedView => "'MATERIALIZED VIEW'",
                TransferObjectKind::Procedure => "'PROCEDURE'",
                TransferObjectKind::Function => "'FUNCTION'",
                TransferObjectKind::Trigger => "'TRIGGER'",
                _ => "'SEQUENCE'",
            })
        ),
        _ => return Err(format!("Object existence check not supported for {:?} {:?}", db_type, kind)),
    };
    Ok(sql)
}
```

Verify `quote_string_literal` exists in transfer.rs (used at line 3717) — yes.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core builds_target_existence_check_sql 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): target object existence check SQL per family"
```

---

## Task 5: MySQL list_objects gains TRIGGER and EVENT

**Files:**
- Modify: `crates/dbx-core/src/db/mysql.rs` (`list_objects` at 2844, `wants_table_objects`/`wants_routine_objects` at 2722, `object_query_supports_paging` at 2825)

- [ ] **Step 1: Write the failing test** — add to existing test module in mysql.rs (pattern: `assert!(sql.contains("information_schema.TRIGGERS"))` at 5004):

```rust
#[test]
fn lists_triggers_and_events_via_information_schema() {
    let sql = list_triggers_objects_sql("shop");
    assert!(sql.contains("information_schema.TRIGGERS"));
    assert!(sql.contains("TRIGGER_SCHEMA = 'shop'"));
    let sql = list_events_objects_sql("shop");
    assert!(sql.contains("information_schema.EVENTS"));
    assert!(sql.contains("EVENT_SCHEMA = 'shop'"));
    assert!(wants_trigger_objects(Some(&["TRIGGER".to_string()])));
    assert!(!wants_trigger_objects(Some(&["TABLE".to_string()])));
    assert!(wants_event_objects(Some(&["EVENT".to_string()])));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core lists_triggers_and_events 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement** — add functions mirroring `list_completion_triggers_sql` (2791) and `list_routines_sql` (2763):

```rust
fn wants_trigger_objects(object_types: Option<&[String]>) -> bool {
    requested_object_type(object_types, "TRIGGER")
}
fn wants_event_objects(object_types: Option<&[String]>) -> bool {
    requested_object_type(object_types, "EVENT")
}

fn list_triggers_objects_sql(database: &str) -> String {
    format!(
        "SELECT TRIGGER_NAME AS object_name, 'TRIGGER' AS object_type, NULL AS object_comment, \
           CREATED AS created_at, NULL AS updated_at, \
           TRIGGER_SCHEMA AS parent_schema, EVENT_OBJECT_TABLE AS parent_name, \
           5 AS sort_order \
         FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = {} \
         ORDER BY object_name",
        quote_value(database)
    )
}

fn list_events_objects_sql(database: &str) -> String {
    format!(
        "SELECT EVENT_NAME AS object_name, 'EVENT' AS object_type, NULL AS object_comment, \
           CREATED AS created_at, LAST_ALTERED AS updated_at, \
           EVENT_SCHEMA AS parent_schema, NULL AS parent_name, \
           6 AS sort_order \
         FROM information_schema.EVENTS \
         WHERE EVENT_SCHEMA = {} \
         ORDER BY object_name",
        quote_value(database)
    )
}
```

Wire into `list_objects` (after the routines block): fetch both lists when `wants_trigger_objects`/`wants_event_objects` and extend `objects` with `row_to_object`. Verify `requested_object_type`/`quote_value`/`row_to_object` signatures and reuse them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core lists_triggers_and_events 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/db/mysql.rs
git commit -m "feat(mysql): list triggers and events for object browsing"
```

---

## Task 6: MySQL object DDL assembly for transfer

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs`

- [ ] **Step 1: Write the failing test** (pure-string functions; no DB needed):

```rust
#[test]
fn strips_mysql_definer_clauses() {
    assert_eq!(
        strip_mysql_definer("CREATE DEFINER=`u`@`%` VIEW v AS SELECT 1"),
        "CREATE VIEW v AS SELECT 1"
    );
    assert_eq!(strip_mysql_definer("CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` VIEW v AS SELECT 1"),
        "CREATE ALGORITHM=UNDEFINED VIEW v AS SELECT 1");
    assert_eq!(strip_mysql_definer("CREATE PROCEDURE p() BEGIN END"), "CREATE PROCEDURE p() BEGIN END");
}

#[test]
fn rewrites_mysql_schema_qualifiers() {
    assert_eq!(
        rewrite_mysql_schema_qualifier("CREATE VIEW `src`.`v` AS SELECT 1 FROM `src`.`t`", "src", "dst"),
        "CREATE VIEW `dst`.`v` AS SELECT 1 FROM `dst`.`t`"
    );
}

#[test]
fn assembles_mysql_trigger_and_event_ddl() {
    let trigger = mysql_trigger_ddl("shop", "trg1", "BEFORE", "INSERT", "users", "SET NEW.updated = NOW()");
    assert_eq!(trigger, "CREATE TRIGGER `trg1` BEFORE INSERT ON `shop`.`users` FOR EACH ROW SET NEW.updated = NOW()");
    let event = mysql_event_ddl("shop", "ev1", "ENABLE", "EVERY 1 DAY", "DELETE FROM logs");
    assert_eq!(event, "CREATE EVENT `ev1` ON SCHEDULE EVERY 1 DAY ENABLE DO DELETE FROM logs");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core strips_mysql_definer_clauses 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement** — pure functions in `transfer.rs`:

```rust
/// Remove `DEFINER=`user`@`host`` tokens from MySQL DDL (they are not
/// transferable and frequently reference accounts that don't exist on target).
pub fn strip_mysql_definer(ddl: &str) -> String {
    let re = Regex::new(r"(?i)\bDEFINER\s*=\s*`[^`]*`@`[^`]*`\s*").unwrap();
    re.replace_all(ddl, "").to_string()
}

/// Rewrite backtick-qualified `schema`.`name` references from `source_schema`
/// to `target_schema` in MySQL DDL.
pub fn rewrite_mysql_schema_qualifier(ddl: &str, source_schema: &str, target_schema: &str) -> String {
    if source_schema == target_schema || source_schema.is_empty() {
        return ddl.to_string();
    }
    let re = Regex::new(&format!(r"`{}`\.", regex::escape(source_schema))).unwrap();
    re.replace_all(ddl, &format!("`{}`.", target_schema)).to_string()
}

pub fn mysql_trigger_ddl(schema: &str, name: &str, timing: &str, manipulation: &str, table: &str, statement: &str) -> String {
    format!(
        "CREATE TRIGGER `{name}` {timing} {manipulation} ON `{schema}`.`{table}` FOR EACH ROW {statement}",
        name = name, timing = timing, manipulation = manipulation,
        schema = schema, table = table, statement = statement.trim()
    )
}

pub fn mysql_event_ddl(schema: &str, name: &str, status: &str, schedule: &str, body: &str) -> String {
    format!(
        "CREATE EVENT `{name}` ON SCHEDULE {schedule} {status} DO {body}",
        name = name, schedule = schedule, status = status, body = body.trim()
    )
}
```

Note: `Regex` is already imported in transfer.rs (line 1).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core strips_mysql_definer_clauses 2>&1 | tail -5`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): mysql object DDL helpers (definer strip, schema rewrite, trigger/event assembly)"
```

---

## Task 7: MySQL object source fetching for transfer

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs`

- [ ] **Step 1: Write the failing test** (SQL generation only):

```rust
#[test]
fn builds_mysql_object_source_queries() {
    let sql = mysql_object_source_query(&TransferObjectKind::View, "shop", "v1").unwrap();
    assert!(sql.contains("SHOW CREATE VIEW"));
    let sql = mysql_object_source_query(&TransferObjectKind::Trigger, "shop", "trg1").unwrap();
    assert!(sql.contains("information_schema.TRIGGERS"));
    assert!(sql.contains("TRIGGER_NAME = 'trg1'"));
    let sql = mysql_object_source_query(&TransferObjectKind::Event, "shop", "ev1").unwrap();
    assert!(sql.contains("information_schema.EVENTS"));
    assert!(sql.contains("EVENT_NAME = 'ev1'"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core builds_mysql_object_source_queries 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement**:

```rust
/// Builds the query that fetches DDL for one MySQL object.
/// - View/Procedure/Function → `SHOW CREATE ...` (existing
///   `schema::mysql_object_source_sql` shape; reuse it by importing the
///   function or duplicating the format strings).
/// - Trigger → information_schema.TRIGGERS row (timing/manipulation/table/
///   statement) via `mysql_trigger_ddl`.
/// - Event → information_schema.EVENTS row via `mysql_event_ddl`.
pub fn mysql_object_source_query(
    kind: &TransferObjectKind,
    database: &str,
    name: &str,
) -> Result<String, String> {
    let db = quote_string_literal(database);
    let n = quote_string_literal(name);
    let ddl = match kind {
        TransferObjectKind::View => format!("SHOW CREATE VIEW `{database}`.`{name}`"),
        TransferObjectKind::Procedure => format!("SHOW CREATE PROCEDURE `{database}`.`{name}`"),
        TransferObjectKind::Function => format!("SHOW CREATE FUNCTION `{database}`.`{name}`"),
        TransferObjectKind::Trigger => format!(
            "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_STATEMENT \
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = {db} AND TRIGGER_NAME = {n}"
        ),
        TransferObjectKind::Event => format!(
            "SELECT EVENT_NAME, STATUS, EXECUTE_AT, INTERVAL_VALUE, INTERVAL_FIELD, EVENT_DEFINITION \
             FROM information_schema.EVENTS WHERE EVENT_SCHEMA = {db} AND EVENT_NAME = {n}"
        ),
        _ => return Err(format!("MySQL object source not supported for {:?}", kind)),
    };
    Ok(ddl)
}
```

Also implement `mysql_object_ddl_from_result(kind, rows) -> Result<String, String>` mapping query rows to a single DDL string (SHOW CREATE column index: view=1, routine=2 — same convention as `schema::mysql_object_source_ddl_column_index`; trigger/event assembled from row cells). Add a unit test asserting the extraction for each kind with a fake `db::QueryResult`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core mysql_object_source_query 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): mysql per-object DDL query and row extraction"
```

---

## Task 8: Oracle/Dameng object DDL via DBMS_METADATA for transfer

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs`

- [ ] **Step 1: Write the failing test**:

```rust
#[test]
fn builds_oracle_object_source_query() {
    let sql = oracle_object_source_query(&TransferObjectKind::Trigger, "HR", "TRG1").unwrap();
    assert!(sql.contains("DBMS_METADATA.GET_DDL('TRIGGER', 'TRG1', 'HR')"));
    let sql = oracle_object_source_query(&TransferObjectKind::Sequence, "HR", "SEQ1").unwrap();
    assert!(sql.contains("DBMS_METADATA.GET_DDL('SEQUENCE', 'SEQ1', 'HR')"));
    let sql = oracle_object_source_query(&TransferObjectKind::View, "", "V1").unwrap();
    assert!(!sql.contains(",'"));
}

#[test]
fn rewrites_oracle_schema_qualifiers() {
    let ddl = "CREATE OR REPLACE TRIGGER \"HR\".\"TRG1\" ...";
    assert_eq!(rewrite_oracle_schema_qualifier(ddl, "HR", "APP"), "CREATE OR REPLACE TRIGGER \"APP\".\"TRG1\" ...");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core builds_oracle_object_source_query 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement**:

```rust
pub fn oracle_object_source_query(kind: &TransferObjectKind, schema: &str, name: &str) -> Result<String, String> {
    let object_type = match kind {
        TransferObjectKind::View => "VIEW",
        TransferObjectKind::MaterializedView => "MATERIALIZED_VIEW",
        TransferObjectKind::Procedure => "PROCEDURE",
        TransferObjectKind::Function => "FUNCTION",
        TransferObjectKind::Trigger => "TRIGGER",
        TransferObjectKind::Sequence => "SEQUENCE",
        _ => return Err(format!("Oracle object source not supported for {:?}", kind)),
    };
    let name_lit = quote_string_literal(name);
    if schema.trim().is_empty() {
        Ok(format!("SELECT DBMS_METADATA.GET_DDL({}, {}) FROM DUAL", quote_string_literal(object_type), name_lit))
    } else {
        Ok(format!(
            "SELECT DBMS_METADATA.GET_DDL({}, {}, {}) FROM DUAL",
            quote_string_literal(object_type),
            name_lit,
            quote_string_literal(schema)
        ))
    }
}

/// Rewrite `"SCHEMA"."NAME"` occurrences in Oracle/DM metadata DDL from
/// source_schema to target_schema.
pub fn rewrite_oracle_schema_qualifier(ddl: &str, source_schema: &str, target_schema: &str) -> String {
    if source_schema == target_schema || source_schema.is_empty() {
        return ddl.to_string();
    }
    let re = Regex::new(&format!(r#""{}"\."# , regex::escape(source_schema))).unwrap();
    re.replace_all(ddl, &format!("\"{target_schema}\".")).to_string()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core builds_oracle_object_source_query 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): oracle/dameng object DDL helpers"
```

---

## Task 9: Generic object transfer executor with skip-existing and ordering

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs`

- [ ] **Step 1: Write the failing test** (pure ordering helper):

```rust
#[test]
fn orders_object_selections_by_dependency() {
    let kinds = vec![
        TransferObjectKind::Trigger, TransferObjectKind::View, TransferObjectKind::Sequence,
        TransferObjectKind::Event, TransferObjectKind::Procedure, TransferObjectKind::Function,
    ];
    let ordered = ordered_transfer_object_kinds(kinds.iter().copied().collect());
    // sequences → views → functions → procedures → triggers → events
    assert_eq!(ordered[0], TransferObjectKind::Sequence);
    assert_eq!(ordered[1], TransferObjectKind::View);
    assert_eq!(ordered[2], TransferObjectKind::Function);
    assert_eq!(ordered[3], TransferObjectKind::Procedure);
    assert_eq!(ordered[4], TransferObjectKind::Trigger);
    assert_eq!(ordered[5], TransferObjectKind::Event);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core orders_object_selections 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement** — ordering + executor skeleton:

```rust
pub fn ordered_transfer_object_kinds(kinds: Vec<TransferObjectKind>) -> Vec<TransferObjectKind> {
    let rank = |kind: &TransferObjectKind| match kind {
        TransferObjectKind::Table => 0,
        TransferObjectKind::Sequence => 1,
        TransferObjectKind::View => 2,
        TransferObjectKind::MaterializedView => 2,
        TransferObjectKind::Function => 3,
        TransferObjectKind::Procedure => 4,
        TransferObjectKind::Trigger => 5,
        TransferObjectKind::Event => 6,
    };
    let mut kinds = kinds;
    kinds.sort_by_key(rank);
    kinds
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferObjectOutcome {
    pub transferred: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}
```

Then the executor (async, one function per family):

```rust
/// Transfers selected non-table objects from source to target.
/// Skips objects that already exist on the target; counts them in the
/// outcome. Executes in dependency order (sequence → view → function →
/// procedure → trigger → event). Errors are collected per object and the
/// transfer continues.
pub async fn transfer_schema_objects<F>(
    state: &AppState,
    request: &TransferRequest,
    source_pool_key: &str,
    target_pool_key: &str,
    mut progress_callback: F,
) -> Result<TransferObjectOutcome, String>
where
    F: FnMut(TransferProgress),
{
    if request.objects.is_empty() {
        return Ok(TransferObjectOutcome::default());
    }
    let source_db_type = get_db_type(state, &request.source_connection_id).await?;
    let target_db_type = get_db_type(state, &request.target_connection_id).await?;
    if !is_same_transfer_family(&source_db_type, &target_db_type) {
        return Err("跨库暂不支持非表对象传输".to_string());
    }
    match transfer_object_family(&source_db_type) {
        Some(TransferObjectFamily::Postgres) => {
            transfer_postgres_schema_objects(state, request, source_pool_key, target_pool_key, progress_callback)
                .await
                .map(|_| TransferObjectOutcome::default())
        }
        Some(TransferObjectFamily::Mysql) => {
            transfer_mysql_schema_objects(state, request, source_pool_key, target_pool_key, progress_callback).await
        }
        Some(TransferObjectFamily::Oracle) => {
            transfer_oracle_schema_objects(state, request, source_pool_key, target_pool_key, progress_callback).await
        }
        None => Ok(TransferObjectOutcome::default()),
    }
}
```

Note: this task lands the skeleton + ordering + outcome; per-family bodies are Tasks 10 (MySQL), 11 (Oracle), 12 (PG refactor). `transfer_mysql_schema_objects` and `transfer_oracle_schema_objects` are stubbed in this task (returning `Ok(TransferObjectOutcome::default())` guarded by a `todo!()`-free minimal implementation) so the crate compiles — they are filled in by Tasks 10/11.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core orders_object_selections 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): schema object transfer executor skeleton with ordering"
```

---

## Task 10: MySQL schema object transfer body

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs`

- [ ] **Step 1: Write the failing test** (selection extraction helper):

```rust
#[test]
fn extracts_selected_names_by_kind() {
    let selections = vec![
        TransferObjectSelection { object_type: TransferObjectKind::View, names: vec!["v1".into()] },
        TransferObjectSelection { object_type: TransferObjectKind::View, names: vec!["v2".into()] },
        TransferObjectSelection { object_type: TransferObjectKind::Trigger, names: vec!["t1".into()] },
    ];
    let views = selected_object_names(&selections, &TransferObjectKind::View);
    assert_eq!(views, vec!["v1", "v2"]);
    assert!(selected_object_names(&selections, &TransferObjectKind::Event).is_empty());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core extracts_selected_names 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement**:

```rust
pub fn selected_object_names(selections: &[TransferObjectSelection], kind: &TransferObjectKind) -> Vec<String> {
    selections
        .iter()
        .filter(|s| &s.object_type == kind)
        .flat_map(|s| s.names.clone())
        .collect::<Vec<_>>()
}
```

Then `transfer_mysql_schema_objects`:

```rust
async fn transfer_mysql_schema_objects<F>(
    state: &AppState,
    request: &TransferRequest,
    source_pool_key: &str,
    target_pool_key: &str,
    mut progress_callback: F,
) -> Result<TransferObjectOutcome, String>
where
    F: FnMut(TransferProgress),
{
    let mut outcome = TransferObjectOutcome::default();
    let source_db = &request.source_database;
    let target_db = if request.target_database.trim().is_empty() {
        source_db.as_str()
    } else {
        request.target_database.as_str()
    };
    let order = ordered_transfer_object_kinds(
        request.objects.iter().map(|s| s.object_type).collect(),
    );
    for kind in order {
        for name in selected_object_names(&request.objects, &kind) {
            if is_cancelled(&request.transfer_id).await {
                return Err("Cancelled".to_string());
            }
            let table = format!("schema object: {name}");
            let progress = |outcome: &mut TransferObjectOutcome, status: TransferStatus, error: Option<String>| {
                progress_callback(TransferProgress {
                    transfer_id: request.transfer_id.clone(),
                    table: table.clone(),
                    table_index: request.tables.len(),
                    total_tables: request.tables.len(),
                    rows_transferred: (outcome.transferred.len() + outcome.skipped.len()) as u64,
                    total_rows: None,
                    status,
                    error,
                    terminal: false,
                });
            };
            // skip if target already has it
            let exists_sql =
                target_object_exists_sql(&DatabaseType::Mysql, target_db, &name, &kind).map_err(|e| e)?;
            let exists = execute_on_pool(state, target_pool_key, &exists_sql).await?.rows.first().is_some();
            if exists {
                outcome.skipped.push(format!("{kind:?}:{name}"));
                progress(&mut outcome, TransferStatus::Running, None);
                continue;
            }
            let query = mysql_object_source_query(&kind, source_db, &name)?;
            let result = execute_on_pool(state, source_pool_key, &query).await?;
            let raw_ddl = mysql_object_ddl_from_result(&kind, &result)?;
            let ddl = strip_mysql_definer(&raw_ddl);
            let ddl = rewrite_mysql_schema_qualifier(&ddl, source_db, target_db);
            match execute_on_pool(state, target_pool_key, &ddl).await {
                Ok(_) => {
                    outcome.transferred.push(format!("{kind:?}:{name}"));
                    progress(&mut outcome, TransferStatus::Running, None);
                }
                Err(e) => {
                    outcome.failed.push(format!("{kind:?}:{name}"));
                    progress(&mut outcome, TransferStatus::Error, Some(e));
                }
            }
        }
    }
    Ok(outcome)
}
```

Check `TransferStatus` variant names (Running/Error/TableDone/Done/Cancelled — see route usage). `is_cancelled` is in transfer.rs:4076.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core extracts_selected_names 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): mysql schema object transfer (skip existing, definer strip, schema rewrite)"
```

---

## Task 11: Oracle/Dameng schema object transfer body

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs`

- [ ] **Step 1: Write the failing test** (schema resolution for DM, where database==schema):

```rust
#[test]
fn resolves_oracle_family_source_schema() {
    // For Oracle/Dameng the metadata lookup schema is the source_schema;
    // when empty, fall back to the database (DM lists users as databases).
    assert_eq!(resolve_oracle_schema("", "HR"), "HR");
    assert_eq!(resolve_oracle_schema("HR", "db"), "HR");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core resolves_oracle_family 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement**:

```rust
fn resolve_oracle_schema(schema: &str, database: &str) -> String {
    if schema.trim().is_empty() { database.to_string() } else { schema.to_string() }
}
```

Then `transfer_oracle_schema_objects` mirroring the MySQL body: for each selected object, existence check via `target_object_exists_sql(&DatabaseType::Oracle, target_schema, name, kind)` (target_schema resolved the same way; for DM use the same ALL_OBJECTS query — Dameng supports `ALL_OBJECTS` view), DDL via `oracle_object_source_query` executed on the source pool with the source schema as query database, extract first cell, `rewrite_oracle_schema_qualifier(&ddl, source_schema, target_schema)`, execute on target. Oracle objects created through `build_executable_object_source_statements` are *not* needed here — DBMS_METADATA output is already executable; the body uses the MySQL loop shape with `execute_on_pool` and the same progress/outcome accounting.

Note: `DBMS_METADATA.GET_DDL` requires a connection whose current schema is the owner schema; the agent executes the query with `database`/`schema` params (see `oracle_agent_object_source` at schema.rs:6566 which passes both). For transfers the pools execute plain SQL; if `GET_DDL` returns no row because the current schema differs, the object transfer reports it as a failed object (acceptable for v1; note in code comment).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core resolves_oracle_family 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): oracle/dameng schema object transfer"
```

---

## Task 12: PG object transfer — per-selection filtering + skip-existing

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs` (`transfer_postgres_schema_objects` at 5020)

- [ ] **Step 1: Write the failing test** (filter helper for PG sources):

```rust
#[test]
fn filters_postgres_object_sources_by_selection() {
    let sources = vec![
        db::ObjectSource { name: "v1".into(), object_type: db::ObjectSourceKind::View, schema: Some("public".into()), source: "SELECT 1".into(), editable: None },
        db::ObjectSource { name: "v2".into(), object_type: db::ObjectSourceKind::View, schema: Some("public".into()), source: "SELECT 2".into(), editable: None },
    ];
    let selection = vec![TransferObjectSelection { object_type: TransferObjectKind::View, names: vec!["v1".into()] }];
    let filtered = filter_object_sources_by_selection(sources, &selection);
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].name, "v1");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core filters_postgres_object_sources 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `transfer_postgres_schema_objects`:

1. After fetching `object_sources`/`materialized_views`/`trigger_sources`, filter each by `selected_object_names(&request.objects, &kind)`:
   - `object_sources` (View/Procedure/Function/Sequence/…) → filter by kind-specific name lists.
   - `materialized_views` → filter by MaterializedView names.
   - `trigger_sources` → filter by Trigger names; if no Trigger selection, skip the whole trigger step (current behavior transfers triggers of selected tables — replace it with explicit selection; when `objects` is empty the function returns early anyway).
2. Skip-existing: before executing each object's DDL, run `target_object_exists_sql(&DatabaseType::Postgres, &request.target_schema, name, kind)` on the target pool; on hit, record in a `skipped` list and `continue` (no execution, no error).
3. Return `Ok(TransferObjectOutcome)` with transferred/skipped/failed populated from the loops (rename the current function's return or add a new wrapper that the executor calls; simplest: change the signature to return `Result<TransferObjectOutcome, String>` and update the route call in Task 14).

Helper `filter_object_sources_by_selection` maps `db::ObjectSourceKind` ↔ `TransferObjectKind`:

```rust
fn transfer_kind_from_object_source_kind(kind: &db::ObjectSourceKind) -> Option<TransferObjectKind> {
    use db::ObjectSourceKind as S;
    Some(match kind {
        S::View => TransferObjectKind::View,
        S::MaterializedView => TransferObjectKind::MaterializedView,
        S::Procedure => TransferObjectKind::Procedure,
        S::Function => TransferObjectKind::Function,
        S::Trigger => TransferObjectKind::Trigger,
        S::Sequence => TransferObjectKind::Sequence,
        _ => return None,
    })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core filters_postgres_object_sources 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): postgres object transfer honors selection and skips existing"
```

---

## Task 13: transfer_table honors StructureOnly (no data copy)

**Files:**
- Modify: `crates/dbx-core/src/transfer.rs` (`transfer_table` around line 4730, before the "Truncate target if overwrite mode" block)

- [ ] **Step 1: Write the failing test** — no pure unit test is feasible (async + DB); instead assert via a new pure helper:

```rust
#[test]
fn structure_only_skips_data_steps() {
    assert!(should_copy_data(&TransferContent::StructureAndData));
    assert!(should_copy_data(&TransferContent::DataOnly));
    assert!(!should_copy_data(&TransferContent::StructureOnly));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core structure_only_skips_data 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement**:

```rust
pub fn should_copy_data(content: &TransferContent) -> bool {
    !matches!(content, TransferContent::StructureOnly)
}
```

In `transfer_table`, immediately before the `// Truncate target if overwrite mode` block (line ~4730):

```rust
    // Structure-only transfer: DDL work (create table, indexes, comments) is
    // done above; skip everything data-related.
    if !should_copy_data(&request.content) {
        return Ok(0);
    }
```

Also apply the same early return at the top of the Mongo branch (`transfer_mongodb_table`): add a guard in the caller route instead — Task 14 rejects StructureOnly for Mongo sources/targets at validation time, so no change is needed inside the Mongo path. If Mongo `create_table` flow differs, validate in Task 14 tests.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-core structure_only_skips_data 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): structure-only mode skips data copy"
```

---

## Task 14: Route integration — validation, object step, summary counts

**Files:**
- Modify: `crates/dbx-web/src/routes/transfer.rs`

- [ ] **Step 1: Write the failing test** — no unit test harness exists for routes; verification is compile + manual. Skip TDD here; the compile step below is the gate.

- [ ] **Step 2: Wire validation**: replace `transfer::validate_transfer_target_table_names(&req)` (line ~63) with `transfer::validate_transfer_request(&req)`; after resolving `source_db_type`/`target_db_type` inside the spawned task, reject when `!request.objects.is_empty() && !transfer::is_same_transfer_family(&source_db_type, &target_db_type)` (terminal error via `terminal_transfer_error`), and reject `StructureOnly` when either side is Mongo (`matches!(source_db_type, DatabaseType::Mongodb) || matches!(target_db_type, ...)`).

- [ ] **Step 3: Run object transfer step** — after the table loop, replace the PG-only `transfer_postgres_schema_objects` block (lines ~327-390) with:

```rust
        let object_outcome = match transfer::transfer_schema_objects(
            &app,
            &req,
            &source_pool_key,
            &target_pool_key,
            |progress| {
                send_transfer_progress(&progress_channel, &progress);
            },
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(e) if e == "Cancelled" => { /* existing cancelled terminal block */ return; }
            Err(e) => { /* existing error terminal block with table="schema objects" */ return; }
        };
```

Keep the existing `transfer_postgres_schema_dependencies` block (enum/domain) in place — it runs before the table loop and stays PG-only.

- [ ] **Step 4: Merge skip count into the final summary**: extend the final `done` progress error text when `!object_outcome.skipped.is_empty()`: append `format!("，跳过 {} 个已存在对象", object_outcome.skipped.len())` — only when no failures; when failures exist, append to the failure message as well. Also add `outcome.transferred.len()` failures: failed object names go into `failed_tables` (they are reported per-object already via progress events; keep the aggregate simple: append `"schema objects"` to `failed_tables` when `!object_outcome.failed.is_empty()`).

- [ ] **Step 5: Compile check**

Run: `cargo check -p dbx-web 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add crates/dbx-web/src/routes/transfer.rs crates/dbx-core/src/transfer.rs
git commit -m "feat(transfer): route integration for content modes and schema objects"
```

---

## Task 15: Backend test sweep

- [ ] **Step 1: Run all transfer-related unit tests**

Run: `cargo test -p dbx-core transfer 2>&1 | tail -15`
Expected: all transfer tests pass (protocol, family, validation, existence SQL, mysql DDL helpers, ordering, selections).

- [ ] **Step 2: Run full dbx-core unit tests**

Run: `cargo test -p dbx-core 2>&1 | tail -10`
Expected: PASS (live-DB tests excluded by default; if any `#[ignore]`-less live tests fail, they are environment-dependent and were failing before this change).

- [ ] **Step 3: Commit any stragglers**

```bash
git add -A && git commit -m "test(transfer): backfill transfer unit tests" --allow-empty
```

---

## Task 16: Frontend types (tauri.ts) and transfer object capability helpers

**Files:**
- Modify: `apps/desktop/src/lib/backend/tauri.ts` (TransferRequest at 3279; types at 3275)
- Create: `apps/desktop/src/lib/database/transferObjectKinds.ts`
- Test: `apps/desktop/src/lib/database/__tests__/transferObjectKinds.spec.ts`

- [ ] **Step 1: Write the failing test**:

```ts
import { describe, expect, it } from "vitest";
import {
  transferObjectFamily,
  transferObjectKindsForDatabase,
  isSameTransferFamily,
  TransferObjectFamily,
} from "@/lib/database/transferObjectKinds";

describe("transferObjectKinds", () => {
  it("groups databases into transfer families", () => {
    expect(transferObjectFamily("mysql")).toBe(TransferObjectFamily.Mysql);
    expect(transferObjectFamily("kingbase")).toBe(TransferObjectFamily.Postgres);
    expect(transferObjectFamily("dameng")).toBe(TransferObjectFamily.Oracle);
    expect(transferObjectFamily("sqlite")).toBeUndefined();
  });

  it("returns per-family object kinds", () => {
    expect(transferObjectKindsForDatabase("mysql")).toEqual([
      "TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT",
    ]);
    expect(transferObjectKindsForDatabase("postgres")).toContain("SEQUENCE");
    expect(transferObjectKindsForDatabase("dameng")).toContain("TRIGGER");
    expect(transferObjectKindsForDatabase("sqlite")).toEqual([]);
  });

  it("detects same-family transfers", () => {
    expect(isSameTransferFamily("mysql", "mysql")).toBe(true);
    expect(isSameTransferFamily("mysql", "postgres")).toBe(false);
    expect(isSameTransferFamily("oracle", "dameng")).toBe(true);
    expect(isSameTransferFamily("postgres", "sqlite")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/desktop vitest run transferObjectKinds 2>&1 | tail -8`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `transferObjectKinds.ts` mirrors the Rust tables:

```ts
import type { DatabaseType } from "@/types/database";

export enum TransferObjectFamily {
  Mysql = "mysql",
  Postgres = "postgres",
  Oracle = "oracle",
}

export type TransferObjectKind =
  | "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE"
  | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "EVENT";

const MYSQL_KINDS: TransferObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"];
const POSTGRES_KINDS: TransferObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"];
const ORACLE_KINDS: TransferObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"];

const FAMILY_BY_DB = new Map<DatabaseType, TransferObjectFamily>([
  ["mysql", TransferObjectFamily.Mysql],
  ["postgres", TransferObjectFamily.Postgres],
  ["kingbase", TransferObjectFamily.Postgres],
  ["gaussdb", TransferObjectFamily.Postgres],
  ["kwdb", TransferObjectFamily.Postgres],
  ["opengauss", TransferObjectFamily.Postgres],
  ["oracle", TransferObjectFamily.Oracle],
  ["dameng", TransferObjectFamily.Oracle],
  ["oceanbase-oracle", TransferObjectFamily.Oracle],
]);

export function transferObjectFamily(dbType?: DatabaseType): TransferObjectFamily | undefined {
  return dbType ? FAMILY_BY_DB.get(dbType) : undefined;
}

export function isSameTransferFamily(a?: DatabaseType, b?: DatabaseType): boolean {
  const fa = transferObjectFamily(a);
  const fb = transferObjectFamily(b);
  return !!fa && fa === fb;
}

export function transferObjectKindsForDatabase(dbType?: DatabaseType): TransferObjectKind[] {
  switch (transferObjectFamily(dbType)) {
    case TransferObjectFamily.Mysql: return [...MYSQL_KINDS];
    case TransferObjectFamily.Postgres: return [...POSTGRES_KINDS];
    case TransferObjectFamily.Oracle: return [...ORACLE_KINDS];
    default: return [];
  }
}
```

Verify `DatabaseType` union includes `"kwdb"` and `"oceanbase-oracle"` in `apps/desktop/src/types/database.ts` — adjust keys to match.

- [ ] **Step 4: Extend tauri.ts types**:

```ts
export type TransferContent = "structureAndData" | "structureOnly" | "dataOnly";
export type TransferObjectKind =
  | "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE"
  | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "EVENT";

export interface TransferObjectSelection {
  objectType: TransferObjectKind;
  names: string[];
}
```

Add to `TransferRequest`:
```ts
  content: TransferContent;
  objects: TransferObjectSelection[];
```

(Keep `createTable` for wire compatibility; the dialog stops sending it — check http.ts `startDataTransferTask`/`api.TransferRequest` construction sites.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --dir apps/desktop vitest run transferObjectKinds 2>&1 | tail -8`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/database/transferObjectKinds.ts apps/desktop/src/lib/database/__tests__/transferObjectKinds.spec.ts apps/desktop/src/lib/backend/tauri.ts
git commit -m "feat(transfer): frontend transfer object kind helpers and request types"
```

---

## Task 17: i18n keys

**Files:**
- Modify: all 9 locale files under `apps/desktop/src/i18n/locales/` (zh-CN, en, zh-TW, es, it, ja, ko, pt-BR, fallback) — `transfer:` namespace (~line 3712 in zh-CN)

- [ ] **Step 1: Add keys to zh-CN.ts** (source of truth):

```ts
    content: "传输方式",
    contentStructureAndData: "结构和数据",
    contentStructureOnly: "仅结构",
    contentDataOnly: "仅数据",
    contentStructureOnlyHint: "仅创建表和对象结构，不复制数据",
    contentDataOnlyHint: "仅复制数据到已存在的目标表",
    objects: "传输对象",
    searchObjects: "搜索对象名...",
    noObjects: "暂无对象",
    objectTypeTable: "表",
    objectTypeView: "视图",
    objectTypeMaterializedView: "物化视图",
    objectTypeProcedure: "存储过程",
    objectTypeFunction: "函数",
    objectTypeTrigger: "触发器",
    objectTypeSequence: "序列",
    objectTypeEvent: "事件",
    objectDataOnlyDisabled: "仅数据模式不传输非表对象",
    objectCrossFamilyDisabled: "跨数据库类型暂不支持非表对象传输",
    objectUnsupportedDisabled: "当前数据库不支持该对象类型传输",
    skippedExistingObjects: "跳过 {count} 个已存在对象",
    dataWriteMode: "数据写入方式",
```

- [ ] **Step 2: Mirror into the other 8 locales** — en: translate; zh-TW/es/it/ja/ko/pt-BR/fallback: use zh-CN text (existing project convention for untranslated keys is fallback; check how other new keys were added historically — `fallback.ts` contains zh-CN text; add the same keys there and to each locale with English or Chinese placeholder per convention).

Verify by grep: `grep -c "contentStructureAndData" apps/desktop/src/i18n/locales/*.ts` → 9 files.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/i18n/locales/
git commit -m "feat(i18n): transfer tree and content mode keys"
```

---

## Task 18: ObjectSelectionTree component

**Files:**
- Create: `apps/desktop/src/components/transfer/ObjectSelectionTree.vue`
- Test: `apps/desktop/src/components/transfer/__tests__/ObjectSelectionTree.spec.ts`

- [ ] **Step 1: Write the failing test** — component-level logic via mounted stubs:

```ts
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ObjectSelectionTree from "@/components/transfer/ObjectSelectionTree.vue";

const groups = [
  { kind: "TABLE" as const, label: "表", items: ["a", "b"] },
  { kind: "VIEW" as const, label: "视图", items: ["v1"] },
];

function make(props: Record<string, unknown> = {}) {
  return mount(ObjectSelectionTree, {
    props: {
      groups,
      disabledGroups: [],
      modelValue: {},
      ...props,
    },
    global: { stubs: { Input: true, Button: true } },
  });
}

describe("ObjectSelectionTree", () => {
  it("renders group headers and items", () => {
    const wrapper = make();
    expect(wrapper.text()).toContain("表");
    expect(wrapper.text()).toContain("v1");
  });

  it("selects all items in a group when the header checkbox is toggled", async () => {
    const wrapper = make();
    await wrapper.findAll("[data-test='group-toggle']")[0].trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([
      { TABLE: ["a", "b"] },
    ]);
  });

  it("filters items by search text", async () => {
    const wrapper = make();
    await wrapper.find("[data-test='search']").setValue("v1");
    expect(wrapper.text()).toContain("v1");
    expect(wrapper.text()).not.toContain("a");
  });

  it("renders disabled groups with a hint", () => {
    const wrapper = make({ disabledGroups: ["VIEW"], disabledHints: { VIEW: "原因" } });
    const group = wrapper.find("[data-test='group-VIEW']");
    expect(group.classes()).toContain("opacity-50");
    expect(group.text()).toContain("原因");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/desktop vitest run ObjectSelectionTree 2>&1 | tail -8`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement the component** — props:

```ts
interface ObjectTreeGroup {
  kind: TransferObjectKind;
  label: string;
  items: string[];
}

props: {
  groups: ObjectTreeGroup[];
  disabledGroups: TransferObjectKind[];   // kinds rendered but greyed out
  disabledHints: Record<string, string>;  // kind → reason
  modelValue: Record<string, string[]>;   // kind → selected names
  search: string;
  loading: boolean;
}
```

Template: per group — header row (CheckSquare/Square icon, label, count `(n/m)`, expand chevron) + collapsible item list (checkbox rows) with `data-test` attributes. Emits `update:modelValue` with the new selection object on every toggle (group header toggles all/none of the group's items). Search filter applies to item rows. Disabled groups render with `opacity-50` and the hint text; their checkboxes are disabled. A top-level select-all button operates across enabled groups.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --dir apps/desktop vitest run ObjectSelectionTree 2>&1 | tail -8`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/transfer/ObjectSelectionTree.vue apps/desktop/src/components/transfer/__tests__/ObjectSelectionTree.spec.ts
git commit -m "feat(transfer): object selection tree component"
```

---

## Task 19: DataTransferDialog integration

**Files:**
- Modify: `apps/desktop/src/components/transfer/DataTransferDialog.vue`

- [ ] **Step 1: Write the failing test** — extend `apps/desktop/src/components/transfer/__tests__/DataTransferDialog.spec.ts`:

```ts
it("sends content and objects in the transfer request", async () => {
  // mount with a stub api.startDataTransferTask capturing the request
  // select a table + a view via the tree, choose "structure only",
  // assert request.content === "structureOnly",
  // request.objects contains { objectType: "VIEW", names: ["v1"] }
});
```

Check how the existing spec stubs `api` (`vi.mock("@/lib/backend/api")`? verify from the existing spec file) and follow the same pattern.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/desktop vitest run DataTransferDialog 2>&1 | tail -8`
Expected: FAIL — request has no content/objects.

- [ ] **Step 3: Implement** — in `DataTransferDialog.vue`:

1. State: replace `sourceTables: string[]` + `selectedTables: Set<string>` with `objectGroups: Record<TransferObjectKind, string[]>` and `selectedObjects: Record<TransferObjectKind, Set<string>>` (keep a `selectedTables` computed derived from the TABLE group for minimal churn in the request builder and target-tree refresh logic).
2. Data loading: `loadObjects()` calls `api.listObjects(sourceConnectionId, sourceDatabase, schema, [kind], undefined, undefined, undefined, catalog)` per kind from `transferObjectKindsForDatabase(sourceDbType)` and fills groups. Keep the existing `table_type` filtering for the TABLE group (`TABLE`/`BASE TABLE`).
3. Mode: `transferContent = ref<api.TransferContent>("structureAndData")`; radio row with 3 options + hints (`contentStructureOnlyHint`/`contentDataOnlyHint`); when `dataOnly`, compute `disabledGroups = non-table kinds` with hint `objectDataOnlyDisabled`; when `!isSameTransferFamily(sourceDbType, targetDbType)`, all non-table kinds disabled with `objectCrossFamilyDisabled`; kinds missing from `transferObjectKindsForDatabase(source)` are not rendered.
4. Request builder: `content: transferContent.value`, `objects: non-table kinds → { objectType, names: [...selected] }`, drop `createTable` (or send `createTable: transferContent.value !== "dataOnly"` for backward compat — check http.ts / tauri command signature; prefer sending both fields, frontend stays in control).
5. Data-write-mode select (`transferMode`) visible only when content includes data (`structureAndData` or `dataOnly`); hidden for `structureOnly`.
6. Ownership preview: only trigger when `content === "structureAndData"` (existing `createTable.value` condition at line ~471 becomes `transferContent.value !== "dataOnly"` — verify ownership applies to structure creation; keep current condition semantics: it ran when createTable was true, i.e. now `content !== "dataOnly"`).
7. Remove the `createTable` checkbox row; remove `toggleSelectAll`/`filteredTables` table-only logic in favor of the tree.
8. Keep `prefillTables` behavior: prefill maps into the TABLE group selection after load.
9. `shouldRefreshTargetTree` (line ~451): refresh when `content !== "dataOnly"`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --dir apps/desktop vitest run DataTransferDialog 2>&1 | tail -8`
Expected: PASS (old + new tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --dir apps/desktop typecheck 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/transfer/
git commit -m "feat(transfer): dialog tree selection and transfer content modes"
```

---

## Task 20: Final verification and review

- [ ] **Step 1: Backend unit tests**

Run: `cargo test -p dbx-core 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 2: Frontend tests**

Run: `pnpm --dir apps/desktop vitest run 2>&1 | tail -8`
Expected: PASS (including the pre-existing 30 tests from databaseCapabilities/databaseFeatureSupport).

- [ ] **Step 3: Frontend typecheck**

Run: `pnpm --dir apps/desktop typecheck 2>&1 | tail -8`
Expected: no errors.

- [ ] **Step 4: Manual smoke (optional, needs running app)**: open transfer dialog with MySQL source → tree shows 表/视图/存储过程/函数/触发器/事件; DM source → 表/视图/存储过程/函数/触发器/序列/物化视图; cross-family target → non-table groups disabled with hint; 仅数据 → non-table disabled; 仅结构 → data write mode hidden.

- [ ] **Step 5: Verify git state**

Run: `git status --short && git log --oneline -15`
Expected: only feature commits; docs/superpowers untracked.

---

## Notes / Risks

- `DatabaseType` variant names must be verified against `crates/dbx-core/src/models/connection.rs` (Gaussdb/Kwdb/OceanbaseOracle) and `apps/desktop/src/types/database.ts` (kwdb/oceanbase-oracle) before compiling Task 2 / Task 16.
- `TransferRequest` literal construction sites: `transfer.rs` tests (~line 5364) and `crates/dbx-core/tests/live_postgres_transfer.rs` — add the two new fields at every site.
- `transfer_postgres_schema_objects` signature change (return `TransferObjectOutcome`) touches the route call in Task 14; keep both in the same commit so the crate stays green between commits only if the route is updated in the same commit — if not, keep the old signature and add a wrapper.
- MySQL `SHOW CREATE` DDL column index differs by kind (view=1, routine=2) — reuse `schema::mysql_object_source_ddl_column_index` semantics in `mysql_object_ddl_from_result`.
- DM `ALL_OBJECTS` availability: Dameng 8 supports `ALL_OBJECTS`; if a customer version lacks it, fall back to `SYS.SYSOBJECTS` (flagged as a follow-up).
- `docs/superpowers/` must never be committed (`git add -f` avoided; it is gitignored).
