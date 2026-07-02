package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.URLEncoder;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Date;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.lang.reflect.Method;
import java.sql.Statement;
import java.sql.Time;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.temporal.TemporalAccessor;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.UUID;
import java.util.logging.Logger;

public final class DbxJdbcPlugin {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int MAX_ROWS = 10_000;
    private static final String[] DEFAULT_TABLE_TYPES = new String[] {
        "TABLE",
        "VIEW",
        "BASE TABLE",
        "MATERIALIZED VIEW",
        "SYSTEM TABLE",
        "SYSTEM VIEW"
    };
    private static final JdbcDriverQuirks DEFAULT_QUIRKS = new JdbcDriverQuirks(
        false,
        false,
        false,
        false,
        false,
        false,
        StatementMaxRowsMode.READ_LOOP_ONLY
    );
    private static final JdbcDriverQuirks USE_CATALOG_QUIRKS = DEFAULT_QUIRKS.withUseCatalogFallbackSql(true);
    private static final JdbcDriverQuirks KINGBASE_QUIRKS = DEFAULT_QUIRKS.withIgnoreCatalogForSchemaMetadata(true);
    private static final JdbcDriverQuirks TAOS_QUIRKS = DEFAULT_QUIRKS.withPreferExecuteQueryForResultSetSql(true);
    private static final JdbcDriverQuirks YASHAN_QUIRKS = new JdbcDriverQuirks(
        true,
        true,
        false,
        false,
        false,
        false,
        StatementMaxRowsMode.APPLY_STATEMENT_MAX_ROWS
    );
    private static final JdbcDriverQuirks IRIS_QUIRKS = new JdbcDriverQuirks(
        true,
        false,
        true,
        false,
        false,
        false,
        StatementMaxRowsMode.READ_LOOP_ONLY
    );
    private static final JdbcDriverQuirks ORACLE_QUIRKS = new JdbcDriverQuirks(
        false,
        true,
        false,
        false,
        false,
        false,
        StatementMaxRowsMode.APPLY_STATEMENT_MAX_ROWS
    );
    private static final List<JdbcDriverQuirkRule> DRIVER_QUIRK_RULES = List.of(
        new JdbcDriverQuirkRule("jdbc:mysql:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:mariadb:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:starrocks:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:doris:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:hive2:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:kingbase", KINGBASE_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:yasdb:", YASHAN_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:iris:", IRIS_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:oracle:", ORACLE_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:dm:", ORACLE_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:taos:", TAOS_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:taos-ws:", TAOS_QUIRKS)
    );
    private static String registeredDriverKey = "";
    private static String sharedConnectionKey = "";
    private static Connection sharedConnection;
    private static final Map<String, QuerySession> QUERY_SESSIONS = new HashMap<>();

    record JdbcDriverQuirks(
        boolean skipExecutionContext,
        boolean useOracleMetadata,
        boolean caseInsensitiveSchemaMetadata,
        boolean useCatalogFallbackSql,
        boolean ignoreCatalogForSchemaMetadata,
        boolean preferExecuteQueryForResultSetSql,
        StatementMaxRowsMode statementMaxRowsMode
    ) {
        JdbcDriverQuirks withUseCatalogFallbackSql(boolean value) {
            return new JdbcDriverQuirks(
                skipExecutionContext,
                useOracleMetadata,
                caseInsensitiveSchemaMetadata,
                value,
                ignoreCatalogForSchemaMetadata,
                preferExecuteQueryForResultSetSql,
                statementMaxRowsMode
            );
        }

        JdbcDriverQuirks withIgnoreCatalogForSchemaMetadata(boolean value) {
            return new JdbcDriverQuirks(
                skipExecutionContext,
                useOracleMetadata,
                caseInsensitiveSchemaMetadata,
                useCatalogFallbackSql,
                value,
                preferExecuteQueryForResultSetSql,
                statementMaxRowsMode
            );
        }

        JdbcDriverQuirks withPreferExecuteQueryForResultSetSql(boolean value) {
            return new JdbcDriverQuirks(
                skipExecutionContext,
                useOracleMetadata,
                caseInsensitiveSchemaMetadata,
                useCatalogFallbackSql,
                ignoreCatalogForSchemaMetadata,
                value,
                statementMaxRowsMode
            );
        }
    }

    enum StatementMaxRowsMode {
        APPLY_STATEMENT_MAX_ROWS,
        READ_LOOP_ONLY
    }

    private record JdbcDriverQuirkRule(String urlPrefix, JdbcDriverQuirks quirks) {
    }

    private DbxJdbcPlugin() {
    }

