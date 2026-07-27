use mysql_async::prelude::*;
use std::collections::HashSet;

use crate::types::{ColumnInfo, DatabaseInfo, IndexInfo, TableInfo};

use super::mysql::{
    bytes_to_string_lossy, database_infos_from_names, first_nonempty_str_by_name, fix_potential_double_encoding,
    get_conn_with_health_check, get_conn_with_timeout, get_opt_str, get_str, get_str_by_name, is_mysql_identifier_byte,
    list_indexes, mysql_keyword_at, quote_identifier, show_create_table_ddl, skip_mysql_quoted, MySqlPool,
};

// Doris and StarRocks reuse the MySQL wire protocol, but catalog addressing and DDL/index
// metadata semantics are MySQL-compatible distributed behavior and stay isolated in this module.
pub async fn list_indexes_with_ddl_fallback(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let statistics_result = list_indexes(pool, database, table).await;
    let mut indexes = match &statistics_result {
        Ok(indexes) => indexes.clone(),
        Err(err) => {
            log::debug!(
                "Falling back to SHOW CREATE TABLE for MySQL-compatible distributed indexes on `{database}`.`{table}` after information_schema.STATISTICS failed: {err}"
            );
            Vec::new()
        }
    };

    match show_create_table_ddl(pool, database, table).await {
        Ok(ddl) => {
            merge_index_infos(&mut indexes, indexes_from_create_table_ddl(&ddl));
            Ok(indexes)
        }
        Err(ddl_err) => {
            if indexes.is_empty() {
                if let Err(statistics_err) = statistics_result {
                    return Err(format!(
                        "{statistics_err}; SHOW CREATE TABLE fallback failed for MySQL-compatible distributed indexes: {ddl_err}"
                    ));
                }
            }
            Ok(indexes)
        }
    }
}

// ---------------------------------------------------------------------------
// Doris / StarRocks multi-catalog support.
//
// These engines expose external catalogs (iceberg, hive, jdbc, ...) alongside
// the native `internal` catalog via `SHOW CATALOGS`. The functions below address
// objects in a specific catalog using 3-part qualified names
// (`<catalog>.<database>.<table>`), which the engines accept directly without
// needing to `SWITCH` the session catalog.
// ---------------------------------------------------------------------------

/// Build a 2-part qualified identifier `` `<catalog>`.`<database>` ``.
fn catalog_database_ref(catalog: &str, database: &str) -> String {
    format!("{}.{}", quote_identifier(catalog), quote_identifier(database))
}

/// Build a 3-part qualified identifier `` `<catalog>`.`<database>`.`<table>` ``.
fn catalog_table_ref(catalog: &str, database: &str, table: &str) -> String {
    format!("{}.{}.{}", quote_identifier(catalog), quote_identifier(database), quote_identifier(table))
}

/// `SHOW CATALOGS` → list of catalogs visible to the current user.
///
/// Column layouts differ between engines: Doris exposes `CatalogName` (with
/// `CatalogId`/`IsCurrent`/`CreateTime`/`LastUpdateTime`), while StarRocks
/// exposes `Catalog` (only `Type`/`Comment`, no `IsCurrent`). The name is read
/// from either column; missing trailing columns degrade gracefully to
/// empty/None. The built-in catalog is named `internal` in Doris and
/// `default_catalog` in StarRocks (both with `Type=internal`); detection is
/// type-based (see `CatalogInfo::is_internal`), not name-based.
pub async fn list_catalogs(pool: &MySqlPool) -> Result<Vec<crate::db::CatalogInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter("SHOW CATALOGS").await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let catalogs: Vec<crate::db::CatalogInfo> = rows
        .iter()
        .filter_map(|row| {
            // Doris column is `CatalogName`; StarRocks column is `Catalog`.
            let name = first_nonempty_str_by_name(row, &["CatalogName", "Catalog"]).trim().to_string();
            if name.is_empty() {
                return None;
            }
            let catalog_type = get_str_by_name(row, "Type").trim().to_string();
            let is_current = {
                let value = get_str_by_name(row, "IsCurrent").trim().to_ascii_lowercase();
                !value.is_empty() && value != "no" && value != "false" && value != "0"
            };
            let comment = get_opt_str(row, "Comment").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            Some(crate::db::CatalogInfo { name, catalog_type, is_current, comment })
        })
        .collect();
    Ok(normalize_catalogs(catalogs))
}

