mod common;
use common::*;
use dbx_binlog as dbx_mysql_binlog_probe;
use dbx_binlog::{inspect, MAX_EVENT_BYTES};
use mysql_common::{binlog::value::BinlogValue, value::Value};
use std::io::Cursor;

#[test]
fn reads_format_description_and_clean_eof() {
    let bytes = log();
    let result = run(&bytes).unwrap();
    assert_eq!(result.events, 1);
    assert_eq!(result.end_position, bytes.len() as u64);
    assert_eq!(result.server_version, "8.0.27");
}

#[test]
fn rejects_invalid_or_missing_format_description() {
    for bytes in [vec![], b"oops".to_vec(), b"\xfebin".to_vec()] {
        assert!(run(&bytes).is_err());
    }
    let mut bytes = b"\xfebin".to_vec();
    bytes.extend(event(16, &1u64.to_le_bytes(), 4));
    assert!(run(&bytes).unwrap_err().to_string().contains("format"));
}

#[test]
fn rejects_truncated_final_header_and_body() {
    let base = log();
    let tail = event(16, &1u64.to_le_bytes(), base.len());
    for len in 1..tail.len() {
        let mut bytes = base.clone();
        bytes.extend_from_slice(&tail[..len]);
        assert!(run(&bytes).is_err(), "accepted truncated event length {len}");
    }
}

#[test]
fn rejects_invalid_sizes_before_allocating_body() {
    for size in [0, 18, MAX_EVENT_BYTES as u32 + 1, u32::MAX] {
        let mut bytes = log();
        let mut header = [0u8; 19];
        header[4] = 16;
        header[9..13].copy_from_slice(&size.to_le_bytes());
        bytes.extend_from_slice(&header);
        assert!(run(&bytes).unwrap_err().to_string().contains("size"));
    }
}

#[test]
fn rejects_corrupt_checksums_and_positions() {
    let base = log();
    let mut tail = event(16, &1u64.to_le_bytes(), base.len());
    tail[19] ^= 1;
    let mut bytes = base.clone();
    bytes.extend_from_slice(&tail);
    assert!(run(&bytes).unwrap_err().to_string().contains("checksum"));

    let mut tail = event(16, &1u64.to_le_bytes(), base.len() + 1);
    bytes = base;
    bytes.append(&mut tail);
    assert!(run(&bytes).unwrap_err().to_string().contains("position"));
}

#[test]
fn handles_short_reads_without_loading_whole_file() {
    let bytes = log();
    assert_eq!(inspect(Chunked(&bytes), |_| {}).unwrap().events, 1);
}

#[test]
fn decodes_write_update_delete_without_losing_bytes_nulls_or_u64_precision() {
    let mut bytes = with_table();
    let old = image(u64::MAX, &[0xff, 0, 0x27, 0x5c], None);
    let new = image(u64::MAX - 1, b"after", Some(-123));
    let mut write = row_prefix(7);
    write.extend_from_slice(&old);
    append(&mut bytes, 30, &write);
    let mut update = row_prefix(7);
    update.push(7);
    update.extend_from_slice(&old);
    update.extend_from_slice(&new);
    append(&mut bytes, 31, &update);
    let mut delete = row_prefix(7);
    delete.extend_from_slice(&new);
    append(&mut bytes, 32, &delete);
    append(&mut bytes, 16, &42u64.to_le_bytes());

    let mut changes = Vec::new();
    let summary = inspect(Cursor::new(&bytes), |row| changes.push(row)).unwrap();
    assert_eq!(summary.rows, 3);
    assert_eq!(summary.commits, 1);
    assert_eq!(summary.partial_rows, 0);
    assert_eq!(summary.unsupported_events, 0);
    assert_eq!(changes.len(), 3);
    assert!(changes.iter().all(|row| row.full_image && row.has_signedness));
    assert!(changes.iter().all(|row| !row.has_column_names));
    assert_eq!(changes[0].database, b"test");
    assert_eq!(changes[0].table, b"items");
    assert!(changes[0].before.is_none());
    let row = changes[0].after.as_ref().unwrap();
    assert_eq!(row.as_ref(0), Some(&BinlogValue::Value(Value::UInt(u64::MAX))));
    assert_eq!(row.as_ref(1), Some(&BinlogValue::Value(Value::Bytes(vec![0xff, 0, 0x27, 0x5c]))));
    assert_eq!(row.as_ref(2), Some(&BinlogValue::Value(Value::NULL)));
    assert_eq!(changes[1].before.as_ref(), changes[0].after.as_ref());
    assert_eq!(changes[1].after.as_ref(), changes[2].before.as_ref());
    assert_eq!(changes[1].after.as_ref().unwrap().as_ref(2), Some(&BinlogValue::Value(Value::Int(-123))));
    assert!(changes[2].after.is_none());
    assert!(changes[0].position < changes[1].position);
    assert!(changes[1].position < changes[2].position);
    assert_eq!(changes[1].before_columns, [0, 1, 2]);
    assert_eq!(changes[1].after_columns, [0, 1, 2]);
}

