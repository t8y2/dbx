package com.dbx.agent.tdengine;

import com.dbx.agent.BaseDatabaseAgent;
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
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import com.taosdata.jdbc.TSDBDriver;
import com.taosdata.jdbc.rs.RestfulConnection;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class TDengineAgent extends BaseDatabaseAgent {
    private static final DateTimeFormatter TDENGINE_TIMESTAMP_FORMAT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS");
    private static final Pattern NUMERIC_PRECISION_PATTERN =
        Pattern.compile("(?i)^(decimal|numeric)\\((\\d+)(?:,\\s*\\d+)?\\)");
    private static final Pattern NUMERIC_SCALE_PATTERN =
        Pattern.compile("(?i)^(decimal|numeric)\\(\\d+,\\s*(\\d+)\\)");
    private static final Pattern CHARACTER_LENGTH_PATTERN =
        Pattern.compile("(?i)^(binary|nchar|varchar|varbinary)\\((\\d+)\\)");
    private static final Pattern COMPOSITE_KEY_PATTERN =
        Pattern.compile("(?i)\\bCOMPOSITE\\s+KEY\\b");

    private Connection connection;

    @Override
    public Connection getConnection() {
        return connection;
    }

    @Override
    public void connect(ConnectParams params) {
        uncheckedVoid(() -> {
            connection = TDengineConnectionFactory.open(params);
        });
    }

    @Override
    public boolean testConnection(ConnectParams params) {
        return unchecked(() -> {
            try (Connection conn = TDengineConnectionFactory.open(params)) {
                return conn.isValid(5);
            }
        });
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW DATABASES")) {
                while (rs.next()) {
                    String name = rs.getString(1);
                    if (!isSystemDatabase(name)) {
                        result.add(new DatabaseInfo(name));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<String> listSchemas() {
        return Collections.emptyList();
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return listTables(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (!normalized.tableTypeAllowed("TABLE")) {
            return Collections.emptyList();
        }
        try {
            return queryConstrainedTables(schema, normalized);
        } catch (RuntimeException ignored) {
            // TDengine 2.x does not expose information_schema.ins_stables/ins_tables.
            return normalized.filterTables(listTablesLegacy(schema));
        }
    }

    private List<TableInfo> listTablesLegacy(String schema) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            result.addAll(queryTables("SHOW " + quoteQualifiedPrefix(schema) + "STABLES", "STABLE"));
            result.addAll(queryTables("SHOW " + quoteQualifiedPrefix(schema) + "TABLES", "TABLE"));

            Map<String, TableInfo> distinct = new LinkedHashMap<>();
            for (TableInfo table : result) {
                distinct.putIfAbsent(table.getTable_type() + ":" + table.getName(), table);
            }
            List<TableInfo> sorted = new ArrayList<>(distinct.values());
            sortTablesForHierarchy(sorted);
            return sorted;
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        List<ObjectInfo> result = new ArrayList<>();
        for (TableInfo table : listTables(schema)) {
            result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
        }
        return result;
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery("DESCRIBE " + qualifiedName(schema, table))) {
                return readDescribeColumns(rs);
            }
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String source = getCreateSql(schema, name, objectType);
        if (source.isBlank()) {
            source = getTableDdl(schema, name);
        }
        return new ObjectSource(name, objectType, schema, source);
    }

    @Override
    public String getTableDdl(String schema, String table) {
        String source = getCreateSql(schema, table, "STABLE");
        if (source.isBlank()) {
            source = getCreateSql(schema, table, "TABLE");
        }
        if (source.isBlank()) {
            return super.getTableDdl(schema, table);
        }
        return source;
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
        return Collections.emptyList();
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        return JdbcExecutor.current().execute(
            requireConnected(),
            sql,
            prepareExecutionSchema(schema),
            this::setSchemaSQL,
            options.getMaxRows(),
            options.getFetchSize(),
            options.getTimeoutSecs(),
            this::tdengineResultValue
        );
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        return JdbcExecutor.current().executePage(
            requireConnected(),
            sql,
            prepareExecutionSchema(schema),
            this::setSchemaSQL,
            options,
            this::tdengineResultValue
        );
    }

    @Override
    public QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
        return JdbcExecutor.current().startTableRead(
            requireConnected(),
            sql,
            prepareExecutionSchema(schema),
            this::setSchemaSQL,
            options,
            this::tdengineResultValue
        );
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "USE " + quoteIdentifier(schema);
    }

    @Override
    public QueryResult executeTransaction(List<String> statements, String schema) {
        return super.executeTransaction(statements, prepareExecutionSchema(schema));
    }

    @Override
    public QueryResult executeBatch(List<String> statements, String schema) {
        return super.executeBatch(statements, prepareExecutionSchema(schema));
    }

    private String prepareExecutionSchema(String schema) {
        return unchecked(() -> prepareExecutionSchema(requireConnected(), schema));
    }

    static String prepareExecutionSchema(Connection connection, String schema) throws SQLException {
        if (!(connection instanceof RestfulConnection) || schema == null || schema.trim().isEmpty()) {
            return schema;
        }

        String database = schema.trim();
        // Connector/J 3.6.3 misparses quoted USE statements and puts the whole SQL in /rest/sql/<db>.
        connection.setCatalog(database);
        connection.setClientInfo(TSDBDriver.PROPERTY_KEY_DBNAME, database);
        return null;
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

    private List<TableInfo> queryTables(String sql, String tableType) throws Exception {
        List<TableInfo> result = new ArrayList<>();
        try (java.sql.Statement stmt = requireConnected().createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            while (rs.next()) {
                result.add(new TableInfo(rs.getString(1), tableType, null));
            }
        }
        return result;
    }

    private List<TableInfo> queryConstrainedTables(String database, MetadataListConstraints constraints) {
        return unchecked(() -> {
            TableMetadataQuery query = buildTableMetadataQuery(database, constraints);
            List<TableInfo> result = new ArrayList<>();
            try (java.sql.PreparedStatement stmt = requireConnected().prepareStatement(query.sql())) {
                MetadataSqlSupport.bind(stmt, query.args());
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            rs.getString(1),
                            rs.getString(2),
                            optionalString(rs, 3),
                            null,
                            optionalString(rs, 4)
                        ));
                    }
                }
            }
            MetadataListConstraints postFilter = constraints.hasLimit() ? constraints.withoutPaging() : constraints;
            return postFilter.filterTables(result);
        });
    }

    static TableMetadataQuery buildTableMetadataQuery(String database, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder("""
            SELECT table_name, table_type, table_comment, parent_name
            FROM (
                SELECT stable_name AS table_name,
                       'STABLE' AS table_type,
                       table_comment,
                       CAST(NULL AS VARCHAR(192)) AS parent_name,
                       stable_name AS hierarchy_name,
                       0 AS hierarchy_rank
                FROM information_schema.ins_stables
                WHERE db_name = ?
                UNION ALL
                SELECT table_name,
                       'TABLE' AS table_type,
                       table_comment,
                       stable_name AS parent_name,
                       CASE WHEN stable_name IS NULL THEN table_name ELSE stable_name END AS hierarchy_name,
                       1 AS hierarchy_rank
                FROM information_schema.ins_tables
                WHERE db_name = ?
            ) metadata
            WHERE 1 = 1
            """.stripIndent().trim());
        args.add(database);
        args.add(database);
        if (normalized.hasFilter()) {
            String pattern = normalized.fuzzyLikePattern();
            sql.append(" AND (table_name LIKE ? OR table_comment LIKE ?)");
            args.add(pattern);
            args.add(pattern);
        }
        sql.append(" ORDER BY hierarchy_name, hierarchy_rank, table_name");
        MetadataSqlSupport.appendLiteralLimitOffset(sql, normalized);
        return new TableMetadataQuery(sql.toString(), args);
    }

    static final class TableMetadataQuery {
        private final String sql;
        private final List<Object> args;

        TableMetadataQuery(String sql, List<Object> args) {
            this.sql = sql;
            this.args = args;
        }

        String sql() {
            return sql;
        }

        List<Object> args() {
            return args;
        }
    }

    static void sortTablesForHierarchy(List<TableInfo> tables) {
        tables.sort((left, right) -> {
            String leftGroup = hierarchyGroupName(left);
            String rightGroup = hierarchyGroupName(right);
            int groupCompared = leftGroup.compareTo(rightGroup);
            if (groupCompared != 0) {
                return groupCompared;
            }

            boolean leftIsParent = left.getParent_name() == null;
            boolean rightIsParent = right.getParent_name() == null;
            if (leftIsParent != rightIsParent) {
                return leftIsParent ? -1 : 1;
            }
            return left.getName().toLowerCase(Locale.ROOT).compareTo(right.getName().toLowerCase(Locale.ROOT));
        });
    }

    private static String hierarchyGroupName(TableInfo table) {
        String parentName = table.getParent_name();
        String groupName = parentName == null || parentName.trim().isEmpty() ? table.getName() : parentName;
        return groupName.toLowerCase(Locale.ROOT);
    }

    static List<ColumnInfo> readDescribeColumns(ResultSet rs) throws Exception {
        List<ColumnInfo> result = new ArrayList<>();
        int ordinal = 0;
        while (rs.next()) {
            ordinal += 1;
            String name = rs.getString(1);
            String dataType = coalesce(rs.getString(2));
            String note = optionalString(rs, 4);
            boolean isTag = note != null && note.toUpperCase(Locale.ROOT).contains("TAG");
            boolean isPrimaryKey = !isTag && (ordinal == 1 || (note != null && COMPOSITE_KEY_PATTERN.matcher(note).find()));
            result.add(new ColumnInfo(
                name,
                dataType,
                !isPrimaryKey,
                null,
                isPrimaryKey,
                note,
                isTag ? "TAG" : null,
                parseNumericPrecision(dataType),
                parseNumericScale(dataType),
                parseCharacterMaximumLength(dataType)
            ));
        }
        return result;
    }

    private String getCreateSql(String schema, String name, String objectType) {
        String showType = switch (objectType.toUpperCase(Locale.ROOT)) {
            case "STABLE", "SUPER TABLE", "SUPERTABLE" -> "STABLE";
            case "TABLE", "BASE TABLE", "CHILD TABLE" -> "TABLE";
            default -> null;
        };
        if (showType == null) {
            return "";
        }

        try (java.sql.Statement stmt = requireConnected().createStatement();
             ResultSet rs = stmt.executeQuery("SHOW CREATE " + showType + " " + qualifiedName(schema, name))) {
            if (!rs.next()) {
                return "";
            }
            int columnCount = rs.getMetaData().getColumnCount();
            for (int i = 2; i <= columnCount; i++) {
                String value = rs.getString(i);
                if (value != null && value.toUpperCase(Locale.ROOT).contains("CREATE")) {
                    return value;
                }
            }
            String value = rs.getString(columnCount);
            return value == null ? "" : value;
        } catch (Exception e) {
            return "";
        }
    }

    private Object tdengineResultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = switch (sqlType) {
                case Types.BIGINT -> rs.getLong(index);
                case Types.INTEGER, Types.SMALLINT, Types.TINYINT -> rs.getInt(index);
                case Types.FLOAT, Types.REAL -> rs.getFloat(index);
                case Types.DOUBLE -> rs.getDouble(index);
                case Types.DECIMAL, Types.NUMERIC -> rs.getBigDecimal(index);
                case Types.BOOLEAN, Types.BIT -> rs.getBoolean(index);
                default -> rs.getObject(index);
            };
            return rs.wasNull() ? null : decodeTdengineValue(value);
        });
    }

    public static Object decodeTdengineValue(Object value) {
        if (value instanceof byte[] bytes) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
        if (value instanceof Timestamp timestamp) {
            return TDENGINE_TIMESTAMP_FORMAT.format(timestamp.toLocalDateTime());
        }
        return value;
    }

    private static String quoteQualifiedPrefix(String schema) {
        String trimmed = schema.trim();
        return trimmed.isEmpty() ? "" : quoteIdentifier(trimmed) + ".";
    }

    private static String qualifiedName(String schema, String name) {
        String table = quoteIdentifier(name);
        String trimmed = schema.trim();
        return trimmed.isEmpty() ? table : quoteIdentifier(trimmed) + "." + table;
    }

    private static String quoteIdentifier(String identifier) {
        return "`" + identifier.replace("`", "``") + "`";
    }

    private static boolean isSystemDatabase(String name) {
        if (name == null) {
            return false;
        }
        String normalized = name.trim().toLowerCase(Locale.ROOT);
        return "information_schema".equals(normalized) || "performance_schema".equals(normalized);
    }

    private static Integer parseNumericPrecision(String dataType) {
        return parseIntGroup(NUMERIC_PRECISION_PATTERN, dataType, 2);
    }

    private static Integer parseNumericScale(String dataType) {
        return parseIntGroup(NUMERIC_SCALE_PATTERN, dataType, 2);
    }

    private static Integer parseCharacterMaximumLength(String dataType) {
        return parseIntGroup(CHARACTER_LENGTH_PATTERN, dataType, 2);
    }

    private static Integer parseIntGroup(Pattern pattern, String value, int group) {
        Matcher matcher = pattern.matcher(value);
        if (!matcher.find()) {
            return null;
        }
        try {
            return Integer.valueOf(matcher.group(group));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String optionalString(ResultSet rs, int index) {
        try {
            return rs.getString(index);
        } catch (Exception e) {
            return null;
        }
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(TDengineAgent::new).run();
    }
}

final class TDengineJdbcUrl {
    enum TransportPreference {
        AUTO,
        WEBSOCKET,
        REST
    }

    private static final String PARAM_TRANSPORT = "transport";
    private static final String PARAM_DBX_TRANSPORT = "dbx.transport";

    private TDengineJdbcUrl() {
    }

    static String from(ConnectParams params) {
        TransportPreference preference = transportPreference(params.getUrl_params());
        if (preference == TransportPreference.REST) {
            return from(params, TDengineTransport.REST);
        }
        String host = params.getHost().isBlank() ? "localhost" : params.getHost();
        int port = params.getPort() > 0 ? params.getPort() : 6041;
        String database = params.getDatabase().trim();
        String path = database.isBlank() ? "/" : "/" + database;
        String query = normalizeQueryString(params.getUrl_params());
        String suffix = query.isBlank() ? "" : "?" + query;
        return "jdbc:TAOS-WS://" + host + ":" + port + path + suffix;
    }

    static String from(ConnectParams params, TDengineTransport transport) {
        String host = params.getHost().isBlank() ? "localhost" : params.getHost();
        int port = params.getPort() > 0 ? params.getPort() : 6041;
        String database = params.getDatabase().trim();
        String path = database.isBlank() ? "/" : "/" + database;
        String query = normalizeQueryString(params.getUrl_params());
        String suffix = query.isBlank() ? "" : "?" + query;
        return transport.urlPrefix() + host + ":" + port + path + suffix;
    }

    static String sanitizeConnectionString(String connectionString) {
        if (connectionString == null || connectionString.isBlank()) {
            return "";
        }
        int queryIndex = connectionString.indexOf('?');
        if (queryIndex < 0) {
            return connectionString;
        }
        String base = connectionString.substring(0, queryIndex);
        String rawQuery = connectionString.substring(queryIndex + 1);
        int fragmentIndex = rawQuery.indexOf('#');
        String fragment = "";
        if (fragmentIndex >= 0) {
            fragment = rawQuery.substring(fragmentIndex);
            rawQuery = rawQuery.substring(0, fragmentIndex);
        }
        String query = normalizeQueryString(rawQuery);
        if (query.isBlank()) {
            return base + fragment;
        }
        return base + "?" + query + fragment;
    }

    static TransportPreference transportPreference(String rawQuery) {
        String query = rawQuery == null ? "" : rawQuery.trim();
        if (query.startsWith("?")) {
            query = query.substring(1);
        }
        if (query.isBlank()) {
            return TransportPreference.AUTO;
        }
        String[] parts = query.split("&");
        for (String part : parts) {
            if (part == null || part.isBlank()) {
                continue;
            }
            int index = part.indexOf('=');
            String key = index < 0 ? part.trim() : part.substring(0, index).trim();
            if (!PARAM_TRANSPORT.equalsIgnoreCase(key) && !PARAM_DBX_TRANSPORT.equalsIgnoreCase(key)) {
                continue;
            }
            String value = index < 0 ? "" : part.substring(index + 1).trim();
            if ("rest".equalsIgnoreCase(value) || "rs".equalsIgnoreCase(value)) {
                return TransportPreference.REST;
            }
            if ("ws".equalsIgnoreCase(value) || "websocket".equalsIgnoreCase(value)) {
                return TransportPreference.WEBSOCKET;
            }
        }
        return TransportPreference.AUTO;
    }

    private static String normalizeQueryString(String rawQuery) {
        String query = rawQuery == null ? "" : rawQuery.trim();
        if (query.startsWith("?")) {
            query = query.substring(1);
        }
        if (query.isBlank()) {
            return "";
        }
        String[] parts = query.split("&");
        List<String> kept = new ArrayList<>();
        for (String part : parts) {
            if (part == null || part.isBlank()) {
                continue;
            }
            int index = part.indexOf('=');
            String key = index < 0 ? part.trim() : part.substring(0, index).trim();
            if (PARAM_TRANSPORT.equalsIgnoreCase(key) || PARAM_DBX_TRANSPORT.equalsIgnoreCase(key)) {
                continue;
            }
            kept.add(part);
        }
        return String.join("&", kept);
    }
}

enum TDengineTransport {
    WEBSOCKET("jdbc:TAOS-WS://", "com.taosdata.jdbc.ws.WebSocketDriver"),
    REST("jdbc:TAOS-RS://", "com.taosdata.jdbc.rs.RestfulDriver");

    private final String urlPrefix;
    private final String driverClass;

    TDengineTransport(String urlPrefix, String driverClass) {
        this.urlPrefix = urlPrefix;
        this.driverClass = driverClass;
    }

    String urlPrefix() {
        return urlPrefix;
    }

    String driverClass() {
        return driverClass;
    }
}

final class TDengineConnectionFactory {
    private static final int AUTO_TRANSPORT_ATTEMPT_TIMEOUT_SECONDS = 8;

    private TDengineConnectionFactory() {
    }

    static Connection open(ConnectParams params) throws Exception {
        String explicitConnectionString = params.getConnection_string() == null ? "" : params.getConnection_string().trim();
        if (!explicitConnectionString.isBlank()) {
            String sanitizedConnectionString = TDengineJdbcUrl.sanitizeConnectionString(explicitConnectionString);
            Class.forName(driverClassFromConnectionString(sanitizedConnectionString));
            return DriverManager.getConnection(sanitizedConnectionString, params.getUsername(), params.getPassword());
        }

        TDengineJdbcUrl.TransportPreference preference = TDengineJdbcUrl.transportPreference(params.getUrl_params());
        TDengineTransport[] candidates = transportsFor(preference);
        Exception firstError = null;
        for (TDengineTransport transport : candidates) {
            try {
                Connection connection = preference == TDengineJdbcUrl.TransportPreference.AUTO
                    ? openWithAttemptTimeout(params, transport)
                    : openDirect(params, transport);
                return connection;
            } catch (Exception e) {
                if (firstError == null) {
                    firstError = e;
                } else {
                    firstError.addSuppressed(e);
                }
            }
        }
        if (firstError != null) {
            throw new RuntimeException("Failed to connect TDengine using transports: " + candidateNames(candidates), firstError);
        }
        throw new IllegalStateException("No TDengine transport available.");
    }

    private static Connection openDirect(ConnectParams params, TDengineTransport transport) throws Exception {
        Class.forName(transport.driverClass());
        String url = TDengineJdbcUrl.from(params, transport);
        return DriverManager.getConnection(url, params.getUsername(), params.getPassword());
    }

    private static Connection openWithAttemptTimeout(ConnectParams params, TDengineTransport transport) throws Exception {
        String threadName = "tdengine-connect-" + transport.name().toLowerCase(Locale.ROOT);
        ThreadFactory factory = runnable -> {
            Thread thread = new Thread(runnable, threadName);
            thread.setDaemon(true);
            return thread;
        };
        ExecutorService executor = Executors.newSingleThreadExecutor(factory);
        try {
            Future<Connection> future = executor.submit(new Callable<Connection>() {
                @Override
                public Connection call() throws Exception {
                    return openDirect(params, transport);
                }
            });
            return future.get(AUTO_TRANSPORT_ATTEMPT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            throw new RuntimeException(
                "TDengine " + transport.name().toLowerCase(Locale.ROOT)
                    + " transport connect timed out after " + AUTO_TRANSPORT_ATTEMPT_TIMEOUT_SECONDS + "s",
                e
            );
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Interrupted while connecting TDengine via " + transport.name().toLowerCase(Locale.ROOT), e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception exception) {
                throw exception;
            }
            throw new RuntimeException(cause);
        } finally {
            executor.shutdownNow();
        }
    }

    private static TDengineTransport[] transportsFor(TDengineJdbcUrl.TransportPreference preference) {
        return switch (preference) {
            case REST -> new TDengineTransport[] {TDengineTransport.REST};
            case WEBSOCKET -> new TDengineTransport[] {TDengineTransport.WEBSOCKET};
            case AUTO -> new TDengineTransport[] {TDengineTransport.WEBSOCKET, TDengineTransport.REST};
        };
    }

    private static String candidateNames(TDengineTransport[] candidates) {
        List<String> names = new ArrayList<>();
        for (TDengineTransport candidate : candidates) {
            names.add(candidate.name().toLowerCase(Locale.ROOT));
        }
        return String.join(" -> ", names);
    }

    private static String driverClassFromConnectionString(String connectionString) {
        if (connectionString.regionMatches(true, 0, TDengineTransport.REST.urlPrefix(), 0, TDengineTransport.REST.urlPrefix().length())) {
            return TDengineTransport.REST.driverClass();
        }
        if (connectionString.regionMatches(true, 0, TDengineTransport.WEBSOCKET.urlPrefix(), 0, TDengineTransport.WEBSOCKET.urlPrefix().length())) {
            return TDengineTransport.WEBSOCKET.driverClass();
        }
        return TDengineTransport.WEBSOCKET.driverClass();
    }
}
