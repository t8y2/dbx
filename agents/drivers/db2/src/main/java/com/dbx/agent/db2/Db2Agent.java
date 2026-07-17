package com.dbx.agent.db2;

import com.dbx.agent.BaseDatabaseAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.MetadataSqlSupport;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public final class Db2Agent extends BaseDatabaseAgent {
    private static final Set<String> NUMERIC_PRECISION_TYPES = Set.of(
        "DECIMAL", "NUMERIC", "INTEGER", "SMALLINT", "BIGINT", "REAL", "DOUBLE", "FLOAT"
    );
    private static final Set<String> NUMERIC_SCALE_TYPES = Set.of("DECIMAL", "NUMERIC");
    private static final Set<String> CHARACTER_LENGTH_TYPES = Set.of("VARCHAR", "CHAR", "CLOB", "GRAPHIC", "VARGRAPHIC");

    private Connection connection;

    @Override
    public Connection getConnection() {
        return connection;
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "SET SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    @Override
    public void connect(ConnectParams params) {
        uncheckedVoid(() -> {
            Class.forName("com.ibm.db2.jcc.DB2Driver");
            connection = DriverManager.getConnection(buildUrl(params), params.getUsername(), params.getPassword());
        });
    }

    @Override
    public boolean testConnection(ConnectParams params) {
        return unchecked(() -> {
            Class.forName("com.ibm.db2.jcc.DB2Driver");
            try (Connection conn = DriverManager.getConnection(buildUrl(params), params.getUsername(), params.getPassword())) {
                return conn.isValid(5);
            }
        });
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            String sql = "SELECT CURRENT_SERVER FROM SYSIBM.SYSDUMMY1";
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery(sql)) {
                while (rs.next()) {
                    result.add(new DatabaseInfo(rs.getString(1).trim()));
                }
            }
            return result;
        });
    }

    @Override
    public List<String> listSchemas() {
        return unchecked(() -> {
            List<String> result = new ArrayList<>();
            String sql = "SELECT SCHEMANAME FROM SYSCAT.SCHEMATA ORDER BY SCHEMANAME";
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery(sql)) {
                while (rs.next()) {
                    result.add(rs.getString(1).trim());
                }
            }
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            String sql = "SELECT TABNAME, TYPE FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE IN ('T','V') ORDER BY TABNAME";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String db2Type = rs.getString(2).trim();
                        String type = switch (db2Type) {
                            case "T" -> "TABLE";
                            case "V" -> "VIEW";
                            default -> db2Type;
                        };
                        result.add(new TableInfo(rs.getString(1).trim(), type, null));
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
            StringBuilder sql = new StringBuilder("SELECT TABNAME, TYPE FROM SYSCAT.TABLES WHERE TABSCHEMA = ?");
            args.add(schema);
            appendDb2TableTypePredicate(sql, args, constraints);
            MetadataSqlSupport.appendNameFilter(sql, args, "TABNAME", constraints);
            sql.append(" ORDER BY TABNAME");
            MetadataSqlSupport.appendLiteralOffsetFetch(sql, constraints);
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString(1).trim(), db2TableType(rs.getString(2)), null));
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

            String sql = "SELECT PROCNAME, 'PROCEDURE' FROM SYSCAT.PROCEDURES WHERE PROCSCHEMA = ? ORDER BY PROCNAME";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1).trim(), rs.getString(2), schema, null));
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
                StringBuilder tableSql = new StringBuilder(
                    "SELECT TABNAME AS OBJECT_NAME, CASE TYPE WHEN 'T' THEN 'TABLE' WHEN 'V' THEN 'VIEW' ELSE TYPE END AS OBJECT_TYPE FROM SYSCAT.TABLES WHERE TABSCHEMA = ?"
                );
                args.add(schema);
                appendDb2TableTypePredicate(tableSql, args, constraints);
                MetadataSqlSupport.appendNameFilter(tableSql, args, "TABNAME", constraints);
                branches.add(tableSql.toString());
            }
            if (constraints.objectTypeAllowed("PROCEDURE")) {
                StringBuilder procedureSql = new StringBuilder(
                    "SELECT PROCNAME AS OBJECT_NAME, 'PROCEDURE' AS OBJECT_TYPE FROM SYSCAT.PROCEDURES WHERE PROCSCHEMA = ?"
                );
                args.add(schema);
                MetadataSqlSupport.appendNameFilter(procedureSql, args, "PROCNAME", constraints);
                branches.add(procedureSql.toString());
            }
            if (branches.isEmpty()) {
                return List.of();
            }
            StringBuilder sql = new StringBuilder("SELECT OBJECT_NAME, OBJECT_TYPE FROM (")
                .append(String.join(" UNION ALL ", branches))
                .append(") metadata_objects ORDER BY CASE OBJECT_TYPE WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'PROCEDURE' THEN 2 ELSE 9 END, OBJECT_NAME");
            MetadataSqlSupport.appendLiteralOffsetFetch(sql, constraints);
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1).trim(), rs.getString(2), schema, null));
                    }
                }
            }
            return constraints.withoutPaging().filterObjects(result);
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            String sql = "SELECT TEXT FROM SYSCAT.ROUTINES WHERE ROUTINESCHEMA = ? AND ROUTINENAME = ?";
            String source;
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, name);
                try (ResultSet rs = stmt.executeQuery()) {
                    source = rs.next() ? coalesce(rs.getString(1)) : "";
                }
            }
            return new ObjectSource(name, objectType, schema, source);
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            Set<String> pkColumns = new java.util.HashSet<>();
            String pkSql = """
                SELECT kc.COLNAME FROM SYSCAT.KEYCOLUSE kc
                JOIN SYSCAT.TABCONST tc ON kc.CONSTNAME = tc.CONSTNAME AND kc.TABSCHEMA = tc.TABSCHEMA AND kc.TABNAME = tc.TABNAME
                WHERE tc.TYPE = 'P' AND tc.TABSCHEMA = ? AND tc.TABNAME = ?
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(pkSql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        pkColumns.add(rs.getString(1).trim());
                    }
                }
            }

            List<ColumnInfo> result = new ArrayList<>();
            String colSql = """
                SELECT COLNAME, TYPENAME, NULLS, DEFAULT, LENGTH, SCALE
                FROM SYSCAT.COLUMNS
                WHERE TABSCHEMA = ? AND TABNAME = ?
                ORDER BY COLNO
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(colSql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String name = rs.getString("COLNAME").trim();
                        String typeName = rs.getString("TYPENAME").trim();
                        Integer length = intObject(rs, "LENGTH");
                        Integer scale = intObject(rs, "SCALE");
                        String dataType = formatDataType(typeName, length, scale);

                        result.add(new ColumnInfo(
                            name,
                            dataType,
                            "Y".equals(rs.getString("NULLS").trim()),
                            trimNullable(rs.getString("DEFAULT")),
                            pkColumns.contains(name),
                            null,
                            null,
                            NUMERIC_PRECISION_TYPES.contains(typeName) ? length : null,
                            NUMERIC_SCALE_TYPES.contains(typeName) ? scale : null,
                            CHARACTER_LENGTH_TYPES.contains(typeName) ? length : null
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
            List<IndexInfo> result = new ArrayList<>();
            String sql = "SELECT INDNAME, COLNAMES, UNIQUERULE FROM SYSCAT.INDEXES WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY INDNAME";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String colNames = trimToEmpty(rs.getString(2));
                        List<String> columns = splitColumns(colNames, "[+-]");
                        String uniqueRule = trimToEmpty(rs.getString(3));
                        result.add(new IndexInfo(
                            rs.getString(1).trim(),
                            columns,
                            "U".equals(uniqueRule) || "P".equals(uniqueRule),
                            "P".equals(uniqueRule),
                            null,
                            null,
                            null,
                            null
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return unchecked(() -> {
            List<ForeignKeyInfo> result = new ArrayList<>();
            String sql = "SELECT CONSTNAME, FK_COLNAMES, REFTABNAME, PK_COLNAMES FROM SYSCAT.REFERENCES WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY CONSTNAME";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        List<String> fkColList = splitColumns(trimToEmpty(rs.getString(2)), "\\s+");
                        List<String> pkColList = splitColumns(trimToEmpty(rs.getString(4)), "\\s+");
                        String refTable = rs.getString(3).trim();
                        String constName = rs.getString(1).trim();
                        for (int i = 0; i < fkColList.size(); i++) {
                            result.add(new ForeignKeyInfo(
                                constName,
                                fkColList.get(i),
                                refTable,
                                i < pkColList.size() ? pkColList.get(i) : ""
                            ));
                        }
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        return unchecked(() -> {
            List<TriggerInfo> result = new ArrayList<>();
            String sql = "SELECT TRIGNAME, TRIGEVENT, TRIGTIME FROM SYSCAT.TRIGGERS WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY TRIGNAME";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TriggerInfo(
                            rs.getString(1).trim(),
                            rs.getString(2).trim(),
                            rs.getString(3).trim()
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        return JdbcExecutor.current().execute(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options.getMaxRows(),
            options.getFetchSize(),
            options.getTimeoutSecs(),
            this::stringResultValue
        );
    }

    @Override
    public void disconnect() {
        uncheckedVoid(() -> {
            if (connection != null) {
                connection.close();
            }
            connection = null;
        });
    }

    private Object stringResultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = rs.getObject(index);
            return rs.wasNull() ? null : value == null ? null : value.toString();
        });
    }

    static String buildUrl(ConnectParams params) {
        if (!params.getConnection_string().trim().isEmpty()) {
            return params.getConnection_string();
        }
        String url = "jdbc:db2://" + params.getHost() + ":" + params.getPort() + "/" + params.getDatabase();
        String extraParams = trimDb2UrlParams(params.getUrl_params());
        if (extraParams.isEmpty()) {
            return url;
        }
        return url + ":" + extraParams + (extraParams.endsWith(";") ? "" : ";");
    }

    private static boolean isUnconstrained(MetadataListConstraints constraints) {
        return !constraints.hasFilter() && !constraints.hasLimit() && !constraints.hasOffset() && !constraints.hasObjectTypes();
    }

    private static boolean includesSupportedObjects(MetadataListConstraints constraints) {
        return constraints.includesTableLikeTypes() || constraints.objectTypeAllowed("PROCEDURE");
    }

    private static void appendDb2TableTypePredicate(StringBuilder sql, List<Object> args, MetadataListConstraints constraints) {
        List<String> types = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            types.add("T");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            types.add("V");
        }
        if (types.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND TYPE IN (").append(MetadataSqlSupport.placeholders(types.size())).append(")");
        args.addAll(types);
    }

    private static String db2TableType(String value) {
        String db2Type = value == null ? "" : value.trim();
        return switch (db2Type) {
            case "T" -> "TABLE";
            case "V" -> "VIEW";
            default -> db2Type;
        };
    }

    private static String trimDb2UrlParams(String urlParams) {
        String value = urlParams == null ? "" : urlParams.trim();
        while (value.startsWith("?") || value.startsWith("&") || value.startsWith(":") || value.startsWith(";")) {
            value = value.substring(1);
        }
        return value;
    }

    private static String formatDataType(String typeName, Integer length, Integer scale) {
        return switch (typeName.toUpperCase(Locale.ROOT)) {
            case "VARCHAR", "CHAR", "CLOB", "GRAPHIC", "VARGRAPHIC" -> length != null ? typeName + "(" + length + ")" : typeName;
            case "DECIMAL", "NUMERIC" -> {
                if (length != null && scale != null && scale > 0) {
                    yield typeName + "(" + length + "," + scale + ")";
                }
                yield length != null ? typeName + "(" + length + ")" : typeName;
            }
            default -> typeName;
        };
    }

    private static Integer intObject(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value == null ? null : ((Number) value).intValue();
    }

    private static List<String> splitColumns(String value, String regex) {
        List<String> result = new ArrayList<>();
        for (String part : value.split(regex)) {
            if (!part.isBlank()) {
                result.add(part);
            }
        }
        return result;
    }

    private static String trimNullable(String value) {
        return value == null ? null : value.trim();
    }

    private static String trimToEmpty(String value) {
        return value == null ? "" : value.trim();
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(Db2Agent::new).run();
    }
}
