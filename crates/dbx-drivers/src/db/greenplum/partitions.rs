use std::collections::{HashMap, HashSet};

use deadpool_postgres::Pool;
use tokio_postgres::types::Type;

use super::probe::GreenplumCapabilities;
use super::{
    like_contains_pattern, like_fuzzy_pattern, non_empty, normalize_schema, pg_err, split_bound_items,
    split_catalog_lines, split_top_level_commas, strip_outer_parens,
};
use crate::db::{self, ObjectInfo, TableInfo};
use crate::types::{PgPartitionBound, PgPartitionKind, PgPartitionNode, PgTablePartitioning};

const GP7_EXTERNAL_TABLES_SQL: &str = "SELECT c.relname::text \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relkind = 'f' AND c.relname = ANY($2::text[])";

pub(super) const GP6_PARTITION_TARGET_SQL: &str = "SELECT c.oid AS target_oid, \
            n.nspname::text AS target_schema, \
            c.relname::text AS target_name, \
            COALESCE(child_pp.parrelid, CASE WHEN EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_partition root_pp \
              WHERE root_pp.parrelid = c.oid AND NOT root_pp.paristemplate \
            ) THEN c.oid END) AS root_oid, \
            child_pr.oid AS target_rule_oid, \
            rn.nspname::text AS root_schema, \
            rc.relname::text AS root_name \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_partition_rule child_pr ON child_pr.parchildrelid = c.oid \
     LEFT JOIN pg_catalog.pg_partition child_pp ON child_pp.oid = child_pr.paroid AND NOT child_pp.paristemplate \
     LEFT JOIN pg_catalog.pg_class rc ON rc.oid = COALESCE(child_pp.parrelid, c.oid) \
     LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace \
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'f') \
     ORDER BY child_pr.oid NULLS LAST \
     LIMIT 1";

pub(super) const GP6_PARTITION_LEVELS_SQL: &str = "SELECT pp.oid AS part_oid, \
            pp.parlevel::int AS level, \
            pp.parkind::text AS kind, \
            ARRAY( \
              SELECT a.attname::text \
              FROM generate_series(1, COALESCE(array_length(string_to_array(btrim(pp.paratts::text), ' '), 1), 0)) AS pos(n) \
              JOIN pg_catalog.pg_attribute a \
                ON a.attrelid = pp.parrelid \
               AND a.attnum = (string_to_array(btrim(pp.paratts::text), ' '))[pos.n]::smallint \
               AND a.attnum > 0 \
               AND NOT a.attisdropped \
              ORDER BY pos.n \
            ) AS key_columns \
     FROM pg_catalog.pg_partition pp \
     WHERE pp.parrelid = $1::oid \
       AND NOT pp.paristemplate \
     ORDER BY pp.parlevel, pp.oid";

pub(super) const GP6_PARTITION_RULES_SQL: &str = "SELECT pr.oid AS rule_oid, \
            pr.paroid AS part_oid, \
            pr.parparentrule AS parent_rule_oid, \
            pr.parchildrelid AS child_oid, \
            cn.nspname::text AS child_schema, \
            c.relname::text AS child_name, \
            COALESCE(pr.parname::text, '') AS partition_name, \
            COALESCE(pr.parisdefault, false) AS is_default, \
            COALESCE(pr.parruleord::int, 0) AS rule_ord, \
            pg_catalog.pg_get_expr(pr.parrangestart, pp.parrelid) AS range_start, \
            COALESCE(pr.parrangestartincl, true) AS range_start_incl, \
            pg_catalog.pg_get_expr(pr.parrangeend, pp.parrelid) AS range_end, \
            COALESCE(pr.parrangeendincl, false) AS range_end_incl, \
            pg_catalog.pg_get_expr(pr.parlistvalues, pp.parrelid) AS list_values, \
            COALESCE(array_to_string(c.reloptions, E'\\n'), '')::text AS reloptions, \
            COALESCE(ts.spcname::text, '') AS tablespace_name \
     FROM pg_catalog.pg_partition_rule pr \
     JOIN pg_catalog.pg_partition pp ON pp.oid = pr.paroid \
     JOIN pg_catalog.pg_class c ON c.oid = pr.parchildrelid \
     JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = c.reltablespace AND c.reltablespace <> 0 \
     WHERE pp.parrelid = $1::oid \
       AND NOT pp.paristemplate \
       AND pr.parchildrelid <> 0 \
     ORDER BY pp.parlevel, pr.parruleord, c.relname";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GreenplumPartitionStatus {
    pub is_partitioned_parent: bool,
    pub is_partition: bool,
    pub is_foreign: bool,
}

#[derive(Debug, Clone)]
pub(super) struct Gp6PartitionLevel {
    pub part_oid: u32,
    pub level: i32,
    pub kind: Option<PgPartitionKind>,
    pub key_columns: Vec<String>,
}

#[derive(Debug, Clone)]
pub(super) struct Gp6PartitionRule {
    pub rule_oid: u32,
    pub part_oid: u32,
    pub parent_rule_oid: u32,
    pub child_oid: u32,
    pub child_schema: String,
    pub child_name: String,
    pub partition_name: String,
    pub is_default: bool,
    pub rule_ord: i32,
    pub range_start: Option<String>,
    pub range_start_incl: bool,
    pub range_end: Option<String>,
    pub range_end_incl: bool,
    pub list_values: Option<String>,
    pub reloptions: Vec<String>,
    pub tablespace: Option<String>,
}

// ---------------------------------------------------------------------------
// Table & Object Listing (Sidebar Tree Folding + External Table Annotation)
// ---------------------------------------------------------------------------

