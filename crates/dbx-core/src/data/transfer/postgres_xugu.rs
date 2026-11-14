//! Native PostgreSQL → native Xugu tables. Deliberately not a PostgreSQL-family
//! fallback: unsupported catalog features fail before an overwrite can clear data.

use super::*;
use sqlparser::{ast::Expr, dialect::PostgreSqlDialect, parser::Parser};

pub(crate) fn is_pair(source: &DatabaseType, target: &DatabaseType) -> bool {
    *source == DatabaseType::Postgres && *target == DatabaseType::Xugu
}

fn profile_allowed(config: &ConnectionConfig) -> bool {
    config.db_type == DatabaseType::Postgres && matches!(config.driver_profile.as_deref(), None | Some("postgres"))
}

fn quote(name: &str) -> String {
    quote_identifier(name, &DatabaseType::Postgres)
}

fn parameters(kind: &str) -> Result<Vec<i32>, String> {
    match kind.split_once('(') {
        Some((_, tail)) => tail
            .split_once(')')
            .ok_or_else(|| format!("Incomplete PostgreSQL type: {kind}"))?
            .0
            .split(',')
            .map(|n| n.trim().parse().map_err(|_| format!("Invalid PostgreSQL type: {kind}")))
            .collect(),
        None => Ok(Vec::new()),
    }
}

fn is_zoned(kind: &str) -> bool {
    let kind = kind.to_ascii_lowercase();
    kind.contains("with time zone") || matches!(source_base(&kind).as_str(), "timetz" | "timestamptz")
}

fn source_base(kind: &str) -> String {
    normalize_xugu_type_name(kind).to_ascii_lowercase()
}

pub(super) fn column_type(column: &db::ColumnInfo) -> Result<String, String> {
    let kind = column.data_type.trim().to_ascii_lowercase();
    let params = parameters(&kind)?;
    let base = source_base(&kind);
    let mapped = match base.as_str() {
        "smallint" | "int2" => "SMALLINT".into(),
        "integer" | "int" | "int4" => "INTEGER".into(),
        "bigint" | "int8" | "oid" | "xid" => "BIGINT".into(),
        "real" | "float4" => "FLOAT".into(),
        "double precision" | "float8" => "DOUBLE".into(),
        "boolean" | "bool" => "BOOLEAN".into(),
        "numeric" | "decimal" => {
            let (precision, scale) = match params.as_slice() {
                [p] => (*p, 0),
                [p, s] => (*p, *s),
                _ => {
                    return Err(format!(
                        "PostgreSQL column '{}' needs explicit NUMERIC precision and scale",
                        column.name
                    ))
                }
            };
            if !(1..=38).contains(&precision) || !(0..=precision).contains(&scale) {
                return Err(format!("PostgreSQL column '{}' exceeds Xugu NUMERIC precision/scale", column.name));
            }
            format!("NUMERIC({precision},{scale})")
        }
        "character" | "char" | "bpchar" | "character varying" | "varchar" => {
            let fixed = matches!(base.as_str(), "character" | "char" | "bpchar");
            match params.as_slice() {
                [] if !fixed => "CLOB".into(),
                [] => "CHAR(1)".into(),
                [n] if (1..=60000).contains(n) => format!("{}({n})", if fixed { "CHAR" } else { "VARCHAR" }),
                _ => return Err(format!("PostgreSQL column '{}' exceeds Xugu character length", column.name)),
            }
        }
        // PostgreSQL XML permits content fragments, whereas Xugu XML requires
        // a document. Preserve the complete source text, not a reserialized XML.
        "text" | "xml" | "jsonpath" => "CLOB".into(),
        "name" => "VARCHAR(64)".into(),
        "bit" | "bit varying" | "varbit" => {
            let fixed = base == "bit";
            let n = params.first().copied().unwrap_or(if fixed { 1 } else { 60000 });
            if !(1..=60000).contains(&n) {
                return Err(format!("PostgreSQL column '{}' exceeds Xugu BIT capacity", column.name));
            }
            format!("{}({n})", if fixed { "BIT" } else { "VARBIT" })
        }
        "bytea" => "BLOB".into(),
        // A canonical textual UUID avoids depending on Xugu GUID wire decoding.
        "uuid" => "VARCHAR(36)".into(),
        // Xugu's native JSON numeric representation rounds large JSON number
        // tokens. Preserve PostgreSQL's document text instead of silently
        // changing payloads; existing native JSON targets fail capacity checks.
        "json" | "jsonb" => "CLOB".into(),
        "date" => "DATE".into(),
        "time" | "time without time zone" | "time with time zone" | "timetz" => {
            let p = params.first().copied().unwrap_or(6);
            if !(0..=6).contains(&p) || (is_zoned(&kind) && p > 3) {
                return Err(format!(
                    "PostgreSQL column '{}' TIME precision exceeds the lossless Xugu mapping",
                    column.name
                ));
            }
            if is_zoned(&kind) {
                format!("TIME({p}) WITH TIME ZONE")
            } else if p <= 3 {
                format!("TIME({p})")
            } else {
                // Native TIME stores at most milliseconds. An interval retains
                // microseconds (and PostgreSQL's valid 24:00 endpoint).
                "INTERVAL HOUR(2) TO SECOND(6)".into()
            }
        }
        "timestamp" | "timestamp without time zone" | "timestamp with time zone" | "timestamptz" => {
            let p = params.first().copied().unwrap_or(6);
            if !(0..=6).contains(&p) {
                return Err(format!("Invalid PostgreSQL timestamp precision for '{}'", column.name));
            }
            format!("DATETIME({p}){}", if is_zoned(&kind) { " WITH TIME ZONE" } else { "" })
        }
        "year" | "year to month" | "month" if kind.starts_with("interval ") => "INTERVAL YEAR(8) TO MONTH".into(),
        "day" | "day to hour" | "day to minute" | "day to second" | "hour" | "hour to minute" | "hour to second"
        | "minute" | "minute to second" | "second"
            if kind.starts_with("interval ") =>
        {
            "INTERVAL DAY(6) TO SECOND(6)".into()
        }
        _ => {
            return Err(format!(
                "PostgreSQL → Xugu does not yet support column '{}' type '{}'",
                column.name, column.data_type
            ))
        }
    };
    Ok(mapped)
}

