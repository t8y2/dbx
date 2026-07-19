package com.dbx.agent;

import java.sql.Connection;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLWarning;
import java.sql.SQLXML;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.function.Supplier;

public final class JdbcExecutor {
    public static final JdbcExecutor INSTANCE = new JdbcExecutor();
    public static final int DEFAULT_MAX_ROWS = 10000;
    public static final long QUERY_SESSION_IDLE_TIMEOUT_MILLIS = 10 * 60 * 1000L;

    private final ConcurrentHashMap<String, QuerySession> sessions = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, QuerySession> tableReadSessions = new ConcurrentHashMap<>();
    private final java.util.Set<Statement> activeStatements = ConcurrentHashMap.newKeySet();

    public JdbcExecutor() {
    }

    public static JdbcExecutor current() {
        return AgentExecutionContext.jdbcExecutor();
    }

    public QueryResult execute(Connection conn, String sql, String schema, Function<String, String> setSchemaSql) {
        return execute(conn, sql, schema, setSchemaSql, DEFAULT_MAX_ROWS, null, this::defaultResultValue);
    }

    public QueryResult execute(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        int maxRows,
        Integer fetchSize
    ) {
        return execute(conn, sql, schema, setSchemaSql, maxRows, fetchSize, this::defaultResultValue);
    }

    public QueryResult execute(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        int maxRows,
        Integer fetchSize,
        ResultValueReader valueReader
    ) {
        return execute(conn, sql, schema, setSchemaSql, maxRows, fetchSize, 0, valueReader);
    }

    public QueryResult execute(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        int maxRows,
        Integer fetchSize,
        int timeoutSecs,
        ResultValueReader valueReader
    ) {
        return execute(conn, sql, schema, setSchemaSql, () -> "", maxRows, fetchSize, timeoutSecs, valueReader);
    }

    public QueryResult execute(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql,
        int maxRows,
        Integer fetchSize,
        int timeoutSecs,
        ResultValueReader valueReader
    ) {
        return unchecked(() -> {
            String trimmedSql = trimSql(sql);
            long start = System.currentTimeMillis();

            applySchema(conn, schema, setSchemaSql, resetSchemaSql);

            try (Statement stmt = conn.createStatement()) {
                activeStatements.add(stmt);
                try {
                int effectiveMaxRows = Math.max(maxRows, 1);
                stmt.setMaxRows(effectiveMaxRows + 1);
                applyQueryTimeout(stmt, timeoutSecs);
                if (fetchSize != null && fetchSize > 0) {
                    stmt.setFetchSize(fetchSize);
                }
                // SQL dumps often contain BEGIN/COMMIT/ROLLBACK as executable statements.
                // Do not translate them to Connection.commit(), which requires autoCommit=false.
                boolean hasResultSet = stmt.execute(trimmedSql);
                long elapsed = System.currentTimeMillis() - start;
                QueryResult result;
                if (hasResultSet) {
                    try (ResultSet rs = stmt.getResultSet()) {
                        result = readResultSet(rs, elapsed, effectiveMaxRows, valueReader);
                    }
                } else {
                    int updateCount = stmt.getUpdateCount();
                    result = new QueryResult(
                        Collections.emptyList(),
                        Collections.emptyList(),
                        updateCount >= 0 ? updateCount : 0,
                        elapsed,
                        false
                    );
                }
                return withStatementWarnings(result, stmt);
                } finally {
                    activeStatements.remove(stmt);
                }
            }
        });
    }

    public QueryResult readResultSet(ResultSet rs, long executionTimeMs) {
        return readResultSet(rs, executionTimeMs, DEFAULT_MAX_ROWS, this::defaultResultValue);
    }

