use crate::sql_dialect::descriptor::{DialectCapabilityDescriptor, DialectInfo, DialectKind, TypeMappingMatrix};
use insta::assert_json_snapshot;

#[test]
fn snapshot_mysql_descriptor() {
    let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Mysql);
    assert_json_snapshot!("mysql_descriptor", desc);
}

#[test]
fn snapshot_postgres_descriptor() {
    let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Postgres);
    assert_json_snapshot!("postgres_descriptor", desc);
}

#[test]
fn snapshot_sqlite_descriptor() {
    let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Sqlite);
    assert_json_snapshot!("sqlite_descriptor", desc);
}

#[test]
fn snapshot_sqlserver_descriptor() {
    let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::SqlServer);
    assert_json_snapshot!("sqlserver_descriptor", desc);
}

#[test]
fn snapshot_oracle_descriptor() {
    let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Oracle);
    assert_json_snapshot!("oracle_descriptor", desc);
}

#[test]
fn snapshot_duckdb_descriptor() {
    let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::DuckDb);
    assert_json_snapshot!("duckdb_descriptor", desc);
}

#[test]
fn snapshot_mysql_info() {
    let info = DialectInfo::for_kind(DialectKind::Mysql);
    assert_json_snapshot!("mysql_info", info);
}

#[test]
fn snapshot_postgres_info() {
    let info = DialectInfo::for_kind(DialectKind::Postgres);
    assert_json_snapshot!("postgres_info", info);
}

#[test]
fn snapshot_mysql_to_postgres_type_mapping() {
    let matrix = TypeMappingMatrix::for_dialects(DialectKind::Mysql, DialectKind::Postgres);
    assert_json_snapshot!("mysql_to_postgres_mapping", &matrix.rules);
}

#[test]
fn snapshot_postgres_to_mysql_type_mapping() {
    let matrix = TypeMappingMatrix::for_dialects(DialectKind::Postgres, DialectKind::Mysql);
    assert_json_snapshot!("postgres_to_mysql_mapping", &matrix.rules);
}

#[test]
fn snapshot_all_dialects_info() {
    let all = DialectInfo::all();
    assert_json_snapshot!("all_dialects_info", all);
}
