package com.dbx.agent.informix;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcExecutor;
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
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

public final class InformixAgent extends AbstractJdbcAgent {
    private String loginOwner = "";

    @Override
    protected String driverClass() {
        return "com.informix.jdbc.IfxDriver";
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return jdbcUrl(params);
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        loginOwner = normalizeOwner(params.getUsername());
    }

    @Override
    protected void afterDisconnect() {
        loginOwner = "";
    }

    public static String jdbcUrl(ConnectParams params) {
        String rawUrlParams = params.getUrl_params();
        String extraParams = rawUrlParams == null ? "" : trimEnd(trimStart(rawUrlParams.trim(), ':', ';'), ';');
        String rawDatabase = params.getDatabase();
        String database = rawDatabase == null || rawDatabase.trim().isEmpty()
            ? "sysmaster" : rawDatabase.trim();

        // Determine INFORMIXSERVER: from dedicated field, url_params, or default
        String informixServer = params.getInformix_server();
        informixServer = informixServer == null ? "" : informixServer.trim();
        if (informixServer.isEmpty()) {
            informixServer = hasUrlParameter(extraParams, "INFORMIXSERVER") ? "" : defaultInformixServer(params.getHost());
        }
        String serverParam = informixServer.isEmpty() ? "" : "INFORMIXSERVER=" + informixServer;

        if (extraParams.isEmpty()) {
            extraParams = "CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8";
        }

        List<String> jdbcParams = new ArrayList<>();
        if (!serverParam.isEmpty()) {
            jdbcParams.add(serverParam);
        }
        if (!extraParams.isEmpty()) {
            jdbcParams.add(extraParams);
        }
        return "jdbc:informix-sqli://" + params.getHost() + ":" + params.getPort() + "/" + database + ":"
            + String.join(";", jdbcParams);
    }

    private static String defaultInformixServer(String host) {
        return isIpAddress(host) ? "informix" : host;
    }

    private static boolean isIpAddress(String host) {
        return host.matches("\\d{1,3}(\\.\\d{1,3}){3}") || host.contains(":");
    }

    /**
     * Map Informix coltype integer codes to type names.
     * See Informix documentation for coltype values.
     */
    public static String mapColType(int coltype) {
        int baseType = coltype % 256;
        return switch (baseType) {
            case 0 -> "CHAR";
            case 1 -> "SMALLINT";
            case 2 -> "INTEGER";
            case 3 -> "FLOAT";
            case 4 -> "SMALLFLOAT";
            case 5 -> "DECIMAL";
            case 6 -> "SERIAL";
            case 7 -> "DATE";
            case 8 -> "MONEY";
            case 9 -> "NULL";
            case 10 -> "DATETIME";
            case 11 -> "BYTE";
            case 12 -> "TEXT";
            case 13 -> "VARCHAR";
            case 14 -> "INTERVAL";
            case 15 -> "NCHAR";
            case 16 -> "NVARCHAR";
            case 17 -> "INT8";
            case 18 -> "SERIAL8";
            case 19 -> "SET";
            case 20 -> "MULTISET";
            case 21 -> "LIST";
            case 22 -> "ROW";
            case 23 -> "COLLECTION";
            case 40 -> "LVARCHAR";
            case 41 -> "BOOLEAN";
            case 43, 52 -> "BIGINT";
            case 44, 53 -> "BIGSERIAL";
            default -> "UNKNOWN(" + baseType + ")";
        };
    }

    public static Set<Integer> primaryKeyColumnNumbers(List<Integer> parts) {
        Set<Integer> result = new HashSet<>();
        for (Integer part : parts) {
            if (part == null) {
                continue;
            }
            int value = Math.abs(part);
            if (value > 0) {
                result.add(value);
            }
        }
        return result;
    }

    public static String databaseCatalogSql() {
        return "SELECT name FROM sysmaster:sysdatabases ORDER BY name";
    }

