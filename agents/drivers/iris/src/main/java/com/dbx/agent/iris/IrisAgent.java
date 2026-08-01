package com.dbx.agent.iris;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.StandardJdbcMetadata;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class IrisAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile IRIS_PROFILE = new JdbcAgentProfile(
        "com.intersystems.jdbc.IRISDriver",
        "jdbc:IRIS://{host}:{port}/{database}",
        1972,
        true
    );

    public IrisAgent() {
        super(IRIS_PROFILE);
    }

    @Override
    public List<String> listSchemas() {
        return dedupeCaseInsensitiveSchemas(StandardJdbcMetadata.INSTANCE.listSchemas(requireConnection(), IRIS_PROFILE));
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return irisColumns(requireConnection(), schema, table);
    }

    static List<ColumnInfo> irisColumns(Connection conn, String schema, String table) {
        return unchecked(() -> {
            List<ColumnInfo> columns = new ArrayList<>();
            try (PreparedStatement stmt = conn.prepareStatement(columnSql(schema))) {
                int index = 1;
                if (!isBlank(schema)) {
                    stmt.setString(index++, schema.trim());
                }
                stmt.setString(index, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String name = rs.getString("COLUMN_NAME");
                        if (isBlank(name)) {
                            continue;
                        }
                        columns.add(new ColumnInfo(
                            name,
                            stringOrDefault(rs, "DATA_TYPE", "Unknown"),
                            !"NO".equalsIgnoreCase(stringOrNull(rs, "IS_NULLABLE")),
                            stringOrNull(rs, "COLUMN_DEFAULT"),
                            "YES".equalsIgnoreCase(stringOrNull(rs, "PRIMARY_KEY")),
                            null,
                            null,
                            intOrNull(rs, "NUMERIC_PRECISION"),
                            intOrNull(rs, "NUMERIC_SCALE"),
                            intOrNull(rs, "CHARACTER_MAXIMUM_LENGTH")
                        ));
                    }
                }
            }
            if (!hasPrimaryKey(columns)) {
                markPrimaryKeys(columns, irisPrimaryKeys(conn, schema, table));
            }
            return columns;
        });
    }

    static List<String> dedupeCaseInsensitiveSchemas(List<String> schemas) {
        Map<String, String> byNormalizedName = new LinkedHashMap<>();
        for (String schema : schemas) {
            if (schema == null || schema.trim().isEmpty()) {
                continue;
            }
            String name = schema.trim();
            byNormalizedName.putIfAbsent(name.toUpperCase(Locale.ROOT), name);
        }
        return new ArrayList<>(byNormalizedName.values());
    }

    private static Set<String> irisPrimaryKeys(Connection conn, String schema, String table) {
        Set<String> keys = jdbcPrimaryKeys(conn, schema, table);
        return keys.isEmpty() ? nativePrimaryKeys(conn, schema, table) : keys;
    }

    private static Set<String> jdbcPrimaryKeys(Connection conn, String schema, String table) {
        Set<String> keys = new LinkedHashSet<>();
        try {
            DatabaseMetaData meta = conn.getMetaData();
            try (ResultSet rs = meta.getPrimaryKeys(null, isBlank(schema) ? null : schema.trim(), table)) {
                addPrimaryKeys(keys, rs);
            }
        } catch (Exception ignored) {
        }
        return keys;
    }

    private static Set<String> nativePrimaryKeys(Connection conn, String schema, String table) {
        Set<String> keys = new LinkedHashSet<>();
        try (PreparedStatement stmt = conn.prepareStatement(primaryKeySql(schema))) {
            int index = 1;
            if (!isBlank(schema)) {
                stmt.setString(index++, schema.trim());
            }
            stmt.setString(index, table);
            try (ResultSet rs = stmt.executeQuery()) {
                addPrimaryKeys(keys, rs);
            }
        } catch (Exception ignored) {
            // Primary key metadata is optional for display; column listing must keep working.
        }
        return keys;
    }

    private static String columnSql(String schema) {
        StringBuilder sql = new StringBuilder(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, "
                + "PRIMARY_KEY, NUMERIC_PRECISION, NUMERIC_SCALE, CHARACTER_MAXIMUM_LENGTH "
                + "FROM INFORMATION_SCHEMA.COLUMNS WHERE "
        );
        if (!isBlank(schema)) {
            sql.append("UPPER(TABLE_SCHEMA) = UPPER(?) AND ");
        }
        sql.append("UPPER(TABLE_NAME) = UPPER(?) ORDER BY ORDINAL_POSITION");
        return sql.toString();
    }

    private static void addPrimaryKeys(Set<String> keys, ResultSet rs) throws Exception {
        while (rs.next()) {
            String column = rs.getString("COLUMN_NAME");
            if (!isBlank(column)) {
                keys.add(column.toUpperCase(Locale.ROOT));
            }
        }
    }

    private static boolean hasPrimaryKey(List<ColumnInfo> columns) {
        for (ColumnInfo column : columns) {
            if (column.getIs_primary_key()) {
                return true;
            }
        }
        return false;
    }

    private static void markPrimaryKeys(List<ColumnInfo> columns, Set<String> primaryKeys) {
        for (ColumnInfo column : columns) {
            if (primaryKeys.contains(column.getName().toUpperCase(Locale.ROOT))) {
                column.setIs_primary_key(true);
            }
        }
    }

    private static String primaryKeySql(String schema) {
        StringBuilder sql = new StringBuilder(
            "SELECT k.COLUMN_NAME "
                + "FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k "
                + "WHERE k.CONSTRAINT_TYPE = 'PRIMARY KEY' AND "
        );
        if (!isBlank(schema)) {
            sql.append("UPPER(k.TABLE_SCHEMA) = UPPER(?) AND ");
        }
        sql.append("UPPER(k.TABLE_NAME) = UPPER(?) ORDER BY k.ORDINAL_POSITION");
        return sql.toString();
    }

    private static String stringOrDefault(ResultSet rs, String column, String fallback) throws Exception {
        String value = stringOrNull(rs, column);
        return isBlank(value) ? fallback : value;
    }

    private static String stringOrNull(ResultSet rs, String column) throws Exception {
        String value = rs.getString(column);
        return rs.wasNull() ? null : value;
    }

    private static Integer intOrNull(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(IrisAgent::new).run();
    }
}
