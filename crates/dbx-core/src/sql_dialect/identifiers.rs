use std::collections::HashSet;

use crate::models::connection::DatabaseType;
use percent_encoding::percent_decode_str;

use super::capabilities::{is_schema_aware, is_simple_informix_identifier};

pub const SQLSERVER_LINKED_SCHEMA_PREFIX: &str = "__dbx_sqlserver_linked__:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlServerLinkedSchemaRef {
    pub server: String,
    pub catalog: String,
    pub schema: String,
}

pub fn parse_sqlserver_linked_schema_ref(schema: &str) -> Option<SqlServerLinkedSchemaRef> {
    let payload = schema.strip_prefix(SQLSERVER_LINKED_SCHEMA_PREFIX)?;
    let mut parts = payload.split('|');
    let server = decode_linked_schema_part(parts.next()?)?;
    let catalog = decode_linked_schema_part(parts.next()?)?;
    let schema = decode_linked_schema_part(parts.next()?)?;
    if parts.next().is_some() || server.trim().is_empty() || catalog.trim().is_empty() || schema.trim().is_empty() {
        return None;
    }
    Some(SqlServerLinkedSchemaRef { server, catalog, schema })
}

pub fn sqlserver_linked_table_name(linked: &SqlServerLinkedSchemaRef, table_name: &str) -> String {
    [linked.server.as_str(), linked.catalog.as_str(), linked.schema.as_str(), table_name]
        .into_iter()
        .map(|part| quote_table_identifier(Some(DatabaseType::SqlServer), part))
        .collect::<Vec<_>>()
        .join(".")
}

fn decode_linked_schema_part(value: &str) -> Option<String> {
    percent_decode_str(value).decode_utf8().ok().map(|value| value.into_owned())
}

pub fn qualified_table_name(database_type: Option<DatabaseType>, schema: Option<&str>, table_name: &str) -> String {
    if database_type == Some(DatabaseType::Iotdb) {
        let table_name = quote_table_identifier(database_type, table_name);
        let schema = schema.map(str::trim).filter(|schema| !schema.is_empty());
        if let Some(schema) = schema {
            if table_name == schema || table_name.starts_with(&format!("{schema}.")) {
                return table_name;
            }
            return format!("{}.{}", quote_table_identifier(database_type, schema), table_name);
        }
        return table_name;
    }
    let supports_qualifier = database_type.is_some_and(is_schema_aware)
        || matches!(
            database_type,
            Some(DatabaseType::Mysql | DatabaseType::Goldendb | DatabaseType::StarRocks | DatabaseType::Doris)
        );
    if supports_qualifier
        && database_type != Some(DatabaseType::Jdbc)
        && schema.is_some_and(|schema| !schema.trim().is_empty())
    {
        if database_type == Some(DatabaseType::SqlServer) {
            if let Some(linked) = schema.and_then(parse_sqlserver_linked_schema_ref) {
                return sqlserver_linked_table_name(&linked, table_name);
            }
        }
        return format!(
            "{}.{}",
            quote_table_identifier(database_type, schema.unwrap()),
            quote_table_identifier(database_type, table_name)
        );
    }
    quote_table_identifier(database_type, table_name)
}

