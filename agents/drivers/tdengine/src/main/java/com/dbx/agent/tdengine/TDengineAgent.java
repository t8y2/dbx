package com.dbx.agent.tdengine;

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
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoField;
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

public final class TDengineAgent extends AbstractJdbcAgent {
    private static final long TABLE_CACHE_TTL_MILLIS = 10_000L;
    private static final DateTimeFormatter TDENGINE_TIMESTAMP_FORMAT =
        new DateTimeFormatterBuilder()
            .appendPattern("yyyy-MM-dd HH:mm:ss")
            .appendFraction(ChronoField.NANO_OF_SECOND, 3, 9, true)
            .toFormatter();
    private static final Pattern NUMERIC_PRECISION_PATTERN =
        Pattern.compile("(?i)^(decimal|numeric)\\((\\d+)(?:,\\s*\\d+)?\\)");
    private static final Pattern NUMERIC_SCALE_PATTERN =
        Pattern.compile("(?i)^(decimal|numeric)\\(\\d+,\\s*(\\d+)\\)");
    private static final Pattern CHARACTER_LENGTH_PATTERN =
        Pattern.compile("(?i)^(binary|nchar|varchar|varbinary)\\((\\d+)\\)");
    private static final Pattern COMPOSITE_KEY_PATTERN =
        Pattern.compile("(?i)\\bCOMPOSITE\\s+KEY\\b");
    private static final Pattern TDENGINE_VERSION_PATTERN =
        Pattern.compile("^(\\d+)\\.(\\d+)\\.(\\d+)(?:\\.|$)");

    private final Object tableCacheLock = new Object();
    private String tableCacheSchema = "";
    private long tableCacheTimeMillis;
    private List<TableInfo> tableCache = Collections.emptyList();
    private Connection restfulStateConnection;
    private String restfulOriginalCatalog;
    private String restfulOriginalDatabase;
    private boolean restInformationSchemaPagingEnabled;

    @Override
    protected String driverClass() {
        return TDengineTransport.WEBSOCKET.driverClass();
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        String connectionString = params.getConnection_string() == null ? "" : params.getConnection_string().trim();
        if (!connectionString.isBlank()) {
            return TDengineJdbcUrl.sanitizeConnectionString(connectionString);
        }
        TDengineJdbcUrl.TransportPreference preference = TDengineJdbcUrl.transportPreference(params.getUrl_params());
        TDengineTransport transport = preference == TDengineJdbcUrl.TransportPreference.REST
            ? TDengineTransport.REST
            : TDengineTransport.WEBSOCKET;
        return TDengineJdbcUrl.from(params, transport);
    }

    @Override
    protected void loadDriver(ConnectParams params) {
    }

    @Override
    protected Connection openConnection(ConnectParams params) throws Exception {
        return TDengineConnectionFactory.open(params);
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        clearTableCache();
        clearRestfulState();
        restInformationSchemaPagingEnabled = supportsRestInformationSchemaPaging(connection);
    }

    @Override
    protected void beforePooledConnectionReturn(Connection connection) throws Exception {
        if (restfulStateConnection != connection) {
            return;
        }
        try {
            restoreRestfulConnectionState(connection, restfulOriginalCatalog, restfulOriginalDatabase);
        } finally {
            clearRestfulState();
        }
    }

    @Override
    protected void afterDisconnect() {
        clearTableCache();
        clearRestfulState();
        restInformationSchemaPagingEnabled = false;
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
        if (normalized.hasLimit() && !normalized.hasFilter()) {
            if (restInformationSchemaPagingEnabled) {
                try {
                    return listTablesPageFromRestInformationSchema(schema, normalized);
                } catch (RuntimeException ignored) {
                }
            }
            return listTablesPageFromShow(schema, normalized);
        }
        return normalized.filterTables(listTablesFromShow(schema));
    }

    private List<TableInfo> listTablesPageFromRestInformationSchema(
        String schema,
        MetadataListConstraints constraints
    ) {
        return unchecked(() -> {
            int limit = constraints.getLimit();
            int offset = constraints.getOffset() == null ? 0 : constraints.getOffset();
            List<TableInfo> result = new ArrayList<>(limit);

            TablePageScan stablePage = queryTablesPage(
                "SHOW " + quoteQualifiedPrefix(schema) + "STABLES",
                "STABLE",
                false,
                offset,
                limit
            );
            result.addAll(stablePage.tables());
            if (result.size() >= limit) {
                return result;
            }

            int tableOffset = Math.max(0, offset - stablePage.scannedRows());
            result.addAll(queryInformationSchemaTablePage(
                schema,
                tableOffset,
                limit - result.size()
            ));
            return result;
        });
    }