    public QueryResult readResultSet(
        ResultSet rs,
        long executionTimeMs,
        int maxRows,
        ResultValueReader valueReader
    ) {
        return unchecked(() -> {
            ResultSetMetaData meta = rs.getMetaData();
            int colCount = meta.getColumnCount();
            List<String> columns = new ArrayList<>(colCount);
            List<String> columnTypes = new ArrayList<>(colCount);
            // Cache JDBC column metadata once; some drivers resolve it lazily,
            // and row reading is the hot path.
            int[] sqlTypeByIndex = new int[colCount];
            String[] typeNameByIndex = new String[colCount];
            for (int i = 1; i <= colCount; i++) {
                columns.add(meta.getColumnLabel(i));
                sqlTypeByIndex[i - 1] = safeColumnSqlType(meta, i);
                String typeName = safeColumnTypeName(meta, i);
                columnTypes.add(typeName);
                typeNameByIndex[i - 1] = typeName;
            }

            List<List<Object>> rows = new ArrayList<>(initialRowCapacity(maxRows));
            boolean truncated = false;
            while (rs.next()) {
                if (rows.size() >= maxRows) {
                    truncated = true;
                    break;
                }
                rows.add(rowValues(rs, valueReader, sqlTypeByIndex, typeNameByIndex));
            }

            return new QueryResult(columns, columnTypes, rows, 0L, executionTimeMs, truncated);
        });
    }

    public QueryPageResult executePage(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql
    ) {
        return executePage(conn, sql, schema, setSchemaSql, new QueryPageOptions(), this::defaultResultValue);
    }

    public QueryPageResult executePage(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        QueryPageOptions options
    ) {
        return executePage(conn, sql, schema, setSchemaSql, options, this::defaultResultValue);
    }

    public QueryPageResult executePage(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        QueryPageOptions options,
        ResultValueReader valueReader
    ) {
        return executePage(conn, sql, schema, setSchemaSql, () -> "", options, valueReader, sessions);
    }

    public QueryPageResult executePage(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql,
        QueryPageOptions options,
        ResultValueReader valueReader
    ) {
        return executePage(conn, sql, schema, setSchemaSql, resetSchemaSql, options, valueReader, sessions);
    }

    public QueryPageResult startTableRead(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        QueryPageOptions options,
        ResultValueReader valueReader
    ) {
        return executePage(conn, sql, schema, setSchemaSql, () -> "", options, valueReader, tableReadSessions);
    }

    public QueryPageResult startTableRead(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql,
        QueryPageOptions options,
        ResultValueReader valueReader
    ) {
        return executePage(conn, sql, schema, setSchemaSql, resetSchemaSql, options, valueReader, tableReadSessions);
    }

    private QueryPageResult executePage(
        Connection conn,
        String sql,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql,
        QueryPageOptions options,
        ResultValueReader valueReader,
        ConcurrentHashMap<String, QuerySession> targetSessions
    ) {
        return unchecked(() -> {
            expireIdleSessions(targetSessions, System.currentTimeMillis(), QUERY_SESSION_IDLE_TIMEOUT_MILLIS);
            String trimmedSql = trimSql(sql);
            long start = System.currentTimeMillis();

            applySchema(conn, schema, setSchemaSql, resetSchemaSql);

            Statement stmt = conn.createStatement();
            activeStatements.add(stmt);
            try {
                applyQueryTimeout(stmt, options.getTimeoutSecs());
                if (options.getFetchSize() != null && options.getFetchSize() > 0) {
                    stmt.setFetchSize(options.getFetchSize());
                }
                // Keep script transaction-control statements in the SQL stream.
                // JDBC transaction APIs are reserved for executeTransaction.
                boolean hasResultSet = stmt.execute(trimmedSql);
                long elapsed = System.currentTimeMillis() - start;
                if (!hasResultSet) {
                    int updateCount = stmt.getUpdateCount();
                    activeStatements.remove(stmt);
                    stmt.close();
                    return new QueryPageResult(
                        Collections.emptyList(),
                        Collections.emptyList(),
                        updateCount >= 0 ? updateCount : 0,
                        elapsed
                    );
                }

                ResultSet rs = stmt.getResultSet();
                ResultSetMetaData meta = rs.getMetaData();
                String sessionId = UUID.randomUUID().toString();
                int colCount = meta.getColumnCount();
                List<String> columns = new ArrayList<>(colCount);
                List<String> columnTypes = new ArrayList<>(colCount);
                // Cache JDBC column metadata once; fetching a page should only read row values.
                int[] sqlTypeByIndex = new int[colCount];
                String[] typeNameByIndex = new String[colCount];
                for (int i = 1; i <= colCount; i++) {
                    columns.add(meta.getColumnLabel(i));
                    sqlTypeByIndex[i - 1] = safeColumnSqlType(meta, i);
                    String typeName = safeColumnTypeName(meta, i);
                    columnTypes.add(typeName);
                    typeNameByIndex[i - 1] = typeName;
                }
                QuerySession session = new QuerySession(
                    sessionId,
                    stmt,
                    rs,
                    columns,
                    columnTypes,
                    sqlTypeByIndex,
                    typeNameByIndex,
                    Math.max(options.getMaxRows(), 1),
                    valueReader
                );
                targetSessions.put(sessionId, session);
                return readSessionPage(targetSessions, session, options.getPageSize(), elapsed);
            } catch (Exception e) {
                activeStatements.remove(stmt);
                try {
                    stmt.close();
                } catch (Exception ignored) {
                }
                throw e;
            }
        });
    }