pub async fn list_tables_filtered(
    pool: &Pool,
    caps: &GreenplumCapabilities,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    table_objects_only: bool,
) -> Result<Vec<TableInfo>, String> {
    if !caps.is_classic_gp6() {
        let mut tables = if table_objects_only {
            db::postgres::list_table_objects_filtered(pool, schema, filter, limit, offset).await?
        } else {
            db::postgres::list_tables_filtered(pool, schema, filter, limit, offset).await?
        };
        annotate_gp7_external_tables(pool, schema, &mut tables).await;
        return Ok(tables);
    }

    let schema = normalize_schema(schema);
    let filter = filter.unwrap_or("").trim();
    let filter_pattern = like_contains_pattern(filter);
    let fuzzy_filter_pattern =
        if crate::sql::fuzzy_filter_enabled(filter) { like_fuzzy_pattern(filter) } else { String::new() };
    let limit_param = limit.and_then(|value| i64::try_from(value).ok());
    let offset_param = offset.and_then(|value| i64::try_from(value).ok()).unwrap_or(0);
    let sql = gp6_tables_sql(limit_param, offset_param, table_objects_only, caps.has_relstorage);

    let client = db::postgres::checkout_postgres_client(pool, None, db::connection_timeout()).await?;
    let params: &[(&(dyn tokio_postgres::types::ToSql + Sync), Type)] =
        &[(&schema, Type::VARCHAR), (&filter_pattern, Type::VARCHAR), (&fuzzy_filter_pattern, Type::VARCHAR)];
    let rows = client.query_typed(&sql, params).await.map_err(pg_err)?;
    Ok(rows.iter().map(table_info_from_row).collect())
}

/// Sidebar table-tree pagination: counts top-level relations and appends every
/// descendant partition (including multi-level subpartitions) beneath each
/// returned root so large partitioned tables never flood sidebar pages.
pub async fn list_table_roots_page_filtered(
    pool: &Pool,
    caps: &GreenplumCapabilities,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    table_objects_only: bool,
) -> Result<Vec<TableInfo>, String> {
    if !caps.is_classic_gp6() {
        let mut tables =
            db::postgres::list_table_roots_page_filtered(pool, schema, filter, limit, offset, table_objects_only)
                .await?;
        annotate_gp7_external_tables(pool, schema, &mut tables).await;
        return Ok(tables);
    }

    let filter_trimmed = filter.unwrap_or("").trim();
    let limit_param = limit.and_then(|value| i64::try_from(value).ok());
    let offset_param = offset.and_then(|value| i64::try_from(value).ok()).unwrap_or(0);
    if !filter_trimmed.is_empty() || limit_param.is_none() {
        return list_tables_filtered(pool, caps, schema, filter, limit, offset, table_objects_only).await;
    }

    let schema = normalize_schema(schema);
    let limit_value = limit_param.unwrap();
    let client = db::postgres::checkout_postgres_client(pool, None, db::connection_timeout()).await?;

    let roots_sql = gp6_table_roots_page_sql(limit_value, offset_param, table_objects_only, caps.has_relstorage);
    let root_params: [(&(dyn tokio_postgres::types::ToSql + Sync), Type); 1] = [(&schema, Type::VARCHAR)];
    let roots = client.query_typed(&roots_sql, &root_params).await.map_err(pg_err)?;
    let partitioned_roots: Vec<u32> =
        roots.iter().filter_map(|row| row.try_get::<_, Option<u32>>(5).ok().flatten()).collect();
    let mut tables: Vec<TableInfo> = roots.iter().map(table_info_from_row).collect();
    if !partitioned_roots.is_empty() {
        let descendants_sql = gp6_partition_descendants_sql(table_objects_only, caps.has_relstorage);
        let descendant_params: [(&(dyn tokio_postgres::types::ToSql + Sync), Type); 2] =
            [(&schema, Type::VARCHAR), (&partitioned_roots, Type::OID_ARRAY)];
        let descendants = client.query_typed(&descendants_sql, &descendant_params).await.map_err(pg_err)?;
        tables.extend(descendants.iter().map(table_info_from_row));
    }
    Ok(tables)
}

pub async fn list_objects(
    pool: &Pool,
    caps: &GreenplumCapabilities,
    schema: &str,
    include_relations: bool,
    include_routines: bool,
    include_custom_types: bool,
) -> Result<Vec<ObjectInfo>, String> {
    if !caps.is_classic_gp6() {
        let mut objects =
            db::postgres::list_objects(pool, schema, include_relations, include_routines, include_custom_types).await?;
        if include_relations {
            let names = objects.iter().map(|object| object.name.clone()).collect::<Vec<_>>();
            let external_names = gp7_external_table_names(pool, schema, &names).await.unwrap_or_else(|error| {
                log::debug!("[greenplum][list_objects:external-table-fallback] error={error}");
                HashSet::new()
            });
            for object in &mut objects {
                if external_names.contains(&object.name) {
                    object.object_type = "EXTERNAL TABLE".to_string();
                }
            }
        }
        return Ok(objects);
    }

    let mut objects = Vec::new();
    if include_relations {
        objects.extend(list_gp6_relation_objects(pool, schema, caps.has_relstorage).await?);
    }
    if include_routines || include_custom_types {
        let supplemental =
            db::postgres::list_objects(pool, schema, false, include_routines, include_custom_types).await?;
        objects.extend(supplemental);
    }
    Ok(objects)
}

