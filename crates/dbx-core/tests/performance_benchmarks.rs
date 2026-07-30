// ============================================================================
// 12.5 — Performance Benchmarks
//
// These benchmarks measure schema diff performance with large table sets.
// Run with: cargo test --release --test performance_benchmarks -- --ignored
// ============================================================================

use std::time::Instant;

use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{
    prepare_schema_diff, SchemaDiffPreparationOptions, ShardBy, ShardStrategy, TableSchemaDetail,
};
use dbx_core::types::{ColumnInfo, TableInfo};

fn generate_tables(count: usize, prefix: &str) -> Vec<TableInfo> {
    (0..count)
        .map(|i| TableInfo {
            name: format!("{}_{}", prefix, i),
            table_type: "BASE TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect()
}

fn generate_details(tables: &[TableInfo], columns_per_table: usize) -> Vec<TableSchemaDetail> {
    tables
        .iter()
        .map(|t| TableSchemaDetail {
            name: t.name.clone(),
            columns: (0..columns_per_table)
                .map(|j| ColumnInfo {
                    name: format!("col_{}", j),
                    data_type: if j % 3 == 0 { "int".to_string() } else { "varchar(64)".to_string() },
                    is_nullable: j % 2 == 0,
                    column_default: if j == 0 { Some("0".to_string()) } else { None },
                    is_primary_key: j == 0,
                    extra: None,
                    comment: None,
                    numeric_precision: if j % 3 == 0 { Some(10) } else { None },
                    numeric_scale: if j % 3 == 0 { Some(0) } else { None },
                    character_maximum_length: if j % 3 != 0 { Some(64) } else { None },
                    enum_values: None,
                    character_set: None,
                    collation: None,
                })
                .collect(),
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: None,
        })
        .collect()
}

/// Benchmark: diff a small number of tables (baseline)
#[ignore]
#[test]
fn benchmark_small_schema_diff() {
    let table_count = 10;
    let columns_per_table = 5;
    let source_tables = generate_tables(table_count, "src");
    let target_tables = generate_tables(table_count, "tgt");
    let source_details = generate_details(&source_tables, columns_per_table);
    let target_details = generate_details(&target_tables, columns_per_table);

    let options = SchemaDiffPreparationOptions {
        source_tables,
        target_tables,
        source_details,
        target_details,
        database_type: DatabaseType::Postgres,
        ..Default::default()
    };

    let start = Instant::now();
    let result = prepare_schema_diff(options);
    let elapsed = start.elapsed();

    assert!(!result.diffs.is_empty(), "Should detect differences");
    eprintln!("[BENCHMARK] small_schema_diff ({} tables, {} cols): {:?}", table_count, columns_per_table, elapsed);
}

/// Benchmark: diff a medium number of tables
#[ignore]
#[test]
fn benchmark_medium_schema_diff() {
    let table_count = 100;
    let columns_per_table = 10;
    let source_tables = generate_tables(table_count, "src");
    let target_tables = generate_tables(table_count, "tgt");
    let source_details = generate_details(&source_tables, columns_per_table);
    let target_details = generate_details(&target_tables, columns_per_table);

    let options = SchemaDiffPreparationOptions {
        source_tables,
        target_tables,
        source_details,
        target_details,
        database_type: DatabaseType::Postgres,
        ..Default::default()
    };

    let start = Instant::now();
    let result = prepare_schema_diff(options);
    let elapsed = start.elapsed();

    assert!(!result.diffs.is_empty(), "Should detect differences");
    eprintln!("[BENCHMARK] medium_schema_diff ({} tables, {} cols): {:?}", table_count, columns_per_table, elapsed);
}

/// Benchmark: diff a large number of tables
#[ignore]
#[test]
fn benchmark_large_schema_diff() {
    let table_count = 200;
    let columns_per_table = 10;
    let source_tables = generate_tables(table_count, "src");
    let target_tables = generate_tables(table_count, "tgt");
    let source_details = generate_details(&source_tables, columns_per_table);
    let target_details = generate_details(&target_tables, columns_per_table);

    let options = SchemaDiffPreparationOptions {
        source_tables,
        target_tables,
        source_details,
        target_details,
        database_type: DatabaseType::Postgres,
        ..Default::default()
    };

    let start = Instant::now();
    let result = prepare_schema_diff(options);
    let elapsed = start.elapsed();

    assert!(!result.diffs.is_empty(), "Should detect differences");
    eprintln!("[BENCHMARK] large_schema_diff ({} tables, {} cols): {:?}", table_count, columns_per_table, elapsed);
}

/// Benchmark: diff 1000 tables (simulates the 1000-table requirement)
#[ignore]
#[test]
fn benchmark_thousand_table_schema_diff() {
    let table_count = 1000;
    let columns_per_table = 5;
    let source_tables = generate_tables(table_count, "src");
    let target_tables = generate_tables(table_count, "tgt");
    let source_details = generate_details(&source_tables, columns_per_table);
    let target_details = generate_details(&target_tables, columns_per_table);

    let options = SchemaDiffPreparationOptions {
        source_tables,
        target_tables,
        source_details,
        target_details,
        database_type: DatabaseType::Postgres,
        ..Default::default()
    };

    let start = Instant::now();
    let result = prepare_schema_diff(options);
    let elapsed = start.elapsed();

    assert!(!result.diffs.is_empty(), "Should detect differences");
    eprintln!(
        "[BENCHMARK] thousand_table_schema_diff ({} tables, {} cols): {:?}",
        table_count, columns_per_table, elapsed
    );
}

/// Benchmark: shard-parallel speedup comparison
#[ignore]
#[test]
fn benchmark_shard_parallel_speedup() {
    let table_count = 200;
    let columns_per_table = 8;
    let source_tables = generate_tables(table_count, "src");
    let target_tables = generate_tables(table_count, "tgt");
    let source_details = generate_details(&source_tables, columns_per_table);
    let target_details = generate_details(&target_tables, columns_per_table);

    // Single-threaded (shard_count = 1)
    let options_single = SchemaDiffPreparationOptions {
        source_tables: source_tables.clone(),
        target_tables: target_tables.clone(),
        source_details: source_details.clone(),
        target_details: target_details.clone(),
        database_type: DatabaseType::Postgres,
        ..Default::default()
    };

    let start_single = Instant::now();
    let _result_single = prepare_schema_diff(options_single);
    let single_time = start_single.elapsed();

    // Shard-parallel (shard_count = 4)
    let shard_options = SchemaDiffPreparationOptions {
        source_tables: source_tables.clone(),
        target_tables: target_tables.clone(),
        source_details: source_details.clone(),
        target_details: target_details.clone(),
        database_type: DatabaseType::Postgres,
        shard_strategy: Some(ShardStrategy { shard_count: 4, shard_by: ShardBy::RoundRobin }),
        ..Default::default()
    };

    let start_parallel = Instant::now();
    let _result_parallel = prepare_schema_diff(shard_options);
    let parallel_time = start_parallel.elapsed();

    eprintln!(
        "[BENCHMARK] shard_speedup: single={:?}, parallel(4 shards)={:?}, speedup={:.2}x",
        single_time,
        parallel_time,
        single_time.as_secs_f64() / parallel_time.as_secs_f64().max(0.0001)
    );

    assert!(
        parallel_time <= single_time * 3, // Allow some overhead; shard_count=4 may not be 4x faster on small data
        "Parallel should not be significantly slower than single-threaded"
    );
}

/// Benchmark: DependencyGraph build time
#[ignore]
#[test]
fn benchmark_dependency_graph_build() {
    use dbx_core::schema_diff::DependencyGraph;
    use dbx_core::types::ForeignKeyInfo;

    let details: Vec<TableSchemaDetail> = (0..100)
        .map(|i| {
            let mut fks = vec![];
            if i > 0 {
                fks.push(ForeignKeyInfo {
                    name: format!("fk_{}_to_{}", i, i - 1),
                    column: "parent_id".to_string(),
                    ref_schema: None,
                    ref_table: format!("tgt_{}", i - 1),
                    ref_column: "id".to_string(),
                    on_update: None,
                    on_delete: None,
                });
            }
            TableSchemaDetail {
                name: format!("tgt_{}", i),
                columns: vec![],
                indexes: vec![],
                foreign_keys: fks,
                triggers: vec![],
                ddl: None,
            }
        })
        .collect();

    let tables: Vec<TableInfo> = (0..100)
        .map(|i| TableInfo {
            name: format!("tgt_{}", i),
            table_type: "BASE TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect();

    let start = Instant::now();
    let graph = DependencyGraph::build(&details, &tables);
    let elapsed = start.elapsed();

    assert_eq!(graph.nodes.len(), 100);
    eprintln!("[BENCHMARK] dependency_graph_build (100 tables): {:?}", elapsed);
}