#[derive(Debug, Deserialize)]
struct CatalogColumn {
    name: String,
    kind: String,
    namespace: String,
    type_class: String,
    generated: String,
    identity: String,
    default: Option<String>,
    not_null: bool,
    custom_collation: bool,
    comment: Option<String>,
    sequence: Option<Sequence>,
}

#[derive(Debug, Deserialize)]
struct Sequence {
    reference: String,
    start: String,
    increment: String,
    min: String,
    max: String,
    cycle: bool,
}

#[derive(Debug, Deserialize)]
struct Key {
    name: String,
    kind: String,
    columns: Vec<String>,
    deferrable: bool,
    validated: bool,
    nulls_not_distinct: bool,
    plain_index: bool,
}

#[derive(Debug, Deserialize)]
struct Evidence {
    version: i32,
    kind: String,
    persistence: String,
    partitioned: bool,
    inherits: bool,
    row_security: bool,
    triggers: bool,
    indexes: bool,
    comment: Option<String>,
    columns: Vec<CatalogColumn>,
    keys: Vec<Key>,
}

/// Read exact catalog identity and completeness in one result. No search_path,
/// string-replaced DDL, or best-effort metadata fallback is involved.
fn evidence_sql(schema: &str, table: &str) -> String {
    format!(
        r#"SELECT pg_catalog.json_build_object(
 'version', current_setting('server_version_num')::int,
 'kind', c.relkind, 'persistence', c.relpersistence,
 'partitioned', c.relispartition, 'row_security', c.relrowsecurity OR c.relforcerowsecurity,
 'inherits', EXISTS(SELECT FROM pg_catalog.pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid),
 'triggers', EXISTS(SELECT FROM pg_catalog.pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)
   OR EXISTS(SELECT FROM pg_catalog.pg_rewrite rw WHERE rw.ev_class=c.oid),
 'indexes', EXISTS(SELECT FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid
   AND NOT EXISTS(SELECT FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid
     AND k.conrelid=c.oid AND k.contype IN ('p','u','x'))),
 'comment', pg_catalog.obj_description(c.oid, 'pg_class'),
 'columns', (SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
   'name', a.attname, 'kind', pg_catalog.format_type(a.atttypid,a.atttypmod),
   'namespace', tn.nspname, 'type_class', t.typtype,
   'generated', a.attgenerated, 'identity', a.attidentity,
   'default', pg_catalog.pg_get_expr(d.adbin,d.adrelid), 'not_null', a.attnotnull,
   'custom_collation', a.attcollation<>t.typcollation,
   'comment', pg_catalog.col_description(c.oid,a.attnum),
   'sequence', (SELECT pg_catalog.json_build_object('reference',q.seqrelid::regclass::text,
     'start',q.seqstart::text,'increment',q.seqincrement::text,
     'min',q.seqmin::text,'max',q.seqmax::text,'cycle',q.seqcycle)
     FROM pg_catalog.pg_sequence q WHERE q.seqrelid=pg_catalog.pg_get_serial_sequence(
       pg_catalog.format('%I.%I',n.nspname,c.relname),a.attname)::regclass)
 ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
 JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
 LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'keys', COALESCE((SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
   'name', k.conname, 'kind', k.contype, 'deferrable', k.condeferrable, 'validated',k.convalidated,
   'nulls_not_distinct', COALESCE((to_jsonb(i)->>'indnullsnotdistinct')::boolean,false),
   'plain_index', CASE WHEN k.contype IN ('p','u') THEN COALESCE(
     i.indisvalid AND i.indisready AND i.indnkeyatts=i.indnatts AND i.indpred IS NULL AND i.indexprs IS NULL
     AND EXISTS(SELECT FROM pg_catalog.pg_class ix JOIN pg_catalog.pg_am am ON am.oid=ix.relam
       WHERE ix.oid=i.indexrelid AND am.amname='btree')
     AND NOT EXISTS(SELECT FROM unnest(i.indclass::oid[]) cls(oid)
       JOIN pg_catalog.pg_opclass op ON op.oid=cls.oid WHERE NOT op.opcdefault)
     AND NOT EXISTS(SELECT FROM unnest(i.indoption::smallint[]) opt(value) WHERE opt.value<>0)
     AND NOT EXISTS(SELECT FROM unnest(i.indkey::smallint[],i.indcollation::oid[]) cols(attnum,collation_id)
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=cols.attnum
       WHERE cols.collation_id<>a.attcollation),false) ELSE true END,
   'columns', COALESCE((SELECT pg_catalog.json_agg(a.attname ORDER BY pos.ordinality)
     FROM unnest(k.conkey) WITH ORDINALITY pos(attnum,ordinality)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=pos.attnum),'[]'::json)
 )) FROM pg_catalog.pg_constraint k LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=k.conindid
 WHERE k.conrelid=c.oid),'[]'::json)
 )::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname={} AND c.relname={}"#,
        quote_string_literal(schema),
        quote_string_literal(table)
    )
}