async fn list_gp6_relation_objects(pool: &Pool, schema: &str, has_relstorage: bool) -> Result<Vec<ObjectInfo>, String> {
    let schema = normalize_schema(schema);
    let sql = gp6_object_relations_sql(has_relstorage);
    let client = db::postgres::checkout_postgres_client(pool, None, db::connection_timeout()).await?;
    let rows = client.query(&sql, &[&schema]).await.map_err(pg_err)?;
    Ok(rows
        .into_iter()
        .map(|row| ObjectInfo {
            name: row.try_get::<_, String>(0).unwrap_or_default(),
            object_type: row.try_get::<_, String>(1).unwrap_or_else(|_| "TABLE".to_string()),
            schema: Some(schema.to_string()),
            valid: None,
            signature: None,
            custom_type_kind: None,
            has_members: None,
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
            created_at: None,
            updated_at: None,
            parent_schema: row.try_get::<_, Option<String>>(3).ok().flatten().filter(|s| !s.is_empty()),
            parent_name: row.try_get::<_, Option<String>>(4).ok().flatten().filter(|s| !s.is_empty()),
            trigger: None,
            xugu_type_members_expandable: None,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Partition Status & Structured Multi-Level Partition Tree (PgTablePartitioning)
// ---------------------------------------------------------------------------

pub async fn get_table_partition_status(
    pool: &Pool,
    caps: &GreenplumCapabilities,
    schema: &str,
    table: &str,
) -> Result<GreenplumPartitionStatus, String> {
    if !caps.is_classic_gp6() {
        let info = db::postgres::get_table_partition_info(pool, schema, table).await?;
        return Ok(GreenplumPartitionStatus {
            is_partitioned_parent: info.key.is_some(),
            is_partition: info.is_partition,
            is_foreign: info.is_foreign,
        });
    }

    let schema = normalize_schema(schema);
    let client = db::postgres::checkout_postgres_client(pool, None, db::connection_timeout()).await?;
    let status_sql = gp6_partition_status_sql(caps.has_relstorage);
    let Some(row) = client.query_opt(&status_sql, &[&schema, &table]).await.map_err(pg_err)? else {
        return Ok(GreenplumPartitionStatus::default());
    };
    let relkind = row.try_get::<_, String>(0).unwrap_or_default();
    let relstorage = row.try_get::<_, String>(1).unwrap_or_default();
    let is_partitioned_parent = row.try_get::<_, bool>(2).unwrap_or(false);
    let is_partition = row.try_get::<_, bool>(3).unwrap_or(false);
    Ok(GreenplumPartitionStatus {
        is_partitioned_parent,
        is_partition,
        is_foreign: relkind == "f" || relstorage == "x",
    })
}

pub async fn get_table_partitioning(
    pool: &Pool,
    caps: &GreenplumCapabilities,
    schema: &str,
    table: &str,
) -> Result<PgTablePartitioning, String> {
    if !caps.is_classic_gp6() {
        return db::postgres::get_table_partitioning(pool, schema, table).await;
    }

    let schema = normalize_schema(schema);
    let client = db::postgres::checkout_postgres_client(pool, None, db::connection_timeout()).await?;
    let Some(target_row) = client.query_opt(GP6_PARTITION_TARGET_SQL, &[&schema, &table]).await.map_err(pg_err)? else {
        return Ok(PgTablePartitioning::default());
    };

    let target_oid = target_row.try_get::<_, u32>(0).map_err(pg_err)?;
    let root_oid = match target_row.try_get::<_, Option<u32>>(3).map_err(pg_err)? {
        Some(oid) => oid,
        None => return Ok(PgTablePartitioning::default()),
    };
    let target_rule_oid = target_row.try_get::<_, Option<u32>>(4).map_err(pg_err)?;
    let root_schema = target_row.try_get::<_, Option<String>>(5).ok().flatten().unwrap_or_else(|| schema.to_string());
    let root_name = target_row.try_get::<_, Option<String>>(6).ok().flatten().unwrap_or_else(|| table.to_string());

    let (levels, rules) = fetch_gp6_partition_catalog(&client, root_oid).await?;
    if levels.is_empty() && rules.is_empty() {
        return Ok(PgTablePartitioning::default());
    }

    let child_oids: Vec<u32> = rules.iter().map(|rule| rule.child_oid).collect();
    let stats = fetch_gp6_partition_stats(&client, caps.has_relstorage, &child_oids).await.unwrap_or_default();

    Ok(assemble_gp6_table_partitioning(
        target_oid,
        target_rule_oid,
        root_oid,
        &root_schema,
        &root_name,
        &levels,
        &rules,
        &stats,
        caps.server_version_num,
    ))
}

pub(super) async fn fetch_gp6_partition_catalog(
    client: &deadpool_postgres::Client,
    root_oid: u32,
) -> Result<(Vec<Gp6PartitionLevel>, Vec<Gp6PartitionRule>), String> {
    let level_rows = client.query(GP6_PARTITION_LEVELS_SQL, &[&root_oid]).await.map_err(pg_err)?;
    let levels = level_rows
        .into_iter()
        .map(|row| {
            let kind_raw = row.try_get::<_, String>(2).unwrap_or_default();
            Gp6PartitionLevel {
                part_oid: row.try_get::<_, u32>(0).unwrap_or_default(),
                level: row.try_get::<_, i32>(1).unwrap_or_default(),
                kind: db::postgres::pg_partition_kind_from_strategy(&kind_raw),
                key_columns: row.try_get::<_, Vec<String>>(3).unwrap_or_default(),
            }
        })
        .collect::<Vec<_>>();

    let rule_rows = client.query(GP6_PARTITION_RULES_SQL, &[&root_oid]).await.map_err(pg_err)?;
    let rules = rule_rows
        .into_iter()
        .map(|row| Gp6PartitionRule {
            rule_oid: row.try_get::<_, u32>(0).unwrap_or_default(),
            part_oid: row.try_get::<_, u32>(1).unwrap_or_default(),
            parent_rule_oid: row.try_get::<_, u32>(2).unwrap_or_default(),
            child_oid: row.try_get::<_, u32>(3).unwrap_or_default(),
            child_schema: row.try_get::<_, String>(4).unwrap_or_default(),
            child_name: row.try_get::<_, String>(5).unwrap_or_default(),
            partition_name: row.try_get::<_, String>(6).unwrap_or_default(),
            is_default: row.try_get::<_, bool>(7).unwrap_or(false),
            rule_ord: row.try_get::<_, i32>(8).unwrap_or_default(),
            range_start: row.try_get::<_, Option<String>>(9).ok().flatten().filter(|s| !s.trim().is_empty()),
            range_start_incl: row.try_get::<_, bool>(10).unwrap_or(true),
            range_end: row.try_get::<_, Option<String>>(11).ok().flatten().filter(|s| !s.trim().is_empty()),
            range_end_incl: row.try_get::<_, bool>(12).unwrap_or(false),
            list_values: row.try_get::<_, Option<String>>(13).ok().flatten().filter(|s| !s.trim().is_empty()),
            reloptions: split_catalog_lines(row.try_get::<_, String>(14).unwrap_or_default()),
            tablespace: non_empty(row.try_get::<_, String>(15).unwrap_or_default()),
        })
        .collect::<Vec<_>>();

    Ok((levels, rules))
}

async fn fetch_gp6_partition_stats(
    client: &deadpool_postgres::Client,
    has_relstorage: bool,
    oids: &[u32],
) -> Result<HashMap<u32, (Option<i64>, Option<i64>)>, String> {
    if oids.is_empty() {
        return Ok(HashMap::new());
    }
    let owned: Vec<u32> = oids.to_vec();
    let rows = client.query(gp6_partition_stats_sql(has_relstorage), &[&owned]).await.map_err(pg_err)?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let oid = row.try_get::<_, u32>(0).ok()?;
            let row_estimate = row.try_get::<_, Option<i64>>(1).ok().flatten().filter(|v| *v >= 0);
            let total_bytes = row.try_get::<_, Option<i64>>(2).ok().flatten().filter(|v| *v >= 0);
            Some((oid, (row_estimate, total_bytes)))
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
fn assemble_gp6_table_partitioning(
    target_oid: u32,
    target_rule_oid: Option<u32>,
    root_oid: u32,
    root_schema: &str,
    root_name: &str,
    levels: &[Gp6PartitionLevel],
    rules: &[Gp6PartitionRule],
    stats: &HashMap<u32, (Option<i64>, Option<i64>)>,
    server_version_num: Option<i32>,
) -> PgTablePartitioning {
    let levels_by_oid: HashMap<u32, &Gp6PartitionLevel> = levels.iter().map(|level| (level.part_oid, level)).collect();
    let rules_by_oid: HashMap<u32, &Gp6PartitionRule> = rules.iter().map(|rule| (rule.rule_oid, rule)).collect();
    let mut children_by_parent_rule: HashMap<u32, Vec<&Gp6PartitionRule>> = HashMap::new();
    for rule in rules {
        children_by_parent_rule.entry(rule.parent_rule_oid).or_default().push(rule);
    }
    for children in children_by_parent_rule.values_mut() {
        children.sort_by(|left, right| {
            left.rule_ord.cmp(&right.rule_ord).then_with(|| left.child_name.cmp(&right.child_name))
        });
    }

    let is_partition = target_rule_oid.is_some();
    let target_rule = target_rule_oid.and_then(|oid| rules_by_oid.get(&oid).copied());

    let (parent_schema, parent_table) = match target_rule {
        Some(rule) if rule.parent_rule_oid == 0 => (Some(root_schema.to_string()), Some(root_name.to_string())),
        Some(rule) => match rules_by_oid.get(&rule.parent_rule_oid) {
            Some(parent_rule) => (Some(parent_rule.child_schema.clone()), Some(parent_rule.child_name.clone())),
            None => (Some(root_schema.to_string()), Some(root_name.to_string())),
        },
        None => (None, None),
    };

    let own_bound = target_rule.and_then(|rule| {
        let level_kind = levels_by_oid.get(&rule.part_oid).and_then(|level| level.kind);
        parse_gp6_rule_bound(rule, level_kind).0
    });

    let root_parent_rule_key = target_rule_oid.unwrap_or(0);
    let target_children_level: Option<&Gp6PartitionLevel> = children_by_parent_rule
        .get(&root_parent_rule_key)
        .and_then(|children| children.first())
        .and_then(|first_child| levels_by_oid.get(&first_child.part_oid).copied())
        .or_else(|| if target_oid == root_oid { levels.iter().find(|level| level.level == 0) } else { None });

    let is_partitioned = target_children_level.is_some();
    let strategy = target_children_level.and_then(|level| level.kind);
    let key_columns = target_children_level.map(|level| level.key_columns.clone()).unwrap_or_default();
    let key_definition = target_children_level.and_then(format_gp6_key_definition);

    let mut visited = HashSet::new();
    if let Some(rule_oid) = target_rule_oid {
        visited.insert(rule_oid);
    }
    let partitions =
        build_gp6_partition_nodes(root_parent_rule_key, &levels_by_oid, &children_by_parent_rule, stats, &mut visited);
    let default_partition =
        partitions.iter().find(|node| node.bound == Some(PgPartitionBound::Default)).map(|node| node.name.clone());

    PgTablePartitioning {
        is_partitioned,
        is_partition,
        parent: match (parent_schema.as_deref(), parent_table.as_deref()) {
            (Some(s), Some(t)) => Some(format!("{s}.{t}")),
            _ => None,
        },
        parent_schema,
        parent_table,
        own_bound,
        strategy,
        key_definition,
        key_columns,
        key_expression: None,
        default_partition,
        partitions,
        server_version_num,
    }
}

fn build_gp6_partition_nodes(
    parent_rule_oid: u32,
    levels_by_oid: &HashMap<u32, &Gp6PartitionLevel>,
    children_by_parent_rule: &HashMap<u32, Vec<&Gp6PartitionRule>>,
    stats: &HashMap<u32, (Option<i64>, Option<i64>)>,
    visited: &mut HashSet<u32>,
) -> Vec<PgPartitionNode> {
    let Some(child_rules) = children_by_parent_rule.get(&parent_rule_oid) else {
        return Vec::new();
    };
    let mut nodes = Vec::with_capacity(child_rules.len());
    for rule in child_rules {
        if !visited.insert(rule.rule_oid) {
            continue;
        }
        let children = build_gp6_partition_nodes(rule.rule_oid, levels_by_oid, children_by_parent_rule, stats, visited);
        let child_level = children_by_parent_rule
            .get(&rule.rule_oid)
            .and_then(|sub| sub.first())
            .and_then(|first| levels_by_oid.get(&first.part_oid).copied());
        let own_level_kind = levels_by_oid.get(&rule.part_oid).and_then(|level| level.kind);
        let (bound, bound_definition) = parse_gp6_rule_bound(rule, own_level_kind);
        let (row_estimate, total_bytes) = stats.get(&rule.child_oid).copied().unwrap_or((None, None));
        nodes.push(PgPartitionNode {
            schema: rule.child_schema.clone(),
            name: rule.child_name.clone(),
            strategy: child_level.and_then(|level| level.kind),
            key_definition: child_level.and_then(format_gp6_key_definition),
            bound,
            bound_definition,
            is_leaf: children.is_empty(),
            row_estimate,
            total_bytes,
            children,
        });
    }
    nodes
}

pub(super) fn format_gp6_key_definition(level: &Gp6PartitionLevel) -> Option<String> {
    let kind = match level.kind? {
        PgPartitionKind::Range => "RANGE",
        PgPartitionKind::List => "LIST",
        PgPartitionKind::Hash => "HASH",
    };
    if level.key_columns.is_empty() {
        return None;
    }
    let columns = level.key_columns.iter().map(|col| db::postgres::pg_quote_ident(col)).collect::<Vec<_>>().join(", ");
    Some(format!("{kind} ({columns})"))
}

pub(super) fn parse_gp6_rule_bound(
    rule: &Gp6PartitionRule,
    kind: Option<PgPartitionKind>,
) -> (Option<PgPartitionBound>, Option<String>) {
    if rule.is_default {
        return (Some(PgPartitionBound::Default), Some("DEFAULT".to_string()));
    }
    match kind {
        Some(PgPartitionKind::List) => {
            let Some(raw) = rule.list_values.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
                return (None, None);
            };
            let inner = strip_outer_parens(raw);
            let values = split_top_level_commas(inner)
                .into_iter()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>();
            let bound = (!values.is_empty()).then_some(PgPartitionBound::List { values });
            (bound, Some(format!("VALUES ({inner})")))
        }
        Some(PgPartitionKind::Range) => {
            let mut definition_parts = Vec::new();
            if let Some(start) = rule.range_start.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let incl = if rule.range_start_incl { "INCLUSIVE" } else { "EXCLUSIVE" };
                definition_parts.push(format!("START ({start}) {incl}"));
            }
            if let Some(end) = rule.range_end.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let incl = if rule.range_end_incl { "INCLUSIVE" } else { "EXCLUSIVE" };
                definition_parts.push(format!("END ({end}) {incl}"));
            }
            if definition_parts.is_empty() {
                return (None, None);
            }
            let bound_definition = Some(definition_parts.join(" "));
            // Preserve exact inclusive/exclusive wording when boundaries deviate
            // from PostgreSQL's standard half-open [FROM, TO) semantics.
            let standard_half_open = (rule.range_start.is_none() || rule.range_start_incl)
                && (rule.range_end.is_none() || !rule.range_end_incl);
            let bound = if standard_half_open {
                let from = match rule.range_start.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(start) => split_bound_items(strip_outer_parens(start)),
                    None => vec!["MINVALUE".to_string()],
                };
                let to = match rule.range_end.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(end) => split_bound_items(strip_outer_parens(end)),
                    None => vec!["MAXVALUE".to_string()],
                };
                Some(PgPartitionBound::Range { from, to })
            } else {
                None
            };
            (bound, bound_definition)
        }
        _ => (None, None),
    }
}