#[test]
fn preserves_partial_image_column_ordinals_instead_of_inventing_nulls() {
    let mut bytes = with_table();
    let mut update = row_prefix(1); // before: only BIGINT
    update.push(2); // after: only BLOB
    update.push(0); // before NULL bitmap
    update.extend_from_slice(&9u64.to_le_bytes());
    update.extend_from_slice(&[0, 1, 0xff]); // after NULL bitmap + BLOB
    append(&mut bytes, 31, &update);
    let mut changes = Vec::new();
    let summary = inspect(Cursor::new(&bytes), |row| changes.push(row)).unwrap();
    assert_eq!(summary.partial_rows, 1);
    let row = &changes[0];
    assert!(!row.full_image);
    assert_eq!(row.before_columns, [0]);
    assert_eq!(row.after_columns, [1]);
    assert_eq!(row.before.as_ref().unwrap().len(), 1);
    assert_eq!(row.after.as_ref().unwrap().as_ref(0), Some(&BinlogValue::Value(Value::Bytes(vec![0xff]))));
}

#[test]
fn rejects_rows_without_a_table_map() {
    let mut bytes = log();
    let mut write = row_prefix(7);
    write.extend(image(1, b"x", None));
    append(&mut bytes, 30, &write);
    assert!(run(&bytes).unwrap_err().to_string().contains("table map"));
}

#[test]
fn reports_unsupported_events_instead_of_silently_ignoring_them() {
    let mut bytes = log();
    let position = bytes.len() as u64;
    append(&mut bytes, 28, b"not an ordinary DML event"); // IGNORABLE_EVENT
    let summary = run(&bytes).unwrap();
    assert_eq!(summary.unsupported_events, 1);
    assert_eq!(summary.diagnostics[0].position, position);
    assert_eq!(summary.diagnostics[0].event_type, 28);
}

#[test]
fn bounds_unsupported_diagnostics_in_a_long_stream() {
    let mut bytes = log();
    for _ in 0..100 {
        append(&mut bytes, 28, b"unsupported");
    }
    let summary = run(&bytes).unwrap();
    assert_eq!(summary.unsupported_events, 100);
    assert!(summary.diagnostics.len() <= 32);
    assert!(!summary.diagnostics.is_empty());
}

#[test]
fn rejects_duplicate_format_description() {
    let mut bytes = log();
    let fde = bytes[19 + 4..bytes.len() - 4].to_vec();
    append(&mut bytes, 15, &fde);
    assert!(run(&bytes).unwrap_err().to_string().contains("duplicate"));
}

#[test]
fn allows_the_mutable_in_use_flag_in_the_format_description() {
    let mut bytes = log();
    bytes[4 + 17] |= 1;
    assert_eq!(run(&bytes).unwrap().events, 1);
}

#[test]
fn preserves_sparse_multibyte_bitmaps_nulls_and_multiple_rows() {
    let mut bytes = log();
    let mut table = vec![1, 0, 0, 0, 0, 0, 0, 0];
    table.extend_from_slice(b"\x04test\0\x05items\0");
    table.push(10);
    table.extend_from_slice(&[1; 10]); // ten signed TINYINT columns
    table.extend_from_slice(&[0, 0xff, 0x03, 1, 2, 0, 0]); // no type metadata; nullable; signedness
    append(&mut bytes, 19, &table);
    let mut update = row_prefix(1);
    update[10] = 10;
    update.extend_from_slice(&[3, 2, 1]); // before 0,8,9; after 1,8
    update.extend_from_slice(&[2, 7, 9, 2, 5, 0, 10, 11, 12, 1, 13]);
    append(&mut bytes, 31, &update);
    let mut changes = Vec::new();
    let summary = inspect(Cursor::new(bytes), |row| changes.push(row)).unwrap();
    assert_eq!(summary.rows, 2);
    assert_eq!(summary.partial_rows, 2);
    for row in &changes {
        assert_eq!(row.before_columns, [0, 8, 9]);
        assert_eq!(row.after_columns, [1, 8]);
    }
    assert_eq!(changes[0].before.as_ref().unwrap().as_ref(1), Some(&BinlogValue::Value(Value::NULL)));
    assert_eq!(changes[0].after.as_ref().unwrap().as_ref(0), Some(&BinlogValue::Value(Value::Int(5))));
    assert_eq!(changes[1].before.as_ref().unwrap().as_ref(2), Some(&BinlogValue::Value(Value::Int(12))));
    assert_eq!(changes[1].after.as_ref().unwrap().as_ref(0), Some(&BinlogValue::Value(Value::NULL)));
    assert_eq!(changes[1].after.as_ref().unwrap().as_ref(1), Some(&BinlogValue::Value(Value::Int(13))));
}

#[test]
fn propagates_decoder_errors_for_a_complete_frame_with_a_truncated_row() {
    let mut bytes = with_table();
    let mut write = row_prefix(7);
    write.extend_from_slice(&[0, 1, 2, 3]); // row claims a BIGINT but has only three value bytes
    append(&mut bytes, 30, &write); // frame length, position and checksum remain valid
    assert!(run(&bytes).is_err());
}

