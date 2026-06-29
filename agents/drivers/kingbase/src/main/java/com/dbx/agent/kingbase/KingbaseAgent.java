package com.dbx.agent.kingbase;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.JsonRpcServer;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.PostgresLikeAgent;
import com.dbx.agent.PostgresLikeAgentProfile;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
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

public final class KingbaseAgent extends PostgresLikeAgent {
    public static final PostgresLikeAgentProfile KINGBASE_PROFILE = new PostgresLikeAgentProfile(
        "com.kingbase8.Driver",
        "jdbc:kingbase8://{host}:{port}/{database}"
    );

    public KingbaseAgent() {
        super(KINGBASE_PROFILE);
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        if (params.isMysql_compat_mode()) {
            setMysqlCompatMode(true);
        }
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            String sql = isMysqlCompatMode()
                ? "SELECT current_database() AS database_name"
                : "SELECT datname AS database_name FROM sys_database WHERE datistemplate = false ORDER BY datname";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql);
                 ResultSet rs = stmt.executeQuery()) {
                List<DatabaseInfo> result = new ArrayList<>();
                while (rs.next()) {
                    result.add(new DatabaseInfo(rs.getString("database_name")));
                }
                if (!result.isEmpty()) return result;
            }
            return Collections.singletonList(new DatabaseInfo(getConfiguredDatabase()));
        });
    }

    @Override
    public List<String> listSchemas() {
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
                    "FROM sys_namespace " +
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
        if (isMysqlCompatMode()) {
            return listTables(schema, "table_type IN ('BASE TABLE', 'VIEW')");
        }
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            String sql = "SELECT c.relname AS table_name, " +
                "CASE c.relkind " +
                "WHEN 'r' THEN 'TABLE' " +
                "WHEN 'p' THEN 'TABLE' " +
                "WHEN 'v' THEN 'VIEW' " +
                "WHEN 'm' THEN 'MATERIALIZED_VIEW' " +
                "WHEN 'f' THEN 'FOREIGN_TABLE' " +
                "ELSE 'TABLE' END AS table_type, " +
                "d.description AS table_comment " +
                "FROM sys_catalog.sys_class c " +
                "JOIN sys_catalog.sys_namespace n ON n.oid = c.relnamespace " +
                "LEFT JOIN sys_catalog.sys_description d ON d.objoid = c.oid AND d.objsubid = 0 " +
                "WHERE n.nspname = ? AND c.relkind IN ('r','p','v','m','f') " +
                "ORDER BY c.relname";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, effectiveSchema(schema));
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
            return result;
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return unchecked(() -> {
            String effectiveSchema = effectiveSchema(schema);
            List<ObjectInfo> result = new ArrayList<>();
            for (TableInfo table : listTables(effectiveSchema)) {
                result.add(new ObjectInfo(table.getName(), table.getTable_type(), effectiveSchema, table.getComment()));
            }
            if (isMysqlCompatMode()) {
                return result;
            }

            String sql = "SELECT p.proname AS routine_name, " +
                "CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type, " +
                "d.description AS routine_comment " +
                "FROM sys_catalog.sys_proc p " +
                "JOIN sys_catalog.sys_namespace n ON n.oid = p.pronamespace " +
                "LEFT JOIN sys_catalog.sys_description d ON d.objoid = p.oid AND d.objsubid = 0 " +
                "WHERE n.nspname = ? AND p.prokind IN ('p','f') " +
                "ORDER BY p.proname";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, effectiveSchema);
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
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
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
            String prokind = "PROCEDURE".equalsIgnoreCase(objectType) ? "p" : "f";
            String sql = "SELECT sys_get_functiondef(p.oid) AS source " +
                "FROM sys_catalog.sys_proc p " +
                "JOIN sys_catalog.sys_namespace n ON n.oid = p.pronamespace " +
                "WHERE n.nspname = ? AND p.proname = ? AND p.prokind = ? " +
                "ORDER BY p.oid LIMIT 1";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, effectiveSchema(schema));
                stmt.setString(2, name);
                stmt.setString(3, prokind);
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
            return result;
        });
    }

    private List<ColumnInfo> getInformationSchemaColumns(String schema, String table, Set<String> primaryKeys) {
        return unchecked(() -> {
            List<ColumnInfo> result = new ArrayList<>();
            String sql = "SELECT column_name, data_type, is_nullable, column_default, " +
                "numeric_precision, numeric_scale, character_maximum_length " +
                "FROM information_schema.columns " +
                "WHERE table_schema = " + sqlString(effectiveSchema(schema)) +
                " AND table_name = " + sqlString(table) + " " +
                "ORDER BY ordinal_position";
            try (Statement stmt = requireConnected().createStatement()) {
                try (ResultSet rs = stmt.executeQuery(sql)) {
                    while (rs.next()) {
                        String columnName = rs.getString("column_name");
                        result.add(new ColumnInfo(
                            columnName,
                            rs.getString("data_type"),
                            "YES".equalsIgnoreCase(coalesce(rs.getString("is_nullable"))),
                            rs.getString("column_default"),
                            primaryKeys.contains(columnName),
                            null,
                            null,
                            intObject(rs, "numeric_precision"),
                            intObject(rs, "numeric_scale"),
                            intObject(rs, "character_maximum_length")
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
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
        return Collections.emptyList();
    }

    @Override
    public String setSchemaSQL(String schema) {
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

    private List<TableInfo> listTables(String schema, String tableTypePredicate) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            String sql = "SELECT table_name, table_type " +
                "FROM information_schema.tables " +
                "WHERE table_schema = " + sqlString(effectiveSchema(schema)) + " AND " + tableTypePredicate + " " +
                "ORDER BY table_name";
            try (Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery(sql)) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString(1), normalizeTableType(rs.getString(2))));
                    }
            }
            return result;
        });
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
        new JsonRpcServer(new KingbaseAgent()).run();
    }
}
