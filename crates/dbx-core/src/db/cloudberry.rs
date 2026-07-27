use std::collections::HashSet;

use deadpool_postgres::Pool;

use super::{ObjectInfo, TableInfo};
use crate::db;

const CLOUD_BERRY_TABLE_DDL_SQL: &str = "SELECT pg_get_tabledef($1, $2, true)";

const CLOUD_BERRY_EXTERNAL_TABLES_SQL: &str = "SELECT c.relname \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     JOIN pg_catalog.pg_exttable x ON x.reloid = c.oid \
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[])";

const CLOUD_BERRY_TABLE_MODIFIERS_SQL: &str = "SELECT COALESCE(am.amname, '')::text AS access_method, \
            COALESCE(array_to_string(c.reloptions, E'\\n'), '')::text AS reloptions, \
            COALESCE(dp.policytype::text, '')::text AS policy_type, \
            COALESCE(string_agg(a.attname, E'\\n' \
              ORDER BY array_position(dp.distkey::smallint[], a.attnum::smallint)), '')::text \
              AS distribution_columns, \
            bool_or(x.reloid IS NOT NULL) AS is_external, \
            COALESCE(fs.srvname, '')::text AS external_server, \
            ft.ftoptions AS external_options \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam \
     LEFT JOIN pg_catalog.gp_distribution_policy dp ON dp.localoid = c.oid \
     LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(dp.distkey) \
     LEFT JOIN pg_catalog.pg_exttable x ON x.reloid = c.oid \
     LEFT JOIN pg_catalog.pg_foreign_table ft ON ft.ftrelid = c.oid \
     LEFT JOIN pg_catalog.pg_foreign_server fs ON fs.oid = ft.ftserver \
     WHERE n.nspname = $1 AND c.relname = $2 \
       AND c.relkind IN ('r', 'p', 'f') \
     GROUP BY c.oid, am.amname, c.reloptions, dp.policytype, dp.distkey, fs.srvname, ft.ftoptions \
     LIMIT 1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DistributionPolicy {
    Hash(Vec<String>),
    Random,
    Replicated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalTableDefinition {
    pub server: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableModifiers {
    pub access_method: Option<String>,
    pub reloptions: Vec<String>,
    pub distribution: Option<DistributionPolicy>,
    pub external: Option<ExternalTableDefinition>,
}

pub async fn list_tables_filtered(
    pool: &Pool,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<TableInfo>, String> {
    let mut tables = db::postgres::list_tables_filtered(pool, schema, filter, limit, offset).await?;
    annotate_external_tables(pool, schema, &mut tables).await;
    Ok(tables)
}

pub async fn list_objects(pool: &Pool, schema: &str) -> Result<Vec<ObjectInfo>, String> {
    let mut objects = db::postgres::list_objects(pool, schema).await?;
    let names = objects.iter().map(|object| object.name.clone()).collect::<Vec<_>>();
    let external_names = external_table_names(pool, schema, &names).await.unwrap_or_else(|error| {
        log::debug!("[cloudberry][list_objects:external-table-fallback] error={error}");
        HashSet::new()
    });
    for object in &mut objects {
        if external_names.contains(&object.name) {
            object.object_type = "EXTERNAL TABLE".to_string();
        }
    }
    Ok(objects)
}

pub async fn table_ddl(pool: &Pool, schema: &str, table: &str) -> Result<String, String> {
    let client = db::postgres::checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let row = client
        .query_opt(CLOUD_BERRY_TABLE_DDL_SQL, &[&schema, &table])
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Cloudberry table not found: {schema}.{table}"))?;
    let ddl = row.try_get::<_, Option<String>>(0).map_err(|error| error.to_string())?.unwrap_or_default();
    normalize_ddl(ddl)
}

pub async fn table_modifiers(pool: &Pool, schema: &str, table: &str) -> Result<TableModifiers, String> {
    let client = db::postgres::checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let row = client
        .query_opt(CLOUD_BERRY_TABLE_MODIFIERS_SQL, &[&schema, &table])
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Cloudberry table not found: {schema}.{table}"))?;

    let access_method = non_empty(row.try_get::<_, String>(0).map_err(|error| error.to_string())?)
        .filter(|method| !method.eq_ignore_ascii_case("heap"));
    let reloptions = split_catalog_lines(row.try_get::<_, String>(1).map_err(|error| error.to_string())?);
    let policy_type = row.try_get::<_, String>(2).map_err(|error| error.to_string())?;
    let distribution_columns = split_catalog_lines(row.try_get::<_, String>(3).map_err(|error| error.to_string())?);
    let distribution = match policy_type.as_str() {
        "r" => Some(DistributionPolicy::Replicated),
        "p" if distribution_columns.is_empty() => Some(DistributionPolicy::Random),
        "p" => Some(DistributionPolicy::Hash(distribution_columns)),
        _ => None,
    };

    let is_external = row.try_get::<_, bool>(4).map_err(|error| error.to_string())?;
    let external = if is_external {
        let server = row.try_get::<_, String>(5).map_err(|error| error.to_string())?;
        if server.trim().is_empty() {
            return Err(format!("Cloudberry external table has no foreign server: {schema}.{table}"));
        }
        Some(ExternalTableDefinition {
            server,
            options: row.try_get::<_, Option<Vec<String>>>(6).map_err(|error| error.to_string())?.unwrap_or_default(),
        })
    } else {
        None
    };

    Ok(TableModifiers { access_method, reloptions, distribution, external })
}

pub fn append_table_modifiers(ddl: &str, modifiers: &TableModifiers) -> Result<String, String> {
    if let Some(external) = modifiers.external.as_ref() {
        return render_external_table_ddl(ddl, external);
    }

    let clauses = render_table_modifier_clauses(modifiers);
    if clauses.is_empty() {
        return Ok(ddl.to_string());
    }
    let insertion = ddl
        .find(";\n")
        .or_else(|| ddl.find(';'))
        .ok_or_else(|| "Cloudberry fallback DDL has no CREATE TABLE terminator".to_string())?;
    let mut output = String::with_capacity(ddl.len() + clauses.len() + 2);
    output.push_str(&ddl[..insertion]);
    output.push('\n');
    output.push_str(&clauses);
    output.push_str(&ddl[insertion..]);
    Ok(output)
}

fn render_external_table_ddl(ddl: &str, external: &ExternalTableDefinition) -> Result<String, String> {
    let create_table = "CREATE TABLE ";
    if !ddl.starts_with(create_table) {
        return Err("Cloudberry external-table fallback expected CREATE TABLE DDL".to_string());
    }
    let insertion = ddl
        .find(";\n")
        .or_else(|| ddl.find(';'))
        .ok_or_else(|| "Cloudberry fallback DDL has no CREATE TABLE terminator".to_string())?;
    let mut output = String::with_capacity(ddl.len() + external.options.len() * 24 + 48);
    output.push_str("CREATE FOREIGN TABLE ");
    output.push_str(&ddl[create_table.len()..insertion]);
    output.push_str("\nSERVER ");
    output.push_str(&db::postgres::pg_quote_ident(&external.server));
    if !external.options.is_empty() {
        // Cloudberry 2.x stores external tables as foreign tables. Reusing the
        // server options preserves URI, format and execution-location details.
        output.push_str("\nOPTIONS (\n  ");
        output.push_str(
            &external
                .options
                .iter()
                .map(|option| render_foreign_table_option(option))
                .collect::<Result<Vec<_>, _>>()?
                .join(",\n  "),
        );
        output.push_str("\n)");
    }
    output.push_str(&ddl[insertion..]);
    Ok(output)
}

fn render_foreign_table_option(option: &str) -> Result<String, String> {
    let (name, value) =
        option.split_once('=').ok_or_else(|| format!("Invalid Cloudberry foreign-table option: {option}"))?;
    Ok(format!("{} {}", db::postgres::pg_quote_ident(name), quote_sql_string(value)))
}

fn render_table_modifier_clauses(modifiers: &TableModifiers) -> String {
    let mut clauses = Vec::new();
    if let Some(access_method) = modifiers.access_method.as_deref() {
        clauses.push(format!("USING {}", db::postgres::pg_quote_ident(access_method)));
    }
    if !modifiers.reloptions.is_empty() {
        clauses.push(format!("WITH (\n  {}\n)", modifiers.reloptions.join(",\n  ")));
    }
    if let Some(distribution) = modifiers.distribution.as_ref() {
        clauses.push(match distribution {
            DistributionPolicy::Hash(columns) => format!(
                "DISTRIBUTED BY ({})",
                columns.iter().map(|column| db::postgres::pg_quote_ident(column)).collect::<Vec<_>>().join(", ")
            ),
            DistributionPolicy::Random => "DISTRIBUTED RANDOMLY".to_string(),
            DistributionPolicy::Replicated => "DISTRIBUTED REPLICATED".to_string(),
        });
    }
    clauses.join("\n")
}

async fn annotate_external_tables(pool: &Pool, schema: &str, tables: &mut [TableInfo]) {
    let names = tables.iter().map(|table| table.name.clone()).collect::<Vec<_>>();
    let external_names = external_table_names(pool, schema, &names).await.unwrap_or_else(|error| {
        log::debug!("[cloudberry][list_tables:external-table-fallback] error={error}");
        HashSet::new()
    });
    for table in tables {
        if external_names.contains(&table.name) {
            table.table_type = "EXTERNAL TABLE".to_string();
        }
    }
}

async fn external_table_names(pool: &Pool, schema: &str, names: &[String]) -> Result<HashSet<String>, String> {
    if names.is_empty() {
        return Ok(HashSet::new());
    }
    let client = db::postgres::checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows =
        client.query(CLOUD_BERRY_EXTERNAL_TABLES_SQL, &[&schema, &names]).await.map_err(|error| error.to_string())?;
    Ok(rows.into_iter().filter_map(|row| row.try_get::<_, String>(0).ok()).collect())
}

fn normalize_ddl(ddl: String) -> Result<String, String> {
    let ddl = ddl.trim();
    if ddl.is_empty() {
        return Err("Cloudberry returned an empty table DDL".to_string());
    }
    if ddl.ends_with(';') {
        Ok(format!("{ddl}\n"))
    } else {
        Ok(format!("{ddl};\n"))
    }
}

fn non_empty(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn split_catalog_lines(value: String) -> Vec<String> {
    value.lines().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect()
}

fn quote_sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modifiers(distribution: Option<DistributionPolicy>) -> TableModifiers {
        TableModifiers { access_method: None, reloptions: Vec::new(), distribution, external: None }
    }

    #[test]
    fn appends_hash_distribution_before_table_terminator() {
        let ddl = "CREATE TABLE \"public\".\"events\" (\n  \"tenant_id\" integer\n);\n";
        let rendered = append_table_modifiers(
            ddl,
            &modifiers(Some(DistributionPolicy::Hash(vec!["tenant_id".to_string(), "event id".to_string()]))),
        )
        .unwrap();

        assert_eq!(
            rendered,
            "CREATE TABLE \"public\".\"events\" (\n  \"tenant_id\" integer\n)\nDISTRIBUTED BY (\"tenant_id\", \"event id\");\n"
        );
    }

    #[test]
    fn appends_storage_and_replicated_distribution() {
        let ddl = "CREATE TABLE \"public\".\"dimensions\" (\n  \"id\" integer\n);\n";
        let rendered = append_table_modifiers(
            ddl,
            &TableModifiers {
                access_method: Some("ao_column".to_string()),
                reloptions: vec!["compresstype=zstd".to_string(), "compresslevel=3".to_string()],
                distribution: Some(DistributionPolicy::Replicated),
                external: None,
            },
        )
        .unwrap();

        assert!(rendered.contains("USING \"ao_column\""));
        assert!(rendered.contains("WITH (\n  compresstype=zstd,\n  compresslevel=3\n)"));
        assert!(rendered.contains("DISTRIBUTED REPLICATED;"));
    }

    #[test]
    fn renders_external_table_from_foreign_options() {
        let ddl = "CREATE TABLE \"public\".\"external_events\" (\n  \"id\" integer\n);\n";
        let rendered = append_table_modifiers(
            ddl,
            &TableModifiers {
                external: Some(ExternalTableDefinition {
                    server: "gp_exttable_server".to_string(),
                    options: vec![
                        "format=csv".to_string(),
                        "location_uris=file://cdw/tmp/events.csv".to_string(),
                        "null=".to_string(),
                    ],
                }),
                ..modifiers(None)
            },
        )
        .unwrap();

        assert!(rendered.starts_with("CREATE FOREIGN TABLE \"public\".\"external_events\""));
        assert!(rendered.contains("SERVER \"gp_exttable_server\""));
        assert!(rendered.contains("\"location_uris\" 'file://cdw/tmp/events.csv'"));
        assert!(rendered.contains("\"null\" ''"));
    }

    #[test]
    fn ddl_query_uses_cloudberry_native_definition_function() {
        assert_eq!(CLOUD_BERRY_TABLE_DDL_SQL, "SELECT pg_get_tabledef($1, $2, true)");
        assert!(CLOUD_BERRY_TABLE_MODIFIERS_SQL.contains("gp_distribution_policy"));
        assert!(CLOUD_BERRY_TABLE_MODIFIERS_SQL.contains("pg_exttable"));
    }
}
