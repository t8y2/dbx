package com.dbx.agent.db2;

import com.dbx.agent.AbstractJdbcAgent;
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
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public final class Db2Agent extends AbstractJdbcAgent {
    private static final String LARGE_VALUE_BYTES_COLUMN_PREFIX = "__DBX_LARGE_VALUE_BYTES_";
    private static final String DEFERRED_LOB_MARKER = "D:1";
    private static final Set<String> NUMERIC_PRECISION_TYPES = Set.of(
        "DECIMAL", "NUMERIC", "INTEGER", "SMALLINT", "BIGINT", "REAL", "DOUBLE", "FLOAT"
    );
    private static final Set<String> NUMERIC_SCALE_TYPES = Set.of("DECIMAL", "NUMERIC");
    private static final Set<String> CHARACTER_LENGTH_TYPES = Set.of("VARCHAR", "CHAR", "CLOB", "GRAPHIC", "VARGRAPHIC");
    private final Set<String> deferredQuerySessions = ConcurrentHashMap.newKeySet();
    private final Set<String> deferredTableReadSessions = ConcurrentHashMap.newKeySet();

    @Override
    protected String driverClass() {
        return "com.ibm.db2.jcc.DB2Driver";
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "SET SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
    }

    @Override
    protected Properties buildConnectionProperties(ConnectParams params) {
        Properties properties = super.buildConnectionProperties(params);
        properties.setProperty("db2.jcc.charsetDecoderEncoder", "3");
        return properties;
    }

    @Override
    protected void afterDisconnect() {
        deferredQuerySessions.clear();
        deferredTableReadSessions.clear();
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
            String sql = "SELECT TABNAME, TYPE, REMARKS FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE IN ('T','V') ORDER BY TABNAME";
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
                        result.add(new TableInfo(rs.getString(1).trim(), type, rs.getString(3)));
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
            StringBuilder sql = new StringBuilder("SELECT TABNAME, TYPE, REMARKS FROM SYSCAT.TABLES WHERE TABSCHEMA = ?");
            args.add(schema);
            appendDb2TableTypePredicate(sql, args, constraints);
            MetadataSqlSupport.appendNameFilter(sql, args, "TABNAME", constraints);
            sql.append(" ORDER BY TABNAME");
            MetadataSqlSupport.appendLiteralOffsetFetch(sql, constraints);
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString(1).trim(), db2TableType(rs.getString(2)), rs.getString(3)));
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
                result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment(), table.getValid()));
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
                    "SELECT TABNAME AS OBJECT_NAME, CASE TYPE WHEN 'T' THEN 'TABLE' WHEN 'V' THEN 'VIEW' ELSE TYPE END AS OBJECT_TYPE, REMARKS AS OBJECT_COMMENT FROM SYSCAT.TABLES WHERE TABSCHEMA = ?"
                );
                args.add(schema);
                appendDb2TableTypePredicate(tableSql, args, constraints);
                MetadataSqlSupport.appendNameFilter(tableSql, args, "TABNAME", constraints);
                branches.add(tableSql.toString());
            }
            if (constraints.objectTypeAllowed("PROCEDURE")) {
                StringBuilder procedureSql = new StringBuilder(
                    "SELECT PROCNAME AS OBJECT_NAME, 'PROCEDURE' AS OBJECT_TYPE, CAST(NULL AS VARCHAR(254)) AS OBJECT_COMMENT FROM SYSCAT.PROCEDURES WHERE PROCSCHEMA = ?"
                );
                args.add(schema);
                MetadataSqlSupport.appendNameFilter(procedureSql, args, "PROCNAME", constraints);
                branches.add(procedureSql.toString());
            }
            if (branches.isEmpty()) {
                return List.of();
            }
            StringBuilder sql = new StringBuilder("SELECT OBJECT_NAME, OBJECT_TYPE, OBJECT_COMMENT FROM (")
                .append(String.join(" UNION ALL ", branches))
                .append(") metadata_objects ORDER BY CASE OBJECT_TYPE WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'PROCEDURE' THEN 2 ELSE 9 END, OBJECT_NAME");
            MetadataSqlSupport.appendLiteralOffsetFetch(sql, constraints);
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1).trim(), rs.getString(2), schema, rs.getString(3)));
                    }
                }
            }
            return constraints.withoutPaging().filterObjects(result);
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            String normalizedType = objectType == null ? "" : objectType.trim().toUpperCase(Locale.ROOT);
            // View definitions live in SYSCAT.VIEWS; SYSCAT.ROUTINES only covers procedures and functions.
            String sql = "VIEW".equals(normalizedType)
                ? "SELECT TEXT FROM SYSCAT.VIEWS WHERE VIEWSCHEMA = ? AND VIEWNAME = ?"
                : "SELECT TEXT FROM SYSCAT.ROUTINES WHERE ROUTINESCHEMA = ? AND ROUTINENAME = ?";
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
                SELECT COLNAME, TYPENAME, NULLS, DEFAULT, LENGTH, SCALE, REMARKS
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
                            rs.getString("REMARKS"),
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
        boolean deferLobs = shouldDeferLobs(sql, options.getDeferLobs());
        JdbcExecutor.ResultValueReader valueReader = deferLobs
            ? (JdbcExecutor.ColumnAwareResultValueReader) this::deferredResultValue
            : this::resultValue;
        QueryResult result = JdbcExecutor.current().execute(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options.getMaxRows(),
            options.getFetchSize(),
            options.getTimeoutSecs(),
            valueReader
        );
        return deferLobs ? addDeferredLobMarkers(result) : result;
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        boolean deferLobs = shouldDeferLobs(sql, options.getDeferLobs());
        JdbcExecutor.ResultValueReader valueReader = deferLobs
            ? (JdbcExecutor.ColumnAwareResultValueReader) this::deferredResultValue
            : this::resultValue;
        QueryPageResult result = JdbcExecutor.current().executePage(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            this::resetSchemaSQL,
            options,
            valueReader,
            advancePastUpdateCounts()
        );
        rememberDeferredSession(deferredQuerySessions, result, deferLobs);
        return deferLobs ? addDeferredLobMarkers(result) : result;
    }

    @Override
    public QueryPageResult fetchQueryPage(String sessionId, int pageSize) {
        QueryPageResult result = JdbcExecutor.current().fetchPage(sessionId, pageSize);
        return finishDeferredPage(deferredQuerySessions, sessionId, result);
    }

    @Override
    public boolean closeQuerySession(String sessionId) {
        deferredQuerySessions.remove(sessionId);
        return super.closeQuerySession(sessionId);
    }

    @Override
    public QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
        boolean deferLobs = shouldDeferLobs(sql, options.getDeferLobs());
        JdbcExecutor.ResultValueReader valueReader = deferLobs
            ? (JdbcExecutor.ColumnAwareResultValueReader) this::deferredResultValue
            : this::resultValue;
        QueryPageResult result = JdbcExecutor.current().startTableRead(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            this::resetSchemaSQL,
            options,
            valueReader
        );
        rememberDeferredSession(deferredTableReadSessions, result, deferLobs);
        return deferLobs ? addDeferredLobMarkers(result) : result;
    }

    @Override
    public QueryPageResult fetchTableReadPage(String sessionId, int pageSize) {
        QueryPageResult result = JdbcExecutor.current().fetchTableReadPage(sessionId, pageSize);
        return finishDeferredPage(deferredTableReadSessions, sessionId, result);
    }

    @Override
    public boolean closeTableReadSession(String sessionId) {
        deferredTableReadSessions.remove(sessionId);
        return super.closeTableReadSession(sessionId);
    }

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            if (sqlType == Types.CLOB || sqlType == Types.NCLOB) {
                String value = rs.getString(index);
                return rs.wasNull() ? null : value;
            }
            if (sqlType == Types.BLOB || sqlType == Types.BINARY || sqlType == Types.VARBINARY || sqlType == Types.LONGVARBINARY) {
                byte[] value = rs.getBytes(index);
                return rs.wasNull() ? null : JdbcExecutor.bytesToHex(value);
            }
            Object value = rs.getObject(index);
            return rs.wasNull() ? null : value == null ? null : value.toString();
        });
    }

    Object deferredResultValue(ResultSet rs, int index, int sqlType, String typeName) {
        String lobType = deferredLobType(sqlType, typeName);
        if (lobType == null) {
            return resultValue(rs, index, sqlType);
        }
        return unchecked(() -> {
            if ("BLOB".equals(lobType)) {
                Blob value = rs.getBlob(index);
                return value == null || rs.wasNull() ? null : "<BLOB>";
            }
            Clob value = rs.getClob(index);
            return value == null || rs.wasNull() ? null : "<" + lobType + ">";
        });
    }

    static QueryResult addDeferredLobMarkers(QueryResult result) {
        DeferredLobResult deferred = deferredLobResult(result.getColumns(), result.getColumn_types(), result.getRows());
        if (deferred == null) {
            return result;
        }
        result.setColumns(deferred.columns());
        result.setColumn_types(deferred.columnTypes());
        result.setRows(deferred.rows());
        return result;
    }

    static QueryPageResult addDeferredLobMarkers(QueryPageResult result) {
        DeferredLobResult deferred = deferredLobResult(result.getColumns(), result.getColumn_types(), result.getRows());
        if (deferred == null) {
            return result;
        }
        result.setColumns(deferred.columns());
        result.setColumn_types(deferred.columnTypes());
        result.setRows(deferred.rows());
        return result;
    }

    private static DeferredLobResult deferredLobResult(
        List<String> columns,
        List<String> columnTypes,
        List<List<Object>> rows
    ) {
        if (columns.size() != columnTypes.size()
            || columns.stream().anyMatch(column -> column.toUpperCase(Locale.ROOT).startsWith(LARGE_VALUE_BYTES_COLUMN_PREFIX))) {
            return null;
        }
        List<String> deferredTypes = new ArrayList<>(columnTypes.size());
        boolean hasDeferredLob = false;
        for (String columnType : columnTypes) {
            String lobType = deferredLobType(Types.OTHER, columnType);
            deferredTypes.add(lobType);
            hasDeferredLob |= lobType != null;
        }
        if (!hasDeferredLob) {
            return null;
        }

        List<String> expandedColumns = new ArrayList<>(columns.size() + deferredTypes.size());
        List<String> expandedColumnTypes = new ArrayList<>(columnTypes.size() + deferredTypes.size());
        for (int index = 0; index < columns.size(); index++) {
            expandedColumns.add(columns.get(index));
            expandedColumnTypes.add(columnTypes.get(index));
            String lobType = deferredTypes.get(index);
            if (lobType != null) {
                expandedColumns.add(LARGE_VALUE_BYTES_COLUMN_PREFIX + markerAliasKind(lobType) + "_" + index);
                expandedColumnTypes.add("VARCHAR");
            }
        }

        List<List<Object>> expandedRows = new ArrayList<>(rows.size());
        for (List<Object> row : rows) {
            List<Object> expandedRow = new ArrayList<>(expandedColumns.size());
            for (int index = 0; index < columns.size(); index++) {
                Object value = index < row.size() ? row.get(index) : null;
                expandedRow.add(value);
                if (deferredTypes.get(index) != null) {
                    expandedRow.add(value == null ? null : DEFERRED_LOB_MARKER);
                }
            }
            expandedRows.add(expandedRow);
        }
        return new DeferredLobResult(expandedColumns, expandedColumnTypes, expandedRows);
    }

    private static String deferredLobType(int sqlType, String typeName) {
        String normalized = typeName == null ? "" : typeName.trim().toUpperCase(Locale.ROOT);
        int parameterStart = normalized.indexOf('(');
        if (parameterStart >= 0) {
            normalized = normalized.substring(0, parameterStart).trim();
        }
        if (sqlType == Types.BLOB || "BLOB".equals(normalized)) {
            return "BLOB";
        }
        if ("DBCLOB".equals(normalized)) {
            return "DBCLOB";
        }
        if (sqlType == Types.CLOB || sqlType == Types.NCLOB || "CLOB".equals(normalized) || "NCLOB".equals(normalized)) {
            return "CLOB";
        }
        return null;
    }

    private static String markerAliasKind(String lobType) {
        return "BLOB".equals(lobType) ? "L" : "C";
    }

    private static boolean shouldDeferLobs(String sql, boolean requested) {
        return requested && !sql.toUpperCase(Locale.ROOT).contains(LARGE_VALUE_BYTES_COLUMN_PREFIX);
    }

    private static void rememberDeferredSession(Set<String> sessions, QueryPageResult result, boolean deferLobs) {
        if (deferLobs && result.getHas_more() && result.getSession_id() != null) {
            sessions.add(result.getSession_id());
        }
    }

    private static QueryPageResult finishDeferredPage(Set<String> sessions, String sessionId, QueryPageResult result) {
        if (!sessions.contains(sessionId)) {
            return result;
        }
        if (!result.getHas_more()) {
            sessions.remove(sessionId);
        }
        return addDeferredLobMarkers(result);
    }

    private record DeferredLobResult(
        List<String> columns,
        List<String> columnTypes,
        List<List<Object>> rows
    ) {}

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