    public QueryPageResult fetchPage(String sessionId, int pageSize) {
        expireIdleQuerySessions();
        return fetchSessionPage(sessions, sessionId, pageSize, "Query session not found");
    }

    public boolean closeQuerySession(String sessionId) {
        return closeSession(sessions, sessionId);
    }

    public QueryPageResult fetchTableReadPage(String sessionId, int pageSize) {
        expireIdleTableReadSessions();
        return fetchSessionPage(tableReadSessions, sessionId, pageSize, "Table read session not found");
    }

    public boolean closeTableReadSession(String sessionId) {
        return closeSession(tableReadSessions, sessionId);
    }

    public void closeAllQuerySessions() {
        closeAllSessions(sessions);
    }

    public void closeAllTableReadSessions() {
        closeAllSessions(tableReadSessions);
    }

    public void cancelActiveStatements() {
        for (Statement statement : activeStatements) {
            try {
                statement.cancel();
            } catch (SQLException ignored) {
            }
        }
        // Paged result sets can remain idle between fetch requests, so no
        // Statement is executing when cancellation arrives. Close those
        // session-owned cursors as part of the same cancellation boundary.
        closeAllQuerySessions();
        closeAllTableReadSessions();
    }

    public int expireIdleQuerySessions() {
        return expireIdleQuerySessions(System.currentTimeMillis(), QUERY_SESSION_IDLE_TIMEOUT_MILLIS);
    }

    public int expireIdleQuerySessions(long nowMillis, long idleTimeoutMillis) {
        return expireIdleSessions(sessions, nowMillis, idleTimeoutMillis);
    }

    public int expireIdleTableReadSessions() {
        return expireIdleTableReadSessions(System.currentTimeMillis(), QUERY_SESSION_IDLE_TIMEOUT_MILLIS);
    }

    public int expireIdleTableReadSessions(long nowMillis, long idleTimeoutMillis) {
        return expireIdleSessions(tableReadSessions, nowMillis, idleTimeoutMillis);
    }

    private int expireIdleSessions(
        ConcurrentHashMap<String, QuerySession> targetSessions,
        long nowMillis,
        long idleTimeoutMillis
    ) {
        if (idleTimeoutMillis < 0) {
            return 0;
        }
        int closed = 0;
        List<QuerySession> snapshot = new ArrayList<>(targetSessions.values());
        for (QuerySession session : snapshot) {
            boolean expired;
            synchronized (session) {
                expired = nowMillis - session.lastAccessedAtMillis >= idleTimeoutMillis;
            }
            if (expired && closeSession(targetSessions, session.id)) {
                closed += 1;
            }
        }
        return closed;
    }

