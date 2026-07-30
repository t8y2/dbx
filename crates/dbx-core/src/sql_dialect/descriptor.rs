use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DialectKind {
    Mysql,
    Postgres,
    Sqlite,
    DuckDb,
    SqlServer,
    Oracle,
    H2,
    ClickHouse,
    ManticoreSearch,
    Informix,
    Questdb,
    Unsupported,
}

impl DialectKind {
    pub fn from_database_type(db_type: DatabaseType) -> Self {
        match db_type {
            DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::Goldendb
            | DatabaseType::Sundb
            | DatabaseType::Databend
            | DatabaseType::Gbase => DialectKind::Mysql,
            DatabaseType::Postgres
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::OpenGauss
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
            | DatabaseType::Kingbase
            | DatabaseType::Firebird
            | DatabaseType::Redshift
            | DatabaseType::Vertica
            | DatabaseType::Exasol => DialectKind::Postgres,
            DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso => DialectKind::Sqlite,
            DatabaseType::DuckDb => DialectKind::DuckDb,
            DatabaseType::SqlServer | DatabaseType::Access => DialectKind::SqlServer,
            DatabaseType::Oracle
            | DatabaseType::Dameng
            | DatabaseType::OceanbaseOracle
            | DatabaseType::Iris
            | DatabaseType::Yashandb
            | DatabaseType::Xugu => DialectKind::Oracle,
            DatabaseType::H2 => DialectKind::H2,
            DatabaseType::ClickHouse => DialectKind::ClickHouse,
            DatabaseType::ManticoreSearch => DialectKind::ManticoreSearch,
            DatabaseType::Informix => DialectKind::Informix,
            DatabaseType::Questdb => DialectKind::Questdb,
            _ => DialectKind::Unsupported,
        }
    }

    pub fn to_database_type(self) -> Option<DatabaseType> {
        match self {
            DialectKind::Mysql => Some(DatabaseType::Mysql),
            DialectKind::Postgres => Some(DatabaseType::Postgres),
            DialectKind::Sqlite => Some(DatabaseType::Sqlite),
            DialectKind::DuckDb => Some(DatabaseType::DuckDb),
            DialectKind::SqlServer => Some(DatabaseType::SqlServer),
            DialectKind::Oracle => Some(DatabaseType::Oracle),
            DialectKind::H2 => Some(DatabaseType::H2),
            DialectKind::ClickHouse => Some(DatabaseType::ClickHouse),
            DialectKind::ManticoreSearch => Some(DatabaseType::ManticoreSearch),
            DialectKind::Informix => Some(DatabaseType::Informix),
            DialectKind::Questdb => Some(DatabaseType::Questdb),
            DialectKind::Unsupported => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            DialectKind::Mysql => "mysql",
            DialectKind::Postgres => "postgres",
            DialectKind::Sqlite => "sqlite",
            DialectKind::DuckDb => "duckdb",
            DialectKind::SqlServer => "sqlserver",
            DialectKind::Oracle => "oracle",
            DialectKind::H2 => "h2",
            DialectKind::ClickHouse => "clickhouse",
            DialectKind::ManticoreSearch => "manticoresearch",
            DialectKind::Informix => "informix",
            DialectKind::Questdb => "questdb",
            DialectKind::Unsupported => "unsupported",
        }
    }

    pub fn from_label(label: &str) -> Option<Self> {
        match label.to_ascii_lowercase().as_str() {
            // MySQL family
            "mysql" | "doris" | "starrocks" | "goldendb" | "sundb" | "databend" | "gbase" => Some(DialectKind::Mysql),
            // PostgreSQL family
            "postgresql" | "postgres" | "gaussdb" | "kwdb" | "opengauss" | "highgo" | "vastbase" | "kingbase"
            | "firebird" | "redshift" | "vertica" | "exasol" => Some(DialectKind::Postgres),
            // SQLite family
            "sqlite" | "rqlite" | "turso" => Some(DialectKind::Sqlite),
            // DuckDB
            "duckdb" => Some(DialectKind::DuckDb),
            // SQL Server family
            "sqlserver" | "mssql" | "sql server" | "access" => Some(DialectKind::SqlServer),
            // Oracle family
            "oracle" | "dameng" | "oceanbaseoracle" | "oceanbase" | "iris" | "yashandb" | "xugu" => {
                Some(DialectKind::Oracle)
            }
            // Others
            "h2" => Some(DialectKind::H2),
            "clickhouse" => Some(DialectKind::ClickHouse),
            "manticoresearch" => Some(DialectKind::ManticoreSearch),
            "informix" => Some(DialectKind::Informix),
            "questdb" => Some(DialectKind::Questdb),
            _ => None,
        }
    }
}

type DdlCapabilityFlags = u64;

