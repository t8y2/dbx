use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StructureDialect {
    Mysql,
    Doris,
    Postgres,
    Sqlite,
    #[cfg(feature = "duckdb-sidecar")]
    DuckDb,
    SqlServer,
    Oracle,
    Dameng,
    // 神通 Oscar：Oracle 兼容方言，且支持 ALTER TABLE DROP/ADD PRIMARY KEY（与 Dameng 一致，
    // 不同于 Oracle）。DDL 生成行为与 Dameng 共享分支；单独成 dialect 以保证 label/反向映射准确。
    Oscar,
    H2,
    ClickHouse,
    ManticoreSearch,
    Informix,
    Questdb,
    Unsupported,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct TableStructureCapabilities {
    pub(super) dialect: StructureDialect,
    pub(super) add_column: bool,
    pub(super) drop_column: bool,
    pub(super) rename_column: bool,
    pub(super) alter_existing_column: bool,
    pub(super) reorder_column: bool,
    pub(super) comment: bool,
    pub(super) create_index: bool,
    pub(super) drop_index: bool,
    pub(super) rebuild_index: bool,
    pub(super) index_type: bool,
    pub(super) index_include: bool,
    pub(super) index_filter: bool,
    pub(super) index_comment: bool,
    pub(super) alter_primary_key: bool,
    pub(super) foreign_key: bool,
}

impl Default for TableStructureCapabilities {
    fn default() -> Self {
        Self {
            dialect: StructureDialect::Unsupported,
            add_column: false,
            drop_column: false,
            rename_column: false,
            alter_existing_column: false,
            reorder_column: false,
            comment: false,
            create_index: false,
            drop_index: false,
            rebuild_index: false,
            index_type: false,
            index_include: false,
            index_filter: false,
            index_comment: false,
            alter_primary_key: false,
            foreign_key: false,
        }
    }
}

pub(super) fn capabilities_for(database_type: Option<DatabaseType>) -> TableStructureCapabilities {
    let base = TableStructureCapabilities::default();
    match database_type {
        Some(
            DatabaseType::Mysql
            | DatabaseType::StarRocks
            | DatabaseType::Goldendb
            | DatabaseType::Sundb
            | DatabaseType::Databend,
        ) => TableStructureCapabilities {
            dialect: StructureDialect::Mysql,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            reorder_column: true,
            comment: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            index_type: true,
            index_comment: true,
            alter_primary_key: true,
            foreign_key: true,
            ..base
        },
        Some(DatabaseType::Doris) => TableStructureCapabilities {
            dialect: StructureDialect::Doris,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            comment: true,
            ..base
        },
        Some(DatabaseType::Gbase) => TableStructureCapabilities {
            dialect: StructureDialect::Mysql,
            add_column: true,
            drop_column: true,
            rename_column: true,
            reorder_column: true,
            ..base
        },
        Some(
            DatabaseType::Postgres
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::OpenGauss
            | DatabaseType::Highgo
            | DatabaseType::Uxdb
            | DatabaseType::Vastbase
            | DatabaseType::Kingbase
            | DatabaseType::Firebird,
        ) => TableStructureCapabilities {
            dialect: StructureDialect::Postgres,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            comment: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            index_type: true,
            index_include: true,
            index_filter: true,
            index_comment: true,
            alter_primary_key: true,
            foreign_key: true,
            ..base
        },
        Some(DatabaseType::Questdb) => TableStructureCapabilities {
            dialect: StructureDialect::Questdb,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            reorder_column: false,
            comment: false,
            create_index: false,
            drop_index: false,
            rebuild_index: false,
            index_type: false,
            index_include: false,
            index_filter: false,
            index_comment: false,
            alter_primary_key: false,
            foreign_key: false,
        },
        Some(DatabaseType::Redshift | DatabaseType::Vertica) => TableStructureCapabilities {
            dialect: StructureDialect::Postgres,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            comment: true,
            ..base
        },
        Some(DatabaseType::Sqlite | DatabaseType::Rqlite) => TableStructureCapabilities {
            dialect: StructureDialect::Sqlite,
            add_column: true,
            drop_column: true,
            rename_column: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            index_filter: true,
            ..base
        },
        #[cfg(feature = "duckdb-sidecar")]
        Some(DatabaseType::DuckDb) => TableStructureCapabilities {
            dialect: StructureDialect::DuckDb,
            add_column: true,
            drop_column: true,
            rename_column: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            ..base
        },
        Some(DatabaseType::SqlServer) => TableStructureCapabilities {
            dialect: StructureDialect::SqlServer,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            comment: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            index_type: true,
            index_include: true,
            index_filter: true,
            index_comment: true,
            ..base
        },
        Some(DatabaseType::Dameng) => TableStructureCapabilities {
            dialect: StructureDialect::Dameng,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            comment: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            index_type: true,
            alter_primary_key: true,
            ..base
        },
        // 神通 Oscar v7：Oracle 兼容，实测支持 ALTER TABLE ADD/MODIFY/DROP/RENAME COLUMN、
        // DROP/ADD PRIMARY KEY、COMMENT ON、CREATE/DROP INDEX（见 issue #5505 探测）。
        Some(DatabaseType::Oscar) => TableStructureCapabilities {
            dialect: StructureDialect::Oscar,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            comment: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            index_type: true,
            alter_primary_key: true,
            ..base
        },
        Some(DatabaseType::Iris) => TableStructureCapabilities {
            dialect: StructureDialect::Oracle,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            // IRIS supports %DESCRIPTION while defining tables/columns, but cannot alter existing descriptions.
            comment: false,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            index_type: true,
            ..base
        },
        Some(DatabaseType::Oracle) => TableStructureCapabilities {
            dialect: StructureDialect::Oracle,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            comment: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            index_type: true,
            foreign_key: true,
            ..base
        },
        Some(DatabaseType::OceanbaseOracle | DatabaseType::Yashandb | DatabaseType::Xugu) => {
            TableStructureCapabilities {
                dialect: StructureDialect::Oracle,
                add_column: true,
                drop_column: true,
                rename_column: true,
                alter_existing_column: true,
                comment: true,
                create_index: true,
                drop_index: true,
                rebuild_index: true,
                index_type: true,
                ..base
            }
        }
        Some(DatabaseType::H2) => TableStructureCapabilities {
            dialect: StructureDialect::H2,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            comment: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            ..base
        },
        Some(DatabaseType::ClickHouse) => TableStructureCapabilities {
            dialect: StructureDialect::ClickHouse,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            reorder_column: true,
            comment: true,
            ..base
        },
        Some(DatabaseType::ManticoreSearch) => TableStructureCapabilities {
            dialect: StructureDialect::ManticoreSearch,
            add_column: true,
            drop_column: true,
            ..base
        },
        Some(DatabaseType::Informix) => TableStructureCapabilities {
            dialect: StructureDialect::Informix,
            add_column: true,
            drop_column: true,
            rename_column: true,
            alter_existing_column: true,
            create_index: true,
            drop_index: true,
            rebuild_index: true,
            ..base
        },
        _ => base,
    }
}

pub(super) fn is_oracle_like(dialect: StructureDialect) -> bool {
    matches!(dialect, StructureDialect::Oracle | StructureDialect::Dameng | StructureDialect::Oscar)
}

pub(super) fn database_label(database_type: Option<DatabaseType>) -> String {
    database_type
        .map(|database_type| {
            serde_json::to_value(database_type)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_else(|| "this database".to_string())
        })
        .unwrap_or_else(|| "this database".to_string())
}

pub(super) fn dialect_label(dialect: StructureDialect) -> String {
    match dialect {
        StructureDialect::Mysql => "mysql",
        StructureDialect::Doris => "doris",
        StructureDialect::Postgres => "postgres",
        StructureDialect::Sqlite => "sqlite",
        #[cfg(feature = "duckdb-sidecar")]
        StructureDialect::DuckDb => "duckdb",
        StructureDialect::SqlServer => "sqlserver",
        StructureDialect::Oracle => "oracle",
        StructureDialect::Dameng => "dameng",
        StructureDialect::Oscar => "oscar",
        StructureDialect::H2 => "h2",
        StructureDialect::ClickHouse => "clickhouse",
        StructureDialect::ManticoreSearch => "manticoresearch",
        StructureDialect::Informix => "informix",
        StructureDialect::Questdb => "questdb",
        StructureDialect::Unsupported => "this database",
    }
    .to_string()
}

pub(super) fn database_type_for_dialect(dialect: StructureDialect) -> Option<DatabaseType> {
    match dialect {
        StructureDialect::Mysql => Some(DatabaseType::Mysql),
        StructureDialect::Doris => Some(DatabaseType::Doris),
        StructureDialect::Postgres => Some(DatabaseType::Postgres),
        StructureDialect::Sqlite => Some(DatabaseType::Sqlite),
        #[cfg(feature = "duckdb-sidecar")]
        StructureDialect::DuckDb => Some(DatabaseType::DuckDb),
        StructureDialect::SqlServer => Some(DatabaseType::SqlServer),
        StructureDialect::Oracle => Some(DatabaseType::Oracle),
        StructureDialect::Dameng => Some(DatabaseType::Dameng),
        StructureDialect::Oscar => Some(DatabaseType::Oscar),
        StructureDialect::H2 => Some(DatabaseType::H2),
        StructureDialect::ClickHouse => Some(DatabaseType::ClickHouse),
        StructureDialect::ManticoreSearch => Some(DatabaseType::ManticoreSearch),
        StructureDialect::Informix => Some(DatabaseType::Informix),
        StructureDialect::Questdb => Some(DatabaseType::Questdb),
        StructureDialect::Unsupported => None,
    }
}
