use std::collections::HashSet;
use std::fmt::Write;

use crate::recovery::{valid_charset, valid_decimal};
use crate::schema::valid_identifier;
use crate::{Cell, ColumnSchema, RecoveryPlan, TableSchema, ValueKind};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn ident(name: &str) -> Result<String, String> {
    if !valid_identifier(name) {
        return Err("invalid SQL identifier".into());
    }
    Ok(format!("`{}`", name.replace('`', "``")))
}

fn qualified(table: &TableSchema) -> Result<String, String> {
    Ok(format!("{}.{}", ident(&table.database)?, ident(&table.table)?))
}

fn literal(cell: &Cell) -> Result<String, String> {
    Ok(match cell {
        Cell::Null => "NULL".into(),
        Cell::Integer(number) => number.to_string(),
        Cell::Binary(bytes) => format!("X'{}'", hex(bytes)),
        Cell::Text { bytes, charset } if valid_charset(charset) => {
            let charset = if charset == "utf8" { "utf8mb3" } else { charset };
            format!("CONVERT(X'{}' USING {charset})", hex(bytes))
        }
        Cell::Decimal(value) if valid_decimal(value) => value.clone(),
        Cell::Json(value) => {
            serde_json::from_str::<serde_json::Value>(value).map_err(|_| "invalid JSON literal")?;
            format!("CAST(CONVERT(X'{}' USING utf8mb4) AS JSON)", hex(value.as_bytes()))
        }
        Cell::DateTime(value) | Cell::Time(value) if crate::temporal::valid_literal(value) => format!("'{value}'"),
        Cell::Timestamp(value) if valid_decimal(value) && !value.starts_with('-') => format!("FROM_UNIXTIME({value})"),
        _ => return Err("invalid or unsupported SQL literal".into()),
    })
}