    public Object defaultResultValue(ResultSet rs, int index, int sqlType) throws SQLException {
        Object value;
        switch (sqlType) {
            case Types.BIGINT:
                value = rs.getLong(index);
                break;
            case Types.INTEGER:
            case Types.SMALLINT:
            case Types.TINYINT:
                value = rs.getInt(index);
                break;
            case Types.FLOAT:
            case Types.REAL:
                value = rs.getFloat(index);
                break;
            case Types.DOUBLE:
                value = rs.getDouble(index);
                break;
            case Types.DECIMAL:
            case Types.NUMERIC:
                value = rs.getBigDecimal(index);
                break;
            case Types.BOOLEAN:
            case Types.BIT:
                value = rs.getBoolean(index);
                break;
            case Types.CHAR:
            case Types.VARCHAR:
            case Types.LONGVARCHAR:
            case Types.NCHAR:
            case Types.NVARCHAR:
            case Types.LONGNVARCHAR:
            case Types.CLOB:
            case Types.NCLOB:
                value = rs.getString(index);
                break;
            case Types.BINARY:
            case Types.VARBINARY:
            case Types.LONGVARBINARY:
            case Types.BLOB:
                value = bytesToHex(rs.getBytes(index));
                break;
            case Types.SQLXML:
                value = sqlXmlToString(rs.getSQLXML(index));
                break;
            default:
                value = normalizeResultValue(rs.getObject(index));
                break;
        }
        return rs.wasNull() ? null : value;
    }

    public static Object stringResultValue(ResultSet rs, int index, int sqlType) throws SQLException {
        Object value;
        switch (sqlType) {
            case Types.BINARY:
            case Types.VARBINARY:
            case Types.LONGVARBINARY:
            case Types.BLOB:
                value = bytesToHex(rs.getBytes(index));
                break;
            case Types.SQLXML:
                value = sqlXmlToString(rs.getSQLXML(index));
                break;
            default:
                value = rs.getString(index);
                break;
        }
        return rs.wasNull() ? null : value;
    }

    public static Object normalizeResultValue(Object value) throws SQLException {
        if (value == null) {
            return null;
        }
        if (value instanceof Clob) {
            Clob clob = (Clob) value;
            return clob.getSubString(1, Math.toIntExact(clob.length()));
        }
        if (value instanceof Blob) {
            Blob blob = (Blob) value;
            return bytesToHex(blob.getBytes(1, Math.toIntExact(blob.length())));
        }
        if (value instanceof SQLXML) {
            SQLXML sqlxml = (SQLXML) value;
            return sqlxml.getString();
        }
        if (value instanceof byte[]) {
            byte[] bytes = (byte[]) value;
            return bytesToHex(bytes);
        }
        return value instanceof Number || value instanceof Boolean ? value : value.toString();
    }

    public static String bytesToHex(byte[] bytes) {
        if (bytes == null) {
            return null;
        }
        StringBuilder result = new StringBuilder(bytes.length * 2 + 2);
        result.append("0x");
        for (byte b : bytes) {
            result.append(Character.forDigit((b >> 4) & 0xF, 16));
            result.append(Character.forDigit(b & 0xF, 16));
        }
        return result.toString();
    }

    private static String sqlXmlToString(SQLXML value) throws SQLException {
        return value == null ? null : value.getString();
    }

    private QueryPageResult fetchSessionPage(
        ConcurrentHashMap<String, QuerySession> targetSessions,
        String sessionId,
        int pageSize,
        String missingMessage
    ) {
        QuerySession session = targetSessions.get(sessionId);
        if (session == null) {
            throw new IllegalArgumentException(missingMessage);
        }
        synchronized (session) {
            return readSessionPage(targetSessions, session, pageSize, 0L);
        }
    }

    private QueryPageResult readSessionPage(
        ConcurrentHashMap<String, QuerySession> targetSessions,
        QuerySession session,
        int pageSize,
        long executionTimeMs
    ) {
        return unchecked(() -> {
            session.lastAccessedAtMillis = System.currentTimeMillis();
            int effectivePageSize = Math.max(pageSize, 1);
            List<List<Object>> rows = new ArrayList<>(initialRowCapacity(effectivePageSize));

            if (session.pendingRow != null) {
                rows.add(session.pendingRow);
                session.pendingRow = null;
            }

            while (rows.size() < effectivePageSize && session.rowsRead < session.maxRows) {
                if (!session.resultSet.next()) {
                    closeSession(targetSessions, session.id);
                    return new QueryPageResult(session.columns, session.columnTypes, rows, 0L, executionTimeMs, false, null, false);
                }
                rows.add(rowValues(session.resultSet, session.valueReader, session.sqlTypeByIndex, session.typeNameByIndex));
                session.rowsRead += 1;
            }

            if (session.rowsRead >= session.maxRows) {
                boolean truncated = session.resultSet.next();
                closeSession(targetSessions, session.id);
                return new QueryPageResult(session.columns, session.columnTypes, rows, 0L, executionTimeMs, truncated, null, false);
            }

            boolean hasMore = session.resultSet.next();
            if (!hasMore) {
                closeSession(targetSessions, session.id);
                return new QueryPageResult(session.columns, session.columnTypes, rows, 0L, executionTimeMs, false, null, false);
            }

            session.pendingRow = rowValues(session.resultSet, session.valueReader, session.sqlTypeByIndex, session.typeNameByIndex);
            session.rowsRead += 1;
            return new QueryPageResult(session.columns, session.columnTypes, rows, 0L, executionTimeMs, false, session.id, true);
        });
    }

