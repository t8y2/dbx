package com.dbx.agent;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;

final class JdbcConnectionPoolRegistry implements AutoCloseable {
    private static final int DEFAULT_MAXIMUM_POOL_SIZE = 8;
    private static final int DEFAULT_MINIMUM_IDLE = 0;
    private static final long DEFAULT_CONNECTION_TIMEOUT_MILLIS = 30_000L;
    private static final long DEFAULT_VALIDATION_TIMEOUT_MILLIS = 5_000L;
    private static final long DEFAULT_IDLE_TIMEOUT_MILLIS = 120_000L;
    private static final long DEFAULT_MAX_LIFETIME_MILLIS = 1_800_000L;
    private static final long DEFAULT_POOL_RETIRE_MILLIS = 300_000L;
    private final Map<String, PoolEntry> pools = new ConcurrentHashMap<>();
    private final PoolSettings settings;
    private final AtomicBoolean closed = new AtomicBoolean();

    JdbcConnectionPoolRegistry() {
        this(PoolSettings.fromEnvironment());
    }

    JdbcConnectionPoolRegistry(PoolSettings settings) {
        this.settings = Objects.requireNonNull(settings, "settings");
    }

    Lease borrow(String identity, ConnectionFactory connectionFactory) throws Exception {
        String key = digest(identity);
        while (true) {
            if (closed.get()) {
                throw new IllegalStateException("JDBC connection pool registry is closed");
            }
            PoolEntry entry;
            try {
                entry = pools.computeIfAbsent(key, ignored -> createPoolEntry(key, connectionFactory));
            } catch (PoolCreationException error) {
                throw error.unwrap();
            }
            try {
                return entry.borrow();
            } catch (PoolRetiredException ignored) {
                pools.remove(key, entry);
            }
        }
    }

    int poolCount() {
        return pools.size();
    }

    boolean isEnabled() {
        return settings.enabled;
    }

    private PoolEntry createPoolEntry(String key, ConnectionFactory connectionFactory) {
        ConnectionFactoryDataSource factoryDataSource = null;
        try {
            Connection initialConnection = Objects.requireNonNull(
                connectionFactory.open(),
                "JDBC connection factory returned null"
            );
            factoryDataSource = new ConnectionFactoryDataSource(connectionFactory, initialConnection);
            HikariConfig config = new HikariConfig();
            config.setPoolName("dbx-jdbc-" + key.substring(0, 12));
            config.setDataSource(factoryDataSource);
            config.setMaximumPoolSize(settings.maximumPoolSize);
            config.setMinimumIdle(settings.minimumIdle);
            config.setConnectionTimeout(settings.connectionTimeoutMillis);
            config.setValidationTimeout(settings.validationTimeoutMillis);
            config.setIdleTimeout(settings.idleTimeoutMillis);
            config.setMaxLifetime(settings.maxLifetimeMillis);
            config.setInitializationFailTimeout(-1L);
            config.setIsolateInternalQueries(true);
            config.setThreadFactory(daemonThreadFactory("dbx-jdbc-pool-" + key.substring(0, 8)));
            return new PoolEntry(new HikariDataSource(config), factoryDataSource, settings.poolRetireMillis);
        } catch (Exception error) {
            if (factoryDataSource != null) {
                factoryDataSource.closeUnusedInitialConnection();
            }
            throw new PoolCreationException(error);
        }
    }

    void retireUnusedPools() {
        if (closed.get()) {
            return;
        }
        long now = System.currentTimeMillis();
        List<PoolEntry> retired = new ArrayList<>();
        for (String key : pools.keySet()) {
            pools.computeIfPresent(key, (ignored, entry) -> {
                if (entry.tryRetire(now)) {
                    retired.add(entry);
                    return null;
                }
                return entry;
            });
        }
        for (PoolEntry entry : retired) {
            entry.closeRetired();
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        for (PoolEntry entry : pools.values()) {
            entry.close();
        }
        pools.clear();
    }

    private static String digest(String identity) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(hash.length * 2);
            for (byte value : hash) {
                result.append(Character.forDigit((value >>> 4) & 0x0f, 16));
                result.append(Character.forDigit(value & 0x0f, 16));
            }
            return result.toString();
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private static ThreadFactory daemonThreadFactory(String name) {
        return runnable -> {
            Thread thread = new Thread(runnable, name);
            thread.setDaemon(true);
            return thread;
        };
    }

    @FunctionalInterface
    interface ConnectionFactory {
        Connection open() throws Exception;
    }

    static final class Lease implements AutoCloseable {
        private final PoolEntry entry;
        private final Connection connection;
        private final AtomicBoolean closed = new AtomicBoolean();

        private Lease(PoolEntry entry, Connection connection) {
            this.entry = entry;
            this.connection = connection;
        }

        Connection connection() {
            return connection;
        }

        void evict() {
            if (closed.compareAndSet(false, true)) {
                entry.release(connection, true);
            }
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                entry.release(connection, false);
            }
        }
    }

