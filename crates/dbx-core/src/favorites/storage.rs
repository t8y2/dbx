//! A child of `storage`, so existing private connection access needs no changes.
use super::Storage;
use crate::favorites::*;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use uuid::Uuid;

const COLUMNS: &str = "id, code, name, connection_id, catalog, database_name, schema_name, object_type, object_name, revision, created_at, updated_at";

fn decode(row: &Row<'_>) -> rusqlite::Result<TableFavorite> {
    Ok(TableFavorite {
        id: row.get(0)?,
        code: row.get(1)?,
        name: row.get(2)?,
        target: FavoriteTarget {
            connection_id: row.get(3)?,
            catalog: row.get(4)?,
            database: row.get(5)?,
            schema: row.get(6)?,
            object_type: row.get(7)?,
            object_name: row.get(8)?,
        },
        revision: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn by_id(conn: &Connection, id: &str) -> Result<Option<TableFavorite>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM table_favorites WHERE id = ?1"), [id], decode)
        .optional()
        .map_err(|e| e.to_string())
}

fn by_target(conn: &Connection, target: &FavoriteTarget) -> Result<Option<TableFavorite>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM table_favorites WHERE connection_id = ?1 AND catalog = ?2 AND database_name = ?3 AND schema_name = ?4 AND object_type = ?5 AND object_name = ?6"),
        params![target.connection_id, target.catalog, target.database, target.schema, target.object_type, target.object_name], decode,
    ).optional().map_err(|e| e.to_string())
}

fn require_connection(conn: &Connection, target: &FavoriteTarget) -> Result<(), String> {
    let exists: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM connections WHERE id = ?1)", [&target.connection_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("CONNECTION_NOT_FOUND: connection no longer exists".into());
    }
    Ok(())
}

fn code_in_use(conn: &Connection, code: &str, except_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM table_favorites WHERE code = ?1 AND id <> ?2)",
        params![code, except_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn require_revision(item: &TableFavorite, revision: i64) -> Result<(), String> {
    if item.revision != revision {
        return Err("FAVORITE_REVISION_CONFLICT: favorite changed in another window".into());
    }
    Ok(())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Storage {
    pub async fn list_table_favorites(&self) -> Result<TableFavorites, String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!("SELECT {COLUMNS} FROM table_favorites ORDER BY code, id"))
                .map_err(|e| e.to_string())?;
            let items = stmt
                .query_map([], decode)
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            Ok(TableFavorites { items })
        })
        .await
    }

    pub async fn create_table_favorite(&self, input: CreateTableFavorite) -> Result<CreatedTableFavorite, String> {
        validate_target(&input.target)?;
        let name = normalize_name(&input.name)?;
        let code = input.code.filter(|code| !code.trim().is_empty()).map(|code| normalize_code(&code)).transpose()?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            require_connection(&tx, &input.target)?;
            if let Some(item) = by_target(&tx, &input.target)? {
                return Ok(CreatedTableFavorite { item, created: false });
            }
            let code = if let Some(code) = code {
                if code_in_use(&tx, &code, "")? { return Err("FAVORITE_CODE_CONFLICT: code already exists".into()); }
                code
            } else {
                let mut value: i64 = tx.query_row("SELECT next_value FROM table_favorite_sequence WHERE singleton = 1", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                loop {
                    let candidate = format!("F{value:04}");
                    value = value.checked_add(1).ok_or("INVALID_FAVORITE: automatic code sequence exhausted")?;
                    if !code_in_use(&tx, &candidate, "")? {
                        tx.execute("UPDATE table_favorite_sequence SET next_value = ?1 WHERE singleton = 1", [value]).map_err(|e| e.to_string())?;
                        break candidate;
                    }
                }
            };
            let item = TableFavorite { id: Uuid::new_v4().to_string(), code, name, target: input.target, revision: 1, created_at: now_ms(), updated_at: now_ms() };
            tx.execute(
                "INSERT INTO table_favorites (id, code, name, connection_id, catalog, database_name, schema_name, object_type, object_name, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![item.id, item.code, item.name, item.target.connection_id, item.target.catalog, item.target.database, item.target.schema, item.target.object_type, item.target.object_name, item.revision, item.created_at, item.updated_at],
            ).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(CreatedTableFavorite { item, created: true })
        }).await
    }

    pub async fn update_table_favorite(&self, id: String, input: UpdateTableFavorite) -> Result<TableFavorite, String> {
        validate_revision(input.expected_revision)?;
        let name = normalize_name(&input.name)?;
        let code = normalize_code(&input.code)?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            let mut item = by_id(&tx, &id)?.ok_or("FAVORITE_NOT_FOUND: favorite no longer exists")?;
            require_revision(&item, input.expected_revision)?;
            if code_in_use(&tx, &code, &id)? {
                return Err("FAVORITE_CODE_CONFLICT: code already exists".into());
            }
            item.name = name;
            item.code = code;
            item.revision += 1;
            item.updated_at = now_ms();
            tx.execute(
                "UPDATE table_favorites SET name = ?1, code = ?2, revision = ?3, updated_at = ?4 WHERE id = ?5",
                params![item.name, item.code, item.revision, item.updated_at, id],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(item)
        })
        .await
    }

    pub async fn relink_table_favorite(&self, id: String, input: RelinkTableFavorite) -> Result<TableFavorite, String> {
        validate_target(&input.target)?;
        validate_revision(input.expected_revision)?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            let mut item = by_id(&tx, &id)?.ok_or("FAVORITE_NOT_FOUND: favorite no longer exists")?;
            require_revision(&item, input.expected_revision)?;
            require_connection(&tx, &input.target)?;
            if by_target(&tx, &input.target)?.is_some_and(|other| other.id != id) {
                return Err("FAVORITE_TARGET_CONFLICT: target is already favorited".into());
            }
            item.target = input.target; item.revision += 1; item.updated_at = now_ms();
            tx.execute("UPDATE table_favorites SET connection_id = ?1, catalog = ?2, database_name = ?3, schema_name = ?4, object_type = ?5, object_name = ?6, revision = ?7, updated_at = ?8 WHERE id = ?9",
                params![item.target.connection_id, item.target.catalog, item.target.database, item.target.schema, item.target.object_type, item.target.object_name, item.revision, item.updated_at, id]).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(item)
        }).await
    }

    pub async fn remove_table_favorite(&self, id: String, expected_revision: i64) -> Result<(), String> {
        validate_revision(expected_revision)?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            if let Some(item) = by_id(&tx, &id)? {
                require_revision(&item, expected_revision)?;
                tx.execute("DELETE FROM table_favorites WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