    private void closeAllSessions(ConcurrentHashMap<String, QuerySession> targetSessions) {
        List<String> ids = new ArrayList<>(targetSessions.keySet());
        for (String id : ids) {
            closeSession(targetSessions, id);
        }
    }

    private boolean closeSession(ConcurrentHashMap<String, QuerySession> targetSessions, String sessionId) {
        QuerySession session = targetSessions.remove(sessionId);
        if (session == null) {
            return false;
        }
        synchronized (session) {
            activeStatements.remove(session.statement);
            try {
                session.resultSet.close();
            } catch (Exception ignored) {
            }
            try {
                session.statement.close();
            } catch (Exception ignored) {
            }
        }
        return true;
    }

    static String safeColumnTypeName(ResultSetMetaData meta, int columnIndex) {
        try {
            String name = meta.getColumnTypeName(columnIndex);
            return name == null ? "" : name;
        } catch (SQLException ignored) {
            return "";
        }
    }

    static int safeColumnSqlType(ResultSetMetaData meta, int columnIndex) {
        try {
            return meta.getColumnType(columnIndex);
        } catch (SQLException ignored) {
            return Types.OTHER;
        }
    }

    private List<Object> rowValues(
        ResultSet rs,
        ResultValueReader valueReader,
        int[] sqlTypeByIndex,
        String[] typeNameByIndex
    ) throws SQLException {
        int colCount = sqlTypeByIndex.length;
        List<Object> row = new ArrayList<>(colCount);
        for (int i = 1; i <= colCount; i++) {
            int sqlType = sqlTypeByIndex[i - 1];
            Object value;
            if (valueReader instanceof ColumnAwareResultValueReader) {
                String typeName = typeNameByIndex != null && i - 1 < typeNameByIndex.length
                    ? typeNameByIndex[i - 1]
                    : "";
                value = ((ColumnAwareResultValueReader) valueReader).read(rs, i, sqlType, typeName);
            } else {
                value = valueReader.read(rs, i, sqlType);
            }
            row.add(value);
        }
        return row;
    }

    private static int initialRowCapacity(int requestedRows) {
        if (requestedRows <= 0) {
            return 0;
        }
        return Math.min(requestedRows, 1024);
    }

    private void applySchema(
        Connection conn,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql
    ) throws SQLException {
        try {
            JdbcSchemaSwitcher.apply(conn, schema, setSchemaSql, resetSchemaSql);
        } catch (SQLException e) {
            throw e;
        } catch (Exception e) {
            throw new SQLException(e);
        }
    }

    private static void applyQueryTimeout(Statement stmt, int timeoutSecs) throws SQLException {
        if (timeoutSecs > 0) {
            stmt.setQueryTimeout(timeoutSecs);
        }
    }

    private static QueryResult withStatementWarnings(QueryResult result, Statement stmt) {
        if (!result.getColumns().isEmpty() || !result.getRows().isEmpty()) {
            return result;
        }

        List<List<Object>> rows = new ArrayList<>();
        try {
            Set<SQLWarning> seen = Collections.newSetFromMap(new IdentityHashMap<>());
            for (SQLWarning warning = stmt.getWarnings(); warning != null && seen.add(warning); warning = warning.getNextWarning()) {
                String message = warning.getMessage();
                if (message != null && !message.trim().isEmpty()) {
                    rows.add(Collections.singletonList(message));
                }
            }
            stmt.clearWarnings();
        } catch (SQLException ignored) {
            // Warning retrieval is advisory; a driver bug here must not turn a
            // successfully executed statement into a query failure.
        }

        if (rows.isEmpty()) {
            return result;
        }
        return new QueryResult(
            Collections.singletonList("Message"),
            Collections.singletonList("nvarchar"),
            rows,
            result.getAffected_rows(),
            result.getExecution_time_ms(),
            result.getTruncated()
        );
    }