#[test]
fn collects_complete_transactions_and_hashes_the_entire_file() {
    let mut bytes = with_table();
    let start = bytes.len() as u64;
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 1);
    append(&mut bytes, 16, &42u64.to_le_bytes());
    let end = bytes.len() as u64;
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 2);
    query(&mut bytes, b"ROLLBACK");
    let parsed = dbx_mysql_binlog_probe::read_log(Cursor::new(&bytes)).unwrap();
    assert_eq!(parsed.transactions().len(), 1);
    assert_eq!(parsed.transactions()[0].start_position, start);
    assert_eq!(parsed.transactions()[0].end_position, end);
    assert_eq!(parsed.transactions()[0].rows.len(), 1);
    assert_eq!(parsed.sha256().len(), 64);
    let mut changed = bytes;
    query(&mut changed, b"BEGIN");
    query(&mut changed, b"COMMIT");
    assert_ne!(parsed.sha256(), dbx_mysql_binlog_probe::read_log(Cursor::new(changed)).unwrap().sha256());
}

#[test]
fn refuses_incomplete_nested_or_orphan_transactions() {
    for case in 0..4 {
        let mut bytes = with_table();
        match case {
            0 => {
                query(&mut bytes, b"BEGIN");
                write_row(&mut bytes, 1);
            }
            1 => {
                query(&mut bytes, b"BEGIN");
                query(&mut bytes, b"BEGIN");
            }
            2 => write_row(&mut bytes, 1),
            _ => append(&mut bytes, 16, &42u64.to_le_bytes()),
        }
        assert!(dbx_mysql_binlog_probe::read_log(Cursor::new(bytes)).is_err(), "case {case}");
    }
}

#[test]
fn retains_gtid_identity_and_commit_time() {
    let mut bytes = with_table();
    let start = bytes.len() as u64;
    let mut gtid = vec![0];
    gtid.extend_from_slice(&[0x11; 16]);
    gtid.extend_from_slice(&7u64.to_le_bytes());
    append(&mut bytes, 33, &gtid);
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 1);
    query(&mut bytes, b"COMMIT");
    let parsed = dbx_mysql_binlog_probe::read_log(Cursor::new(bytes)).unwrap();
    assert_eq!(parsed.transactions()[0].start_position, start);
    assert_eq!(parsed.transactions()[0].timestamp, 1_700_000_000);
    assert_eq!(parsed.transactions()[0].gtid.as_deref(), Some("11111111-1111-1111-1111-111111111111:7"));
}

#[test]
fn filters_by_whole_transactions_and_validates_ranges() {
    use dbx_mysql_binlog_probe::{read_log, TransactionFilter};
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 1);
    // Both rows are deliberately returned, not just one matching event.
    write_row(&mut bytes, 2);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let selected = parsed
        .matching_transactions(&TransactionFilter {
            database: Some("test".into()),
            table: Some("items".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].rows.len(), 2);
    assert!(parsed
        .matching_transactions(&TransactionFilter { table: Some("other".into()), ..Default::default() })
        .unwrap()
        .is_empty());
    assert!(parsed
        .matching_transactions(&TransactionFilter {
            from_position: Some(10),
            to_position: Some(5),
            ..Default::default()
        })
        .is_err());
    assert!(parsed
        .matching_transactions(&TransactionFilter { from_time: Some(1_700_000_001), ..Default::default() })
        .unwrap()
        .is_empty());
}

#[test]
fn requires_file_bound_historical_schema_and_reliable_named_primary_keys() {
    use dbx_mysql_binlog_probe::{plan_recovery, read_log};
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, u64::MAX);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let start = parsed.transactions()[0].start_position;
    let schema = snapshot(&parsed);
    assert!(plan_recovery(&parsed, &schema, &[start]).is_ok());
    for case in 0..11 {
        let mut bad = schema.clone();
        match case {
            0 => bad.binlog_sha256 = "0".repeat(64),
            1 => bad.historical = false,
            2 => bad.provenance.clear(),
            3 => bad.valid_from = start + 1,
            4 => bad.tables[0].primary_key.clear(),
            5 => bad.tables[0].columns[0].nullable = true,
            6 => bad.tables[0].columns[0].name = "wrong_column".into(),
            7 => bad.tables[0].columns[0].unsigned = false,
            8 => bad.tables[0].columns[0].generated = true,
            9 => bad.tables[0].no_triggers_or_foreign_keys = false,
            _ => bad.tables[0].engine = "MyISAM".into(),
        }
        assert!(plan_recovery(&parsed, &bad, &[start]).is_err(), "case {case}");
    }
    assert!(plan_recovery(&parsed, &schema, &[]).is_err());
    assert!(plan_recovery(&parsed, &schema, &[start, start]).is_err());
    assert!(plan_recovery(&parsed, &schema, &[start + 1]).is_err());
}