    public static void main(String[] args) throws Exception {
        try (
            BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8))
        ) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                ObjectNode response = handleLine(line);
                writer.write(MAPPER.writeValueAsString(response));
                writer.newLine();
                writer.flush();
                if (response.path("_dbx_close").asBoolean(false)) {
                    break;
                }
            }
        } finally {
            closeSharedConnection();
        }
    }

    private static ObjectNode handleLine(String line) throws Exception {
        JsonNode request = MAPPER.readTree(line);
        JsonNode id = request.path("id");
        ObjectNode response = MAPPER.createObjectNode();
        response.set("id", id.isMissingNode() ? MAPPER.getNodeFactory().numberNode(1) : id);

        try {
            String method = requireText(request, "method");
            JsonNode params = request.path("params");
            JsonNode connection = params.path("connection");
            if ("close".equals(method)) {
                closeSharedConnection();
                ObjectNode result = MAPPER.createObjectNode();
                result.put("ok", true);
                response.set("result", result);
                response.put("_dbx_close", true);
                return response;
            }
            registerDrivers(connection);
            response.set("result", handle(method, params, connection));
        } catch (Exception error) {
            ObjectNode errorNode = MAPPER.createObjectNode();
            errorNode.put("message", error.getMessage() == null ? error.toString() : error.getMessage());
            response.set("error", errorNode);
        }
        return response;
    }

    private static JsonNode handle(String method, JsonNode params, JsonNode connection) throws Exception {
        return switch (method) {
            case "testConnection", "connect" -> {
                openConnection(connection);
                ObjectNode result = MAPPER.createObjectNode();
                result.put("ok", true);
                yield result;
            }
            case "executeQuery" -> executeQuery(
                connection,
                requireText(params, "sql"),
                optionalText(params, "database"),
                optionalText(params, "schema"),
                positiveInt(params, "maxRows", MAX_ROWS),
                nonNegativeInt(params, "fetchSize", 0),
                nonNegativeInt(params, "timeoutSecs", -1)
            );
            case "executeQueryPage", "execute_query_page" -> executeQueryPage(
                connection,
                requireText(params, "sql"),
                optionalText(params, "database"),
                optionalText(params, "schema"),
                positiveInt(params, "pageSize", 100),
                positiveInt(params, "maxRows", MAX_ROWS),
                nonNegativeInt(params, "fetchSize", 0),
                nonNegativeInt(params, "timeoutSecs", -1)
            );
            case "fetchQueryPage", "fetch_query_page" -> fetchQueryPage(
                requireText(params, "sessionId"),
                positiveInt(params, "pageSize", 100)
            );
            case "closeQuerySession", "close_query_session" -> closeQuerySessionResult(requireText(params, "sessionId"));
            case "listDatabases" -> listDatabases(connection);
            case "listSchemas" -> listSchemas(connection, optionalText(params, "database"));
            case "listTables" -> listTables(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema"),
                optionalText(params, "filter"),
                nonNegativeInt(params, "limit", 0)
            );
            case "listObjects", "list_objects" -> listObjects(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema")
            );
            case "listDataTypes", "list_data_types" -> listDataTypes(connection, optionalText(params, "database"));
            case "getObjectSource", "get_object_source" -> getObjectSource(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema"),
                requireText(params, "name"),
                requireText(params, "object_type")
            );
            case "getColumns" -> getColumns(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema"),
                requireText(params, "table")
            );
            case "getExplainInfo" -> getExplainInfo(
                connection,
                requireText(params, "sql"),
                optionalText(params, "database"),
                optionalText(params, "schema"),
                nonNegativeInt(params, "timeoutSecs", -1),
                optionalText(params, "mode")
            );
            default -> throw new IllegalArgumentException("Unsupported JDBC plugin method: " + method);
        };
    }

    private static void registerDrivers(JsonNode connection) throws Exception {
        String driverKey = driverKey(connection);
        if (driverKey.equals(registeredDriverKey)) {
            return;
        }
        closeSharedConnection();
        List<URL> urls = new ArrayList<>();
        JsonNode paths = connection.path("jdbc_driver_paths");
        if (paths.isArray()) {
            for (JsonNode path : paths) {
                String value = path.asText("").trim();
                if (!value.isEmpty()) {
                    urls.add(expandHome(value).toUri().toURL());
                }
            }
        }

        ClassLoader loader = urls.isEmpty()
            ? Thread.currentThread().getContextClassLoader()
            : new URLClassLoader(urls.toArray(URL[]::new), DbxJdbcPlugin.class.getClassLoader());
        Thread.currentThread().setContextClassLoader(loader);

        String driverClass = optionalText(connection, "jdbc_driver_class");
        if (driverClass != null) {
            Driver driver = (Driver) Class.forName(driverClass, true, loader).getDeclaredConstructor().newInstance();
            DriverManager.registerDriver(new DriverShim(driver));
            registeredDriverKey = driverKey;
            return;
        }

        boolean loaded = false;
        for (Driver driver : ServiceLoader.load(Driver.class, loader)) {
            DriverManager.registerDriver(new DriverShim(driver));
            loaded = true;
        }
        if (!loaded && !urls.isEmpty()) {
            throw new IllegalArgumentException("No JDBC driver was discovered. Enter the driver class name for this JAR.");
        }
        registeredDriverKey = driverKey;
    }

    private static Connection openConnection(JsonNode connection) throws SQLException {
        String url = jdbcUrl(connection);
        if (url == null) {
            throw new IllegalArgumentException("JDBC URL is required.");
        }
        String key = connectionKey(connection);
        if (sharedConnection != null && key.equals(sharedConnectionKey) && !sharedConnection.isClosed()) {
            return sharedConnection;
        }
        closeSharedConnection();

        Properties properties = new Properties();
        String username = optionalText(connection, "username");
        String password = optionalText(connection, "password");
        if (username != null) {
            properties.setProperty("user", username);
        }
        if (password != null) {
            properties.setProperty("password", password);
        }
        applyConnectTimeout(connection, properties);
        if (isOracleUrl(url)) {
            applyOracleProperties(connection, properties);
        }
        sharedConnection = DriverManager.getConnection(url, properties);
        sharedConnectionKey = key;
        return sharedConnection;
    }

    private static void applyConnectTimeout(JsonNode connection, Properties properties) {
        int connectTimeoutSecs = positiveInt(connection, "connect_timeout_secs", 30);
        DriverManager.setLoginTimeout(connectTimeoutSecs);
        if (isPrestoOrTrinoConnection(connection)) {
            return;
        }
        String value = Integer.toString(connectTimeoutSecs);
        properties.putIfAbsent("loginTimeout", value);
        properties.putIfAbsent("connectTimeout", value);
    }

    private static boolean isPrestoOrTrinoConnection(JsonNode connection) {
        String url = jdbcUrl(connection);
        if (urlMatchesPrefix(url, "jdbc:presto:") || urlMatchesPrefix(url, "jdbc:trino:")) {
            return true;
        }
        String driverClass = optionalText(connection, "jdbc_driver_class");
        if (driverClass == null) {
            return false;
        }
        String normalized = driverClass.toLowerCase(Locale.ROOT);
        return normalized.equals("io.prestosql.jdbc.prestodriver") ||
            normalized.equals("com.facebook.presto.jdbc.prestodriver") ||
            normalized.equals("io.trino.jdbc.trinodriver");
    }

    private static void applyOracleProperties(JsonNode connection, Properties properties) {
        properties.putIfAbsent("remarksReporting", "false");
        properties.putIfAbsent("restrictGetTables", "true");
        properties.putIfAbsent("includeSynonyms", "false");
        properties.putIfAbsent("oracle.jdbc.defaultRowPrefetch", "100");
        if (connection.path("sysdba").asBoolean(false)) {
            properties.putIfAbsent("internal_logon", "sysdba");
        }
    }

    private static JsonNode executeQuery(
        JsonNode connection,
        String sql,
        String database,
        String schema,
        int maxRows,
        int fetchSize,
        int timeoutSecs
    ) throws Exception {
        long start = System.nanoTime();
        Connection conn = openConnection(connection);
        applyExecutionContext(connection, conn, database, schema);
        JdbcDriverQuirks quirks = driverQuirks(connection);
        try (Statement statement = conn.createStatement()) {
            applyStatementOptions(statement, maxRows, fetchSize, timeoutSecs, quirks);
            String trimmedSql = trimStatementSql(sql);
            ExecutedStatement executed = executeStatementForResult(statement, trimmedSql, quirks);
            ObjectNode result = MAPPER.createObjectNode();
            ArrayNode columns = MAPPER.createArrayNode();
            ArrayNode rows = MAPPER.createArrayNode();
            boolean truncated = false;

            try (ResultSet rs = executed.resultSet()) {
                if (rs != null) {
                    ResultSetMetaData meta = rs.getMetaData();
                    int columnCount = meta.getColumnCount();
                    for (int i = 1; i <= columnCount; i++) {
                        String label = meta.getColumnLabel(i);
                        columns.add(label == null || label.isBlank() ? meta.getColumnName(i) : label);
                    }
                    while (rs.next()) {
                        if (rows.size() >= maxRows) {
                            truncated = true;
                            break;
                        }
                        ArrayNode row = MAPPER.createArrayNode();
                        for (int i = 1; i <= columnCount; i++) {
                            row.add(MAPPER.valueToTree(readValue(rs, meta, i)));
                        }
                        rows.add(row);
                    }
                }
            }

            result.set("columns", columns);
            result.set("rows", rows);
            result.put("affected_rows", columns.isEmpty() ? Math.max(executed.updateCount(), 0) : 0);
            result.put("execution_time_ms", (System.nanoTime() - start) / 1_000_000);
            result.put("truncated", truncated);
            return result;
        }
    }

    private record ExecutedStatement(ResultSet resultSet, int updateCount) {
    }

    private static final class QuerySession {
        private final String id;
        private final Statement statement;
        private final ResultSet resultSet;
        private final ResultSetMetaData meta;
        private final ArrayNode columns;
        private final int maxRows;
        private final long startNanos;
        private int rowsReturned;
        private ArrayNode pendingRow;

        private QuerySession(
            String id,
            Statement statement,
            ResultSet resultSet,
            ResultSetMetaData meta,
            ArrayNode columns,
            int maxRows,
            long startNanos
        ) {
            this.id = id;
            this.statement = statement;
            this.resultSet = resultSet;
            this.meta = meta;
            this.columns = columns;
            this.maxRows = Math.max(1, maxRows);
            this.startNanos = startNanos;
        }
    }

    private static JsonNode executeQueryPage(
        JsonNode connection,
        String sql,
        String database,
        String schema,
        int pageSize,
        int maxRows,
        int fetchSize,
        int timeoutSecs
    ) throws Exception {
        long start = System.nanoTime();
        Connection conn = openConnection(connection);
        applyExecutionContext(connection, conn, database, schema);
        JdbcDriverQuirks quirks = driverQuirks(connection);
        Statement statement = conn.createStatement();
        try {
            applyStatementOptions(statement, maxRows, fetchSize, timeoutSecs, quirks);
            String trimmedSql = trimStatementSql(sql);
            ExecutedStatement executed = executeStatementForResult(statement, trimmedSql, quirks);
            ResultSet rs = executed.resultSet();
            if (rs == null) {
                ObjectNode result = MAPPER.createObjectNode();
                result.set("columns", MAPPER.createArrayNode());
                result.set("rows", MAPPER.createArrayNode());
                result.put("affected_rows", Math.max(executed.updateCount(), 0));
                result.put("execution_time_ms", (System.nanoTime() - start) / 1_000_000);
                result.put("truncated", false);
                result.putNull("session_id");
                result.put("has_more", false);
                statement.close();
                return result;
            }

            ResultSetMetaData meta = rs.getMetaData();
            ArrayNode columns = MAPPER.createArrayNode();
            int columnCount = meta.getColumnCount();
            for (int i = 1; i <= columnCount; i++) {
                String label = meta.getColumnLabel(i);
                columns.add(label == null || label.isBlank() ? meta.getColumnName(i) : label);
            }
            String sessionId = UUID.randomUUID().toString();
            QuerySession session = new QuerySession(sessionId, statement, rs, meta, columns, maxRows, start);
            QUERY_SESSIONS.put(sessionId, session);
            return readQuerySessionPage(session, pageSize);
        } catch (Exception error) {
            try {
                statement.close();
            } catch (Exception ignored) {
            }
            throw error;
        }
    }

    private static JsonNode fetchQueryPage(String sessionId, int pageSize) throws SQLException {
        QuerySession session = QUERY_SESSIONS.get(sessionId);
        if (session == null) {
            throw new IllegalArgumentException("Unknown query session: " + sessionId);
        }
        return readQuerySessionPage(session, pageSize);
    }

    private static JsonNode readQuerySessionPage(QuerySession session, int pageSize) throws SQLException {
        int effectivePageSize = Math.max(1, pageSize);
        ArrayNode rows = MAPPER.createArrayNode();
        boolean truncated = false;

        while (rows.size() < effectivePageSize && session.rowsReturned < session.maxRows) {
            ArrayNode row;
            if (session.pendingRow != null) {
                row = session.pendingRow;
                session.pendingRow = null;
            } else {
                if (!session.resultSet.next()) {
                    closeQuerySession(session.id);
                    return queryPageResult(session, rows, false, false);
                }
                row = readRow(session.resultSet, session.meta);
            }
            rows.add(row);
            session.rowsReturned++;
        }

        if (session.rowsReturned >= session.maxRows) {
            truncated = session.pendingRow != null || session.resultSet.next();
            closeQuerySession(session.id);
            return queryPageResult(session, rows, truncated, false);
        }

        boolean hasMore = session.resultSet.next();
        if (!hasMore) {
            closeQuerySession(session.id);
            return queryPageResult(session, rows, false, false);
        }

        session.pendingRow = readRow(session.resultSet, session.meta);
        return queryPageResult(session, rows, false, true);
    }

    private static ObjectNode queryPageResult(QuerySession session, ArrayNode rows, boolean truncated, boolean hasMore) {
        ObjectNode result = MAPPER.createObjectNode();
        result.set("columns", session.columns.deepCopy());
        result.set("rows", rows);
        result.put("affected_rows", 0);
        result.put("execution_time_ms", (System.nanoTime() - session.startNanos) / 1_000_000);
        result.put("truncated", truncated);
        if (hasMore) {
            result.put("session_id", session.id);
        } else {
            result.putNull("session_id");
        }
        result.put("has_more", hasMore);
        return result;
    }

    private static ObjectNode closeQuerySessionResult(String sessionId) {
        ObjectNode result = MAPPER.createObjectNode();
        result.put("ok", closeQuerySession(sessionId));
        return result;
    }

    private static boolean closeQuerySession(String sessionId) {
        QuerySession session = QUERY_SESSIONS.remove(sessionId);
        if (session == null) {
            return false;
        }
        try {
            session.resultSet.close();
        } catch (Exception ignored) {
        }
        try {
            session.statement.close();
        } catch (Exception ignored) {
        }
        return true;
    }

    private static void closeAllQuerySessions() {
        List<String> sessionIds = new ArrayList<>(QUERY_SESSIONS.keySet());
        for (String sessionId : sessionIds) {
            closeQuerySession(sessionId);
        }
    }

    private static ArrayNode readRow(ResultSet rs, ResultSetMetaData meta) throws SQLException {
        ArrayNode row = MAPPER.createArrayNode();
        for (int i = 1; i <= meta.getColumnCount(); i++) {
            row.add(MAPPER.valueToTree(readValue(rs, meta, i)));
        }
        return row;
    }

    private static ExecutedStatement executeStatementForResult(
        Statement statement,
        String sql,
        JdbcDriverQuirks quirks
    ) throws SQLException {
        if (quirks.preferExecuteQueryForResultSetSql() && looksLikeResultSetSql(sql)) {
            return new ExecutedStatement(statement.executeQuery(sql), -1);
        }
        boolean hasResultSet = statement.execute(sql);
        int updateCount = hasResultSet ? -1 : statement.getUpdateCount();
        ResultSet rs = hasResultSet ? statement.getResultSet() : null;
        if (rs == null && shouldRetryWithExecuteQuery(sql, hasResultSet, updateCount)) {
            rs = statement.executeQuery(sql);
        }
        return new ExecutedStatement(rs, updateCount);
    }

    private static boolean shouldRetryWithExecuteQuery(String sql, boolean hasResultSet, int updateCount) {
        if (hasResultSet) {
            return true;
        }
        return updateCount < 0 && looksLikeResultSetSql(sql);
    }

    static boolean looksLikeResultSetSql(String sql) {
        String keyword = firstSqlKeyword(sql);
        return switch (keyword) {
            case "SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE", "PRAGMA" -> true;
            default -> false;
        };
    }

    private static String firstSqlKeyword(String sql) {
        String text = stripLeadingSqlComments(sql).trim();
        int end = 0;
        while (end < text.length() && Character.isLetter(text.charAt(end))) {
            end++;
        }
        return text.substring(0, end).toUpperCase(Locale.ROOT);
    }

    private static String stripLeadingSqlComments(String sql) {
        String text = sql.trim();
        boolean changed;
        do {
            changed = false;
            if (text.startsWith("--")) {
                int lineEnd = text.indexOf('\n');
                if (lineEnd < 0) {
                    return "";
                }
                text = text.substring(lineEnd + 1).trim();
                changed = true;
            } else if (text.startsWith("/*")) {
                int commentEnd = text.indexOf("*/", 2);
                if (commentEnd < 0) {
                    return "";
                }
                text = text.substring(commentEnd + 2).trim();
                changed = true;
            }
        } while (changed);
        return text;
    }

    /**
     * Get DM execution plan using DmdbConnection.getExplainInfo() via reflection.
     *
     * Two modes:
     *   mode="explain" (default) — dmConn.getExplainInfo(sqlStr) — direct plan, no execution
     *   mode="autotrace"         — execute SQL, then dmConn.getExplainInfo(stmt) — actual stats
     *
     * Falls back to standard EXPLAIN if DM driver is not available.
     */
    private static JsonNode getExplainInfo(
        JsonNode connection,
        String sql,
        String database,
        String schema,
        int timeoutSecs,
        String mode
    ) throws Exception {
        Connection conn = openConnection(connection);
        applyExecutionContext(connection, conn, database, schema);

        boolean autotrace = "autotrace".equalsIgnoreCase(mode);
        String planText = null;
        String dmMethod = null;

        if (autotrace) {
            if (!isSafeAutotraceSql(sql)) {
                throw new IllegalArgumentException("unsafe");
            }
            // ── Autotrace mode: execute SQL first, then getExplainInfo(stmt) ──
            boolean monitorEnabled = false;
            try (Statement s = conn.createStatement()) {
                s.execute("SF_SET_SESSION_PARA_VALUE('MONITOR_SQL_EXEC', 1)");
                monitorEnabled = true;
            } catch (Exception ignored) {}

            try {
                try (Statement stmt = conn.createStatement()) {
                    if (timeoutSecs >= 0) {
                        try { stmt.setQueryTimeout(timeoutSecs); } catch (SQLFeatureNotSupportedException | UnsupportedOperationException ignored) {}
                    }
                    boolean hasResultSet = stmt.execute(trimStatementSql(sql));
                    if (hasResultSet) {
                        try (ResultSet rs = stmt.getResultSet()) {
                            while (rs.next()) { /* consume */ }
                        }
                    }

                    // Try DM getExplainInfo(Statement)
                    try {
                        Class<?> dmConnClass = Class.forName("dm.jdbc.driver.DmdbConnection");
                        if (dmConnClass.isInstance(conn)) {
                            Method m = dmConnClass.getMethod("getExplainInfo", Statement.class);
                            planText = (String) m.invoke(dmConnClass.cast(conn), stmt);
                            dmMethod = "getExplainInfo(stmt)";
                        }
                    } catch (ClassNotFoundException | NoSuchMethodException e) {
                        // Not DM or DM driver version doesn't support it
                    }
                }
            } finally {
                if (monitorEnabled) {
                    try (Statement s = conn.createStatement()) {
                        s.execute("SF_SET_SESSION_PARA_VALUE('MONITOR_SQL_EXEC', 0)");
                    } catch (Exception ignored) {}
                }
            }
        } else {
            // ── Explain mode: direct plan via getExplainInfo(sqlStr), no execution ──
            try {
                Class<?> dmConnClass = Class.forName("dm.jdbc.driver.DmdbConnection");
                if (dmConnClass.isInstance(conn)) {
                    Method m = dmConnClass.getMethod("getExplainInfo", String.class);
                    planText = (String) m.invoke(dmConnClass.cast(conn), sql);
                    dmMethod = "getExplainInfo(sql)";
                }
            } catch (ClassNotFoundException | NoSuchMethodException e) {
                // Not DM or DM driver version doesn't support it
            }
        }

        // Fallback: if DM method didn't work, try standard EXPLAIN
        if (planText == null || planText.trim().isEmpty()) {
            try (Statement explainStmt = conn.createStatement();
                 ResultSet rs = explainStmt.executeQuery("EXPLAIN " + sql)) {
                StringBuilder sb = new StringBuilder();
                while (rs.next()) {
                    sb.append(rs.getString(1)).append("\n");
                }
                planText = sb.toString().trim();
            }
            dmMethod = "explain(sql)";
        }

        ObjectNode result = MAPPER.createObjectNode();
        result.put("ok", true);
        result.put("plan", planText != null ? planText : "");
        result.put("has_actual_stats", "getExplainInfo(stmt)".equals(dmMethod));
        result.put("mode", autotrace ? "autotrace" : "explain");
        return result;
    }

    private static void applyStatementOptions(
        Statement statement,
        int maxRows,
        int fetchSize,
        int timeoutSecs,
        JdbcDriverQuirks quirks
    )
        throws SQLException {
        if (quirks.statementMaxRowsMode() == StatementMaxRowsMode.APPLY_STATEMENT_MAX_ROWS) {
            statement.setMaxRows((int) Math.min(Integer.MAX_VALUE, (long) maxRows + 1L));
        }
        if (fetchSize > 0) {
            try {
                statement.setFetchSize(fetchSize);
            } catch (SQLFeatureNotSupportedException | UnsupportedOperationException ignored) {
            }
        }
        if (timeoutSecs >= 0) {
            try {
                statement.setQueryTimeout(timeoutSecs);
            } catch (SQLFeatureNotSupportedException | UnsupportedOperationException ignored) {
            }
        }
    }

    private static String trimStatementSql(String sql) {
        return sql == null ? "" : sql.trim().replaceFirst(";\\s*$", "");
    }

    private static boolean isSafeAutotraceSql(String sql) {
        String stripped = stripCommentsAndLiterals(trimStatementSql(sql));
        if (stripped.isBlank()) {
            return false;
        }
        String[] statements = stripped.split(";", -1);
        for (int i = 1; i < statements.length; i++) {
            if (!statements[i].isBlank()) {
                return false;
            }
        }
        String lower = statements[0].stripLeading().toLowerCase(Locale.ROOT);
        boolean readOnly = lower.equals("select")
            || lower.startsWith("select ")
            || lower.startsWith("select\n")
            || lower.equals("with")
            || lower.startsWith("with ")
            || lower.startsWith("with\n")
            || lower.equals("table")
            || lower.startsWith("table ")
            || lower.startsWith("table\n")
            || lower.equals("values")
            || lower.startsWith("values ")
            || lower.startsWith("values\n");
        if (!readOnly) {
            return false;
        }
        for (String keyword : new String[] {"drop", "delete", "truncate", "alter", "update", "merge", "replace", "insert", "create"}) {
            if (containsWord(lower, keyword)) {
                return false;
            }
        }
        return true;
    }

    private static boolean containsWord(String source, String word) {
        int index = source.indexOf(word);
        while (index >= 0) {
            boolean before = index == 0 || !isIdentifierChar(source.charAt(index - 1));
            int afterIndex = index + word.length();
            boolean after = afterIndex >= source.length() || !isIdentifierChar(source.charAt(afterIndex));
            if (before && after) {
                return true;
            }
            index = source.indexOf(word, index + 1);
        }
        return false;
    }

    private static boolean isIdentifierChar(char ch) {
        return Character.isLetterOrDigit(ch) || ch == '_';
    }

    private static String stripCommentsAndLiterals(String sql) {
        StringBuilder output = new StringBuilder(sql.length());
        boolean inLineComment = false;
        boolean inBlockComment = false;
        boolean inSingleQuote = false;
        boolean inDoubleQuote = false;

        for (int i = 0; i < sql.length(); i++) {
            char ch = sql.charAt(i);
            char next = i + 1 < sql.length() ? sql.charAt(i + 1) : '\0';

            if (inLineComment) {
                if (ch == '\n') {
                    inLineComment = false;
                    output.append(' ');
                }
                continue;
            }
            if (inBlockComment) {
                if (ch == '*' && next == '/') {
                    i++;
                    inBlockComment = false;
                    output.append(' ');
                }
                continue;
            }
            if (inSingleQuote) {
                if (ch == '\'' && next == '\'') {
                    i++;
                } else if (ch == '\'') {
                    inSingleQuote = false;
                }
                output.append(' ');
                continue;
            }
            if (inDoubleQuote) {
                if (ch == '"' && next == '"') {
                    i++;
                } else if (ch == '"') {
                    inDoubleQuote = false;
                }
                output.append(' ');
                continue;
            }

            if (ch == '-' && next == '-') {
                i++;
                inLineComment = true;
                continue;
            }
            if (ch == '#') {
                inLineComment = true;
                continue;
            }
            if (ch == '/' && next == '*') {
                i++;
                inBlockComment = true;
                continue;
            }
            if (ch == '\'') {
                inSingleQuote = true;
                output.append(' ');
                continue;
            }
            if (ch == '"') {
                inDoubleQuote = true;
                output.append(' ');
                continue;
            }
            output.append(ch);
        }
        return output.toString();
    }

    private static void applyExecutionContext(JsonNode connection, Connection conn, String database, String schema) throws SQLException {
        if (driverQuirks(connection).skipExecutionContext()) {
            return;
        }
        String catalog = emptyToNull(database);
        if (catalog != null) {
            try {
                conn.setCatalog(catalog);
            } catch (SQLFeatureNotSupportedException | AbstractMethodError | UnsupportedOperationException ignored) {
            }
            if (driverQuirks(connection).useCatalogFallbackSql()) {
                applyUseCatalogFallback(conn, catalog);
            }
        }
        if (schema != null) {
            try {
                conn.setSchema(schema);
            } catch (SQLFeatureNotSupportedException | AbstractMethodError | UnsupportedOperationException ignored) {
            }
        }
    }

    private static void applyUseCatalogFallback(Connection conn, String catalog) {
        try (Statement statement = conn.createStatement()) {
            statement.execute("USE " + quoteJdbcIdentifier(catalog));
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
        }
    }

    private static String quoteJdbcIdentifier(String identifier) {
        if (identifier != null && identifier.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            return identifier;
        }
        return "`" + identifier.replace("`", "``") + "`";
    }

    static JdbcDriverQuirks driverQuirks(JsonNode connection) {
        String url = optionalText(connection, "connection_string");
        for (JdbcDriverQuirkRule rule : DRIVER_QUIRK_RULES) {
            if (urlMatchesPrefix(url, rule.urlPrefix())) {
                return rule.quirks();
            }
        }
        if (isKyuubiDriver(connection)) {
            return USE_CATALOG_QUIRKS;
        }
        return DEFAULT_QUIRKS;
    }

    private static boolean isKyuubiDriver(JsonNode connection) {
        String driverClass = optionalText(connection, "jdbc_driver_class");
        if (driverClass != null && driverClass.toLowerCase(Locale.ROOT).contains("kyuubi")) {
            return true;
        }
        JsonNode paths = connection.path("jdbc_driver_paths");
        if (!paths.isArray()) {
            return false;
        }
        for (JsonNode path : paths) {
            if (path.asText("").toLowerCase(Locale.ROOT).contains("kyuubi")) {
                return true;
            }
        }
        return false;
    }

    private static boolean urlMatchesPrefix(String url, String prefix) {
        return url != null && url.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    private static JsonNode listDatabases(JsonNode connection) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return result;
        }
        try (ResultSet rs = conn.getMetaData().getCatalogs()) {
            while (rs.next()) {
                String name = rs.getString("TABLE_CAT");
                addDatabase(result, name);
            }
        }
        addDatabase(result, optionalText(connection, "database"));
        try {
            addDatabase(result, conn.getCatalog());
        } catch (SQLFeatureNotSupportedException | AbstractMethodError | UnsupportedOperationException ignored) {
        }
        return result;
    }

    private static void addDatabase(ArrayNode result, String name) {
        if (name == null || name.isBlank()) {
            return;
        }
        for (JsonNode item : result) {
            if (name.equals(item.path("name").asText())) {
                return;
            }
        }
        ObjectNode item = MAPPER.createObjectNode();
        item.put("name", name);
        result.add(item);
    }

    private static JsonNode listSchemas(JsonNode connection, String database) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        JdbcDriverQuirks quirks = driverQuirks(connection);
        String catalog = metadataCatalog(database, quirks);
        if (quirks.useOracleMetadata()) {
            return oracleListSchemas(conn);
        }
        DatabaseMetaData meta = conn.getMetaData();
        if (quirks.caseInsensitiveSchemaMetadata()) {
            try (ResultSet rs = meta.getSchemas(catalog, null)) {
                appendSchemas(result, rs, true);
            } catch (SQLException ignored) {
                try (ResultSet rs = meta.getSchemas()) {
                    appendSchemas(result, rs, true);
                }
            }
            try (ResultSet rs = meta.getSchemas(null, null)) {
                appendSchemas(result, rs, true);
            } catch (SQLException ignored) {
            }
        } else {
            try (ResultSet rs = meta.getSchemas(catalog, null)) {
                appendSchemas(result, rs, false);
            } catch (SQLFeatureNotSupportedException | UnsupportedOperationException ignored) {
                try (ResultSet rs = meta.getSchemas()) {
                    appendSchemas(result, rs, false);
                }
            }
            if (result.isEmpty() && catalog != null) {
                try (ResultSet rs = meta.getSchemas(null, null)) {
                    appendSchemas(result, rs, false);
                } catch (SQLFeatureNotSupportedException | UnsupportedOperationException ignored) {
                }
            }
        }
        if (result.isEmpty()) {
            try {
                String schema = conn.getSchema();
                if (schema != null) {
                    addSchema(result, schema, quirks.caseInsensitiveSchemaMetadata());
                }
            } catch (SQLFeatureNotSupportedException | AbstractMethodError | UnsupportedOperationException ignored) {
            }
        }
        return result;
    }

    private static JsonNode listTables(JsonNode connection, String database, String schema, String filter, int limit) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        JdbcDriverQuirks quirks = driverQuirks(connection);
        if (quirks.useOracleMetadata()) {
            return oracleListTables(conn, oracleEffectiveSchema(conn, schema));
        }
        if (usePrestoInformationSchemaTables(connection)) {
            return prestoListTables(conn, database, schema, filter, limit);
        }
        DatabaseMetaData meta = conn.getMetaData();
        String[] types = jdbcTableTypes(meta);
        String catalog = metadataCatalog(database, quirks);
        String schemaPattern = resolveSchemaPattern(meta, database, schema, quirks);
        appendTables(result, meta, catalog, schemaPattern, types);
        if (result.isEmpty() && catalog != null) {
            appendTables(result, meta, null, schemaPattern, types);
        }
        return result;
    }

    private static JsonNode listObjects(JsonNode connection, String database, String schema) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return oracleListObjects(conn, oracleEffectiveSchema(conn, schema), schema);
        }
        if (usePrestoInformationSchemaTables(connection)) {
            return prestoListObjects(conn, database, schema);
        }
        DatabaseMetaData meta = conn.getMetaData();
        JdbcDriverQuirks quirks = driverQuirks(connection);
        String catalog = metadataCatalog(database, quirks);
        String schemaPattern = resolveSchemaPattern(meta, database, schema, quirks);

        String[] tableTypes = jdbcTableTypes(meta);
        appendTableObjects(result, meta, catalog, schemaPattern, schema, tableTypes);
        if (result.isEmpty() && catalog != null) {
            appendTableObjects(result, meta, null, schemaPattern, schema, tableTypes);
        }

        try (ResultSet rs = meta.getProcedures(catalog, schemaPattern, "%")) {
            while (rs.next()) {
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", rs.getString("PROCEDURE_NAME"));
                item.put("object_type", "PROCEDURE");
                putNullable(item, "schema", schema);
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
            }
        } catch (SQLException ignored) {
        }

        Set<String> procedureNames = new HashSet<>();
        for (JsonNode node : result) {
            if ("PROCEDURE".equals(node.path("object_type").asText())) {
                procedureNames.add(node.path("name").asText());
            }
        }
        try (ResultSet rs = meta.getFunctions(catalog, schemaPattern, "%")) {
            while (rs.next()) {
                String name = rs.getString("FUNCTION_NAME");
                if (!procedureNames.contains(name)) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", name);
                    item.put("object_type", "FUNCTION");
                    putNullable(item, "schema", schema);
                    putNullable(item, "comment", rs.getString("REMARKS"));
                    result.add(item);
                }
            }
        } catch (SQLException ignored) {
        }

        return result;
    }

    private static JsonNode listDataTypes(JsonNode connection, String database) throws SQLException {
        Connection conn = openConnection(connection);
        JdbcDriverQuirks quirks = driverQuirks(connection);
        String catalog = metadataCatalog(database, quirks);
        if (catalog != null) {
            try {
                conn.setCatalog(catalog);
            } catch (SQLFeatureNotSupportedException | AbstractMethodError | UnsupportedOperationException ignored) {
            }
        }
        ArrayNode result = MAPPER.createArrayNode();
        Set<String> seen = new HashSet<>();
        try (ResultSet rs = conn.getMetaData().getTypeInfo()) {
            while (rs.next()) {
                String name = rs.getString("TYPE_NAME");
                if (name == null || name.isBlank()) {
                    continue;
                }
                String trimmed = name.trim();
                if (seen.add(trimmed.toLowerCase(Locale.ROOT))) {
                    result.add(trimmed);
                }
            }
        }
        return result;
    }

    private static JsonNode getColumns(JsonNode connection, String database, String schema, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return oracleGetColumns(conn, oracleEffectiveSchema(conn, schema), table);
        }
        if (isKingbaseUrl(optionalText(connection, "connection_string"))) {
            return kingbaseGetColumns(conn, schema, table);
        }
        if (usePrestoInformationSchemaTables(connection)) {
            return prestoGetColumns(conn, database, schema, table);
        }
        DatabaseMetaData meta = conn.getMetaData();
        JdbcDriverQuirks quirks = driverQuirks(connection);
        String catalog = metadataCatalog(database, quirks);
        String schemaPattern = resolveSchemaPattern(meta, database, schema, quirks);
        Set<String> primaryKeys = safePrimaryKeys(meta, catalog, schemaPattern, table);
        appendColumns(result, meta, catalog, schemaPattern, table, primaryKeys);
        if (result.isEmpty() && catalog != null) {
            primaryKeys = safePrimaryKeys(meta, null, schemaPattern, table);
            appendColumns(result, meta, null, schemaPattern, table, primaryKeys);
        }
        if (quirks.useCatalogFallbackSql()) {
            mergeShowFullColumnMetadata(conn, result, schemaPattern, table);
        }
        return result;
    }

    private static void appendSchemas(ArrayNode result, ResultSet rs, boolean caseInsensitive) throws SQLException {
        while (rs.next()) {
            String schema = rs.getString("TABLE_SCHEM");
            addSchema(result, schema, caseInsensitive);
        }
    }

    private static void addSchema(ArrayNode result, String schema, boolean caseInsensitive) {
        if (schema == null || schema.isBlank()) {
            return;
        }
        String key = schemaKey(schema, caseInsensitive);
        for (int i = 0; i < result.size(); i++) {
            String existing = result.get(i).asText("");
            if (schemaKey(existing, caseInsensitive).equals(key)) {
                if (preferSchemaDisplayName(existing, schema)) {
                    result.set(i, MAPPER.getNodeFactory().textNode(schema));
                }
                return;
            }
        }
        result.add(schema);
    }

    static boolean preferSchemaDisplayName(String existing, String candidate) {
        return isAllUppercaseIdentifier(existing) && !isAllUppercaseIdentifier(candidate);
    }

    private static boolean isAllUppercaseIdentifier(String value) {
        return value != null && value.equals(value.toUpperCase(Locale.ROOT)) && !value.equals(value.toLowerCase(Locale.ROOT));
    }

    private static String schemaKey(String schema, boolean caseInsensitive) {
        return caseInsensitive ? schema.toLowerCase(Locale.ROOT) : schema;
    }

    private static String metadataCatalog(String database, JdbcDriverQuirks quirks) {
        if (quirks.caseInsensitiveSchemaMetadata() || quirks.ignoreCatalogForSchemaMetadata()) {
            return null;
        }
        return emptyToNull(database);
    }

    private static String resolveSchemaPattern(
        DatabaseMetaData meta,
        String database,
        String schema,
        JdbcDriverQuirks quirks
    ) throws SQLException {
        String schemaPattern = emptyToNull(schema);
        if (schemaPattern == null || !quirks.caseInsensitiveSchemaMetadata()) {
            return schemaPattern;
        }
        String resolved = null;
        try {
            resolved = findSchemaPattern(meta, metadataCatalog(database, quirks), schemaPattern);
        } catch (SQLException ignored) {
        }
        if (resolved != null) {
            return resolved;
        }
        resolved = findSchemaPattern(meta, null, schemaPattern);
        return resolved == null ? schemaPattern : resolved;
    }

    private static String findSchemaPattern(DatabaseMetaData meta, String catalog, String schema) throws SQLException {
        try (ResultSet rs = meta.getSchemas(catalog, null)) {
            String fallback = null;
            while (rs.next()) {
                String candidate = rs.getString("TABLE_SCHEM");
                if (candidate == null || candidate.isBlank()) {
                    continue;
                }
                if (candidate.equals(schema)) {
                    return candidate;
                }
                if (candidate.equalsIgnoreCase(schema) && (fallback == null || preferSchemaDisplayName(fallback, candidate))) {
                    fallback = candidate;
                }
            }
            return fallback;
        } catch (SQLFeatureNotSupportedException | UnsupportedOperationException ignored) {
            return null;
        }
    }

    private static void appendTables(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        String[] types
    ) throws SQLException {
        try (ResultSet rs = meta.getTables(catalog, schema, "%", types)) {
            while (rs.next()) {
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", rs.getString("TABLE_NAME"));
                item.put("table_type", rs.getString("TABLE_TYPE"));
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
            }
        }
    }

    static String[] jdbcTableTypes(DatabaseMetaData meta) throws SQLException {
        Set<String> allowed = new HashSet<>();
        for (String type : DEFAULT_TABLE_TYPES) {
            allowed.add(type.toUpperCase(Locale.ROOT));
        }
        try (ResultSet rs = meta.getTableTypes()) {
            List<String> types = new ArrayList<>();
            while (rs.next()) {
                String type = rs.getString("TABLE_TYPE");
                if (type != null && allowed.contains(type.toUpperCase(Locale.ROOT))) {
                    types.add(type);
                }
            }
            if (!types.isEmpty()) {
                return types.toArray(new String[0]);
            }
        } catch (SQLFeatureNotSupportedException | UnsupportedOperationException ignored) {
        }
        return DEFAULT_TABLE_TYPES;
    }

    private static void appendTableObjects(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schemaPattern,
        String schema,
        String[] tableTypes
    ) throws SQLException {
        try (ResultSet rs = meta.getTables(catalog, schemaPattern, "%", tableTypes)) {
            while (rs.next()) {
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", rs.getString("TABLE_NAME"));
                item.put("object_type", rs.getString("TABLE_TYPE"));
                putNullable(item, "schema", schema);
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
            }
        }
    }

    private static boolean usePrestoInformationSchemaTables(JsonNode connection) {
        String url = optionalText(connection, "connection_string");
        return urlMatchesPrefix(url, "jdbc:presto:") || urlMatchesPrefix(url, "jdbc:trino:");
    }

    private static JsonNode prestoListTables(Connection conn, String database, String schema, String filter, int limit) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        try (PreparedStatement ps = conn.prepareStatement(prestoInformationSchemaTablesSql(database, filter, limit))) {
            ps.setString(1, schema);
            if (emptyToNull(filter) != null) {
                ps.setString(2, escapeLikePattern(filter.toLowerCase(Locale.ROOT)) + "%");
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString(1));
                    item.put("table_type", normalizeInformationSchemaTableType(rs.getString(2)));
                    item.putNull("comment");
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static JsonNode prestoListObjects(Connection conn, String database, String schema) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        try (PreparedStatement ps = conn.prepareStatement(prestoInformationSchemaTablesSql(database, null, 0))) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString(1));
                    item.put("object_type", normalizeInformationSchemaTableType(rs.getString(2)));
                    putNullable(item, "schema", schema);
                    item.putNull("comment");
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static JsonNode prestoGetColumns(Connection conn, String database, String schema, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        try (PreparedStatement ps = conn.prepareStatement(prestoInformationSchemaColumnsSql(database))) {
            ps.setString(1, schema);
            ps.setString(2, table);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String dataType = rs.getString(2);
                    ObjectNode item = columnNode(result, rs.getString(1));
                    item.put("data_type", dataType);
                    item.put("is_nullable", !"NO".equalsIgnoreCase(rs.getString(3)));
                    putNullablePreferValue(item, "column_default", rs.getString(4));
                    item.put("is_primary_key", false);
                    item.putNull("extra");
                    putNullablePreferValue(item, "comment", rs.getString(5));
                    // Presto/Trino information_schema.columns does not expose precision/length fields.
                    putNullableInt(item, "numeric_precision", prestoNumericPrecision(dataType));
                    putNullableInt(item, "numeric_scale", prestoNumericScale(dataType));
                    putNullableInt(item, "character_maximum_length", prestoCharacterMaximumLength(dataType));
                }
            }
        }
        return result;
    }

    static String prestoInformationSchemaTablesSql(String database, String filter, int limit) {
        String source = emptyToNull(database) == null
            ? "information_schema.tables"
            : quoteAnsiIdentifier(database) + ".information_schema.tables";
        StringBuilder sql = new StringBuilder("SELECT table_name, table_type FROM " + source +
            " WHERE table_schema = ? AND table_type IN ('BASE TABLE', 'VIEW')" +
            (emptyToNull(filter) == null ? "" : " AND lower(table_name) LIKE ? ESCAPE '\\'") +
            " ORDER BY table_type, table_name");
        if (limit > 0) {
            sql.append(" LIMIT ").append(limit);
        }
        return sql.toString();
    }

    static String prestoInformationSchemaColumnsSql(String database) {
        String source = emptyToNull(database) == null
            ? "information_schema.columns"
            : quoteAnsiIdentifier(database) + ".information_schema.columns";
        return "SELECT column_name, data_type, is_nullable, column_default, comment FROM " + source +
            " WHERE table_schema = ? AND table_name = ?" +
            " ORDER BY ordinal_position";
    }

    private static Integer prestoNumericPrecision(String dataType) {
        return prestoTypeArgument(dataType, 0, "decimal", "numeric");
    }

    private static Integer prestoNumericScale(String dataType) {
        return prestoTypeArgument(dataType, 1, "decimal", "numeric");
    }

    private static Integer prestoCharacterMaximumLength(String dataType) {
        return prestoTypeArgument(dataType, 0, "char", "varchar");
    }

    private static Integer prestoTypeArgument(String dataType, int argumentIndex, String... typeNames) {
        if (dataType == null) {
            return null;
        }
        int open = dataType.indexOf('(');
        int close = open < 0 ? -1 : dataType.indexOf(')', open + 1);
        if (open <= 0 || close <= open) {
            return null;
        }
        String name = dataType.substring(0, open).trim().toLowerCase(Locale.ROOT);
        boolean matches = false;
        for (String typeName : typeNames) {
            if (typeName.equals(name)) {
                matches = true;
                break;
            }
        }
        if (!matches) {
            return null;
        }
        String[] arguments = dataType.substring(open + 1, close).split(",");
        if (argumentIndex >= arguments.length) {
            return null;
        }
        try {
            return Integer.valueOf(arguments[argumentIndex].trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    static String normalizeInformationSchemaTableType(String tableType) {
        if (tableType == null) {
            return "TABLE";
        }
        String normalized = tableType.trim().toUpperCase(Locale.ROOT).replace(' ', '_');
        return switch (normalized) {
            case "BASE_TABLE" -> "TABLE";
            case "MATERIALIZED_VIEW" -> "MATERIALIZED_VIEW";
            case "VIEW" -> "VIEW";
            default -> tableType;
        };
    }

    private static JsonNode kingbaseGetColumns(Connection conn, String schema, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String effectiveSchema = emptyToNull(schema) == null ? "PUBLIC" : schema;
        Set<String> primaryKeys = kingbasePrimaryKeys(conn, effectiveSchema, table);
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
            "WHERE n.nspname = " + sqlString(effectiveSchema) +
            " AND c.relname = " + sqlString(table) + " " +
            "AND a.attnum > 0 AND NOT a.attisdropped " +
            "ORDER BY a.attnum";
        try (Statement statement = conn.createStatement()) {
            try (ResultSet rs = statement.executeQuery(sql)) {
                while (rs.next()) {
                    String name = rs.getString("column_name");
                    ObjectNode item = columnNode(result, name);
                    item.put("data_type", rs.getString("data_type"));
                    item.put("is_nullable", rs.getBoolean("is_nullable"));
                    putNullablePreferValue(item, "column_default", rs.getString("column_default"));
                    item.put("is_primary_key", primaryKeys.contains(name));
                    item.putNull("extra");
                    putNullablePreferValue(item, "comment", rs.getString("column_comment"));
                    putNullableInt(item, "numeric_precision", rs.getObject("numeric_precision"));
                    putNullableInt(item, "numeric_scale", rs.getObject("numeric_scale"));
                    putNullableInt(item, "character_maximum_length", rs.getObject("character_maximum_length"));
                }
            }
        }
        return result;
    }

    private static Set<String> kingbasePrimaryKeys(Connection conn, String schema, String table) {
        Set<String> primaryKeys = new HashSet<>();
        String sql = "SELECT a.attname AS column_name " +
            "FROM sys_catalog.sys_constraint co " +
            "JOIN sys_catalog.sys_class c ON c.oid = co.conrelid " +
            "JOIN sys_catalog.sys_namespace n ON n.oid = c.relnamespace " +
            "JOIN LATERAL (SELECT unnest(co.conkey) AS attnum, generate_series(1, array_length(co.conkey, 1)) AS ord) AS pk_cols ON true " +
            "JOIN sys_catalog.sys_attribute a ON a.attrelid = c.oid AND a.attnum = pk_cols.attnum " +
            "WHERE co.contype = 'p' " +
            "AND n.nspname = " + sqlString(schema) + " " +
            "AND c.relname = " + sqlString(table) + " " +
            "ORDER BY pk_cols.ord";
        try (Statement statement = conn.createStatement()) {
            try (ResultSet rs = statement.executeQuery(sql)) {
                while (rs.next()) {
                    primaryKeys.add(rs.getString("column_name"));
                }
            }
        } catch (SQLException ignored) {
            return Collections.emptySet();
        }
        return primaryKeys;
    }

    private static boolean isKingbaseUrl(String url) {
        return urlMatchesPrefix(url, "jdbc:kingbase");
    }

    private static String quoteAnsiIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private static String sqlString(String value) {
        return "'" + (value == null ? "" : value).replace("'", "''") + "'";
    }

    private static void appendColumns(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        String table,
        Set<String> primaryKeys
    ) throws SQLException {
        try (ResultSet rs = meta.getColumns(catalog, schema, table, "%")) {
            while (rs.next()) {
                String name = rs.getString("COLUMN_NAME");
                ObjectNode item = columnNode(result, name);
                item.put("data_type", rs.getString("TYPE_NAME"));
                item.put("is_nullable", columnIsNullable(rs));
                putNullablePreferValue(item, "column_default", rs.getString("COLUMN_DEF"));
                item.put("is_primary_key", primaryKeys.contains(name));
                item.putNull("extra");
                putNullablePreferValue(item, "comment", rs.getString("REMARKS"));
                putNullableInt(item, "numeric_precision", rs.getObject("COLUMN_SIZE"));
                putNullableInt(item, "numeric_scale", rs.getObject("DECIMAL_DIGITS"));
                putNullableInt(item, "character_maximum_length", rs.getObject("COLUMN_SIZE"));
            }
        }
    }

    private static boolean columnIsNullable(ResultSet rs) throws SQLException {
        try {
            String isNullableStr = rs.getString("IS_NULLABLE");
            if ("YES".equalsIgnoreCase(isNullableStr)) {
                return true;
            }
            if ("NO".equalsIgnoreCase(isNullableStr)) {
                return false;
            }
        } catch (SQLException ignored) {
        }
        return rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls;
    }

    private static void mergeShowFullColumnMetadata(Connection conn, ArrayNode result, String schema, String table) {
        String target = qualifiedJdbcTableName(schema, table);
        try (Statement statement = conn.createStatement(); ResultSet rs = statement.executeQuery("SHOW FULL COLUMNS FROM " + target)) {
            int fieldIndex = resultSetColumnIndex(rs, "Field");
            int typeIndex = resultSetColumnIndex(rs, "Type");
            int extraIndex = resultSetColumnIndex(rs, "Extra");
            int commentIndex = resultSetColumnIndex(rs, "Comment");
            if (fieldIndex <= 0) {
                return;
            }
            while (rs.next()) {
                String name = rs.getString(fieldIndex);
                if (name != null) {
                    ObjectNode item = columnNode(result, name);
                    if (typeIndex > 0) {
                        putNullablePreferValue(item, "data_type", rs.getString(typeIndex));
                    }
                    if (extraIndex > 0) {
                        putNullablePreferValue(item, "extra", rs.getString(extraIndex));
                    }
                    if (commentIndex > 0) {
                        putNullablePreferValue(item, "comment", rs.getString(commentIndex));
                    }
                }
            }
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
        }
    }

    private static String qualifiedJdbcTableName(String schema, String table) {
        String tableName = quoteJdbcIdentifier(table);
        String schemaName = emptyToNull(schema);
        return schemaName == null ? tableName : quoteJdbcIdentifier(schemaName) + "." + tableName;
    }

    private static int resultSetColumnIndex(ResultSet rs, String label) throws SQLException {
        ResultSetMetaData meta = rs.getMetaData();
        for (int i = 1; i <= meta.getColumnCount(); i++) {
            if (label.equalsIgnoreCase(meta.getColumnLabel(i)) || label.equalsIgnoreCase(meta.getColumnName(i))) {
                return i;
            }
        }
        return -1;
    }

    private static void closeSharedConnection() {
        closeAllQuerySessions();
        if (sharedConnection != null) {
            try {
                sharedConnection.close();
            } catch (SQLException ignored) {
            }
            sharedConnection = null;
            sharedConnectionKey = "";
        }
    }

    private static String driverKey(JsonNode connection) {
        return optionalText(connection, "jdbc_driver_class") + "|" + connection.path("jdbc_driver_paths").toString();
    }

    private static String connectionKey(JsonNode connection) {
        return optionalText(connection, "connection_string")
            + "|" + optionalText(connection, "url_params")
            + "|" + optionalText(connection, "username")
            + "|" + optionalText(connection, "password")
            + "|" + connection.path("sysdba").asBoolean(false);
    }

    private static Set<String> primaryKeys(DatabaseMetaData meta, String database, String schema, String table) throws SQLException {
        Set<String> primaryKeys = new HashSet<>();
        try (ResultSet rs = meta.getPrimaryKeys(emptyToNull(database), emptyToNull(schema), table)) {
            while (rs.next()) {
                primaryKeys.add(rs.getString("COLUMN_NAME"));
            }
        }
        return primaryKeys;
    }

    private static Set<String> safePrimaryKeys(DatabaseMetaData meta, String database, String schema, String table) {
        try {
            return primaryKeys(meta, database, schema, table);
        } catch (SQLException ignored) {
            return Collections.emptySet();
        }
    }

    // --- Oracle-specific metadata methods ---

    private static boolean isOracleUrl(String url) {
        return url != null && url.regionMatches(true, 0, "jdbc:oracle:", 0, 12);
    }

    static String jdbcUrlWithPasswordKey(String url, String password) {
        if (url == null || password == null || password.isBlank() || !isSqliteUrl(url)) {
            return url;
        }
        if (!urlHasQueryParam(url, "cipher") || urlHasQueryParam(url, "key")) {
            return url;
        }
        return appendJdbcUrlParam(url, "key", password);
    }

    static String jdbcUrl(JsonNode connection) {
        String url = appendJdbcUrlParams(optionalText(connection, "connection_string"), optionalText(connection, "url_params"));
        return jdbcUrlWithPasswordKey(url, optionalText(connection, "password"));
    }

    private static boolean isSqliteUrl(String url) {
        return url.regionMatches(true, 0, "jdbc:sqlite:", 0, 12);
    }

    private static boolean urlHasQueryParam(String url, String key) {
        int queryStart = url.indexOf('?');
        if (queryStart < 0) {
            return false;
        }
        int fragmentStart = url.indexOf('#', queryStart + 1);
        String query = fragmentStart < 0 ? url.substring(queryStart + 1) : url.substring(queryStart + 1, fragmentStart);
        for (String part : query.split("[&;]")) {
            int equals = part.indexOf('=');
            String name = equals < 0 ? part : part.substring(0, equals);
            if (name.equalsIgnoreCase(key)) {
                return true;
            }
        }
        return false;
    }

    private static String appendJdbcUrlParam(String url, String key, String value) {
        int fragmentStart = url.indexOf('#');
        String base = fragmentStart < 0 ? url : url.substring(0, fragmentStart);
        String fragment = fragmentStart < 0 ? "" : url.substring(fragmentStart);
        String separator = base.contains("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
        String encodedValue = URLEncoder.encode(value, StandardCharsets.UTF_8);
        return base + separator + key + "=" + encodedValue + fragment;
    }

    static String appendJdbcUrlParams(String url, String urlParams) {
        if (url == null || urlParams == null || urlParams.isBlank()) {
            return url;
        }
        String params = urlParams.trim();
        while (params.startsWith("?") || params.startsWith("&") || params.startsWith(";") || params.startsWith(":")) {
            params = params.substring(1).trim();
        }
        if (params.isEmpty()) {
            return url;
        }

        int fragmentStart = url.indexOf('#');
        String base = fragmentStart < 0 ? url : url.substring(0, fragmentStart);
        String fragment = fragmentStart < 0 ? "" : url.substring(fragmentStart);
        if (jdbcUrlUsesColonProperties(base) && !params.endsWith(";")) {
            params = params + ";";
        }
        String separator = jdbcUrlParamSeparator(base);
        return base + separator + params + fragment;
    }

    private static String jdbcUrlParamSeparator(String base) {
        if (urlMatchesPrefix(base, "jdbc:sqlserver:") || urlMatchesPrefix(base, "jdbc:dremio:")) {
            return base.endsWith(";") ? "" : ";";
        }
        if (jdbcUrlUsesColonProperties(base)) {
            if (base.endsWith(":") || base.endsWith(";")) {
                return "";
            }
            return jdbcUrlHasColonProperties(base) ? ";" : ":";
        }
        return base.contains("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
    }

    private static boolean jdbcUrlUsesColonProperties(String base) {
        return urlMatchesPrefix(base, "jdbc:db2:") || urlMatchesPrefix(base, "jdbc:informix-sqli:");
    }

    private static boolean jdbcUrlHasColonProperties(String base) {
        int schemeEnd = base.indexOf("://");
        if (schemeEnd < 0) {
            return false;
        }
        int pathStart = base.indexOf('/', schemeEnd + 3);
        if (pathStart < 0) {
            return false;
        }
        return base.indexOf(':', pathStart + 1) >= 0;
    }

    private static String oracleEffectiveSchema(Connection conn, String schema) throws SQLException {
        if (schema != null && !schema.isBlank()) {
            return oracleResolveOwner(conn, schema);
        }
        String username = conn.getMetaData().getUserName();
        return username == null || username.isBlank() ? username : oracleResolveOwner(conn, username);
    }

    private static String oracleResolveOwner(Connection conn, String owner) throws SQLException {
        String exact = oracleFindIdentifier(
            conn,
            "SELECT username FROM all_users WHERE username = ?",
            owner
        );
        if (exact != null) {
            return exact;
        }
        String upper = owner.toUpperCase();
        exact = oracleFindIdentifier(
            conn,
            "SELECT username FROM all_users WHERE username = ?",
            upper
        );
        return exact == null ? owner : exact;
    }

    private static String oracleResolveTable(Connection conn, String owner, String table) throws SQLException {
        String exact = oracleFindIdentifier(
            conn,
            "SELECT table_name FROM all_tab_comments WHERE owner = ? AND table_name = ?",
            owner,
            table
        );
        if (exact != null) {
            return exact;
        }
        String upper = table.toUpperCase();
        exact = oracleFindIdentifier(
            conn,
            "SELECT table_name FROM all_tab_comments WHERE owner = ? AND table_name = ?",
            owner,
            upper
        );
        return exact == null ? table : exact;
    }

    private static String oracleFindIdentifier(Connection conn, String sql, String first) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, first);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return rs.getString(1);
                }
            }
        }
        return null;
    }

    private static String oracleFindIdentifier(Connection conn, String sql, String first, String second) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, first);
            ps.setString(2, second);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return rs.getString(1);
                }
            }
        }
        return null;
    }

    private static JsonNode oracleListSchemas(Connection conn) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery("SELECT username FROM all_users ORDER BY username")) {
            while (rs.next()) {
                String name = rs.getString(1);
                if (name != null && !name.isBlank()) {
                    result.add(name);
                }
            }
        }
        return result;
    }

    private static JsonNode oracleListTables(Connection conn, String owner) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String sql =
            "SELECT table_name AS name, 'TABLE' AS table_type, comments " +
            "FROM all_tab_comments WHERE owner = ? AND table_type = 'TABLE' " +
            "UNION ALL " +
            "SELECT table_name AS name, 'VIEW' AS table_type, comments " +
            "FROM all_tab_comments WHERE owner = ? AND table_type = 'VIEW' " +
            "ORDER BY name";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("table_type", rs.getString("table_type"));
                    putNullable(item, "comment", rs.getString("comments"));
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static JsonNode oracleListObjects(Connection conn, String owner, String schemaLabel) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String tableSql =
            "SELECT table_name AS name, table_type AS object_type, comments " +
            "FROM all_tab_comments WHERE owner = ? ORDER BY name";
        try (PreparedStatement ps = conn.prepareStatement(tableSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", rs.getString("object_type"));
                    putNullable(item, "schema", schemaLabel);
                    putNullable(item, "comment", rs.getString("comments"));
                    result.add(item);
                }
            }
        }
        String procSql =
            "SELECT object_name AS name, object_type " +
            "FROM all_procedures WHERE owner = ? AND object_type IN ('PROCEDURE', 'FUNCTION') " +
            "AND procedure_name IS NULL ORDER BY object_name";
        try (PreparedStatement ps = conn.prepareStatement(procSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", rs.getString("object_type"));
                    putNullable(item, "schema", schemaLabel);
                    item.putNull("comment");
                    result.add(item);
                }
            }
        }
        String packageSql =
            "SELECT object_name AS name, CASE object_type WHEN 'PACKAGE BODY' THEN 'PACKAGE_BODY' ELSE object_type END AS object_type " +
            "FROM all_objects WHERE owner = ? AND object_type IN ('PACKAGE', 'PACKAGE BODY') ORDER BY object_type, object_name";
        try (PreparedStatement ps = conn.prepareStatement(packageSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", rs.getString("object_type"));
                    putNullable(item, "schema", schemaLabel);
                    item.putNull("comment");
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static JsonNode getObjectSource(JsonNode connection, String database, String schema, String name, String objectType)
        throws SQLException {
        Connection conn = openConnection(connection);
        if (!driverQuirks(connection).useOracleMetadata()) {
            throw new SQLException("Object source is not supported by this JDBC driver");
        }
        String owner = oracleEffectiveSchema(conn, schema);
        String metadataType = oracleMetadataObjectType(objectType);
        String sql = "SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, metadataType);
            ps.setString(2, name);
            ps.setString(3, owner);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new SQLException("Object source not found");
                }
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", name);
                item.put("object_type", objectType);
                putNullable(item, "schema", owner);
                putNullable(item, "source", rs.getString(1));
                return item;
            }
        }
    }

    private static String oracleMetadataObjectType(String objectType) {
        String normalized = objectType == null ? "" : objectType.trim().toUpperCase().replace(' ', '_');
        return switch (normalized) {
            case "VIEW" -> "VIEW";
            case "PROCEDURE" -> "PROCEDURE";
            case "FUNCTION" -> "FUNCTION";
            case "PACKAGE" -> "PACKAGE";
            case "PACKAGE_BODY" -> "PACKAGE_BODY";
            default -> normalized;
        };
    }

    private static JsonNode oracleGetColumns(Connection conn, String owner, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String resolvedTable = oracleResolveTable(conn, owner, table);
        Set<String> pks = oraclePrimaryKeys(conn, owner, resolvedTable);
        // data_default is a LONG column — it must be read first in JDBC, before any other
        // column, otherwise the data is truncated. We put it at position 1 for this reason.
        String sql =
            "SELECT c.data_default, c.column_name, c.data_type, c.nullable, " +
            "c.data_precision, c.data_scale, c.char_length, cc.comments " +
            "FROM all_tab_columns c " +
            "LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name " +
            "WHERE c.owner = ? AND c.table_name = ? ORDER BY c.column_id";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, resolvedTable);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    // data_default is a LONG — read it first, before all other columns.
                    String dataDefault = rs.getString("data_default");
                    String name = rs.getString("column_name");
                    ObjectNode item = columnNode(result, name);
                    item.put("data_type", rs.getString("data_type"));
                    item.put("is_nullable", !"N".equals(rs.getString("nullable")));
                    putNullablePreferValue(item, "column_default", dataDefault);
                    item.put("is_primary_key", pks.contains(name));
                    item.putNull("extra");
                    putNullablePreferValue(item, "comment", rs.getString("comments"));
                    putNullableInt(item, "numeric_precision", rs.getObject("data_precision"));
                    putNullableInt(item, "numeric_scale", rs.getObject("data_scale"));
                    putNullableInt(item, "character_maximum_length", rs.getObject("char_length"));
                }
            }
        }
        return result;
    }

    private static Set<String> oraclePrimaryKeys(Connection conn, String owner, String table) throws SQLException {
        Set<String> keys = new HashSet<>();
        String sql =
            "SELECT cols.column_name FROM all_constraints cons " +
            "JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner " +
            "WHERE cons.constraint_type = 'P' AND cons.owner = ? AND cons.table_name = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, table);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    keys.add(rs.getString("column_name"));
                }
            }
        }
        return keys;
    }

    private static Object readValue(ResultSet rs, ResultSetMetaData meta, int index) throws SQLException {
        Object value = rs.getObject(index);
        if (value == null) {
            return null;
        }
        if (value instanceof byte[] bytes) {
            return binaryToHex(bytes);
        }
        if (isBinaryColumn(meta, index)) {
            byte[] bytes = rs.getBytes(index);
            return bytes == null ? null : binaryToHex(bytes);
        }
        Object temporalValue = readTemporalValue(rs, meta, index);
        if (temporalValue != null) {
            return temporalValue;
        }
        if (value instanceof Date || value instanceof Time || value instanceof Timestamp || value instanceof TemporalAccessor) {
            return value.toString();
        }
        if (value instanceof BigDecimal decimal) {
            return decimal;
        }
        if (value instanceof Number || value instanceof Boolean || value instanceof String) {
            return value;
        }
        return value.toString();
    }

    private static Object readTemporalValue(ResultSet rs, ResultSetMetaData meta, int index) throws SQLException {
        return switch (meta.getColumnType(index)) {
            case Types.DATE -> {
                Date date = rs.getDate(index);
                yield date == null ? null : date.toString();
            }
            case Types.TIME -> {
                Time time = rs.getTime(index);
                yield time == null ? null : time.toString();
            }
            case Types.TIMESTAMP -> {
                Timestamp timestamp = rs.getTimestamp(index);
                yield timestamp == null ? null : timestamp.toString();
            }
            default -> null;
        };
    }

    private static boolean isBinaryColumn(ResultSetMetaData meta, int index) throws SQLException {
        return switch (meta.getColumnType(index)) {
            case Types.BINARY,
                 Types.VARBINARY,
                 Types.LONGVARBINARY,
                 Types.BLOB -> true;
            default -> false;
        };
    }

    private static String binaryToHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(2 + bytes.length * 2);
        out.append("0x");
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0x0f, 16));
            out.append(Character.forDigit(b & 0x0f, 16));
        }
        return out.toString();
    }

    private static void putNullable(ObjectNode node, String field, String value) {
        if (value == null) {
            node.putNull(field);
        } else {
            node.put(field, value);
        }
    }

    private static ObjectNode columnNode(ArrayNode result, String name) {
        for (JsonNode node : result) {
            if (name.equals(node.path("name").asText()) && node instanceof ObjectNode objectNode) {
                return objectNode;
            }
        }
        ObjectNode item = MAPPER.createObjectNode();
        item.put("name", name);
        result.add(item);
        return item;
    }

    private static void putNullablePreferValue(ObjectNode node, String field, String value) {
        if (value == null || value.isBlank()) {
            if (!node.has(field)) {
                node.putNull(field);
            }
            return;
        }
        node.put(field, value);
    }

    private static void putNullableInt(ObjectNode node, String field, Object value) {
        if (value instanceof Number number) {
            node.put(field, number.intValue());
        } else {
            node.putNull(field);
        }
    }

    private static String requireText(JsonNode node, String field) {
        String value = optionalText(node, field);
        if (value == null) {
            throw new IllegalArgumentException(field + " is required.");
        }
        return value;
    }

    private static String optionalText(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return null;
        }
        String text = value.asText("").trim();
        return text.isEmpty() ? null : text;
    }

    private static int positiveInt(JsonNode node, String field, int defaultValue) {
        return Math.max(1, nonNegativeInt(node, field, defaultValue));
    }

    private static int nonNegativeInt(JsonNode node, String field, int defaultValue) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return defaultValue;
        }
        if (!value.canConvertToInt()) {
            return defaultValue;
        }
        return Math.max(0, value.asInt(defaultValue));
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static String escapeLikePattern(String value) {
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    private static Path expandHome(String path) {
        if (path.equals("~") || path.startsWith("~/")) {
            return Path.of(System.getProperty("user.home") + path.substring(1));
        }
        return Path.of(path);
    }

    private static final class DriverShim implements Driver {
        private final Driver driver;

        private DriverShim(Driver driver) {
            this.driver = driver;
        }

        @Override
        public Connection connect(String url, Properties info) throws SQLException {
            return driver.connect(url, info);
        }

        @Override
        public boolean acceptsURL(String url) throws SQLException {
            return driver.acceptsURL(url);
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
            return driver.getPropertyInfo(url, info);
        }

        @Override
        public int getMajorVersion() {
            return driver.getMajorVersion();
        }

        @Override
        public int getMinorVersion() {
            return driver.getMinorVersion();
        }

        @Override
        public boolean jdbcCompliant() {
            return driver.jdbcCompliant();
        }

        @Override
        public Logger getParentLogger() throws SQLFeatureNotSupportedException {
            return driver.getParentLogger();
        }
    }
}
