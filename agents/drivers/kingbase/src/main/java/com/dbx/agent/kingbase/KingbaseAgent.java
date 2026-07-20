package com.dbx.agent.kingbase;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.MetadataSqlSupport;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.PostgresLikeAgent;
import com.dbx.agent.PostgresLikeAgentProfile;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class KingbaseAgent extends PostgresLikeAgent {
    private static final int TRIGGER_TYPE_BEFORE = 1 << 1;
    private static final int TRIGGER_TYPE_INSTEAD = 1 << 6;
    private static final int KINGBASE_VOID_TYPE_OID = 2278;
    private static final String KINGBASE_REL_NAME = "CAST(c.relname AS varchar(256))";
    private static final String KINGBASE_REL_OID = "CAST(c.oid AS varchar(64))";
    private static final String KINGBASE_REL_NAMESPACE = "CAST(c.relnamespace AS varchar(64))";
    private static final String KINGBASE_REL_OWNER = "c.relowner";
    private static final String KINGBASE_SCHEMA_NAME = "CAST(n.nspname AS varchar(256))";
    private static final String KINGBASE_NAMESPACE_OID = "CAST(n.oid AS varchar(64))";
    private static final String KINGBASE_DESCRIPTION = "CAST(d.description AS varchar(4000))";
    private static final String KINGBASE_ROUTINE_NAME = "CAST(p.proname AS varchar(256))";
    private static final String KINGBASE_ROUTINE_OID = "CAST(p.oid AS varchar(64))";
    private static final String KINGBASE_ROUTINE_NAMESPACE = "CAST(p.pronamespace AS varchar(64))";
    private static final String KINGBASE_VIEW_NAME = "CAST(v.viewname AS varchar(256))";
    private static final String KINGBASE_VIEW_SCHEMA = "CAST(v.schemaname AS varchar(256))";
    private static final String KINGBASE_MATVIEW_NAME = "CAST(mv.matviewname AS varchar(256))";
    private static final String KINGBASE_MATVIEW_SCHEMA = "CAST(mv.schemaname AS varchar(256))";
    private static final Pattern BOUNDED_VARCHAR_TYPE = Pattern.compile(
        "^(?:varchar|character\\s+varying)\\s*\\(\\s*(\\d+)\\s*\\)$",
        Pattern.CASE_INSENSITIVE
    );
    private boolean postgresCatalogMode;
    private boolean sqlServerIdentityCatalogMode;

    public static final PostgresLikeAgentProfile KINGBASE_PROFILE = new PostgresLikeAgentProfile(
        "com.kingbase8.Driver",
        "jdbc:kingbase8://{host}:{port}/{database}"
    );

    public KingbaseAgent() {
        super(KINGBASE_PROFILE);
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        postgresCatalogMode = false;
        sqlServerIdentityCatalogMode = false;
        setMysqlCompatMode(params.isMysql_compat_mode());
        if (params.isMysql_compat_mode()) {
            return;
        }
        postgresCatalogMode = !catalogExists(connection, "sys_catalog.sys_namespace")
            && catalogExists(connection, "pg_catalog.pg_namespace");
        if (!postgresCatalogMode && detectMysqlCompatMode(connection)) {
            setMysqlCompatMode(true);
        }
        // SQLServer compatibility exposes identity metadata through this catalog only.
        sqlServerIdentityCatalogMode = !postgresCatalogMode
            && !isMysqlCompatMode()
            && catalogExists(connection, "sys.identity_columns");
    }

    private static boolean detectMysqlCompatMode(Connection connection) {
        try (Statement stmt = connection.createStatement();
             ResultSet rs = stmt.executeQuery(
                 "SELECT setting FROM sys_catalog.sys_settings WHERE LOWER(name) = 'database_mode'"
             )) {
            if (rs.next()) {
                return "mysql".equalsIgnoreCase(rs.getString(1));
            }
        } catch (Exception ignored) {
            // Older Kingbase versions do not expose database_mode.
        }
        return mysqlSqlModeExists(connection);
    }

    private static boolean mysqlSqlModeExists(Connection connection) {
        try (Statement stmt = connection.createStatement();
             ResultSet rs = stmt.executeQuery("SELECT 1 FROM sys_catalog.sys_settings WHERE LOWER(name) = 'sql_mode'")) {
            return rs.next();
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean catalogExists(Connection connection, String catalog) {
        try (Statement stmt = connection.createStatement();
             ResultSet ignored = stmt.executeQuery("SELECT 1 FROM " + catalog + " WHERE 1 = 0")) {
            return true;
        } catch (Exception ignored) {
            // Kingbase compatibility modes expose different catalog families.
            return false;
        }
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        if (postgresCatalogMode) return super.listDatabases();
        return unchecked(() -> {
            for (String sql : List.of(
                "SELECT datname AS database_name FROM sys_catalog.sys_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname",
                "SELECT datname AS database_name FROM pg_catalog.pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname"
            )) {
                try {
                    List<DatabaseInfo> result = queryDatabases(sql);
                    if (!result.isEmpty()) return result;
                } catch (Exception ignored) {
                    // Kingbase catalog names differ across compatibility modes and versions.
                }
            }
            if (isMysqlCompatMode()) {
                try {
                    List<DatabaseInfo> result = queryDatabases("SELECT current_database() AS database_name");
                    if (!result.isEmpty()) return result;
                } catch (Exception ignored) {
                    // Keep the configured database as the final fallback if current_database() is unavailable.
                }
            }
            return Collections.singletonList(new DatabaseInfo(getConfiguredDatabase()));
        });
    }

    private List<DatabaseInfo> queryDatabases(String sql) throws Exception {
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql);
             ResultSet rs = stmt.executeQuery()) {
            List<DatabaseInfo> result = new ArrayList<>();
            while (rs.next()) {
                result.add(new DatabaseInfo(rs.getString("database_name")));
            }
            return result;
        }
    }

    @Override
    public List<String> listSchemas() {
        if (postgresCatalogMode) return super.listSchemas();
        return unchecked(() -> {
            List<String> result = new ArrayList<>();
            String sql = isMysqlCompatMode()
                ? "SELECT schema_name " +
                    "FROM information_schema.schemata " +
                    "WHERE UPPER(schema_name) <> 'INFORMATION_SCHEMA' " +
                    "AND UPPER(schema_name) NOT LIKE 'SYS%' " +
                    "AND UPPER(schema_name) NOT LIKE 'XLOG%' " +
                    "ORDER BY schema_name"
                : "SELECT nspname AS schema_name " +
                    "FROM sys_catalog.sys_namespace " +
                    "WHERE nspname NOT LIKE 'sys_temp_%' " +
                    "AND nspname NOT LIKE 'sys_toast_temp_%' " +
                    "ORDER BY nspname";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql);
                 ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.add(rs.getString("schema_name"));
                }
            }
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        if (postgresCatalogMode) return super.listTables(schema);
        if (isMysqlCompatMode()) {
            return queryMysqlCompatTables(schema, MetadataListConstraints.NONE);
        }
        return queryRegularTables(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        if (postgresCatalogMode) return super.listTables(schema, constraints);
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (isUnconstrained(normalized)) {
            return listTables(schema);
        }
        if (!normalized.includesTableLikeTypes()) {
            return List.of();
        }
        try {
            return isMysqlCompatMode()
                ? queryMysqlCompatTables(schema, normalized)
                : queryRegularTables(schema, normalized);
        } catch (RuntimeException e) {
            return normalized.filterTables(listTables(schema));
        }
    }

    private List<TableInfo> queryRegularTables(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            List<String> branches = new ArrayList<>();
            addRegularRelationBranches(branches, args, effectiveSchema(schema), constraints, "table_name", "table_type", "table_comment");
            if (branches.isEmpty()) {
                return List.of();
            }
            StringBuilder sql = new StringBuilder("SELECT table_name, table_type, table_comment FROM (")
                .append(String.join(" UNION ALL ", branches))
                .append(") metadata_tables ORDER BY table_name");
            MetadataSqlSupport.appendLiteralLimitOffset(sql, constraints);
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            rs.getString("table_name"),
                            normalizeTableType(rs.getString("table_type")),
                            rs.getString("table_comment")
                        ));
                    }
                }
            }
            return constraints.withoutPaging().filterTables(result);
        });
    }

    private List<TableInfo> queryMysqlCompatTables(String schema, MetadataListConstraints constraints) {
        try {
            return queryMysqlCompatInformationSchemaTables(schema, constraints);
        } catch (RuntimeException error) {
            if (!isSysFreespacePermissionError(error)) {
                throw error;
            }
            return queryMysqlCompatCatalogTables(schema, constraints);
        }
    }

    private List<TableInfo> queryMysqlCompatInformationSchemaTables(
        String schema,
        MetadataListConstraints constraints
    ) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            StringBuilder sql = new StringBuilder("SELECT t.table_name, t.table_type, ")
                .append(KINGBASE_DESCRIPTION).append(" AS table_comment ")
                .append("FROM information_schema.tables t ")
                .append("LEFT JOIN sys_catalog.sys_namespace n ON ").append(KINGBASE_SCHEMA_NAME)
                .append(" = CAST(t.table_schema AS varchar(256)) ")
                .append("LEFT JOIN sys_catalog.sys_class c ON ").append(KINGBASE_REL_NAMESPACE)
                .append(" = ").append(KINGBASE_NAMESPACE_OID)
                .append(" AND ").append(KINGBASE_REL_NAME).append(" = CAST(t.table_name AS varchar(256)) ")
                .append("LEFT JOIN sys_catalog.sys_description d ON CAST(d.objoid AS varchar(64)) = ")
                .append(KINGBASE_REL_OID).append(" AND d.objsubid = 0 ")
                .append("WHERE t.table_schema = ").append(sqlString(effectiveSchema(schema)));
            appendMysqlCompatTableTypePredicate(sql, args, constraints);
            MetadataSqlSupport.appendNameFilter(sql, args, "t.table_name", constraints);
            sql.append(" ORDER BY t.table_name");
            MetadataSqlSupport.appendLiteralLimitOffset(sql, constraints);
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString(1), normalizeTableType(rs.getString(2)), rs.getString(3)));
                    }
                }
            }
            return constraints.withoutPaging().filterTables(result);
        });
    }

    private List<TableInfo> queryMysqlCompatCatalogTables(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            StringBuilder sql = new StringBuilder("SELECT ")
                .append(KINGBASE_REL_NAME).append(" AS table_name, ")
                .append("CASE WHEN CAST(c.relkind AS varchar(16)) IN ('r', 'p') THEN 'TABLE' ELSE 'VIEW' END AS table_type, ")
                .append(KINGBASE_DESCRIPTION).append(" AS table_comment ")
                .append("FROM sys_catalog.sys_class c ")
                .append("JOIN sys_catalog.sys_namespace n ON ").append(KINGBASE_NAMESPACE_OID).append(" = ").append(KINGBASE_REL_NAMESPACE).append(' ')
                .append("LEFT JOIN sys_catalog.sys_description d ON CAST(d.objoid AS varchar(64)) = ").append(KINGBASE_REL_OID).append(" AND d.objsubid = 0 ")
                .append("WHERE ").append(KINGBASE_SCHEMA_NAME).append(" = ").append(sqlString(effectiveSchema(schema)));
            appendMysqlCompatCatalogTypePredicate(sql, constraints);
            appendRelationVisibilityPredicate(sql);
            MetadataSqlSupport.appendNameFilter(sql, args, KINGBASE_REL_NAME, constraints);
            sql.append(" ORDER BY ").append(KINGBASE_REL_NAME);
            MetadataSqlSupport.appendLiteralLimitOffset(sql, constraints);
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            rs.getString("table_name"),
                            normalizeTableType(rs.getString("table_type")),
                            rs.getString("table_comment")
                        ));
                    }
                }
            }
            return constraints.withoutPaging().filterTables(result);
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        if (postgresCatalogMode) return super.listObjects(schema);
        return unchecked(() -> {
            String effectiveSchema = effectiveSchema(schema);
            List<ObjectInfo> result = new ArrayList<>();
            for (TableInfo table : listTables(effectiveSchema)) {
                result.add(new ObjectInfo(table.getName(), table.getTable_type(), effectiveSchema, table.getComment()));
            }
            if (isMysqlCompatMode()) {
                return result;
            }

            String sql = "SELECT " + KINGBASE_ROUTINE_NAME + " AS routine_name, " +
                "CASE WHEN p.prorettype = " + KINGBASE_VOID_TYPE_OID + " THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type, " +
                KINGBASE_DESCRIPTION + " AS routine_comment " +
                "FROM sys_catalog.sys_proc p " +
                "JOIN sys_catalog.sys_namespace n ON " + KINGBASE_NAMESPACE_OID + " = " + KINGBASE_ROUTINE_NAMESPACE + " " +
                "LEFT JOIN sys_catalog.sys_description d ON CAST(d.objoid AS varchar(64)) = " + KINGBASE_ROUTINE_OID + " AND d.objsubid = 0 " +
                "WHERE " + KINGBASE_SCHEMA_NAME + " = " + sqlString(effectiveSchema) + " " +
                "ORDER BY " + KINGBASE_ROUTINE_NAME;
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(
                            rs.getString("routine_name"),
                            rs.getString("routine_type"),
                            effectiveSchema,
                            rs.getString("routine_comment")
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        if (postgresCatalogMode) return super.listObjects(schema, constraints);
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (isUnconstrained(normalized)) {
            return listObjects(schema);
        }
        if (!includesSupportedObjects(normalized)) {
            return List.of();
        }
        try {
            return isMysqlCompatMode()
                ? normalized.filterObjects(toObjects(queryMysqlCompatTables(schema, normalized), effectiveSchema(schema)))
                : queryRegularObjects(schema, normalized);
        } catch (RuntimeException e) {
            return normalized.filterObjects(listObjects(schema));
        }
    }

    private List<ObjectInfo> queryRegularObjects(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            String effectiveSchema = effectiveSchema(schema);
            List<ObjectInfo> result = new ArrayList<>();
            List<String> branches = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            if (constraints.includesTableLikeTypes()) {
                addRegularRelationBranches(branches, args, effectiveSchema, constraints, "object_name", "object_type", "object_comment");
            }
            if (constraints.objectTypeAllowed("PROCEDURE") || constraints.objectTypeAllowed("FUNCTION")) {
                StringBuilder routineSql = new StringBuilder("SELECT ")
                    .append(KINGBASE_ROUTINE_NAME).append(" AS object_name, ")
                    .append("CASE WHEN p.prorettype = ").append(KINGBASE_VOID_TYPE_OID).append(" THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, ")
                    .append(KINGBASE_DESCRIPTION).append(" AS object_comment ")
                    .append("FROM sys_catalog.sys_proc p ")
                    .append("JOIN sys_catalog.sys_namespace n ON ").append(KINGBASE_NAMESPACE_OID).append(" = ").append(KINGBASE_ROUTINE_NAMESPACE).append(' ')
                    .append("LEFT JOIN sys_catalog.sys_description d ON CAST(d.objoid AS varchar(64)) = ").append(KINGBASE_ROUTINE_OID).append(" AND d.objsubid = 0 ")
                    .append("WHERE ").append(KINGBASE_SCHEMA_NAME).append(" = ").append(sqlString(effectiveSchema));
                appendRoutineKindPredicate(routineSql, args, constraints);
                MetadataSqlSupport.appendNameFilter(routineSql, args, KINGBASE_ROUTINE_NAME, constraints);
                branches.add(routineSql.toString());
            }
            if (branches.isEmpty()) {
                return List.of();
            }
            StringBuilder sql = new StringBuilder("SELECT object_name, object_type, object_comment FROM (")
                .append(String.join(" UNION ALL ", branches))
                .append(") metadata_objects ORDER BY CASE object_type WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'MATERIALIZED_VIEW' THEN 2 WHEN 'FOREIGN_TABLE' THEN 3 WHEN 'PROCEDURE' THEN 4 WHEN 'FUNCTION' THEN 5 ELSE 9 END, object_name");
            MetadataSqlSupport.appendLiteralLimitOffset(sql, constraints);
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(
                            rs.getString("object_name"),
                            rs.getString("object_type"),
                            effectiveSchema,
                            rs.getString("object_comment")
                        ));
                    }
                }
            }
            return constraints.withoutPaging().filterObjects(result);
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        if (postgresCatalogMode) return super.getObjectSource(schema, name, objectType);
        if ("FUNCTION".equalsIgnoreCase(objectType) || "PROCEDURE".equalsIgnoreCase(objectType)) {
            return routineSource(schema, name, objectType);
        }
        if (!"VIEW".equalsIgnoreCase(objectType) && !"MATERIALIZED_VIEW".equalsIgnoreCase(objectType)) {
            return new ObjectSource(name, objectType, effectiveSchema(schema), "");
        }
        return unchecked(() -> {
            String source = "";
            String sql = "SELECT view_definition " +
                "FROM information_schema.views " +
                "WHERE table_schema = " + sqlString(effectiveSchema(schema)) +
                " AND table_name = " + sqlString(name);
            if (!isMysqlCompatMode()) {
                sql = "SELECT sys_get_viewdef(c.oid) AS view_definition " +
                    "FROM sys_catalog.sys_class c " +
                    "JOIN sys_catalog.sys_namespace n ON " + KINGBASE_NAMESPACE_OID + " = " + KINGBASE_REL_NAMESPACE + " " +
                    "WHERE " + KINGBASE_SCHEMA_NAME + " = " + sqlString(effectiveSchema(schema)) +
                    " AND " + KINGBASE_REL_NAME + " = " + sqlString(name) +
                    " LIMIT 1";
            }
            try (Statement stmt = requireConnected().createStatement()) {
                try (ResultSet rs = stmt.executeQuery(sql)) {
                    if (rs.next()) {
                        source = coalesce(rs.getString("view_definition"));
                    }
                }
            }
            return new ObjectSource(name, objectType, effectiveSchema(schema), source);
        });
    }

    private ObjectSource routineSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            String source = "";
            String sql = "SELECT sys_get_functiondef(p.oid) AS source " +
                "FROM sys_catalog.sys_proc p " +
                "JOIN sys_catalog.sys_namespace n ON " + KINGBASE_NAMESPACE_OID + " = " + KINGBASE_ROUTINE_NAMESPACE + " " +
                "WHERE " + KINGBASE_SCHEMA_NAME + " = " + sqlString(effectiveSchema(schema)) +
                " AND " + KINGBASE_ROUTINE_NAME + " = " + sqlString(name) + " " +
                "ORDER BY CASE WHEN p.prorettype = " + KINGBASE_VOID_TYPE_OID + " THEN " +
                ("PROCEDURE".equalsIgnoreCase(objectType) ? "0 ELSE 1" : "1 ELSE 0") +
                " END, p.oid LIMIT 1";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                try (ResultSet rs = stmt.executeQuery()) {
                    if (rs.next()) {
                        source = coalesce(rs.getString("source"));
                    }
                }
            }
            return new ObjectSource(name, objectType, effectiveSchema(schema), source);
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        if (postgresCatalogMode) return super.getColumns(schema, table);
        return unchecked(() -> {
            Set<String> primaryKeys = primaryKeys(schema, table);
            if (!isMysqlCompatMode()) {
                return getRegularColumns(schema, table, primaryKeys);
            }
            return getInformationSchemaColumns(schema, table, primaryKeys);
        });
    }

    private List<ColumnInfo> getRegularColumns(String schema, String table, Set<String> primaryKeys) {
        return unchecked(() -> {
            List<ColumnInfo> result = new ArrayList<>();
            String sql = "SELECT a.attname AS column_name, " +
                "format_type(a.atttypid, a.atttypmod) AS data_type, " +
                "NOT a.attnotnull AS is_nullable, " +
                "sys_get_expr(ad.adbin, ad.adrelid) AS column_default, " +
                "d.description AS column_comment, " +
                "CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 " +
                "THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE NULL END AS numeric_precision, " +
                "CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 " +
                "THEN (a.atttypmod - 4) & 65535 ELSE NULL END AS numeric_scale, " +
                "CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 0 " +
                "THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length " +
                "FROM sys_catalog.sys_attribute a " +
                "JOIN sys_catalog.sys_type t ON t.oid = a.atttypid " +
                "JOIN sys_catalog.sys_class c ON c.oid = a.attrelid " +
                "JOIN sys_catalog.sys_namespace n ON n.oid = c.relnamespace " +
                "LEFT JOIN sys_catalog.sys_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum " +
                "LEFT JOIN sys_catalog.sys_description d ON d.objoid = a.attrelid AND d.objsubid = a.attnum " +
                "WHERE n.nspname = " + sqlString(effectiveSchema(schema)) +
                " AND c.relname = " + sqlString(table) + " " +
                "AND a.attnum > 0 AND NOT a.attisdropped " +
                "ORDER BY a.attnum";
            try (Statement stmt = requireConnected().createStatement()) {
                try (ResultSet rs = stmt.executeQuery(sql)) {
                    while (rs.next()) {
                        String columnName = rs.getString("column_name");
                        result.add(new ColumnInfo(
                            columnName,
                            rs.getString("data_type"),
                            rs.getBoolean("is_nullable"),
                            rs.getString("column_default"),
                            primaryKeys.contains(columnName),
                            null,
                            rs.getString("column_comment"),
                            intObject(rs, "numeric_precision"),
                            intObject(rs, "numeric_scale"),
                            intObject(rs, "character_maximum_length")
                        ));
                    }
                }
            }
            applySqlServerIdentityMetadata(schema, table, result);
            return result;
        });
    }

    private void applySqlServerIdentityMetadata(String schema, String table, List<ColumnInfo> columns) {
        if (!sqlServerIdentityCatalogMode || columns.isEmpty()) return;
        String sql = "SELECT a.attname AS column_name, ic.seed_value AS identity_seed, " +
            "ic.increment_value AS identity_increment " +
            "FROM sys.identity_columns ic " +
            "JOIN sys_catalog.sys_class c ON c.oid = ic.object_id " +
            "JOIN sys_catalog.sys_namespace n ON n.oid = c.relnamespace " +
            "JOIN sys_catalog.sys_attribute a ON a.attrelid = c.oid AND a.attnum = ic.column_id " +
            "WHERE n.nspname = " + sqlString(effectiveSchema(schema)) +
            " AND c.relname = " + sqlString(table);
        try (Statement stmt = requireConnected().createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            Map<String, ColumnInfo> columnsByName = new LinkedHashMap<>();
            for (ColumnInfo column : columns) {
                columnsByName.put(column.getName(), column);
            }
            while (rs.next()) {
                ColumnInfo column = columnsByName.get(rs.getString("column_name"));
                if (column != null) {
                    column.setExtra(identityExtra(rs));
                }
            }
        } catch (SQLException ignored) {
            // Identity metadata is optional and some Kingbase versions expose a broken compatibility view.
            sqlServerIdentityCatalogMode = false;
        }
    }

    private static String identityExtra(ResultSet rs) throws SQLException {
        String seed = rs.getString("identity_seed");
        String increment = rs.getString("identity_increment");
        if (seed == null || increment == null) {
            return null;
        }
        return "identity(" + seed + "," + increment + ")";
    }

    private List<ColumnInfo> getInformationSchemaColumns(String schema, String table, Set<String> primaryKeys) {
        return unchecked(() -> {
            List<ColumnInfo> result = new ArrayList<>();
            String sql = "SELECT ic.column_name, ic.data_type, ic.is_nullable, ic.column_default, " +
                "ic.numeric_precision, ic.numeric_scale, ic.character_maximum_length, " +
                "format_type(a.atttypid, a.atttypmod) AS catalog_data_type, " +
                "d.description AS column_comment " +
                "FROM information_schema.columns ic " +
                // information_schema preserves MySQL-compatible type metadata but does not expose comments.
                "LEFT JOIN sys_catalog.sys_namespace n ON n.nspname = ic.table_schema " +
                "LEFT JOIN sys_catalog.sys_class c ON c.relnamespace = n.oid AND c.relname = ic.table_name " +
                "LEFT JOIN sys_catalog.sys_attribute a ON a.attrelid = c.oid AND a.attname = ic.column_name " +
                "AND a.attnum > 0 AND NOT a.attisdropped " +
                "LEFT JOIN sys_catalog.sys_description d ON d.objoid = a.attrelid AND d.objsubid = a.attnum " +
                "WHERE ic.table_schema = " + sqlString(effectiveSchema(schema)) +
                " AND ic.table_name = " + sqlString(table) + " " +
                "ORDER BY ic.ordinal_position";
            try (Statement stmt = requireConnected().createStatement()) {
                try (ResultSet rs = stmt.executeQuery(sql)) {
                    while (rs.next()) {
                        String columnName = rs.getString("column_name");
                        String dataType = rs.getString("data_type");
                        Integer characterLength = intObject(rs, "character_maximum_length");
                        String catalogDataType = rs.getString("catalog_data_type");
                        Integer catalogCharacterLength = boundedCharacterLength(catalogDataType);
                        if ("varchar".equalsIgnoreCase(dataType)
                            && (characterLength == null || characterLength <= 0)
                            && catalogCharacterLength != null) {
                            dataType = catalogDataType;
                            characterLength = catalogCharacterLength;
                        }
                        result.add(new ColumnInfo(
                            columnName,
                            dataType,
                            "YES".equalsIgnoreCase(coalesce(rs.getString("is_nullable"))),
                            rs.getString("column_default"),
                            primaryKeys.contains(columnName),
                            null,
                            rs.getString("column_comment"),
                            intObject(rs, "numeric_precision"),
                            intObject(rs, "numeric_scale"),
                            characterLength
                        ));
                    }
                }
            }
            return result;
        });
    }

    private static Integer boundedCharacterLength(String dataType) {
        if (dataType == null) return null;
        Matcher match = BOUNDED_VARCHAR_TYPE.matcher(dataType.trim());
        if (!match.matches()) return null;
        try {
            int length = Integer.parseInt(match.group(1));
            return length > 0 ? length : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        if (postgresCatalogMode) return super.listIndexes(schema, table);
        return unchecked(() -> {
            Map<String, CatalogIndexBuilder> indexes = new LinkedHashMap<>();
            String sql = "SELECT i.relname AS index_name, am.amname AS index_type, " +
                "ix.indisunique AS is_unique, ix.indisprimary AS is_primary, " +
                "a.attname AS column_name, pos.n AS ordinal_position " +
                "FROM SYS_CATALOG.SYS_INDEX ix " +
                "JOIN SYS_CATALOG.SYS_CLASS t ON t.oid = ix.indrelid " +
                "JOIN SYS_CATALOG.SYS_CLASS i ON i.oid = ix.indexrelid " +
                "JOIN SYS_CATALOG.SYS_NAMESPACE n ON n.oid = t.relnamespace " +
                "JOIN SYS_CATALOG.SYS_AM am ON am.oid = i.relam " +
                "JOIN generate_series(1, 64) AS pos(n) ON pos.n <= array_length(string_to_array(ix.indkey::text, ' '), 1) " +
                "JOIN SYS_CATALOG.SYS_ATTRIBUTE a ON a.attrelid = t.oid AND a.attnum = (string_to_array(ix.indkey::text, ' '))[pos.n]::int2 " +
                "WHERE n.nspname = " + sqlString(effectiveSchema(schema)) +
                " AND t.relname = " + sqlString(table) + " " +
                "ORDER BY i.relname, pos.n";
            try (Statement stmt = requireConnected().createStatement()) {
                try (ResultSet rs = stmt.executeQuery(sql)) {
                    while (rs.next()) {
                        String name = rs.getString("index_name");
                        CatalogIndexBuilder builder = indexes.get(name);
                        if (builder == null) {
                            builder = new CatalogIndexBuilder(
                                name,
                                rs.getBoolean("is_unique"),
                                rs.getBoolean("is_primary"),
                                rs.getString("index_type")
                            );
                            indexes.put(name, builder);
                        }
                        builder.columns.add(rs.getString("column_name"));
                    }
                }
            }
            List<IndexInfo> result = new ArrayList<>();
            for (CatalogIndexBuilder index : indexes.values()) {
                result.add(new IndexInfo(index.name, index.columns, index.unique, index.primary, null, index.indexType, null, null));
            }
            return result;
        });
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        if (postgresCatalogMode) return super.listForeignKeys(schema, table);
        return unchecked(() -> {
            List<ForeignKeyInfo> result = new ArrayList<>();
            String sql = "SELECT fk.constraint_name, fk.column_name, pk.table_name AS ref_table, pk.column_name AS ref_column " +
                "FROM information_schema.table_constraints tc " +
                "JOIN information_schema.key_column_usage fk " +
                "ON fk.constraint_schema = tc.constraint_schema " +
                "AND fk.constraint_name = tc.constraint_name " +
                "AND fk.table_schema = tc.table_schema " +
                "AND fk.table_name = tc.table_name " +
                "JOIN information_schema.referential_constraints rc " +
                "ON rc.constraint_schema = tc.constraint_schema " +
                "AND rc.constraint_name = tc.constraint_name " +
                "JOIN information_schema.key_column_usage pk " +
                "ON pk.constraint_schema = rc.unique_constraint_schema " +
                "AND pk.constraint_name = rc.unique_constraint_name " +
                "AND pk.ordinal_position = fk.position_in_unique_constraint " +
                "WHERE tc.table_schema = " + sqlString(effectiveSchema(schema)) +
                " AND tc.table_name = " + sqlString(table) + " " +
                "AND tc.constraint_type = 'FOREIGN KEY' " +
                "ORDER BY fk.constraint_name, fk.ordinal_position";
            try (Statement stmt = requireConnected().createStatement()) {
                try (ResultSet rs = stmt.executeQuery(sql)) {
                    while (rs.next()) {
                        result.add(new ForeignKeyInfo(
                            rs.getString("constraint_name"),
                            rs.getString("column_name"),
                            rs.getString("ref_table"),
                            rs.getString("ref_column")
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        if (postgresCatalogMode) return super.listTriggers(schema, table);
        return unchecked(() -> {
            List<TriggerInfo> result = new ArrayList<>();
            String sql = "SELECT tg.tgname AS trigger_name, " +
                "trim(trailing ',' FROM (" +
                "CASE WHEN (tg.tgtype & 4) <> 0 THEN 'INSERT,' ELSE '' END || " +
                "CASE WHEN (tg.tgtype & 8) <> 0 THEN 'DELETE,' ELSE '' END || " +
                "CASE WHEN (tg.tgtype & 16) <> 0 THEN 'UPDATE,' ELSE '' END || " +
                "CASE WHEN (tg.tgtype & 32) <> 0 THEN 'TRUNCATE,' ELSE '' END" +
                ")) AS event_manipulation, tg.tgtype AS trigger_type " +
                "FROM sys_catalog.sys_trigger tg " +
                "JOIN sys_catalog.sys_class c ON c.oid = tg.tgrelid " +
                "JOIN sys_catalog.sys_namespace n ON n.oid = c.relnamespace " +
                "WHERE n.nspname = " + sqlString(effectiveSchema(schema)) +
                " AND c.relname = " + sqlString(table) + " AND NOT tg.tgisinternal " +
                "ORDER BY tg.tgname";
            try (Statement stmt = requireConnected().createStatement()) {
                try (ResultSet rs = stmt.executeQuery(sql)) {
                    while (rs.next()) {
                        result.add(new TriggerInfo(
                            rs.getString("trigger_name"),
                            rs.getString("event_manipulation"),
                            decodeTriggerTiming(rs.getInt("trigger_type"))
                        ));
                    }
                }
            }
            return result;
        });
    }

    private static String decodeTriggerTiming(int triggerType) {
        // INSTEAD OF has its own catalog bit and must not fall through to AFTER.
        if ((triggerType & TRIGGER_TYPE_INSTEAD) != 0) return "INSTEAD OF";
        if ((triggerType & TRIGGER_TYPE_BEFORE) != 0) return "BEFORE";
        return "AFTER";
    }

    @Override
    public String setSchemaSQL(String schema) {
        if (postgresCatalogMode) return super.setSchemaSQL(schema);
        // Keep sys_catalog's implicit priority for functions, types, and
        // operators. User table references are schema-qualified before execution.
        return "SET search_path TO " + JdbcIdentifiers.INSTANCE.doubleQuote(effectiveSchema(schema));
    }

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType, String columnTypeName) {
        if (isTemporalType(sqlType, columnTypeName)) {
            return unchecked(() -> {
                Object value = rs.getTimestamp(index);
                return rs.wasNull() ? null : value.toString();
            });
        }
        return super.resultValue(rs, index, sqlType, columnTypeName);
    }

    private static boolean isTemporalType(int sqlType, String columnTypeName) {
        switch (sqlType) {
            case Types.DATE:
            case Types.TIME:
            case Types.TIME_WITH_TIMEZONE:
            case Types.TIMESTAMP:
            case Types.TIMESTAMP_WITH_TIMEZONE:
                return true;
            default:
                break;
        }
        if (columnTypeName == null) {
            return false;
        }
        String normalized = columnTypeName.trim().toLowerCase(Locale.ROOT);
        return normalized.equals("date")
            || normalized.equals("time")
            || normalized.equals("datetime")
            || normalized.startsWith("timestamp");
    }

    private Set<String> primaryKeys(String schema, String table) {
        return unchecked(() -> {
            Set<String> primaryKeys = new LinkedHashSet<>();
            String sql = "SELECT kcu.column_name " +
                "FROM information_schema.table_constraints tc " +
                "JOIN information_schema.key_column_usage kcu " +
                "ON kcu.constraint_schema = tc.constraint_schema " +
                "AND kcu.constraint_name = tc.constraint_name " +
                "AND kcu.table_schema = tc.table_schema " +
                "AND kcu.table_name = tc.table_name " +
                "WHERE tc.table_schema = " + sqlString(effectiveSchema(schema)) +
                " AND tc.table_name = " + sqlString(table) + " " +
                "AND tc.constraint_type = 'PRIMARY KEY' " +
                "ORDER BY kcu.ordinal_position";
            try (Statement stmt = requireConnected().createStatement()) {
                try (ResultSet rs = stmt.executeQuery(sql)) {
                    while (rs.next()) {
                        primaryKeys.add(rs.getString("column_name"));
                    }
                }
            }
            return primaryKeys;
        });
    }

    private static boolean isUnconstrained(MetadataListConstraints constraints) {
        return !constraints.hasFilter() && !constraints.hasLimit() && !constraints.hasOffset() && !constraints.hasObjectTypes();
    }

    private static boolean includesSupportedObjects(MetadataListConstraints constraints) {
        return constraints.includesTableLikeTypes()
            || constraints.objectTypeAllowed("PROCEDURE")
            || constraints.objectTypeAllowed("FUNCTION");
    }

    private static void addRegularRelationBranches(
        List<String> branches,
        List<Object> args,
        String schema,
        MetadataListConstraints constraints,
        String nameAlias,
        String typeAlias,
        String commentAlias
    ) {
        if (constraints.tableTypeAllowed("TABLE")) {
            branches.add(regularRelationBranch(schema, args, constraints, nameAlias, typeAlias, commentAlias, "TABLE"));
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            branches.add(regularViewBranch(schema, args, constraints, nameAlias, typeAlias, commentAlias));
        }
        if (constraints.tableTypeAllowed("MATERIALIZED_VIEW")) {
            branches.add(regularMaterializedViewBranch(schema, args, constraints, nameAlias, typeAlias, commentAlias));
        }
    }

    private static String regularRelationBranch(
        String schema,
        List<Object> args,
        MetadataListConstraints constraints,
        String nameAlias,
        String typeAlias,
        String commentAlias,
        String objectType
    ) {
        StringBuilder sql = new StringBuilder("SELECT ")
            .append(KINGBASE_REL_NAME).append(" AS ").append(nameAlias).append(", '")
            .append(objectType).append("' AS ").append(typeAlias).append(", ")
            .append(KINGBASE_DESCRIPTION).append(" AS ").append(commentAlias).append(' ')
            .append("FROM sys_catalog.sys_class c ")
            .append("JOIN sys_catalog.sys_namespace n ON ").append(KINGBASE_NAMESPACE_OID).append(" = ").append(KINGBASE_REL_NAMESPACE).append(' ')
            .append("LEFT JOIN sys_catalog.sys_description d ON CAST(d.objoid AS varchar(64)) = ").append(KINGBASE_REL_OID).append(" AND d.objsubid = 0 ")
            .append("WHERE ").append(KINGBASE_SCHEMA_NAME).append(" = ").append(sqlString(schema))
            .append(" AND (EXISTS (SELECT 1 FROM sys_catalog.sys_tables t ")
            .append("WHERE CAST(t.schemaname AS varchar(256)) = ").append(KINGBASE_SCHEMA_NAME)
            .append(" AND CAST(t.tablename AS varchar(256)) = ").append(KINGBASE_REL_NAME).append(')')
            .append(" OR EXISTS (SELECT 1 FROM sys_catalog.sys_foreign_table ft ")
            .append("WHERE CAST(ft.ftrelid AS varchar(64)) = ").append(KINGBASE_REL_OID).append("))");
        MetadataSqlSupport.appendNameFilter(sql, args, KINGBASE_REL_NAME, constraints);
        return sql.toString();
    }

    private static String regularViewBranch(
        String schema,
        List<Object> args,
        MetadataListConstraints constraints,
        String nameAlias,
        String typeAlias,
        String commentAlias
    ) {
        // sys_views/sys_matviews avoid relkind while preserving the sidebar's
        // separate VIEW and MATERIALIZED_VIEW groups.
        StringBuilder sql = new StringBuilder("SELECT ")
            .append(KINGBASE_VIEW_NAME).append(" AS ").append(nameAlias).append(", 'VIEW' AS ").append(typeAlias).append(", ")
            .append(KINGBASE_DESCRIPTION).append(" AS ").append(commentAlias).append(' ')
            .append("FROM sys_catalog.sys_views v ")
            .append("JOIN sys_catalog.sys_namespace n ON ").append(KINGBASE_SCHEMA_NAME).append(" = ").append(KINGBASE_VIEW_SCHEMA).append(' ')
            .append("JOIN sys_catalog.sys_class c ON ").append(KINGBASE_REL_NAMESPACE).append(" = ").append(KINGBASE_NAMESPACE_OID)
            .append(" AND ").append(KINGBASE_REL_NAME).append(" = ").append(KINGBASE_VIEW_NAME).append(' ')
            .append("LEFT JOIN sys_catalog.sys_description d ON CAST(d.objoid AS varchar(64)) = ").append(KINGBASE_REL_OID).append(" AND d.objsubid = 0 ")
            .append("WHERE ").append(KINGBASE_VIEW_SCHEMA).append(" = ").append(sqlString(schema));
        MetadataSqlSupport.appendNameFilter(sql, args, KINGBASE_VIEW_NAME, constraints);
        return sql.toString();
    }

    private static String regularMaterializedViewBranch(
        String schema,
        List<Object> args,
        MetadataListConstraints constraints,
        String nameAlias,
        String typeAlias,
        String commentAlias
    ) {
        StringBuilder sql = new StringBuilder("SELECT ")
            .append(KINGBASE_MATVIEW_NAME).append(" AS ").append(nameAlias).append(", 'MATERIALIZED_VIEW' AS ").append(typeAlias).append(", ")
            .append(KINGBASE_DESCRIPTION).append(" AS ").append(commentAlias).append(' ')
            .append("FROM sys_catalog.sys_matviews mv ")
            .append("JOIN sys_catalog.sys_namespace n ON ").append(KINGBASE_SCHEMA_NAME).append(" = ").append(KINGBASE_MATVIEW_SCHEMA).append(' ')
            .append("JOIN sys_catalog.sys_class c ON ").append(KINGBASE_REL_NAMESPACE).append(" = ").append(KINGBASE_NAMESPACE_OID)
            .append(" AND ").append(KINGBASE_REL_NAME).append(" = ").append(KINGBASE_MATVIEW_NAME).append(' ')
            .append("LEFT JOIN sys_catalog.sys_description d ON CAST(d.objoid AS varchar(64)) = ").append(KINGBASE_REL_OID).append(" AND d.objsubid = 0 ")
            .append("WHERE ").append(KINGBASE_MATVIEW_SCHEMA).append(" = ").append(sqlString(schema));
        MetadataSqlSupport.appendNameFilter(sql, args, KINGBASE_MATVIEW_NAME, constraints);
        return sql.toString();
    }

    private static void appendRelationVisibilityPredicate(StringBuilder sql) {
        sql.append(" AND (SYS_HAS_ROLE(").append(KINGBASE_REL_OWNER).append(", 'USAGE')")
            .append(" OR HAS_TABLE_PRIVILEGE(c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')")
            .append(" OR HAS_ANY_COLUMN_PRIVILEGE(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))");
    }

    private static void appendMysqlCompatCatalogTypePredicate(
        StringBuilder sql,
        MetadataListConstraints constraints
    ) {
        boolean includeTables = constraints.tableTypeAllowed("TABLE");
        boolean includeViews = constraints.tableTypeAllowed("VIEW");
        if (includeTables && includeViews) {
            sql.append(" AND (CAST(c.relkind AS varchar(16)) IN ('r', 'p')")
                .append(" OR (CAST(c.relkind AS varchar(16)) = 'v' AND c.oid >= 16384))");
        } else if (includeTables) {
            sql.append(" AND CAST(c.relkind AS varchar(16)) IN ('r', 'p')");
        } else if (includeViews) {
            sql.append(" AND CAST(c.relkind AS varchar(16)) = 'v' AND c.oid >= 16384");
        } else {
            sql.append(" AND 1 = 0");
        }
    }

    private static void appendMysqlCompatTableTypePredicate(
        StringBuilder sql,
        List<Object> args,
        MetadataListConstraints constraints
    ) {
        if (!constraints.hasObjectTypes()) {
            sql.append(" AND table_type IN ('BASE TABLE', 'VIEW')");
            return;
        }
        List<String> types = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            types.add("BASE TABLE");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            types.add("VIEW");
        }
        if (types.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND table_type IN (").append(MetadataSqlSupport.placeholders(types.size())).append(")");
        args.addAll(types);
    }

    private static boolean isSysFreespacePermissionError(Throwable error) {
        boolean insufficientPrivilege = false;
        boolean mentionsSysFreespace = false;
        for (Throwable current = error; current != null; current = current.getCause()) {
            if (current instanceof SQLException && "42501".equals(((SQLException) current).getSQLState())) {
                insufficientPrivilege = true;
            }
            String message = current.getMessage();
            if (message != null) {
                String normalized = message.toLowerCase(Locale.ROOT);
                mentionsSysFreespace |= normalized.contains("sys_freespace")
                    || normalized.contains("pg_relation_size_ex");
            }
        }
        return insufficientPrivilege && mentionsSysFreespace;
    }

    private static void appendRoutineKindPredicate(StringBuilder sql, List<Object> args, MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            return;
        }
        boolean includeProcedures = constraints.objectTypeAllowed("PROCEDURE");
        boolean includeFunctions = constraints.objectTypeAllowed("FUNCTION");
        if (includeProcedures && includeFunctions) {
            return;
        }
        if (!includeProcedures && !includeFunctions) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(includeProcedures
            ? " AND p.prorettype = " + KINGBASE_VOID_TYPE_OID
            : " AND p.prorettype <> " + KINGBASE_VOID_TYPE_OID);
    }

    private static List<ObjectInfo> toObjects(List<TableInfo> tables, String schema) {
        List<ObjectInfo> result = new ArrayList<>();
        for (TableInfo table : tables) {
            result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
        }
        return result;
    }

    private String effectiveSchema(String schema) {
        if (schema != null && !schema.trim().isEmpty()) {
            return schema;
        }
        return "PUBLIC";
    }

    private static Integer intObject(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    private static String normalizeTableType(String type) {
        if (type == null || type.trim().isEmpty()) return "TABLE";
        if ("BASE TABLE".equalsIgnoreCase(type)) return "TABLE";
        return type;
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    private static String sqlString(String value) {
        return "'" + coalesce(value).replace("'", "''") + "'";
    }

    private static final class CatalogIndexBuilder {
        final String name;
        final boolean unique;
        final boolean primary;
        final String indexType;
        final List<String> columns = new ArrayList<>();

        CatalogIndexBuilder(String name, boolean unique, boolean primary, String indexType) {
            this.name = name;
            this.unique = unique;
            this.primary = primary;
            this.indexType = indexType;
        }
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(KingbaseAgent::new).run();
    }
}