pub const CAP_ADD_COLUMN: DdlCapabilityFlags = 1 << 0;
pub const CAP_DROP_COLUMN: DdlCapabilityFlags = 1 << 1;
pub const CAP_RENAME_COLUMN: DdlCapabilityFlags = 1 << 2;
pub const CAP_ALTER_EXISTING_COLUMN: DdlCapabilityFlags = 1 << 3;
pub const CAP_REORDER_COLUMN: DdlCapabilityFlags = 1 << 4;
pub const CAP_COMMENT: DdlCapabilityFlags = 1 << 5;
pub const CAP_CREATE_INDEX: DdlCapabilityFlags = 1 << 6;
pub const CAP_DROP_INDEX: DdlCapabilityFlags = 1 << 7;
pub const CAP_REBUILD_INDEX: DdlCapabilityFlags = 1 << 8;
pub const CAP_INDEX_TYPE: DdlCapabilityFlags = 1 << 9;
pub const CAP_INDEX_INCLUDE: DdlCapabilityFlags = 1 << 10;
pub const CAP_INDEX_FILTER: DdlCapabilityFlags = 1 << 11;
pub const CAP_INDEX_COMMENT: DdlCapabilityFlags = 1 << 12;
pub const CAP_ALTER_PRIMARY_KEY: DdlCapabilityFlags = 1 << 13;
pub const CAP_FOREIGN_KEY: DdlCapabilityFlags = 1 << 14;
pub const CAP_CREATE_TABLE: DdlCapabilityFlags = 1 << 15;
pub const CAP_DROP_TABLE: DdlCapabilityFlags = 1 << 16;
pub const CAP_TRUNCATE_TABLE: DdlCapabilityFlags = 1 << 17;
pub const CAP_CREATE_TRIGGER: DdlCapabilityFlags = 1 << 18;
pub const CAP_DROP_TRIGGER: DdlCapabilityFlags = 1 << 19;
pub const CAP_CREATE_FUNCTION: DdlCapabilityFlags = 1 << 20;
pub const CAP_DROP_FUNCTION: DdlCapabilityFlags = 1 << 21;
pub const CAP_CREATE_SEQUENCE: DdlCapabilityFlags = 1 << 22;
pub const CAP_DROP_SEQUENCE: DdlCapabilityFlags = 1 << 23;
pub const CAP_ALTER_OWNER: DdlCapabilityFlags = 1 << 24;
pub const CAP_GRANT_REVOKE: DdlCapabilityFlags = 1 << 25;
pub const CAP_IF_NOT_EXISTS: DdlCapabilityFlags = 1 << 26;
pub const CAP_CREATE_OR_REPLACE: DdlCapabilityFlags = 1 << 27;
pub const CAP_TEMPORARY_TABLE: DdlCapabilityFlags = 1 << 28;
pub const CAP_TRANSACTIONAL_DDL: DdlCapabilityFlags = 1 << 29;
pub const CAP_AUTO_INCREMENT: DdlCapabilityFlags = 1 << 30;
pub const CAP_IDENTITY_COLUMNS: DdlCapabilityFlags = 1 << 31;