/// Like `qualified_table_name`, but also supports 3-part names for SQL Server
/// (`<database>.<schema>.<table>`) and Doris/StarRocks external catalogs
/// (`<catalog>.<database>.<table>`). SQL parsing stores the first segment of a
/// 3-part source in `catalog`; for SQL Server that segment is its database.
/// Doris/StarRocks use `schema` as the middle segment when present, otherwise
/// `database`, and ignore their built-in `internal` catalog.
pub fn qualified_table_name_with_catalog(
    database_type: Option<DatabaseType>,
    catalog: Option<&str>,
    schema: Option<&str>,
    database: Option<&str>,
    table_name: &str,
) -> String {
    let catalog = catalog.map(str::trim).filter(|catalog| !catalog.is_empty());
    match (catalog, database_type) {
        (Some(database), Some(DatabaseType::SqlServer)) => {
            let table = qualified_table_name(database_type, schema, table_name);
            format!("{}.{}", quote_table_identifier(database_type, database), table)
        }
        (Some(catalog), Some(DatabaseType::Doris | DatabaseType::StarRocks)) if catalog != "internal" => {
            let middle = schema
                .map(str::trim)
                .filter(|schema| !schema.is_empty())
                .or_else(|| database.map(str::trim).filter(|database| !database.is_empty()));
            let table = match middle {
                Some(middle) => format!(
                    "{}.{}",
                    quote_table_identifier(database_type, middle),
                    quote_table_identifier(database_type, table_name)
                ),
                None => quote_table_identifier(database_type, table_name),
            };
            format!("{}.{}", quote_table_identifier(database_type, catalog), table)
        }
        _ => qualified_table_name(database_type, schema, table_name),
    }
}

pub fn quote_table_identifier(database_type: Option<DatabaseType>, name: &str) -> String {
    if matches!(database_type, Some(DatabaseType::Gaussdb | DatabaseType::OpenGauss))
        && is_explicitly_quoted_identifier(name)
    {
        return name.to_string();
    }
    match database_type {
        Some(DatabaseType::Iotdb) => name.to_string(),
        // JDBC connections use the driver-reported identifier quote string
        // (DatabaseMetaData.getIdentifierQuoteString()) inside the JDBC agent,
        // so the Rust layer passes identifiers through unquoted.
        Some(DatabaseType::Jdbc) => name.to_string(),
        Some(
            DatabaseType::Mysql
            | DatabaseType::ClickHouse
            | DatabaseType::Doris
            | DatabaseType::Goldendb
            | DatabaseType::StarRocks
            | DatabaseType::ManticoreSearch
            | DatabaseType::Hive
            | DatabaseType::Kyuubi
            | DatabaseType::Impala
            | DatabaseType::Argo
            | DatabaseType::Spark
            | DatabaseType::Databricks
            | DatabaseType::Databend
            | DatabaseType::Tdengine
            | DatabaseType::Access
            | DatabaseType::Bigquery
            // GoogleSQL (Spanner's default dialect) quotes identifiers with backticks;
            // double quotes are string literals there, so `SELECT * FROM "users"` is a
            // syntax error. PostgreSQL-dialect Spanner databases override this through
            // the identifier quote reported by the agent on connect.
            | DatabaseType::Spanner
            | DatabaseType::Questdb,
        ) => {
            format!("`{}`", name.replace('`', "``"))
        }
        Some(DatabaseType::Informix) if is_simple_informix_identifier(name) => name.to_string(),
        Some(DatabaseType::Neo4j) => format!("`{}`", name.replace('`', "``")),
        Some(DatabaseType::SqlServer) => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// Quote an IRIS identifier only when its spelling requires a delimited name.
///
/// Caché/IRIS installations may disable delimited identifiers. The IRIS JDBC
/// preparser turns quoted names into `:%qpar(...)` parameters in that mode,
/// which is not valid in table references. Ordinary metadata names are
/// case-insensitive and can be sent unquoted; names containing separators or
/// other punctuation still need the identifier quote character.
pub(crate) fn quote_iris_identifier(name: &str, identifier_quote: Option<&str>) -> String {
    let mut chars = name.chars();
    let ordinary = chars.next().is_some_and(|first| first == '_' || first == '%' || first.is_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_alphanumeric());
    if ordinary {
        return name.to_string();
    }
    let quote = identifier_quote.map(str::trim).filter(|quote| !quote.is_empty()).unwrap_or("\"");
    format!("{quote}{}{quote}", name.replace(quote, &format!("{quote}{quote}")))
}

pub(crate) fn quote_gaussdb_jdbc_identifier(
    name: &str,
    identifier_quote: &str,
    database_type: Option<DatabaseType>,
) -> String {
    if is_explicitly_quoted_identifier(name) {
        return name.to_string();
    }
    let quote = identifier_quote.trim();
    if quote.is_empty() {
        return name.to_string();
    }
    let requires_quote = !is_simple_lower_identifier(name)
        || is_postgres_reserved_identifier(name)
        || (matches!(database_type, Some(DatabaseType::Gaussdb | DatabaseType::OpenGauss))
            && is_gaussdb_only_reserved_identifier(name))
        || (quote == "`" && is_mysql_only_reserved_identifier(name));
    if !requires_quote {
        return name.to_string();
    }
    format!("{quote}{}{quote}", name.replace(quote, &format!("{quote}{quote}")))
}

fn is_explicitly_quoted_identifier(name: &str) -> bool {
    name.len() >= 2
        && ((name.starts_with('"') && name.ends_with('"'))
            || (name.starts_with('`') && name.ends_with('`'))
            || (name.starts_with('[') && name.ends_with(']')))
}

fn is_simple_lower_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_lowercase())
        && chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_lowercase() || ch.is_ascii_digit())
}