    private QueryResult emptyQueryResult(long start) {
        return new QueryResult(
            Collections.emptyList(),
            Collections.emptyList(),
            0L,
            System.currentTimeMillis() - start
        );
    }

    private QueryPageResult emptyQueryPageResult(long start) {
        return new QueryPageResult(
            Collections.emptyList(),
            Collections.emptyList(),
            0L,
            System.currentTimeMillis() - start
        );
    }

    static String trimSql(String sql) {
        String trimmed = stripTrailingSlashDelimiter(sql.trim());
        if (isPlSqlBlock(trimmed)) {
            return trimmed;
        }
        while (trimmed.endsWith(";")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1).trim();
        }
        return trimmed;
    }

    private static String stripTrailingSlashDelimiter(String sql) {
        String trimmed = sql.trim();
        if (!trimmed.endsWith("/")) {
            return trimmed;
        }
        int slashStart = trimmed.length() - 1;
        int lineStart = trimmed.lastIndexOf('\n', slashStart - 1) + 1;
        if (!trimmed.substring(lineStart, slashStart).trim().isEmpty()) {
            return trimmed;
        }
        String beforeSlash = trimmed.substring(0, lineStart).trim();
        return isPlSqlBlock(beforeSlash) ? beforeSlash : trimmed;
    }

    private static boolean isPlSqlBlock(String sql) {
        String upperSql = sql.toUpperCase(Locale.ROOT).trim();
        if (!upperSql.startsWith("DECLARE") && !upperSql.startsWith("BEGIN")) {
            return false;
        }
        return upperSql.matches("(?s).*\\bEND\\s+(?!IF\\b|LOOP\\b|CASE\\b)[A-Z0-9_$#]+\\s*;\\s*$")
            || upperSql.matches("(?s).*\\bEND\\s*;\\s*$");
    }

    private static <T> T unchecked(ThrowingSupplier<T> supplier) {
        try {
            return supplier.get();
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @FunctionalInterface
    public interface ResultValueReader {
        Object read(ResultSet rs, int index, int sqlType) throws SQLException;
    }

    /**
     * Optional extension of {@link ResultValueReader} that exposes the JDBC
     * {@code getColumnTypeName} alongside the SQL type code, allowing per-driver
     * agents to convert vendor-specific column types (e.g. PostGIS
     * {@code geometry}) without re-querying the metadata.
     */
    public interface ColumnAwareResultValueReader extends ResultValueReader {
        Object read(ResultSet rs, int index, int sqlType, String columnTypeName) throws SQLException;

        @Override
        default Object read(ResultSet rs, int index, int sqlType) throws SQLException {
            return read(rs, index, sqlType, safeColumnTypeName(rs.getMetaData(), index));
        }
    }

    private interface ThrowingSupplier<T> {
        T get() throws Exception;
    }

    private static final class QuerySession {
        private final String id;
        private final Statement statement;
        private final ResultSet resultSet;
        private final List<String> columns;
        private final List<String> columnTypes;
        private final int[] sqlTypeByIndex;
        private final String[] typeNameByIndex;
        private final int maxRows;
        private final ResultValueReader valueReader;
        private int rowsRead;
        private List<Object> pendingRow;
        private long lastAccessedAtMillis;

        private QuerySession(
            String id,
            Statement statement,
            ResultSet resultSet,
            List<String> columns,
            List<String> columnTypes,
            int[] sqlTypeByIndex,
            String[] typeNameByIndex,
            int maxRows,
            ResultValueReader valueReader
        ) {
            this.id = id;
            this.statement = statement;
            this.resultSet = resultSet;
            this.columns = columns;
            this.columnTypes = columnTypes;
            this.sqlTypeByIndex = sqlTypeByIndex;
            this.typeNameByIndex = typeNameByIndex;
            this.maxRows = maxRows;
            this.valueReader = valueReader;
            this.lastAccessedAtMillis = System.currentTimeMillis();
        }
    }
}
