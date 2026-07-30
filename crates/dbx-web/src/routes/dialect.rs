use axum::extract::Query;
use axum::Json;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct DialectDataTypesQuery {
    dialect_name: String,
}

pub async fn list_data_types(Query(query): Query<DialectDataTypesQuery>) -> Json<Vec<String>> {
    Json(dbx_core::sql_dialect::dialect_types::list_dialect_type_names(&query.dialect_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_data_types_matches_tauri_command_behavior() {
        dbx_core::sql_dialect::dialect_loader::register_core_dialects();
        let Json(types) =
            list_data_types(Query(DialectDataTypesQuery { dialect_name: "PostgreSQL".to_string() })).await;
        assert!(!types.is_empty(), "Expected non-empty types, got {types:?}");
    }
}