fn is_postgres_reserved_identifier(name: &str) -> bool {
    matches!(
        name,
        "all"
            | "analyse"
            | "analyze"
            | "and"
            | "any"
            | "array"
            | "as"
            | "asc"
            | "asymmetric"
            | "authorization"
            | "binary"
            | "both"
            | "case"
            | "cast"
            | "check"
            | "collate"
            | "collation"
            | "column"
            | "concurrently"
            | "constraint"
            | "create"
            | "cross"
            | "current_catalog"
            | "current_date"
            | "current_role"
            | "current_schema"
            | "current_time"
            | "current_timestamp"
            | "current_user"
            | "default"
            | "deferrable"
            | "desc"
            | "distinct"
            | "do"
            | "else"
            | "end"
            | "except"
            | "false"
            | "fetch"
            | "for"
            | "foreign"
            | "freeze"
            | "from"
            | "full"
            | "grant"
            | "group"
            | "having"
            | "ilike"
            | "in"
            | "initially"
            | "inner"
            | "intersect"
            | "into"
            | "is"
            | "isnull"
            | "join"
            | "lateral"
            | "leading"
            | "left"
            | "like"
            | "limit"
            | "localtime"
            | "localtimestamp"
            | "natural"
            | "not"
            | "notnull"
            | "null"
            | "offset"
            | "on"
            | "only"
            | "or"
            | "order"
            | "outer"
            | "overlaps"
            | "placing"
            | "primary"
            | "references"
            | "returning"
            | "right"
            | "select"
            | "session_user"
            | "similar"
            | "some"
            | "symmetric"
            | "system_user"
            | "table"
            | "tablesample"
            | "then"
            | "to"
            | "trailing"
            | "true"
            | "union"
            | "unique"
            | "user"
            | "using"
            | "variadic"
            | "verbose"
            | "when"
            | "where"
            | "window"
            | "with"
    )
}