async fn evidence(state: &AppState, pool: &str, schema: &str, table: &str) -> Result<Evidence, String> {
    let result = execute_read_on_pool_with_max_rows(state, pool, &evidence_sql(schema, table), Some(2)).await?;
    let [row] = result.rows.as_slice() else {
        return Err(format!("Missing or ambiguous PostgreSQL table '{schema}.{table}'"));
    };
    let text = row.first().and_then(|v| v.as_str()).ok_or("Incomplete PostgreSQL catalog evidence")?;
    serde_json::from_str(text).map_err(|e| format!("Incomplete PostgreSQL catalog evidence: {e}"))
}

fn literal_default(sql: &str, column: &db::ColumnInfo) -> Result<String, String> {
    let expressions = Parser::parse_sql(&PostgreSqlDialect {}, &format!("SELECT {sql}"))
        .map_err(|e| format!("Unsupported PostgreSQL default: {e}"))?;
    let [sqlparser::ast::Statement::Query(query)] = expressions.as_slice() else {
        return Err("Unsupported PostgreSQL default".into());
    };
    let sqlparser::ast::SetExpr::Select(select) = query.body.as_ref() else {
        return Err("Unsupported PostgreSQL default".into());
    };
    let [sqlparser::ast::SelectItem::UnnamedExpr(expr)] = select.projection.as_slice() else {
        return Err("Unsupported PostgreSQL default".into());
    };
    fn convert(expr: &Expr, column: &db::ColumnInfo) -> Result<String, String> {
        use sqlparser::ast::{UnaryOperator, Value};
        match expr {
            Expr::Value(value) => match &value.value {
                Value::Number(n, _) => Ok(n.clone()),
                Value::SingleQuotedString(s) => {
                    if normalize_xugu_type_name(&column_type(column)?) == "BLOB" {
                        return Err("PostgreSQL non-NULL BYTEA defaults need an explicit migration rule".into());
                    }
                    validate_rows(std::slice::from_ref(column), &[vec![serde_json::Value::String(s.clone())]])?;
                    Ok(quote_string_literal(s))
                }
                Value::Boolean(v) => Ok(if *v { "TRUE" } else { "FALSE" }.into()),
                Value::SingleQuotedByteStringLiteral(s)
                    if matches!(normalize_xugu_type_name(&column_type(column)?).as_str(), "BIT" | "VARBIT") =>
                {
                    validate_rows(std::slice::from_ref(column), &[vec![serde_json::Value::String(s.clone())]])?;
                    Ok(format!("B'{s}'"))
                }
                Value::Null => Ok("NULL".into()),
                _ => Err("Unsupported PostgreSQL default literal".into()),
            },
            Expr::Nested(e) => convert(e, column),
            Expr::Cast { expr, data_type, .. } => {
                let cast = data_type.to_string().to_ascii_lowercase();
                let source = column.data_type.to_ascii_lowercase();
                let text_cast = matches!(cast.as_str(), "text" | "character varying" | "character")
                    && matches!(normalize_xugu_type_name(&column_type(column)?).as_str(), "CLOB" | "VARCHAR" | "CHAR");
                if cast != source && !text_cast {
                    return Err("PostgreSQL default cast changes its declared type".into());
                }
                convert(expr, column)
            }
            Expr::UnaryOp { op: UnaryOperator::Minus, expr } if matches!(expr.as_ref(), Expr::Value(v) if matches!(v.value, Value::Number(..))) => {
                Ok(format!("-{}", convert(expr, column)?))
            }
            _ => Err("PostgreSQL expressions, casts and sequence defaults require an explicit migration rule".into()),
        }
    }
    convert(expr, column)
}

fn owned_nextval(default: Option<&str>, reference: &str) -> bool {
    // Both strings come from PostgreSQL's own deparser in the same catalog query.
    // An OWNED BY dependency alone does not make a column a serial column.
    let argument = format!("{}::regclass", quote_string_literal(reference));
    default.is_some_and(|value| {
        value == format!("nextval({argument})") || value == format!("pg_catalog.nextval({argument})")
    })
}