const CAP_NAMES: &[(DdlCapabilityFlags, &str)] = &[
    (CAP_ADD_COLUMN, "add_column"),
    (CAP_DROP_COLUMN, "drop_column"),
    (CAP_RENAME_COLUMN, "rename_column"),
    (CAP_ALTER_EXISTING_COLUMN, "alter_existing_column"),
    (CAP_REORDER_COLUMN, "reorder_column"),
    (CAP_COMMENT, "comment"),
    (CAP_CREATE_INDEX, "create_index"),
    (CAP_DROP_INDEX, "drop_index"),
    (CAP_REBUILD_INDEX, "rebuild_index"),
    (CAP_INDEX_TYPE, "index_type"),
    (CAP_INDEX_INCLUDE, "index_include"),
    (CAP_INDEX_FILTER, "index_filter"),
    (CAP_INDEX_COMMENT, "index_comment"),
    (CAP_ALTER_PRIMARY_KEY, "alter_primary_key"),
    (CAP_FOREIGN_KEY, "foreign_key"),
    (CAP_CREATE_TABLE, "create_table"),
    (CAP_DROP_TABLE, "drop_table"),
    (CAP_TRUNCATE_TABLE, "truncate_table"),
    (CAP_CREATE_TRIGGER, "create_trigger"),
    (CAP_DROP_TRIGGER, "drop_trigger"),
    (CAP_CREATE_FUNCTION, "create_function"),
    (CAP_DROP_FUNCTION, "drop_function"),
    (CAP_CREATE_SEQUENCE, "create_sequence"),
    (CAP_DROP_SEQUENCE, "drop_sequence"),
    (CAP_ALTER_OWNER, "alter_owner"),
    (CAP_GRANT_REVOKE, "grant_revoke"),
    (CAP_IF_NOT_EXISTS, "if_not_exists"),
    (CAP_CREATE_OR_REPLACE, "create_or_replace"),
    (CAP_TEMPORARY_TABLE, "temporary_table"),
    (CAP_TRANSACTIONAL_DDL, "transactional_ddl"),
    (CAP_AUTO_INCREMENT, "auto_increment"),
    (CAP_IDENTITY_COLUMNS, "identity_columns"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DialectCapabilityDescriptor {
    pub dialect: DialectKind,
    pub flags: DdlCapabilityFlags,
    pub max_identifier_length: u32,
    pub supports_schemas: bool,
    pub supports_catalogs: bool,
    pub max_columns_per_table: u32,
    pub max_indexes_per_table: u32,
    pub max_query_size_bytes: u64,
    pub supports_full_text_index: bool,
    pub supports_spatial_index: bool,
    pub supports_partitioning: bool,
    pub supports_table_sampling: bool,
    pub max_foreign_key_name_length: u32,
    pub supports_on_update_cascade: bool,
    pub supports_on_delete_set_null: bool,
    pub supports_deferrable_constraints: bool,
    pub supports_array_type: bool,
    pub supports_json_type: bool,
    pub supports_enum_type: bool,
    pub supports_uuid_type: bool,
    pub supports_identity_columns: bool,
    pub supports_auto_increment: bool,
    pub supports_sequences: bool,
}

impl Default for DialectCapabilityDescriptor {
    fn default() -> Self {
        Self {
            dialect: DialectKind::Unsupported,
            flags: 0,
            max_identifier_length: 0,
            supports_schemas: false,
            supports_catalogs: false,
            max_columns_per_table: 0,
            max_indexes_per_table: 0,
            max_query_size_bytes: 0,
            supports_full_text_index: false,
            supports_spatial_index: false,
            supports_partitioning: false,
            supports_table_sampling: false,
            max_foreign_key_name_length: 0,
            supports_on_update_cascade: false,
            supports_on_delete_set_null: false,
            supports_deferrable_constraints: false,
            supports_array_type: false,
            supports_json_type: false,
            supports_enum_type: false,
            supports_uuid_type: false,
            supports_identity_columns: false,
            supports_auto_increment: false,
            supports_sequences: false,
        }
    }
}

impl DialectCapabilityDescriptor {
    pub fn has_capability(&self, flag: DdlCapabilityFlags) -> bool {
        self.flags & flag != 0
    }

    pub fn for_dialect(kind: DialectKind) -> Self {
        match kind {
            DialectKind::Mysql => Self {
                dialect: DialectKind::Mysql,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_ALTER_EXISTING_COLUMN
                    | CAP_REORDER_COLUMN
                    | CAP_COMMENT
                    | CAP_CREATE_INDEX
                    | CAP_DROP_INDEX
                    | CAP_REBUILD_INDEX
                    | CAP_INDEX_TYPE
                    | CAP_INDEX_COMMENT
                    | CAP_ALTER_PRIMARY_KEY
                    | CAP_FOREIGN_KEY
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_CREATE_TRIGGER
                    | CAP_DROP_TRIGGER
                    | CAP_CREATE_FUNCTION
                    | CAP_DROP_FUNCTION
                    | CAP_CREATE_SEQUENCE
                    | CAP_DROP_SEQUENCE
                    | CAP_ALTER_OWNER
                    | CAP_GRANT_REVOKE
                    | CAP_IF_NOT_EXISTS
                    | CAP_TEMPORARY_TABLE
                    | CAP_AUTO_INCREMENT,
                max_identifier_length: 64,
                max_columns_per_table: 4096,
                max_indexes_per_table: 64,
                max_query_size_bytes: 16 * 1024 * 1024,
                max_foreign_key_name_length: 64,
                supports_full_text_index: true,
                supports_spatial_index: true,
                supports_partitioning: true,
                supports_on_update_cascade: true,
                supports_on_delete_set_null: true,
                supports_json_type: true,
                supports_enum_type: true,
                supports_auto_increment: true,
                ..Default::default()
            },
            DialectKind::Postgres => Self {
                dialect: DialectKind::Postgres,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_ALTER_EXISTING_COLUMN
                    | CAP_COMMENT
                    | CAP_CREATE_INDEX
                    | CAP_DROP_INDEX
                    | CAP_REBUILD_INDEX
                    | CAP_INDEX_TYPE
                    | CAP_INDEX_INCLUDE
                    | CAP_INDEX_FILTER
                    | CAP_INDEX_COMMENT
                    | CAP_ALTER_PRIMARY_KEY
                    | CAP_FOREIGN_KEY
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_CREATE_TRIGGER
                    | CAP_DROP_TRIGGER
                    | CAP_CREATE_FUNCTION
                    | CAP_DROP_FUNCTION
                    | CAP_CREATE_SEQUENCE
                    | CAP_DROP_SEQUENCE
                    | CAP_ALTER_OWNER
                    | CAP_GRANT_REVOKE
                    | CAP_IF_NOT_EXISTS
                    | CAP_CREATE_OR_REPLACE
                    | CAP_TRANSACTIONAL_DDL
                    | CAP_TEMPORARY_TABLE
                    | CAP_IDENTITY_COLUMNS,
                max_identifier_length: 63,
                supports_schemas: true,
                max_columns_per_table: 1600,
                max_indexes_per_table: 100,
                max_query_size_bytes: 256 * 1024 * 1024,
                max_foreign_key_name_length: 63,
                supports_full_text_index: true,
                supports_spatial_index: true,
                supports_partitioning: true,
                supports_table_sampling: true,
                supports_on_update_cascade: true,
                supports_on_delete_set_null: true,
                supports_deferrable_constraints: true,
                supports_array_type: true,
                supports_json_type: true,
                supports_enum_type: true,
                supports_uuid_type: true,
                supports_identity_columns: true,
                supports_sequences: true,
                ..Default::default()
            },
            DialectKind::Sqlite => Self {
                dialect: DialectKind::Sqlite,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_CREATE_INDEX
                    | CAP_DROP_INDEX
                    | CAP_REBUILD_INDEX
                    | CAP_INDEX_FILTER
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_CREATE_TRIGGER
                    | CAP_DROP_TRIGGER
                    | CAP_CREATE_FUNCTION
                    | CAP_DROP_FUNCTION
                    | CAP_CREATE_SEQUENCE
                    | CAP_DROP_SEQUENCE
                    | CAP_IF_NOT_EXISTS
                    | CAP_AUTO_INCREMENT,
                max_identifier_length: 255,
                max_columns_per_table: 2000,
                max_indexes_per_table: 200,
                max_foreign_key_name_length: 255,
                supports_full_text_index: true,
                supports_on_update_cascade: true,
                supports_on_delete_set_null: true,
                supports_auto_increment: true,
                ..Default::default()
            },
            DialectKind::DuckDb => Self {
                dialect: DialectKind::DuckDb,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_CREATE_INDEX
                    | CAP_DROP_INDEX
                    | CAP_REBUILD_INDEX
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_IF_NOT_EXISTS
                    | CAP_CREATE_OR_REPLACE
                    | CAP_TEMPORARY_TABLE,
                max_identifier_length: 255,
                supports_schemas: true,
                max_columns_per_table: 1600,
                max_indexes_per_table: 100,
                max_query_size_bytes: 256 * 1024 * 1024,
                max_foreign_key_name_length: 255,
                supports_spatial_index: true,
                supports_partitioning: true,
                supports_table_sampling: true,
                supports_on_update_cascade: true,
                supports_on_delete_set_null: true,
                supports_array_type: true,
                supports_json_type: true,
                supports_enum_type: true,
                supports_uuid_type: true,
                supports_sequences: true,
                ..Default::default()
            },
            DialectKind::SqlServer => Self {
                dialect: DialectKind::SqlServer,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_ALTER_EXISTING_COLUMN
                    | CAP_COMMENT
                    | CAP_CREATE_INDEX
                    | CAP_DROP_INDEX
                    | CAP_REBUILD_INDEX
                    | CAP_INDEX_TYPE
                    | CAP_INDEX_INCLUDE
                    | CAP_INDEX_FILTER
                    | CAP_INDEX_COMMENT
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_CREATE_TRIGGER
                    | CAP_DROP_TRIGGER
                    | CAP_CREATE_FUNCTION
                    | CAP_DROP_FUNCTION
                    | CAP_CREATE_SEQUENCE
                    | CAP_DROP_SEQUENCE
                    | CAP_ALTER_OWNER
                    | CAP_GRANT_REVOKE
                    | CAP_IF_NOT_EXISTS
                    | CAP_TEMPORARY_TABLE
                    | CAP_TRANSACTIONAL_DDL
                    | CAP_IDENTITY_COLUMNS,
                max_identifier_length: 128,
                supports_schemas: true,
                supports_catalogs: true,
                max_columns_per_table: 1024,
                max_indexes_per_table: 999,
                max_query_size_bytes: 65_536 * 4_096,
                max_foreign_key_name_length: 128,
                supports_full_text_index: true,
                supports_spatial_index: true,
                supports_partitioning: true,
                supports_table_sampling: true,
                supports_on_update_cascade: true,
                supports_on_delete_set_null: true,
                supports_json_type: true,
                supports_uuid_type: true,
                supports_identity_columns: true,
                supports_sequences: true,
                ..Default::default()
            },
            DialectKind::Oracle => Self {
                dialect: DialectKind::Oracle,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_ALTER_EXISTING_COLUMN
                    | CAP_COMMENT
                    | CAP_CREATE_INDEX
                    | CAP_DROP_INDEX
                    | CAP_REBUILD_INDEX
                    | CAP_INDEX_TYPE
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_CREATE_TRIGGER
                    | CAP_DROP_TRIGGER
                    | CAP_CREATE_FUNCTION
                    | CAP_DROP_FUNCTION
                    | CAP_CREATE_SEQUENCE
                    | CAP_DROP_SEQUENCE
                    | CAP_ALTER_OWNER
                    | CAP_GRANT_REVOKE
                    | CAP_IF_NOT_EXISTS
                    | CAP_TEMPORARY_TABLE,
                max_identifier_length: 30,
                supports_schemas: true,
                max_columns_per_table: 1000,
                max_indexes_per_table: 100,
                max_query_size_bytes: 64 * 1024,
                max_foreign_key_name_length: 30,
                supports_full_text_index: true,
                supports_spatial_index: true,
                supports_partitioning: true,
                supports_table_sampling: true,
                supports_on_update_cascade: true,
                supports_on_delete_set_null: true,
                supports_deferrable_constraints: true,
                supports_json_type: true,
                supports_identity_columns: true,
                supports_sequences: true,
                ..Default::default()
            },
            DialectKind::H2 => Self {
                dialect: DialectKind::H2,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_ALTER_EXISTING_COLUMN
                    | CAP_COMMENT
                    | CAP_CREATE_INDEX
                    | CAP_DROP_INDEX
                    | CAP_REBUILD_INDEX
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_CREATE_TRIGGER
                    | CAP_DROP_TRIGGER
                    | CAP_CREATE_FUNCTION
                    | CAP_DROP_FUNCTION
                    | CAP_IF_NOT_EXISTS
                    | CAP_TEMPORARY_TABLE
                    | CAP_IDENTITY_COLUMNS,
                max_identifier_length: 256,
                supports_schemas: true,
                max_columns_per_table: 1600,
                max_indexes_per_table: 100,
                max_query_size_bytes: 128 * 1024,
                max_foreign_key_name_length: 256,
                supports_full_text_index: true,
                supports_spatial_index: true,
                supports_on_update_cascade: true,
                supports_on_delete_set_null: true,
                supports_deferrable_constraints: true,
                supports_json_type: true,
                supports_uuid_type: true,
                supports_identity_columns: true,
                supports_sequences: true,
                ..Default::default()
            },
            DialectKind::ClickHouse => Self {
                dialect: DialectKind::ClickHouse,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_ALTER_EXISTING_COLUMN
                    | CAP_REORDER_COLUMN
                    | CAP_COMMENT
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_IF_NOT_EXISTS
                    | CAP_TEMPORARY_TABLE,
                max_identifier_length: 256,
                supports_schemas: true,
                max_columns_per_table: 1000,
                max_query_size_bytes: 256 * 1024 * 1024,
                max_foreign_key_name_length: 256,
                supports_full_text_index: true,
                supports_partitioning: true,
                supports_table_sampling: true,
                supports_array_type: true,
                supports_json_type: true,
                supports_enum_type: true,
                supports_uuid_type: true,
                ..Default::default()
            },
            DialectKind::ManticoreSearch => Self {
                dialect: DialectKind::ManticoreSearch,
                flags: CAP_ADD_COLUMN | CAP_DROP_COLUMN | CAP_CREATE_TABLE | CAP_DROP_TABLE | CAP_TRUNCATE_TABLE,
                max_identifier_length: 256,
                max_columns_per_table: 512,
                max_query_size_bytes: 16 * 1024 * 1024,
                supports_full_text_index: true,
                supports_spatial_index: true,
                supports_json_type: true,
                supports_auto_increment: true,
                ..Default::default()
            },
            DialectKind::Informix => Self {
                dialect: DialectKind::Informix,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_ALTER_EXISTING_COLUMN
                    | CAP_CREATE_INDEX
                    | CAP_DROP_INDEX
                    | CAP_REBUILD_INDEX
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_CREATE_TRIGGER
                    | CAP_DROP_TRIGGER
                    | CAP_GRANT_REVOKE,
                max_identifier_length: 128,
                supports_schemas: true,
                max_columns_per_table: 32767,
                max_indexes_per_table: 200,
                max_query_size_bytes: 2 * 1024 * 1024,
                max_foreign_key_name_length: 128,
                supports_partitioning: true,
                supports_on_delete_set_null: true,
                supports_deferrable_constraints: true,
                supports_sequences: true,
                ..Default::default()
            },
            DialectKind::Questdb => Self {
                dialect: DialectKind::Questdb,
                flags: CAP_ADD_COLUMN
                    | CAP_DROP_COLUMN
                    | CAP_RENAME_COLUMN
                    | CAP_ALTER_EXISTING_COLUMN
                    | CAP_CREATE_TABLE
                    | CAP_DROP_TABLE
                    | CAP_TRUNCATE_TABLE
                    | CAP_IF_NOT_EXISTS,
                max_identifier_length: 256,
                max_columns_per_table: 1024,
                max_query_size_bytes: 64 * 1024,
                supports_partitioning: true,
                ..Default::default()
            },
            DialectKind::Unsupported => Self::default(),
        }
    }

    pub fn capabilities_for_database_type(db_type: DatabaseType) -> Self {
        crate::sql_dialect::resolve_for_db(db_type)
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TypeConversionRule {
    pub source_type: String,
    pub target_type: String,
    pub precision_loss: bool,
    pub requires_cast: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TypeMappingMatrix {
    pub from: DialectKind,
    pub to: DialectKind,
    pub rules: Vec<TypeConversionRule>,
}

impl TypeMappingMatrix {
    pub fn for_dialects(from: DialectKind, to: DialectKind) -> Self {
        let rules = Self::build_rules(from, to);
        Self { from, to, rules }
    }

    fn build_rules(from: DialectKind, to: DialectKind) -> Vec<TypeConversionRule> {
        let mut rules = Vec::new();
        match (from, to) {
            (DialectKind::Mysql, DialectKind::Postgres) => {
                rules.push(TypeConversionRule {
                    source_type: "TINYINT(1)".into(),
                    target_type: "BOOLEAN".into(),
                    precision_loss: false,
                    requires_cast: true,
                });
                rules.push(TypeConversionRule {
                    source_type: "TINYINT".into(),
                    target_type: "SMALLINT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "MEDIUMINT".into(),
                    target_type: "INTEGER".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "INT".into(),
                    target_type: "INTEGER".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "BIGINT".into(),
                    target_type: "BIGINT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "FLOAT".into(),
                    target_type: "REAL".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "DOUBLE".into(),
                    target_type: "DOUBLE PRECISION".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "TINYTEXT".into(),
                    target_type: "TEXT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "TEXT".into(),
                    target_type: "TEXT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "MEDIUMTEXT".into(),
                    target_type: "TEXT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "LONGTEXT".into(),
                    target_type: "TEXT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "BLOB".into(),
                    target_type: "BYTEA".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "TINYBLOB".into(),
                    target_type: "BYTEA".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "MEDIUMBLOB".into(),
                    target_type: "BYTEA".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "LONGBLOB".into(),
                    target_type: "BYTEA".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "DATETIME".into(),
                    target_type: "TIMESTAMP".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
            }
            (DialectKind::Postgres, DialectKind::Mysql) => {
                rules.push(TypeConversionRule {
                    source_type: "SMALLINT".into(),
                    target_type: "SMALLINT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "INTEGER".into(),
                    target_type: "INT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "BIGINT".into(),
                    target_type: "BIGINT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "REAL".into(),
                    target_type: "FLOAT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "DOUBLE PRECISION".into(),
                    target_type: "DOUBLE".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "TEXT".into(),
                    target_type: "LONGTEXT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "BYTEA".into(),
                    target_type: "BLOB".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "BOOLEAN".into(),
                    target_type: "TINYINT(1)".into(),
                    precision_loss: false,
                    requires_cast: true,
                });
                rules.push(TypeConversionRule {
                    source_type: "TIMESTAMP".into(),
                    target_type: "DATETIME".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "TIMESTAMPTZ".into(),
                    target_type: "DATETIME".into(),
                    precision_loss: true,
                    requires_cast: true,
                });
                rules.push(TypeConversionRule {
                    source_type: "UUID".into(),
                    target_type: "CHAR(36)".into(),
                    precision_loss: false,
                    requires_cast: true,
                });
                rules.push(TypeConversionRule {
                    source_type: "JSONB".into(),
                    target_type: "JSON".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
            }
            (DialectKind::Mysql, DialectKind::Sqlite) => {
                rules.push(TypeConversionRule {
                    source_type: "INT".into(),
                    target_type: "INTEGER".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "BIGINT".into(),
                    target_type: "INTEGER".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "TINYINT".into(),
                    target_type: "INTEGER".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "SMALLINT".into(),
                    target_type: "INTEGER".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "MEDIUMINT".into(),
                    target_type: "INTEGER".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "DOUBLE".into(),
                    target_type: "REAL".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "FLOAT".into(),
                    target_type: "REAL".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "DATETIME".into(),
                    target_type: "TEXT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "TIMESTAMP".into(),
                    target_type: "TEXT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "TEXT".into(),
                    target_type: "TEXT".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
                rules.push(TypeConversionRule {
                    source_type: "BLOB".into(),
                    target_type: "BLOB".into(),
                    precision_loss: false,
                    requires_cast: false,
                });
            }
            _ => {}
        }
        rules
    }

    pub fn convert_type(&self, source_type: &str) -> (String, bool) {
        let trimmed = source_type.trim().to_ascii_uppercase();

        for rule in &self.rules {
            if trimmed == rule.source_type {
                return (rule.target_type.clone(), rule.requires_cast);
            }
            if trimmed.starts_with(&rule.source_type) {
                let remaining = trimmed.trim_start_matches(&rule.source_type);
                if remaining.is_empty() || remaining.starts_with(' ') || remaining.starts_with('(') {
                    return (rule.target_type.clone(), rule.requires_cast);
                }
            }
        }

        (source_type.to_string(), true)
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DialectInfo {
    pub kind: DialectKind,
    pub label: String,
    pub capabilities: Vec<String>,
    pub max_identifier_length: u32,
    pub supports_schemas: bool,
    pub supports_catalogs: bool,
    pub max_columns_per_table: u32,
    pub supports_json_type: bool,
    pub supports_array_type: bool,
    pub supports_enum_type: bool,
    pub supports_uuid_type: bool,
    pub supports_auto_increment: bool,
    pub supports_identity_columns: bool,
    pub supports_sequences: bool,
    pub supports_partitioning: bool,
    pub supports_full_text_index: bool,
    pub supports_spatial_index: bool,
    pub supports_transactional_ddl: bool,
}

impl From<DialectCapabilityDescriptor> for DialectInfo {
    fn from(caps: DialectCapabilityDescriptor) -> Self {
        Self {
            kind: caps.dialect,
            label: caps.dialect.label().to_string(),
            capabilities: CAP_NAMES
                .iter()
                .filter(|(flag, _)| caps.has_capability(*flag))
                .map(|(_, name)| name.to_string())
                .collect(),
            max_identifier_length: caps.max_identifier_length,
            supports_schemas: caps.supports_schemas,
            supports_catalogs: caps.supports_catalogs,
            max_columns_per_table: caps.max_columns_per_table,
            supports_json_type: caps.supports_json_type,
            supports_array_type: caps.supports_array_type,
            supports_enum_type: caps.supports_enum_type,
            supports_uuid_type: caps.supports_uuid_type,
            supports_auto_increment: caps.supports_auto_increment,
            supports_identity_columns: caps.supports_identity_columns,
            supports_sequences: caps.supports_sequences,
            supports_partitioning: caps.supports_partitioning,
            supports_full_text_index: caps.supports_full_text_index,
            supports_spatial_index: caps.supports_spatial_index,
            supports_transactional_ddl: caps.has_capability(CAP_TRANSACTIONAL_DDL),
        }
    }
}

impl DialectInfo {
    pub fn for_kind(kind: DialectKind) -> Self {
        let caps = crate::sql_dialect::resolve(kind);
        Self::from(caps)
    }

    pub fn all() -> Vec<Self> {
        use DialectKind::*;
        vec![Mysql, Postgres, Sqlite, DuckDb, SqlServer, Oracle, H2, ClickHouse, ManticoreSearch, Informix, Questdb]
            .into_iter()
            .map(Self::for_kind)
            .collect()
    }
}

pub fn dialect_check(kind: DialectKind) -> DialectInfo {
    DialectInfo::for_kind(kind)
}

pub fn dialect_check_all() -> Vec<DialectInfo> {
    DialectInfo::all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialect_kind_from_database_type_roundtrip() {
        let test_cases = vec![
            (DatabaseType::Mysql, DialectKind::Mysql),
            (DatabaseType::Postgres, DialectKind::Postgres),
            (DatabaseType::Sqlite, DialectKind::Sqlite),
            (DatabaseType::DuckDb, DialectKind::DuckDb),
            (DatabaseType::SqlServer, DialectKind::SqlServer),
            (DatabaseType::Oracle, DialectKind::Oracle),
            (DatabaseType::H2, DialectKind::H2),
            (DatabaseType::ClickHouse, DialectKind::ClickHouse),
            (DatabaseType::ManticoreSearch, DialectKind::ManticoreSearch),
            (DatabaseType::Informix, DialectKind::Informix),
            (DatabaseType::Questdb, DialectKind::Questdb),
            (DatabaseType::Redis, DialectKind::Unsupported),
            (DatabaseType::MongoDb, DialectKind::Unsupported),
        ];
        for (db_type, expected) in test_cases {
            assert_eq!(DialectKind::from_database_type(db_type), expected, "Mismatch for {db_type:?}");
        }
    }

    #[test]
    fn dialect_kind_to_database_type_roundtrip() {
        for kind in &[
            DialectKind::Mysql,
            DialectKind::Postgres,
            DialectKind::Sqlite,
            DialectKind::DuckDb,
            DialectKind::SqlServer,
            DialectKind::Oracle,
            DialectKind::H2,
            DialectKind::ClickHouse,
            DialectKind::ManticoreSearch,
            DialectKind::Informix,
            DialectKind::Questdb,
        ] {
            let db_type = kind.to_database_type().unwrap();
            let back = DialectKind::from_database_type(db_type);
            assert_eq!(*kind, back, "Roundtrip failed for {kind:?}");
        }
        assert_eq!(DialectKind::Unsupported.to_database_type(), None);
    }

    #[test]
    fn dialect_capability_descriptor_for_all_kinds() {
        for kind in &[
            DialectKind::Mysql,
            DialectKind::Postgres,
            DialectKind::Sqlite,
            DialectKind::DuckDb,
            DialectKind::SqlServer,
            DialectKind::Oracle,
            DialectKind::H2,
            DialectKind::ClickHouse,
            DialectKind::ManticoreSearch,
            DialectKind::Informix,
            DialectKind::Questdb,
            DialectKind::Unsupported,
        ] {
            let desc = DialectCapabilityDescriptor::for_dialect(*kind);
            assert_eq!(desc.dialect, *kind);
        }
    }

    #[test]
    fn mysql_capabilities_match_capabilities_for() {
        let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Mysql);
        assert!(desc.has_capability(CAP_ADD_COLUMN));
        assert!(desc.has_capability(CAP_DROP_COLUMN));
        assert!(desc.has_capability(CAP_RENAME_COLUMN));
        assert!(desc.has_capability(CAP_FOREIGN_KEY));
        assert!(desc.supports_auto_increment);
        assert!(desc.supports_json_type);
        assert!(desc.supports_enum_type);
        assert!(!desc.supports_schemas);
        assert!(!desc.supports_identity_columns);
    }

    #[test]
    fn postgres_capabilities() {
        let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Postgres);
        assert!(desc.has_capability(CAP_ADD_COLUMN));
        assert!(desc.has_capability(CAP_FOREIGN_KEY));
        assert!(desc.has_capability(CAP_INDEX_INCLUDE));
        assert!(desc.has_capability(CAP_INDEX_FILTER));
        assert!(desc.has_capability(CAP_TRANSACTIONAL_DDL));
        assert!(desc.supports_schemas);
        assert!(desc.supports_array_type);
        assert!(desc.supports_json_type);
        assert!(desc.supports_enum_type);
        assert!(desc.supports_uuid_type);
        assert!(desc.supports_sequences);
        assert!(!desc.supports_auto_increment);
        assert_eq!(desc.max_identifier_length, 63);
    }

    #[test]
    fn mysql_to_postgres_type_mapping() {
        let matrix = TypeMappingMatrix::for_dialects(DialectKind::Mysql, DialectKind::Postgres);
        assert_eq!(matrix.convert_type("INT"), ("INTEGER".to_string(), false));
        assert_eq!(matrix.convert_type("TINYINT"), ("SMALLINT".to_string(), false));
        assert_eq!(matrix.convert_type("BIGINT"), ("BIGINT".to_string(), false));
        assert_eq!(matrix.convert_type("BLOB"), ("BYTEA".to_string(), false));
        assert_eq!(matrix.convert_type("DATETIME"), ("TIMESTAMP".to_string(), false));
        assert_eq!(matrix.convert_type("TEXT"), ("TEXT".to_string(), false));
        assert!(matrix.convert_type("TINYINT(1)").1);
    }

    #[test]
    fn postgres_to_mysql_type_mapping() {
        let matrix = TypeMappingMatrix::for_dialects(DialectKind::Postgres, DialectKind::Mysql);
        assert_eq!(matrix.convert_type("INTEGER"), ("INT".to_string(), false));
        assert_eq!(matrix.convert_type("BIGINT"), ("BIGINT".to_string(), false));
        assert_eq!(matrix.convert_type("TEXT"), ("LONGTEXT".to_string(), false));
        assert_eq!(matrix.convert_type("BYTEA"), ("BLOB".to_string(), false));
        assert_eq!(matrix.convert_type("BOOLEAN"), ("TINYINT(1)".to_string(), true));
        assert_eq!(matrix.convert_type("UUID"), ("CHAR(36)".to_string(), true));
    }

    #[test]
    fn mysql_to_sqlite_type_mapping() {
        let matrix = TypeMappingMatrix::for_dialects(DialectKind::Mysql, DialectKind::Sqlite);
        assert_eq!(matrix.convert_type("INT"), ("INTEGER".to_string(), false));
        assert_eq!(matrix.convert_type("BIGINT"), ("INTEGER".to_string(), false));
        assert_eq!(matrix.convert_type("TEXT"), ("TEXT".to_string(), false));
        let (result, lossy) = matrix.convert_type("VARCHAR(255)");
        assert_eq!(result, "VARCHAR(255)");
        assert!(lossy);
    }

    #[test]
    fn type_mapping_unknown_type_passthrough() {
        let matrix = TypeMappingMatrix::for_dialects(DialectKind::Mysql, DialectKind::Postgres);
        let (result, lossy) = matrix.convert_type("GEOGRAPHY");
        assert_eq!(result, "GEOGRAPHY");
        assert!(lossy);
    }

    #[test]
    fn dialect_kind_label() {
        assert_eq!(DialectKind::Mysql.label(), "mysql");
        assert_eq!(DialectKind::Postgres.label(), "postgres");
        assert_eq!(DialectKind::Unsupported.label(), "unsupported");
    }

    #[test]
    fn unsupported_capabilities_are_all_false() {
        let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Unsupported);
        assert_eq!(desc.flags, 0);
        assert!(!desc.supports_schemas);
        assert!(!desc.supports_partitioning);
    }
}
