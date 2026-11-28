use std::collections::{HashMap, HashSet};

use deadpool_postgres::Pool;

use super::partitions::{
    fetch_gp6_partition_catalog, format_gp6_key_definition, parse_gp6_rule_bound, Gp6PartitionLevel, Gp6PartitionRule,
};
use super::probe::GreenplumCapabilities;
use super::{non_empty, normalize_schema, pg_err, quote_sql_string, split_catalog_lines};
use crate::db::{self, ddl_scan};

pub(super) const GP6_EXTTABLE_SQL: &str = "SELECT e.urilocation, \
            e.execlocation, \
            COALESCE(e.fmttype::text, '')::text, \
            COALESCE(e.fmtopts, '')::text, \
            e.options, \
            COALESCE(e.command, '')::text, \
            e.rejectlimit, \
            COALESCE(e.rejectlimittype::text, '')::text, \
            COALESCE(e.logerrors, false), \
            COALESCE(pg_catalog.pg_encoding_to_char(e.encoding), '')::text, \
            COALESCE(e.writable, false) \
     FROM pg_catalog.pg_exttable e \
     WHERE e.reloid = $1::oid \
     LIMIT 1";

pub(super) const GP6_APPENDONLY_SQL: &str = "SELECT COALESCE(ao.blocksize, 32768)::int, \
            COALESCE(ao.compresslevel, 0)::int, \
            COALESCE(ao.checksum, true), \
            COALESCE(ao.compresstype::text, '')::text, \
            COALESCE(ao.columnstore, false) \
     FROM pg_catalog.pg_appendonly ao \
     WHERE ao.relid = $1::oid \
     LIMIT 1";

pub(super) const GP6_ATTRIBUTE_ENCODING_SQL: &str = "SELECT a.attname::text, \
            COALESCE(array_to_string(ae.attoptions, E'\\n'), '')::text \
     FROM pg_catalog.pg_attribute_encoding ae \
     JOIN pg_catalog.pg_attribute a \
       ON a.attrelid = ae.attrelid AND a.attnum = ae.attnum \
     WHERE ae.attrelid = $1::oid \
       AND a.attnum > 0 \
       AND NOT a.attisdropped \
       AND ae.attoptions IS NOT NULL \
     ORDER BY a.attnum";