#[test]
fn blocks_later_unselected_table_changes_and_unsupported_events() {
    use dbx_mysql_binlog_probe::{plan_recovery, read_log};
    let mut bytes = named_log();
    for id in [1, 2] {
        query(&mut bytes, b"BEGIN");
        write_row(&mut bytes, id);
        query(&mut bytes, b"COMMIT");
    }
    let parsed = read_log(Cursor::new(&bytes)).unwrap();
    let starts: Vec<_> = parsed.transactions().iter().map(|tx| tx.start_position).collect();
    let schema = snapshot(&parsed);
    assert!(plan_recovery(&parsed, &schema, &starts).is_ok());
    assert!(plan_recovery(&parsed, &schema, &starts[..1]).unwrap_err().contains("later"));
    assert!(plan_recovery(&parsed, &schema, &starts[1..]).is_ok());
    query(&mut bytes, b"ALTER TABLE items ADD COLUMN changed INT");
    let altered = read_log(Cursor::new(bytes)).unwrap();
    let mut schema = snapshot(&altered);
    schema.valid_to += 10_000;
    assert!(plan_recovery(&altered, &schema, &starts).is_err());
}

#[test]
fn reverses_transactions_rows_and_primary_key_changes() {
    use dbx_mysql_binlog_probe::{plan_recovery, read_log, Cell};
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 10);
    query(&mut bytes, b"COMMIT");
    query(&mut bytes, b"BEGIN");
    let old = image(10, b"test", Some(1));
    let mid = image(11, b"changed", None);
    let last = image(12, b"last", Some(3));
    for (before, after) in [(&old, &mid), (&mid, &last)] {
        let mut update = row_prefix(7);
        update.push(7);
        update.extend_from_slice(before);
        update.extend_from_slice(after);
        append(&mut bytes, 31, &update);
    }
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let starts: Vec<_> = parsed.transactions().iter().map(|tx| tx.start_position).collect();
    let plan = plan_recovery(&parsed, &snapshot(&parsed), &starts).unwrap();
    assert_eq!(plan.transactions[0].start_position, starts[1]);
    assert_eq!(plan.transactions[0].actions[0].expected.as_ref().unwrap()[0], Cell::Integer(12));
    assert_eq!(plan.transactions[0].actions[0].restore.as_ref().unwrap()[0], Cell::Integer(11));
    assert_eq!(plan.transactions[0].actions[1].restore.as_ref().unwrap()[0], Cell::Integer(10));
    assert_eq!(plan.transactions[1].start_position, starts[0]);
    assert!(plan.transactions[1].actions[0].restore.is_none());
}

#[test]
fn emits_guarded_sql_without_lossy_literals_or_conflict_suppression() {
    use dbx_mysql_binlog_probe::{plan_recovery, read_log};
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    let mut delete = row_prefix(7);
    delete.extend(image(u64::MAX, &[0xff, 0, b'\'', b'\\'], None));
    append(&mut bytes, 32, &delete);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let start = parsed.transactions()[0].start_position;
    let mut plan = plan_recovery(&parsed, &snapshot(&parsed), &[start]).unwrap();
    let sql = plan.to_sql().unwrap();
    assert!(sql.contains("18446744073709551615"));
    assert!(sql.contains("X'ff00275c'"));
    assert!(sql.contains("NULL"));
    assert!(sql.contains("SQL SECURITY INVOKER"));
    assert!(sql.contains("DECLARE EXIT HANDLER FOR SQLEXCEPTION"));
    assert!(sql.contains("ROLLBACK;"));
    assert!(sql.contains("RESIGNAL;"));
    assert!(sql.contains("SIGNAL SQLSTATE '45000'"));
    assert!(sql.contains("FOR UPDATE"));
    assert!(sql.contains("ROW_COUNT() <> 1"));
    assert!(sql.contains("information_schema.COLUMNS"));
    assert!(sql.contains("fresh dedicated"));
    assert!(!sql.contains("INSERT IGNORE"));
    assert!(!sql.contains("REPLACE INTO"));
    assert!(!sql.contains("FOREIGN_KEY_CHECKS"));
    plan.transactions[0].actions[0].table.columns[0].name = "a`b".into();
    assert!(plan.to_sql().unwrap().contains("`a``b`"));
}

#[test]
fn verifies_noop_updates_instead_of_failing_on_zero_affected_rows() {
    use dbx_mysql_binlog_probe::{plan_recovery, read_log};
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    let row = image(1, b"same", Some(0));
    let mut update = row_prefix(7);
    update.push(7);
    update.extend_from_slice(&row);
    update.extend_from_slice(&row);
    append(&mut bytes, 31, &update);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let sql = plan_recovery(&parsed, &snapshot(&parsed), &[parsed.transactions()[0].start_position])
        .unwrap()
        .to_sql()
        .unwrap();
    assert!(sql.contains("FOR UPDATE"));
    assert!(sql.contains("CAST(dbx_row.`payload` AS BINARY) <=> X'73616d65'"));
    assert!(!sql.contains("UPDATE `test`.`items` AS dbx_row SET"));
}

