use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::sql_dialect::{
    firebird_rows_clause, pagination_strategy, qualified_table_name, PaginationContext, TablePaginationStrategy,
};

use crate::database_search_sql::{build_table_search_conditions, clamp_limit, DatabaseSearchColumn};

/// 多表探测查询：把一批表的搜索条件合并为一条 UNION ALL 语句，
/// 每个分支返回 (序号标签, 命中数)——分支内套与单表查询一致的 WHERE 条件和
/// 该方言的行数限额，COUNT 结果即"该表最多有 limit 条命中"。
/// 标签用分支序号 t0..tN 而非表名字面量，彻底绕开标识符转义；
/// included_indices[k] 是第 k 个分支对应的输入表下标。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSearchProbeTable {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub columns: Vec<DatabaseSearchColumn>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSearchProbeSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_profile: Option<String>,
    #[serde(default)]
    pub tables: Vec<DatabaseSearchProbeTable>,
    pub term: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSearchProbeSql {
    pub sql: String,
    pub included_indices: Vec<usize>,
}

pub fn build_database_search_probe_sql(options: DatabaseSearchProbeSqlOptions) -> Option<DatabaseSearchProbeSql> {
    let database_type = options.database_type;
    let driver_profile = options.driver_profile.as_deref();
    let limit = clamp_limit(options.limit);

    let mut branches = Vec::new();
    let mut included_indices = Vec::new();
    for (index, table) in options.tables.iter().enumerate() {
        // 无可搜列的表剔除出探测批，不中断其余表（进度由调用方按已处理推进）。
        let Some(conditions) =
            build_table_search_conditions(database_type, driver_profile, &table.columns, &options.term)
        else {
            continue;
        };
        let qualified = qualified_table_name(database_type, table.schema.as_deref(), &table.table_name);
        let label = format!("t{}", branches.len());
        branches.push(probe_branch_sql(database_type, &qualified, &conditions.where_clause, &label, limit));
        included_indices.push(index);
    }

    if branches.is_empty() {
        return None;
    }
    Some(DatabaseSearchProbeSql { sql: branches.join("\nUNION ALL\n"), included_indices })
}