// ---------------------------------------------------------------------------
// SQL Builders (Strict PG 9.4 / GP6 & GP7 Compatibility)
// ---------------------------------------------------------------------------

pub(super) fn gp6_partition_status_sql(has_relstorage: bool) -> String {
    let relstorage_expr = if has_relstorage { "COALESCE(c.relstorage::text, 'h')" } else { "'h'::text" };
    format!(
        "SELECT c.relkind::text, \
                {relstorage_expr} AS relstorage, \
                EXISTS ( \
                  SELECT 1 FROM pg_catalog.pg_partition pp \
                  WHERE pp.parrelid = c.oid AND pp.parlevel = 0 AND NOT pp.paristemplate \
                ) OR EXISTS ( \
                  SELECT 1 \
                  FROM pg_catalog.pg_partition_rule self_pr \
                  JOIN pg_catalog.pg_partition_rule child_pr ON child_pr.parparentrule = self_pr.oid \
                  JOIN pg_catalog.pg_partition child_pp ON child_pp.oid = child_pr.paroid \
                  WHERE self_pr.parchildrelid = c.oid \
                    AND child_pr.parchildrelid <> 0 \
                    AND NOT child_pp.paristemplate \
                ) AS is_partitioned_parent, \
                EXISTS ( \
                  SELECT 1 \
                  FROM pg_catalog.pg_partition_rule pr \
                  JOIN pg_catalog.pg_partition pp ON pp.oid = pr.paroid \
                  WHERE pr.parchildrelid = c.oid AND NOT pp.paristemplate \
                ) AS is_partition \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'f') \
         LIMIT 1"
    )
}

