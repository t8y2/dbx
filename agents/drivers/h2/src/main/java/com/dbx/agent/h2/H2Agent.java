package com.dbx.agent.h2;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.MetadataSqlSupport;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public class H2Agent extends AbstractJdbcAgent {
    private String databaseName = "";
    private H2DriverLoader.LoadedDriver loadedDriver;
    private H2DriverVersion driverVersion = H2DriverVersion.V3;
    private int databaseMajorVersion = 2;

    @Override
    protected String driverClass() {
        return "org.h2.Driver";
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
    }

    @Override
    protected void loadDriver(ConnectParams params) throws Exception {
        H2DriverVersion selected = H2DriverVersion.select(params);
        if (selected == H2DriverVersion.CUSTOM) {
            H2DriverLoader.LoadedDriver external = H2DriverLoader.loadExternal(
                params.getJdbc_driver_paths(),
                params.getJdbc_driver_class()
            );
            if (loadedDriver == null || !loadedDriver.identity().equals(external.identity())) {
                replaceLoadedDriver(external);
            } else {
                external.classLoader().close();
            }
        } else if (loadedDriver == null || loadedDriver.version() != selected) {
            replaceLoadedDriver(H2DriverLoader.load(selected));
        }
        driverVersion = selected;
    }

    private void replaceLoadedDriver(H2DriverLoader.LoadedDriver replacement) throws Exception {
        H2DriverLoader.LoadedDriver previous = loadedDriver;
        if (previous != null) {
            try {
                previous.classLoader().close();
            } catch (Exception error) {
                replacement.classLoader().close();
                throw error;
            }
        }
        loadedDriver = replacement;
    }

    @Override
    protected Connection openConnection(ConnectParams params) throws Exception {
        if (loadedDriver == null) {
            throw new IllegalStateException("H2 JDBC driver was not loaded");
        }
        Connection opened = loadedDriver.driver().connect(buildJdbcUrl(params), buildConnectionProperties(params));
        if (opened == null) {
            throw new SQLException("H2 JDBC driver rejected URL: " + buildJdbcUrl(params));
        }
        return opened;
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        databaseName = params.getDatabase();
        databaseMajorVersion = unchecked(() -> connection.getMetaData().getDatabaseMajorVersion());
    }

    H2DriverVersion driverVersion() {
        return driverVersion;
    }

    boolean isVersion2OrLater() {
        return databaseMajorVersion >= 2;
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return List.of(new DatabaseInfo(databaseName.isBlank() ? "default" : databaseName));
    }

    @Override
    public List<String> listSchemas() {
        return unchecked(() -> {
            List<String> result = new ArrayList<>();
            try (var stmt = requireConnected().prepareStatement(
                "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME"
            );
                 ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.add(rs.getString(1));
                }
            }
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            String effectiveSchema = resolveSchema(schema);
            List<TableInfo> result = new ArrayList<>();
            try (var stmt = requireConnected().prepareStatement(
                """
                SELECT TABLE_NAME, TABLE_TYPE
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_SCHEMA = ?
                ORDER BY TABLE_NAME
                """
            )) {
                stmt.setString(1, effectiveSchema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String tableType = rs.getString("TABLE_TYPE");
                        if ("BASE TABLE".equals(tableType)) {
                            tableType = "TABLE";
                        }
                        result.add(new TableInfo(rs.getString("TABLE_NAME"), tableType, null));
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
            String effectiveSchema = resolveSchema(schema);
            List<TableInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            StringBuilder sql = new StringBuilder("SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?");
            args.add(effectiveSchema);
            appendH2TableTypePredicate(sql, args, constraints, isVersion2OrLater());
            MetadataSqlSupport.appendNameFilter(sql, args, "TABLE_NAME", constraints);
            sql.append(" ORDER BY TABLE_NAME");
            MetadataSqlSupport.appendLiteralLimitOffset(sql, constraints);
            try (var stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString("TABLE_NAME"), normalizeTableType(rs.getString("TABLE_TYPE")), null));
                    }
                }
            }
            return constraints.withoutPaging().filterTables(result);
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return unchecked(() -> {
            String effectiveSchema = resolveSchema(schema);
            List<ObjectInfo> result = new ArrayList<>();
            for (TableInfo table : listTables(schema)) {
                result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
            }

            String sql = isVersion2OrLater()
                ? "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME"
                : "SELECT ALIAS_NAME, CASE WHEN RETURNS_RESULT = 2 THEN 'FUNCTION' ELSE 'PROCEDURE' END FROM INFORMATION_SCHEMA.FUNCTION_ALIASES WHERE ALIAS_SCHEMA = ? ORDER BY ALIAS_NAME";
            try (var stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, effectiveSchema);
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
        if (!isVersion2OrLater()) {
            return constraints.filterObjects(listObjects(schema));
        }
        return unchecked(() -> {
            String effectiveSchema = resolveSchema(schema);
            List<ObjectInfo> result = new ArrayList<>();
            List<String> branches = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            if (constraints.includesTableLikeTypes()) {
                StringBuilder tableSql = new StringBuilder("SELECT TABLE_NAME AS OBJECT_NAME, TABLE_TYPE AS OBJECT_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?");
                args.add(effectiveSchema);
                appendH2TableTypePredicate(tableSql, args, constraints, true);
                MetadataSqlSupport.appendNameFilter(tableSql, args, "TABLE_NAME", constraints);
                branches.add(tableSql.toString());
            }
            if (constraints.objectTypeAllowed("PROCEDURE") || constraints.objectTypeAllowed("FUNCTION")) {
                StringBuilder routineSql = new StringBuilder("SELECT ROUTINE_NAME AS OBJECT_NAME, ROUTINE_TYPE AS OBJECT_TYPE FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = ?");
                args.add(effectiveSchema);
                appendRoutineTypePredicate(routineSql, args, constraints);
                MetadataSqlSupport.appendNameFilter(routineSql, args, "ROUTINE_NAME", constraints);
                branches.add(routineSql.toString());
            }
            if (branches.isEmpty()) {
                return List.of();
            }
            StringBuilder sql = new StringBuilder("SELECT OBJECT_NAME, OBJECT_TYPE FROM (")
                .append(String.join(" UNION ALL ", branches))
                .append(") metadata_objects ORDER BY CASE OBJECT_TYPE WHEN 'BASE TABLE' THEN 0 WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'PROCEDURE' THEN 2 WHEN 'FUNCTION' THEN 3 ELSE 9 END, OBJECT_NAME");
            MetadataSqlSupport.appendLiteralLimitOffset(sql, constraints);
            try (var stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1), normalizeTableType(rs.getString(2)), schema, null));
                    }
                }
            }
            return constraints.withoutPaging().filterObjects(result);
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            String effectiveSchema = resolveSchema(schema);
            String sql = switch (objectType.toUpperCase(Locale.ROOT)) {
                case "VIEW" -> "SELECT VIEW_DEFINITION FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";
                case "FUNCTION", "PROCEDURE" -> isVersion2OrLater()
                    ? "SELECT ROUTINE_DEFINITION FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?"
                    : "SELECT SOURCE FROM INFORMATION_SCHEMA.FUNCTION_ALIASES WHERE ALIAS_SCHEMA = ? AND ALIAS_NAME = ?";
                default -> throw new IllegalArgumentException("Unsupported object type: " + objectType);
            };

            String source = "";
            try (var stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, effectiveSchema);
                stmt.setString(2, name);
                try (ResultSet rs = stmt.executeQuery()) {
                    if (rs.next()) {
                        String value = rs.getString(1);
                        source = value == null ? "" : value;
                    }
                }
            }
            return new ObjectSource(name, objectType, schema, source);
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            String effectiveSchema = resolveSchema(schema);
            Set<String> primaryKeys = new HashSet<>();
            String primaryKeySql = isVersion2OrLater()
                ? """
                    SELECT ic.COLUMN_NAME
                    FROM INFORMATION_SCHEMA.INDEX_COLUMNS ic
                    JOIN INFORMATION_SCHEMA.INDEXES i
                      ON ic.INDEX_SCHEMA = i.INDEX_SCHEMA AND ic.INDEX_NAME = i.INDEX_NAME
                    WHERE ic.TABLE_SCHEMA = ? AND ic.TABLE_NAME = ?
                      AND i.INDEX_TYPE_NAME = 'PRIMARY KEY'
                    """
                : "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.INDEXES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND PRIMARY_KEY = TRUE";
            try (var stmt = requireConnected().prepareStatement(primaryKeySql)) {
                stmt.setString(1, effectiveSchema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        primaryKeys.add(rs.getString("COLUMN_NAME"));
                    }
                }
            }

            List<ColumnInfo> result = new ArrayList<>();
            String typeColumn = isVersion2OrLater() ? "DATA_TYPE" : "TYPE_NAME";
            String columnSql = "SELECT COLUMN_NAME, " + typeColumn + " AS DBX_DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, "
                + "NUMERIC_PRECISION, NUMERIC_SCALE, CHARACTER_MAXIMUM_LENGTH, REMARKS "
                + "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION";
            try (var stmt = requireConnected().prepareStatement(columnSql)) {
                stmt.setString(1, effectiveSchema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String columnName = rs.getString("COLUMN_NAME");
                        result.add(new ColumnInfo(
                            columnName,
                            rs.getString("DBX_DATA_TYPE"),
                            "YES".equals(rs.getString("IS_NULLABLE")),
                            rs.getString("COLUMN_DEFAULT"),
                            primaryKeys.contains(columnName),
                            rs.getString("REMARKS"),
                            null,
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
        return unchecked(() -> {
            String effectiveSchema = resolveSchema(schema);
            Map<String, List<String>> indexMap = new LinkedHashMap<>();
            Map<String, Boolean> uniqueMap = new HashMap<>();
            Map<String, Boolean> primaryMap = new HashMap<>();
            Map<String, String> typeMap = new HashMap<>();

            String indexSql = isVersion2OrLater()
                ? """
                    SELECT i.INDEX_NAME, ic.COLUMN_NAME, ic.IS_UNIQUE, i.INDEX_TYPE_NAME,
                           CASE WHEN i.INDEX_TYPE_NAME = 'PRIMARY KEY' THEN TRUE ELSE FALSE END AS IS_PRIMARY
                    FROM INFORMATION_SCHEMA.INDEX_COLUMNS ic
                    JOIN INFORMATION_SCHEMA.INDEXES i
                      ON ic.INDEX_SCHEMA = i.INDEX_SCHEMA AND ic.INDEX_NAME = i.INDEX_NAME
                    WHERE ic.TABLE_SCHEMA = ? AND ic.TABLE_NAME = ?
                    ORDER BY i.INDEX_NAME, ic.ORDINAL_POSITION
                    """
                : """
                    SELECT INDEX_NAME, COLUMN_NAME, CASE WHEN NON_UNIQUE THEN FALSE ELSE TRUE END AS IS_UNIQUE,
                           INDEX_TYPE_NAME, PRIMARY_KEY AS IS_PRIMARY
                    FROM INFORMATION_SCHEMA.INDEXES
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                    ORDER BY INDEX_NAME, ORDINAL_POSITION
                    """;
            try (var stmt = requireConnected().prepareStatement(indexSql)) {
                stmt.setString(1, effectiveSchema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String indexName = rs.getString("INDEX_NAME");
                        String columnName = rs.getString("COLUMN_NAME");
                        String indexType = rs.getString("INDEX_TYPE_NAME");

                        indexMap.computeIfAbsent(indexName, ignored -> new ArrayList<>()).add(columnName);
                        uniqueMap.put(indexName, rs.getBoolean("IS_UNIQUE"));
                        primaryMap.put(indexName, rs.getBoolean("IS_PRIMARY"));
                        typeMap.put(indexName, indexType == null ? "" : indexType);
                    }
                }
            }

            List<IndexInfo> result = new ArrayList<>();
            for (Map.Entry<String, List<String>> entry : indexMap.entrySet()) {
                String name = entry.getKey();
                result.add(new IndexInfo(
                    name,
                    entry.getValue(),
                    uniqueMap.getOrDefault(name, false),
                    primaryMap.getOrDefault(name, false),
                    null,
                    typeMap.get(name),
                    null,
                    null
                ));
            }
            return result;
        });
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return unchecked(() -> {
            String effectiveSchema = resolveSchema(schema);
            List<ForeignKeyInfo> result = new ArrayList<>();
            try (ResultSet rs = requireConnected().getMetaData().getImportedKeys(null, effectiveSchema, table)) {
                while (rs.next()) {
                    result.add(new ForeignKeyInfo(
                        rs.getString("FK_NAME"),
                        rs.getString("FKCOLUMN_NAME"),
                        rs.getString("PKTABLE_NAME"),
                        rs.getString("PKCOLUMN_NAME")
                    ));
                }
            }
            result.sort(java.util.Comparator.comparing(ForeignKeyInfo::getName, java.util.Comparator.nullsLast(String::compareTo)));
            return result;
        });
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        return unchecked(() -> {
            String effectiveSchema = resolveSchema(schema);
            List<TriggerInfo> result = new ArrayList<>();
            String triggerSql = isVersion2OrLater()
                ? """
                    SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING
                    FROM INFORMATION_SCHEMA.TRIGGERS
                    WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
                    ORDER BY TRIGGER_NAME
                    """
                : """
                    SELECT TRIGGER_NAME, TRIGGER_TYPE AS EVENT_MANIPULATION,
                           CASE WHEN BEFORE THEN 'BEFORE' ELSE 'AFTER' END AS ACTION_TIMING
                    FROM INFORMATION_SCHEMA.TRIGGERS
                    WHERE TRIGGER_SCHEMA = ? AND TABLE_NAME = ?
                    ORDER BY TRIGGER_NAME
                    """;
            try (var stmt = requireConnected().prepareStatement(triggerSql)) {
                stmt.setString(1, effectiveSchema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TriggerInfo(
                            rs.getString("TRIGGER_NAME"),
                            rs.getString("EVENT_MANIPULATION"),
                            rs.getString("ACTION_TIMING")
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "SET SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> JdbcExecutor.current().defaultResultValue(rs, index, sqlType));
    }

    @Override
    protected JdbcExecutor.ColumnAwareResultValueReader resultValueReader() {
        return (rs, index, sqlType, columnTypeName) -> {
            if (isJsonType(columnTypeName)) {
                byte[] bytes = rs.getBytes(index);
                // H2 stores JSON as UTF-8 bytes and getString/default JDBC
                // handling exposes a hex literal such as 0x5b5d. Decode only
                // JSON columns so real binary data keeps the existing hex view.
                return rs.wasNull() || bytes == null ? null : new String(bytes, StandardCharsets.UTF_8);
            }
            return resultValue(rs, index, sqlType);
        };
    }

    static String buildUrl(ConnectParams params) {
        String connectionString = params.getConnection_string();
        if (connectionString != null && !connectionString.trim().isEmpty()) {
            return connectionString.trim();
        }
        if (params.getHost().isBlank()) {
            return "jdbc:h2:" + params.getDatabase();
        }
        return "jdbc:h2:tcp://" + params.getHost() + ":" + params.getPort() + "/" + params.getDatabase();
    }

    private static boolean isUnconstrained(MetadataListConstraints constraints) {
        return !constraints.hasFilter() && !constraints.hasLimit() && !constraints.hasOffset() && !constraints.hasObjectTypes();
    }

    private static boolean includesSupportedObjects(MetadataListConstraints constraints) {
        return constraints.includesTableLikeTypes()
            || constraints.objectTypeAllowed("PROCEDURE")
            || constraints.objectTypeAllowed("FUNCTION");
    }

    private static void appendH2TableTypePredicate(
        StringBuilder sql,
        List<Object> args,
        MetadataListConstraints constraints,
        boolean version2OrLater
    ) {
        if (!constraints.hasObjectTypes()) {
            return;
        }
        List<String> types = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            types.add(version2OrLater ? "BASE TABLE" : "TABLE");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            types.add("VIEW");
        }
        if (types.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND TABLE_TYPE IN (").append(MetadataSqlSupport.placeholders(types.size())).append(")");
        args.addAll(types);
    }

    private static void appendRoutineTypePredicate(StringBuilder sql, List<Object> args, MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            return;
        }
        List<String> types = new ArrayList<>();
        if (constraints.objectTypeAllowed("PROCEDURE")) {
            types.add("PROCEDURE");
        }
        if (constraints.objectTypeAllowed("FUNCTION")) {
            types.add("FUNCTION");
        }
        if (types.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND ROUTINE_TYPE IN (").append(MetadataSqlSupport.placeholders(types.size())).append(")");
        args.addAll(types);
    }

    private static String normalizeTableType(String tableType) {
        return "BASE TABLE".equals(tableType) ? "TABLE" : tableType;
    }

    private static String resolveSchema(String schema) {
        if ("PUBLIC".equalsIgnoreCase(schema) || "INFORMATION_SCHEMA".equalsIgnoreCase(schema)) {
            return schema.toUpperCase(Locale.ROOT);
        }
        return "PUBLIC";
    }

    private static Integer intOrNull(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    private static boolean isJsonType(String columnTypeName) {
        return columnTypeName != null && "JSON".equals(columnTypeName.trim().toUpperCase(Locale.ROOT));
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(H2Agent::new).run();
    }
}