fn prepare(
    evidence: &Evidence,
    columns: &[db::ColumnInfo],
    schema: &str,
    table: &str,
) -> Result<ddl_plan::PreparedTableDdl, String> {
    if evidence.version < 120000
        || evidence.kind != "r"
        || evidence.persistence != "p"
        || evidence.partitioned
        || evidence.inherits
        || evidence.row_security
        || evidence.triggers
        || evidence.indexes
    {
        return Err("PostgreSQL → Xugu phase one requires PostgreSQL 12+ ordinary persistent tables without inheritance, partitions, row security, user triggers, rewrite rules or standalone indexes".into());
    }
    if columns.is_empty() || evidence.columns.len() != columns.len() {
        return Err("Incomplete PostgreSQL column metadata".into());
    }
    let mut definitions = Vec::new();
    let mut comments = Vec::new();
    let full = format!("{}.{}", quote(schema), quote(table));
    for (source, catalog) in columns.iter().zip(&evidence.columns) {
        if source.name != catalog.name
            || source.data_type != catalog.kind
            || catalog.namespace != "pg_catalog"
            || catalog.type_class != "b"
            || !catalog.generated.is_empty()
            || catalog.custom_collation
        {
            return Err(format!("Unsupported or inconsistent PostgreSQL column metadata for '{}'", source.name));
        }
        let mapped = column_type(source)?;
        let mut definition = format!("{} {mapped}", quote(&source.name));
        if let Some(sequence) = &catalog.sequence {
            if !matches!(mapped.as_str(), "INTEGER" | "BIGINT")
                || !matches!(catalog.identity.as_str(), "" | "d")
                || sequence.cycle
            {
                return Err(format!("Unsupported PostgreSQL identity semantics for '{}'", source.name));
            }
            if catalog.identity.is_empty() && !owned_nextval(catalog.default.as_deref(), &sequence.reference) {
                return Err(format!(
                    "PostgreSQL column '{}' owns a sequence but does not use its plain NEXTVAL default",
                    source.name
                ));
            }
            let start = sequence.start.parse::<i64>().map_err(|_| "Invalid identity start")?;
            let step = sequence.increment.parse::<i64>().map_err(|_| "Invalid identity increment")?;
            let min = sequence.min.parse::<i64>().map_err(|_| "Invalid identity minimum")?;
            let max = sequence.max.parse::<i64>().map_err(|_| "Invalid identity maximum")?;
            let upper = if mapped == "INTEGER" { i32::MAX as i64 } else { i64::MAX };
            let lower = if mapped == "INTEGER" { i32::MIN as i64 } else { i64::MIN };
            if step == 0 || (step > 0 && (min != 1 || max != upper)) || (step < 0 && (min != lower || max != -1)) {
                return Err(format!("Custom PostgreSQL identity bounds are not supported for '{}'", source.name));
            }
            definition.push_str(&format!(" IDENTITY({start},{step})"));
        } else if !catalog.identity.is_empty() {
            return Err(format!("Missing PostgreSQL identity sequence for '{}'", source.name));
        } else if let Some(default) = &catalog.default {
            definition.push_str(&format!(" DEFAULT {}", literal_default(default, source)?));
        }
        if catalog.not_null {
            definition.push_str(" NOT NULL");
        }
        definitions.push(definition);
        if let Some(comment) = &catalog.comment {
            comments.push(format!(
                "COMMENT ON COLUMN {full}.{} IS {}",
                quote(&source.name),
                quote_string_literal(comment)
            ));
        }
    }
    for key in &evidence.keys {
        if key.kind == "n" && key.validated && !key.deferrable {
            continue;
        }
        if !matches!(key.kind.as_str(), "p" | "u")
            || key.deferrable
            || !key.validated
            || key.nulls_not_distinct
            || !key.plain_index
            || key.columns.is_empty()
            || key.columns.iter().any(|name| !columns.iter().any(|c| &c.name == name))
        {
            return Err(format!("Unsupported PostgreSQL constraint '{}'", key.name));
        }
        for name in &key.columns {
            let column = columns.iter().find(|c| &c.name == name).ok_or("Missing PostgreSQL key column")?;
            if matches!(normalize_xugu_type_name(&column_type(column)?).as_str(), "CLOB" | "BLOB") {
                return Err(format!("PostgreSQL key '{}' requires an unsupported Xugu LOB index", key.name));
            }
        }
        definitions.push(format!(
            "CONSTRAINT {} {} ({})",
            quote(&key.name),
            if key.kind == "p" { "PRIMARY KEY" } else { "UNIQUE" },
            key.columns.iter().map(|n| quote(n)).collect::<Vec<_>>().join(", ")
        ));
    }
    let mut ddl = format!("CREATE TABLE {full} (\n  {}\n);", definitions.join(",\n  "));
    if let Some(comment) = &evidence.comment {
        comments.push(format!("COMMENT ON TABLE {full} IS {}", quote_string_literal(comment)));
    }
    for comment in comments {
        ddl.push_str(&format!("\n{comment};"));
    }
    Ok(ddl_plan::PreparedTableDdl {
        ddl,
        reused_source_ddl: false,
        deferred_fk_alters: Vec::new(),
        deferred_fk_names: Vec::new(),
        source_evidence: None,
    })
}

pub(super) async fn prepare_table(
    state: &AppState,
    request: &TransferRequest,
    table: &str,
    target: &str,
    pool: &str,
    columns: &[db::ColumnInfo],
) -> Result<ddl_plan::PreparedTableDdl, String> {
    prepare(&evidence(state, pool, &request.source_schema, table).await?, columns, &request.target_schema, target)
}

