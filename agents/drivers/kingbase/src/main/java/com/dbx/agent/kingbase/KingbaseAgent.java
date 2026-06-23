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
        return listTables(schema, "table_type = 'BASE TABLE'");
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        List<ObjectInfo> result = new ArrayList<>();
        for (TableInfo table : listTables(schema)) {
            result.add(new ObjectInfo(table.getName(), table.getTable_type(), effectiveSchema(schema), table.getComment()));
        }
        return result;
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        if (!"VIEW".equalsIgnoreCase(objectType)) {
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

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            Set<String> primaryKeys = primaryKeys(schema, table);
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
            Map<String, ConstraintIndexBuilder> indexes = new LinkedHashMap<>();
            String sql = "SELECT tc.constraint_name, tc.constraint_type, kcu.column_name " +
                "FROM information_schema.table_constraints tc " +
                "JOIN information_schema.key_column_usage kcu " +
                "ON kcu.constraint_schema = tc.constraint_schema " +
                "AND kcu.constraint_name = tc.constraint_name " +
                "AND kcu.table_schema = tc.table_schema " +
                "AND kcu.table_name = tc.table_name " +
                "WHERE tc.table_schema = " + sqlString(effectiveSchema(schema)) +
                " AND tc.table_name = " + sqlString(table) + " " +
                "AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE') " +
                "ORDER BY tc.constraint_name, kcu.ordinal_position";
            try (Statement stmt = requireConnected().createStatement()) {
                try (ResultSet rs = stmt.executeQuery(sql)) {
                    while (rs.next()) {
                        String name = rs.getString("constraint_name");
                        String type = rs.getString("constraint_type");
                        ConstraintIndexBuilder builder = indexes.get(name);
                        if (builder == null) {
                            builder = new ConstraintIndexBuilder(name, "PRIMARY KEY".equalsIgnoreCase(type));
                            indexes.put(name, builder);
                        }
                        builder.columns.add(rs.getString("column_name"));
                    }
                }
            }
            List<IndexInfo> result = new ArrayList<>();
            for (ConstraintIndexBuilder index : indexes.values()) {
                result.add(new IndexInfo(index.name, index.columns, true, index.primary, null, index.primary ? "PRIMARY KEY" : "UNIQUE", null, null));
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

    private static final class ConstraintIndexBuilder {
        final String name;
        final List<String> columns = new ArrayList<>();
        final boolean primary;

        ConstraintIndexBuilder(String name, boolean primary) {
            this.name = name;
            this.primary = primary;
        }
    }

    public static void main(String[] args) {
        new JsonRpcServer(new KingbaseAgent()).run();
    }
}