    static final class PoolSettings {
        private final boolean enabled;
        private final int maximumPoolSize;
        private final int minimumIdle;
        private final long connectionTimeoutMillis;
        private final long validationTimeoutMillis;
        private final long idleTimeoutMillis;
        private final long maxLifetimeMillis;
        private final long poolRetireMillis;

        PoolSettings(
            int maximumPoolSize,
            int minimumIdle,
            long connectionTimeoutMillis,
            long validationTimeoutMillis,
            long idleTimeoutMillis,
            long maxLifetimeMillis,
            long poolRetireMillis
        ) {
            this(
                true,
                maximumPoolSize,
                minimumIdle,
                connectionTimeoutMillis,
                validationTimeoutMillis,
                idleTimeoutMillis,
                maxLifetimeMillis,
                poolRetireMillis
            );
        }

        PoolSettings(
            boolean enabled,
            int maximumPoolSize,
            int minimumIdle,
            long connectionTimeoutMillis,
            long validationTimeoutMillis,
            long idleTimeoutMillis,
            long maxLifetimeMillis,
            long poolRetireMillis
        ) {
            this.enabled = enabled;
            this.maximumPoolSize = maximumPoolSize;
            this.minimumIdle = minimumIdle;
            this.connectionTimeoutMillis = connectionTimeoutMillis;
            this.validationTimeoutMillis = validationTimeoutMillis;
            this.idleTimeoutMillis = idleTimeoutMillis;
            this.maxLifetimeMillis = maxLifetimeMillis;
            this.poolRetireMillis = poolRetireMillis;
        }

        static PoolSettings fromEnvironment() {
            int maximumPoolSize = intSetting(
                "dbx.agent.jdbc.pool.maximumPoolSize",
                "DBX_AGENT_JDBC_POOL_MAXIMUM_POOL_SIZE",
                DEFAULT_MAXIMUM_POOL_SIZE,
                1,
                32
            );
            int minimumIdle = intSetting(
                "dbx.agent.jdbc.pool.minimumIdle",
                "DBX_AGENT_JDBC_POOL_MINIMUM_IDLE",
                DEFAULT_MINIMUM_IDLE,
                0,
                maximumPoolSize
            );
            long connectionTimeoutMillis = longSetting(
                "dbx.agent.jdbc.pool.connectionTimeoutMillis",
                "DBX_AGENT_JDBC_POOL_CONNECTION_TIMEOUT_MILLIS",
                DEFAULT_CONNECTION_TIMEOUT_MILLIS,
                250L
            );
            long validationTimeoutMillis = Math.min(
                connectionTimeoutMillis,
                longSetting(
                    "dbx.agent.jdbc.pool.validationTimeoutMillis",
                    "DBX_AGENT_JDBC_POOL_VALIDATION_TIMEOUT_MILLIS",
                    DEFAULT_VALIDATION_TIMEOUT_MILLIS,
                    250L
                )
            );
            return new PoolSettings(
                booleanSetting(
                    "dbx.agent.jdbc.pool.enabled",
                    "DBX_AGENT_JDBC_POOL_ENABLED",
                    true
                ),
                maximumPoolSize,
                minimumIdle,
                connectionTimeoutMillis,
                validationTimeoutMillis,
                longSetting(
                    "dbx.agent.jdbc.pool.idleTimeoutMillis",
                    "DBX_AGENT_JDBC_POOL_IDLE_TIMEOUT_MILLIS",
                    DEFAULT_IDLE_TIMEOUT_MILLIS,
                    10_000L
                ),
                longSetting(
                    "dbx.agent.jdbc.pool.maxLifetimeMillis",
                    "DBX_AGENT_JDBC_POOL_MAX_LIFETIME_MILLIS",
                    DEFAULT_MAX_LIFETIME_MILLIS,
                    30_000L
                ),
                longSetting(
                    "dbx.agent.jdbc.pool.retireMillis",
                    "DBX_AGENT_JDBC_POOL_RETIRE_MILLIS",
                    DEFAULT_POOL_RETIRE_MILLIS,
                    60_000L
                )
            );
        }

        private static int intSetting(String property, String environment, int defaultValue, int minimum, int maximum) {
            String value = setting(property, environment);
            if (value == null) {
                return defaultValue;
            }
            try {
                return Math.max(minimum, Math.min(maximum, Integer.parseInt(value.trim())));
            } catch (NumberFormatException ignored) {
                return defaultValue;
            }
        }

        private static long longSetting(String property, String environment, long defaultValue, long minimum) {
            String value = setting(property, environment);
            if (value == null) {
                return defaultValue;
            }
            try {
                return Math.max(minimum, Long.parseLong(value.trim()));
            } catch (NumberFormatException ignored) {
                return defaultValue;
            }
        }

