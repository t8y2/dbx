package com.dbx.agent.snowflake;

import com.dbx.agent.AbstractJdbcAgent;
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
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.sql.Connection;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

public final class SnowflakeAgent extends AbstractJdbcAgent {

    @Override
    protected String driverClass() {
        return "net.snowflake.client.jdbc.SnowflakeDriver";
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW DATABASES")) {
                while (rs.next()) {
                    result.add(new DatabaseInfo(rs.getString("name")));
                }
            }
            result.sort(Comparator.comparing(DatabaseInfo::getName));
            return result;
        });
    }

    @Override
    public List<String> listSchemas() {
        return unchecked(() -> {
            List<String> result = new ArrayList<>();
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW SCHEMAS")) {
                while (rs.next()) {
                    result.add(rs.getString("name"));
                }
            }
            Collections.sort(result);
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            String sql = "SELECT TABLE_NAME, TABLE_TYPE " +
                "FROM INFORMATION_SCHEMA.TABLES " +
                "WHERE TABLE_SCHEMA = ? " +
                "ORDER BY TABLE_NAME";
            try (java.sql.PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            rs.getString("TABLE_NAME"),
                            normalizeTableType(rs.getString("TABLE_TYPE")),
                            null
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (isUnconstrained(normalized)) {
            return listTables(schema);
        }
        if (!normalized.includesTableLikeTypes()) {
            return List.of();
        }
        try {
            return queryConstrainedTables(schema, normalized);
        } catch (RuntimeException e) {
            return normalized.filterTables(listTables(schema));
        }
    }

    private List<TableInfo> queryConstrainedTables(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            StringBuilder sql = new StringBuilder("SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?");
            args.add(schema);
            appendSnowflakeTableTypePredicate(sql, args, constraints);
            MetadataSqlSupport.appendNameFilter(sql, args, "TABLE_NAME", constraints);
            sql.append(" ORDER BY TABLE_NAME");
            MetadataSqlSupport.appendLiteralLimitOffset(sql, constraints);
            try (java.sql.PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            rs.getString("TABLE_NAME"),
                            normalizeTableType(rs.getString("TABLE_TYPE")),
                            null
                        ));
                    }
                }
            }
            return constraints.withoutPaging().filterTables(result);
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return unchecked(() -> {
            List<ObjectInfo> result = new ArrayList<>();
            for (TableInfo table : listTables(schema)) {
                result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
            }

            String sql = "SELECT PROCEDURE_NAME, 'PROCEDURE' " +
                "FROM INFORMATION_SCHEMA.PROCEDURES " +
                "WHERE PROCEDURE_SCHEMA = ? " +
                "ORDER BY PROCEDURE_NAME";
            try (java.sql.PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1), rs.getString(2), schema, null));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (isUnconstrained(normalized)) {
            return listObjects(schema);
        }
        if (!includesSupportedObjects(normalized)) {
            return List.of();
        }
        try {
            return queryConstrainedObjects(schema, normalized);
        } catch (RuntimeException e) {
            return normalized.filterObjects(listObjects(schema));
        }
    }

    private List<ObjectInfo> queryConstrainedObjects(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            List<ObjectInfo> result = new ArrayList<>();
            List<String> branches = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            if (constraints.includesTableLikeTypes()) {
                StringBuilder tableSql = new StringBuilder("SELECT TABLE_NAME AS OBJECT_NAME, TABLE_TYPE AS OBJECT_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?");
                args.add(schema);
                appendSnowflakeTableTypePredicate(tableSql, args, constraints);
                MetadataSqlSupport.appendNameFilter(tableSql, args, "TABLE_NAME", constraints);
                branches.add(tableSql.toString());
            }
            if (constraints.objectTypeAllowed("PROCEDURE")) {
                StringBuilder procedureSql = new StringBuilder("SELECT PROCEDURE_NAME AS OBJECT_NAME, 'PROCEDURE' AS OBJECT_TYPE FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = ?");
                args.add(schema);
                MetadataSqlSupport.appendNameFilter(procedureSql, args, "PROCEDURE_NAME", constraints);
                branches.add(procedureSql.toString());
            }
            if (branches.isEmpty()) {
                return List.of();
            }
            StringBuilder sql = new StringBuilder("SELECT OBJECT_NAME, OBJECT_TYPE FROM (")
                .append(String.join(" UNION ALL ", branches))
                .append(") metadata_objects ORDER BY CASE OBJECT_TYPE WHEN 'BASE TABLE' THEN 0 WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'MATERIALIZED VIEW' THEN 2 WHEN 'PROCEDURE' THEN 3 ELSE 9 END, OBJECT_NAME");
            MetadataSqlSupport.appendLiteralLimitOffset(sql, constraints);
            try (java.sql.PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(
                            rs.getString("OBJECT_NAME"),
                            normalizeTableType(rs.getString("OBJECT_TYPE")),
                            schema,
                            null
                        ));
                    }
                }
            }
            return constraints.withoutPaging().filterObjects(result);
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            String ddlType = objectType.toUpperCase(Locale.ROOT);
            String sql = "SELECT GET_DDL('" + ddlType + "', '\"" + schema + "\".\"" + name + "\"')";
            String source = "";
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery(sql)) {
                if (rs.next()) {
                    String value = rs.getString(1);
                    source = value == null ? "" : value;
                }
            }
            return new ObjectSource(name, objectType, schema, source);
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            Connection conn = requireConnected();
            List<String> primaryKeys = new ArrayList<>();
            try (java.sql.Statement stmt = conn.createStatement()) {
                String qualifiedTable = JdbcIdentifiers.INSTANCE.doubleQuote(schema) + "." + JdbcIdentifiers.INSTANCE.doubleQuote(table);
                try (ResultSet rs = stmt.executeQuery("SHOW PRIMARY KEYS IN TABLE " + qualifiedTable)) {
                    while (rs.next()) {
                        primaryKeys.add(rs.getString("column_name"));
                    }
                }
            } catch (Exception ignored) {
                // Snowflake may not return primary key metadata for every object.
            }

            List<ColumnInfo> result = new ArrayList<>();
            String sql = "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, " +
                "NUMERIC_PRECISION, NUMERIC_SCALE, CHARACTER_MAXIMUM_LENGTH, COMMENT " +
                "FROM INFORMATION_SCHEMA.COLUMNS " +
                "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? " +
                "ORDER BY ORDINAL_POSITION";
            try (java.sql.PreparedStatement stmt = conn.prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String colName = rs.getString("COLUMN_NAME");
                        result.add(new ColumnInfo(
                            colName,
                            rs.getString("DATA_TYPE"),
                            "YES".equals(rs.getString("IS_NULLABLE")),
                            rs.getString("COLUMN_DEFAULT"),
                            primaryKeys.contains(colName),
                            null,
                            blankToNull(rs.getString("COMMENT")),
                            intOrNull(rs, "NUMERIC_PRECISION"),
                            intOrNull(rs, "NUMERIC_SCALE"),
                            intOrNull(rs, "CHARACTER_MAXIMUM_LENGTH")
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return Collections.emptyList();
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return unchecked(() -> {
            try (java.sql.Statement stmt = requireConnected().createStatement()) {
                String qualifiedTable = JdbcIdentifiers.INSTANCE.doubleQuote(schema) + "." + JdbcIdentifiers.INSTANCE.doubleQuote(table);
                try (ResultSet rs = stmt.executeQuery("SHOW IMPORTED KEYS IN TABLE " + qualifiedTable)) {
                    List<ForeignKeyInfo> result = new ArrayList<>();
                    while (rs.next()) {
                        result.add(new ForeignKeyInfo(
                            rs.getString("fk_name"),
                            rs.getString("fk_column_name"),
                            rs.getString("pk_table_name"),
                            rs.getString("pk_column_name")
                        ));
                    }
                    return result;
                }
            } catch (Exception ignored) {
                return Collections.emptyList();
            }
        });
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        return Collections.emptyList();
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "USE SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = rs.getObject(index);
            return rs.wasNull() ? null : value == null ? null : value.toString();
        });
    }

    private static String buildUrl(ConnectParams params) {
        return "jdbc:snowflake://" + params.getHost() + ":" + params.getPort() + "/?db=" + params.getDatabase();
    }

    private static boolean isUnconstrained(MetadataListConstraints constraints) {
        return !constraints.hasFilter() && !constraints.hasLimit() && !constraints.hasOffset() && !constraints.hasObjectTypes();
    }

    private static boolean includesSupportedObjects(MetadataListConstraints constraints) {
        return constraints.includesTableLikeTypes() || constraints.objectTypeAllowed("PROCEDURE");
    }

    private static void appendSnowflakeTableTypePredicate(StringBuilder sql, List<Object> args, MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            return;
        }
        List<String> types = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            types.add("BASE TABLE");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            types.add("VIEW");
        }
        if (constraints.tableTypeAllowed("MATERIALIZED_VIEW")) {
            types.add("MATERIALIZED VIEW");
        }
        if (types.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND TABLE_TYPE IN (").append(MetadataSqlSupport.placeholders(types.size())).append(")");
        args.addAll(types);
    }

    private static String normalizeTableType(String tableType) {
        if ("BASE TABLE".equals(tableType)) {
            return "TABLE";
        }
        if ("MATERIALIZED VIEW".equals(tableType)) {
            return "MATERIALIZED_VIEW";
        }
        return tableType;
    }

    private static String blankToNull(String value) {
        return value == null || value.isEmpty() ? null : value;
    }

    private static Integer intOrNull(ResultSet rs, String column) throws java.sql.SQLException {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(SnowflakeAgent::new).run();
    }
}
