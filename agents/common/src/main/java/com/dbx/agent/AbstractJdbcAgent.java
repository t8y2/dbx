package com.dbx.agent;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

public abstract class AbstractJdbcAgent extends BaseDatabaseAgent {
    private Connection connection;
    private String configuredDatabase = "";

    @Override
    public final Connection getConnection() {
        return connection;
    }

    @Override
    public String getIdentifierQuote() {
        try {
            String quote = requireConnected().getMetaData().getIdentifierQuoteString();
            return quote == null || quote.trim().isEmpty() ? "" : quote.trim();
        } catch (Exception ignored) {
            return "";
        }
    }

    @Override
    public final void connect(ConnectParams params) {
        uncheckedVoid(() -> {
            loadDriver(params);
            connection = openConnection(params);
            configuredDatabase = params.getDatabase();
            afterConnect(params, connection);
        });
    }

    @Override
    public final boolean testConnection(ConnectParams params) {
        return unchecked(() -> {
            loadDriver(params);
            try (Connection conn = openConnection(params)) {
                return conn.isValid(5);
            }
        });
    }

    private void loadDriver(ConnectParams params) throws Exception {
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
        return TransactionExecutor.executeUpdateStatements(requireConnected(), statements, schema, this::setSchemaSQL);
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

    protected abstract String driverClass();

    protected abstract String buildJdbcUrl(ConnectParams params);

    protected Connection openConnection(ConnectParams params) throws Exception {
        return DriverManager.getConnection(buildJdbcUrl(params), params.getUsername(), params.getPassword());
    }

    protected void afterConnect(ConnectParams params, Connection connection) throws Exception {
    }

    protected void beforeQueryExecution(Connection connection, int timeoutSecs) throws Exception {
    }

    protected String getConfiguredDatabase() {
        return configuredDatabase;
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
}