pub(super) fn gp6_partition_stats_sql(has_relstorage: bool) -> &'static str {
    if has_relstorage {
        "SELECT c.oid, \
                CASE WHEN c.relkind = 'f' OR c.relstorage IN ('x', 'v') THEN NULL \
                     WHEN c.reltuples >= 0 THEN c.reltuples::bigint \
                     ELSE NULL END, \
                CASE WHEN c.relkind = 'f' OR c.relstorage IN ('x', 'v') THEN NULL \
                     ELSE pg_catalog.pg_total_relation_size(c.oid) END \
         FROM pg_catalog.pg_class c \
         WHERE c.oid = ANY($1::oid[])"
    } else {
        "SELECT c.oid, \
                CASE WHEN c.relkind = 'f' THEN NULL \
                     WHEN c.reltuples >= 0 THEN c.reltuples::bigint \
                     ELSE NULL END, \
                CASE WHEN c.relkind = 'f' THEN NULL \
                     ELSE pg_catalog.pg_total_relation_size(c.oid) END \
         FROM pg_catalog.pg_class c \
         WHERE c.oid = ANY($1::oid[])"
    }
}

fn gp6_table_type_case_sql(has_relstorage: bool) -> &'static str {
    if has_relstorage {
        "CASE WHEN c.relstorage = 'x' THEN 'EXTERNAL TABLE' \
              WHEN c.relkind = 'r' THEN 'BASE TABLE' \
              WHEN c.relkind = 'v' THEN 'VIEW' \
              WHEN c.relkind = 'm' THEN 'MATERIALIZED_VIEW' \
              WHEN c.relkind = 'f' THEN 'FOREIGN TABLE' \
              ELSE 'BASE TABLE' END"
    } else {
        "CASE c.relkind WHEN 'r' THEN 'BASE TABLE' WHEN 'v' THEN 'VIEW' \
              WHEN 'm' THEN 'MATERIALIZED_VIEW' WHEN 'f' THEN 'FOREIGN TABLE' \
              ELSE 'BASE TABLE' END"
    }
}

