package com.dbx.agent;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public abstract class AbstractJdbcAgent extends BaseDatabaseAgent {
    private static final String GAUSSDB_COMPATIBILITY_SQL =
        "SELECT datcompatibility FROM pg_catalog.pg_database WHERE datname = current_database()";

    private volatile Connection connection;
    private String configuredDatabase = "";
    private String identifierQuote = "";
    private JdbcConnectionPoolRegistry poolRegistry;
    private JdbcConnectionPoolRegistry.Lease pooledLease;
    private ConnectParams connectParams;
    private String poolIdentity;
    private boolean requestActive;
    private boolean leasePinnedAtRequestStart;
    private boolean sessionAffinity;

    @Override
    public final Connection getConnection() {
        return connection;
    }

    @Override
    public String getIdentifierQuote() {
        return identifierQuote;
    }

    @Override
    public final void connect(ConnectParams params) {
        uncheckedVoid(() -> {
            closeCurrentConnection();
            sessionAffinity = false;
            requestActive = false;
            leasePinnedAtRequestStart = false;
            loadDriver(params);
            configuredDatabase = params.getDatabase();
            connectParams = params;
            poolIdentity = buildPoolIdentity(params);
            if (poolRegistry == null) {
                connection = openInitializedConnection(params);
                afterConnect(params, connection);
                identifierQuote = resolveIdentifierQuote(params, connection);
                return;
            }

            JdbcConnectionPoolRegistry.Lease lease = borrowPooledConnection();
            connection = lease.connection();
            try {
                afterConnect(params, connection);
                identifierQuote = resolveIdentifierQuote(params, connection);
            } catch (Exception error) {
                lease.evict();
                throw error;
            } finally {
                if (!preparePooledConnectionForReturn()) {
                    lease.evict();
                } else {
                    lease.close();
                }
                connection = null;
            }
        });
    }

    @Override
    public final boolean testConnection(ConnectParams params) {
        return Boolean.TRUE.equals(testConnectionWithInfo(params).get("ok"));
    }

    @Override
    public final Map<String, Object> testConnectionWithInfo(ConnectParams params) {
        return unchecked(() -> {
            loadDriver(params);
            try (Connection conn = openTestConnection(params)) {
                boolean valid = conn != null && conn.isValid(5);
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("ok", valid);
                if (valid) {
                    Map<String, String> databaseInfo = JdbcDatabaseInfo.from(conn);
                    if (!databaseInfo.isEmpty()) {
                        result.put("databaseInfo", databaseInfo);
                    }
                }
                return result;
            }
        });
    }

    @Override
    public final Map<String, String> getDatabaseInfo() {
        return JdbcDatabaseInfo.from(getConnection());
    }

    protected void loadDriver(ConnectParams params) throws Exception {
        List<String> driverPaths = params.getJdbc_driver_paths();
        String driverClass = params.getJdbc_driver_class();
        if (driverClass == null || driverClass.isEmpty()) {
            driverClass = driverClass();
        }
        if (driverPaths != null && !driverPaths.isEmpty()) {
            List<URL> urls = new ArrayList<>();
            for (String path : driverPaths) {
                urls.add(Paths.get(path).toUri().toURL());
            }
            URLClassLoader loader = new URLClassLoader(urls.toArray(new URL[0]), getClass().getClassLoader());
            Driver driver = (Driver) Class.forName(driverClass, true, loader).getDeclaredConstructor().newInstance();
            DriverManager.registerDriver(new DriverShim(driver));
        } else {
            Class.forName(driverClass);
        }
    }

    private static final class DriverShim implements Driver {
        private final Driver driver;

        DriverShim(Driver driver) {
            this.driver = driver;
        }

        @Override
        public Connection connect(String url, java.util.Properties info) throws java.sql.SQLException {
            return driver.connect(url, info);
        }

        @Override
        public boolean acceptsURL(String url) throws java.sql.SQLException {
            return driver.acceptsURL(url);
        }

        @Override
        public java.sql.DriverPropertyInfo[] getPropertyInfo(String url, java.util.Properties info) throws java.sql.SQLException {
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
        public java.util.logging.Logger getParentLogger() throws java.sql.SQLFeatureNotSupportedException {
            return driver.getParentLogger();
        }
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        Connection conn = requireConnected();
        uncheckedVoid(() -> beforeQueryExecution(conn, options.getTimeoutSecs()));
        return JdbcExecutor.current().execute(
            conn,
            sql,
            schema,
            this::setSchemaSQL,
            this::resetSchemaSQL,
            options.getMaxRows(),
            options.getFetchSize(),
            options.getTimeoutSecs(),
            resultValueReader()
        );
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        Connection conn = requireConnected();
        uncheckedVoid(() -> beforeQueryExecution(conn, options.getTimeoutSecs()));
        return JdbcExecutor.current().executePage(
            conn,
            sql,
            schema,
            this::setSchemaSQL,
            this::resetSchemaSQL,
            options,
            resultValueReader()
        );
    }

    @Override
    public QueryPageResult fetchQueryPage(String sessionId, int pageSize) {
        return JdbcExecutor.current().fetchPage(sessionId, pageSize);
    }

    @Override
    public boolean closeQuerySession(String sessionId) {
        return JdbcExecutor.current().closeQuerySession(sessionId);
    }

    @Override
    public QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
        Connection conn = requireConnected();
        uncheckedVoid(() -> beforeQueryExecution(conn, options.getTimeoutSecs()));
        return JdbcExecutor.current().startTableRead(
            conn,
            sql,
            schema,
            this::setSchemaSQL,
            this::resetSchemaSQL,
            options,
            resultValueReader()
        );
    }

    @Override
    public QueryPageResult fetchTableReadPage(String sessionId, int pageSize) {
        return JdbcExecutor.current().fetchTableReadPage(sessionId, pageSize);
    }

    @Override
    public boolean closeTableReadSession(String sessionId) {
        return JdbcExecutor.current().closeTableReadSession(sessionId);
    }

    @Override
    public QueryResult executeTransaction(List<String> statements, String schema) {
        return TransactionExecutor.executeUpdateStatements(
            requireConnected(),
            statements,
            schema,
            this::setSchemaSQL,
            this::resetSchemaSQL
        );
    }

    @Override
    public synchronized void disconnect() {
        uncheckedVoid(() -> {
            closeCurrentConnection();
            afterDisconnect();
            connectParams = null;
            poolIdentity = null;
            sessionAffinity = false;
            requestActive = false;
            leasePinnedAtRequestStart = false;
            identifierQuote = "";
        });
    }

    final synchronized void attachConnectionPoolRegistry(JdbcConnectionPoolRegistry registry) {
        if (connectParams != null || connection != null || pooledLease != null) {
            throw new IllegalStateException("JDBC pool registry must be attached before connecting");
        }
        poolRegistry = registry;
    }

    final synchronized boolean usesConnectionPool() {
        return poolRegistry != null;
    }

    final synchronized void beginPooledRequest() throws Exception {
        if (poolRegistry == null) {
            return;
        }
        if (connectParams == null) {
            throw new IllegalStateException("Not connected");
        }
        requestActive = true;
        leasePinnedAtRequestStart = pooledLease != null;
        if (pooledLease == null) {
            try {
                pooledLease = borrowPooledConnection();
            } catch (Exception error) {
                requestActive = false;
                throw error;
            }
        }
        connection = pooledLease.connection();
    }

    final synchronized void finishPooledRequest(
        JdbcExecutor executor,
        boolean succeeded,
        boolean requiresSessionAffinity,
        boolean evictAfterRequest
    ) {
        if (poolRegistry == null) {
            return;
        }
        requestActive = false;
        if (succeeded && requiresSessionAffinity) {
            sessionAffinity = true;
            JdbcSchemaSwitcher.forget(connection);
        }
        if (pooledLease == null) {
            connection = null;
            return;
        }
        if (evictAfterRequest && leasePinnedAtRequestStart) {
            sessionAffinity = true;
        } else if (evictAfterRequest || (!succeeded && !leasePinnedAtRequestStart)) {
            releasePooledConnection(true);
            return;
        }
        if (sessionAffinity || executor.hasOpenSessions() || executor.hasActiveStatements()) {
            return;
        }
        releasePooledConnection(!preparePooledConnectionForReturn());
    }

    final synchronized void releaseIdlePooledConnection(JdbcExecutor executor) {
        if (poolRegistry == null || requestActive || sessionAffinity || pooledLease == null) {
            return;
        }
        if (executor.hasOpenSessions() || executor.hasActiveStatements()) {
            return;
        }
        releasePooledConnection(!preparePooledConnectionForReturn());
    }

    private static String resolveIdentifierQuote(ConnectParams params, Connection connection) {
        if (isPostgresCompatibleJdbc(params)) {
            try (Statement statement = connection.createStatement()) {
                statement.setQueryTimeout(5);
                try (ResultSet result = statement.executeQuery(GAUSSDB_COMPATIBILITY_SQL)) {
                    if (result.next()) {
                        String quote = gaussdbIdentifierQuote(result.getString(1));
                        if (quote != null) {
                            return quote;
                        }
                    }
                }
            } catch (Exception ignored) {
            }
        }
        try {
            String quote = connection.getMetaData().getIdentifierQuoteString();
            return quote == null || quote.trim().isEmpty() ? "" : quote.trim();
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String gaussdbIdentifierQuote(String compatibilityMode) {
        if (compatibilityMode == null) {
            return null;
        }
        String normalized = compatibilityMode.trim().toUpperCase(Locale.ROOT);
        if ("M".equals(normalized) || "B".equals(normalized) || "MYSQL".equals(normalized)) {
            return "`";
        }
        if ("A".equals(normalized) || "PG".equals(normalized) || "ORA".equals(normalized) || "POSTGRESQL".equals(normalized)) {
            return "\"";
        }
        return null;
    }

    private static boolean isPostgresCompatibleJdbc(ConnectParams params) {
        StringBuilder identity = new StringBuilder();
        appendJdbcIdentity(identity, params.getConnection_string());
        appendJdbcIdentity(identity, params.getJdbc_driver_class());
        List<String> driverPaths = params.getJdbc_driver_paths();
        if (driverPaths != null) {
            for (String path : driverPaths) {
                appendJdbcIdentity(identity, path);
            }
        }
        String normalized = identity.toString().toLowerCase(Locale.ROOT);
        return normalized.contains("jdbc:postgresql:")
            || normalized.contains("jdbc:opengauss:")
            || normalized.contains("jdbc:gaussdb:")
            || normalized.contains("org.postgresql")
            || normalized.contains("org.opengauss")
            || normalized.contains("com.huawei.gaussdb")
            || normalized.contains("postgresql")
            || normalized.contains("opengauss")
            || normalized.contains("gaussdb");
    }

    private static void appendJdbcIdentity(StringBuilder identity, String value) {
        if (value == null || value.isEmpty()) {
            return;
        }
        if (identity.length() > 0) {
            identity.append('\n');
        }
        identity.append(value);
    }

    protected abstract String driverClass();

    protected abstract String buildJdbcUrl(ConnectParams params);

    protected Connection openConnection(ConnectParams params) throws Exception {
        return DriverManager.getConnection(buildJdbcUrl(params), params.getUsername(), params.getPassword());
    }

    protected Connection openTestConnection(ConnectParams params) throws Exception {
        return openConnection(params);
    }

    protected void afterPhysicalConnect(ConnectParams params, Connection connection) throws Exception {
    }

    protected void afterConnect(ConnectParams params, Connection connection) throws Exception {
    }

    protected void afterDisconnect() throws Exception {
    }

    protected void beforeQueryExecution(Connection connection, int timeoutSecs) throws Exception {
    }

    protected void beforePooledConnectionReturn(Connection connection) throws Exception {
    }

    protected final void applySchemaContext(Connection connection, String schema) throws Exception {
        JdbcSchemaSwitcher.apply(connection, schema, this::setSchemaSQL, this::resetSchemaSQL);
    }

    protected String getConfiguredDatabase() {
        return configuredDatabase;
    }

    protected static <T> T unwrapConnection(Connection connection, Class<T> connectionType) {
        if (connectionType.isInstance(connection)) {
            return connectionType.cast(connection);
        }
        try {
            if (connection.isWrapperFor(connectionType)) {
                return connection.unwrap(connectionType);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
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
                default:
                    value = rs.getString(index);
                    break;
            }
            return rs.wasNull() ? null : value;
        });
    }

    protected JdbcExecutor.ResultValueReader resultValueReader() {
        return this::resultValue;
    }

    private Connection openInitializedConnection(ConnectParams params) throws Exception {
        Connection opened = openConnection(params);
        boolean initialized = false;
        try {
            afterPhysicalConnect(params, opened);
            initialized = true;
            return opened;
        } finally {
            if (!initialized) {
                try {
                    opened.close();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private JdbcConnectionPoolRegistry.Lease borrowPooledConnection() throws Exception {
        ConnectParams params = connectParams;
        if (params == null || poolIdentity == null || poolRegistry == null) {
            throw new IllegalStateException("Not connected");
        }
        return poolRegistry.borrow(poolIdentity, () -> openInitializedConnection(params));
    }

    private void closeCurrentConnection() throws Exception {
        if (pooledLease != null) {
            boolean evict = sessionAffinity || !preparePooledConnectionForReturn();
            releasePooledConnection(evict);
        } else if (connection != null) {
            connection.close();
            connection = null;
        }
    }

    private boolean preparePooledConnectionForReturn() {
        try {
            beforePooledConnectionReturn(connection);
        } catch (Exception ignored) {
            return false;
        }
        return JdbcSchemaSwitcher.resetBeforeReturn(connection);
    }

    private void releasePooledConnection(boolean evict) {
        JdbcConnectionPoolRegistry.Lease lease = pooledLease;
        pooledLease = null;
        connection = null;
        leasePinnedAtRequestStart = false;
        if (lease == null) {
            return;
        }
        if (evict) {
            lease.evict();
        } else {
            lease.close();
        }
    }

    private String buildPoolIdentity(ConnectParams params) {
        StringBuilder identity = new StringBuilder();
        appendPoolIdentity(identity, "agentClass", getClass().getName());
        appendPoolIdentity(identity, "driverClass", effectiveDriverClass(params));
        appendPoolIdentity(identity, "jdbcUrl", buildJdbcUrl(params));
        appendPoolIdentity(identity, "host", params.getHost());
        appendPoolIdentity(identity, "port", Integer.toString(params.getPort()));
        appendPoolIdentity(identity, "database", params.getDatabase());
        appendPoolIdentity(identity, "username", params.getUsername());
        appendPoolIdentity(identity, "password", params.getPassword());
        appendPoolIdentity(identity, "urlParams", params.getUrl_params());
        appendPoolIdentity(identity, "connectionString", params.getConnection_string());
        appendPoolIdentity(identity, "portExplicit", Boolean.toString(params.isPort_explicit()));
        appendPoolIdentity(identity, "mysqlCompatMode", Boolean.toString(params.isMysql_compat_mode()));
        appendPoolIdentity(identity, "ssl", Boolean.toString(params.isSsl()));
        appendPoolIdentity(identity, "caCertPath", params.getCa_cert_path());
        appendPoolIdentity(identity, "clientCertPath", params.getClient_cert_path());
        appendPoolIdentity(identity, "clientKeyPath", params.getClient_key_path());
        appendPoolIdentity(identity, "gbaseServer", params.getGbase_server());
        appendPoolIdentity(identity, "informixServer", params.getInformix_server());
        List<String> driverPaths = params.getJdbc_driver_paths();
        if (driverPaths != null) {
            for (int index = 0; index < driverPaths.size(); index++) {
                appendPoolIdentity(identity, "driverPath" + index, driverPaths.get(index));
            }
        }
        return identity.toString();
    }

    private String effectiveDriverClass(ConnectParams params) {
        String configured = params.getJdbc_driver_class();
        return configured == null || configured.isEmpty() ? driverClass() : configured;
    }

    private static void appendPoolIdentity(StringBuilder identity, String key, String value) {
        String normalized = value == null ? "" : value;
        identity.append(key.length()).append(':').append(key)
            .append('=').append(normalized.length()).append(':').append(normalized).append(';');
    }
}