#[test]
fn inverse_actions_replay_to_the_original_state() {
    use dbx_mysql_binlog_probe::{plan_recovery, read_log, Cell};
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 1);
    query(&mut bytes, b"COMMIT");
    query(&mut bytes, b"BEGIN");
    let old = image(1, b"test", Some(1));
    let new = image(2, b"later", Some(2));
    let mut update = row_prefix(7);
    update.push(7);
    update.extend(old);
    update.extend(new);
    append(&mut bytes, 31, &update);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let starts: Vec<_> = parsed.transactions().iter().map(|tx| tx.start_position).collect();
    let plan = plan_recovery(&parsed, &snapshot(&parsed), &starts).unwrap();
    let mut state = vec![vec![Cell::Integer(2), Cell::Binary(b"later".to_vec()), Cell::Integer(2)]];
    for transaction in &plan.transactions {
        for action in &transaction.actions {
            if let Some(expected) = &action.expected {
                let index = state.iter().position(|row| row == expected).expect("expected post-image must match");
                state.remove(index);
            }
            if let Some(restore) = &action.restore {
                state.push(restore.clone());
            }
        }
    }
    assert!(state.is_empty());
}

#[test]
fn export_rejects_unnamed_or_partial_images_even_with_a_schema_manifest() {
    use dbx_mysql_binlog_probe::{plan_recovery, read_log};
    let mut bytes = with_table();
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 1);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    assert!(plan_recovery(&parsed, &snapshot(&parsed), &[parsed.transactions()[0].start_position]).is_err());
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    let mut write = row_prefix(1);
    write.push(0);
    write.extend_from_slice(&1u64.to_le_bytes());
    append(&mut bytes, 30, &write);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    assert!(plan_recovery(&parsed, &snapshot(&parsed), &[parsed.transactions()[0].start_position]).is_err());
}

#[test]
fn preserves_exact_decimal_and_rejects_invalid_text_encoding() {
    use dbx_mysql_binlog_probe::{plan_recovery, read_log, Cell, ValueKind};
    let mut bytes = log();
    let mut table = vec![1, 0, 0, 0, 0, 0, 0, 0];
    table.extend_from_slice(b"\x04test\0\x05items\0");
    table.extend_from_slice(&[3, 8, 252, 246, 3, 1, 30, 6, 6, 1, 1, 0x80]);
    let names = b"\x02id\x07payload\x07counter";
    table.extend_from_slice(&[4, names.len() as u8]);
    table.extend_from_slice(names);
    table.extend_from_slice(&[8, 1, 0]);
    append(&mut bytes, 19, &table);
    query(&mut bytes, b"BEGIN");
    let mut delete = row_prefix(7);
    delete.push(0);
    delete.extend_from_slice(&1u64.to_le_bytes());
    delete.extend_from_slice(&[1, 0xff]);
    let value = "123456789012345678901234.567890";
    mysql_common::binlog::decimal::Decimal::parse_str_bytes(value.as_bytes()).unwrap().write_bin(&mut delete).unwrap();
    append(&mut bytes, 32, &delete);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let mut schema = snapshot(&parsed);
    let column = &mut schema.tables[0].columns[2];
    column.wire_type = 246;
    column.wire_metadata = vec![30, 6];
    column.kind = ValueKind::Decimal { precision: 30, scale: 6 };
    let plan = plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).unwrap();
    assert_eq!(plan.transactions[0].actions[0].restore.as_ref().unwrap()[2], Cell::Decimal(value.into()));
    assert!(plan.to_sql().unwrap().contains(value));
    schema.tables[0].columns[1].kind = ValueKind::Text { charset: "utf8mb4".into() };
    assert!(plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).unwrap_err().contains("UTF-8"));
}

#[test]
fn qualifies_shadowable_column_names_in_all_row_guards() {
    use dbx_binlog::{plan_recovery, read_log};
    let mut bytes = named_log_with_names(b"\x02id\x0bv_tx_active\x07v_count");
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 1);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let mut schema = snapshot(&parsed);
    schema.tables[0].columns[1].name = "v_tx_active".into();
    schema.tables[0].columns[2].name = "v_count".into();
    let sql = plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).unwrap().to_sql().unwrap();
    assert!(sql.contains("FROM `test`.`items` AS dbx_row"));
    assert!(sql.contains("CAST(dbx_row.`v_tx_active` AS BINARY)"));
    assert!(sql.contains("dbx_row.`v_count` <=> 1"));
    assert!(!sql.contains("WHERE `id`"));
}

#[test]
fn captures_strict_zero_preserving_mode_at_create_and_restores_before_call() {
    use dbx_binlog::{plan_recovery, read_log};
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    let mut delete = row_prefix(7);
    delete.extend(image(0, b"zero key", Some(1)));
    append(&mut bytes, 32, &delete);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let sql = plan_recovery(&parsed, &snapshot(&parsed), &[parsed.transactions()[0].start_position])
        .unwrap()
        .to_sql()
        .unwrap();
    let set_mode = sql.find("'STRICT_ALL_TABLES','NO_AUTO_VALUE_ON_ZERO'").expect("safe creation mode");
    let create = sql.find("CREATE PROCEDURE").unwrap();
    let restore = sql.find("SET SESSION sql_mode = @dbx_saved_").expect("restore caller mode");
    let call = sql.find("\nCALL ").unwrap();
    assert!(set_mode < create && create < restore && restore < call);
    assert!(sql.contains("FIND_IN_SET('NO_AUTO_VALUE_ON_ZERO', @@session.sql_mode) = 0"));
    assert!(sql.contains("DECLARE EXIT HANDLER FOR SQLWARNING"));
    assert!(sql.contains("restored image mismatch"));
}