        private static boolean booleanSetting(String property, String environment, boolean defaultValue) {
            String value = setting(property, environment);
            if (value == null) {
                return defaultValue;
            }
            String normalized = value.trim();
            if ("true".equalsIgnoreCase(normalized) || "1".equals(normalized) || "yes".equalsIgnoreCase(normalized)) {
                return true;
            }
            if ("false".equalsIgnoreCase(normalized) || "0".equals(normalized) || "no".equalsIgnoreCase(normalized)) {
                return false;
            }
            return defaultValue;
        }

        private static String setting(String property, String environment) {
            String value = System.getProperty(property);
            return value == null || value.trim().isEmpty() ? System.getenv(environment) : value;
        }
    }

    private static final class PoolEntry implements AutoCloseable {
        private final HikariDataSource dataSource;
        private final ConnectionFactoryDataSource factoryDataSource;
        private final long retireMillis;
        private int activeLeases;
        private boolean retired;
        private boolean dataSourceClosed;
        private volatile long lastReleasedAtMillis = System.currentTimeMillis();

        private PoolEntry(
            HikariDataSource dataSource,
            ConnectionFactoryDataSource factoryDataSource,
            long retireMillis
        ) {
            this.dataSource = dataSource;
            this.factoryDataSource = factoryDataSource;
            this.retireMillis = retireMillis;
        }

        private Lease borrow() throws SQLException {
            synchronized (this) {
                if (retired) {
                    throw new PoolRetiredException();
                }
                activeLeases += 1;
            }
            try {
                return new Lease(this, dataSource.getConnection());
            } catch (SQLException | RuntimeException error) {
                synchronized (this) {
                    activeLeases -= 1;
                    lastReleasedAtMillis = System.currentTimeMillis();
                }
                throw error;
            }
        }

        private void release(Connection connection, boolean evict) {
            try {
                if (evict) {
                    dataSource.evictConnection(connection);
                }
                connection.close();
            } catch (Exception ignored) {
            } finally {
                synchronized (this) {
                    lastReleasedAtMillis = System.currentTimeMillis();
                    activeLeases -= 1;
                }
            }
        }

        private synchronized boolean tryRetire(long nowMillis) {
            if (retired || activeLeases != 0 || nowMillis - lastReleasedAtMillis < retireMillis) {
                return false;
            }
            retired = true;
            return true;
        }

        private void closeRetired() {
            synchronized (this) {
                if (dataSourceClosed) {
                    return;
                }
                dataSourceClosed = true;
            }
            factoryDataSource.closeUnusedInitialConnection();
            dataSource.close();
        }

        @Override
        public void close() {
            synchronized (this) {
                retired = true;
            }
            closeRetired();
        }
    }

    private static final class PoolRetiredException extends SQLException {
        private PoolRetiredException() {
            super("JDBC connection pool was retired");
        }
    }

    private static final class ConnectionFactoryDataSource implements DataSource {
        private final ConnectionFactory connectionFactory;
        private final AtomicReference<Connection> initialConnection;

        private ConnectionFactoryDataSource(ConnectionFactory connectionFactory, Connection initialConnection) {
            this.connectionFactory = connectionFactory;
            this.initialConnection = new AtomicReference<>(initialConnection);
        }

        @Override
        public Connection getConnection() throws SQLException {
            Connection opened = initialConnection.getAndSet(null);
            if (opened != null) {
                return opened;
            }
            try {
                return connectionFactory.open();
            } catch (SQLException error) {
                throw error;
            } catch (Exception error) {
                throw new SQLException("Failed to open JDBC connection", error);
            }
        }

        private void closeUnusedInitialConnection() {
            Connection opened = initialConnection.getAndSet(null);
            if (opened == null) {
                return;
            }
            try {
                opened.close();
            } catch (Exception ignored) {
            }
        }

        @Override
        public Connection getConnection(String username, String password) throws SQLException {
            return getConnection();
        }

        @Override
        public PrintWriter getLogWriter() {
            return null;
        }

        @Override
        public void setLogWriter(PrintWriter out) {
        }

        @Override
        public void setLoginTimeout(int seconds) {
        }

        @Override
        public int getLoginTimeout() {
            return 0;
        }

        @Override
        public Logger getParentLogger() throws SQLFeatureNotSupportedException {
            return Logger.getLogger("com.dbx.agent.jdbc.pool");
        }

        @Override
        public <T> T unwrap(Class<T> iface) throws SQLException {
            if (iface.isInstance(this)) {
                return iface.cast(this);
            }
            throw new SQLException("Not a wrapper for " + iface.getName());
        }

        @Override
        public boolean isWrapperFor(Class<?> iface) {
            return iface.isInstance(this);
        }
    }

    private static final class PoolCreationException extends RuntimeException {
        private PoolCreationException(Exception cause) {
            super(cause);
        }

        private Exception unwrap() {
            Throwable cause = getCause();
            return cause instanceof Exception ? (Exception) cause : this;
        }
    }
}
