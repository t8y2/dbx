use super::*;
use tempfile::TempDir;

fn input(table: &str, code: Option<&str>) -> CreateTableFavorite {
    CreateTableFavorite {
        target: FavoriteTarget {
            connection_id: "c1".into(),
            catalog: "".into(),
            database: "db".into(),
            schema: "public".into(),
            object_type: "table".into(),
            object_name: table.into(),
        },
        name: format!(" {table} 收藏 "),
        code: code.map(str::to_owned),
    }
}

async fn setup() -> (TempDir, Storage) {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(&dir.path().join("dbx.db")).await.unwrap();
    storage
        .with_conn(|conn| {
            conn.execute("INSERT INTO connections (id, config_json) VALUES ('c1', '{}')", [])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .unwrap();
    (dir, storage)
}

#[tokio::test]
async fn favorites_code_preview_does_not_reserve_and_skips_taken_codes() {
    let (_dir, storage) = setup().await;
    assert_eq!(storage.list_table_favorites().await.unwrap().next_code, "01");
    assert_eq!(storage.list_table_favorites().await.unwrap().next_code, "01");
    storage.create_table_favorite(input("custom", Some("01"))).await.unwrap();
    assert_eq!(storage.list_table_favorites().await.unwrap().next_code, "02");
    let first = storage.create_table_favorite(input("first", None)).await.unwrap();
    let second = storage.create_table_favorite(input("second", None)).await.unwrap();
    assert_eq!(first.item.code, "02");
    assert_eq!(second.item.code, "03");
    let payload = serde_json::to_value(storage.list_table_favorites().await.unwrap()).unwrap();
    assert_eq!(payload["nextCode"], "04");
}

#[tokio::test]
async fn favorites_numbering_idempotence_and_restart() {
    let (dir, storage) = setup().await;
    let custom = storage.create_table_favorite(input("a", Some(" 01 "))).await.unwrap();
    assert_eq!(custom.item.code, "01");
    assert_eq!(custom.item.name, "a 收藏");
    let automatic = storage.create_table_favorite(input("b", None)).await.unwrap();
    assert_eq!(automatic.item.code, "02");
    let duplicate = storage.create_table_favorite(input("b", Some("DIFFERENT"))).await.unwrap();
    assert!(!duplicate.created);
    assert_eq!(duplicate.item, automatic.item);
    storage.remove_table_favorite(custom.item.id, 1).await.unwrap();
    drop(storage);
    let storage = Storage::open(&dir.path().join("dbx.db")).await.unwrap();
    assert_eq!(storage.list_table_favorites().await.unwrap().items, vec![automatic.item]);
    assert_eq!(storage.create_table_favorite(input("c", None)).await.unwrap().item.code, "03");
}

#[tokio::test]
async fn favorites_revision_conflicts_and_idempotent_delete() {
    let (_dir, storage) = setup().await;
    let item = storage.create_table_favorite(input("a", None)).await.unwrap().item;
    let update = UpdateTableFavorite { name: "新名称".into(), code: "custom".into(), expected_revision: 1 };
    let updated = storage.update_table_favorite(item.id.clone(), update.clone()).await.unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.code, "CUSTOM");
    assert_eq!(updated.created_at, item.created_at);
    assert!(storage
        .update_table_favorite(item.id.clone(), update)
        .await
        .unwrap_err()
        .starts_with("FAVORITE_REVISION_CONFLICT:"));
    assert!(storage
        .remove_table_favorite(item.id.clone(), 1)
        .await
        .unwrap_err()
        .starts_with("FAVORITE_REVISION_CONFLICT:"));
    storage.remove_table_favorite(item.id.clone(), 2).await.unwrap();
    storage.remove_table_favorite(item.id.clone(), 1).await.unwrap();
    assert!(storage
        .update_table_favorite(
            item.id,
            UpdateTableFavorite { name: "x".into(), code: "x".into(), expected_revision: 2 }
        )
        .await
        .unwrap_err()
        .starts_with("FAVORITE_NOT_FOUND:"));
}

#[tokio::test]
async fn favorites_relink_preserves_identity_and_rejects_duplicate_targets() {
    let (_dir, storage) = setup().await;
    let a = storage.create_table_favorite(input("a", None)).await.unwrap().item;
    let b = storage.create_table_favorite(input("b", None)).await.unwrap().item;
    assert!(storage
        .relink_table_favorite(a.id.clone(), RelinkTableFavorite { target: b.target, expected_revision: 1 })
        .await
        .unwrap_err()
        .starts_with("FAVORITE_TARGET_CONFLICT:"));
    let moved = storage
        .relink_table_favorite(
            a.id.clone(),
            RelinkTableFavorite { target: input("renamed", None).target, expected_revision: 1 },
        )
        .await
        .unwrap();
    assert_eq!((&moved.id, &moved.code, &moved.name, moved.created_at), (&a.id, &a.code, &a.name, a.created_at));
    assert_eq!(moved.target.object_name, "renamed");
    assert_eq!(moved.revision, 2);
    assert!(storage
        .relink_table_favorite(a.id, RelinkTableFavorite { target: input("again", None).target, expected_revision: 1 })
        .await
        .unwrap_err()
        .starts_with("FAVORITE_REVISION_CONFLICT:"));
}

#[tokio::test]
async fn favorites_case_schema_and_catalog_remain_distinct() {
    let (_dir, storage) = setup().await;
    for (table, schema, catalog) in
        [("Users", "public", ""), ("users", "public", ""), ("Users", "other", ""), ("Users", "public", "other")]
    {
        let mut request = input(table, None);
        request.target.schema = schema.into();
        request.target.catalog = catalog.into();
        assert!(storage.create_table_favorite(request).await.unwrap().created);
    }
    assert_eq!(storage.list_table_favorites().await.unwrap().items.len(), 4);
}

#[tokio::test]
async fn favorites_separate_connections_concurrent_creation() {
    let (dir, a) = setup().await;
    let b = Storage::open(&dir.path().join("dbx.db")).await.unwrap();
    let (left, right) =
        tokio::join!(a.create_table_favorite(input("same", None)), b.create_table_favorite(input("same", None)));
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(left.item.id, right.item.id);
    assert_ne!(left.created, right.created);
    let (left, right) =
        tokio::join!(a.create_table_favorite(input("left", None)), b.create_table_favorite(input("right", None)));
    assert_ne!(left.unwrap().item.code, right.unwrap().item.code);
    assert_eq!(a.list_table_favorites().await.unwrap().items.len(), 3);
}

#[tokio::test]
async fn favorites_connection_replacement_and_deletion_leave_repairable_records() {
    let (_dir, storage) = setup().await;
    let a = storage.create_table_favorite(input("a", None)).await.unwrap().item;
    // The existing replacement flow must preserve an unreadable connection too.
    storage.save_connections(&[]).await.unwrap();
    assert_eq!(storage.list_table_favorites().await.unwrap().items, vec![a.clone()]);
    storage
        .with_conn(|conn| {
            conn.execute("DELETE FROM connections", []).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(storage.list_table_favorites().await.unwrap().items, vec![a.clone()]);
    assert!(storage.create_table_favorite(input("b", None)).await.unwrap_err().starts_with("CONNECTION_NOT_FOUND:"));
    assert!(storage
        .relink_table_favorite(
            a.id.clone(),
            RelinkTableFavorite { target: input("b", None).target, expected_revision: 1 }
        )
        .await
        .unwrap_err()
        .starts_with("CONNECTION_NOT_FOUND:"));
    let updated = storage
        .update_table_favorite(
            a.id.clone(),
            UpdateTableFavorite { name: "可修复".into(), code: a.code, expected_revision: 1 },
        )
        .await
        .unwrap();
    storage.remove_table_favorite(a.id, updated.revision).await.unwrap();
}

#[tokio::test]
async fn favorites_validation_and_code_conflict_do_not_consume_sequence() {
    let (_dir, storage) = setup().await;
    let a = storage.create_table_favorite(input("a", Some("custom"))).await.unwrap().item;
    assert!(storage
        .create_table_favorite(input("b", Some("CUSTOM")))
        .await
        .unwrap_err()
        .starts_with("FAVORITE_CODE_CONFLICT:"));
    for code in ["中文", "has space", "!", "123456789012345678901234567890123"] {
        assert!(storage
            .create_table_favorite(input("b", Some(code)))
            .await
            .unwrap_err()
            .starts_with("INVALID_FAVORITE:"));
    }
    let mut bad = input("b", None);
    bad.name = " ".into();
    assert!(storage.create_table_favorite(bad).await.is_err());
    let mut emoji = input("b", None);
    emoji.name = "🦀".repeat(100);
    let b = storage.create_table_favorite(emoji).await.unwrap().item;
    assert_eq!(b.code, "01");
    assert!(storage
        .update_table_favorite(a.id, UpdateTableFavorite { name: "a".into(), code: b.code, expected_revision: 1 })
        .await
        .unwrap_err()
        .starts_with("FAVORITE_CODE_CONFLICT:"));
}

#[tokio::test]
async fn favorites_old_database_upgrade_and_whole_database_copy() {
    let source = tempfile::tempdir().unwrap();
    let path = source.path().join("dbx.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL); INSERT INTO connections VALUES ('c1', '{}');").unwrap();
    drop(conn);
    let storage = Storage::open(&path).await.unwrap();
    let a = storage.create_table_favorite(input("a", None)).await.unwrap().item;
    let target = tempfile::tempdir().unwrap();
    assert_eq!(
        crate::storage::maybe_import_user_data_db(target.path(), Some(source.path())).unwrap(),
        crate::storage::DataDbImportResult::Imported
    );
    let copied = Storage::open(&target.path().join("dbx.db")).await.unwrap();
    assert_eq!(copied.list_table_favorites().await.unwrap().items, vec![a]);
    assert_eq!(copied.create_table_favorite(input("b", None)).await.unwrap().item.code, "02");
}

#[tokio::test]
async fn favorites_sequence_seed_does_not_mark_empty_database_as_user_data() {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(&dir.path().join("dbx.db")).await.unwrap();
    assert!(!storage.with_conn(|conn| super::super::sqlite_db_has_user_data(conn)).await.unwrap());
}
