//! Comments belong to export/display DDL, not the editable view source.
use super::{clone_metadata_pool, connection_config, pg_ident, retry_metadata_connection_for_session};
use crate::connection::{AppState, PoolKind};
use crate::db;
use dbx_sql::value_literals::quote_postgres_string_literal;
use serde_json::Value;

fn comments_query(schema: &str, name: &str) -> String {
    format!(
        "SELECT c.relkind::text, pg_catalog.obj_description(c.oid, 'pg_class'), \
         a.attname, pg_catalog.col_description(c.oid, a.attnum) \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         WHERE n.nspname = {} AND c.relname = {} AND c.relkind IN ('v', 'm') \
         ORDER BY a.attnum",
        quote_postgres_string_literal(schema),
        quote_postgres_string_literal(name),
    )
}

fn nullable_text(value: Option<&Value>) -> Result<Option<&str>, String> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        _ => Err("Invalid PostgreSQL view comment metadata".into()),
    }
}

fn append_comments(ddl: &str, schema: &str, name: &str, rows: &[Vec<Value>]) -> Result<String, String> {
    let row =
        rows.first().ok_or_else(|| format!("PostgreSQL view not found while reading comments: {schema}.{name}"))?;
    let kind = match nullable_text(row.first())? {
        Some("v") => "VIEW",
        Some("m") => "MATERIALIZED VIEW",
        _ => return Err("Invalid PostgreSQL view relation kind".into()),
    };
    let reference = format!("{}.{}", pg_ident(schema), pg_ident(name));
    let mut comments = Vec::new();
    if let Some(comment) = nullable_text(row.get(1))? {
        comments.push(format!("COMMENT ON {kind} {reference} IS {};", quote_postgres_string_literal(comment)));
    }
    for row in rows {
        let column = nullable_text(row.get(2))?;
        let comment = nullable_text(row.get(3))?;
        if let Some(comment) = comment {
            let column = column.ok_or("Missing PostgreSQL column name for comment")?;
            comments.push(format!(
                "COMMENT ON COLUMN {reference}.{} IS {};",
                pg_ident(column),
                quote_postgres_string_literal(comment)
            ));
        }
    }
    if comments.is_empty() {
        return Ok(ddl.to_owned());
    }
    Ok(format!("{};\n{}", ddl.trim_end().trim_end_matches(';'), comments.join("\n")))
}

pub(crate) async fn enrich_postgres_view_ddl_with_comments(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
    ddl: &str,
    client_session_id: Option<&str>,
) -> Result<String, String> {
    retry_metadata_connection_for_session(state, connection_id, Some(database), client_session_id, || async {
        let pool_key =
            state.get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id).await?;
        let pool = clone_metadata_pool(state, &pool_key).await.ok_or("Pool not found")?;
        let PoolKind::Postgres(pool) = pool else {
            return Err("PostgreSQL view comments require a native PostgreSQL connection".into());
        };
        let config = connection_config(state, connection_id).await;
        let sql = comments_query(schema, name);
        let query = db::postgres::execute_query(&pool, &sql);
        let result = if let Some(timeout) = super::agent_metadata_timeout(config.as_ref()) {
            db::with_connection_timeout("PostgreSQL view comments", timeout, query).await?
        } else {
            query.await?
        };
        if result.truncated {
            return Err("PostgreSQL view comment metadata was truncated".into());
        }
        append_comments(ddl, schema, name, &result.rows)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn comments_preserve_literal_contents_and_raw_catalog_identifiers() {
        let rows = vec![vec![json!("m"), json!(" 中文 O'Reilly; \\path\n "), json!("\"column\""), json!(" \t\n ")]];
        let ddl =
            append_comments("CREATE MATERIALIZED VIEW x AS SELECT 1 WITH NO DATA;", "a.b", "\"view\"", &rows).unwrap();
        assert!(ddl.contains(
            "WITH NO DATA;\nCOMMENT ON MATERIALIZED VIEW \"a.b\".\"\"\"view\"\"\" IS E' 中文 O''Reilly; \\\\path\\n ';"
        ));
        assert!(ddl.contains("COMMENT ON COLUMN \"a.b\".\"\"\"view\"\"\".\"\"\"column\"\"\" IS E' \\t\\n ';"));
    }

    #[test]
    fn null_comments_leave_ddl_unchanged_and_zero_column_views_work() {
        let rows = vec![vec![json!("v"), Value::Null, Value::Null, Value::Null]];
        assert_eq!(append_comments("CREATE VIEW x AS SELECT", "s", "x", &rows).unwrap(), "CREATE VIEW x AS SELECT");
        let rows = vec![vec![json!("v"), json!("object"), Value::Null, Value::Null]];
        assert!(append_comments("CREATE VIEW x AS SELECT", "s", "x", &rows)
            .unwrap()
            .ends_with("COMMENT ON VIEW \"s\".\"x\" IS 'object';"));
    }

    #[test]
    fn missing_or_malformed_metadata_is_an_error() {
        assert!(append_comments("ddl", "s", "v", &[]).is_err());
        assert!(append_comments("ddl", "s", "v", &[vec![json!("r")]]).is_err());
        assert!(append_comments("ddl", "s", "v", &[vec![json!("v"), json!(5)]]).is_err());
        assert!(append_comments("ddl", "s", "v", &[vec![json!("v"), Value::Null, Value::Null, json!("x")]]).is_err());
    }

    #[test]
    fn catalog_query_preserves_exact_schema_and_name() {
        let query = comments_query("s\\'", "same.name");
        assert!(query.contains("n.nspname = E's\\\\''' AND c.relname = 'same.name'"));
        assert!(query.contains("LEFT JOIN pg_catalog.pg_attribute"));
        assert!(query.contains("ORDER BY a.attnum"));
    }
}