fn gp6_object_type_case_sql(has_relstorage: bool) -> &'static str {
    if has_relstorage {
        "CASE WHEN c.relstorage = 'x' THEN 'EXTERNAL TABLE' \
              WHEN c.relkind = 'v' THEN 'VIEW' \
              WHEN c.relkind = 'm' THEN 'MATERIALIZED_VIEW' \
              WHEN c.relkind = 'S' THEN 'SEQUENCE' \
              ELSE 'TABLE' END"
    } else {
        "CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED_VIEW' \
              WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END"
    }
}

pub(super) fn gp6_tables_sql(
    limit: Option<i64>,
    offset: i64,
    table_objects_only: bool,
    has_relstorage: bool,
) -> String {
    let pagination = match limit {
        Some(limit) => format!("LIMIT {limit} OFFSET {offset}"),
        None => format!("OFFSET {offset}"),
    };
    let relation_kinds = if table_objects_only { "'r','f'" } else { "'r','v','m','f'" };
    let type_case = gp6_table_type_case_sql(has_relstorage);
    format!(
        "SELECT c.relname::text AS table_name, \
                {type_case} AS table_type, \
                obj_description(c.oid) AS table_comment, \
                CASE WHEN pp.oid IS NOT NULL THEN pn.nspname::text ELSE NULL END AS parent_schema, \
                CASE WHEN pp.oid IS NOT NULL THEN pc.relname::text ELSE NULL END AS parent_name \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_partition_rule pr ON pr.parchildrelid = c.oid AND pr.parchildrelid <> 0 \
         LEFT JOIN pg_catalog.pg_partition pp ON pp.oid = pr.paroid AND NOT pp.paristemplate \
         LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid AND i.inhseqno = 1 AND pp.oid IS NOT NULL \
         LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
         LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ({relation_kinds}) \
           AND ($2 = '%%' OR c.relname ILIKE $2 OR ($3 <> '' AND c.relname ILIKE $3)) \
         ORDER BY CASE WHEN pp.oid IS NOT NULL THEN 1 ELSE 0 END, c.relname \
         {pagination}"
    )
}