/// Words GaussDB/openGauss reserve that plain PostgreSQL does not, so they
/// are missed by [`is_postgres_reserved_identifier`] alone (t8y2/dbx#6283).
/// For example `compact` is a bare lowercase identifier that passes
/// [`is_simple_lower_identifier`] and isn't a Postgres keyword, but GaussDB
/// reserves it and rejects it unquoted in DDL.
///
/// This is the static fallback for when no live `pg_get_keywords()` catalog
/// could be probed from the target (see `AppState::gaussdb_reserved_keywords`).
/// The list was cross-checked against a writable openGauss 5.0.0 instance's
/// own `pg_get_keywords()` — the authoritative source per openGauss's docs —
/// by diffing against its full 653-row catalog: every word below has
/// `catcode` `R` (`reserved`) or `T` (`reserved, can be function or type
/// name`) there. Words from Huawei's GaussDB(DWS) keyword reference that
/// turned out *not* to be reserved on core GaussDB/openGauss (`hot`,
/// `nlssort`, `warmup` aren't keywords at all; `fenced`, `internal`, `plan`,
/// `tsfield`, `tstag`, `tstime` are `unreserved`) are deliberately absent:
/// quoting them would reintroduce the case-locking bug this exists to fix.
/// `compact` was additionally confirmed by running `CREATE TABLE ... (compact
/// int)` unquoted, which fails with `ERROR: syntax error at or near "compact"`.
///
/// Note this snapshot is version-specific — e.g. `maxvalue` is reserved on
/// openGauss 5.0 but unreserved on current openGauss — which is exactly why
/// the live catalog takes precedence whenever it is available.
fn is_gaussdb_only_reserved_identifier(name: &str) -> bool {
    matches!(
        name,
        "authid"
            | "buckets"
            | "compact"
            | "csn"
            | "deltamerge"
            | "excluded"
            | "groupparent"
            | "hdfsdirectory"
            | "less"
            | "maxvalue"
            | "minus"
            | "modify"
            | "nocycle"
            | "performance"
            | "procedure"
            | "recyclebin"
            | "reject"
            | "rownum"
            | "shrink"
            | "sysdate"
            | "timecapsule"
            | "verify"
    )
}

fn is_mysql_only_reserved_identifier(name: &str) -> bool {
    matches!(
        name,
        "accessible"
            | "auto_increment"
            | "change"
            | "database"
            | "databases"
            | "delayed"
            | "describe"
            | "div"
            | "dual"
            | "enclosed"
            | "escaped"
            | "explain"
            | "force"
            | "fulltext"
            | "high_priority"
            | "ignore"
            | "index"
            | "infile"
            | "key"
            | "keys"
            | "kill"
            | "linear"
            | "lines"
            | "load"
            | "lock"
            | "low_priority"
            | "master_ssl_verify_server_cert"
            | "maxvalue"
            | "mediumint"
            | "mod"
            | "no_write_to_binlog"
            | "optimize"
            | "optionally"
            | "outfile"
            | "partition"
            | "purge"
            | "range"
            | "read_write"
            | "regexp"
            | "release"
            | "rename"
            | "replace"
            | "require"
            | "rlike"
            | "schema"
            | "schemas"
            | "separator"
            | "show"
            | "spatial"
            | "sql_big_result"
            | "sql_calc_found_rows"
            | "sql_small_result"
            | "ssl"
            | "starting"
            | "straight_join"
            | "terminated"
            | "tinyint"
            | "unlock"
            | "unsigned"
            | "use"
            | "utc_date"
            | "utc_time"
            | "utc_timestamp"
            | "values"
            | "varbinary"
            | "varchar"
            | "write"
            | "xor"
            | "zerofill"
    )
}

pub fn normalize_where_input(where_input: Option<&str>) -> String {
    let trimmed = where_input.unwrap_or("").trim().trim_end_matches(';').trim();
    let mut chars = trimmed.chars();
    let prefix = chars.by_ref().take(5).collect::<String>();
    if prefix.eq_ignore_ascii_case("where") {
        chars.as_str().trim().to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn quote_transfer_identifier(name: &str, database_type: &DatabaseType) -> String {
    match database_type {
        DatabaseType::Mysql
        | DatabaseType::ClickHouse
        | DatabaseType::Doris
        | DatabaseType::StarRocks
        | DatabaseType::Hive
        | DatabaseType::Kyuubi
        | DatabaseType::Impala
        | DatabaseType::Argo
        | DatabaseType::Spark
        | DatabaseType::Questdb => format!("`{}`", name.replace('`', "``")),
        DatabaseType::SqlServer => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('\"', "\"\"")),
    }
}

/// How data-transfer *column* identifiers are quoted on the target. Table and
/// schema names are unaffected and always go through
/// [`quote_transfer_identifier`].
#[derive(Clone, Copy)]
pub(crate) struct TransferColumnQuoting<'a> {
    /// `TransferRequest::quote_target_column_names`. `true` (the default)
    /// quotes every column name exactly as the source spelled it.
    pub(crate) quote_target_column_names: bool,
    /// Live `pg_get_keywords()` reserved-word catalog for the GaussDB/openGauss
    /// target server (see `AppState::gaussdb_reserved_keywords`). Only
    /// consulted when `quote_target_column_names` is `false` on such a target;
    /// `None` falls back to the static keyword lists.
    pub(crate) gaussdb_keywords: Option<&'a HashSet<String>>,
}