/// Keep exact integers/decimals and temporal fractions out of JavaScript numbers.
/// Replace only the generated projection; never rewrite user SQL or its literals.
pub(super) fn project_page(sql: &str, columns: &[db::ColumnInfo], order: &[String]) -> Result<String, String> {
    let names = columns.iter().map(|c| quote(&c.name)).collect::<Vec<_>>().join(", ");
    let prefix = format!("SELECT {names} FROM ");
    let ctid_prefix = format!("SELECT {names}, ctid::text AS {POSTGRES_CTID_ALIAS} FROM ");
    let ctid = if sql.starts_with(&prefix) {
        false
    } else if sql.starts_with(&ctid_prefix) {
        true
    } else {
        return Err("Unexpected PostgreSQL transfer projection".into());
    };
    let projection = columns.iter().map(|column| {
        let name = quote(&column.name);
        let reference = format!("dbx_pg_source.{name}");
        if column.data_type == "bytea" {
            format!("CASE WHEN {reference} IS NULL THEN NULL ELSE '0x'||pg_catalog.encode({reference},'hex') END AS {name}")
        } else if is_zoned(&column.data_type) && source_base(&column.data_type).starts_with("timestamp") {
            let utc = format!("({reference} AT TIME ZONE 'UTC')");
            format!("CASE WHEN {utc}>='0001-01-01' AND {utc}<'10000-01-01' THEN pg_catalog.to_char({utc},'YYYY-MM-DD HH24:MI:SS.US')||' +00:00' ELSE {reference}::text END AS {name}")
        } else if is_zoned(&column.data_type) {
            let offset = format!("extract(timezone from {reference})::int");
            format!("pg_catalog.to_char({reference}::time::interval,'HH24:MI:SS.MS')||CASE WHEN {offset}<0 THEN ' -' ELSE ' +' END||lpad((abs({offset})/3600)::text,2,'0')||':'||lpad(((abs({offset})%3600)/60)::text,2,'0') AS {name}")
        } else if column.data_type.starts_with("interval ") {
            let ym = matches!(source_base(&column.data_type).as_str(), "year" | "month" | "year to month");
            if ym {
                let months = format!("(extract(year from {reference})::bigint*12+extract(month from {reference})::bigint)");
                format!("CASE WHEN {months}<0 THEN '-' ELSE '' END||(abs({months})/12)::text||'-'||(abs({months})%12)::text AS {name}")
            } else {
                let days = format!("extract(day from {reference})::int");
                let rest = format!("({reference}-pg_catalog.make_interval(days=>{days}))");
                format!("CASE WHEN {days}<0 OR {rest}<interval '0' THEN '-' ELSE '' END||abs({days})::text||' '||pg_catalog.to_char(CASE WHEN {rest}<interval '0' THEN -{rest} ELSE {rest} END,'HH24:MI:SS.US') AS {name}")
            }
        } else if column_type(column).is_ok_and(|kind| matches!(normalize_xugu_type_name(&kind).as_str(), "DATE" | "DATETIME")) {
            let format = if column.data_type == "date" { "YYYY-MM-DD" } else { "YYYY-MM-DD HH24:MI:SS.US" };
            format!("CASE WHEN {reference}>='0001-01-01' AND {reference}<'10000-01-01' THEN pg_catalog.to_char({reference},'{format}') ELSE {reference}::text END AS {name}")
        } else if column_type(column).is_ok_and(|kind| normalize_xugu_type_name(&kind) == "TIME") {
            format!("pg_catalog.to_char({reference}::interval,'HH24:MI:SS.MS') AS {name}")
        } else if source_base(&column.data_type).starts_with("time") {
            format!("pg_catalog.to_char({reference}::interval,'HH24:MI:SS.US') AS {name}")
        } else {
            format!("{reference}::text AS {name}")
        }
    }).collect::<Vec<_>>().join(", ");
    let cursor = if ctid { format!(", dbx_pg_source.{POSTGRES_CTID_ALIAS}") } else { String::new() };
    let order = if ctid {
        format!(" ORDER BY dbx_pg_source.{POSTGRES_CTID_ALIAS}::tid")
    } else if !order.is_empty() {
        format!(
            " ORDER BY {}",
            order.iter().map(|n| format!("dbx_pg_source.{}", quote(n))).collect::<Vec<_>>().join(", ")
        )
    } else {
        String::new()
    };
    // Page in native PostgreSQL types BEFORE casting. Ordering an output alias
    // after ::text would put 10 before 2 and silently skip keyset pages.
    Ok(format!("SELECT {projection}{cursor} FROM ({sql}) AS dbx_pg_source{order}"))
}

fn unsafe_predicate(column: &db::ColumnInfo) -> Result<Option<String>, String> {
    let name = quote(&column.name);
    let mapped = column_type(column)?;
    let base = normalize_xugu_type_name(&mapped);
    Ok(match base.as_str() {
        "CHAR" | "VARCHAR" | "CLOB" | "JSON" => {
            let trailing = if base == "VARCHAR" && column.data_type != "uuid" {
                format!(" OR right({name}::text,1)=' '")
            } else {
                String::new()
            };
            Some(format!("(pg_catalog.encode(pg_catalog.convert_to({name}::text,'UTF8'),'hex') ~ '^(..)*f[0-4][89ab][0-9a-f][89ab][0-9a-f][89ab][0-9a-f]'{trailing})"))
        }
        "FLOAT" | "DOUBLE" | "NUMERIC" => Some(format!("{name}::text IN ('NaN','Infinity','-Infinity')")),
        "DATE" | "DATETIME" => {
            Some(format!("(NOT pg_catalog.isfinite({name}) OR {name}<'0001-01-01' OR {name}>='10000-01-01')"))
        }
        "TIME" => Some(format!("{name}::text LIKE '24:%'")),
        "DATETIME WITH TIME ZONE" => {
            let utc = format!("({name} AT TIME ZONE 'UTC')");
            Some(format!("(NOT pg_catalog.isfinite({name}) OR {utc}<'0001-01-01' OR {utc}>='10000-01-01')"))
        }
        "TIME WITH TIME ZONE" => Some(format!("({name}::text LIKE '24:%' OR extract(timezone from {name}) NOT BETWEEN -46740 AND 53940 OR mod(extract(timezone from {name})::int,60)<>0)")),
        "BIT" | "VARBIT" => Some(format!("length({name})>60000")),
        "YEAR TO MONTH" => Some(format!("(abs(extract(year from {name})*12+extract(month from {name}))>1199999999 OR extract(day from {name})<>0 OR extract(hour from {name})<>0 OR extract(minute from {name})<>0 OR extract(second from {name})<>0)")),
        "DAY TO SECOND" => Some(format!("(extract(year from {name})<>0 OR extract(month from {name})<>0 OR abs(extract(day from {name}))>999999 OR abs(extract(hour from {name}))>23 OR extract(day from {name})*(extract(hour from {name})*3600+extract(minute from {name})*60+extract(second from {name}))<0)")),
        _ => None,
    })
}