pub(super) fn gp6_table_roots_page_sql(
    limit: i64,
    offset: i64,
    table_objects_only: bool,
    has_relstorage: bool,
) -> String {
    let relation_kinds = if table_objects_only { "'r','f'" } else { "'r','v','m','f'" };
    let type_case = gp6_table_type_case_sql(has_relstorage);
    format!(
        "SELECT c.relname::text AS table_name, \
                {type_case} AS table_type, \
                obj_description(c.oid) AS table_comment, \
                NULL::text AS parent_schema, \
                NULL::text AS parent_name, \
                CASE WHEN EXISTS ( \
                  SELECT 1 FROM pg_catalog.pg_partition pp \
                  WHERE pp.parrelid = c.oid AND pp.parlevel = 0 AND NOT pp.paristemplate \
                ) THEN c.oid END AS partitioned_oid \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ({relation_kinds}) \
           AND NOT EXISTS ( \
             SELECT 1 \
             FROM pg_catalog.pg_partition_rule pr \
             JOIN pg_catalog.pg_partition pp ON pp.oid = pr.paroid AND NOT pp.paristemplate \
             JOIN pg_catalog.pg_inherits i ON i.inhrelid = pr.parchildrelid \
             JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent \
             JOIN pg_catalog.pg_namespace parent_n ON parent_n.oid = parent.relnamespace \
             WHERE pr.parchildrelid = c.oid AND parent_n.nspname = n.nspname \
           ) \
         ORDER BY c.relname \
         LIMIT {limit} OFFSET {offset}"
    )
}

pub(super) fn gp6_partition_descendants_sql(table_objects_only: bool, has_relstorage: bool) -> String {
    let relation_kinds = if table_objects_only { "'r','f'" } else { "'r','v','m','f'" };
    let type_case = gp6_table_type_case_sql(has_relstorage);
    format!(
        "WITH RECURSIVE partition_tree AS ( \
           SELECT i.inhrelid AS oid, \
                  i.inhparent AS parent_oid, \
                  COALESCE(pr.parruleord, 0) AS rule_ord, \
                  ARRAY[i.inhparent, i.inhrelid]::oid[] AS path \
           FROM pg_catalog.pg_inherits i \
           JOIN pg_catalog.pg_partition_rule pr ON pr.parchildrelid = i.inhrelid \
           JOIN pg_catalog.pg_partition pp ON pp.oid = pr.paroid AND NOT pp.paristemplate \
           JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid \
           JOIN pg_catalog.pg_namespace child_n ON child_n.oid = child.relnamespace \
           WHERE i.inhparent = ANY($2::oid[]) AND child_n.nspname = $1 \
           UNION ALL \
           SELECT i.inhrelid, \
                  i.inhparent, \
                  COALESCE(pr.parruleord, 0), \
                  tree.path || i.inhrelid \
           FROM partition_tree tree \
           JOIN pg_catalog.pg_inherits i ON i.inhparent = tree.oid \
           JOIN pg_catalog.pg_partition_rule pr ON pr.parchildrelid = i.inhrelid \
           JOIN pg_catalog.pg_partition pp ON pp.oid = pr.paroid AND NOT pp.paristemplate \
           JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid \
           JOIN pg_catalog.pg_namespace child_n ON child_n.oid = child.relnamespace \
           WHERE child_n.nspname = $1 AND NOT i.inhrelid = ANY(tree.path) \
         ) \
         SELECT c.relname::text AS table_name, \
                {type_case} AS table_type, \
                obj_description(c.oid) AS table_comment, \
                pn.nspname::text AS parent_schema, \
                pc.relname::text AS parent_name \
         FROM partition_tree tree \
         JOIN pg_catalog.pg_class c ON c.oid = tree.oid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_class pc ON pc.oid = tree.parent_oid \
         JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ({relation_kinds}) \
         ORDER BY tree.rule_ord, c.relname"
    )
}

pub(super) fn gp6_object_relations_sql(has_relstorage: bool) -> String {
    let type_case = gp6_object_type_case_sql(has_relstorage);
    format!(
        "SELECT c.relname::text AS object_name, \
                {type_case} AS object_type, \
                obj_description(c.oid) AS object_comment, \
                CASE WHEN pp.oid IS NOT NULL THEN pn.nspname::text ELSE NULL END AS parent_schema, \
                CASE WHEN pp.oid IS NOT NULL THEN pc.relname::text ELSE NULL END AS parent_name \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_partition_rule pr ON pr.parchildrelid = c.oid AND pr.parchildrelid <> 0 \
         LEFT JOIN pg_catalog.pg_partition pp ON pp.oid = pr.paroid AND NOT pp.paristemplate \
         LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid AND i.inhseqno = 1 AND pp.oid IS NOT NULL \
         LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
         LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','S') \
         ORDER BY CASE c.relkind WHEN 'v' THEN 1 WHEN 'm' THEN 1 WHEN 'S' THEN 4 ELSE 0 END, c.relname"
    )
}

async fn annotate_gp7_external_tables(pool: &Pool, schema: &str, tables: &mut [TableInfo]) {
    let names = tables.iter().map(|table| table.name.clone()).collect::<Vec<_>>();
    let external_names = gp7_external_table_names(pool, schema, &names).await.unwrap_or_else(|error| {
        log::debug!("[greenplum][list_tables:external-table-fallback] error={error}");
        HashSet::new()
    });
    for table in tables {
        if external_names.contains(&table.name) {
            table.table_type = "EXTERNAL TABLE".to_string();
        }
    }
}

async fn gp7_external_table_names(pool: &Pool, schema: &str, names: &[String]) -> Result<HashSet<String>, String> {
    if names.is_empty() {
        return Ok(HashSet::new());
    }
    let schema = normalize_schema(schema);
    let client = db::postgres::checkout_postgres_client(pool, None, db::connection_timeout()).await?;
    let rows = client.query(GP7_EXTERNAL_TABLES_SQL, &[&schema, &names]).await.map_err(pg_err)?;
    Ok(rows.into_iter().filter_map(|row| row.try_get::<_, String>(0).ok()).collect())
}

