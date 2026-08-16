use deadpool_postgres::Pool;

use crate::db;
use crate::models::connection::ConnectionConfig;

pub const DRIVER_PROFILE: &str = "opentenbase";

const TABLE_DISTRIBUTION_SQL: &str = "SELECT c.pclocatortype::text, \
            COALESCE(( \
                SELECT string_agg(a.attname, E'\\n' ORDER BY distributed_column.ordinality) \
                FROM unnest(c.discolnums::smallint[]) WITH ORDINALITY \
                    AS distributed_column(attnum, ordinality) \
                JOIN pg_catalog.pg_attribute a \
                  ON a.attrelid = c.pcrelid AND a.attnum = distributed_column.attnum \
                WHERE NOT a.attisdropped \
            ), '')::text \
     FROM pg_catalog.pgxc_class c \
     JOIN pg_catalog.pg_class relation ON relation.oid = c.pcrelid \
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace \
     WHERE namespace.nspname = $1 AND relation.relname = $2 \
     LIMIT 1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DistributionPolicy {
    Hash(Vec<String>),
    Modulo(Vec<String>),
    Shard(Vec<String>),
    Replication,
    RoundRobin,
}

pub fn is_config(config: &ConnectionConfig) -> bool {
    matches!(config.driver_profile.as_deref(), Some(DRIVER_PROFILE))
}

pub async fn table_distribution(pool: &Pool, schema: &str, table: &str) -> Result<Option<DistributionPolicy>, String> {
    let client = db::postgres::checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let Some(row) =
        client.query_opt(TABLE_DISTRIBUTION_SQL, &[&schema, &table]).await.map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let locator_type = row.try_get::<_, String>(0).map_err(|error| error.to_string())?;
    let columns = row
        .try_get::<_, String>(1)
        .map_err(|error| error.to_string())?
        .lines()
        .map(str::trim)
        .filter(|column| !column.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    parse_distribution_policy(&locator_type, columns)
}

pub fn append_distribution_clause(ddl: &str, distribution: &DistributionPolicy) -> Result<String, String> {
    let clause = render_distribution_clause(distribution)?;
    let insertion = ddl
        .find(";\n")
        .or_else(|| ddl.find(';'))
        .ok_or_else(|| "OpenTenBase DDL has no CREATE TABLE terminator".to_string())?;
    let mut output = String::with_capacity(ddl.len() + clause.len() + 2);
    output.push_str(&ddl[..insertion]);
    output.push('\n');
    output.push_str(&clause);
    output.push_str(&ddl[insertion..]);
    Ok(output)
}

fn parse_distribution_policy(locator_type: &str, columns: Vec<String>) -> Result<Option<DistributionPolicy>, String> {
    let column_distribution = |kind| {
        if columns.is_empty() {
            Err(format!("OpenTenBase {kind} distribution has no distribution columns"))
        } else {
            Ok(columns)
        }
    };
    match locator_type {
        "H" => column_distribution("HASH").map(|columns| Some(DistributionPolicy::Hash(columns))),
        "M" => column_distribution("MODULO").map(|columns| Some(DistributionPolicy::Modulo(columns))),
        "S" => column_distribution("SHARD").map(|columns| Some(DistributionPolicy::Shard(columns))),
        "R" => Ok(Some(DistributionPolicy::Replication)),
        "N" => Ok(Some(DistributionPolicy::RoundRobin)),
        _ => Ok(None),
    }
}

fn render_distribution_clause(distribution: &DistributionPolicy) -> Result<String, String> {
    let render_columns = |kind: &str, columns: &[String]| {
        if columns.is_empty() {
            return Err(format!("OpenTenBase {kind} distribution has no distribution columns"));
        }
        Ok(format!(
            "DISTRIBUTE BY {kind} ({})",
            columns.iter().map(|column| db::postgres::pg_quote_ident(column)).collect::<Vec<_>>().join(", ")
        ))
    };
    match distribution {
        DistributionPolicy::Hash(columns) => render_columns("HASH", columns),
        DistributionPolicy::Modulo(columns) => render_columns("MODULO", columns),
        DistributionPolicy::Shard(columns) => render_columns("SHARD", columns),
        DistributionPolicy::Replication => Ok("DISTRIBUTE BY REPLICATION".to_string()),
        DistributionPolicy::RoundRobin => Ok("DISTRIBUTE BY ROUNDROBIN".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_hash_distribution_before_create_table_terminator() {
        let ddl = "CREATE TABLE \"public\".\"orders\" (\n  \"tenant_id\" integer\n);\n";
        let rendered = append_distribution_clause(
            ddl,
            &DistributionPolicy::Hash(vec!["tenant_id".to_string(), "order id".to_string()]),
        )
        .unwrap();

        assert_eq!(
            rendered,
            "CREATE TABLE \"public\".\"orders\" (\n  \"tenant_id\" integer\n)\nDISTRIBUTE BY HASH (\"tenant_id\", \"order id\");\n"
        );
    }

    #[test]
    fn renders_replication_and_round_robin_distribution() {
        assert_eq!(render_distribution_clause(&DistributionPolicy::Replication).unwrap(), "DISTRIBUTE BY REPLICATION");
        assert_eq!(render_distribution_clause(&DistributionPolicy::RoundRobin).unwrap(), "DISTRIBUTE BY ROUNDROBIN");
    }

    #[test]
    fn maps_current_opentenbase_locator_types() {
        assert_eq!(
            parse_distribution_policy("S", vec!["tenant_id".to_string()]).unwrap(),
            Some(DistributionPolicy::Shard(vec!["tenant_id".to_string()]))
        );
        assert_eq!(
            parse_distribution_policy("M", vec!["tenant_id".to_string()]).unwrap(),
            Some(DistributionPolicy::Modulo(vec!["tenant_id".to_string()]))
        );
        assert_eq!(parse_distribution_policy("D", Vec::new()).unwrap(), None);
    }

    #[test]
    fn distribution_query_matches_opentenbase_catalog_contract() {
        assert!(TABLE_DISTRIBUTION_SQL.contains("pg_catalog.pgxc_class"));
        assert!(TABLE_DISTRIBUTION_SQL.contains("c.discolnums::smallint[]"));
        assert!(TABLE_DISTRIBUTION_SQL.contains("WITH ORDINALITY"));
        assert!(TABLE_DISTRIBUTION_SQL.contains("NOT a.attisdropped"));
    }
}