    private List<TableInfo> listTablesPageFromShow(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            int limit = constraints.getLimit();
            int offset = constraints.getOffset() == null ? 0 : constraints.getOffset();
            List<TableInfo> result = new ArrayList<>(limit);

            TablePageScan stablePage = queryTablesPage(
                "SHOW " + quoteQualifiedPrefix(schema) + "STABLES",
                "STABLE",
                false,
                offset,
                limit
            );
            result.addAll(stablePage.tables());
            if (result.size() >= limit) {
                return result;
            }

            int tableOffset = Math.max(0, offset - stablePage.scannedRows());
            result.addAll(queryTablesPage(
                "SHOW " + quoteQualifiedPrefix(schema) + "TABLES",
                "TABLE",
                true,
                tableOffset,
                limit - result.size()
            ).tables());
            return result;
        });
    }

    private List<TableInfo> listTablesFromShow(String schema) {
        List<TableInfo> cached = cachedTables(schema);
        if (cached != null) {
            return cached;
        }
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            // Connector/J 3.6.3 ignores Statement#setMaxRows. Filtered and
            // unbounded callers still need the complete result, so cache that
            // scan briefly instead of repeating it for adjacent requests.
            result.addAll(queryTables("SHOW " + quoteQualifiedPrefix(schema) + "STABLES", "STABLE", false));
            result.addAll(queryTables("SHOW " + quoteQualifiedPrefix(schema) + "TABLES", "TABLE", true));

            Map<String, TableInfo> distinct = new LinkedHashMap<>();
            for (TableInfo table : result) {
                distinct.putIfAbsent(table.getTable_type() + ":" + table.getName(), table);
            }
            List<TableInfo> sorted = new ArrayList<>(distinct.values());
            sortTablesForHierarchy(sorted);
            cacheTables(schema, sorted);
            return copyTables(sorted);
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
        QueryResult result = JdbcExecutor.current().execute(
            requireConnected(),
            sql,
            prepareExecutionSchema(schema),
            this::setSchemaSQL,
            options.getMaxRows(),
            options.getFetchSize(),
            options.getTimeoutSecs(),
            this::resultValue
        );
        if (mayChangeMetadata(sql)) {
            clearTableCache();
        }
        return result;
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        return JdbcExecutor.current().executePage(
            requireConnected(),
            sql,
            prepareExecutionSchema(schema),
            this::setSchemaSQL,
            options,
            this::resultValue
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
            this::resultValue
        );
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "USE " + quoteIdentifier(schema);
    }

    @Override
    public QueryResult executeTransaction(List<String> statements, String schema) {
        QueryResult result = super.executeTransaction(statements, prepareExecutionSchema(schema));
        if (statements.stream().anyMatch(TDengineAgent::mayChangeMetadata)) {
            clearTableCache();
        }
        return result;
    }

    @Override
    public QueryResult executeBatch(List<String> statements, String schema) {
        QueryResult result = super.executeBatch(statements, prepareExecutionSchema(schema));
        if (statements.stream().anyMatch(TDengineAgent::mayChangeMetadata)) {
            clearTableCache();
        }
        return result;
    }

    private String prepareExecutionSchema(String schema) {
        return unchecked(() -> {
            Connection connection = requireConnected();
            if (schema != null
                && !schema.trim().isEmpty()
                && unwrapConnection(connection, RestfulConnection.class) != null
                && restfulStateConnection != connection) {
                restfulStateConnection = connection;
                restfulOriginalCatalog = connection.getCatalog();
                restfulOriginalDatabase = connection.getClientInfo(TSDBDriver.PROPERTY_KEY_DBNAME);
            }
            return prepareExecutionSchema(connection, schema);
        });
    }

    static String prepareExecutionSchema(Connection connection, String schema) throws SQLException {
        if (unwrapConnection(connection, RestfulConnection.class) == null || schema == null || schema.trim().isEmpty()) {
            return schema;
        }

        String database = schema.trim();
        // Connector/J 3.6.3 misparses quoted USE statements and puts the whole SQL in /rest/sql/<db>.
        connection.setCatalog(database);
        connection.setClientInfo(TSDBDriver.PROPERTY_KEY_DBNAME, database);
        return null;
    }

    static void restoreRestfulConnectionState(Connection connection, String catalog, String database) throws SQLException {
        connection.setCatalog(catalog);
        if (database == null) {
            connection.getClientInfo().remove(TSDBDriver.PROPERTY_KEY_DBNAME);
        } else {
            connection.setClientInfo(TSDBDriver.PROPERTY_KEY_DBNAME, database);
        }
    }

    private List<TableInfo> queryTables(String sql, String tableType, boolean includesStableName) throws Exception {
        List<TableInfo> result = new ArrayList<>();
        try (java.sql.Statement stmt = requireConnected().createStatement()) {
            try (ResultSet rs = stmt.executeQuery(sql)) {
                while (rs.next()) {
                    result.add(readShowTable(rs, tableType, includesStableName));
                }
            }
        }
        return result;
    }

    private TablePageScan queryTablesPage(
        String sql,
        String tableType,
        boolean includesStableName,
        int offset,
        int limit
    ) throws Exception {
        List<TableInfo> result = new ArrayList<>(limit);
        int scannedRows = 0;
        try (java.sql.Statement stmt = requireConnected().createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            while (result.size() < limit && rs.next()) {
                scannedRows += 1;
                if (scannedRows <= offset) {
                    continue;
                }
                result.add(readShowTable(rs, tableType, includesStableName));
            }
        }
        return new TablePageScan(result, scannedRows);
    }

    private List<TableInfo> queryInformationSchemaTablePage(String database, int offset, int limit) throws Exception {
        StringBuilder sql = new StringBuilder(
            "SELECT table_name, stable_name FROM information_schema.ins_tables WHERE db_name = ? LIMIT "
        ).append(limit);
        if (offset > 0) {
            sql.append(" OFFSET ").append(offset);
        }

        List<TableInfo> result = new ArrayList<>(limit);
        try (java.sql.PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
            stmt.setString(1, database);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String parentName = optionalString(rs, 2);
                    if (parentName != null && parentName.trim().isEmpty()) {
                        parentName = null;
                    }
                    result.add(new TableInfo(rs.getString(1), "TABLE", null, null, parentName));
                }
            }
        }
        return result;
    }

    private static TableInfo readShowTable(ResultSet rs, String tableType, boolean includesStableName) throws Exception {
        // SHOW TABLES returns the owning STABLE as its fourth column. It
        // is absent for ordinary tables and older servers, where this
        // best-effort read simply leaves the table at the root level.
        String parentName = includesStableName ? optionalString(rs, 4) : null;
        if (parentName != null && parentName.trim().isEmpty()) {
            parentName = null;
        }
        return new TableInfo(rs.getString(1), tableType, null, null, parentName);
    }

    private record TablePageScan(List<TableInfo> tables, int scannedRows) {
    }

    private static boolean supportsRestInformationSchemaPaging(Connection connection) {
        if (unwrapConnection(connection, RestfulConnection.class) == null) {
            return false;
        }
        try {
            return supportsRestInformationSchemaPagingVersion(connection.getMetaData().getDatabaseProductVersion());
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean supportsRestInformationSchemaPagingVersion(String version) {
        Matcher matcher = TDENGINE_VERSION_PATTERN.matcher(version == null ? "" : version.trim());
        if (!matcher.find()) {
            return false;
        }
        int major = Integer.parseInt(matcher.group(1));
        int minor = Integer.parseInt(matcher.group(2));
        int patch = Integer.parseInt(matcher.group(3));
        return major > 3 || (major == 3 && (minor > 3 || (minor == 3 && patch >= 8)));
    }

    private List<TableInfo> cachedTables(String schema) {
        String normalizedSchema = normalizedSchema(schema);
        synchronized (tableCacheLock) {
            if (cacheFresh(tableCacheTimeMillis) && tableCacheSchema.equals(normalizedSchema)) {
                return copyTables(tableCache);
            }
        }
        return null;
    }

    private void cacheTables(String schema, List<TableInfo> tables) {
        synchronized (tableCacheLock) {
            tableCacheSchema = normalizedSchema(schema);
            tableCache = copyTables(tables);
            tableCacheTimeMillis = System.currentTimeMillis();
        }
    }

    private void clearTableCache() {
        synchronized (tableCacheLock) {
            tableCacheSchema = "";
            tableCacheTimeMillis = 0L;
            tableCache = Collections.emptyList();
        }
    }

    private void clearRestfulState() {
        restfulStateConnection = null;
        restfulOriginalCatalog = null;
        restfulOriginalDatabase = null;
    }

    private static boolean cacheFresh(long cachedAtMillis) {
        return cachedAtMillis > 0L && System.currentTimeMillis() - cachedAtMillis <= TABLE_CACHE_TTL_MILLIS;
    }

    private static String normalizedSchema(String schema) {
        return schema == null ? "" : schema.trim();
    }

    private static List<TableInfo> copyTables(List<TableInfo> tables) {
        List<TableInfo> copies = new ArrayList<>(tables.size());
        for (TableInfo table : tables) {
            copies.add(new TableInfo(
                table.getName(),
                table.getTable_type(),
                table.getComment(),
                table.getParent_schema(),
                table.getParent_name()
            ));
        }
        return copies;
    }

    private static boolean mayChangeMetadata(String sql) {
        String normalized = sql == null ? "" : sql.trim().toLowerCase(Locale.ROOT);
        return normalized.startsWith("create ")
            || normalized.startsWith("drop ")
            || normalized.startsWith("alter ")
            || normalized.startsWith("rename ")
            || normalized.startsWith("truncate ");
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

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
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