fn table_info_from_row(row: &tokio_postgres::Row) -> TableInfo {
    TableInfo {
        name: row.try_get::<_, String>(0).unwrap_or_default(),
        table_type: row.try_get::<_, String>(1).unwrap_or_else(|_| "BASE TABLE".to_string()),
        valid: None,
        comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
        parent_schema: row.try_get::<_, Option<String>>(3).ok().flatten().filter(|s| !s.is_empty()),
        parent_name: row.try_get::<_, Option<String>>(4).ok().flatten().filter(|s| !s.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::greenplum::ddl::render_gp6_partition_def_from_catalog;

    #[test]
    fn assembles_gp6_multilevel_partition_tree_and_bounds() {
        let levels = vec![
            Gp6PartitionLevel {
                part_oid: 200,
                level: 0,
                kind: Some(PgPartitionKind::Range),
                key_columns: vec!["biz_date".to_string()],
            },
            Gp6PartitionLevel {
                part_oid: 201,
                level: 1,
                kind: Some(PgPartitionKind::List),
                key_columns: vec!["region".to_string()],
            },
        ];
        let rules = vec![
            Gp6PartitionRule {
                rule_oid: 300,
                part_oid: 200,
                parent_rule_oid: 0,
                child_oid: 101,
                child_schema: "public".to_string(),
                child_name: "sales_1_prt_p202601".to_string(),
                partition_name: "p202601".to_string(),
                is_default: false,
                rule_ord: 1,
                range_start: Some("'2026-01-01'::date".to_string()),
                range_start_incl: true,
                range_end: Some("'2026-02-01'::date".to_string()),
                range_end_incl: false,
                list_values: None,
                reloptions: Vec::new(),
                tablespace: None,
            },
            Gp6PartitionRule {
                rule_oid: 301,
                part_oid: 201,
                parent_rule_oid: 300,
                child_oid: 102,
                child_schema: "public".to_string(),
                child_name: "sales_1_prt_p202601_2_prt_east".to_string(),
                partition_name: "east".to_string(),
                is_default: false,
                rule_ord: 1,
                range_start: None,
                range_start_incl: true,
                range_end: None,
                range_end_incl: false,
                list_values: Some("'SH', 'HZ'".to_string()),
                reloptions: vec!["appendonly=true".to_string()],
                tablespace: None,
            },
            Gp6PartitionRule {
                rule_oid: 302,
                part_oid: 200,
                parent_rule_oid: 0,
                child_oid: 103,
                child_schema: "public".to_string(),
                child_name: "sales_1_prt_other".to_string(),
                partition_name: "other".to_string(),
                is_default: true,
                rule_ord: 2,
                range_start: None,
                range_start_incl: true,
                range_end: None,
                range_end_incl: false,
                list_values: None,
                reloptions: Vec::new(),
                tablespace: None,
            },
        ];
        let mut stats = HashMap::new();
        stats.insert(102, (Some(5000), Some(1_048_576)));

        let partitioning =
            assemble_gp6_table_partitioning(100, None, 100, "public", "sales", &levels, &rules, &stats, Some(90426));

        assert!(partitioning.is_partitioned);
        assert!(!partitioning.is_partition);
        assert_eq!(partitioning.strategy, Some(PgPartitionKind::Range));
        assert_eq!(partitioning.key_columns, vec!["biz_date"]);
        assert_eq!(partitioning.default_partition.as_deref(), Some("sales_1_prt_other"));
        assert_eq!(partitioning.partitions.len(), 2);

        let first = &partitioning.partitions[0];
        assert_eq!(first.name, "sales_1_prt_p202601");
        assert!(!first.is_leaf);
        assert_eq!(first.strategy, Some(PgPartitionKind::List));
        assert_eq!(
            first.bound,
            Some(PgPartitionBound::Range {
                from: vec!["'2026-01-01'::date".to_string()],
                to: vec!["'2026-02-01'::date".to_string()],
            })
        );
        assert_eq!(first.children.len(), 1);
        let leaf = &first.children[0];
        assert!(leaf.is_leaf);
        assert_eq!(leaf.row_estimate, Some(5000));
        assert_eq!(leaf.total_bytes, Some(1_048_576));
        assert_eq!(leaf.bound, Some(PgPartitionBound::List { values: vec!["'SH'".to_string(), "'HZ'".to_string()] }));

        // Structured DDL fallback should also render both levels cleanly.
        let fallback_ddl = render_gp6_partition_def_from_catalog(&levels, &rules, true).unwrap();
        assert!(fallback_ddl.contains("PARTITION BY RANGE (\"biz_date\")"));
        assert!(fallback_ddl.contains("SUBPARTITION BY LIST (\"region\")"));
        assert!(fallback_ddl.contains("SUBPARTITION \"east\" VALUES ('SH', 'HZ') WITH (appendonly=true)"));
        assert!(fallback_ddl.contains("DEFAULT PARTITION \"other\""));
    }

    #[test]
    fn preserves_non_standard_inclusive_end_in_bound_definition_fallback() {
        let rule = Gp6PartitionRule {
            rule_oid: 1,
            part_oid: 2,
            parent_rule_oid: 0,
            child_oid: 3,
            child_schema: "public".to_string(),
            child_name: "t_1_prt_p1".to_string(),
            partition_name: "p1".to_string(),
            is_default: false,
            rule_ord: 1,
            range_start: Some("1".to_string()),
            range_start_incl: true,
            range_end: Some("100".to_string()),
            range_end_incl: true,
            list_values: None,
            reloptions: Vec::new(),
            tablespace: None,
        };

        let (bound, def) = parse_gp6_rule_bound(&rule, Some(PgPartitionKind::Range));
        assert_eq!(bound, None);
        assert_eq!(def.as_deref(), Some("START (1) INCLUSIVE END (100) INCLUSIVE"));
    }
}