#[test]
fn filtering_one_table_retains_other_tables_in_the_same_transaction() {
    use dbx_binlog::{read_log, TransactionFilter};
    let mut bytes = named_log();
    let original = named_log();
    let mut table = original[log().len() + 19..original.len() - 4].to_vec();
    table[0] = 2;
    table[15..20].copy_from_slice(b"other");
    append(&mut bytes, 19, &table);
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 1);
    let mut write = row_prefix(7);
    write[0] = 2;
    write.extend(image(2, b"second", None));
    append(&mut bytes, 30, &write);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let selected =
        parsed.matching_transactions(&TransactionFilter { table: Some("items".into()), ..Default::default() }).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].rows.len(), 2);
    assert_eq!(selected[0].rows[0].table, b"items");
    assert_eq!(selected[0].rows[1].table, b"other");
}

#[test]
fn checks_logged_charset_and_preserves_utf8_text_bytes() {
    use dbx_binlog::{plan_recovery, read_log, ValueKind};
    let original = named_log();
    let mut table = original[log().len() + 19..original.len() - 4].to_vec();
    table.extend_from_slice(&[3, 1, 45]); // utf8mb4_general_ci for the BLOB/TEXT column
    let mut bytes = log();
    append(&mut bytes, 19, &table);
    query(&mut bytes, b"BEGIN");
    let mut delete = row_prefix(7);
    delete.extend(image(1, "\u{96ea}'\\".as_bytes(), None));
    append(&mut bytes, 32, &delete);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let mut schema = snapshot(&parsed);
    schema.tables[0].columns[1].kind = ValueKind::Text { charset: "utf8mb4".into() };
    let start = parsed.transactions()[0].start_position;
    let sql = plan_recovery(&parsed, &schema, &[start]).unwrap().to_sql().unwrap();
    assert!(sql.contains("CONVERT(X'e99baa275c' USING utf8mb4)"));
    schema.tables[0].columns[1].kind = ValueKind::Text { charset: "latin1".into() };
    assert!(plan_recovery(&parsed, &schema, &[start]).unwrap_err().contains("character set"));
}

#[test]
fn refuses_varchar_values_that_exceed_character_not_just_byte_capacity() {
    use dbx_binlog::{plan_recovery, read_log, ValueKind};
    let original = named_log();
    let mut table = original[log().len() + 19..original.len() - 4].to_vec();
    // Re-author type metadata for BIGINT, VARCHAR(1) utf8mb4, INT.
    // Common table prefix ends at column-count offset 21.
    table[23] = 15;
    table[25] = 2;
    table.insert(27, 0);
    table[26] = 4;
    table.extend_from_slice(&[3, 1, 45]);
    let mut bytes = log();
    append(&mut bytes, 19, &table);
    query(&mut bytes, b"BEGIN");
    let mut delete = row_prefix(7);
    delete.extend(image(1, b"ab", None));
    append(&mut bytes, 32, &delete);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(bytes)).unwrap();
    let mut schema = snapshot(&parsed);
    let column = &mut schema.tables[0].columns[1];
    column.wire_type = 15;
    column.wire_metadata = vec![4, 0];
    column.kind = ValueKind::Text { charset: "utf8mb4".into() };
    assert!(plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).is_err());
}

#[test]
fn refuses_unbounded_table_map_growth_before_library_caching() {
    let original = named_log();
    let mut table = original[log().len() + 19..original.len() - 4].to_vec();
    let mut bytes = log();
    for id in 1u16..=129 {
        table[..2].copy_from_slice(&id.to_le_bytes());
        append(&mut bytes, 19, &table);
    }
    let error = inspect(Cursor::new(bytes), |_| {}).unwrap_err();
    assert!(error.to_string().contains("table map limit"));
}

fn extended_log(wire: u8, metadata: u8, encoded: &[u8]) -> (dbx_binlog::RecoveryLog, dbx_binlog::SchemaManifest) {
    let mut bytes = log();
    let mut table = vec![1, 0, 0, 0, 0, 0, 0, 0];
    table.extend_from_slice(b"\x04test\0\x05items\0");
    table.extend_from_slice(&[3, 8, 252, wire, 2, 1, metadata, 6, 1, 1, 0x80]);
    let names = b"\x02id\x07payload\x07counter";
    table.extend_from_slice(&[4, names.len() as u8]);
    table.extend_from_slice(names);
    table.extend_from_slice(&[8, 1, 0]);
    append(&mut bytes, 19, &table);
    query(&mut bytes, b"BEGIN");
    let mut delete = row_prefix(7);
    delete.push(0);
    delete.extend_from_slice(&1u64.to_le_bytes());
    delete.extend_from_slice(&[0]);
    delete.extend_from_slice(encoded);
    append(&mut bytes, 32, &delete);
    query(&mut bytes, b"COMMIT");
    let parsed = dbx_binlog::read_log(Cursor::new(bytes)).unwrap();
    let mut schema = snapshot(&parsed);
    schema.tables[0].columns[2].wire_type = wire;
    schema.tables[0].columns[2].wire_metadata = vec![metadata];
    (parsed, schema)
}