pub(super) fn validate_rows(columns: &[db::ColumnInfo], rows: &[Vec<serde_json::Value>]) -> Result<(), String> {
    for row in rows {
        if row.len() != columns.len() {
            return Err("Incomplete PostgreSQL transfer row".into());
        }
        for (column, value) in columns.iter().zip(row) {
            let Some(text) = value.as_str() else {
                if value.is_null() {
                    continue;
                }
                return Err(format!("PostgreSQL column '{}' did not return lossless text", column.name));
            };
            let mapped = column_type(column)?;
            let base = normalize_xugu_type_name(&mapped);
            if matches!(base.as_str(), "CHAR" | "VARCHAR" | "CLOB" | "JSON")
                && (text.chars().any(|c| c == '\0' || c as u32 > 0xffff) || (base == "VARCHAR" && text.ends_with(' ')))
            {
                return Err(format!("PostgreSQL column '{}' contains text Xugu cannot preserve", column.name));
            }
            if matches!(base.as_str(), "FLOAT" | "DOUBLE" | "NUMERIC")
                && matches!(text, "NaN" | "Infinity" | "-Infinity")
            {
                return Err(format!("PostgreSQL column '{}' contains a non-finite value", column.name));
            }
            if base == "BOOLEAN" && !matches!(text, "true" | "false") {
                return Err("Invalid PostgreSQL boolean".into());
            }
            if base == "DATE" && chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_err() {
                return Err(format!("PostgreSQL column '{}' contains an unsupported date", column.name));
            }
            if base == "DATETIME" && chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f").is_err() {
                return Err(format!("PostgreSQL column '{}' contains an unsupported timestamp", column.name));
            }
            if base == "TIME" && chrono::NaiveTime::parse_from_str(text, "%H:%M:%S%.f").is_err() {
                return Err(format!("PostgreSQL column '{}' contains an unsupported time", column.name));
            }
            if base == "DATETIME WITH TIME ZONE"
                && chrono::DateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f %:z").is_err()
            {
                return Err(format!("Unsupported PostgreSQL zoned timestamp in '{}'", column.name));
            }
            if base == "TIME WITH TIME ZONE" {
                let valid = text.split_once(' ').is_some_and(|(time, offset)| {
                    chrono::NaiveTime::parse_from_str(time, "%H:%M:%S%.f").is_ok()
                        && chrono::DateTime::parse_from_str(
                            &format!("2000-01-01 {time} {offset}"),
                            "%Y-%m-%d %H:%M:%S%.f %:z",
                        )
                        .is_ok()
                });
                if !valid {
                    return Err("Invalid projected PostgreSQL TIMETZ".into());
                }
            }
            if matches!(base.as_str(), "BIT" | "VARBIT") {
                let n = parameters(&mapped)?[0] as usize;
                if text.len() > n
                    || (base == "BIT" && text.len() != n)
                    || !text.bytes().all(|b| matches!(b, b'0' | b'1'))
                {
                    return Err(format!("PostgreSQL bit value exceeds '{}' capacity", column.name));
                }
            }
            if base == "HOUR TO SECOND" {
                let valid = chrono::NaiveTime::parse_from_str(text, "%H:%M:%S%.f").is_ok()
                    || text.strip_prefix("24:00:00").is_some_and(|tail| {
                        tail.is_empty()
                            || tail.strip_prefix('.').is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b == b'0'))
                    });
                if !valid {
                    return Err("Invalid projected PostgreSQL TIME".into());
                }
            }
            if matches!(base.as_str(), "YEAR TO MONTH" | "DAY TO SECOND") && !valid_interval(text, &base) {
                return Err("Invalid projected PostgreSQL interval".into());
            }
        }
    }
    Ok(())
}

fn valid_interval(text: &str, kind: &str) -> bool {
    let text = text.strip_prefix('-').unwrap_or(text);
    if kind == "YEAR TO MONTH" {
        text.split_once('-').is_some_and(|(y, m)| {
            y.parse::<u32>().is_ok_and(|v| v <= 99_999_999) && m.parse::<u32>().is_ok_and(|v| v <= 11)
        })
    } else {
        text.split_once(' ').is_some_and(|(d, t)| {
            d.parse::<u32>().is_ok_and(|v| v <= 999_999) && chrono::NaiveTime::parse_from_str(t, "%H:%M:%S%.f").is_ok()
        })
    }
}