    @Override
    protected Connection openConnection(ConnectParams params) throws SQLException {
        String url = jdbcUrl(params);
        try {
            return DriverManager.getConnection(url, params.getUsername(), params.getPassword());
        } catch (SQLException error) {
            throw new SQLException(
                "Informix connection failed.\nURL: " + url.replaceAll("//[^@]+@", "//***@") + "\nError: " + error.getMessage(),
                error.getSQLState(), error.getErrorCode()
            );
        }
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery(databaseCatalogSql())) {
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
            List<String> catalogOwners = new ArrayList<>();
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery(schemaCatalogSql())) {
                while (rs.next()) {
                    String owner = normalizeOwner(rs.getString(1));
                    if (!owner.isEmpty()) {
                        catalogOwners.add(owner);
                    }
                }
            }
            return mergeSchemaOwners(catalogOwners, loginOwner);
        });
    }

    static String schemaCatalogSql() {
        // Informix JDBC catalogs are databases; schemas are the object owners in the current database.
        return "SELECT owner FROM systables WHERE tabid >= 100 AND owner IS NOT NULL "
                + "UNION SELECT owner FROM sysprocedures WHERE owner IS NOT NULL ORDER BY owner";
    }

    static List<String> mergeSchemaOwners(List<String> catalogOwners, String loginOwner) {
        Set<String> owners = new TreeSet<>();
        for (String owner : catalogOwners) {
            String normalized = normalizeOwner(owner);
            if (!normalized.isEmpty()) {
                owners.add(normalized);
            }
        }
        String normalizedLoginOwner = normalizeOwner(loginOwner);
        if (!normalizedLoginOwner.isEmpty()) {
            owners.add(normalizedLoginOwner);
        }
        return new ArrayList<>(owners);
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            StringBuilder sql = new StringBuilder("""
                SELECT tabname,
                    CASE tabtype WHEN 'T' THEN 'TABLE' WHEN 'V' THEN 'VIEW' ELSE tabtype END
                FROM systables
                WHERE tabid >= 100
                """.stripIndent().trim());
            appendOwnerPredicate(sql, args, "owner", schema);
            sql.append(" ORDER BY tabname");
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString(1).trim(), rs.getString(2).trim(), null));
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
            StringBuilder sql = new StringBuilder("SELECT ");
            MetadataSqlSupport.appendLiteralSkipFirst(sql, constraints);
            sql.append("tabname, CASE tabtype WHEN 'T' THEN 'TABLE' WHEN 'V' THEN 'VIEW' ELSE tabtype END ")
                .append("FROM systables WHERE tabid >= 100");
            appendInformixTableTypePredicate(sql, constraints);
            appendOwnerPredicate(sql, args, "owner", schema);
            MetadataSqlSupport.appendNameFilter(sql, args, "tabname", constraints);
            sql.append(" ORDER BY tabname");
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString(1).trim(), rs.getString(2).trim(), null));
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

            appendRoutineObjects(result, schema, "f", "FUNCTION");
            appendRoutineObjects(result, schema, "t", "PROCEDURE");
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
                StringBuilder tableSql = new StringBuilder("SELECT tabname AS object_name, CASE tabtype WHEN 'T' THEN 'TABLE' WHEN 'V' THEN 'VIEW' ELSE tabtype END AS object_type, 0 AS object_order FROM systables WHERE tabid >= 100");
                appendInformixTableTypePredicate(tableSql, constraints);
                appendOwnerPredicate(tableSql, args, "owner", schema);
                MetadataSqlSupport.appendNameFilter(tableSql, args, "tabname", constraints);
                branches.add(tableSql.toString());
            }
            if (constraints.objectTypeAllowed("FUNCTION")) {
                StringBuilder functionSql = new StringBuilder("SELECT procname AS object_name, 'FUNCTION' AS object_type, 1 AS object_order FROM sysprocedures WHERE isproc = 'f'");
                appendRoutineOwnerPredicate(functionSql, args, schema);
                MetadataSqlSupport.appendNameFilter(functionSql, args, "procname", constraints);
                branches.add(functionSql.toString());
            }
            if (constraints.objectTypeAllowed("PROCEDURE")) {
                StringBuilder procedureSql = new StringBuilder("SELECT procname AS object_name, 'PROCEDURE' AS object_type, 2 AS object_order FROM sysprocedures WHERE isproc = 't'");
                appendRoutineOwnerPredicate(procedureSql, args, schema);
                MetadataSqlSupport.appendNameFilter(procedureSql, args, "procname", constraints);
                branches.add(procedureSql.toString());
            }
            if (branches.isEmpty()) {
                return List.of();
            }
            StringBuilder sql = new StringBuilder("SELECT ");
            MetadataSqlSupport.appendLiteralSkipFirst(sql, constraints);
            sql.append("object_name, object_type FROM (")
                .append(String.join(" UNION ALL ", branches))
                .append(") metadata_objects ORDER BY object_order, object_name");
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1).trim(), rs.getString(2).trim(), schema, null));
                    }
                }
            }
            return constraints.withoutPaging().filterObjects(result);
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            List<Object> args = new ArrayList<>();
            args.add(name);
            StringBuilder sql = new StringBuilder("""
                SELECT b.data FROM sysprocbody b
                JOIN sysprocedures p ON b.procid = p.procid
                WHERE p.procname = ? AND b.datakey = 'T'
                """.stripIndent().trim());
            appendOwnerPredicate(sql, args, "p.owner", schema);
            sql.append(" ORDER BY b.seqno");
            StringBuilder sb = new StringBuilder();
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String value = rs.getString(1);
                        sb.append(value == null ? "" : value);
                    }
                }
            }
            return new ObjectSource(name, objectType, schema, sb.toString());
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            Connection conn = requireConnected();
            Set<Integer> primaryKeyColumns = getPrimaryKeyColumnNumbers(conn, schema, table);
            List<ColumnInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            args.add(table);
            StringBuilder sql = new StringBuilder("""
                SELECT c.colname, c.coltype, c.colno
                FROM syscolumns c
                JOIN systables t ON t.tabid = c.tabid
                WHERE t.tabname = ?
                """.stripIndent().trim());
            appendOwnerPredicate(sql, args, "t.owner", schema);
            sql.append(" ORDER BY c.colno");
            try (PreparedStatement stmt = conn.prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String colname = rs.getString(1).trim();
                        int coltype = rs.getInt(2);
                        result.add(new ColumnInfo(
                            colname,
                            mapColType(coltype),
                            (coltype & 256) == 0,
                            null,
                            primaryKeyColumns.contains(rs.getInt(3)),
                            null,
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

    private Set<Integer> getPrimaryKeyColumnNumbers(Connection conn, String schema, String table) throws Exception {
        List<Object> args = new ArrayList<>();
        args.add(table);
        StringBuilder sql = new StringBuilder("""
            SELECT i.part1, i.part2, i.part3, i.part4, i.part5, i.part6, i.part7, i.part8,
                   i.part9, i.part10, i.part11, i.part12, i.part13, i.part14, i.part15, i.part16
            FROM sysconstraints c
            JOIN sysindexes i ON i.idxname = c.idxname AND i.tabid = c.tabid
            JOIN systables t ON t.tabid = c.tabid
            WHERE t.tabname = ? AND c.constrtype = 'P'
            """.stripIndent().trim());
        appendOwnerPredicate(sql, args, "t.owner", schema);

        try (PreparedStatement stmt = conn.prepareStatement(sql.toString())) {
            MetadataSqlSupport.bind(stmt, args);
            try (ResultSet rs = stmt.executeQuery()) {
                if (!rs.next()) {
                    return Collections.emptySet();
                }
                List<Integer> parts = new ArrayList<>();
                for (int index = 1; index <= 16; index++) {
                    int value = rs.getInt(index);
                    parts.add(rs.wasNull() ? null : value);
                }
                return primaryKeyColumnNumbers(parts);
            }
        }
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return Collections.emptyList();
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return Collections.emptyList();
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        return unchecked(() -> {
            List<TriggerInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            args.add(table);
            StringBuilder sql = new StringBuilder("""
                SELECT t.trigname, t.event, 'TRIGGER'
                FROM systriggers t
                JOIN systables s ON t.tabid = s.tabid
                WHERE s.tabname = ?
                """.stripIndent().trim());
            appendOwnerPredicate(sql, args, "s.owner", schema);
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TriggerInfo(rs.getString(1).trim(), rs.getString(2).trim(), rs.getString(3).trim()));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        String normalizedSql = switch (trimEnd(sql.trim(), ';').toUpperCase(Locale.ROOT)) {
            case "BEGIN WORK" -> "BEGIN";
            case "COMMIT WORK" -> "COMMIT";
            case "ROLLBACK WORK" -> "ROLLBACK";
            default -> sql;
        };
        return JdbcExecutor.current().execute(
            requireConnected(),
            normalizedSql,
            schema,
            this::setSchemaSQL,
            options.getMaxRows(),
            options.getFetchSize(),
            options.getTimeoutSecs(),
            this::resultValue
        );
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "";
    }

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = rs.getObject(index);
            return rs.wasNull() ? null : value == null ? null : value.toString();
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

    private void appendRoutineObjects(List<ObjectInfo> result, String schema, String routineKind, String objectType)
        throws Exception {
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder("SELECT procname FROM sysprocedures WHERE isproc = ?");
        args.add(routineKind);
        appendRoutineOwnerPredicate(sql, args, schema);
        sql.append(" ORDER BY procname");
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
            MetadataSqlSupport.bind(stmt, args);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.add(new ObjectInfo(rs.getString(1).trim(), objectType, schema, null));
                }
            }
        }
    }

    private void appendOwnerPredicate(StringBuilder sql, List<Object> args, String ownerColumn, String schema) {
        String owner = metadataOwner(schema);
        sql.append(" AND ").append(ownerColumn).append(" = ?");
        args.add(owner);
    }

    private void appendRoutineOwnerPredicate(StringBuilder sql, List<Object> args, String schema) {
        String owner = metadataOwner(schema);
        sql.append(" AND owner = ?");
        args.add(owner);
    }

    private String metadataOwner(String schema) {
        String owner = normalizeOwner(schema);
        if (!owner.isEmpty()) {
            return owner;
        }
        owner = normalizeOwner(loginOwner);
        if (!owner.isEmpty()) {
            return owner;
        }
        throw new IllegalStateException("Informix metadata owner is unavailable for an unqualified request");
    }

    private static String normalizeOwner(String schema) {
        return schema == null ? "" : schema.trim();
    }

    private static void appendInformixTableTypePredicate(StringBuilder sql, MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            return;
        }
        List<String> types = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            types.add("'T'");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            types.add("'V'");
        }
        if (types.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND tabtype IN (").append(String.join(", ", types)).append(")");
    }

    private static String trimStart(String value, char... chars) {
        int index = 0;
        while (index < value.length() && contains(chars, value.charAt(index))) {
            index++;
        }
        return value.substring(index);
    }

    private static String trimEnd(String value, char... chars) {
        int end = value.length();
        while (end > 0 && contains(chars, value.charAt(end - 1))) {
            end--;
        }
        return value.substring(0, end);
    }

    private static boolean contains(char[] chars, char value) {
        for (char candidate : chars) {
            if (candidate == value) {
                return true;
            }
        }
        return false;
    }

    private static boolean hasUrlParameter(String urlParams, String parameterName) {
        for (String urlParam : urlParams.split(";")) {
            int separator = urlParam.indexOf('=');
            if (separator < 0) {
                continue;
            }
            String key = urlParam.substring(0, separator).trim();
            if (key.equalsIgnoreCase(parameterName)) {
                return true;
            }
        }
        return false;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(InformixAgent::new).run();
    }
}