/// Sort with the built-in catalog first, then the rest alphabetically by name.
/// The built-in catalog is identified by `CatalogInfo::is_internal` (type-based)
/// rather than by name, so StarRocks `default_catalog` sorts first just like
/// Doris `internal`. No synthetic catalog is injected: `SHOW CATALOGS` always
/// lists the built-in catalog on both engines, and a single-catalog result is
/// handled by the flat-sidebar fallback in the caller.
fn normalize_catalogs(mut catalogs: Vec<crate::db::CatalogInfo>) -> Vec<crate::db::CatalogInfo> {
    catalogs.sort_by(|a, b| match (a.is_internal(), b.is_internal()) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    catalogs
}

/// `SHOW DATABASES FROM <catalog>` → databases in the given catalog.
pub async fn list_databases_show_from(pool: &MySqlPool, catalog: &str) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let sql = format!("SHOW DATABASES FROM {}", quote_identifier(catalog));
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    Ok(database_infos_from_names(rows.iter().map(|row| get_str(row, 0)), false))
}

/// `SHOW TABLES FROM <catalog>.<database>` → tables in an external catalog.
///
/// External catalogs do not support `SHOW TABLE STATUS`, so comments/status are
/// not fetched (the caller only needs names + types for browsing).
pub async fn list_tables_show_from(pool: &MySqlPool, catalog: &str, database: &str) -> Result<Vec<TableInfo>, String> {
    let sql = format!("SHOW TABLES FROM {}", catalog_database_ref(catalog, database));
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let mut tables: Vec<TableInfo> = rows
        .iter()
        .filter_map(|row| {
            let name = get_str(row, 0).trim().to_string();
            if name.is_empty() {
                return None;
            }
            // SHOW FULL TABLES exposes a type column; plain SHOW TABLES does not.
            let table_type = get_str(row, 1);
            Some(TableInfo {
                name,
                table_type: if table_type.trim().is_empty() { "TABLE".to_string() } else { table_type },
                comment: None,
                parent_schema: None,
                parent_name: None,
            })
        })
        .collect();
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tables)
}

/// `SHOW COLUMNS FROM <catalog>.<database>.<table>` → columns of an external
/// catalog table. Falls back to `DESCRIBE` if `SHOW COLUMNS` is rejected.
pub async fn get_columns_show_from(
    pool: &MySqlPool,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let qualified = catalog_table_ref(catalog, database, table);
    let full_sql = format!("SHOW FULL COLUMNS FROM {qualified}");
    let plain_sql = format!("SHOW COLUMNS FROM {qualified}");
    let describe_sql = format!("DESCRIBE {qualified}");
    let mut conn = get_conn_with_health_check(pool).await?;
    let rows: Vec<mysql_async::Row> = match conn.query_iter(&full_sql).await {
        Ok(result) => result.collect_and_drop().await.map_err(|e| e.to_string())?,
        Err(_) => match conn.query_iter(&plain_sql).await {
            Ok(result) => result.collect_and_drop().await.map_err(|e| e.to_string())?,
            Err(_) => {
                let result = conn.query_iter(&describe_sql).await.map_err(|e| e.to_string())?;
                result.collect_and_drop().await.map_err(|e| e.to_string())?
            }
        },
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "Field").trim().to_string();
            if name.is_empty() {
                return None;
            }
            let key = get_str_by_name(row, "Key");
            let collation = get_opt_str(row, "Collation").filter(|s| !s.is_empty());
            Some(ColumnInfo {
                name,
                data_type: get_str_by_name(row, "Type"),
                is_nullable: get_str_by_name(row, "Null").eq_ignore_ascii_case("YES"),
                column_default: get_opt_str(row, "Default"),
                is_primary_key: key.eq_ignore_ascii_case("PRI"),
                extra: get_opt_str(row, "Extra"),
                comment: get_opt_str(row, "Comment")
                    .map(|s| fix_potential_double_encoding(&s))
                    .filter(|s| !s.is_empty()),
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
                enum_values: None,
                character_set: collation
                    .as_deref()
                    .and_then(|c| c.split_once('_').map(|(charset, _)| charset.to_string()))
                    .filter(|s| !s.is_empty()),
                collation,
            })
        })
        .collect())
}