pub(super) const GP_DISTRIBUTION_FALLBACK_SQL: &str = "SELECT COALESCE(dp.policytype::text, '')::text AS policy_type, \
            COALESCE(( \
              SELECT string_agg(a.attname::text, E'\\n' ORDER BY pos.n) \
              FROM generate_series(1, COALESCE(array_length(string_to_array(btrim(dp.distkey::text), ' '), 1), 0)) AS pos(n) \
              JOIN pg_catalog.pg_attribute a \
                ON a.attrelid = dp.localoid \
               AND a.attnum = (string_to_array(btrim(dp.distkey::text), ' '))[pos.n]::smallint \
               AND a.attnum > 0 \
               AND NOT a.attisdropped \
            ), '')::text AS dist_columns \
     FROM pg_catalog.gp_distribution_policy dp \
     WHERE dp.localoid = $1::oid \
     LIMIT 1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gp6ExternalTableDefinition {
    pub uris: Vec<String>,
    pub exec_locations: Vec<String>,
    pub format_type: String,
    pub format_options: String,
    pub options: Vec<String>,
    pub command: Option<String>,
    pub reject_limit: Option<i32>,
    pub reject_limit_type: Option<String>,
    pub log_errors: bool,
    pub encoding: Option<String>,
    pub writable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gp7ExternalTableDefinition {
    pub server: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gp6ChildPartitionHeader {
    pub parent_schema: String,
    pub parent_table: String,
    pub rule_definition: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TableModifiers {
    pub access_method: Option<String>,
    pub reloptions: Vec<String>,
    pub tablespace: Option<String>,
    pub distribution_clause: Option<String>,
    pub column_encodings: HashMap<String, Vec<String>>,
    pub gp6_partition_def: Option<String>,
    pub gp6_child_partition: Option<Gp6ChildPartitionHeader>,
    pub external_gp6: Option<Gp6ExternalTableDefinition>,
    pub external_gp7: Option<Gp7ExternalTableDefinition>,
}

impl TableModifiers {
    pub fn is_external(&self) -> bool {
        self.external_gp6.is_some() || self.external_gp7.is_some()
    }
}

#[derive(Debug, Clone)]
struct Gp6AppendOnlyInfo {
    blocksize: i32,
    compresslevel: i32,
    checksum: bool,
    compresstype: Option<String>,
    columnstore: bool,
}

// ---------------------------------------------------------------------------
// Catalog Collection (GP6 & GP7 Table Modifiers, Storage, Encoding, External)
// ---------------------------------------------------------------------------

pub async fn table_modifiers(
    pool: &Pool,
    caps: &GreenplumCapabilities,
    schema: &str,
    table: &str,
    include_partitions: bool,
) -> Result<TableModifiers, String> {
    let schema = normalize_schema(schema);
    if !caps.is_classic_gp6() {
        let map = table_modifiers_for_relations(pool, caps, &[(schema.to_string(), table.to_string())]).await?;
        return Ok(map.into_values().next().unwrap_or_default());
    }

    let client = db::postgres::checkout_postgres_client(pool, None, db::connection_timeout()).await?;
    let base_sql = gp6_table_base_modifiers_sql(caps);
    let Some(row) = client.query_opt(&base_sql, &[&schema, &table]).await.map_err(pg_err)? else {
        return Err(format!("Greenplum table not found: {schema}.{table}"));
    };

    let oid = row.try_get::<_, u32>(0).map_err(pg_err)?;
    let relkind = row.try_get::<_, String>(1).unwrap_or_default();
    let relstorage = row.try_get::<_, String>(2).unwrap_or_default();
    let has_oids = row.try_get::<_, bool>(3).unwrap_or(false);
    let mut reloptions = split_catalog_lines(row.try_get::<_, String>(4).unwrap_or_default());
    let tablespace = non_empty(row.try_get::<_, String>(5).unwrap_or_default());
    let mut distribution_clause = non_empty(row.try_get::<_, String>(6).unwrap_or_default());

    if distribution_clause.is_none() && !caps.has_pg_get_table_distributedby && caps.has_gp_distribution_policy {
        distribution_clause = fetch_distribution_clause_fallback(&client, oid).await.unwrap_or_else(|error| {
            log::debug!("[greenplum][distribution-fallback] schema={schema} table={table} error={error}");
            None
        });
    }

    // External table on GP6 (relstorage = 'x').
    let external_gp6 = if relstorage == "x" && caps.has_pg_exttable {
        match fetch_gp6_external_table(&client, oid).await {
            Ok(ext) => ext,
            Err(error) => {
                log::warn!("[greenplum][pg_exttable-fallback] schema={schema} table={table} error={error}");
                None
            }
        }
    } else {
        None
    };

    // Foreign table on GP6 (relkind = 'f').
    let external_gp7 = if relkind == "f" && external_gp6.is_none() {
        fetch_foreign_table_definition(&client, oid).await.unwrap_or(None)
    } else {
        None
    };

    // Append-optimized storage fallback from pg_appendonly when reloptions
    // omits implicit AO fields.
    if matches!(relstorage.as_str(), "a" | "c") {
        let ao_info =
            if caps.has_pg_appendonly { fetch_gp6_appendonly(&client, oid).await.unwrap_or(None) } else { None };
        enrich_gp6_ao_reloptions(&mut reloptions, &relstorage, ao_info.as_ref());
    }

    // Preserve OIDS on GP6 (PG 9.4): always include `oids=true` when enabled;
    // when storage options are already present, include `oids=false` to mirror
    // Greenplum DDL conventions cleanly.
    if caps.has_relhasoids && external_gp6.is_none() && external_gp7.is_none() {
        let already_has_oids = reloptions
            .iter()
            .any(|opt| opt.split_once('=').is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("oids")));
        if !already_has_oids {
            if has_oids {
                reloptions.push("oids=true".to_string());
            } else if !reloptions.is_empty() {
                reloptions.push("oids=false".to_string());
            }
        }
    }

    // Column-level ENCODING (...) for AO column-oriented tables.
    let column_encodings = if relstorage == "c" && caps.has_pg_attribute_encoding {
        fetch_gp6_attribute_encodings(&client, oid).await.unwrap_or_else(|error| {
            log::debug!("[greenplum][pg_attribute_encoding-fallback] schema={schema} table={table} error={error}");
            HashMap::new()
        })
    } else {
        HashMap::new()
    };

    // Partition DDL (root partitioned table) or child partition context.
    let mut gp6_partition_def = None;
    let mut gp6_child_partition = None;
    if external_gp6.is_none() && external_gp7.is_none() {
        let (is_root_partitioned, child_context) = fetch_gp6_table_partition_role(&client, caps, oid).await?;
        if is_root_partitioned {
            gp6_partition_def = fetch_gp6_root_partition_def(&client, caps, oid, include_partitions).await;
        }
        gp6_child_partition = child_context;
    }

    Ok(TableModifiers {
        access_method: None,
        reloptions,
        tablespace,
        distribution_clause,
        column_encodings,
        gp6_partition_def,
        gp6_child_partition,
        external_gp6,
        external_gp7,
    })
}

/// Batched modifiers query for Greenplum 7 (and single-relation GP7 lookups).
/// Fetches `USING` access method, `reloptions`, `TABLESPACE`, `DISTRIBUTED BY`,
/// and foreign/external table options for every relation in a partition tree in
/// a single round trip.
pub async fn table_modifiers_for_relations(
    pool: &Pool,
    caps: &GreenplumCapabilities,
    relations: &[(String, String)],
) -> Result<HashMap<(String, String), TableModifiers>, String> {
    if relations.is_empty() {
        return Ok(HashMap::new());
    }
    let client = db::postgres::checkout_postgres_client(pool, None, db::connection_timeout()).await?;
    let schemas: Vec<&str> = relations.iter().map(|(s, _)| s.as_str()).collect();
    let tables: Vec<&str> = relations.iter().map(|(_, t)| t.as_str()).collect();
    let sql = gp7_table_modifiers_for_relations_sql(caps);
    let rows = client.query(&sql, &[&schemas, &tables]).await.map_err(pg_err)?;

    let mut result = HashMap::new();
    for row in rows {
        let rel_schema = row.try_get::<_, String>(0).map_err(pg_err)?;
        let rel_table = row.try_get::<_, String>(1).map_err(pg_err)?;
        let oid = row.try_get::<_, u32>(2).map_err(pg_err)?;
        let access_method = non_empty(row.try_get::<_, String>(3).unwrap_or_default())
            .filter(|method| !method.eq_ignore_ascii_case("heap"));
        let reloptions = split_catalog_lines(row.try_get::<_, String>(4).unwrap_or_default());
        let tablespace = non_empty(row.try_get::<_, String>(5).unwrap_or_default());
        let mut distribution_clause = non_empty(row.try_get::<_, String>(6).unwrap_or_default());
        if distribution_clause.is_none() && !caps.has_pg_get_table_distributedby && caps.has_gp_distribution_policy {
            distribution_clause = fetch_distribution_clause_fallback(&client, oid).await.unwrap_or(None);
        }
        let is_foreign = row.try_get::<_, bool>(7).unwrap_or(false);
        let external_gp7 = if is_foreign {
            non_empty(row.try_get::<_, String>(8).unwrap_or_default()).map(|server| Gp7ExternalTableDefinition {
                server,
                options: row.try_get::<_, Option<Vec<String>>>(9).ok().flatten().unwrap_or_default(),
            })
        } else {
            None
        };
        result.insert(
            (rel_schema, rel_table),
            TableModifiers {
                access_method,
                reloptions,
                tablespace,
                distribution_clause,
                external_gp7,
                ..Default::default()
            },
        );
    }
    Ok(result)
}

async fn fetch_gp6_appendonly(
    client: &deadpool_postgres::Client,
    oid: u32,
) -> Result<Option<Gp6AppendOnlyInfo>, String> {
    let Some(row) = client.query_opt(GP6_APPENDONLY_SQL, &[&oid]).await.map_err(pg_err)? else {
        return Ok(None);
    };
    Ok(Some(Gp6AppendOnlyInfo {
        blocksize: row.try_get::<_, i32>(0).unwrap_or(32768),
        compresslevel: row.try_get::<_, i32>(1).unwrap_or(0),
        checksum: row.try_get::<_, bool>(2).unwrap_or(true),
        compresstype: non_empty(row.try_get::<_, String>(3).unwrap_or_default()),
        columnstore: row.try_get::<_, bool>(4).unwrap_or(false),
    }))
}

fn enrich_gp6_ao_reloptions(reloptions: &mut Vec<String>, relstorage: &str, ao: Option<&Gp6AppendOnlyInfo>) {
    let has_key = |opts: &[String], keys: &[&str]| {
        opts.iter().any(|opt| {
            opt.split_once('=')
                .is_some_and(|(k, _)| keys.iter().any(|candidate| k.trim().eq_ignore_ascii_case(candidate)))
        })
    };
    if !has_key(reloptions, &["appendonly", "appendoptimized"]) {
        reloptions.insert(0, "appendonly=true".to_string());
    }
    if (relstorage == "c" || ao.is_some_and(|info| info.columnstore)) && !has_key(reloptions, &["orientation"]) {
        reloptions.push("orientation=column".to_string());
    }
    if let Some(info) = ao {
        if let Some(compresstype) = info.compresstype.as_deref() {
            if !compresstype.eq_ignore_ascii_case("none") && !has_key(reloptions, &["compresstype"]) {
                reloptions.push(format!("compresstype={compresstype}"));
            }
        }
        if info.compresslevel > 0 && !has_key(reloptions, &["compresslevel"]) {
            reloptions.push(format!("compresslevel={}", info.compresslevel));
        }
        if info.blocksize != 32768 && !has_key(reloptions, &["blocksize"]) {
            reloptions.push(format!("blocksize={}", info.blocksize));
        }
        if !info.checksum && !has_key(reloptions, &["checksum"]) {
            reloptions.push("checksum=false".to_string());
        }
    }
}

async fn fetch_gp6_attribute_encodings(
    client: &deadpool_postgres::Client,
    oid: u32,
) -> Result<HashMap<String, Vec<String>>, String> {
    let rows = client.query(GP6_ATTRIBUTE_ENCODING_SQL, &[&oid]).await.map_err(pg_err)?;
    let mut encodings = HashMap::new();
    for row in rows {
        let col = row.try_get::<_, String>(0).unwrap_or_default();
        let options = split_catalog_lines(row.try_get::<_, String>(1).unwrap_or_default());
        if !col.is_empty() && !options.is_empty() {
            encodings.insert(col, options);
        }
    }
    Ok(encodings)
}

async fn fetch_gp6_external_table(
    client: &deadpool_postgres::Client,
    oid: u32,
) -> Result<Option<Gp6ExternalTableDefinition>, String> {
    let Some(row) = client.query_opt(GP6_EXTTABLE_SQL, &[&oid]).await.map_err(pg_err)? else {
        return Ok(None);
    };
    Ok(Some(Gp6ExternalTableDefinition {
        uris: row.try_get::<_, Option<Vec<String>>>(0).ok().flatten().unwrap_or_default(),
        exec_locations: row.try_get::<_, Option<Vec<String>>>(1).ok().flatten().unwrap_or_default(),
        format_type: row.try_get::<_, String>(2).unwrap_or_default(),
        format_options: row.try_get::<_, String>(3).unwrap_or_default(),
        options: row.try_get::<_, Option<Vec<String>>>(4).ok().flatten().unwrap_or_default(),
        command: non_empty(row.try_get::<_, String>(5).unwrap_or_default()),
        reject_limit: row.try_get::<_, Option<i32>>(6).ok().flatten().filter(|limit| *limit > 0),
        reject_limit_type: non_empty(row.try_get::<_, String>(7).unwrap_or_default()),
        log_errors: row.try_get::<_, bool>(8).unwrap_or(false),
        encoding: non_empty(row.try_get::<_, String>(9).unwrap_or_default()),
        writable: row.try_get::<_, bool>(10).unwrap_or(false),
    }))
}

async fn fetch_foreign_table_definition(
    client: &deadpool_postgres::Client,
    oid: u32,
) -> Result<Option<Gp7ExternalTableDefinition>, String> {
    let sql = "SELECT COALESCE(fs.srvname::text, '')::text, ft.ftoptions \
               FROM pg_catalog.pg_foreign_table ft \
               JOIN pg_catalog.pg_foreign_server fs ON fs.oid = ft.ftserver \
               WHERE ft.ftrelid = $1::oid \
               LIMIT 1";
    let Some(row) = client.query_opt(sql, &[&oid]).await.map_err(pg_err)? else {
        return Ok(None);
    };
    let Some(server) = non_empty(row.try_get::<_, String>(0).unwrap_or_default()) else {
        return Ok(None);
    };
    Ok(Some(Gp7ExternalTableDefinition {
        server,
        options: row.try_get::<_, Option<Vec<String>>>(1).ok().flatten().unwrap_or_default(),
    }))
}

async fn fetch_distribution_clause_fallback(
    client: &deadpool_postgres::Client,
    oid: u32,
) -> Result<Option<String>, String> {
    let Some(row) = client.query_opt(GP_DISTRIBUTION_FALLBACK_SQL, &[&oid]).await.map_err(pg_err)? else {
        return Ok(None);
    };
    let policy_type = row.try_get::<_, String>(0).unwrap_or_default();
    let columns = split_catalog_lines(row.try_get::<_, String>(1).unwrap_or_default());
    Ok(render_distribution_policy_from_catalog(&policy_type, &columns))
}

fn render_distribution_policy_from_catalog(policy_type: &str, columns: &[String]) -> Option<String> {
    match policy_type.trim() {
        "r" => Some("DISTRIBUTED REPLICATED".to_string()),
        "p" if columns.is_empty() => Some("DISTRIBUTED RANDOMLY".to_string()),
        "p" => Some(format!(
            "DISTRIBUTED BY ({})",
            columns.iter().map(|col| db::postgres::pg_quote_ident(col)).collect::<Vec<_>>().join(", ")
        )),
        _ => None,
    }
}

async fn fetch_gp6_table_partition_role(
    client: &deadpool_postgres::Client,
    caps: &GreenplumCapabilities,
    oid: u32,
) -> Result<(bool, Option<Gp6ChildPartitionHeader>), String> {
    let rule_def_expr = if caps.has_pg_get_partition_rule_def {
        "COALESCE(pg_catalog.pg_get_partition_rule_def(pr.oid, true), '')::text"
    } else {
        "''::text"
    };
    let sql = format!(
        "SELECT EXISTS ( \
           SELECT 1 FROM pg_catalog.pg_partition pp \
           WHERE pp.parrelid = $1::oid AND pp.parlevel = 0 AND NOT pp.paristemplate \
         ) AS is_root_partitioned, \
         pn.nspname::text AS parent_schema, \
         pc.relname::text AS parent_table, \
         {rule_def_expr} AS rule_def, \
         pr.oid AS rule_oid \
         FROM (SELECT $1::oid AS oid) target \
         LEFT JOIN pg_catalog.pg_partition_rule pr ON pr.parchildrelid = target.oid \
         LEFT JOIN pg_catalog.pg_partition pp ON pp.oid = pr.paroid AND NOT pp.paristemplate \
         LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = target.oid \
         LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
         LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
         ORDER BY pr.oid NULLS LAST, i.inhseqno NULLS LAST \
         LIMIT 1"
    );
    let Some(row) = client.query_opt(&sql, &[&oid]).await.map_err(pg_err)? else {
        return Ok((false, None));
    };
    let is_root = row.try_get::<_, bool>(0).unwrap_or(false);
    let rule_oid = row.try_get::<_, Option<u32>>(4).ok().flatten();
    let child_header = if rule_oid.is_some() {
        let parent_schema = row.try_get::<_, Option<String>>(1).ok().flatten().unwrap_or_default();
        let parent_table = row.try_get::<_, Option<String>>(2).ok().flatten().unwrap_or_default();
        let rule_def = row.try_get::<_, String>(3).unwrap_or_default().trim().to_string();
        if !parent_schema.is_empty() && !parent_table.is_empty() {
            Some(Gp6ChildPartitionHeader { parent_schema, parent_table, rule_definition: rule_def })
        } else {
            None
        }
    } else {
        None
    };
    Ok((is_root, child_header))
}

async fn fetch_gp6_root_partition_def(
    client: &deadpool_postgres::Client,
    caps: &GreenplumCapabilities,
    root_oid: u32,
    include_partitions: bool,
) -> Option<String> {
    if include_partitions && caps.has_pg_get_partition_def {
        match client.query_opt("SELECT pg_catalog.pg_get_partition_def($1::oid, true)", &[&root_oid]).await {
            Ok(Some(row)) => {
                if let Some(def) = row.try_get::<_, Option<String>>(0).ok().flatten().map(|s| s.trim().to_string()) {
                    if !def.is_empty() {
                        return Some(def);
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                log::warn!("[greenplum][pg_get_partition_def-fallback] oid={} error={}", root_oid, pg_err(error));
            }
        }
    }

    // Structured fallback from pg_partition + pg_partition_rule (also used for
    // `include_partitions = false` to emit a clean `PARTITION BY ...` header).
    let (levels, rules) = match fetch_gp6_partition_catalog(client, root_oid).await {
        Ok(data) => data,
        Err(error) => {
            log::warn!("[greenplum][partition-catalog-fallback] oid={} error={}", root_oid, error);
            return None;
        }
    };
    render_gp6_partition_def_from_catalog(&levels, &rules, include_partitions)
}

pub(super) fn render_gp6_partition_def_from_catalog(
    levels: &[Gp6PartitionLevel],
    rules: &[Gp6PartitionRule],
    include_partitions: bool,
) -> Option<String> {
    let root_level = levels.iter().find(|level| level.level == 0)?;
    let root_key = format_gp6_key_definition(root_level)?;
    if !include_partitions {
        return Some(format!("PARTITION BY {root_key}"));
    }

    let levels_by_oid: HashMap<u32, &Gp6PartitionLevel> = levels.iter().map(|level| (level.part_oid, level)).collect();
    let mut children_by_parent_rule: HashMap<u32, Vec<&Gp6PartitionRule>> = HashMap::new();
    for rule in rules {
        children_by_parent_rule.entry(rule.parent_rule_oid).or_default().push(rule);
    }
    for children in children_by_parent_rule.values_mut() {
        children.sort_by(|left, right| {
            left.rule_ord.cmp(&right.rule_ord).then_with(|| left.child_name.cmp(&right.child_name))
        });
    }

    let mut visited = HashSet::new();
    let rendered_children =
        render_gp6_partition_rules_level(0, &levels_by_oid, &children_by_parent_rule, 1, &mut visited);
    if rendered_children.is_empty() {
        return Some(format!("PARTITION BY {root_key}"));
    }

    Some(format!("PARTITION BY {root_key}\n(\n{}\n)", rendered_children.join(",\n")))
}

fn render_gp6_partition_rules_level(
    parent_rule_oid: u32,
    levels_by_oid: &HashMap<u32, &Gp6PartitionLevel>,
    children_by_parent_rule: &HashMap<u32, Vec<&Gp6PartitionRule>>,
    depth: usize,
    visited: &mut HashSet<u32>,
) -> Vec<String> {
    let Some(rules) = children_by_parent_rule.get(&parent_rule_oid) else {
        return Vec::new();
    };
    let indent = "  ".repeat(depth);
    let mut lines = Vec::with_capacity(rules.len());
    for rule in rules {
        if !visited.insert(rule.rule_oid) {
            continue;
        }
        let own_kind = levels_by_oid.get(&rule.part_oid).and_then(|level| level.kind);
        let keyword = if depth > 1 { "SUBPARTITION" } else { "PARTITION" };
        let mut clause = if rule.is_default {
            if rule.partition_name.trim().is_empty() {
                format!("{indent}DEFAULT {keyword} other")
            } else {
                format!("{indent}DEFAULT {keyword} {}", db::postgres::pg_quote_ident(&rule.partition_name))
            }
        } else {
            let mut head = String::new();
            head.push_str(&indent);
            if !rule.partition_name.trim().is_empty() {
                head.push_str(&format!("{keyword} {} ", db::postgres::pg_quote_ident(&rule.partition_name)));
            }
            let (_, bound_def) = parse_gp6_rule_bound(rule, own_kind);
            if let Some(bound_def) = bound_def {
                head.push_str(&bound_def);
            }
            head
        };
        if !rule.reloptions.is_empty() {
            clause.push_str(&format!(" WITH ({})", rule.reloptions.join(", ")));
        }
        if let Some(tablespace) = rule.tablespace.as_deref() {
            clause.push_str(&format!(" TABLESPACE {}", db::postgres::pg_quote_ident(tablespace)));
        }

        let sub_rules =
            render_gp6_partition_rules_level(rule.rule_oid, levels_by_oid, children_by_parent_rule, depth + 1, visited);
        if !sub_rules.is_empty() {
            if let Some(sub_key) = children_by_parent_rule
                .get(&rule.rule_oid)
                .and_then(|sub| sub.first())
                .and_then(|first| levels_by_oid.get(&first.part_oid))
                .and_then(|level| format_gp6_key_definition(level))
            {
                clause.push_str(&format!("\n{indent}SUBPARTITION BY {sub_key}"));
            }
            clause.push_str(&format!("\n{indent}(\n{}\n{indent})", sub_rules.join(",\n")));
        }
        lines.push(clause);
    }
    lines
}

pub(super) fn gp6_table_base_modifiers_sql(caps: &GreenplumCapabilities) -> String {
    let relstorage_expr = if caps.has_relstorage { "COALESCE(c.relstorage::text, 'h')" } else { "'h'::text" };
    let relhasoids_expr = if caps.has_relhasoids { "COALESCE(c.relhasoids, false)" } else { "false" };
    let distributedby_expr = if caps.has_pg_get_table_distributedby {
        "COALESCE(pg_catalog.pg_get_table_distributedby(c.oid), '')::text"
    } else {
        "''::text"
    };
    format!(
        "SELECT c.oid, \
                c.relkind::text, \
                {relstorage_expr} AS relstorage, \
                {relhasoids_expr} AS has_oids, \
                COALESCE(array_to_string(c.reloptions, E'\\n'), '')::text AS reloptions, \
                COALESCE(ts.spcname::text, '')::text AS tablespace_name, \
                {distributedby_expr} AS distributed_by \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = c.reltablespace AND c.reltablespace <> 0 \
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'f') \
         LIMIT 1"
    )
}

fn gp7_table_modifiers_for_relations_sql(caps: &GreenplumCapabilities) -> String {
    let distributedby_expr = if caps.has_pg_get_table_distributedby {
        "COALESCE(pg_catalog.pg_get_table_distributedby(c.oid), '')::text"
    } else {
        "''::text"
    };
    format!(
        "SELECT n.nspname::text, \
                c.relname::text, \
                c.oid, \
                COALESCE(am.amname::text, '')::text AS access_method, \
                COALESCE(array_to_string(c.reloptions, E'\\n'), '')::text AS reloptions, \
                COALESCE(ts.spcname::text, '')::text AS tablespace_name, \
                {distributedby_expr} AS distributed_by, \
                (c.relkind = 'f') AS is_foreign, \
                COALESCE(fs.srvname::text, '')::text AS foreign_server, \
                ft.ftoptions AS foreign_options \
         FROM unnest($1::text[], $2::text[]) AS rel(rel_schema, rel_table) \
         JOIN pg_catalog.pg_namespace n ON n.nspname = rel.rel_schema \
         JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = rel.rel_table \
         LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam \
         LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = c.reltablespace AND c.reltablespace <> 0 \
         LEFT JOIN pg_catalog.pg_foreign_table ft ON ft.ftrelid = c.oid \
         LEFT JOIN pg_catalog.pg_foreign_server fs ON fs.oid = ft.ftserver \
         WHERE c.relkind IN ('r', 'p', 'f')"
    )
}

// ---------------------------------------------------------------------------
// Pure DDL Rendering Functions (Unit-Tested Without a Live Database)
// ---------------------------------------------------------------------------

fn skip_leading_ws_and_line_comments(s: &str) -> usize {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'\n' {
                i += 1;
            }
            continue;
        }
        break;
    }
    i
}

/// Finds the first top-level `CREATE [FOREIGN] TABLE` statement in `ddl`,
/// returning `(stmt_body_start, stmt_end)` where `stmt_body_start` skips any
/// leading whitespace and `-- ...` comments.
fn find_create_table_statement_span(ddl: &str) -> Option<(usize, usize)> {
    for range in ddl_scan::top_level_statement_ranges(ddl) {
        let statement = &ddl[range.clone()];
        let prefix = skip_leading_ws_and_line_comments(statement);
        if ddl_scan::parse_create_table_relation(&statement[prefix..]).is_some() {
            return Some((range.start + prefix, range.end));
        }
    }
    None
}

/// Applies Greenplum modifiers to a single rendered `CREATE TABLE` DDL string.
pub fn apply_table_modifiers(ddl: &str, modifiers: &TableModifiers) -> Result<String, String> {
    if let Some(external) = modifiers.external_gp6.as_ref() {
        return render_gp6_external_table_ddl(ddl, external, modifiers.distribution_clause.as_deref());
    }
    if let Some(external) = modifiers.external_gp7.as_ref() {
        return render_gp7_external_table_ddl(ddl, external);
    }

    let mut working = ddl.to_string();
    if !modifiers.column_encodings.is_empty() {
        working = inject_column_encodings(&working, &modifiers.column_encodings);
    }
    if modifiers.gp6_child_partition.is_some() {
        working = strip_top_level_inherits_clause(&working);
    }

    let clauses = render_table_modifier_clauses(modifiers);
    if !clauses.is_empty() {
        let (stmt_start, stmt_end) = find_create_table_statement_span(&working)
            .ok_or_else(|| "Greenplum DDL has no CREATE TABLE statement".to_string())?;
        let statement = &working[stmt_start..stmt_end];
        let insertion = if statement.ends_with(';') { stmt_end - 1 } else { stmt_end };
        let mut output = String::with_capacity(working.len() + clauses.len() + 2);
        output.push_str(&working[..insertion]);
        output.push('\n');
        output.push_str(&clauses);
        output.push_str(&working[insertion..]);
        working = output;
    }

    if let Some(child_header) = modifiers.gp6_child_partition.as_ref() {
        let parent_ref = format!(
            "{}.{}",
            db::postgres::pg_quote_ident(&child_header.parent_schema),
            db::postgres::pg_quote_ident(&child_header.parent_table)
        );
        let comment = if child_header.rule_definition.is_empty() {
            format!("-- Greenplum partition of {parent_ref}\n")
        } else {
            format!("-- Greenplum partition of {parent_ref}: {}\n", child_header.rule_definition)
        };
        working.insert_str(0, &comment);
    }

    Ok(working)
}

/// Tree-aware sibling of `apply_table_modifiers` for GP7 declarative partition
/// trees where `ddl` contains multiple `CREATE [FOREIGN] TABLE` statements.
pub fn apply_tree_table_modifiers(
    ddl: &str,
    modifiers_by_relation: &HashMap<(String, String), TableModifiers>,
) -> Result<String, String> {
    if modifiers_by_relation.is_empty() {
        return Ok(ddl.to_string());
    }
    let mut output = String::with_capacity(ddl.len() + modifiers_by_relation.len() * 64);
    let mut cursor = 0usize;
    for range in ddl_scan::top_level_statement_ranges(ddl) {
        let statement = &ddl[range.clone()];
        let prefix = skip_leading_ws_and_line_comments(statement);
        let Some(relation) = ddl_scan::parse_create_table_relation(&statement[prefix..]) else {
            continue;
        };
        let Some(modifiers) = modifiers_by_relation.get(&relation) else {
            continue;
        };
        let stmt_start = range.start + prefix;
        let stmt_body = &ddl[stmt_start..range.end];
        let rendered_stmt = apply_table_modifiers(stmt_body, modifiers)?;
        output.push_str(&ddl[cursor..stmt_start]);
        output.push_str(&rendered_stmt);
        cursor = range.end;
    }
    output.push_str(&ddl[cursor..]);
    Ok(output)
}

fn render_table_modifier_clauses(modifiers: &TableModifiers) -> String {
    let mut clauses = Vec::new();
    if let Some(access_method) = modifiers.access_method.as_deref() {
        clauses.push(format!("USING {}", db::postgres::pg_quote_ident(access_method)));
    }
    if !modifiers.reloptions.is_empty() {
        clauses.push(format!("WITH (\n  {}\n)", modifiers.reloptions.join(",\n  ")));
    }
    if let Some(tablespace) = modifiers.tablespace.as_deref() {
        clauses.push(format!("TABLESPACE {}", db::postgres::pg_quote_ident(tablespace)));
    }
    if let Some(distribution) = modifiers.distribution_clause.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push(distribution.to_string());
    }
    if let Some(partition_def) = modifiers.gp6_partition_def.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push(partition_def.to_string());
    }
    clauses.join("\n")
}