impl TransferColumnQuoting<'static> {
    /// The default: quote every column name.
    pub(crate) const QUOTED: Self = Self { quote_target_column_names: true, gaussdb_keywords: None };
}

impl<'a> TransferColumnQuoting<'a> {
    pub(crate) fn new(quote_target_column_names: bool, gaussdb_keywords: Option<&'a HashSet<String>>) -> Self {
        Self { quote_target_column_names, gaussdb_keywords }
    }
}

/// Quote a transfer column name for the target.
///
/// With `quote_target_column_names` (the default) every name is quoted
/// as-is. When the user opts out of that on a GaussDB/openGauss target
/// (t8y2/dbx#6205), a column is left unquoted only if it is safe to: a plain
/// lowercase identifier that is not a reserved word on that server. Anything
/// else — mixed or upper case, special characters, reserved words — keeps
/// its quotes, so the name can never be silently case-folded by the server
/// or produce invalid DDL. This matches the heuristic already used for
/// GaussDB JDBC identifier quoting in [`quote_gaussdb_jdbc_identifier`].
///
/// The reserved-word check prefers the live `pg_get_keywords()` catalog of
/// the actual target server when one is available, and uses it *alone*: a
/// GaussDB/openGauss server reports its complete reserved-word set for its
/// build, Postgres-inherited words included, so unioning a static list back
/// on top could force-quote a word that server does not reserve (e.g.
/// `maxvalue`, reserved on openGauss 5.0 but not on current openGauss).
/// Without a live catalog it falls back to the static PostgreSQL list plus
/// [`is_gaussdb_only_reserved_identifier`].
pub(crate) fn transfer_column_identifier(
    name: &str,
    database_type: &DatabaseType,
    quoting: TransferColumnQuoting<'_>,
) -> String {
    if quoting.quote_target_column_names || !matches!(database_type, DatabaseType::Gaussdb | DatabaseType::OpenGauss) {
        return quote_transfer_identifier(name, database_type);
    }
    let is_reserved = match quoting.gaussdb_keywords {
        Some(live) => live.contains(name),
        None => is_postgres_reserved_identifier(name) || is_gaussdb_only_reserved_identifier(name),
    };
    if is_simple_lower_identifier(name) && !is_reserved {
        name.to_string()
    } else {
        quote_transfer_identifier(name, database_type)
    }
}

/// Qualified table name for transfer SQL.
///
/// * Without catalog: produces `schema.table` (or just `table` for MySQL family).
/// * With catalog AND the database type supports external catalogs (Doris/StarRocks):
///   produces `catalog.schema.table` — the 3-part form those engines require to
///   address objects in an external (non-internal) catalog.
pub(crate) fn qualified_transfer_table(
    table_name: &str,
    schema: &str,
    database_type: &DatabaseType,
    catalog: Option<&str>,
) -> String {
    let table = quote_transfer_identifier(table_name, database_type);
    if let Some(catalog) = catalog {
        format!(
            "{}.{}.{}",
            quote_transfer_identifier(catalog, database_type),
            quote_transfer_identifier(schema, database_type),
            table
        )
    } else if schema.is_empty()
        || matches!(database_type, DatabaseType::Mysql | DatabaseType::MongoDb | DatabaseType::Questdb)
    {
        table
    } else {
        format!("{}.{}", quote_transfer_identifier(schema, database_type), table)
    }
}