/// `SHOW CREATE TABLE <catalog>.<database>.<table>` → DDL for an external
/// catalog table.
pub async fn show_create_table_ddl_from(
    pool: &MySqlPool,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<String, String> {
    let sql = format!("SHOW CREATE TABLE {}", catalog_table_ref(catalog, database, table));
    let mut conn = get_conn_with_health_check(pool).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let row = rows.first().ok_or("DDL not found")?;
    row.get_opt::<String, usize>(1)
        .and_then(|result| result.ok())
        .or_else(|| row.get_opt::<Vec<u8>, usize>(1).and_then(|result| result.ok()).map(bytes_to_string_lossy))
        .ok_or_else(|| "Failed to read DDL".to_string())
}

/// Best-effort index listing for an external catalog table. External catalogs
/// generally do not expose MySQL-style index metadata via `information_schema`
/// (that view is scoped to the internal catalog), so indexes are derived from
/// `SHOW CREATE TABLE` parsing. Returns empty on failure (graceful degradation
/// — indexes are informational for external tables).
pub async fn list_catalog_indexes(
    pool: &MySqlPool,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let ddl = show_create_table_ddl_from(pool, catalog, database, table).await?;
    Ok(indexes_from_create_table_ddl(&ddl))
}

fn merge_index_infos(target: &mut Vec<IndexInfo>, parsed: Vec<IndexInfo>) {
    let mut seen_names: HashSet<String> = target.iter().map(|index| index.name.to_ascii_lowercase()).collect();
    for index in parsed {
        if index.columns.is_empty() {
            continue;
        }
        if seen_names.contains(&index.name.to_ascii_lowercase())
            || target.iter().any(|existing| {
                existing.is_unique == index.is_unique
                    && existing.is_primary == index.is_primary
                    && existing.columns == index.columns
            })
        {
            continue;
        }
        seen_names.insert(index.name.to_ascii_lowercase());
        target.push(index);
    }
}

fn indexes_from_create_table_ddl(ddl: &str) -> Vec<IndexInfo> {
    let mut indexes = Vec::new();
    for raw_line in ddl.lines() {
        let line = trim_ddl_definition_line(raw_line);
        if line.is_empty() {
            continue;
        }
        let upper = line.to_ascii_uppercase();
        if upper.starts_with("PRIMARY KEY") {
            if let Some(index) = table_key_index("PRIMARY", line, true, true, "PRIMARY KEY") {
                indexes.push(index);
            }
        } else if upper.starts_with("UNIQUE KEY") {
            if let Some(index) = table_key_index("UNIQUE KEY", line, true, false, "UNIQUE KEY") {
                indexes.push(index);
            }
        } else if upper.starts_with("INDEX ") {
            if let Some(index) = secondary_index(line) {
                indexes.push(index);
            }
        }
    }
    indexes
}

fn trim_ddl_definition_line(line: &str) -> &str {
    let mut trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix(',') {
        trimmed = rest.trim_start();
    }
    while let Some(rest) = trimmed.strip_suffix(',') {
        trimmed = rest.trim_end();
    }
    trimmed
}

fn table_key_index(name: &str, line: &str, is_unique: bool, is_primary: bool, index_type: &str) -> Option<IndexInfo> {
    let columns = parse_mysql_index_columns(first_parenthesized_content(line)?);
    if columns.is_empty() {
        return None;
    }
    Some(IndexInfo {
        name: name.to_string(),
        columns,
        is_unique,
        is_primary,
        filter: None,
        index_type: Some(index_type.to_string()),
        included_columns: None,
        comment: None,
    })
}

fn secondary_index(line: &str) -> Option<IndexInfo> {
    let (_, rest) = split_keyword_prefix(line, "INDEX")?;
    let (name, after_name) = read_mysql_identifier(rest.trim_start())?;
    let columns = parse_mysql_index_columns(first_parenthesized_content(after_name)?);
    if columns.is_empty() {
        return None;
    }
    Some(IndexInfo {
        name,
        columns,
        is_unique: false,
        is_primary: false,
        filter: None,
        index_type: mysql_keyword_argument(after_name, "USING").or_else(|| Some("INDEX".to_string())),
        included_columns: None,
        comment: mysql_quoted_string_argument(after_name, "COMMENT"),
    })
}

fn split_keyword_prefix<'a>(line: &'a str, keyword: &str) -> Option<(&'a str, &'a str)> {
    if line.len() < keyword.len() || !line[..keyword.len()].eq_ignore_ascii_case(keyword) {
        return None;
    }
    let rest = &line[keyword.len()..];
    if !rest.is_empty() && is_mysql_identifier_byte(rest.as_bytes()[0]) {
        return None;
    }
    Some((&line[..keyword.len()], rest))
}