fn render_gp6_external_table_ddl(
    ddl: &str,
    external: &Gp6ExternalTableDefinition,
    distribution_clause: Option<&str>,
) -> Result<String, String> {
    let (abs_stmt_start, stmt_end) = find_create_table_statement_span(ddl)
        .ok_or_else(|| "Greenplum external-table fallback expected CREATE TABLE DDL".to_string())?;
    let trimmed = &ddl[abs_stmt_start..stmt_end];
    let create_foreign = "CREATE FOREIGN TABLE ";
    let create_table = "CREATE TABLE ";
    let header_len = if trimmed.starts_with(create_foreign) {
        create_foreign.len()
    } else if trimmed.starts_with(create_table) {
        create_table.len()
    } else {
        return Err("Greenplum external-table fallback expected CREATE TABLE header".to_string());
    };
    let abs_after_header = abs_stmt_start + header_len;
    let stmt_end_before_semi = if trimmed.ends_with(';') { stmt_end - 1 } else { stmt_end };
    let body_end = ddl_scan::find_top_level_paren_close(ddl, abs_after_header).unwrap_or(stmt_end_before_semi);

    let is_web = external.command.is_some()
        || external.uris.iter().any(|uri| {
            let lower = uri.trim().to_ascii_lowercase();
            lower.starts_with("http://") || lower.starts_with("https://")
        });
    let direction = if external.writable { "WRITABLE" } else { "READABLE" };
    let web = if is_web { " WEB" } else { "" };

    let mut out = String::with_capacity(ddl.len() + 256);
    out.push_str(&ddl[..abs_stmt_start]);
    out.push_str(&format!("CREATE {direction} EXTERNAL{web} TABLE "));
    out.push_str(&ddl[abs_after_header..body_end]);

    if let Some(command) = external.command.as_deref() {
        out.push_str(&format!("\nEXECUTE {}", quote_sql_string(command)));
        if let Some(on_clause) = format_gp6_exec_location(&external.exec_locations) {
            out.push(' ');
            out.push_str(&on_clause);
        }
    } else if !external.uris.is_empty() {
        let uris = external.uris.iter().map(|uri| quote_sql_string(uri)).collect::<Vec<_>>().join(",\n  ");
        out.push_str(&format!("\nLOCATION (\n  {uris}\n)"));
        if let Some(on_clause) = format_gp6_exec_location(&external.exec_locations) {
            if on_clause != "ON ALL" {
                out.push(' ');
                out.push_str(&on_clause);
            }
        }
    }

    let format_name = match external.format_type.trim().to_ascii_lowercase().as_str() {
        "c" => "CSV",
        "b" => "CUSTOM",
        _ => "TEXT",
    };
    let fmt_opts = external.format_options.trim();
    if fmt_opts.is_empty() {
        out.push_str(&format!("\nFORMAT '{format_name}'"));
    } else {
        out.push_str(&format!("\nFORMAT '{format_name}' ({fmt_opts})"));
    }

    if !external.options.is_empty() {
        let opts = external
            .options
            .iter()
            .filter_map(|opt| opt.split_once('='))
            .map(|(k, v)| format!("{} {}", db::postgres::pg_quote_ident(k.trim()), quote_sql_string(v)))
            .collect::<Vec<_>>();
        if !opts.is_empty() {
            out.push_str(&format!("\nOPTIONS (\n  {}\n)", opts.join(",\n  ")));
        }
    }
    if let Some(encoding) = external.encoding.as_deref() {
        out.push_str(&format!("\nENCODING {}", quote_sql_string(encoding)));
    }
    if external.log_errors {
        out.push_str("\nLOG ERRORS");
    }
    if let Some(limit) = external.reject_limit {
        let unit = match external.reject_limit_type.as_deref().map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("p") => "PERCENT",
            _ => "ROWS",
        };
        out.push_str(&format!("\nSEGMENT REJECT LIMIT {limit} {unit}"));
    }
    if external.writable {
        if let Some(dist) = distribution_clause.map(str::trim).filter(|s| !s.is_empty()) {
            out.push('\n');
            out.push_str(dist);
        }
    }

    out.push_str(&ddl[stmt_end_before_semi..]);
    Ok(out)
}