fn predicate(table: &TableSchema, row: &[Cell], indexes: &[usize]) -> Result<String, String> {
    if row.len() != table.columns.len() || indexes.is_empty() {
        return Err("invalid SQL guard row shape".into());
    }
    indexes
        .iter()
        .map(|&i| {
            let column = table.columns.get(i).ok_or("invalid key ordinal")?;
            let name = format!("dbx_row.{}", ident(&column.name)?);
            // Compare raw bytes, not case/accent-insensitive text collation equality.
            match &row[i] {
                Cell::Binary(bytes) | Cell::Text { bytes, .. } => {
                    Ok(format!("CAST({name} AS BINARY) <=> X'{}'", hex(bytes)))
                }
                cell => Ok(format!("{name} <=> {}", literal(cell)?)),
            }
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|parts| parts.join(" AND "))
}

fn require(out: &mut String, condition: &str, message: &str) {
    writeln!(out, "  IF {condition} THEN").unwrap();
    writeln!(out, "    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DBX binlog: {message}';").unwrap();
    writeln!(out, "  END IF;").unwrap();
}

fn column_condition(column: &ColumnSchema) -> Result<String, String> {
    let (data_type, extra) = match &column.kind {
        ValueKind::Integer => {
            let data_type = match column.wire_type {
                1 => "tinyint",
                2 => "smallint",
                9 => "mediumint",
                3 => "int",
                8 => "bigint",
                _ => return Err("unsupported integer type".into()),
            };
            (
                data_type.to_owned(),
                format!(" AND (LOCATE('unsigned', LOWER(COLUMN_TYPE)) > 0) = {}", u8::from(column.unsigned)),
            )
        }
        ValueKind::Decimal { precision, scale } => {
            if *precision == 0 || *precision > 65 || scale > precision || *scale > 30 {
                return Err("invalid DECIMAL schema".into());
            }
            ("decimal".into(), format!(" AND NUMERIC_PRECISION = {precision} AND NUMERIC_SCALE = {scale} AND (LOCATE('unsigned', LOWER(COLUMN_TYPE)) > 0) = {}", u8::from(column.unsigned)))
        }
        ValueKind::Json => ("json".into(), String::new()),
        ValueKind::DateTime { precision } | ValueKind::Timestamp { precision } | ValueKind::Time { precision } => {
            let data_type = match column.kind {
                ValueKind::DateTime { .. } => "datetime",
                ValueKind::Timestamp { .. } => "timestamp",
                _ => "time",
            };
            if *precision > 6 {
                return Err("invalid temporal precision".into());
            }
            (data_type.into(), format!(" AND DATETIME_PRECISION = {precision}"))
        }
        ValueKind::Binary | ValueKind::Text { .. } => {
            let binary = matches!(column.kind, ValueKind::Binary);
            let (data_type, length) = match (column.wire_type, column.wire_metadata.as_slice()) {
                (15, [low, high]) => {
                    (if binary { "varbinary" } else { "varchar" }, Some(u16::from_le_bytes([*low, *high])))
                }
                (252, [width]) => (
                    match (binary, width) {
                        (true, 1) => "tinyblob",
                        (true, 2) => "blob",
                        (true, 3) => "mediumblob",
                        (true, 4) => "longblob",
                        (false, 1) => "tinytext",
                        (false, 2) => "text",
                        (false, 3) => "mediumtext",
                        (false, 4) => "longtext",
                        _ => return Err("unsupported BLOB/TEXT length".into()),
                    },
                    None,
                ),
                _ => return Err("unsupported character/binary wire type".into()),
            };
            let mut extra = length.map(|n| format!(" AND CHARACTER_OCTET_LENGTH = {n}")).unwrap_or_default();
            if let ValueKind::Text { charset } = &column.kind {
                if !valid_charset(charset) {
                    return Err("unsupported charset".into());
                }
                extra.push_str(if charset == "utf8" { " AND CHARACTER_SET_NAME IN ('utf8','utf8mb3')" } else { "" });
                if charset != "utf8" {
                    write!(extra, " AND CHARACTER_SET_NAME = '{charset}'").unwrap();
                }
            } else {
                extra.push_str(" AND CHARACTER_SET_NAME IS NULL");
            }
            (data_type.to_owned(), extra)
        }
    };
    Ok(format!("CAST(COLUMN_NAME AS BINARY) = X'{}' AND DATA_TYPE = '{data_type}' AND IS_NULLABLE = '{}' AND GENERATION_EXPRESSION = ''{extra}", hex(column.name.as_bytes()), if column.nullable { "YES" } else { "NO" }))
}

fn preflight(out: &mut String, table: &TableSchema) -> Result<(), String> {
    let name = qualified(table)?;
    let scope = format!(
        "CAST(TABLE_SCHEMA AS BINARY) = X'{}' AND CAST(TABLE_NAME AS BINARY) = X'{}'",
        hex(table.database.as_bytes()),
        hex(table.table.as_bytes())
    );
    // Open the actual table inside the transaction before checking its metadata.
    writeln!(out, "  SELECT COUNT(*) INTO v_count FROM {name} WHERE 1 = 0 FOR UPDATE;").unwrap();
    writeln!(out, "  SELECT COUNT(*) INTO v_count FROM information_schema.TABLES WHERE {scope} AND ENGINE = 'InnoDB' AND TABLE_TYPE = 'BASE TABLE';").unwrap();
    require(out, "v_count <> 1", "target must be an InnoDB base table");
    writeln!(out, "  SELECT COUNT(*) INTO v_count FROM information_schema.COLUMNS WHERE {scope};").unwrap();
    require(out, &format!("v_count <> {}", table.columns.len()), "target column count changed");
    for (i, column) in table.columns.iter().enumerate() {
        writeln!(out, "  SELECT COUNT(*) INTO v_count FROM information_schema.COLUMNS WHERE {scope} AND ORDINAL_POSITION = {} AND {};", i + 1, column_condition(column)?).unwrap();
        require(out, "v_count <> 1", "target column definition changed");
    }
    writeln!(
        out,
        "  SELECT COUNT(*) INTO v_count FROM information_schema.STATISTICS WHERE {scope} AND INDEX_NAME = 'PRIMARY';"
    )
    .unwrap();
    require(out, &format!("v_count <> {}", table.primary_key.len()), "target primary key changed");
    for (i, &ordinal) in table.primary_key.iter().enumerate() {
        let column = table.columns.get(ordinal).ok_or("invalid primary key ordinal")?;
        writeln!(out, "  SELECT COUNT(*) INTO v_count FROM information_schema.STATISTICS WHERE {scope} AND INDEX_NAME = 'PRIMARY' AND SEQ_IN_INDEX = {} AND CAST(COLUMN_NAME AS BINARY) = X'{}' AND SUB_PART IS NULL;", i + 1, hex(column.name.as_bytes())).unwrap();
        require(out, "v_count <> 1", "target primary key changed");
    }
    writeln!(out, "  SELECT COUNT(*) INTO v_count FROM information_schema.TRIGGERS WHERE CAST(EVENT_OBJECT_SCHEMA AS BINARY) = X'{}' AND CAST(EVENT_OBJECT_TABLE AS BINARY) = X'{}';", hex(table.database.as_bytes()), hex(table.table.as_bytes())).unwrap();
    require(out, "v_count <> 0", "target has triggers");
    writeln!(out, "  SELECT COUNT(*) INTO v_count FROM information_schema.KEY_COLUMN_USAGE WHERE ({scope} AND REFERENCED_TABLE_NAME IS NOT NULL) OR (CAST(REFERENCED_TABLE_SCHEMA AS BINARY) = X'{}' AND CAST(REFERENCED_TABLE_NAME AS BINARY) = X'{}');", hex(table.database.as_bytes()), hex(table.table.as_bytes())).unwrap();
    require(out, "v_count <> 0", "target has foreign key dependencies");
    Ok(())
}

pub(crate) fn render(plan: &RecoveryPlan) -> Result<String, String> {
    let first = plan.transactions.first().and_then(|tx| tx.actions.first()).ok_or("empty recovery plan")?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|error| format!("cannot generate helper identity: {error}"))?;
    let routine = format!("{}.{}", ident(&first.table.database)?, ident(&format!("_dbx_binlog_{}", hex(&nonce)))?);
    let saved_mode = format!("@dbx_saved_{}", hex(&nonce));
    let mut out = String::from(
        "-- DBX binlog recovery: MANUAL REVIEW REQUIRED. No automatic execution.\n\
-- Use a fresh dedicated autocommit session and STOP ON FIRST ERROR.\n\
-- Requires CREATE/EXECUTE/ALTER ROUTINE privileges and full metadata visibility\n\
-- (including all triggers and incoming/outgoing foreign keys). Independently\n\
-- confirm no triggers/FKs exist: privilege-filtered metadata is not proof.\n\
-- Check current schema/data and take a backup before manually running this file.\n\
-- Each inverse transaction commits separately. Later failure DOES NOT undo\n\
-- previously committed inverse transactions. Do not retry blindly.\n\
-- Helper DDL implicitly commits: never use a session with existing work.\n\
-- If CALL fails and execution stops, manually DROP the named helper afterward.\n\
-- If CREATE fails, discard this dedicated session or restore its SQL mode.\n",
    );
    // MySQL captures sql_mode at CREATE PROCEDURE, not at CALL.
    writeln!(out, "SET {saved_mode} = @@session.sql_mode;\nSET SESSION sql_mode = CONCAT_WS(',',NULLIF(@@session.sql_mode,''),'STRICT_ALL_TABLES','NO_AUTO_VALUE_ON_ZERO');\nDELIMITER $$").unwrap();
    writeln!(out, "CREATE PROCEDURE {routine}()\nSQL SECURITY INVOKER\nBEGIN\n  DECLARE v_count BIGINT UNSIGNED DEFAULT 0;\n  DECLARE v_tx_active BOOLEAN DEFAULT FALSE;\n  DECLARE v_saved_zone VARCHAR(64) DEFAULT @@session.time_zone;\n  DECLARE EXIT HANDLER FOR SQLWARNING\n  BEGIN\n    IF v_tx_active THEN ROLLBACK; END IF;\n    SET SESSION time_zone = v_saved_zone;\n    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DBX binlog: SQL warning during recovery';\n  END;\n  DECLARE EXIT HANDLER FOR SQLEXCEPTION\n  BEGIN\n    IF v_tx_active THEN ROLLBACK; END IF;\n    SET SESSION time_zone = v_saved_zone;\n    RESIGNAL;\n  END;").unwrap();
    require(&mut out, "@@session.autocommit <> 1", "dedicated autocommit session required");
    require(&mut out, "FIND_IN_SET('NO_AUTO_VALUE_ON_ZERO', @@session.sql_mode) = 0 OR FIND_IN_SET('STRICT_ALL_TABLES', @@session.sql_mode) = 0", "strict zero-preserving routine mode required");
    out.push_str("  SET SESSION time_zone = '+00:00';\n");
    for tx in &plan.transactions {
        writeln!(out, "  -- inverse transaction {}\n  SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;\n  START TRANSACTION;\n  SET v_tx_active = TRUE;", tx.start_position).unwrap();
        let mut checked = HashSet::new();
        for action in &tx.actions {
            if checked.insert((&action.table.database, &action.table.table)) {
                preflight(&mut out, &action.table)?;
            }
        }
        for action in &tx.actions {
            let table = &action.table;
            let name = qualified(table)?;
            let all: Vec<_> = (0..table.columns.len()).collect();
            if let Some(expected) = &action.expected {
                let guard = predicate(table, expected, &all)?;
                writeln!(out, "  SELECT COUNT(*) INTO v_count FROM {name} AS dbx_row WHERE {guard} FOR UPDATE;")
                    .unwrap();
                require(&mut out, "v_count <> 1", "expected post-image missing or changed");
                if action.restore.as_ref() == Some(expected) {
                    continue;
                }
                if let Some(restore) = &action.restore {
                    if restore.len() != table.columns.len() {
                        return Err("invalid restoration row shape".into());
                    }
                    let assignments = table
                        .columns
                        .iter()
                        .zip(restore)
                        .map(|(c, v)| Ok(format!("dbx_row.{} = {}", ident(&c.name)?, literal(v)?)))
                        .collect::<Result<Vec<_>, String>>()?
                        .join(", ");
                    writeln!(out, "  UPDATE {name} AS dbx_row SET {assignments} WHERE {guard};").unwrap();
                } else {
                    writeln!(out, "  DELETE FROM {name} AS dbx_row WHERE {guard};").unwrap();
                }
            } else if let Some(restore) = &action.restore {
                let key = predicate(table, restore, &table.primary_key)?;
                writeln!(out, "  SELECT COUNT(*) INTO v_count FROM {name} AS dbx_row WHERE {key} FOR UPDATE;").unwrap();
                require(&mut out, "v_count <> 0", "primary key already exists");
                let columns = table.columns.iter().map(|c| ident(&c.name)).collect::<Result<Vec<_>, _>>()?.join(", ");
                let values = restore.iter().map(literal).collect::<Result<Vec<_>, _>>()?.join(", ");
                writeln!(out, "  INSERT INTO {name} ({columns}) VALUES ({values});").unwrap();
            } else {
                return Err("inverse action has no image".into());
            }
            require(&mut out, "ROW_COUNT() <> 1", "unexpected affected-row count");
            if let Some(restored) = &action.restore {
                let guard = predicate(table, restored, &all)?;
                writeln!(out, "  SELECT COUNT(*) INTO v_count FROM {name} AS dbx_row WHERE {guard} FOR UPDATE;")
                    .unwrap();
                require(&mut out, "v_count <> 1", "restored image mismatch");
            } else if let Some(deleted) = &action.expected {
                let key = predicate(table, deleted, &table.primary_key)?;
                writeln!(out, "  SELECT COUNT(*) INTO v_count FROM {name} AS dbx_row WHERE {key} FOR UPDATE;").unwrap();
                require(&mut out, "v_count <> 0", "deleted row still exists");
            }
        }
        out.push_str("  COMMIT;\n  SET v_tx_active = FALSE;\n");
    }
    writeln!(out, "  SET SESSION time_zone = v_saved_zone;\nEND$$\nSET SESSION sql_mode = {saved_mode}$$\nSET {saved_mode} = NULL$$\nCALL {routine}()$$\nDROP PROCEDURE {routine}$$\nDELIMITER ;").unwrap();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_utf8_schema_renders_an_explicit_utf8mb3_charset() {
        let value = Cell::Text { bytes: b"text".to_vec(), charset: "utf8".into() };
        assert_eq!(literal(&value).unwrap(), "CONVERT(X'74657874' USING utf8mb3)");
    }

    #[test]
    fn refuses_injected_or_approximate_literals() {
        for value in ["1e3", "1; DROP TABLE t", "NaN", "1..2", ".5"] {
            assert!(literal(&Cell::Decimal(value.into())).is_err());
        }
        assert!(literal(&Cell::Text { bytes: vec![], charset: "utf8mb4); DROP TABLE t".into() }).is_err());
    }
}