fn read_mysql_identifier(input: &str) -> Option<(String, &str)> {
    let input = input.trim_start();
    if input.is_empty() {
        return None;
    }
    let bytes = input.as_bytes();
    if bytes[0] == b'`' {
        let mut i = 1;
        let mut value = String::new();
        while i < bytes.len() {
            if bytes[i] == b'`' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'`' {
                    value.push('`');
                    i += 2;
                    continue;
                }
                return Some((value, &input[i + 1..]));
            }
            let ch = input[i..].chars().next()?;
            value.push(ch);
            i += ch.len_utf8();
        }
        return None;
    }

    let end = input.find(|ch: char| ch.is_whitespace() || matches!(ch, '(' | ')' | ',')).unwrap_or(input.len());
    if end == 0 {
        return None;
    }
    Some((input[..end].to_string(), &input[end..]))
}

fn first_parenthesized_content(input: &str) -> Option<&str> {
    let bytes = input.as_bytes();
    let mut depth = 0usize;
    let mut start = None;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = skip_mysql_quoted(input, i, bytes[i]);
                continue;
            }
            b'(' => {
                if depth == 0 {
                    start = Some(i + 1);
                }
                depth += 1;
            }
            b')' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    return start.map(|start| &input[start..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn split_top_level_csv(input: &str) -> Vec<&str> {
    let bytes = input.as_bytes();
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = skip_mysql_quoted(input, i, bytes[i]);
                continue;
            }
            b'(' => depth += 1,
            b')' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                parts.push(input[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(input[start..].trim());
    parts
}

fn parse_mysql_index_columns(input: &str) -> Vec<String> {
    split_top_level_csv(input)
        .into_iter()
        .filter_map(|part| read_mysql_identifier(part).map(|(column, _)| column))
        .filter(|column| !column.is_empty())
        .collect()
}

fn mysql_keyword_argument(input: &str, keyword: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = skip_mysql_quoted(input, i, bytes[i]);
                continue;
            }
            _ if mysql_keyword_at(input, i, keyword) => {
                return read_mysql_identifier(&input[i + keyword.len()..]).map(|(value, _)| value);
            }
            _ => i += 1,
        }
    }
    None
}