fn format_gp6_exec_location(locations: &[String]) -> Option<String> {
    let first = locations.first()?.trim();
    if first.is_empty() {
        return None;
    }
    let upper = first.to_ascii_uppercase();
    if upper == "ALL_SEGMENTS" {
        return Some("ON ALL".to_string());
    }
    if upper == "MASTER_ONLY" || upper == "COORDINATOR_ONLY" {
        return Some("ON MASTER".to_string());
    }
    if upper == "PER_HOST" {
        return Some("ON HOST".to_string());
    }
    if let Some(host) = first.strip_prefix("HOST:").or_else(|| first.strip_prefix("host:")) {
        return Some(format!("ON HOST {}", quote_sql_string(host)));
    }
    if let Some(seg) = first.strip_prefix("SEGMENT_ID:").or_else(|| first.strip_prefix("segment_id:")) {
        return Some(format!("ON SEGMENT {seg}"));
    }
    if let Some(count) = first.strip_prefix("TOTAL_SEGS:").or_else(|| first.strip_prefix("total_segs:")) {
        return Some(format!("ON {count}"));
    }
    None
}

fn render_gp7_external_table_ddl(ddl: &str, external: &Gp7ExternalTableDefinition) -> Result<String, String> {
    let (abs_stmt_start, stmt_end) = find_create_table_statement_span(ddl)
        .ok_or_else(|| "Greenplum foreign-table fallback expected CREATE TABLE DDL".to_string())?;
    let trimmed = &ddl[abs_stmt_start..stmt_end];
    let create_foreign = "CREATE FOREIGN TABLE ";
    let create_table = "CREATE TABLE ";
    let header_len = if trimmed.starts_with(create_foreign) {
        create_foreign.len()
    } else if trimmed.starts_with(create_table) {
        create_table.len()
    } else {
        return Err("Greenplum foreign-table fallback expected CREATE TABLE header".to_string());
    };
    let abs_after_header = abs_stmt_start + header_len;
    let stmt_end_before_semi = if trimmed.ends_with(';') { stmt_end - 1 } else { stmt_end };
    let body_end = ddl_scan::find_top_level_paren_close(ddl, abs_after_header).unwrap_or(stmt_end_before_semi);

    let mut output = String::with_capacity(ddl.len() + external.options.len() * 24 + 48);
    output.push_str(&ddl[..abs_stmt_start]);
    output.push_str("CREATE FOREIGN TABLE ");
    output.push_str(&ddl[abs_after_header..body_end]);
    output.push_str("\nSERVER ");
    output.push_str(&db::postgres::pg_quote_ident(&external.server));
    if !external.options.is_empty() {
        let rendered_opts = external
            .options
            .iter()
            .filter_map(|option| option.split_once('='))
            .map(|(name, value)| format!("{} {}", db::postgres::pg_quote_ident(name), quote_sql_string(value)))
            .collect::<Vec<_>>();
        if !rendered_opts.is_empty() {
            output.push_str("\nOPTIONS (\n  ");
            output.push_str(&rendered_opts.join(",\n  "));
            output.push_str("\n)");
        }
    }
    output.push_str(&ddl[stmt_end_before_semi..]);
    Ok(output)
}

