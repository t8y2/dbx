package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Clob;
import java.sql.DatabaseMetaData;
import java.sql.Date;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.ParameterMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLClientInfoException;
import java.sql.SQLFeatureNotSupportedException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.sql.Statement;
import java.sql.Time;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.TemporalAccessor;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.logging.Logger;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public final class DbxJdbcPlugin {
    private static final ObjectMapper MAPPER =
        new ObjectMapper().configure(SerializationFeature.WRITE_BIGDECIMAL_AS_PLAIN, true);
    private static final int MAX_ROWS = 10_000;
    private static final String JDBCX_URL_PREFIX = "jdbcx:";
    private static final String JDBCX_EXTENSION_WHITELIST_PROPERTY = "jdbcx.extension.whitelist";
    private static final String JDBCX_HIGH_PRIVILEGE_EXTENSIONS_OPT_IN = "-Ddbx.jdbcx.allowHighPrivilegeExtensions=";
    private static final String JDBCX_SAFE_EXTENSION_WHITELIST = "help,var,version";
    private static final int PHOENIX_VARBINARY_ENCODED_TYPE = 9000;
    private static final String PHOENIX_VARBINARY_ENCODED_TYPE_NAME = "VARBINARY_ENCODED";
    private static final Pattern PHOENIX_SYSTEM_CATALOG_WILDCARD = Pattern.compile(
        "^SELECT\\s+\\*\\s+FROM\\s+(?:SYSTEM|\\\"SYSTEM\\\")\\s*\\.\\s*(?:CATALOG|\\\"CATALOG\\\")$",
        Pattern.CASE_INSENSITIVE
    );
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
        false,
        null,
        StatementMaxRowsMode.READ_LOOP_ONLY
    );
    private static final JdbcDriverQuirks USE_CATALOG_QUIRKS = DEFAULT_QUIRKS.withUseCatalogFallbackSql(true);
    private static final JdbcDriverQuirks HIVE_QUIRKS = USE_CATALOG_QUIRKS.withSchemasAsDatabasesFallback(true);
    private static final JdbcDriverQuirks KINGBASE_QUIRKS = DEFAULT_QUIRKS.withIgnoreCatalogForSchemaMetadata(true);
    private static final JdbcDriverQuirks TAOS_QUIRKS = DEFAULT_QUIRKS
        .withPreferExecuteQueryForResultSetSql(true)
        .withDatabaseClientInfoProperty("dbname");
    private static final JdbcDriverQuirks YASHAN_QUIRKS = new JdbcDriverQuirks(
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        null,
        StatementMaxRowsMode.APPLY_STATEMENT_MAX_ROWS
    );
    private static final JdbcDriverQuirks IRIS_QUIRKS = new JdbcDriverQuirks(
        true,
        false,
        true,
        false,
        false,
        false,
        false,
        null,
        StatementMaxRowsMode.READ_LOOP_ONLY
    );
    private static final JdbcDriverQuirks ORACLE_QUIRKS = new JdbcDriverQuirks(
        false,
        true,
        false,
        false,
        false,
        false,
        false,
        null,
        StatementMaxRowsMode.APPLY_STATEMENT_MAX_ROWS
    );
    private static final List<JdbcDriverQuirkRule> DRIVER_QUIRK_RULES = List.of(
        new JdbcDriverQuirkRule("jdbc:mysql:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:mariadb:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:starrocks:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:doris:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:hive2:", HIVE_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:kingbase", KINGBASE_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:yasdb:", YASHAN_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:iris:", IRIS_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:oracle:", ORACLE_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:dm:", ORACLE_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:taos:", TAOS_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:taos-ws:", TAOS_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:taos-rs:", TAOS_QUIRKS)
    );
    private static String registeredDriverKey = "";
    private static Driver registeredDriver;
    private static String sharedConnectionKey = "";
    private static Connection sharedConnection;
    private static boolean manualTransactionActive;
    private static final Map<String, QuerySession> QUERY_SESSIONS = new HashMap<>();

    record JdbcDriverQuirks(
        boolean skipExecutionContext,
        boolean useOracleMetadata,
        boolean caseInsensitiveSchemaMetadata,
        boolean useCatalogFallbackSql,
        boolean ignoreCatalogForSchemaMetadata,
        boolean preferExecuteQueryForResultSetSql,
        boolean schemasAsDatabasesFallback,
        String databaseClientInfoProperty,
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
                schemasAsDatabasesFallback,
                databaseClientInfoProperty,
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
                schemasAsDatabasesFallback,
                databaseClientInfoProperty,
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
                schemasAsDatabasesFallback,
                databaseClientInfoProperty,
                statementMaxRowsMode
            );
        }

        JdbcDriverQuirks withSchemasAsDatabasesFallback(boolean value) {
            return new JdbcDriverQuirks(
                skipExecutionContext,
                useOracleMetadata,
                caseInsensitiveSchemaMetadata,
                useCatalogFallbackSql,
                ignoreCatalogForSchemaMetadata,
                preferExecuteQueryForResultSetSql,
                value,
                databaseClientInfoProperty,
                statementMaxRowsMode
            );
        }

        JdbcDriverQuirks withDatabaseClientInfoProperty(String value) {
            return new JdbcDriverQuirks(
                skipExecutionContext,
                useOracleMetadata,
                caseInsensitiveSchemaMetadata,
                useCatalogFallbackSql,
                ignoreCatalogForSchemaMetadata,
                preferExecuteQueryForResultSetSql,
                schemasAsDatabasesFallback,
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

        JsonNode connection = MAPPER.createObjectNode();
        try {
            String method = requireText(request, "method");
            JsonNode params = request.path("params");
            connection = params.path("connection");
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
        } catch (Throwable error) {
            // The plugin protocol boundary must report linkage errors from vendor drivers instead of exiting silently.
            ObjectNode errorNode = MAPPER.createObjectNode();
            errorNode.put("message", enrichDriverHint(connection, throwableMessage(error)));
            response.set("error", errorNode);
        }
        return response;
    }

    private static final Pattern ORACLE_UNSUPPORTED_CHARSET_PATTERN =
        Pattern.compile("(?i)unsupported charset|不支持的字符集");

    // Inceptor/Hive adhoc engine error code. Matched with word boundaries so that
    // incidental substrings (ports, durations like 107500 or 10750ms) do not trigger
    // the adhoc hint retry.
    private static final Pattern HIVE_ADHOC_ERROR_CODE_PATTERN = Pattern.compile("\\b10750\\b");

    // The base Oracle thin driver jar ships converters for a handful of charsets only;
    // databases such as ZHS16GBK need orai18n.jar, otherwise every metadata call that
    // reads dictionary comments fails wholesale.
    static String enrichDriverHint(JsonNode connection, String message) {
        if (message == null || !ORACLE_UNSUPPORTED_CHARSET_PATTERN.matcher(message).find()) {
            return message;
        }
        if (!isOracleUrl(jdbcUrl(connection))) {
            return message;
        }
        String hint = message.contains("不支持的字符集")
            ? "。请在 设置 → JDBC 驱动 中为该 Oracle 驱动一并导入同版本的 orai18n.jar，或改用 DBX 内置 Oracle 连接（默认驱动已支持中文多字节字符集）"
            : ". Import orai18n.jar (same version as the ojdbc driver) next to the Oracle driver under Settings -> JDBC Drivers, or use DBX's built-in Oracle connection instead, whose default driver supports multibyte Chinese charsets";
        return message.endsWith(hint) ? message : message + hint;
    }

    private static String throwableMessage(Throwable error) {
        List<Throwable> causes = new ArrayList<>();
        Throwable cause = error;
        while (cause != null && !causes.contains(cause)) {
            causes.add(cause);
            cause = cause.getCause();
        }
        for (int i = causes.size() - 1; i >= 0; i--) {
            Throwable current = causes.get(i);
            String message = informativeThrowableMessage(current);
            if (message != null) {
                return message;
            }
            for (Throwable suppressed : current.getSuppressed()) {
                message = informativeThrowableMessage(suppressed);
                if (message != null) {
                    return message;
                }
            }
        }
        return causes.isEmpty() ? error.toString() : causes.get(causes.size() - 1).toString();
    }

    private static String informativeThrowableMessage(Throwable error) {
        String message = error.getMessage();
        if (error instanceof ClassNotFoundException || error instanceof NoClassDefFoundError) {
            String trimmed = message == null ? "" : message.trim();
            String className = trimmed.replace('/', '.');
            if (className.startsWith("io.modelcontextprotocol.")) {
                return "Missing JDBCX MCP runtime class " + className
                    + ". Install io.github.jdbcx:io.modelcontextprotocol with the version required by the selected JDBCX runtime.";
            }
            if (!className.isEmpty()) {
                return "Missing Java class " + className + ". Install the required runtime dependency.";
            }
        }
        if (error instanceof UnsupportedOperationException || error instanceof AbstractMethodError) {
            return describeThrowable(error);
        }
        if (message == null || message.isBlank()) {
            return null;
        }
        String trimmed = message.trim();
        return trimmed.equals(error.getClass().getName()) || trimmed.equals(error.getClass().getSimpleName())
            ? null
            : trimmed;
    }

    private static JsonNode handle(String method, JsonNode params, JsonNode connection) throws Exception {
        return switch (method) {
            case "testConnection" -> connectionTestResult(openConnection(connection));
            case "connect" -> {
                openConnection(connection);
                ObjectNode result = MAPPER.createObjectNode();
                result.put("ok", true);
                yield result;
            }
            case "connectionInfo" -> databaseInfoResult(openConnection(connection));
            case "executeQuery" -> executeQuery(
                connection,
                requireText(params, "sql"),
                optionalText(params, "database"),
                optionalText(params, "schema"),
                positiveInt(params, "maxRows", MAX_ROWS),
                nonNegativeInt(params, "fetchSize", 0),
                nonNegativeInt(params, "rowOffset", 0),
                nonNegativeInt(params, "timeoutSecs", -1)
            );
            case "beginManualTransaction", "begin_manual_transaction" -> beginManualTransaction(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema")
            );
            case "executeInManualTransaction", "execute_in_manual_transaction" -> executeInManualTransaction(
                connection,
                requireText(params, "sql"),
                optionalText(params, "database"),
                optionalText(params, "schema"),
                positiveInt(params, "maxRows", MAX_ROWS),
                nonNegativeInt(params, "fetchSize", 0),
                nonNegativeInt(params, "rowOffset", 0),
                nonNegativeInt(params, "timeoutSecs", -1)
            );
            case "commitManualTransaction", "commit_manual_transaction" -> commitManualTransaction();
            case "rollbackManualTransaction", "rollback_manual_transaction" -> rollbackManualTransaction();
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
                nonNegativeInt(params, "limit", 0),
                nonNegativeInt(params, "offset", 0),
                optionalStringList(params, "object_types")
            );
            case "listObjects", "list_objects" -> listObjects(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema"),
                optionalText(params, "filter"),
                nonNegativeInt(params, "limit", 0),
                nonNegativeInt(params, "offset", 0),
                optionalStringList(params, "object_types")
            );
            case "listIndexes", "list_indexes" -> listIndexes(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema"),
                requireText(params, "table")
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

    private static ObjectNode connectionTestResult(Connection connection) {
        ObjectNode result = MAPPER.createObjectNode();
        result.put("ok", true);
        ObjectNode databaseInfo = databaseInfo(connection);
        if (!databaseInfo.isEmpty()) {
            result.set("databaseInfo", databaseInfo);
        }
        return result;
    }

    private static ObjectNode databaseInfoResult(Connection connection) {
        ObjectNode result = MAPPER.createObjectNode();
        ObjectNode databaseInfo = databaseInfo(connection);
        if (!databaseInfo.isEmpty()) {
            result.set("databaseInfo", databaseInfo);
        }
        return result;
    }

    private static ObjectNode databaseInfo(Connection connection) {
        try {
            DatabaseMetaData metadata = connection.getMetaData();
            return metadata == null ? MAPPER.createObjectNode() : databaseInfo(metadata);
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            return MAPPER.createObjectNode();
        }
    }

    private static ObjectNode databaseInfo(DatabaseMetaData metadata) {
        ObjectNode info = MAPPER.createObjectNode();
        putMetadataText(info, "productName", metadata::getDatabaseProductName);
        putMetadataText(info, "productVersion", metadata::getDatabaseProductVersion);
        putIdentifierCase(
            info,
            "unquotedIdentifierCase",
            metadata::storesLowerCaseIdentifiers,
            metadata::storesUpperCaseIdentifiers,
            metadata::storesMixedCaseIdentifiers
        );
        putIdentifierCase(
            info,
            "quotedIdentifierCase",
            metadata::storesLowerCaseQuotedIdentifiers,
            metadata::storesUpperCaseQuotedIdentifiers,
            metadata::storesMixedCaseQuotedIdentifiers
        );
        putMetadataText(info, "driverName", metadata::getDriverName);
        putMetadataText(info, "driverVersion", metadata::getDriverVersion);
        Boolean supportsTransactions = readMetadata(metadata::supportsTransactions);
        if (supportsTransactions != null) {
            info.put("supportsTransactions", supportsTransactions);
        }

        Integer jdbcMajor = readMetadata(metadata::getJDBCMajorVersion);
        Integer jdbcMinor = readMetadata(metadata::getJDBCMinorVersion);
        if (jdbcMajor != null && jdbcMinor != null && jdbcMajor >= 0 && jdbcMinor >= 0) {
            info.put("jdbcVersion", jdbcMajor + "." + jdbcMinor);
        }
        return info;
    }

    private static void putMetadataText(ObjectNode target, String key, SqlSupplier<String> supplier) {
        String value = readMetadata(supplier);
        if (value != null && !value.trim().isEmpty()) {
            target.put(key, value.trim());
        }
    }

    private static void putIdentifierCase(
        ObjectNode target,
        String key,
        SqlSupplier<Boolean> lower,
        SqlSupplier<Boolean> upper,
        SqlSupplier<Boolean> mixed
    ) {
        if (Boolean.TRUE.equals(readMetadata(lower))) {
            target.put(key, "lower");
        } else if (Boolean.TRUE.equals(readMetadata(upper))) {
            target.put(key, "upper");
        } else if (Boolean.TRUE.equals(readMetadata(mixed))) {
            target.put(key, "mixed");
        }
    }

    private static <T> T readMetadata(SqlSupplier<T> supplier) {
        try {
            return supplier.get();
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            return null;
        }
    }

    private interface SqlSupplier<T> {
        T get() throws SQLException;
    }

    private static void registerDrivers(JsonNode connection) throws Exception {
        String driverKey = driverKey(connection);
        if (driverKey.equals(registeredDriverKey) && registeredDriver != null) {
            return;
        }
        closeSharedConnection();
        registeredDriver = null;
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
            Constructor<?> constructor = Class.forName(driverClass, true, loader).getDeclaredConstructor();
            constructor.setAccessible(true);
            Driver driver = (Driver) constructor.newInstance();
            registeredDriver = new DriverShim(driver);
            DriverManager.registerDriver(registeredDriver);
            registeredDriverKey = driverKey;
            return;
        }

        boolean loaded = false;
        Driver first = null;
        for (Driver driver : ServiceLoader.load(Driver.class, loader)) {
            Driver shim = new DriverShim(driver);
            if (first == null) {
                first = shim;
            }
            DriverManager.registerDriver(shim);
            loaded = true;
        }
        if (!loaded && !urls.isEmpty()) {
            throw new IllegalArgumentException("No JDBC driver was discovered. Enter the driver class name for this JAR.");
        }
        registeredDriver = first;
        registeredDriverKey = driverKey;
    }

    private static Connection openConnection(JsonNode connection) throws SQLException {
        String url = jdbcUrl(connection);
        if (url == null) {
            throw new IllegalArgumentException("JDBC URL is required.");
        }
        String key = connectionKey(connection);
        if (sharedConnection != null && key.equals(sharedConnectionKey) && !isConnectionClosed(sharedConnection)) {
            configureOrdinaryAutoCommit(sharedConnection);
            return sharedConnection;
        }
        closeSharedConnection();

        JdbcUrlCredentials urlCredentials = extractJdbcUrlCredentials(url);
        url = urlCredentials.url;
        Properties properties = new Properties();
        applyPhoenixUrlProperties(url, properties);
        String username = optionalText(connection, "username");
        String password = optionalText(connection, "password");
        if (username == null) {
            username = urlCredentials.username;
        }
        if (password == null) {
            password = urlCredentials.password;
        }
        if (username != null) {
            properties.setProperty("user", username);
        }
        if (password != null) {
            properties.setProperty("password", password);
        }
        applyConnectTimeout(connection, properties);
        applyJdbcxExtensionSecurity(connection, url, properties);
        if (isOracleUrl(url)) {
            applyOracleProperties(connection, properties);
        }
        // Prefer the explicitly registered driver. DriverManager.getConnection only catches
        // SQLException; Hive/Inceptor drivers may throw UnsupportedOperationException for optional
        // methods, which aborts connect before the intended driver is reached.
        sharedConnection = connectWithRegisteredDriver(url, properties);
        sharedConnectionKey = key;
        configureOrdinaryAutoCommit(sharedConnection);
        return sharedConnection;
    }

    private static Connection connectWithRegisteredDriver(String url, Properties properties) throws SQLException {
        if (registeredDriver != null) {
            try {
                Connection connection = registeredDriver.connect(url, properties);
                if (connection != null) {
                    return connection;
                }
            } catch (UnsupportedOperationException | AbstractMethodError error) {
                throw new SQLException("JDBC driver rejected connect for URL '" + url + "'", error);
            }
        }
        try {
            return DriverManager.getConnection(url, properties);
        } catch (UnsupportedOperationException | AbstractMethodError error) {
            throw new SQLException("JDBC DriverManager rejected connect for URL '" + url + "'", error);
        }
    }

    private static String describeThrowable(Throwable error) {
        if (error == null) {
            return "unknown error";
        }
        String message = error.getMessage();
        if (message != null && !message.isBlank()
            && !message.equals(error.getClass().getName())
            && !message.equals(error.getClass().getSimpleName())) {
            return error.getClass().getName() + ": " + message.trim();
        }
        StackTraceElement[] stack = error.getStackTrace();
        if (stack != null && stack.length > 0) {
            StackTraceElement top = stack[0];
            return error.getClass().getName() + " at " + top.getClassName() + "." + top.getMethodName()
                + "(" + top.getFileName() + ":" + top.getLineNumber() + ")";
        }
        return error.getClass().getName();
    }

    private static boolean isConnectionClosed(Connection connection) {
        try {
            return connection.isClosed();
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            // Hive-based drivers may throw UnsupportedOperationException for optional Connection methods.
            return true;
        }
    }

    private static void configureOrdinaryAutoCommit(Connection jdbcConnection) throws SQLException {
        if (manualTransactionActive || hasActiveQuerySession(jdbcConnection) || jdbcConnection.getAutoCommit()) {
            return;
        }
        jdbcConnection.setAutoCommit(true);
    }

    private static boolean hasActiveQuerySession(Connection jdbcConnection) {
        return QUERY_SESSIONS.values().stream().anyMatch(session -> session.connection == jdbcConnection);
    }

    private static boolean isPhoenixConnection(JsonNode connection, String url) {
        if (isPhoenixUrl(url)) {
            return true;
        }
        String driverClass = optionalText(connection, "jdbc_driver_class");
        return driverClass != null && driverClass.equalsIgnoreCase("org.apache.phoenix.jdbc.PhoenixDriver");
    }

    private static void applyPhoenixUrlProperties(String url, Properties properties) {
        if (!isPhoenixDirectUrl(url)) {
            return;
        }
        int propertiesStart = url.indexOf(';');
        if (propertiesStart < 0) {
            return;
        }
        // Phoenix builds its HBase client configuration from Driver.connect Properties,
        // while arbitrary semicolon URL attributes are not merged into QueryServices.
        for (String part : url.substring(propertiesStart + 1).split(";")) {
            int equals = part.indexOf('=');
            if (equals <= 0) {
                continue;
            }
            String key = part.substring(0, equals).trim();
            if (!key.isEmpty()) {
                properties.setProperty(key, part.substring(equals + 1).trim());
            }
        }
    }

    private static boolean isPhoenixDirectUrl(String url) {
        return isPhoenixUrl(url) && !urlMatchesPrefix(url, "jdbc:phoenix:thin:");
    }

    private static boolean isPhoenixUrl(String url) {
        String prefix = "jdbc:phoenix";
        if (url == null || !url.regionMatches(true, 0, prefix, 0, prefix.length())) {
            return false;
        }
        return url.length() == prefix.length() || url.charAt(prefix.length()) == ':' || url.charAt(prefix.length()) == ';';
    }

    private static void applyJdbcxExtensionSecurity(JsonNode connection, String url, Properties properties) {
        if (isJdbcxUrl(url) && !jdbcxHighPrivilegeExtensionsEnabled(connection)) {
            properties.setProperty(JDBCX_EXTENSION_WHITELIST_PROPERTY, JDBCX_SAFE_EXTENSION_WHITELIST);
        }
    }

    private static boolean isJdbcxUrl(String url) {
        return url != null && url.regionMatches(true, 0, JDBCX_URL_PREFIX, 0, JDBCX_URL_PREFIX.length());
    }

    private static boolean jdbcxHighPrivilegeExtensionsEnabled(JsonNode connection) {
        JsonNode options = connection.path("agent_java_options");
        if (!options.isArray()) {
            return false;
        }
        for (int i = options.size() - 1; i >= 0; i--) {
            String option = options.path(i).asText("").trim();
            if (option.startsWith(JDBCX_HIGH_PRIVILEGE_EXTENSIONS_OPT_IN)) {
                return Boolean.parseBoolean(option.substring(JDBCX_HIGH_PRIVILEGE_EXTENSIONS_OPT_IN.length()));
            }
        }
        return false;
    }

    private static void applyConnectTimeout(JsonNode connection, Properties properties) {
        int connectTimeoutSecs = positiveInt(connection, "connect_timeout_secs", 30);
        DriverManager.setLoginTimeout(connectTimeoutSecs);
        if (isPrestoOrTrinoConnection(connection) || isHive2Connection(connection)) {
            // Hive/Inceptor treat unknown timeout properties inconsistently; keep only
            // DriverManager login timeout and avoid injecting vendor-specific keys.
            return;
        }
        String value = Integer.toString(connectTimeoutSecs);
        properties.putIfAbsent("loginTimeout", value);
        if (!jdbcUrlHasParameter(jdbcUrl(connection), "connectTimeout")) {
            properties.putIfAbsent("connectTimeout", connectTimeoutPropertyValue(connection, connectTimeoutSecs));
        }
    }

    private static boolean isHive2Connection(JsonNode connection) {
        String url = jdbcUrl(connection);
        if (urlMatchesPrefix(url, "jdbc:hive2:")) {
            return true;
        }
        String driverClass = optionalText(connection, "jdbc_driver_class");
        if (driverClass == null) {
            return false;
        }
        String normalized = driverClass.toLowerCase(Locale.ROOT);
        return normalized.contains("hive") || normalized.contains("inceptor") || normalized.contains("kyuubi");
    }

    private static String connectTimeoutPropertyValue(JsonNode connection, int connectTimeoutSecs) {
        if (usesMillisecondConnectTimeout(connection)) {
            return Integer.toString(connectTimeoutSecs * 1000);
        }
        return Integer.toString(connectTimeoutSecs);
    }

    private static boolean usesMillisecondConnectTimeout(JsonNode connection) {
        String url = jdbcUrl(connection);
        if (
            urlMatchesPrefix(url, "jdbc:mysql:") ||
            urlMatchesPrefix(url, "jdbc:mariadb:") ||
            urlMatchesPrefix(url, "jdbc:starrocks:") ||
            urlMatchesPrefix(url, "jdbc:doris:")
        ) {
            return true;
        }
        String driverClass = optionalText(connection, "jdbc_driver_class");
        if (driverClass == null) {
            return false;
        }
        String normalized = driverClass.toLowerCase(Locale.ROOT);
        return normalized.equals("com.mysql.cj.jdbc.driver") ||
            normalized.equals("com.mysql.jdbc.driver") ||
            normalized.equals("org.mariadb.jdbc.driver");
    }

    private static boolean isPostgresConnection(JsonNode connection) {
        if (urlMatchesPrefix(jdbcUrl(connection), "jdbc:postgresql:")) {
            return true;
        }
        String driverClass = optionalText(connection, "jdbc_driver_class");
        return driverClass != null && driverClass.equalsIgnoreCase("org.postgresql.Driver");
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

    private static ZoneId tdengineTimestampZone(JsonNode connection, Connection jdbcConnection) {
        String url = jdbcUrl(connection);
        if (
            !urlMatchesPrefix(url, "jdbc:taos:") &&
            !urlMatchesPrefix(url, "jdbc:taos-ws:") &&
            !urlMatchesPrefix(url, "jdbc:taos-rs:")
        ) {
            return null;
        }
        try (
            Statement statement = jdbcConnection.createStatement();
            ResultSet result = statement.executeQuery("SELECT timezone()")
        ) {
            return result.next() ? parseTdengineTimezone(result.getString(1)) : null;
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            return null;
        }
    }

    static ZoneId parseTdengineTimezone(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String name = value.trim().split("\\s+", 2)[0];
        try {
            return ZoneId.of(name);
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static JsonNode executeQuery(
        JsonNode connection,
        String sql,
        String database,
        String schema,
        int maxRows,
        int fetchSize,
        int rowOffset,
        int timeoutSecs
    ) throws Exception {
        Connection conn = openConnection(connection);
        return executeQueryOnConnection(connection, conn, sql, database, schema, maxRows, fetchSize, rowOffset, timeoutSecs);
    }

    private static boolean shouldRetryWithAdhocHint(SQLException error) {
        String msg = error == null ? null : error.getMessage();
        if (msg == null) {
            return false;
        }
        String lower = msg.toLowerCase(Locale.ROOT);
        return lower.contains("adhoc") || HIVE_ADHOC_ERROR_CODE_PATTERN.matcher(msg).find() || lower.contains("stream query");
    }

    private static boolean isPlainSelectStatement(String sql) {
        if (sql == null || sql.isBlank()) {
            return false;
        }
        // Only plain SELECT statements are retried with the hint. WITH ... SELECT is
        // excluded because the hint would be injected before the first SELECT inside
        // the CTE body instead of the outer query; DML and other statements are not
        // silently rewritten and re-executed.
        return "SELECT".equals(firstSqlKeyword(sql));
    }

    private static String injectAdhocHint(String sql) {
        if (sql == null) {
            return null;
        }
        String trimmed = sql.trim();
        if (trimmed.isEmpty() || trimmed.toLowerCase(Locale.ROOT).contains("adhoc")) {
            return trimmed;
        }
        String body = stripLeadingSqlComments(trimmed);
        if (!body.regionMatches(true, 0, "SELECT", 0, 6)) {
            return trimmed;
        }
        int bodyStart = trimmed.length() - body.length();
        return trimmed.substring(0, bodyStart) + body.replaceFirst("(?i)^SELECT\\s+", "SELECT /*+ adhoc */ ");
    }

    private static ExecutedStatement executeStatementForResultWithAdhocRetry(
        JsonNode connection,
        Statement statement,
        String sql,
        JdbcDriverQuirks quirks
    ) throws SQLException {
        try {
            return executeStatementForResult(statement, sql, quirks);
        } catch (SQLException error) {
            if (isHive2RoutinesConnection(connection)
                && isPlainSelectStatement(sql)
                && shouldRetryWithAdhocHint(error)) {
                return executeStatementForResult(statement, injectAdhocHint(sql), quirks);
            }
            throw error;
        }
    }

    private static JsonNode executeQueryOnConnection(
        JsonNode connection,
        Connection conn,
        String sql,
        String database,
        String schema,
        int maxRows,
        int fetchSize,
        int rowOffset,
        int timeoutSecs
    ) throws Exception {
        long start = System.nanoTime();
        applyExecutionContext(connection, conn, database, schema);
        JdbcDriverQuirks quirks = driverQuirks(connection);
        boolean preserveOracleDateTime = isOracleUrl(jdbcUrl(connection));
        ZoneId timestampZone = tdengineTimestampZone(connection, conn);
        try (Statement statement = conn.createStatement()) {
            applyStatementOptions(statement, maxRows, fetchSize, timeoutSecs, quirks);
            String trimmedSql = trimStatementSql(sql);
            String effectiveSql = rewritePhoenixSystemCatalogQuery(connection, conn, trimmedSql);
            ExecutedStatement executed = executeStatementForResultWithAdhocRetry(connection, statement, effectiveSql, quirks);
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
                    for (int skipped = 0; skipped < rowOffset && rs.next(); skipped++) {
                        // Caché/IRIS does not support SQL offset pagination; advance
                        // the forward-only JDBC cursor before collecting this page.
                    }
                    while (rs.next()) {
                        if (rows.size() >= maxRows) {
                            truncated = true;
                            break;
                        }
                        ArrayNode row = MAPPER.createArrayNode();
                        for (int i = 1; i <= columnCount; i++) {
                            row.add(MAPPER.valueToTree(readValue(rs, meta, i, preserveOracleDateTime, timestampZone)));
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

    private static ObjectNode beginManualTransaction(JsonNode connection, String database, String schema)
        throws SQLException {
        if (manualTransactionActive) {
            throw new SQLException("A manual transaction is already active");
        }
        Connection conn = openConnection(connection);
        DatabaseMetaData metadata = readMetadata(conn::getMetaData);
        Boolean supportsTransactions = metadata == null ? null : readMetadata(metadata::supportsTransactions);
        if (Boolean.FALSE.equals(supportsTransactions)) {
            throw new SQLFeatureNotSupportedException("This JDBC driver does not support transactions");
        }
        applyExecutionContext(connection, conn, database, schema);
        conn.setAutoCommit(false);
        manualTransactionActive = true;
        return okResult();
    }

    private static JsonNode executeInManualTransaction(
        JsonNode connection,
        String sql,
        String database,
        String schema,
        int maxRows,
        int fetchSize,
        int rowOffset,
        int timeoutSecs
    ) throws Exception {
        Connection conn = activeManualTransactionConnection(connection);
        return executeQueryOnConnection(connection, conn, sql, database, schema, maxRows, fetchSize, rowOffset, timeoutSecs);
    }

    private static ObjectNode commitManualTransaction() throws SQLException {
        Connection conn = activeManualTransactionConnection(null);
        conn.commit();
        conn.setAutoCommit(true);
        manualTransactionActive = false;
        return okResult();
    }

    private static ObjectNode rollbackManualTransaction() throws SQLException {
        Connection conn = activeManualTransactionConnection(null);
        conn.rollback();
        conn.setAutoCommit(true);
        manualTransactionActive = false;
        return okResult();
    }

    private static Connection activeManualTransactionConnection(JsonNode connection) throws SQLException {
        if (!manualTransactionActive || sharedConnection == null || sharedConnection.isClosed()) {
            throw new SQLException("No manual transaction is active");
        }
        if (connection != null && !connectionKey(connection).equals(sharedConnectionKey)) {
            throw new SQLException("The manual transaction belongs to a different JDBC connection");
        }
        return sharedConnection;
    }

    private static ObjectNode okResult() {
        ObjectNode result = MAPPER.createObjectNode();
        result.put("ok", true);
        return result;
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
        private final Connection connection;
        private final boolean restoreAutoCommit;
        private final boolean preserveOracleDateTime;
        private final ZoneId timestampZone;
        private int rowsReturned;
        private ArrayNode pendingRow;

        private QuerySession(
            String id,
            Statement statement,
            ResultSet resultSet,
            ResultSetMetaData meta,
            ArrayNode columns,
            int maxRows,
            long startNanos,
            Connection connection,
            boolean restoreAutoCommit,
            boolean preserveOracleDateTime,
            ZoneId timestampZone
        ) {
            this.id = id;
            this.statement = statement;
            this.resultSet = resultSet;
            this.meta = meta;
            this.columns = columns;
            this.maxRows = Math.max(1, maxRows);
            this.startNanos = startNanos;
            this.connection = connection;
            this.restoreAutoCommit = restoreAutoCommit;
            this.preserveOracleDateTime = preserveOracleDateTime;
            this.timestampZone = timestampZone;
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
        boolean preserveOracleDateTime = isOracleUrl(jdbcUrl(connection));
        ZoneId timestampZone = tdengineTimestampZone(connection, conn);
        boolean restoreAutoCommit = beginPagedQueryTransaction(connection, conn);
        Statement statement;
        try {
            statement = createPagedQueryStatement(conn);
        } catch (Exception | LinkageError error) {
            restorePagedQueryTransaction(conn, restoreAutoCommit);
            throw error;
        }
        try {
            applyStatementOptions(statement, maxRows, fetchSize, timeoutSecs, quirks);
            String trimmedSql = trimStatementSql(sql);
            String effectiveSql = rewritePhoenixSystemCatalogQuery(connection, conn, trimmedSql);
            ExecutedStatement executed = executeStatementForResultWithAdhocRetry(connection, statement, effectiveSql, quirks);
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
                restorePagedQueryTransaction(conn, restoreAutoCommit);
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
            QuerySession session = new QuerySession(
                sessionId,
                statement,
                rs,
                meta,
                columns,
                maxRows,
                start,
                conn,
                restoreAutoCommit,
                preserveOracleDateTime,
                timestampZone
            );
            QUERY_SESSIONS.put(sessionId, session);
            try {
                return readQuerySessionPage(session, pageSize);
            } catch (Exception | LinkageError error) {
                QUERY_SESSIONS.remove(sessionId);
                throw error;
            }
        } catch (Exception | LinkageError error) {
            try {
                statement.close();
            } catch (Exception ignored) {
            }
            restorePagedQueryTransaction(conn, restoreAutoCommit);
            throw error;
        }
    }

    private static Statement createPagedQueryStatement(Connection connection) throws SQLException {
        try {
            return connection.createStatement(ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY);
        } catch (SQLFeatureNotSupportedException | UnsupportedOperationException | AbstractMethodError ignored) {
            return connection.createStatement();
        }
    }

    private static boolean beginPagedQueryTransaction(JsonNode connectionConfig, Connection connection)
        throws SQLException {
        if (!isPostgresConnection(connectionConfig) || !connection.getAutoCommit()) {
            return false;
        }
        connection.setAutoCommit(false);
        return true;
    }

    private static void restorePagedQueryTransaction(Connection connection, boolean restoreAutoCommit) {
        if (!restoreAutoCommit) {
            return;
        }
        try {
            connection.rollback();
        } catch (SQLException ignored) {
        }
        try {
            connection.setAutoCommit(true);
        } catch (SQLException ignored) {
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
                row = readRow(session.resultSet, session.meta, session.preserveOracleDateTime, session.timestampZone);
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

        session.pendingRow = readRow(session.resultSet, session.meta, session.preserveOracleDateTime, session.timestampZone);
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
        restorePagedQueryTransaction(session.connection, session.restoreAutoCommit);
        return true;
    }

    private static void closeAllQuerySessions() {
        List<String> sessionIds = new ArrayList<>(QUERY_SESSIONS.keySet());
        for (String sessionId : sessionIds) {
            closeQuerySession(sessionId);
        }
    }

    private static ArrayNode readRow(
        ResultSet rs,
        ResultSetMetaData meta,
        boolean preserveOracleDateTime,
        ZoneId timestampZone
    ) throws SQLException {
        ArrayNode row = MAPPER.createArrayNode();
        for (int i = 1; i <= meta.getColumnCount(); i++) {
            row.add(MAPPER.valueToTree(readValue(rs, meta, i, preserveOracleDateTime, timestampZone)));
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

        if (!autotrace && isOracleConnection(connection)) {
            planText = getOracleExplainInfo(conn, sql, timeoutSecs);
            dmMethod = "oracle-plan-table";
        }

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
        } else if (planText == null) {
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

    private static boolean isOracleConnection(JsonNode connection) {
        String url = optionalText(connection, "connection_string");
        return url != null && url.regionMatches(true, 0, "jdbc:oracle:", 0, "jdbc:oracle:".length());
    }

    private static String getOracleExplainInfo(Connection connection, String sql, int timeoutSecs) throws SQLException {
        String statementId = "DBX_" + UUID.randomUUID().toString().replace("-", "").substring(0, 26);
        String statementSql = trimStatementSql(sql);
        StringBuilder plan = new StringBuilder();
        try {
            try (PreparedStatement explain = connection.prepareStatement(
                "EXPLAIN PLAN SET STATEMENT_ID = '" + statementId + "' FOR " + statementSql
            )) {
                applyExplainTimeout(explain, timeoutSecs);
                nullBindExplainParameters(explain, statementSql);
                explain.execute();
            }
            try (PreparedStatement read = connection.prepareStatement(
                "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', ?, 'TYPICAL +PREDICATE'))"
            )) {
                applyExplainTimeout(read, timeoutSecs);
                read.setString(1, statementId);
                try (ResultSet rows = read.executeQuery()) {
                    while (rows.next()) {
                        if (plan.length() > 0) plan.append('\n');
                        plan.append(rows.getString(1));
                    }
                }
            }
            return plan.toString();
        } finally {
            try (PreparedStatement cleanup = connection.prepareStatement(
                "DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = ?"
            )) {
                applyExplainTimeout(cleanup, timeoutSecs);
                cleanup.setString(1, statementId);
                cleanup.executeUpdate();
            } catch (SQLException ignored) {}
        }
    }

    /**
     * SQL passed to EXPLAIN PLAN may legitimately contain Oracle bind markers
     * (":1", ":name", or "?") that aren't meant to be executed with real
     * values — e.g. statements copied from V$SQL/AWR reports. A PreparedStatement
     * still requires every marker to be bound before execute(), or Oracle throws
     * "ORA-17041: Missing IN or OUT parameter". The plan doesn't depend on the
     * actual bind values, so null them all out.
     */
    private static void nullBindExplainParameters(PreparedStatement statement, String sql) throws SQLException {
        int parameterCount = -1;
        try {
            ParameterMetaData metadata = statement.getParameterMetaData();
            if (metadata != null) {
                parameterCount = metadata.getParameterCount();
            }
        } catch (SQLException ignored) {
        }
        if (parameterCount < 0) {
            parameterCount = oracleExplainBindMarkerCount(sql);
        }
        for (int index = 1; index <= parameterCount; index++) {
            statement.setNull(index, Types.VARCHAR);
        }
    }

    private static int oracleExplainBindMarkerCount(String sql) {
        int count = 0;
        for (int index = 0; index < sql.length(); index++) {
            char ch = sql.charAt(index);
            if (ch == '\'') {
                index = skipSingleQuotedSql(sql, index);
            } else if (ch == '"') {
                index = skipDoubleQuotedSql(sql, index);
            } else if (ch == 'q' || ch == 'Q') {
                int end = skipOracleAlternativeQuotedSql(sql, index);
                if (end != index) {
                    index = end;
                }
            } else if (ch == '-' && index + 1 < sql.length() && sql.charAt(index + 1) == '-') {
                index = skipLineCommentSql(sql, index);
            } else if (ch == '/' && index + 1 < sql.length() && sql.charAt(index + 1) == '*') {
                index = skipBlockCommentSql(sql, index);
            } else if (ch == '?') {
                count++;
            } else if (ch == ':') {
                int end = oracleBindMarkerEnd(sql, index);
                if (end > index) {
                    count++;
                    index = end - 1;
                }
            }
        }
        return count;
    }

    private static int oracleBindMarkerEnd(String sql, int index) {
        if (index + 1 >= sql.length() || (index > 0 && sql.charAt(index - 1) == ':')) {
            return index;
        }
        char next = sql.charAt(index + 1);
        int end = index + 2;
        if (next >= '0' && next <= '9') {
            while (end < sql.length() && sql.charAt(end) >= '0' && sql.charAt(end) <= '9') {
                end++;
            }
            return end;
        }
        if (!isOracleIdentifierStart(next)) {
            return index;
        }
        while (end < sql.length() && isOracleIdentifierPart(sql.charAt(end))) {
            end++;
        }
        return end;
    }

    private static boolean isOracleIdentifierStart(char ch) {
        return (ch >= 'a' && ch <= 'z')
            || (ch >= 'A' && ch <= 'Z')
            || ch == '_'
            || ch == '$'
            || ch == '#';
    }

    private static boolean isOracleIdentifierPart(char ch) {
        return isOracleIdentifierStart(ch) || (ch >= '0' && ch <= '9');
    }

    private static int skipSingleQuotedSql(String sql, int index) {
        for (int current = index + 1; current < sql.length(); current++) {
            if (sql.charAt(current) != '\'') {
                continue;
            }
            if (current + 1 < sql.length() && sql.charAt(current + 1) == '\'') {
                current++;
                continue;
            }
            return current;
        }
        return sql.length() - 1;
    }

    private static int skipDoubleQuotedSql(String sql, int index) {
        for (int current = index + 1; current < sql.length(); current++) {
            if (sql.charAt(current) != '"') {
                continue;
            }
            if (current + 1 < sql.length() && sql.charAt(current + 1) == '"') {
                current++;
                continue;
            }
            return current;
        }
        return sql.length() - 1;
    }

    private static int skipOracleAlternativeQuotedSql(String sql, int index) {
        if (index + 2 >= sql.length() || sql.charAt(index + 1) != '\'') {
            return index;
        }
        char open = sql.charAt(index + 2);
        char close = switch (open) {
            case '[' -> ']';
            case '{' -> '}';
            case '(' -> ')';
            case '<' -> '>';
            default -> open;
        };
        for (int current = index + 3; current + 1 < sql.length(); current++) {
            if (sql.charAt(current) == close && sql.charAt(current + 1) == '\'') {
                return current + 1;
            }
        }
        return sql.length() - 1;
    }

    private static int skipLineCommentSql(String sql, int index) {
        for (int current = index; current < sql.length(); current++) {
            char ch = sql.charAt(current);
            if (ch == '\n' || ch == '\r') {
                return current;
            }
        }
        return sql.length() - 1;
    }

    private static int skipBlockCommentSql(String sql, int index) {
        int end = sql.indexOf("*/", index + 2);
        return end < 0 ? sql.length() - 1 : end + 1;
    }

    private static void applyExplainTimeout(Statement statement, int timeoutSecs) throws SQLException {
        if (timeoutSecs >= 0) {
            try {
                statement.setQueryTimeout(timeoutSecs);
            } catch (SQLFeatureNotSupportedException | UnsupportedOperationException ignored) {}
        }
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
        JdbcDriverQuirks quirks = driverQuirks(connection);
        if (quirks.skipExecutionContext()) {
            return;
        }
        String catalog = emptyToNull(database);
        if (catalog != null) {
            try {
                conn.setCatalog(catalog);
            } catch (SQLFeatureNotSupportedException | AbstractMethodError | UnsupportedOperationException ignored) {
            }
            if (quirks.databaseClientInfoProperty() != null) {
                try {
                    conn.setClientInfo(quirks.databaseClientInfoProperty(), catalog);
                } catch (SQLClientInfoException | AbstractMethodError | UnsupportedOperationException ignored) {
                }
            }
            if (quirks.useCatalogFallbackSql()) {
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
            return HIVE_QUIRKS;
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
        JdbcDriverQuirks quirks = driverQuirks(connection);
        if (quirks.useOracleMetadata()) {
            return result;
        }
        DatabaseMetaData metadata = conn.getMetaData();
        SQLException catalogFailure = null;
        try (ResultSet rs = metadata.getCatalogs()) {
            while (rs.next()) {
                String name = rs.getString("TABLE_CAT");
                addDatabase(result, name);
            }
        } catch (AbstractMethodError | UnsupportedOperationException ignored) {
            // Hive/Inceptor often throw UnsupportedOperationException for optional metadata methods.
        } catch (SQLException e) {
            catalogFailure = e;
        }
        if (result.isEmpty() && quirks.useCatalogFallbackSql()) {
            addDatabasesFromShowDatabases(conn, result);
        }
        if (catalogFailure != null && result.isEmpty()) {
            // Only tolerate getCatalogs failures when the SHOW DATABASES fallback recovered them.
            throw catalogFailure;
        }
        if (result.isEmpty() && quirks.schemasAsDatabasesFallback()) {
            addSchemaDatabases(result, metadata);
        }
        addDatabase(result, optionalText(connection, "database"));
        try {
            addDatabase(result, conn.getCatalog());
        } catch (SQLFeatureNotSupportedException | AbstractMethodError | UnsupportedOperationException ignored) {
        }
        return result;
    }

    private static void addSchemaDatabases(ArrayNode result, DatabaseMetaData metadata) {
        try (ResultSet rs = metadata.getSchemas()) {
            while (rs.next()) {
                addDatabase(result, rs.getString("TABLE_SCHEM"));
            }
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
        }
    }

    private static void addDatabasesFromShowDatabases(Connection conn, ArrayNode result) {
        try (Statement statement = conn.createStatement()) {
            if (statement == null) {
                // Proxied or broken drivers may return null; let the schemas fallback take over.
                return;
            }
            try (ResultSet rs = statement.executeQuery("SHOW DATABASES")) {
                while (rs.next()) {
                    addDatabase(result, rs.getString(1));
                }
            }
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
        }
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

    private static JsonNode listTables(
        JsonNode connection,
        String database,
        String schema,
        String filter,
        int limit,
        int offset,
        List<String> objectTypes
    ) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        JdbcDriverQuirks quirks = driverQuirks(connection);
        if (quirks.useOracleMetadata()) {
            return filterMetadataNodes(
                (ArrayNode) oracleListTables(conn, oracleEffectiveSchema(conn, schema)),
                filter,
                limit,
                offset,
                objectTypes,
                "table_type",
                true
            );
        }
        if (usePrestoInformationSchemaTables(connection)) {
            return prestoListTables(conn, database, schema, filter, limit, offset, objectTypes);
        }
        if (isKingbaseUrl(optionalText(connection, "connection_string"))) {
            return filterMetadataNodes(
                (ArrayNode) kingbaseListTables(conn, schema, false),
                filter,
                limit,
                offset,
                objectTypes,
                "table_type",
                true
            );
        }
        DatabaseMetaData meta = conn.getMetaData();
        String[] types = constrainedJdbcTableTypes(jdbcTableTypes(meta), objectTypes);
        if (types.length == 0) {
            return result;
        }
        String catalog = metadataCatalog(database, quirks);
        String schemaPattern = resolveSchemaPattern(meta, database, schema, quirks);
        boolean catalogHadTables = appendTables(result, meta, catalog, schemaPattern, types, filter, limit, offset);
        if (!catalogHadTables && catalog != null) {
            appendTables(result, meta, null, schemaPattern, types, filter, limit, offset);
        }
        return result;
    }

    private static JsonNode listObjects(
        JsonNode connection,
        String database,
        String schema,
        String filter,
        int limit,
        int offset,
        List<String> objectTypes
    ) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return filterMetadataNodes(
                (ArrayNode) oracleListObjects(conn, oracleEffectiveSchema(conn, schema), schema),
                filter,
                limit,
                offset,
                objectTypes,
                "object_type",
                false
            );
        }
        if (usePrestoInformationSchemaTables(connection)) {
            return prestoListObjects(conn, database, schema, filter, limit, offset, objectTypes);
        }
        boolean kingbase = isKingbaseUrl(optionalText(connection, "connection_string"));
        if (kingbase) {
            result.addAll((ArrayNode) kingbaseListTables(conn, schema, true));
        }
        DatabaseMetaData meta = conn.getMetaData();
        JdbcDriverQuirks quirks = driverQuirks(connection);
        String catalog = metadataCatalog(database, quirks);
        String schemaPattern = resolveSchemaPattern(meta, database, schema, quirks);
        Set<String> allowedObjectTypes = normalizedObjectTypes(objectTypes);

        boolean loadedRoutinesFromSystemTables = false;
        if (isHive2RoutinesConnection(connection)) {
            loadedRoutinesFromSystemTables = appendInceptorRoutinesFromSystemTables(
                conn,
                database,
                schema,
                filter,
                result,
                objectTypes
            );
        }

        if (!kingbase) {
            String[] tableTypes = constrainedJdbcTableTypes(jdbcTableTypes(meta), objectTypes);
            if (tableTypes.length > 0) {
                appendTableObjects(result, meta, catalog, schemaPattern, schema, tableTypes);
                if (result.isEmpty() && catalog != null) {
                    appendTableObjects(result, meta, null, schemaPattern, schema, tableTypes);
                }
            }
        }

        if (!loadedRoutinesFromSystemTables && (allowedObjectTypes.isEmpty() || allowedObjectTypes.contains("PROCEDURE"))) {
            try (ResultSet rs = meta.getProcedures(catalog, schemaPattern, "%")) {
                while (rs != null && rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("PROCEDURE_NAME"));
                    item.put("object_type", "PROCEDURE");
                    putNullable(item, "schema", schema);
                    putNullable(item, "comment", rs.getString("REMARKS"));
                    result.add(item);
                }
            } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            }
        }

        Set<String> procedureNames = new HashSet<>();
        for (JsonNode node : result) {
            if ("PROCEDURE".equals(node.path("object_type").asText())) {
                procedureNames.add(node.path("name").asText());
            }
        }
        if (!loadedRoutinesFromSystemTables && (allowedObjectTypes.isEmpty() || allowedObjectTypes.contains("FUNCTION"))) {
            try (ResultSet rs = meta.getFunctions(catalog, schemaPattern, "%")) {
                while (rs != null && rs.next()) {
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
            } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            }
        }

        if ((allowedObjectTypes.isEmpty() || allowedObjectTypes.contains("EVENT")) && isMysqlFamilyConnection(connection)) {
            appendMysqlEvents(result, conn, database, schema);
        }

        return filterMetadataNodes(result, filter, limit, offset, objectTypes, "object_type", false);
    }

    private static boolean isHive2RoutinesConnection(JsonNode connection) {
        String url = optionalText(connection, "connection_string");
        if (url != null && urlMatchesPrefix(url, "jdbc:hive2:")) {
            return true;
        }
        String driverClass = optionalText(connection, "jdbc_driver_class");
        if (driverClass == null) {
            return false;
        }
        String normalized = driverClass.toLowerCase(Locale.ROOT);
        return normalized.contains("inceptor") || normalized.contains("transwarp") || normalized.contains("hive");
    }

    private static boolean appendInceptorRoutinesFromSystemTables(
        Connection conn,
        String database,
        String schema,
        String filter,
        ArrayNode result,
        List<String> objectTypes
    ) {
        Set<String> allowedTypes = normalizedObjectTypes(objectTypes);
        boolean wantAll = allowedTypes.isEmpty();
        boolean wantProcedures = wantAll || allowedTypes.contains("PROCEDURE");
        boolean wantFunctions = wantAll || allowedTypes.contains("FUNCTION");
        if (!wantProcedures && !wantFunctions) {
            return false;
        }

        String trimmedFilter = filter == null ? "" : filter.trim();
        String likePattern = trimmedFilter.isEmpty() ? "%" : "%" + trimmedFilter + "%";

        LinkedHashSet<String> candidates = new LinkedHashSet<>();
        String db = emptyToNull(database);
        if (db != null) {
            candidates.add(db);
        }
        String sc = emptyToNull(schema);
        if (sc != null) {
            candidates.add(sc);
        }
        if (candidates.isEmpty()) {
            return false;
        }

        int added = 0;
        try {
            for (String candidateDb : candidates) {
                if (wantProcedures) {
                    String sql =
                        "SELECT procedure_name FROM system.procedures_v " +
                            "WHERE lower(database_name) = lower(?) AND lower(procedure_name) LIKE lower(?) " +
                            "ORDER BY procedure_name";
                    try (PreparedStatement ps = conn.prepareStatement(sql)) {
                        ps.setString(1, candidateDb);
                        ps.setString(2, likePattern);
                        try (ResultSet rs = ps.executeQuery()) {
                            while (rs.next()) {
                                ObjectNode item = MAPPER.createObjectNode();
                                item.put("name", rs.getString(1));
                                item.put("object_type", "PROCEDURE");
                                putNullable(item, "schema", schema);
                                item.putNull("comment");
                                result.add(item);
                                added++;
                            }
                        }
                    }
                }

                if (wantFunctions) {
                    String sql =
                        "SELECT function_name FROM system.functions_v " +
                            "WHERE lower(database_name) = lower(?) AND lower(function_name) LIKE lower(?) " +
                            "ORDER BY function_name";
                    try (PreparedStatement ps = conn.prepareStatement(sql)) {
                        ps.setString(1, candidateDb);
                        ps.setString(2, likePattern);
                        try (ResultSet rs = ps.executeQuery()) {
                            while (rs.next()) {
                                ObjectNode item = MAPPER.createObjectNode();
                                item.put("name", rs.getString(1));
                                item.put("object_type", "FUNCTION");
                                putNullable(item, "schema", schema);
                                item.putNull("comment");
                                result.add(item);
                                added++;
                            }
                        }
                    }
                }

                if (added > 0) {
                    break;
                }
            }
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            return added > 0;
        }

        return added > 0;
    }

    private static String stripRoutineSignature(String name) {
        if (name == null) {
            return null;
        }
        String trimmed = name.trim();
        int paren = trimmed.indexOf('(');
        return paren > 0 ? trimmed.substring(0, paren).trim() : trimmed;
    }

    private static boolean isMysqlFamilyConnection(JsonNode connection) {
        String url = jdbcUrl(connection);
        return urlMatchesPrefix(url, "jdbc:mysql:") || urlMatchesPrefix(url, "jdbc:mariadb:") || urlMatchesPrefix(url, "jdbc:tidb:");
    }

    private static void appendMysqlEvents(ArrayNode result, Connection conn, String database, String schema) {
        String eventSchema = emptyToNull(schema) != null ? schema : database;
        if (eventSchema == null || eventSchema.isBlank()) return;
        String sql = "SELECT EVENT_NAME, EVENT_SCHEMA, EVENT_COMMENT, CREATED, LAST_ALTERED FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?";
        try (PreparedStatement statement = conn.prepareStatement(sql)) {
            statement.setString(1, eventSchema);
            try (ResultSet rs = statement.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("EVENT_NAME"));
                    item.put("object_type", "EVENT");
                    putNullable(item, "schema", rs.getString("EVENT_SCHEMA"));
                    putNullable(item, "comment", rs.getString("EVENT_COMMENT"));
                    putNullable(item, "created_at", rs.getString("CREATED"));
                    putNullable(item, "updated_at", rs.getString("LAST_ALTERED"));
                    result.add(item);
                }
            }
        } catch (SQLException ignored) {
            // Lack of EVENT privilege must not hide tables and routines.
        }
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

    private static JsonNode listIndexes(JsonNode connection, String database, String schema, String table)
        throws SQLException {
        Connection conn = openConnection(connection);
        JdbcDriverQuirks quirks = driverQuirks(connection);
        if (quirks.useOracleMetadata()) {
            String owner = oracleEffectiveSchema(conn, schema);
            String resolvedTable = oracleResolveTable(conn, owner, table);
            return oracleListIndexes(conn, owner, resolvedTable == null ? table : resolvedTable);
        }

        DatabaseMetaData meta = conn.getMetaData();
        String catalog = metadataCatalog(database, quirks);
        String schemaPattern = resolveSchemaPattern(meta, database, schema, quirks);
        Set<String> primaryIndexNames = new HashSet<>();
        Map<Integer, String> primaryColumnsBySequence = new TreeMap<>();
        try (ResultSet rs = meta.getPrimaryKeys(catalog, schemaPattern, table)) {
            while (rs != null && rs.next()) {
                String name = rs.getString("PK_NAME");
                if (name != null && !name.isBlank()) {
                    primaryIndexNames.add(name);
                }
                String column = rs.getString("COLUMN_NAME");
                if (column != null && !column.isBlank()) {
                    primaryColumnsBySequence.put((int) rs.getShort("KEY_SEQ"), column);
                }
            }
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
        }

        // Presto/Trino JDBC throws SQLFeatureNotSupportedException from getIndexInfo, and
        // drivers compiled before JDBC 4 surface unimplemented DatabaseMetaData methods as
        // AbstractMethodError. Both must degrade to an empty list, matching the metadata
        // error tolerance used by the other DatabaseMetaData readers in this plugin.
        LinkedHashMap<String, ObjectNode> indexes = new LinkedHashMap<>();
        try (ResultSet rs = meta.getIndexInfo(catalog, schemaPattern, table, false, false)) {
            appendJdbcIndexes(indexes, primaryIndexNames, rs);
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
        }
        if (indexes.isEmpty() && catalog != null) {
            try (ResultSet rs = meta.getIndexInfo(null, schemaPattern, table, false, false)) {
                appendJdbcIndexes(indexes, primaryIndexNames, rs);
            } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            }
        }
        markPrimaryIndexByColumns(indexes.values(), new ArrayList<>(primaryColumnsBySequence.values()));
        ArrayNode result = MAPPER.createArrayNode();
        indexes.values().forEach(result::add);
        return result;
    }

    private static void markPrimaryIndexByColumns(Iterable<ObjectNode> indexes, List<String> primaryColumns) {
        if (primaryColumns.isEmpty()) {
            return;
        }
        for (ObjectNode index : indexes) {
            if (index.path("is_primary").asBoolean()) {
                return;
            }
        }
        for (ObjectNode index : indexes) {
            JsonNode columns = index.path("columns");
            if (columns.size() != primaryColumns.size()) {
                continue;
            }
            boolean matches = true;
            for (int i = 0; i < primaryColumns.size(); i++) {
                if (!primaryColumns.get(i).equalsIgnoreCase(columns.path(i).asText())) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                index.put("is_primary", true);
                return;
            }
        }
    }

    private static void appendJdbcIndexes(
        Map<String, ObjectNode> indexes,
        Set<String> primaryIndexNames,
        ResultSet rs
    ) throws SQLException {
        while (rs != null && rs.next()) {
            String name = rs.getString("INDEX_NAME");
            String column = rs.getString("COLUMN_NAME");
            if (name == null || name.isBlank() || column == null || column.isBlank()) {
                continue;
            }
            ObjectNode item = indexes.get(name);
            if (item == null) {
                item = indexNode(
                    name,
                    !rs.getBoolean("NON_UNIQUE"),
                    primaryIndexNames.contains(name),
                    jdbcIndexType(rs.getShort("TYPE"))
                );
                indexes.put(name, item);
            }
            ((ArrayNode) item.path("columns")).add(column);
        }
    }

    private static String jdbcIndexType(short type) {
        return switch (type) {
            case DatabaseMetaData.tableIndexClustered -> "CLUSTERED";
            case DatabaseMetaData.tableIndexHashed -> "HASHED";
            case DatabaseMetaData.tableIndexOther -> "OTHER";
            default -> null;
        };
    }

    private static ObjectNode indexNode(String name, boolean unique, boolean primary, String indexType) {
        ObjectNode item = MAPPER.createObjectNode();
        item.put("name", name);
        item.set("columns", MAPPER.createArrayNode());
        item.put("is_unique", unique);
        item.put("is_primary", primary);
        item.putNull("filter");
        putNullable(item, "index_type", indexType);
        item.putNull("included_columns");
        item.putNull("comment");
        return item;
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
        JdbcMetadataIdentity identity = appendColumns(result, meta, catalog, schemaPattern, table);
        if (result.isEmpty() && catalog != null) {
            identity = appendColumns(result, meta, null, schemaPattern, table);
        }
        Set<String> primaryKeys = safePrimaryKeys(meta, identity.catalog(), identity.schema(), identity.table());
        markPrimaryKeyColumns(result, primaryKeys);
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

    private static boolean appendTables(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        String[] types,
        String filter,
        int limit,
        int offset
    ) throws SQLException {
        String normalizedFilter = filter == null ? "" : filter.trim().toLowerCase(Locale.ROOT);
        int skipped = 0;
        int max = limit <= 0 ? Integer.MAX_VALUE : limit;
        boolean found = false;
        try (ResultSet rs = meta.getTables(catalog, schema, "%", types)) {
            while (rs.next()) {
                found = true;
                String name = rs.getString("TABLE_NAME");
                if (!metadataNameMatches(name, normalizedFilter)) {
                    continue;
                }
                if (skipped++ < Math.max(0, offset)) {
                    continue;
                }
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", name);
                item.put("table_type", rs.getString("TABLE_TYPE"));
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
                if (result.size() >= max) {
                    break;
                }
            }
        }
        return found;
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

    private static String[] constrainedJdbcTableTypes(String[] tableTypes, List<String> objectTypes) {
        Set<String> allowed = normalizedObjectTypes(objectTypes);
        if (allowed.isEmpty()) {
            return tableTypes;
        }
        List<String> result = new ArrayList<>();
        for (String tableType : tableTypes) {
            if (allowed.contains(normalizeTableObjectType(tableType))) {
                result.add(tableType);
            }
        }
        return result.toArray(new String[0]);
    }

    private static ArrayNode filterMetadataNodes(
        ArrayNode source,
        String filter,
        int limit,
        int offset,
        List<String> objectTypes,
        String typeField,
        boolean defaultBlankTypeToTable
    ) {
        ArrayNode result = MAPPER.createArrayNode();
        Set<String> allowedTypes = normalizedObjectTypes(objectTypes);
        String normalizedFilter = filter == null ? "" : filter.trim().toLowerCase(Locale.ROOT);
        int start = Math.max(0, offset);
        int max = limit <= 0 ? Integer.MAX_VALUE : limit;
        int skipped = 0;
        for (JsonNode item : source) {
            if (!metadataNameMatches(item.path("name").asText(""), normalizedFilter)) {
                continue;
            }
            String type = item.path(typeField).asText("");
            String normalizedType = defaultBlankTypeToTable ? normalizeTableObjectType(type) : normalizeObjectType(type);
            if (!allowedTypes.isEmpty() && (normalizedType.isEmpty() || !allowedTypes.contains(normalizedType))) {
                continue;
            }
            if (skipped++ < start) {
                continue;
            }
            if (result.size() >= max) {
                break;
            }
            result.add(item);
        }
        return result;
    }

    private static boolean metadataNameMatches(String name, String filter) {
        if (filter == null || filter.isEmpty()) {
            return true;
        }
        String candidate = name == null ? "" : name.toLowerCase(Locale.ROOT);
        return candidate.contains(filter) || (filter.length() >= 2 && fuzzySubsequenceMatches(candidate, filter));
    }

    private static boolean fuzzySubsequenceMatches(String candidate, String expected) {
        int cursor = 0;
        for (int i = 0; i < expected.length(); i++) {
            cursor = candidate.indexOf(expected.charAt(i), cursor);
            if (cursor < 0) {
                return false;
            }
            cursor++;
        }
        return true;
    }

    private static Set<String> normalizedObjectTypes(List<String> objectTypes) {
        Set<String> result = new HashSet<>();
        if (objectTypes == null) {
            return result;
        }
        for (String objectType : objectTypes) {
            String normalized = normalizeObjectType(objectType);
            if (!normalized.isEmpty()) {
                result.add(normalized);
            }
        }
        return result;
    }

    private static String normalizeTableObjectType(String value) {
        String normalized = normalizeObjectType(value);
        return normalized.isEmpty() ? "TABLE" : normalized;
    }

    private static String normalizeObjectType(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        String upper = value.trim().toUpperCase(Locale.ROOT).replace(' ', '_');
        if (upper.contains("MATERIALIZED") && upper.contains("VIEW")) {
            return "MATERIALIZED_VIEW";
        }
        if ("BASE_TABLE".equals(upper) || upper.contains("TABLE")) {
            return "TABLE";
        }
        if (upper.contains("VIEW")) {
            return "VIEW";
        }
        return upper;
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

    private static JsonNode prestoListTables(
        Connection conn,
        String database,
        String schema,
        String filter,
        int limit,
        int offset,
        List<String> objectTypes
    ) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        int queryLimit = limit > 0 ? Math.max(1, limit + Math.max(0, offset)) : 0;
        try (PreparedStatement ps = conn.prepareStatement(prestoInformationSchemaTablesSql(database, filter, queryLimit))) {
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
        return filterMetadataNodes(result, filter, limit, offset, objectTypes, "table_type", true);
    }

    private static JsonNode prestoListObjects(
        Connection conn,
        String database,
        String schema,
        String filter,
        int limit,
        int offset,
        List<String> objectTypes
    ) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        int queryLimit = limit > 0 ? Math.max(1, limit + Math.max(0, offset)) : 0;
        try (PreparedStatement ps = conn.prepareStatement(prestoInformationSchemaTablesSql(database, filter, queryLimit))) {
            ps.setString(1, schema);
            if (emptyToNull(filter) != null) {
                ps.setString(2, escapeLikePattern(filter.toLowerCase(Locale.ROOT)) + "%");
            }
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
        return filterMetadataNodes(result, filter, limit, offset, objectTypes, "object_type", false);
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

    private static JsonNode kingbaseListTables(Connection conn, String schema, boolean objectNodes) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String effectiveSchema = kingbaseEffectiveSchema(conn, schema);
        KingbaseTableCatalogMode catalogMode = kingbaseTableCatalogMode(conn);
        String sql = switch (catalogMode) {
            case SYS_CATALOG -> kingbaseCastSafeTablesSql();
            case POSTGRES_CATALOG -> kingbasePostgresTablesSql();
            case INFORMATION_SCHEMA -> kingbaseCompatibilityTablesSql();
        };
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, effectiveSchema);
            if (catalogMode == KingbaseTableCatalogMode.SYS_CATALOG) {
                ps.setString(2, effectiveSchema);
                ps.setString(3, effectiveSchema);
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String tableName = rs.getString("table_name");
                    String tableType = normalizeInformationSchemaTableType(rs.getString("table_type"));
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", tableName);
                    if (objectNodes) {
                        item.put("object_type", tableType);
                        item.put("schema", effectiveSchema);
                    } else {
                        item.put("table_type", tableType);
                    }
                    putNullable(item, "comment", rs.getString("remarks"));
                    result.add(item);
                }
            }
        }
        return result;
    }

    private enum KingbaseTableCatalogMode {
        SYS_CATALOG,
        POSTGRES_CATALOG,
        INFORMATION_SCHEMA
    }

    private static KingbaseTableCatalogMode kingbaseTableCatalogMode(Connection conn) {
        if (!kingbaseCatalogExists(conn, "sys_catalog.sys_namespace")) {
            return kingbaseCatalogExists(conn, "pg_catalog.pg_namespace")
                ? KingbaseTableCatalogMode.POSTGRES_CATALOG
                : KingbaseTableCatalogMode.INFORMATION_SCHEMA;
        }
        return kingbaseMysqlCompatibilityMode(conn)
            ? KingbaseTableCatalogMode.INFORMATION_SCHEMA
            : KingbaseTableCatalogMode.SYS_CATALOG;
    }

    private static boolean kingbaseMysqlCompatibilityMode(Connection conn) {
        try (Statement statement = conn.createStatement();
             ResultSet rs = statement.executeQuery(
                 "SELECT setting FROM sys_catalog.sys_settings WHERE LOWER(name) = 'database_mode'"
             )) {
            if (rs.next()) {
                return "mysql".equalsIgnoreCase(rs.getString(1));
            }
        } catch (Exception ignored) {
            // Older Kingbase versions do not expose database_mode.
        }
        try (Statement statement = conn.createStatement();
             ResultSet rs = statement.executeQuery(
                 "SELECT 1 FROM sys_catalog.sys_settings WHERE LOWER(name) = 'sql_mode'"
             )) {
            return rs.next();
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean kingbaseCatalogExists(Connection conn, String catalog) {
        try (Statement statement = conn.createStatement();
             ResultSet ignored = statement.executeQuery("SELECT 1 FROM " + catalog + " WHERE 1 = 0")) {
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String kingbaseCompatibilityTablesSql() {
        return """
            SELECT CAST(table_name AS varchar(256)) AS table_name,
                CASE UPPER(CAST(table_type AS varchar(64)))
                    WHEN 'VIEW' THEN 'VIEW'
                    WHEN 'MATERIALIZED VIEW' THEN 'MATERIALIZED_VIEW'
                    ELSE 'TABLE'
                END AS table_type,
                NULL AS remarks
            FROM information_schema.tables
            WHERE CAST(table_schema AS varchar(256)) = ?
                AND UPPER(CAST(table_type AS varchar(64))) IN ('BASE TABLE', 'TABLE', 'VIEW', 'MATERIALIZED VIEW')
            ORDER BY CAST(table_name AS varchar(256))
            """;
    }

    private static String kingbasePostgresTablesSql() {
        return """
            SELECT CAST(c.relname AS varchar(256)) AS table_name,
                CASE c.relkind
                    WHEN 'v' THEN 'VIEW'
                    WHEN 'm' THEN 'MATERIALIZED_VIEW'
                    WHEN 'f' THEN 'FOREIGN TABLE'
                    ELSE 'TABLE'
                END AS table_type,
                CAST(obj_description(c.oid) AS varchar(4000)) AS remarks
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ?
                AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            ORDER BY c.relname
            """;
    }

    private static String kingbaseCastSafeTablesSql() {
        return """
            SELECT table_name, table_type, remarks
            FROM (
                SELECT CAST(c.relname AS varchar(256)) AS table_name,
                    'TABLE' AS table_type,
                    CAST(d.description AS varchar(4000)) AS remarks
                FROM sys_catalog.sys_class c
                JOIN sys_catalog.sys_namespace n
                    ON CAST(n.oid AS varchar(64)) = CAST(c.relnamespace AS varchar(64))
                LEFT JOIN sys_catalog.sys_description d
                    ON CAST(d.objoid AS varchar(64)) = CAST(c.oid AS varchar(64)) AND d.objsubid = 0
                WHERE CAST(n.nspname AS varchar(256)) = ?
                    AND (
                        EXISTS (
                            SELECT 1 FROM sys_catalog.sys_tables t
                            WHERE CAST(t.schemaname AS varchar(256)) = CAST(n.nspname AS varchar(256))
                                AND CAST(t.tablename AS varchar(256)) = CAST(c.relname AS varchar(256))
                        )
                        OR EXISTS (
                            SELECT 1 FROM sys_catalog.sys_foreign_table ft
                            WHERE CAST(ft.ftrelid AS varchar(64)) = CAST(c.oid AS varchar(64))
                        )
                    )
                UNION ALL
                SELECT CAST(v.viewname AS varchar(256)) AS table_name,
                    'VIEW' AS table_type,
                    CAST(d.description AS varchar(4000)) AS remarks
                FROM sys_catalog.sys_views v
                JOIN sys_catalog.sys_namespace n
                    ON CAST(n.nspname AS varchar(256)) = CAST(v.schemaname AS varchar(256))
                JOIN sys_catalog.sys_class c
                    ON CAST(c.relnamespace AS varchar(64)) = CAST(n.oid AS varchar(64))
                    AND CAST(c.relname AS varchar(256)) = CAST(v.viewname AS varchar(256))
                LEFT JOIN sys_catalog.sys_description d
                    ON CAST(d.objoid AS varchar(64)) = CAST(c.oid AS varchar(64)) AND d.objsubid = 0
                WHERE CAST(v.schemaname AS varchar(256)) = ?
                UNION ALL
                SELECT CAST(mv.matviewname AS varchar(256)) AS table_name,
                    'MATERIALIZED_VIEW' AS table_type,
                    CAST(d.description AS varchar(4000)) AS remarks
                FROM sys_catalog.sys_matviews mv
                JOIN sys_catalog.sys_namespace n
                    ON CAST(n.nspname AS varchar(256)) = CAST(mv.schemaname AS varchar(256))
                JOIN sys_catalog.sys_class c
                    ON CAST(c.relnamespace AS varchar(64)) = CAST(n.oid AS varchar(64))
                    AND CAST(c.relname AS varchar(256)) = CAST(mv.matviewname AS varchar(256))
                LEFT JOIN sys_catalog.sys_description d
                    ON CAST(d.objoid AS varchar(64)) = CAST(c.oid AS varchar(64)) AND d.objsubid = 0
                WHERE CAST(mv.schemaname AS varchar(256)) = ?
            ) metadata_tables
            ORDER BY table_name
            """;
    }

    private static String kingbaseEffectiveSchema(Connection conn, String schema) {
        String effectiveSchema = emptyToNull(schema);
        if (effectiveSchema != null) {
            return effectiveSchema;
        }
        try {
            effectiveSchema = emptyToNull(conn.getSchema());
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
        }
        return effectiveSchema == null ? "PUBLIC" : effectiveSchema;
    }

    private static JsonNode kingbaseGetColumns(Connection conn, String schema, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String effectiveSchema = kingbaseEffectiveSchema(conn, schema);
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

    private static JdbcMetadataIdentity appendColumns(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        String table
    ) throws SQLException {
        JdbcMetadataIdentity identity = new JdbcMetadataIdentity(catalog, schema, table);
        boolean identityResolved = false;
        try (ResultSet rs = meta.getColumns(catalog, schema, table, "%")) {
            while (rs.next()) {
                if (!identityResolved) {
                    identity = new JdbcMetadataIdentity(
                        metadataIdentityValue(rs, "TABLE_CAT", catalog, true),
                        metadataIdentityValue(rs, "TABLE_SCHEM", schema, true),
                        metadataIdentityValue(rs, "TABLE_NAME", table, false)
                    );
                    identityResolved = true;
                }
                String name = rs.getString("COLUMN_NAME");
                ObjectNode item = columnNode(result, name);
                item.put("data_type", rs.getString("TYPE_NAME"));
                item.put("is_nullable", columnIsNullable(rs));
                putNullablePreferValue(item, "column_default", rs.getString("COLUMN_DEF"));
                item.put("is_primary_key", false);
                item.putNull("extra");
                putNullablePreferValue(item, "comment", rs.getString("REMARKS"));
                putNullableInt(item, "numeric_precision", rs.getObject("COLUMN_SIZE"));
                putNullableInt(item, "numeric_scale", rs.getObject("DECIMAL_DIGITS"));
                putNullableInt(item, "character_maximum_length", rs.getObject("COLUMN_SIZE"));
            }
        }
        return identity;
    }

    private static String metadataIdentityValue(ResultSet rs, String field, String fallback, boolean nullIsMeaningful) {
        try {
            String value = rs.getString(field);
            if (value == null) {
                return nullIsMeaningful ? null : fallback;
            }
            return value.isBlank() ? fallback : value;
        } catch (SQLException ignored) {
            return fallback;
        }
    }

    private static void markPrimaryKeyColumns(ArrayNode columns, Set<String> primaryKeys) {
        Map<String, ObjectNode> exactMatches = new HashMap<>();
        Map<String, ObjectNode> caseInsensitiveMatches = new HashMap<>();
        for (JsonNode column : columns) {
            if (!(column instanceof ObjectNode objectNode)) {
                continue;
            }
            String columnName = objectNode.path("name").asText();
            exactMatches.put(columnName, objectNode);
            String normalizedName = columnName.toLowerCase(Locale.ROOT);
            if (caseInsensitiveMatches.containsKey(normalizedName)) {
                caseInsensitiveMatches.put(normalizedName, null);
            } else {
                caseInsensitiveMatches.put(normalizedName, objectNode);
            }
        }
        for (String primaryKey : primaryKeys) {
            if (primaryKey == null) {
                continue;
            }
            ObjectNode exactMatch = exactMatches.get(primaryKey);
            if (exactMatch != null) {
                exactMatch.put("is_primary_key", true);
                continue;
            }
            ObjectNode caseInsensitiveMatch = caseInsensitiveMatches.get(primaryKey.toLowerCase(Locale.ROOT));
            if (caseInsensitiveMatch != null) {
                caseInsensitiveMatch.put("is_primary_key", true);
            }
        }
    }

    private record JdbcMetadataIdentity(String catalog, String schema, String table) {}

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
            if (manualTransactionActive) {
                try {
                    sharedConnection.rollback();
                } catch (SQLException ignored) {
                }
            }
            try {
                sharedConnection.close();
            } catch (SQLException ignored) {
            }
            sharedConnection = null;
            sharedConnectionKey = "";
        }
        manualTransactionActive = false;
    }

    private static String driverKey(JsonNode connection) {
        return optionalText(connection, "jdbc_driver_class") + "|" + connection.path("jdbc_driver_paths").toString();
    }

    private static String connectionKey(JsonNode connection) {
        String connectionString = optionalText(connection, "connection_string");
        String jdbcxSecurityKey = isJdbcxUrl(connectionString)
            ? "|jdbcxHighPrivilegeExtensions=" + jdbcxHighPrivilegeExtensionsEnabled(connection)
            : "";
        return connectionString
            + "|" + optionalText(connection, "url_params")
            + "|" + optionalText(connection, "username")
            + "|" + optionalText(connection, "password")
            + "|" + connection.path("sysdba").asBoolean(false)
            + jdbcxSecurityKey;
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

    private record JdbcUrlCredentials(String url, String username, String password) {}

    static JdbcUrlCredentials extractJdbcUrlCredentials(String url) {
        if (url == null) {
            return new JdbcUrlCredentials(null, null, null);
        }
        int queryStart = url.indexOf('?');
        if (queryStart < 0) {
            return new JdbcUrlCredentials(url, null, null);
        }

        int fragmentStart = url.indexOf('#', queryStart + 1);
        String base = url.substring(0, queryStart);
        String query = fragmentStart < 0 ? url.substring(queryStart + 1) : url.substring(queryStart + 1, fragmentStart);
        String fragment = fragmentStart < 0 ? "" : url.substring(fragmentStart);

        String username = null;
        String password = null;
        boolean foundCredential = false;
        List<String> keptParams = new ArrayList<>();
        for (String part : splitJdbcUrlParams(query)) {
            String name = partName(part);
            String key = decodeQueryPart(name).trim().toLowerCase(Locale.ROOT);
            if ("user".equals(key)) {
                username = decodeQueryPart(partValue(part));
                foundCredential = true;
            } else if ("password".equals(key)) {
                password = decodeQueryPart(partValue(part));
                foundCredential = true;
            } else {
                keptParams.add(part);
            }
        }

        if (!foundCredential) {
            return new JdbcUrlCredentials(url, null, null);
        }
        String sanitizedQuery = joinJdbcUrlParams(keptParams);
        String sanitizedUrl = sanitizedQuery.isEmpty() ? base + fragment : base + "?" + sanitizedQuery + fragment;
        return new JdbcUrlCredentials(sanitizedUrl, username, password);
    }

    private static List<String> splitJdbcUrlParams(String query) {
        List<String> result = new ArrayList<>();
        int start = 0;
        for (int i = 0; i < query.length(); i++) {
            char ch = query.charAt(i);
            if (ch == '&') {
                result.add(query.substring(start, i));
                start = i + 1;
            }
        }
        result.add(query.substring(start));
        return result;
    }

    private static String joinJdbcUrlParams(List<String> params) {
        return params.stream().filter(param -> !param.isEmpty()).collect(Collectors.joining("&"));
    }

    private static String partName(String part) {
        int equals = part.indexOf('=');
        return equals < 0 ? part : part.substring(0, equals);
    }

    private static String partValue(String part) {
        int equals = part.indexOf('=');
        return equals < 0 ? "" : part.substring(equals + 1);
    }

    private static String decodeQueryPart(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException ignored) {
            return value;
        }
    }

    private static boolean isSqliteUrl(String url) {
        return url.regionMatches(true, 0, "jdbc:sqlite:", 0, 12);
    }

    private static boolean urlHasQueryParam(String url, String key) {
        return jdbcUrlHasParameter(url, key);
    }

    private static boolean jdbcUrlHasParameter(String url, String key) {
        if (url == null) {
            return false;
        }
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
        if (
            urlMatchesPrefix(base, "jdbc:sqlserver:") ||
            urlMatchesPrefix(base, "jdbc:dremio:") ||
            isPhoenixUrl(base)
        ) {
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
        } catch (SQLException ignored) {
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
        } catch (SQLException ignored) {
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
            return result;
        } catch (SQLException e) {
            try (ResultSet rs = conn.getMetaData().getSchemas()) {
                while (rs.next()) {
                    String schema = rs.getString("TABLE_SCHEM");
                    if (schema != null && !schema.isBlank()) {
                        result.add(schema);
                    }
                }
            }
            return result;
        }
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
        String sequenceSql = "SELECT sequence_name AS name FROM all_sequences WHERE sequence_owner = ? ORDER BY sequence_name";
        try (PreparedStatement ps = conn.prepareStatement(sequenceSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", "SEQUENCE");
                    putNullable(item, "schema", schemaLabel);
                    item.putNull("comment");
                    result.add(item);
                }
            }
        }
        String synonymSql = "SELECT synonym_name AS name FROM all_synonyms WHERE owner = ? ORDER BY synonym_name";
        try (PreparedStatement ps = conn.prepareStatement(synonymSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", "SYNONYM");
                    putNullable(item, "schema", schemaLabel);
                    item.putNull("comment");
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static JsonNode oracleListIndexes(Connection conn, String owner, String table) throws SQLException {
        String sql =
            "SELECT i.index_name, i.uniqueness, i.index_type, ic.column_name, " +
            "CASE WHEN pk.index_name IS NULL THEN 0 ELSE 1 END AS is_primary " +
            "FROM all_indexes i " +
            "JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name " +
            "AND ic.table_owner = i.table_owner AND ic.table_name = i.table_name " +
            "LEFT JOIN (SELECT owner, index_name, table_name FROM all_constraints WHERE constraint_type = 'P') pk " +
            "ON pk.owner = i.owner AND pk.index_name = i.index_name AND pk.table_name = i.table_name " +
            "WHERE i.table_owner = ? AND i.table_name = ? " +
            "ORDER BY i.index_name, ic.column_position";
        LinkedHashMap<String, ObjectNode> indexes = new LinkedHashMap<>();
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, table);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String name = rs.getString("index_name");
                    ObjectNode item = indexes.get(name);
                    if (item == null) {
                        item = indexNode(
                            name,
                            "UNIQUE".equalsIgnoreCase(rs.getString("uniqueness")),
                            rs.getInt("is_primary") != 0,
                            rs.getString("index_type")
                        );
                        indexes.put(name, item);
                    }
                    String column = rs.getString("column_name");
                    if (column != null && !column.isBlank()) {
                        ((ArrayNode) item.path("columns")).add(column);
                    }
                }
            }
        }
        ArrayNode result = MAPPER.createArrayNode();
        indexes.values().forEach(result::add);
        return result;
    }

    private static JsonNode getObjectSource(JsonNode connection, String database, String schema, String name, String objectType)
        throws SQLException {
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
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

        if (isHive2RoutinesConnection(connection)) {
            String routineName = stripRoutineSignature(name);
            String normalizedType = normalizeObjectType(objectType);

            LinkedHashSet<String> candidates = new LinkedHashSet<>();
            String db = emptyToNull(database);
            if (db != null) {
                candidates.add(db);
            }
            String sc = emptyToNull(schema);
            if (sc != null) {
                candidates.add(sc);
            }
            if (candidates.isEmpty()) {
                throw new SQLException("Object source requires database context for Hive/Inceptor routines");
            }

            for (String candidateDb : candidates) {
                String sql;
                if ("PROCEDURE".equals(normalizedType)) {
                    sql = "SELECT full_text FROM system.procedures_v " +
                        "WHERE lower(database_name) = lower(?) AND procedure_name = ?";
                } else if ("FUNCTION".equals(normalizedType)) {
                    sql = "SELECT full_text FROM system.functions_v " +
                        "WHERE lower(database_name) = lower(?) AND function_name = ?";
                } else {
                    throw new SQLException("Unsupported object_type for Hive/Inceptor routine source: " + objectType);
                }

                try (PreparedStatement ps = conn.prepareStatement(sql)) {
                    ps.setString(1, candidateDb);
                    ps.setString(2, routineName);
                    try (ResultSet rs = ps.executeQuery()) {
                        if (!rs.next()) {
                            continue;
                        }
                        ObjectNode item = MAPPER.createObjectNode();
                        item.put("name", name);
                        item.put("object_type", objectType);
                        putNullable(item, "schema", emptyToNull(schema) != null ? schema : candidateDb);
                        putNullable(item, "source", rs.getString(1));
                        return item;
                    }
                }
            }

            throw new SQLException("Object source not found");
        }

        throw new SQLException("Object source is not supported by this JDBC driver");
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

    private static Object readValue(
        ResultSet rs,
        ResultSetMetaData meta,
        int index,
        boolean preserveOracleDateTime
    ) throws SQLException {
        return readValue(rs, meta, index, preserveOracleDateTime, null);
    }

    private static Object readValue(
        ResultSet rs,
        ResultSetMetaData meta,
        int index,
        boolean preserveOracleDateTime,
        ZoneId timestampZone
    ) throws SQLException {
        int columnType = meta.getColumnType(index);

        if (columnType == Types.BOOLEAN) {
            boolean boolValue = rs.getBoolean(index);
            if (!rs.wasNull()) {
                return boolValue;
            }
            return null;
        }

        // Phoenix exposes VARBINARY_ENCODED as a private type id (9000). Read it through the
        // binary JDBC accessor before a generic getObject() path can ask the driver for an
        // unsupported Java representation.
        if (isPhoenixEncodedBinaryColumn(meta, index, columnType)) {
            byte[] bytes = rs.getBytes(index);
            return bytes == null ? null : binaryToHex(bytes);
        }

        Object value = rs.getObject(index);
        if (value == null) {
            return null;
        }
        if (value instanceof byte[] bytes) {
            if (columnType == Types.BIT && bytes.length == 1 && (bytes[0] == 't' || bytes[0] == 'f')) {
                return bytes[0] == 't';
            }
            return binaryToHex(bytes);
        }
        if (value instanceof Clob clob) {
            return clobToString(clob);
        }
        if (isBinaryColumn(meta, index)) {
            byte[] bytes = rs.getBytes(index);
            return bytes == null ? null : binaryToHex(bytes);
        }
        Object temporalValue = readTemporalValue(rs, meta, index, preserveOracleDateTime, timestampZone);
        if (temporalValue != null) {
            return temporalValue;
        }
        if (value instanceof Timestamp timestamp) {
            return formatTimestamp(timestamp, timestampZone);
        }
        if (value instanceof Date || value instanceof Time || value instanceof TemporalAccessor) {
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

    private static String clobToString(Clob clob) throws SQLException {
        try (Reader reader = clob.getCharacterStream()) {
            StringBuilder out = new StringBuilder();
            char[] buffer = new char[8192];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                out.append(buffer, 0, count);
            }
            return out.toString();
        } catch (IOException error) {
            throw new SQLException("Failed to read CLOB value", error);
        }
    }

    private static Object readTemporalValue(
        ResultSet rs,
        ResultSetMetaData meta,
        int index,
        boolean preserveOracleDateTime,
        ZoneId timestampZone
    ) throws SQLException {
        return switch (meta.getColumnType(index)) {
            case Types.DATE -> {
                if (preserveOracleDateTime) {
                    Timestamp timestamp = rs.getTimestamp(index);
                    yield timestamp == null ? null : timestamp.toString();
                }
                Date date = rs.getDate(index);
                yield date == null ? null : date.toString();
            }
            case Types.TIME -> {
                Time time = rs.getTime(index);
                yield time == null ? null : time.toString();
            }
            case Types.TIMESTAMP -> {
                Timestamp timestamp = rs.getTimestamp(index);
                yield timestamp == null ? null : formatTimestamp(timestamp, timestampZone);
            }
            default -> null;
        };
    }

    static String formatTimestamp(Timestamp timestamp, ZoneId timestampZone) {
        if (timestampZone == null) {
            return timestamp.toString();
        }
        LocalDateTime local = LocalDateTime.ofInstant(timestamp.toInstant(), timestampZone);
        return Timestamp.valueOf(local).toString();
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

    private static boolean isPhoenixEncodedBinaryColumn(
        ResultSetMetaData meta,
        int index,
        int columnType
    ) throws SQLException {
        return columnType == PHOENIX_VARBINARY_ENCODED_TYPE
            && PHOENIX_VARBINARY_ENCODED_TYPE_NAME.equalsIgnoreCase(meta.getColumnTypeName(index));
    }

    private static boolean isPhoenixEncodedBinaryType(int sqlType, String typeName) {
        return sqlType == PHOENIX_VARBINARY_ENCODED_TYPE
            || PHOENIX_VARBINARY_ENCODED_TYPE_NAME.equalsIgnoreCase(typeName);
    }

    static String rewritePhoenixSystemCatalogQuery(
        JsonNode connection,
        Connection jdbcConnection,
        String sql
    ) {
        String url = jdbcUrl(connection);
        String normalizedSql = stripLeadingSqlComments(trimStatementSql(sql));
        if (
            !isPhoenixConnection(connection, url)
                || !PHOENIX_SYSTEM_CATALOG_WILDCARD.matcher(normalizedSql).matches()
        ) {
            return sql;
        }

        List<String> projections = new ArrayList<>();
        boolean hasEncodedColumn = false;
        try (ResultSet columns = jdbcConnection.getMetaData().getColumns(null, "SYSTEM", "CATALOG", "%")) {
            while (columns.next()) {
                String columnName = columns.getString("COLUMN_NAME");
                if (columnName == null || columnName.isBlank()) {
                    continue;
                }
                int sqlType = columns.getInt("DATA_TYPE");
                String typeName = columns.getString("TYPE_NAME");
                String quotedColumn = quotePhoenixIdentifier(columnName);
                if (isPhoenixEncodedBinaryType(sqlType, typeName)) {
                    projections.add("CAST(" + quotedColumn + " AS VARBINARY) AS " + quotedColumn);
                    hasEncodedColumn = true;
                } else {
                    projections.add(quotedColumn);
                }
            }
        } catch (SQLException | RuntimeException ignored) {
            // Keep the original SQL when a driver cannot expose its column metadata. The
            // compatibility path must not turn an optional workaround into a new failure.
            return sql;
        }

        if (!hasEncodedColumn || projections.isEmpty()) {
            return sql;
        }
        return "SELECT " + String.join(", ", projections)
            + " FROM " + quotePhoenixIdentifier("SYSTEM") + "." + quotePhoenixIdentifier("CATALOG");
    }

    private static String quotePhoenixIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
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

    private static List<String> optionalStringList(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return null;
        }
        List<String> result = new ArrayList<>();
        if (value.isArray()) {
            for (JsonNode item : value) {
                String text = item.asText("").trim();
                if (!text.isEmpty()) {
                    result.add(text);
                }
            }
            return result;
        }
        String text = value.asText("").trim();
        if (text.isEmpty()) {
            return null;
        }
        for (String part : text.split(",")) {
            String item = part.trim();
            if (!item.isEmpty()) {
                result.add(item);
            }
        }
        return result;
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