#[test]
fn restores_full_json_unsigned_integer_without_a_float_intermediate() {
    use dbx_binlog::{plan_recovery, Cell, ValueKind};
    let mut encoded = 9u32.to_le_bytes().to_vec();
    encoded.push(0x0a); // binary JSON uint64
    encoded.extend_from_slice(&u64::MAX.to_le_bytes());
    let (parsed, mut schema) = extended_log(245, 4, &encoded);
    schema.tables[0].columns[2].kind = ValueKind::Json;
    let plan = plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).unwrap();
    assert_eq!(plan.transactions[0].actions[0].restore.as_ref().unwrap()[2], Cell::Json("18446744073709551615".into()));
    assert!(plan.to_sql().unwrap().contains("AS JSON)"));
}

#[test]
fn restores_microsecond_datetime_timestamp_and_long_negative_time() {
    use dbx_binlog::{plan_recovery, Cell, ValueKind};
    // DATETIME2: 2026-10-20 12:34:56.123456, independent wire layout.
    let packed: u64 = (((2026 * 13 + 10) * 32 + 20) << 17) | (12 << 12) | (34 << 6) | 56;
    let mut datetime = (packed + 0x8000000000).to_be_bytes()[3..].to_vec();
    datetime.extend_from_slice(&123456u32.to_be_bytes()[1..]);
    let (parsed, mut schema) = extended_log(18, 6, &datetime);
    schema.tables[0].columns[2].kind = ValueKind::DateTime { precision: 6 };
    let plan = plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).unwrap();
    assert_eq!(
        plan.transactions[0].actions[0].restore.as_ref().unwrap()[2],
        Cell::DateTime("2026-10-20 12:34:56.123456".into())
    );
    assert!(plan.to_sql().unwrap().contains("2026-10-20 12:34:56.123456"));
    let mut timestamp = 1_700_000_000u32.to_be_bytes().to_vec();
    timestamp.extend_from_slice(&123456u32.to_be_bytes()[1..]);
    let (parsed, mut schema) = extended_log(17, 6, &timestamp);
    schema.tables[0].columns[2].kind = ValueKind::Timestamp { precision: 6 };
    let plan = plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).unwrap();
    assert_eq!(
        plan.transactions[0].actions[0].restore.as_ref().unwrap()[2],
        Cell::Timestamp("1700000000.123456".into())
    );
    let sql = plan.to_sql().unwrap();
    assert!(sql.contains("FROM_UNIXTIME(1700000000.123456)"));
    assert!(sql.contains("SET SESSION time_zone = '+00:00'"));
    // TIME2 negative encoding is two's complement around the 0x800000 bias.
    let hms: i64 = (838 << 12) | (59 << 6) | 58;
    let time = (((0x800000i64 - hms) << 24) - 999999).to_be_bytes()[2..].to_vec();
    let (parsed, mut schema) = extended_log(19, 6, &time);
    schema.tables[0].columns[2].kind = ValueKind::Time { precision: 6 };
    let plan = plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).unwrap();
    assert_eq!(plan.transactions[0].actions[0].restore.as_ref().unwrap()[2], Cell::Time("-838:59:58.999999".into()));
}

#[test]
fn rejects_time_fraction_beyond_mysql_838_hour_endpoint() {
    let hms: i64 = (838 << 12) | (59 << 6) | 59;
    let time = (((0x800000i64 - hms) << 24) - 1).to_be_bytes()[2..].to_vec();
    let (parsed, mut schema) = extended_log(19, 6, &time);
    schema.tables[0].columns[2].kind = dbx_binlog::ValueKind::Time { precision: 6 };
    assert!(dbx_binlog::plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).is_err());
}