/// Injects `ENCODING (...)` onto matching column lines inside the first
/// `CREATE TABLE (...)` body without touching constraints or later statements.
fn inject_column_encodings(ddl: &str, encodings: &HashMap<String, Vec<String>>) -> String {
    let Some((stmt_start, stmt_end)) = find_create_table_statement_span(ddl) else {
        return ddl.to_string();
    };
    let Some(open_rel) = ddl[stmt_start..stmt_end].find("(\n") else {
        return ddl.to_string();
    };
    let body_start = stmt_start + open_rel + 2;
    let Some(body_end_inclusive) = ddl_scan::find_top_level_paren_close(ddl, stmt_start + open_rel) else {
        return ddl.to_string();
    };
    let body_end = body_end_inclusive.saturating_sub(1);
    if body_end <= body_start {
        return ddl.to_string();
    }

    let body = &ddl[body_start..body_end];
    let updated_lines = body
        .split('\n')
        .map(|line| {
            let trimmed = line.trim_start();
            if !trimmed.starts_with('"') {
                return line.to_string();
            }
            let Some((col_name, _)) = parse_quoted_ident_prefix(trimmed) else {
                return line.to_string();
            };
            let Some(opts) = encodings.get(&col_name) else {
                return line.to_string();
            };
            if opts.is_empty() || line.to_ascii_uppercase().contains(" ENCODING (") {
                return line.to_string();
            }
            let encoding_clause = format!(" ENCODING ({})", opts.join(", "));
            if let Some(without_comma) = line.strip_suffix(',') {
                format!("{without_comma}{encoding_clause},")
            } else {
                format!("{line}{encoding_clause}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut out = String::with_capacity(ddl.len() + encodings.len() * 48);
    out.push_str(&ddl[..body_start]);
    out.push_str(&updated_lines);
    out.push_str(&ddl[body_end..]);
    out
}

/// Removes a top-level ` INHERITS (...)` clause emitted by the generic PG 9.x
/// renderer for GP6 child partitions (which are real partitions, not plain
/// PostgreSQL table inheritance children).
fn strip_top_level_inherits_clause(ddl: &str) -> String {
    let Some((stmt_start, stmt_end)) = find_create_table_statement_span(ddl) else {
        return ddl.to_string();
    };
    let Some(close_paren) = ddl_scan::find_top_level_paren_close(ddl, stmt_start) else {
        return ddl.to_string();
    };
    let tail = &ddl[close_paren..stmt_end];
    let Some(inherits_rel) = find_ascii_ci(tail, " INHERITS (") else {
        return ddl.to_string();
    };
    let abs_inherits_start = close_paren + inherits_rel;
    let Some(abs_inherits_end) = ddl_scan::find_top_level_paren_close(ddl, abs_inherits_start) else {
        return ddl.to_string();
    };
    let mut out = String::with_capacity(ddl.len());
    out.push_str(&ddl[..abs_inherits_start]);
    out.push_str(&ddl[abs_inherits_end..]);
    out
}

fn parse_quoted_ident_prefix(input: &str) -> Option<(String, &str)> {
    let mut chars = input.char_indices();
    let (_, first) = chars.next()?;
    if first != '"' {
        return None;
    }
    let mut ident = String::new();
    while let Some((idx, ch)) = chars.next() {
        if ch == '"' {
            if let Some((_, '"')) = chars.clone().next() {
                chars.next();
                ident.push('"');
                continue;
            }
            return Some((ident, &input[idx + 1..]));
        }
        ident.push(ch);
    }
    None
}

fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let needle_bytes = needle.as_bytes();
    let haystack_bytes = haystack.as_bytes();
    haystack_bytes.windows(needle_bytes.len()).position(|window| window.eq_ignore_ascii_case(needle_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::greenplum::probe::sample_gp7_caps;

    #[test]
    fn renders_gp6_ao_compressed_table_with_encoding_tablespace_and_distribution() {
        let ddl = "CREATE TABLE \"public\".\"fund_flows\" (\n  \"fund_acc_no\" varchar(32) NOT NULL,\n  \"amount\" numeric(18,2)\n);\n";
        let mut column_encodings = HashMap::new();
        column_encodings.insert(
            "fund_acc_no".to_string(),
            vec!["compresstype=zstd".to_string(), "compresslevel=1".to_string(), "blocksize=32768".to_string()],
        );
        let rendered = apply_table_modifiers(
            ddl,
            &TableModifiers {
                reloptions: vec![
                    "appendonly=true".to_string(),
                    "orientation=column".to_string(),
                    "compresstype=zstd".to_string(),
                    "compresslevel=1".to_string(),
                    "oids=false".to_string(),
                ],
                tablespace: Some("hot_ssd".to_string()),
                distribution_clause: Some("DISTRIBUTED BY (fund_acc_no)".to_string()),
                column_encodings,
                ..Default::default()
            },
        )
        .unwrap();

        assert!(rendered.contains(
            "\"fund_acc_no\" varchar(32) NOT NULL ENCODING (compresstype=zstd, compresslevel=1, blocksize=32768),"
        ));
        let with_pos = rendered.find("WITH (\n").unwrap();
        let ts_pos = rendered.find("TABLESPACE \"hot_ssd\"").unwrap();
        let dist_pos = rendered.find("DISTRIBUTED BY (fund_acc_no);").unwrap();
        assert!(with_pos < ts_pos && ts_pos < dist_pos);
    }

    #[test]
    fn renders_gp6_partitioned_root_in_strict_clause_order() {
        let ddl = "CREATE TABLE \"public\".\"orders\" (\n  \"id\" bigint NOT NULL,\n  \"biz_date\" date NOT NULL\n);\n\nCREATE INDEX \"idx_orders_date\" ON \"public\".\"orders\" (\"biz_date\");\n";
        let rendered = apply_table_modifiers(
            ddl,
            &TableModifiers {
                reloptions: vec!["appendonly=true".to_string(), "compresstype=zstd".to_string()],
                distribution_clause: Some("DISTRIBUTED BY (id)".to_string()),
                gp6_partition_def: Some(
                    "PARTITION BY RANGE (biz_date)\n(\n  PARTITION \"p202601\" START ('2026-01-01'::date) INCLUSIVE END ('2026-02-01'::date) EXCLUSIVE,\n  DEFAULT PARTITION \"p_default\"\n)"
                        .to_string(),
                ),
                ..Default::default()
            },
        )
        .unwrap();

        let with_pos = rendered.find("WITH (").unwrap();
        let dist_pos = rendered.find("DISTRIBUTED BY (id)").unwrap();
        let part_pos = rendered.find("PARTITION BY RANGE (biz_date)").unwrap();
        let idx_pos = rendered.find("CREATE INDEX \"idx_orders_date\"").unwrap();
        assert!(with_pos < dist_pos && dist_pos < part_pos && part_pos < idx_pos);
        assert!(rendered.contains("DEFAULT PARTITION \"p_default\"\n);"));
    }

    #[test]
    fn renders_gp6_child_partition_without_bogus_inherits_clause() {
        let ddl = "CREATE TABLE \"public\".\"orders_1_prt_p202601\" (\n  \"id\" bigint NOT NULL,\n  \"biz_date\" date NOT NULL\n) INHERITS (\"public\".\"orders\");\n";
        let rendered = apply_table_modifiers(
            ddl,
            &TableModifiers {
                reloptions: vec![
                    "appendonly=true".to_string(),
                    "compresstype=zstd".to_string(),
                    "compresslevel=5".to_string(),
                ],
                distribution_clause: Some("DISTRIBUTED BY (id)".to_string()),
                gp6_child_partition: Some(Gp6ChildPartitionHeader {
                    parent_schema: "public".to_string(),
                    parent_table: "orders".to_string(),
                    rule_definition: "PARTITION p202601 START ('2026-01-01'::date) END ('2026-02-01'::date)"
                        .to_string(),
                }),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(rendered.starts_with(
            "-- Greenplum partition of \"public\".\"orders\": PARTITION p202601 START ('2026-01-01'::date) END ('2026-02-01'::date)\n"
        ));
        assert!(!rendered.contains("INHERITS"));
        assert!(rendered.contains("compresslevel=5"));
        assert!(rendered.contains("DISTRIBUTED BY (id);"));
    }

    #[test]
    fn renders_gp6_readable_and_writable_web_external_tables() {
        let ddl = "CREATE TABLE \"public\".\"ext_logs\" (\n  \"id\" integer,\n  \"payload\" text\n);\n";
        let readable = apply_table_modifiers(
            ddl,
            &TableModifiers {
                external_gp6: Some(Gp6ExternalTableDefinition {
                    uris: vec!["gpfdist://etl-host:8081/logs/*.csv".to_string()],
                    exec_locations: vec!["ALL_SEGMENTS".to_string()],
                    format_type: "c".to_string(),
                    format_options: "delimiter ',' null '' escape '\"' quote '\"' header".to_string(),
                    options: Vec::new(),
                    command: None,
                    reject_limit: Some(100),
                    reject_limit_type: Some("r".to_string()),
                    log_errors: true,
                    encoding: Some("UTF8".to_string()),
                    writable: false,
                }),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(readable.starts_with("CREATE READABLE EXTERNAL TABLE \"public\".\"ext_logs\""));
        assert!(readable.contains("LOCATION (\n  'gpfdist://etl-host:8081/logs/*.csv'\n)"));
        assert!(readable.contains("FORMAT 'CSV' (delimiter ',' null '' escape '\"' quote '\"' header)"));
        assert!(readable.contains("ENCODING 'UTF8'"));
        assert!(readable.contains("LOG ERRORS"));
        assert!(readable.contains("SEGMENT REJECT LIMIT 100 ROWS;"));

        let writable_web = apply_table_modifiers(
            ddl,
            &TableModifiers {
                distribution_clause: Some("DISTRIBUTED BY (id)".to_string()),
                external_gp6: Some(Gp6ExternalTableDefinition {
                    uris: Vec::new(),
                    exec_locations: vec!["MASTER_ONLY".to_string()],
                    format_type: "t".to_string(),
                    format_options: "delimiter '|'".to_string(),
                    options: Vec::new(),
                    command: Some("cat > /tmp/out.txt".to_string()),
                    reject_limit: None,
                    reject_limit_type: None,
                    log_errors: false,
                    encoding: Some("UTF8".to_string()),
                    writable: true,
                }),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(writable_web.starts_with("CREATE WRITABLE EXTERNAL WEB TABLE \"public\".\"ext_logs\""));
        assert!(writable_web.contains("EXECUTE 'cat > /tmp/out.txt' ON MASTER"));
        assert!(writable_web.contains("DISTRIBUTED BY (id);"));
    }

    #[test]
    fn renders_gp7_partition_tree_modifiers_per_relation() {
        let _caps = sample_gp7_caps();
        let ddl = "CREATE TABLE \"public\".\"events\" (\n  \"id\" bigint,\n  \"dt\" date\n) PARTITION BY RANGE (dt);\n\nCREATE TABLE \"public\".\"events_2026\" PARTITION OF \"public\".\"events\" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');\n";
        let mut modifiers = HashMap::new();
        modifiers.insert(
            ("public".to_string(), "events".to_string()),
            TableModifiers { distribution_clause: Some("DISTRIBUTED BY (id)".to_string()), ..Default::default() },
        );
        modifiers.insert(
            ("public".to_string(), "events_2026".to_string()),
            TableModifiers {
                access_method: Some("ao_column".to_string()),
                reloptions: vec!["compresstype=zstd".to_string(), "compresslevel=3".to_string()],
                tablespace: Some("cold_ts".to_string()),
                distribution_clause: Some("DISTRIBUTED BY (id)".to_string()),
                ..Default::default()
            },
        );

        let rendered = apply_tree_table_modifiers(ddl, &modifiers).unwrap();
        assert!(rendered.contains("PARTITION BY RANGE (dt)\nDISTRIBUTED BY (id);"));
        assert!(rendered.contains(
            "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')\nUSING \"ao_column\"\nWITH (\n  compresstype=zstd,\n  compresslevel=3\n)\nTABLESPACE \"cold_ts\"\nDISTRIBUTED BY (id);"
        ));
    }

    #[test]
    fn renders_gp7_foreign_table_preserving_leading_comment_and_trailing_statements() {
        let ddl = "-- header\nCREATE TABLE \"public\".\"ext_s3\" (\n  \"id\" bigint\n);\n\nCOMMENT ON TABLE \"public\".\"ext_s3\" IS 's3';\n";
        let rendered = apply_table_modifiers(
            ddl,
            &TableModifiers {
                external_gp7: Some(Gp7ExternalTableDefinition {
                    server: "gp_exttable_server".to_string(),
                    options: vec!["format=csv".to_string(), "delimiter=,".to_string()],
                }),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(rendered.starts_with("-- header\nCREATE FOREIGN TABLE \"public\".\"ext_s3\""));
        assert!(
            rendered.contains("SERVER \"gp_exttable_server\"\nOPTIONS (\n  \"format\" 'csv',\n  \"delimiter\" ','\n);")
        );
        assert!(rendered.contains("COMMENT ON TABLE \"public\".\"ext_s3\" IS 's3';"));
    }

    #[test]
    fn distribution_fallback_maps_replicated_random_and_hash() {
        assert_eq!(render_distribution_policy_from_catalog("r", &[]), Some("DISTRIBUTED REPLICATED".to_string()));
        assert_eq!(render_distribution_policy_from_catalog("p", &[]), Some("DISTRIBUTED RANDOMLY".to_string()));
        assert_eq!(
            render_distribution_policy_from_catalog("p", &["fund_acc_no".to_string(), "biz date".to_string()]),
            Some("DISTRIBUTED BY (\"fund_acc_no\", \"biz date\")".to_string())
        );
    }
}