pub(crate) fn preflight<'a>(
    state: &'a AppState,
    request: &'a TransferRequest,
    source_pool: &'a str,
    target_pool: &'a str,
) -> futures::future::BoxFuture<'a, Result<(), String>> {
    Box::pin(async move {
        if !state.configs.read().await.get(&request.source_connection_id).is_some_and(profile_allowed) {
            return Err("PostgreSQL → Xugu does not enable PostgreSQL-compatible product profiles".into());
        }
        if !request.table_filters.is_empty() {
            return Err("PostgreSQL → Xugu phase one does not support table filters".into());
        }
        if !matches!(state.pool_handle(source_pool).await, Some(PoolKind::Postgres(_))) {
            return Err("PostgreSQL → Xugu requires a native PostgreSQL source".into());
        }
        let version =
            execute_read_on_pool_with_max_rows(state, source_pool, "SELECT pg_catalog.version()", Some(1)).await?;
        let version = version
            .rows
            .first()
            .and_then(|r| r.first())
            .and_then(|v| v.as_str())
            .ok_or("Missing PostgreSQL server version")?;
        let lower = version.to_ascii_lowercase();
        if !version.starts_with("PostgreSQL ")
            || [
                "opengauss",
                "kingbase",
                "highgo",
                "vastbase",
                "cockroach",
                "yugabyte",
                "redshift",
                "gaussdb",
                "greenplum",
            ]
            .iter()
            .any(|family| lower.contains(family))
        {
            return Err("PostgreSQL → Xugu requires a native PostgreSQL server".into());
        }
        for table in &request.tables {
            if is_cancelled(&request.transfer_id).await {
                return Err("Cancelled".into());
            }
            let columns = get_columns_for_transfer(
                state,
                source_pool,
                &request.source_connection_id,
                &request.source_database,
                &request.source_schema,
                table,
                None,
            )
            .await?;
            prepare_table(state, request, table, &request.target_table_name(table), source_pool, &columns).await?;
            let target_name = request.target_table_name(table);
            let targets = crate::schema::list_tables_core(
                state,
                &request.target_connection_id,
                &request.target_database,
                &request.target_schema,
                Some(&target_name),
                None,
                None,
                Some(&["TABLE".into()]),
                None,
            )
            .await?;
            if targets.iter().any(|t| t.name == target_name) {
                let mut target = get_columns_for_transfer(
                    state,
                    target_pool,
                    &request.target_connection_id,
                    &request.target_database,
                    &request.target_schema,
                    &target_name,
                    None,
                )
                .await?;
                enrich_target(state, target_pool, &request.target_schema, &target_name, &mut target).await?;
                validate_target(&columns, &target)?;
            } else if !request.create_table || matches!(request.content, TransferContent::DataOnly) {
                return Err(format!("Xugu target table '{target_name}' does not exist; target has not been modified"));
            }
            if should_copy_data(&request.content) {
                let mut checks = Vec::new();
                for column in &columns {
                    if let Some(predicate) = unsafe_predicate(column)? {
                        checks.push((column.name.clone(), predicate));
                    }
                }
                let projection = columns.iter().map(|c| quote(&c.name)).collect::<Vec<_>>().join(", ");
                let full = format!("{}.{}", quote(&request.source_schema), quote(table));
                // Also force SELECT privilege checking when no type needs a scan.
                execute_read_on_pool_with_max_rows(
                    state,
                    source_pool,
                    &format!("SELECT {projection} FROM {full} LIMIT 0"),
                    Some(1),
                )
                .await?;
                if !checks.is_empty() {
                    let cases = checks
                        .iter()
                        .map(|(name, predicate)| format!("WHEN {predicate} THEN {}", quote_string_literal(name)))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let condition =
                        checks.iter().map(|(_, predicate)| predicate.as_str()).collect::<Vec<_>>().join(" OR ");
                    let invalid = execute_read_on_pool_with_max_rows(
                        state,
                        source_pool,
                        &format!("SELECT CASE {cases} END FROM {full} WHERE {condition} LIMIT 1"),
                        Some(1),
                    )
                    .await?;
                    if let Some(name) = invalid.rows.first().and_then(|r| r.first()).and_then(|v| v.as_str()) {
                        return Err(format!("PostgreSQL table '{table}', column '{name}' contains a value outside the lossless Xugu mapping (text, numeric, bit capacity, temporal range/offset or interval components); target has not been modified"));
                    }
                }
            }
        }
        Ok(())
    })
}