fn mysql_quoted_string_argument(input: &str, keyword: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                i = skip_mysql_quoted(input, i, bytes[i]);
                continue;
            }
            _ if mysql_keyword_at(input, i, keyword) => {
                let rest = input[i + keyword.len()..].trim_start();
                if rest.as_bytes().first().copied() != Some(b'\'') {
                    return None;
                }
                let end = skip_mysql_quoted(rest, 0, b'\'');
                if end <= 1 || end > rest.len() {
                    return None;
                }
                return Some(rest[1..end - 1].replace("\\'", "'").replace("''", "'"));
            }
            _ => i += 1,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doris_create_table_ddl_indexes_include_unique_key_and_inverted_indexes() {
        let ddl = r#"
CREATE TABLE `bfm_org` (
  `org_id` bigint NULL,
  `ORG_CODE` varchar(255) NULL,
  `ORG_NAME` varchar(255) NULL,
  INDEX org_id_idx (`org_id`) USING INVERTED,
  INDEX org_code_idx (`ORG_CODE`) USING INVERTED,
  INDEX org_name_idx (`ORG_NAME`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`org_id`)
COMMENT '部门信息表'
DISTRIBUTED BY HASH(`org_id`) BUCKETS 4
"#;

        let indexes = indexes_from_create_table_ddl(ddl);

        assert_eq!(indexes.len(), 4);
        assert_eq!(indexes[0].name, "org_id_idx");
        assert_eq!(indexes[0].columns, vec!["org_id"]);
        assert!(!indexes[0].is_unique);
        assert_eq!(indexes[0].index_type.as_deref(), Some("INVERTED"));
        assert_eq!(indexes[3].name, "UNIQUE KEY");
        assert_eq!(indexes[3].columns, vec!["org_id"]);
        assert!(indexes[3].is_unique);
        assert!(!indexes[3].is_primary);
        assert_eq!(indexes[3].index_type.as_deref(), Some("UNIQUE KEY"));
    }

    #[test]
    fn doris_create_table_ddl_index_parser_handles_quoted_names_and_comments() {
        let ddl = r#"
CREATE TABLE `search_test` (
  `name``part` varchar(64) NULL,
  INDEX `idx``name` (`name``part`) USING NGRAM_BF COMMENT 'name''s index'
) ENGINE=OLAP
UNIQUE KEY(`tenant_id`, `name``part`)
"#;

        let indexes = indexes_from_create_table_ddl(ddl);

        assert_eq!(indexes.len(), 2);
        assert_eq!(indexes[0].name, "idx`name");
        assert_eq!(indexes[0].columns, vec!["name`part"]);
        assert_eq!(indexes[0].index_type.as_deref(), Some("NGRAM_BF"));
        assert_eq!(indexes[0].comment.as_deref(), Some("name's index"));
        assert_eq!(indexes[1].columns, vec!["tenant_id", "name`part"]);
        assert!(indexes[1].is_unique);
    }

    fn catalog_info(name: &str, catalog_type: &str, is_current: bool) -> crate::db::CatalogInfo {
        crate::db::CatalogInfo {
            name: name.to_string(),
            catalog_type: catalog_type.to_string(),
            is_current,
            comment: None,
        }
    }

    #[test]
    fn catalog_database_ref_backtick_qualifies_two_parts() {
        assert_eq!(catalog_database_ref("iceberg_catalog", "sales"), "`iceberg_catalog`.`sales`");
    }

    #[test]
    fn catalog_table_ref_backtick_qualifies_three_parts() {
        assert_eq!(catalog_table_ref("iceberg_catalog", "sales", "orders"), "`iceberg_catalog`.`sales`.`orders`");
    }

    #[test]
    fn doris_catalog_refs_escape_embedded_backticks() {
        assert_eq!(catalog_database_ref("a`b", "c`d"), "`a``b`.`c``d`");
        assert_eq!(catalog_table_ref("a`b", "c`d", "e`f"), "`a``b`.`c``d`.`e``f`");
    }

    #[test]
    fn normalize_catalogs_does_not_inject_missing_internal() {
        // SHOW CATALOGS always lists the built-in catalog on both engines, so a
        // missing internal catalog is not synthesized — the caller's flat-sidebar
        // fallback handles a single/empty result instead.
        let catalogs =
            vec![catalog_info("iceberg_catalog", "iceberg", true), catalog_info("hive_catalog", "hive", false)];
        let normalized = normalize_catalogs(catalogs);
        let names: Vec<&str> = normalized.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["hive_catalog", "iceberg_catalog"]);
        assert!(!normalized.iter().any(|c| c.is_internal()));
    }

    #[test]
    fn normalize_catalogs_keeps_existing_internal_first() {
        let catalogs = vec![
            catalog_info("iceberg_catalog", "iceberg", false),
            catalog_info("internal", "internal", true),
            catalog_info("hive_catalog", "hive", false),
        ];
        let normalized = normalize_catalogs(catalogs);
        let names: Vec<&str> = normalized.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["internal", "hive_catalog", "iceberg_catalog"]);
    }

    #[test]
    fn normalize_catalogs_sorts_starrocks_default_catalog_first() {
        // StarRocks names its built-in catalog `default_catalog` (Type=Internal);
        // detection is type-based, so it sorts first just like Doris `internal`.
        let catalogs =
            vec![catalog_info("hive_catalog", "hive", false), catalog_info("default_catalog", "Internal", true)];
        let normalized = normalize_catalogs(catalogs);
        let names: Vec<&str> = normalized.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["default_catalog", "hive_catalog"]);
        assert!(normalized[0].is_internal());
        assert!(!normalized[1].is_internal());
    }

    #[test]
    fn normalize_catalogs_detects_internal_by_type_not_name() {
        // A catalog literally named `internal` but with an external type is NOT
        // the built-in catalog and must not sort first.
        let catalogs = vec![catalog_info("internal", "iceberg", false), catalog_info("hive_catalog", "hive", false)];
        let normalized = normalize_catalogs(catalogs);
        let names: Vec<&str> = normalized.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["hive_catalog", "internal"]);
        assert!(!normalized.iter().any(|c| c.is_internal()));
    }

    #[test]
    fn normalize_catalogs_handles_empty_input() {
        let normalized = normalize_catalogs(Vec::new());
        assert!(normalized.is_empty());
    }
}