fn probe_branch_sql(
    database_type: Option<DatabaseType>,
    qualified_table: &str,
    where_clause: &str,
    label: &str,
    limit: usize,
) -> String {
    let limited_inner = match pagination_strategy(database_type, PaginationContext::BoundedRead) {
        TablePaginationStrategy::SqlServerTop | TablePaginationStrategy::IrisTop => {
            format!("SELECT TOP {limit} 1 FROM {qualified_table} WHERE ({where_clause})")
        }
        TablePaginationStrategy::InformixFirst => {
            format!("SELECT FIRST {limit} 1 FROM {qualified_table} WHERE ({where_clause})")
        }
        TablePaginationStrategy::FirebirdRows => {
            format!("SELECT 1 FROM {qualified_table} WHERE ({where_clause}) {}", firebird_rows_clause(limit, 0))
        }
        TablePaginationStrategy::Db2FetchFirst | TablePaginationStrategy::FetchFirst => {
            format!("SELECT 1 FROM {qualified_table} WHERE ({where_clause}) FETCH FIRST {limit} ROWS ONLY")
        }
        TablePaginationStrategy::Rownum => {
            format!("SELECT 1 FROM {qualified_table} WHERE ({where_clause}) AND ROWNUM <= {limit}")
        }
        // 这些策略没有服务端限额可用，COUNT 会数完所有命中行——正确性不变，代价交给调用方批次控制。
        TablePaginationStrategy::AgentMaxRows
        | TablePaginationStrategy::QuestDbLimit
        | TablePaginationStrategy::LimitOffset
        | TablePaginationStrategy::Unbounded => {
            format!("SELECT 1 FROM {qualified_table} WHERE ({where_clause}) LIMIT {limit}")
        }
    };
    format!("SELECT '{label}' AS table_label, COUNT(*) AS hits FROM ({limited_inner}) probe_branch")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database_search_sql::build_database_search_sql;

    fn col(name: &str, data_type: &str, is_primary_key: bool) -> DatabaseSearchColumn {
        DatabaseSearchColumn { name: name.to_string(), data_type: data_type.to_string(), is_primary_key }
    }

    fn probe_table(schema: Option<&str>, table: &str, columns: Vec<DatabaseSearchColumn>) -> DatabaseSearchProbeTable {
        DatabaseSearchProbeTable { schema: schema.map(str::to_string), table_name: table.to_string(), columns }
    }

    fn probe_options(
        database_type: DatabaseType,
        tables: Vec<DatabaseSearchProbeTable>,
    ) -> DatabaseSearchProbeSqlOptions {
        DatabaseSearchProbeSqlOptions {
            database_type: Some(database_type),
            driver_profile: None,
            tables,
            term: "alice".to_string(),
            limit: Some(20),
        }
    }

    #[test]
    fn oracle_family_branch_uses_rownum_limited_subquery() {
        let probe = build_database_search_probe_sql(probe_options(
            DatabaseType::Dameng,
            vec![probe_table(Some("DLWEB"), "USERS", vec![col("NAME", "varchar2", false), col("PIC", "blob", false)])],
        ))
        .unwrap();

        assert_eq!(probe.included_indices, vec![0]);
        assert_eq!(
            probe.sql,
            "SELECT 't0' AS table_label, COUNT(*) AS hits FROM \
             (SELECT 1 FROM \"DLWEB\".\"USERS\" WHERE (LOWER(CAST(\"NAME\" AS TEXT)) LIKE '%alice%' ESCAPE '~') AND ROWNUM <= 20) probe_branch"
        );
    }

    #[test]
    fn mysql_family_branch_uses_limit_subquery() {
        let probe = build_database_search_probe_sql(probe_options(
            DatabaseType::Mysql,
            vec![
                probe_table(None, "users", vec![col("email", "varchar", false)]),
                probe_table(None, "orders", vec![col("note", "text", false)]),
            ],
        ))
        .unwrap();

        assert_eq!(probe.included_indices, vec![0, 1]);
        assert!(probe.sql.contains("FROM `users` WHERE"));
        assert!(probe.sql.contains("LIMIT 20"));
        assert_eq!(probe.sql.matches("UNION ALL").count(), 1);
        assert!(probe.sql.contains("'t0' AS table_label"));
        assert!(probe.sql.contains("'t1' AS table_label"));
    }

    #[test]
    fn sqlserver_branch_uses_top_subquery() {
        let probe = build_database_search_probe_sql(probe_options(
            DatabaseType::SqlServer,
            vec![probe_table(Some("dbo"), "users", vec![col("name", "nvarchar", false)])],
        ))
        .unwrap();
        assert!(probe.sql.contains("SELECT TOP 20 1 FROM [dbo].[users]"));
    }

    #[test]
    fn postgres_branch_uses_limit_subquery() {
        let probe = build_database_search_probe_sql(probe_options(
            DatabaseType::Postgres,
            vec![probe_table(Some("public"), "orders", vec![col("note", "text", false)])],
        ))
        .unwrap();
        assert!(probe.sql.contains("FROM \"public\".\"orders\""));
        assert!(probe.sql.contains("LIMIT 20) probe_branch"));
    }

    #[test]
    fn tables_without_searchable_columns_are_excluded_and_indices_preserved() {
        let probe = build_database_search_probe_sql(probe_options(
            DatabaseType::Mysql,
            vec![
                probe_table(None, "files", vec![col("payload", "blob", false)]),
                probe_table(None, "users", vec![col("email", "varchar", false)]),
                probe_table(None, "empty", vec![]),
            ],
        ))
        .unwrap();

        // 无可搜列表被剔除，included_indices 指向原输入下标
        assert_eq!(probe.included_indices, vec![1]);
        assert!(probe.sql.contains("'t0' AS table_label"));
        assert!(probe.sql.contains("FROM `users`"));
        assert!(!probe.sql.contains("`files`"));
        assert!(!probe.sql.contains("`empty`"));
    }

    #[test]
    fn empty_or_all_excluded_input_returns_none() {
        assert_eq!(
            build_database_search_probe_sql(DatabaseSearchProbeSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                driver_profile: None,
                tables: vec![],
                term: "alice".to_string(),
                limit: Some(20),
            }),
            None
        );
        assert_eq!(
            build_database_search_probe_sql(probe_options(
                DatabaseType::Mysql,
                vec![probe_table(None, "files", vec![col("payload", "blob", false)])],
            )),
            None
        );
    }

    #[test]
    fn probe_branch_conditions_match_single_table_query_exactly() {
        let columns = vec![col("email", "varchar", false), col("id", "bigint", true)];

        let single = build_database_search_sql(crate::database_search_sql::DatabaseSearchSqlOptions {
            database_type: Some(DatabaseType::Dameng),
            driver_profile: None,
            schema: Some("DLWEB".to_string()),
            table_name: "USERS".to_string(),
            columns: columns.clone(),
            term: "alice".to_string(),
            limit: Some(20),
        })
        .unwrap();
        let probe = build_database_search_probe_sql(probe_options(
            DatabaseType::Dameng,
            vec![probe_table(Some("DLWEB"), "USERS", columns)],
        ))
        .unwrap();

        // 探测分支内的 WHERE 条件与单表查询完全一致（含数值词场景由共享拼装函数保证）
        let single_conds = single.sql.split(" WHERE (").nth(1).unwrap().split(")) WHERE ROWNUM").next().unwrap();
        assert!(probe.sql.contains(&format!("WHERE ({single_conds}) AND ROWNUM <= 20) probe_branch")));
    }

    #[test]
    fn numeric_term_adds_equality_predicates_in_probe_branches() {
        let probe = build_database_search_probe_sql(DatabaseSearchProbeSqlOptions {
            database_type: Some(DatabaseType::Mysql),
            driver_profile: None,
            tables: vec![probe_table(None, "orders", vec![col("id", "bigint", true), col("note", "text", false)])],
            term: "42".to_string(),
            limit: Some(20),
        })
        .unwrap();
        assert!(probe.sql.contains("`note`"));
        assert!(probe.sql.contains("`id` = 42"));
    }
}