#[test]
fn worker_previews_lossless_images_and_rejects_changed_files() {
    use dbx_binlog::worker::handle_worker_request;
    let path = std::env::temp_dir().join(format!("dbx12838-worker-{}.binlog", std::process::id()));
    let schema_path = path.with_extension("json");
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, u64::MAX);
    query(&mut bytes, b"COMMIT");
    std::fs::write(&path, &bytes).unwrap();
    let parsed = dbx_binlog::read_log(Cursor::new(&bytes)).unwrap();
    std::fs::write(&schema_path, serde_json::to_vec(&snapshot(&parsed)).unwrap()).unwrap();
    let result = (|| -> Result<(), String> {
        let list: serde_json::Value = serde_json::from_str(&handle_worker_request(
            &serde_json::to_vec(&serde_json::json!({"action":"list","path":path})).unwrap(),
        )?)
        .unwrap();
        assert_eq!(list["total"], 1);
        let start = list["transactions"][0]["start_position"].as_str().unwrap();
        let hash = list["sha256"].as_str().unwrap();
        let detail: serde_json::Value = serde_json::from_str(&handle_worker_request(
            &serde_json::to_vec(
                &serde_json::json!({"action":"details","path":path,"sha256":hash,"start_position":start}),
            )
            .unwrap(),
        )?)
        .unwrap();
        assert_eq!(detail["rows"][0]["after"][0]["value"], u64::MAX.to_string());
        assert_eq!(detail["rows"][0]["after"][0]["kind"], "integer");
        assert_eq!(detail["rows"][0]["after"][1]["value"], "74657374");
        assert!(detail["rows"][0]["before"].is_null());
        let generated:serde_json::Value = serde_json::from_str(&handle_worker_request(&serde_json::to_vec(&serde_json::json!({"action":"generate","path":path,"sha256":hash,"schema_path":schema_path,"start_positions":[start]})).unwrap())?).unwrap();
        assert!(generated["sql"].as_str().unwrap().contains("18446744073709551615"));
        let stale = handle_worker_request(
            &serde_json::to_vec(
                &serde_json::json!({"action":"details","path":path,"sha256":"wrong","start_position":start}),
            )
            .unwrap(),
        );
        assert!(stale.unwrap_err().contains("changed"));
        Ok(())
    })();
    std::fs::remove_file(path).unwrap();
    std::fs::remove_file(schema_path).unwrap();
    result.unwrap();
}

#[test]
fn worker_rejects_oversized_or_unknown_requests_without_file_access() {
    use dbx_binlog::worker::{handle_worker_request, MAX_REQUEST_BYTES};
    assert!(handle_worker_request(&vec![b' '; MAX_REQUEST_BYTES + 1]).unwrap_err().contains("64 KiB"));
    assert!(handle_worker_request(br#"{"action":"execute_sql","sql":"DROP DATABASE test"}"#).is_err());
}

#[test]
fn rejects_invalid_utf8_and_duplicate_json_object_keys_before_dom_conversion() {
    for document in [
        vec![0, 1, 0, 12, 0, 11, 0, 1, 0, 4, 1, 0, 0xff],
        vec![0, 2, 0, 20, 0, 18, 0, 1, 0, 19, 0, 1, 0, 4, 1, 0, 4, 1, 0, 0xff, 0xfe],
        vec![0, 2, 0, 20, 0, 18, 0, 1, 0, 19, 0, 1, 0, 4, 1, 0, 4, 1, 0, b'a', b'a'],
    ] {
        let mut encoded = (document.len() as u32).to_le_bytes().to_vec();
        encoded.extend(document);
        let (parsed, mut schema) = extended_log(245, 4, &encoded);
        schema.tables[0].columns[2].kind = dbx_binlog::ValueKind::Json;
        assert!(dbx_binlog::plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position]).is_err());
    }
}

#[test]
fn rejects_deep_json_before_upstream_recursive_dom_allocation() {
    let mut document = vec![5, 0, 0]; // int16 zero
    for _ in 0..70 {
        let mut parent = vec![2, 1, 0]; // small array, one element
        parent.extend_from_slice(&((7 + document.len() - 1) as u16).to_le_bytes());
        parent.extend_from_slice(&[document[0], 7, 0]);
        parent.extend_from_slice(&document[1..]);
        document = parent;
    }
    let mut encoded = (document.len() as u32).to_le_bytes().to_vec();
    encoded.extend(document);
    let (parsed, mut schema) = extended_log(245, 4, &encoded);
    schema.tables[0].columns[2].kind = dbx_binlog::ValueKind::Json;
    assert!(dbx_binlog::plan_recovery(&parsed, &schema, &[parsed.transactions()[0].start_position])
        .unwrap_err()
        .contains("depth"));
}

#[test]
fn worker_does_not_present_unknown_unsigned_bits_as_a_confirmed_negative_integer() {
    let original = named_log();
    let mut table = original[log().len() + 19..original.len() - 4].to_vec();
    table.drain(28..31);
    let mut bytes = log();
    append(&mut bytes, 19, &table);
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, u64::MAX);
    query(&mut bytes, b"COMMIT");
    let parsed = dbx_binlog::read_log(Cursor::new(&bytes)).unwrap();
    let path = std::env::temp_dir().join(format!("dbx12838-ambiguous-{}.binlog", std::process::id()));
    std::fs::write(&path, bytes).unwrap();
    let result=dbx_binlog::worker::handle_worker_request(&serde_json::to_vec(&serde_json::json!({"action":"details","path":path,"sha256":parsed.sha256(),"start_position":parsed.transactions()[0].start_position.to_string()})).unwrap());
    std::fs::remove_file(path).unwrap();
    let value: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(value["rows"][0]["after"][0]["kind"], "ambiguous_integer");
    assert_eq!(value["rows"][0]["after"][0]["value"], "0xffffffffffffffff");
}