pub(super) fn validate_target(source: &[db::ColumnInfo], target: &[db::ColumnInfo]) -> Result<(), String> {
    for column in source {
        let matches = target.iter().filter(|c| c.name == column.name).collect::<Vec<_>>();
        let [destination] = matches.as_slice() else {
            return Err(format!("Missing or ambiguous Xugu column '{}'", column.name));
        };
        let expected = column_type(column)?;
        let wanted = normalize_xugu_type_name(&expected);
        let actual = normalize_xugu_type_name(&destination.data_type);
        let canonical = |n: &str| {
            match n {
                "INT" => "INTEGER",
                "BOOL" => "BOOLEAN",
                "DECIMAL" | "NUMBER" => "NUMERIC",
                "BIT VARYING" => "VARBIT",
                _ => n,
            }
            .to_string()
        };
        if canonical(&wanted) != canonical(&actual) {
            return Err(format!(
                "Xugu column '{}' must accept {expected}, found {}",
                column.name, destination.data_type
            ));
        }
        let required = parameters(&expected)?;
        let available = parameters(&destination.data_type)?;
        if matches!(wanted.as_str(), "CHAR" | "VARCHAR")
            && destination
                .character_maximum_length
                .or_else(|| available.first().copied())
                .is_none_or(|n| n < required[0])
        {
            return Err(format!("Xugu column '{}' is too short", column.name));
        }
        if matches!(wanted.as_str(), "BIT" | "VARBIT") {
            let n = destination
                .character_maximum_length
                .or(destination.numeric_precision)
                .or_else(|| available.first().copied());
            if n.is_none_or(|n| n < required[0] || (wanted == "BIT" && n != required[0])) {
                return Err(format!("Xugu column '{}' cannot preserve bit width", column.name));
            }
        }
        if wanted == "NUMERIC" {
            let p = destination
                .numeric_precision
                .or_else(|| available.first().copied())
                .ok_or("Missing Xugu numeric precision")?;
            let s =
                destination.numeric_scale.or_else(|| available.get(1).copied()).ok_or("Missing Xugu numeric scale")?;
            if s < required[1] || p - s < required[0] - required[1] {
                return Err(format!("Xugu column '{}' cannot preserve numeric precision", column.name));
            }
        }
        if matches!(wanted.as_str(), "DATETIME" | "TIME" | "DATETIME WITH TIME ZONE" | "TIME WITH TIME ZONE")
            && destination.numeric_scale.or_else(|| available.first().copied()).is_none_or(|p| p < required[0])
        {
            return Err(format!("Xugu column '{}' cannot preserve temporal precision", column.name));
        }
        if matches!(wanted.as_str(), "HOUR TO SECOND" | "DAY TO SECOND" | "YEAR TO MONTH") {
            let leading = destination.numeric_precision.or_else(|| available.first().copied());
            let trailing = destination.numeric_scale.or_else(|| {
                destination
                    .data_type
                    .to_ascii_uppercase()
                    .split_once("SECOND(")
                    .and_then(|(_, s)| s.split_once(')'))
                    .and_then(|(s, _)| s.parse::<i32>().ok())
            });
            if leading.is_none_or(|v| v < required[0]) || (wanted != "YEAR TO MONTH" && trailing.is_none_or(|v| v < 6))
            {
                return Err(format!("Xugu column '{}' cannot preserve interval range/precision", column.name));
            }
        }
        if column.is_nullable && !destination.is_nullable {
            return Err(format!("Nullable PostgreSQL column '{}' has a NOT NULL target", column.name));
        }
        if destination.extra.as_deref().is_some_and(|extra| extra.to_ascii_uppercase().contains("GENERATED")) {
            return Err(format!("Xugu target column '{}' is generated", column.name));
        }
    }
    for column in target {
        if !source.iter().any(|c| c.name == column.name) && !target_column_can_be_omitted(column, &DatabaseType::Xugu) {
            return Err(format!("Required Xugu column '{}' has no PostgreSQL source", column.name));
        }
    }
    Ok(())
}

pub(super) async fn enrich_target(
    state: &AppState,
    pool: &str,
    schema: &str,
    table: &str,
    columns: &mut [db::ColumnInfo],
) -> Result<(), String> {
    let needs = |kind: &str| {
        matches!(
            normalize_xugu_type_name(kind).as_str(),
            "TIME"
                | "DATETIME"
                | "TIME WITH TIME ZONE"
                | "DATETIME WITH TIME ZONE"
                | "HOUR TO SECOND"
                | "DAY TO SECOND"
                | "YEAR TO MONTH"
                | "BIT"
                | "VARBIT"
                | "BIT VARYING"
        )
    };
    if !columns.iter().any(|c| needs(&c.data_type)) {
        return Ok(());
    }
    let sql = format!("SELECT c.COL_NAME,c.SCALE FROM ALL_COLUMNS c JOIN ALL_TABLES t ON c.DB_ID=t.DB_ID AND c.TABLE_ID=t.TABLE_ID JOIN ALL_SCHEMAS s ON t.DB_ID=s.DB_ID AND t.SCHEMA_ID=s.SCHEMA_ID WHERE s.DB_ID=CURRENT_DB_ID AND s.SCHEMA_NAME={} AND t.TABLE_NAME={}", quote_string_literal(schema), quote_string_literal(table));
    let result = execute_read_on_pool(state, pool, &sql).await?;
    for column in columns.iter_mut().filter(|c| needs(&c.data_type)) {
        let rows = result
            .rows
            .iter()
            .filter(|r| r.first().and_then(json_scalar_to_string).as_deref() == Some(column.name.as_str()))
            .collect::<Vec<_>>();
        let [row] = rows.as_slice() else {
            return Err("Missing or ambiguous Xugu type capacity".into());
        };
        let scale = row
            .get(1)
            .and_then(json_scalar_to_string)
            .and_then(|v| v.parse().ok())
            .filter(|n: &i32| *n >= 0)
            .ok_or("Missing Xugu type capacity")?;
        let kind = normalize_xugu_type_name(&column.data_type);
        if matches!(kind.as_str(), "HOUR TO SECOND" | "DAY TO SECOND" | "YEAR TO MONTH") {
            column.numeric_precision = Some(scale / 65536);
            column.numeric_scale = Some(scale % 65536);
        } else if matches!(kind.as_str(), "BIT" | "VARBIT" | "BIT VARYING") {
            column.character_maximum_length = Some(scale);
        } else {
            column.numeric_scale = Some(scale);
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "postgres_xugu_tests.rs"]
mod tests;
