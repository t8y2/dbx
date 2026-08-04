package com.dbx.agent;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.SQLTransientConnectionException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
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
    private static final long CHECKOUT_WATCHDOG_GRACE_MILLIS = 50L;
    private static final int DEFAULT_METADATA_RESERVE = 2;
    private static final int DEFAULT_GLOBAL_MAXIMUM_PHYSICAL_CONNECTIONS = 32;
    private static final int DEFAULT_MAX_QUARANTINED_OPERATIONS = 2;
    private final Map<String, PoolEntry> pools = new ConcurrentHashMap<>();
    private final PoolSettings settings;
    private final PhysicalConnectionBudget physicalConnectionBudget;
    private final PhysicalConnectionOpener physicalConnectionOpener;
    private final PhysicalConnectionCloser physicalConnectionCloser;
    private final ConnectionReleaseExecutor connectionReleaseExecutor;
    private final PoolCloseExecutor poolCloseExecutor;
    private final JdbcCheckoutExecutor checkoutExecutor;
    private final AtomicReference<SQLException> runtimeFailure = new AtomicReference<>();
    private final AtomicBoolean closed = new AtomicBoolean();

    JdbcConnectionPoolRegistry() {
        this(PoolSettings.fromEnvironment());
    }

    JdbcConnectionPoolRegistry(PoolSettings settings) {
        this.settings = Objects.requireNonNull(settings, "settings");
        this.physicalConnectionBudget = new PhysicalConnectionBudget(settings.globalMaximumPhysicalConnections);
        this.physicalConnectionOpener = new PhysicalConnectionOpener(settings.globalMaximumPhysicalConnections);
        this.physicalConnectionCloser = new PhysicalConnectionCloser(settings.globalMaximumPhysicalConnections);
        this.connectionReleaseExecutor = new ConnectionReleaseExecutor(settings.globalMaximumPhysicalConnections);
        this.poolCloseExecutor = new PoolCloseExecutor(
            settings.globalMaximumPhysicalConnections,
            runtimeFailure
        );
        this.checkoutExecutor = new JdbcCheckoutExecutor(
            settings.globalMaximumPhysicalConnections,
            connectionReleaseExecutor
        );
    }

    Lease borrow(String identity, ConnectionFactory connectionFactory) throws Exception {
        return borrow(identity, JdbcSessionRole.WORKLOAD, connectionFactory);
    }

    Lease borrow(String identity, JdbcSessionRole role, ConnectionFactory connectionFactory) throws Exception {
        String key = digest(identity);
        while (true) {
            if (closed.get()) {
                throw new IllegalStateException("JDBC connection pool registry is closed");
            }
            SQLException failure = runtimeFailure.get();
            if (failure != null) {
                throw AgentRpcError.resource("close", failure);
            }
            PoolEntry entry;
            try {
                entry = pools.computeIfAbsent(key, ignored -> createPoolEntry(key, connectionFactory));
            } catch (PoolCreationException error) {
                throw error.unwrap();
            }
            try {
                return entry.borrow(role);
            } catch (PoolRetiredException ignored) {
                pools.remove(key, entry);
            } catch (AgentRpcError error) {
                if (entry.isRetired()) {
                    pools.remove(key, entry);
                }
                throw error;
            }
        }
    }

    int poolCount() {
        return pools.size();
    }

    boolean isEnabled() {
        return settings.enabled;
    }

    int activePhysicalConnectionCount() {
        return physicalConnectionBudget.activeCount();
    }

    private PoolEntry createPoolEntry(String key, ConnectionFactory connectionFactory) {
        try {
            ConnectionFactoryDataSource factoryDataSource = new ConnectionFactoryDataSource(
                connectionFactory,
                physicalConnectionBudget,
                physicalConnectionOpener,
                physicalConnectionCloser,
                settings.connectionTimeoutMillis
            );
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
            return new PoolEntry(
                new HikariDataSource(config),
                settings.poolRetireMillis,
                settings.connectionTimeoutMillis,
                settings.maximumPoolSize,
                settings.metadataReserve,
                settings.maxQuarantinedOperations,
                factoryDataSource,
                checkoutExecutor,
                connectionReleaseExecutor,
                poolCloseExecutor
            );
        } catch (Exception error) {
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
        checkoutExecutor.close();
        connectionReleaseExecutor.close();
        poolCloseExecutor.close();
        physicalConnectionOpener.close();
        physicalConnectionCloser.close();
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

    private static ExecutorService boundedExecutor(int maximumThreads, String name) {
        int threads = Math.max(1, maximumThreads);
        return new ThreadPoolExecutor(
            threads,
            threads,
            0L,
            TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(threads),
            daemonThreadFactory(name),
            new ThreadPoolExecutor.AbortPolicy()
        );
    }

    private static long hikariCheckoutTimeoutMillis(long physicalOperationTimeoutMillis) {
        return addTimeoutMargin(physicalOperationTimeoutMillis, CHECKOUT_WATCHDOG_GRACE_MILLIS);
    }

    private static long addTimeoutMargin(long timeoutMillis, long marginMillis) {
        return timeoutMillis > Long.MAX_VALUE - marginMillis ? Long.MAX_VALUE : timeoutMillis + marginMillis;
    }

    @FunctionalInterface
    interface ConnectionFactory {
        Connection open() throws Exception;
    }

    private static final class OperationDeadline {
        private final long deadlineNanos;

        private OperationDeadline(long timeoutMillis) {
            long timeoutNanos = TimeUnit.MILLISECONDS.toNanos(Math.max(1L, timeoutMillis));
            long now = System.nanoTime();
            this.deadlineNanos = now > Long.MAX_VALUE - timeoutNanos ? Long.MAX_VALUE : now + timeoutNanos;
        }

        private long remainingNanos() {
            return Math.max(0L, deadlineNanos - System.nanoTime());
        }
    }

    static final class Lease implements AutoCloseable {
        private final PoolEntry entry;
        private final Connection connection;
        private final boolean workloadPermit;
        private final AtomicBoolean closed = new AtomicBoolean();
        private final AtomicBoolean quarantined = new AtomicBoolean();

        private Lease(PoolEntry entry, Connection connection, boolean workloadPermit) {
            this.entry = entry;
            this.connection = connection;
            this.workloadPermit = workloadPermit;
        }

        Connection connection() {
            return connection;
        }

        synchronized boolean quarantine() {
            return !closed.get() && quarantined.compareAndSet(false, true) && entry.markQuarantined();
        }

        synchronized void evict() {
            if (closed.compareAndSet(false, true)) {
                entry.release(connection, true, workloadPermit, quarantined.get());
            }
        }

        @Override
        public synchronized void close() {
            if (closed.compareAndSet(false, true)) {
                boolean poisoned = quarantined.get();
                entry.release(connection, poisoned, workloadPermit, poisoned);
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
        private final int metadataReserve;
        private final int globalMaximumPhysicalConnections;
        private final int maxQuarantinedOperations;

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
                poolRetireMillis,
                DEFAULT_METADATA_RESERVE,
                DEFAULT_GLOBAL_MAXIMUM_PHYSICAL_CONNECTIONS,
                DEFAULT_MAX_QUARANTINED_OPERATIONS
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
            this(
                enabled,
                maximumPoolSize,
                minimumIdle,
                connectionTimeoutMillis,
                validationTimeoutMillis,
                idleTimeoutMillis,
                maxLifetimeMillis,
                poolRetireMillis,
                DEFAULT_METADATA_RESERVE,
                DEFAULT_GLOBAL_MAXIMUM_PHYSICAL_CONNECTIONS,
                DEFAULT_MAX_QUARANTINED_OPERATIONS
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
            long poolRetireMillis,
            int metadataReserve,
            int globalMaximumPhysicalConnections,
            int maxQuarantinedOperations
        ) {
            this.enabled = enabled;
            this.maximumPoolSize = maximumPoolSize;
            this.minimumIdle = minimumIdle;
            this.connectionTimeoutMillis = connectionTimeoutMillis;
            this.validationTimeoutMillis = validationTimeoutMillis;
            this.idleTimeoutMillis = idleTimeoutMillis;
            this.maxLifetimeMillis = maxLifetimeMillis;
            this.poolRetireMillis = poolRetireMillis;
            this.metadataReserve = Math.max(0, Math.min(metadataReserve, maximumPoolSize - 1));
            this.globalMaximumPhysicalConnections = Math.max(1, globalMaximumPhysicalConnections);
            this.maxQuarantinedOperations = maximumPoolSize == 1
                ? 1
                : Math.max(1, maxQuarantinedOperations);
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
                ),
                intSetting(
                    "dbx.agent.jdbc.pool.metadataReserve",
                    "DBX_AGENT_JDBC_POOL_METADATA_RESERVE",
                    DEFAULT_METADATA_RESERVE,
                    0,
                    Math.max(0, maximumPoolSize - 1)
                ),
                intSetting(
                    "dbx.agent.jdbc.pool.globalMaximumPhysicalConnections",
                    "DBX_AGENT_JDBC_POOL_GLOBAL_MAXIMUM_PHYSICAL_CONNECTIONS",
                    DEFAULT_GLOBAL_MAXIMUM_PHYSICAL_CONNECTIONS,
                    1,
                    256
                ),
                intSetting(
                    "dbx.agent.jdbc.pool.maxQuarantinedOperations",
                    "DBX_AGENT_JDBC_POOL_MAX_QUARANTINED_OPERATIONS",
                    DEFAULT_MAX_QUARANTINED_OPERATIONS,
                    1,
                    64
                )
            );
        }

        int effectiveMetadataReserve() {
            return metadataReserve;
        }

        int effectiveMaxQuarantinedOperations() {
            return maxQuarantinedOperations;
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
        private final long retireMillis;
        private final long connectionTimeoutMillis;
        private final Semaphore workloadPermits;
        private final Semaphore leasePermits;
        private final int maxQuarantinedOperations;
        private final ConnectionFactoryDataSource factoryDataSource;
        private final JdbcCheckoutExecutor checkoutExecutor;
        private final ConnectionReleaseExecutor connectionReleaseExecutor;
        private final PoolCloseExecutor poolCloseExecutor;
        private int activeLeases;
        private int quarantinedLeases;
        private boolean retired;
        private boolean dataSourceClosed;
        private volatile long lastReleasedAtMillis = System.currentTimeMillis();

        private PoolEntry(
            HikariDataSource dataSource,
            long retireMillis,
            long connectionTimeoutMillis,
            int maximumPoolSize,
            int metadataReserve,
            int maxQuarantinedOperations,
            ConnectionFactoryDataSource factoryDataSource,
            JdbcCheckoutExecutor checkoutExecutor,
            ConnectionReleaseExecutor connectionReleaseExecutor,
            PoolCloseExecutor poolCloseExecutor
        ) {
            this.dataSource = dataSource;
            this.retireMillis = retireMillis;
            this.connectionTimeoutMillis = connectionTimeoutMillis;
            this.workloadPermits = new Semaphore(maximumPoolSize - metadataReserve, true);
            this.leasePermits = new Semaphore(maximumPoolSize, true);
            this.maxQuarantinedOperations = maxQuarantinedOperations;
            this.factoryDataSource = factoryDataSource;
            this.checkoutExecutor = checkoutExecutor;
            this.connectionReleaseExecutor = connectionReleaseExecutor;
            this.poolCloseExecutor = poolCloseExecutor;
        }

        private Lease borrow(JdbcSessionRole role) throws SQLException {
            OperationDeadline deadline = new OperationDeadline(hikariCheckoutTimeoutMillis(connectionTimeoutMillis));
            SQLException causalFailure = factoryDataSource.causalFailure();
            if (causalFailure != null) {
                if (requiresRuntimeReplacement(causalFailure)) {
                    retireAfterCheckoutFailure(deadline);
                }
                throw AgentRpcError.resource("connect", causalFailure);
            }
            boolean workloadPermit = false;
            boolean leasePermit = false;
            if (role == JdbcSessionRole.WORKLOAD) {
                workloadPermit = acquirePermit(
                    workloadPermits,
                    deadline,
                    "JDBC workload lease capacity is exhausted"
                );
            }
            try {
                leasePermit = acquirePermit(
                    leasePermits,
                    deadline,
                    "JDBC connection pool lease capacity is exhausted"
                );
            } catch (SQLException | RuntimeException error) {
                if (leasePermit) {
                    leasePermits.release();
                }
                if (workloadPermit) {
                    workloadPermits.release();
                }
                throw error;
            }
            synchronized (this) {
                if (retired) {
                    leasePermits.release();
                    if (workloadPermit) {
                        workloadPermits.release();
                    }
                    throw new PoolRetiredException();
                }
                activeLeases += 1;
            }
            try {
                Lease lease = new Lease(
                    this,
                    checkoutExecutor.checkout(dataSource, factoryDataSource, deadline),
                    workloadPermit
                );
                return lease;
            } catch (SQLException | RuntimeException error) {
                synchronized (this) {
                    activeLeases -= 1;
                    lastReleasedAtMillis = System.currentTimeMillis();
                }
                leasePermits.release();
                if (workloadPermit) {
                    workloadPermits.release();
                }
                causalFailure = factoryDataSource.causalFailure();
                if (contains(error, PhysicalConnectionLimitException.class)
                    || contains(causalFailure, PhysicalConnectionLimitException.class)) {
                    throw AgentRpcError.backpressure("connect", causalFailure == null ? error : causalFailure);
                }
                if (causalFailure != null || contains(error, PhysicalConnectionStateUnknownException.class)) {
                    retireAfterCheckoutFailure(deadline);
                    throw AgentRpcError.resource("connect", causalFailure == null ? error : causalFailure);
                }
                throw error;
            }
        }

        private boolean acquirePermit(
            Semaphore permits,
            OperationDeadline deadline,
            String exhaustedMessage
        ) throws SQLException {
            try {
                if (permits.tryAcquire(deadline.remainingNanos(), TimeUnit.NANOSECONDS)) {
                    return true;
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new SQLException("Interrupted while waiting for a JDBC workload lease", error);
            }
            throw AgentRpcError.backpressure(
                "checkout",
                new SQLTransientConnectionException(exhaustedMessage)
            );
        }

        private synchronized boolean markQuarantined() {
            quarantinedLeases += 1;
            return quarantinedLeases >= maxQuarantinedOperations;
        }

        private void release(Connection connection, boolean evict, boolean workloadPermit, boolean quarantined) {
            try {
                connectionReleaseExecutor.release(
                    dataSource,
                    connection,
                    evict,
                    factoryDataSource,
                    connectionTimeoutMillis
                );
            } finally {
                synchronized (this) {
                    lastReleasedAtMillis = System.currentTimeMillis();
                    activeLeases -= 1;
                    if (quarantined) {
                        quarantinedLeases -= 1;
                    }
                }
                if (workloadPermit) {
                    workloadPermits.release();
                }
                leasePermits.release();
            }
        }

        private synchronized boolean tryRetire(long nowMillis) {
            if (retired || activeLeases != 0 || nowMillis - lastReleasedAtMillis < retireMillis) {
                return false;
            }
            retired = true;
            return true;
        }

        private synchronized boolean isRetired() {
            return retired;
        }

        private void retireAfterCheckoutFailure(OperationDeadline deadline) {
            synchronized (this) {
                retired = true;
            }
            closeRetired(deadline);
        }

        private void closeRetired() {
            closeRetired(new OperationDeadline(hikariCheckoutTimeoutMillis(connectionTimeoutMillis)));
        }

        private void closeRetired(OperationDeadline deadline) {
            synchronized (this) {
                if (dataSourceClosed) {
                    return;
                }
                dataSourceClosed = true;
            }
            factoryDataSource.retire();
            poolCloseExecutor.close(dataSource, factoryDataSource, deadline);
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

    private static final class PhysicalConnectionAttemptCanceledException extends SQLTransientConnectionException {
        private PhysicalConnectionAttemptCanceledException() {
            super("JDBC physical connection attempt was canceled");
        }
    }

    private static final class ConnectionFactoryDataSource implements DataSource {
        private final ConnectionFactory connectionFactory;
        private final PhysicalConnectionBudget physicalConnectionBudget;
        private final PhysicalConnectionOpener physicalConnectionOpener;
        private final PhysicalConnectionCloser physicalConnectionCloser;
        private final long connectionTimeoutMillis;
        private final AtomicReference<SQLException> causalFailure = new AtomicReference<>();
        private final Set<OperationDeadline> checkoutDeadlines = ConcurrentHashMap.newKeySet();
        private final AtomicBoolean retired = new AtomicBoolean();
        private final AtomicInteger physicalCapacityWaiters = new AtomicInteger();
        private final Object attemptMonitor = new Object();
        private long latestStartedAttempt;
        private long latestCompletedAttempt;
        private AttemptDisposition latestAttemptDisposition;
        private SQLException latestAttemptFailure;

        private ConnectionFactoryDataSource(
            ConnectionFactory connectionFactory,
            PhysicalConnectionBudget physicalConnectionBudget,
            PhysicalConnectionOpener physicalConnectionOpener,
            PhysicalConnectionCloser physicalConnectionCloser,
            long connectionTimeoutMillis
        ) {
            this.connectionFactory = connectionFactory;
            this.physicalConnectionBudget = physicalConnectionBudget;
            this.physicalConnectionOpener = physicalConnectionOpener;
            this.physicalConnectionCloser = physicalConnectionCloser;
            this.connectionTimeoutMillis = connectionTimeoutMillis;
        }

        @Override
        public Connection getConnection() throws SQLException {
            SQLException existingFailure = causalFailure.get();
            if (existingFailure != null) {
                throw existingFailure;
            }
            OperationDeadline deadline = currentCheckoutDeadline();
            if (retired.get()) {
                throw new PoolRetiredException();
            }
            AttemptRegistration attempt = beginAttempt();
            physicalCapacityWaiters.incrementAndGet();
            try {
                try {
                    physicalConnectionBudget.acquire(deadline);
                } catch (PhysicalConnectionLimitException error) {
                    attempt.complete(AttemptDisposition.CAPACITY, error);
                    throw error;
                } catch (SQLException error) {
                    attempt.complete(AttemptDisposition.CAPACITY, error);
                    throw error;
                }
            } finally {
                physicalCapacityWaiters.decrementAndGet();
            }
            if (retired.get()) {
                physicalConnectionBudget.release();
                attempt.complete(AttemptDisposition.CANCELED, null);
                throw new PhysicalConnectionAttemptCanceledException();
            }
            boolean opened = false;
            boolean releaseBudget = true;
            Connection connection = null;
            try {
                connection = Objects.requireNonNull(
                    physicalConnectionOpener.open(
                        connectionFactory,
                        physicalConnectionBudget,
                        physicalConnectionCloser,
                        this,
                        deadline,
                        connectionTimeoutMillis
                    ),
                    "JDBC connection factory returned null"
                );
                HikariSetupAttempt setupAttempt = new HikariSetupAttempt(attempt);
                Connection wrapped = physicalConnectionBudget.wrap(
                    connection,
                    physicalConnectionCloser,
                    this,
                    connectionTimeoutMillis,
                    setupAttempt
                );
                opened = true;
                return wrapped;
            } catch (SQLException error) {
                releaseBudget = !contains(error, PhysicalConnectionStateUnknownException.class);
                if (!releaseBudget) {
                    causalFailure.compareAndSet(null, find(error, PhysicalConnectionStateUnknownException.class));
                    attempt.complete(AttemptDisposition.UNKNOWN, error);
                } else if (contains(error, JdbcOperationCapacityException.class)) {
                    causalFailure.compareAndSet(null, find(error, JdbcOperationCapacityException.class));
                    attempt.complete(AttemptDisposition.UNKNOWN, error);
                } else if (contains(error, PhysicalConnectionLimitException.class)) {
                    attempt.complete(AttemptDisposition.CAPACITY, error);
                } else {
                    attempt.complete(AttemptDisposition.KNOWN_FAILURE, error);
                }
                throw error;
            } catch (Exception error) {
                SQLException failure = new SQLException("Failed to open JDBC connection", error);
                releaseBudget = !contains(error, PhysicalConnectionStateUnknownException.class);
                if (!releaseBudget) {
                    causalFailure.compareAndSet(null, find(error, PhysicalConnectionStateUnknownException.class));
                    attempt.complete(AttemptDisposition.UNKNOWN, failure);
                } else {
                    attempt.complete(AttemptDisposition.KNOWN_FAILURE, failure);
                }
                throw failure;
            } finally {
                if (!opened) {
                    if (connection != null) {
                        boolean connectionClosed = physicalConnectionCloser.close(
                            connection,
                            this,
                            connectionTimeoutMillis
                        );
                        releaseBudget = releaseBudget && connectionClosed;
                    }
                    if (releaseBudget) {
                        physicalConnectionBudget.release();
                    }
                }
            }
        }

        private SQLException causalFailure() {
            return causalFailure.get();
        }

        private void completeHikariCheckout(Connection connection) throws SQLException {
            if (connection.isWrapperFor(HikariSetupTrackedConnection.class)) {
                connection.unwrap(HikariSetupTrackedConnection.class).completeHikariSetup();
            }
        }

        private void retire() {
            retired.set(true);
            signalAttemptStateChanged();
        }

        private long latestCompletedAttemptGeneration() {
            synchronized (attemptMonitor) {
                return latestCompletedAttempt;
            }
        }

        private AttemptRegistration beginAttempt() {
            synchronized (attemptMonitor) {
                latestStartedAttempt += 1L;
                return new AttemptRegistration(latestStartedAttempt);
            }
        }

        private AttemptSnapshot awaitAttemptAfter(long baseline, OperationDeadline deadline) {
            synchronized (attemptMonitor) {
                long targetGeneration = latestStartedAttempt;
                if (targetGeneration <= baseline) {
                    return null;
                }
                while (latestCompletedAttempt < targetGeneration
                    && causalFailure.get() == null
                    && !retired.get()) {
                    long remainingNanos = deadline.remainingNanos();
                    if (remainingNanos == 0L) {
                        break;
                    }
                    try {
                        TimeUnit.NANOSECONDS.timedWait(attemptMonitor, remainingNanos);
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                if (latestCompletedAttempt < targetGeneration) {
                    return null;
                }
                return new AttemptSnapshot(latestAttemptDisposition, latestAttemptFailure);
            }
        }

        private void signalAttemptStateChanged() {
            synchronized (attemptMonitor) {
                attemptMonitor.notifyAll();
            }
        }

        private Throwable classifyCheckoutFailure(
            SQLException error,
            long attemptBaseline,
            OperationDeadline deadline
        ) {
            SQLException failure = causalFailure.get();
            if (failure != null) {
                return AgentRpcError.resource("checkout", failure);
            }
            if (retired.get()) {
                return new PoolRetiredException();
            }
            if (contains(error, PhysicalConnectionLimitException.class)) {
                return AgentRpcError.backpressure("checkout", error);
            }
            if (contains(error, PhysicalConnectionStateUnknownException.class)
                || contains(error, JdbcOperationCapacityException.class)) {
                poison(error);
                return AgentRpcError.resource("checkout", error);
            }
            if (physicalCapacityWaiters.get() > 0) {
                return AgentRpcError.backpressure("checkout", error);
            }
            AttemptSnapshot attempt = awaitAttemptAfter(attemptBaseline, deadline);
            failure = causalFailure.get();
            if (failure != null) {
                return AgentRpcError.resource("checkout", failure);
            }
            if (retired.get()) {
                return new PoolRetiredException();
            }
            if (attempt != null) {
                if (attempt.disposition == AttemptDisposition.KNOWN_FAILURE) {
                    return attempt.failure == null ? error : attempt.failure;
                }
                if (attempt.disposition == AttemptDisposition.CAPACITY
                    || attempt.disposition == AttemptDisposition.SUCCESS) {
                    return AgentRpcError.backpressure("checkout", attempt.failure == null ? error : attempt.failure);
                }
            }
            SQLException unknown = new PhysicalConnectionStateUnknownException(error);
            poison(unknown);
            return AgentRpcError.resource("checkout", unknown);
        }

        private final class HikariSetupAttempt {
            private final AtomicBoolean completed = new AtomicBoolean();
            private final AtomicReference<SQLException> failure = new AtomicReference<>();
            private final AttemptRegistration attempt;

            private HikariSetupAttempt(AttemptRegistration attempt) {
                this.attempt = attempt;
            }

            private void recordFailure(SQLException error) {
                failure.compareAndSet(null, error);
            }

            private void completeSuccessfully() {
                if (completed.compareAndSet(false, true)) {
                    attempt.complete(AttemptDisposition.SUCCESS, null);
                }
            }

            private void completeAfterPhysicalClose() {
                if (completed.compareAndSet(false, true)) {
                    SQLException error = failure.get();
                    attempt.complete(
                        AttemptDisposition.KNOWN_FAILURE,
                        error == null
                            ? new SQLException("Hikari rejected a physical connection during setup")
                            : error
                    );
                }
            }
        }

        private final class AttemptRegistration {
            private final long generation;
            private final AtomicBoolean completed = new AtomicBoolean();

            private AttemptRegistration(long generation) {
                this.generation = generation;
            }

            private void complete(AttemptDisposition disposition, SQLException failure) {
                if (!completed.compareAndSet(false, true)) {
                    return;
                }
                synchronized (attemptMonitor) {
                    if (generation >= latestCompletedAttempt) {
                        latestCompletedAttempt = generation;
                        latestAttemptDisposition = disposition;
                        latestAttemptFailure = failure;
                    }
                    attemptMonitor.notifyAll();
                }
            }
        }

        private enum AttemptDisposition {
            SUCCESS,
            KNOWN_FAILURE,
            CAPACITY,
            CANCELED,
            UNKNOWN
        }

        private static final class AttemptSnapshot {
            private final AttemptDisposition disposition;
            private final SQLException failure;

            private AttemptSnapshot(AttemptDisposition disposition, SQLException failure) {
                this.disposition = disposition;
                this.failure = failure;
            }
        }

        private void poison(SQLException failure) {
            causalFailure.compareAndSet(null, failure);
            signalAttemptStateChanged();
        }

        private DeadlineRegistration registerCheckout(OperationDeadline deadline) {
            checkoutDeadlines.add(deadline);
            return new DeadlineRegistration(deadline);
        }

        private OperationDeadline currentCheckoutDeadline() throws SQLException {
            OperationDeadline earliest = null;
            for (OperationDeadline deadline : checkoutDeadlines) {
                if (earliest == null || deadline.deadlineNanos < earliest.deadlineNanos) {
                    earliest = deadline;
                }
            }
            if (earliest == null) {
                throw new SQLTransientConnectionException("No active JDBC checkout owns physical connection creation");
            }
            return earliest;
        }

        private final class DeadlineRegistration implements AutoCloseable {
            private final OperationDeadline deadline;

            private DeadlineRegistration(OperationDeadline deadline) {
                this.deadline = deadline;
            }

            @Override
            public void close() {
                checkoutDeadlines.remove(deadline);
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
            // Hikari waits this long for in-flight add tasks before closing its connection bag.
            long timeoutSeconds = (connectionTimeoutMillis + 999L) / 1_000L;
            return (int) Math.min(Integer.MAX_VALUE, Math.max(1L, timeoutSeconds));
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

    private static final class JdbcCheckoutExecutor implements AutoCloseable {
        private final ExecutorService executor;
        private final ConnectionReleaseExecutor releaseExecutor;

        private JdbcCheckoutExecutor(int maximumConcurrentCheckouts, ConnectionReleaseExecutor releaseExecutor) {
            this.executor = boundedExecutor(maximumConcurrentCheckouts, "dbx-jdbc-checkout");
            this.releaseExecutor = releaseExecutor;
        }

        private Connection checkout(
            HikariDataSource dataSource,
            ConnectionFactoryDataSource factoryDataSource,
            OperationDeadline deadline
        ) throws SQLException {
            CompletableFuture<Connection> outcome = new CompletableFuture<>();
            long attemptBaseline = factoryDataSource.latestCompletedAttemptGeneration();
            try (ConnectionFactoryDataSource.DeadlineRegistration ignored = factoryDataSource.registerCheckout(deadline)) {
                try {
                    executor.execute(() -> completeCheckout(
                        dataSource,
                        factoryDataSource,
                        attemptBaseline,
                        deadline,
                        outcome
                    ));
                } catch (RejectedExecutionException error) {
                    JdbcOperationCapacityException failure = new JdbcOperationCapacityException("checkout", error);
                    factoryDataSource.poison(failure);
                    throw AgentRpcError.resource("checkout", failure);
                }
                try {
                    return outcome.get(deadline.remainingNanos(), TimeUnit.NANOSECONDS);
                } catch (TimeoutException error) {
                    return abandonCheckout(outcome, factoryDataSource, error);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    return abandonCheckout(outcome, factoryDataSource, error);
                } catch (ExecutionException error) {
                    throwCheckoutFailure(error.getCause());
                    throw new IllegalStateException("unreachable");
                }
            }
        }

        private void completeCheckout(
            HikariDataSource dataSource,
            ConnectionFactoryDataSource factoryDataSource,
            long attemptBaseline,
            OperationDeadline deadline,
            CompletableFuture<Connection> outcome
        ) {
            try {
                Connection connection = dataSource.getConnection();
                factoryDataSource.completeHikariCheckout(connection);
                if (!outcome.complete(connection)) {
                    releaseExecutor.releaseLate(
                        dataSource,
                        connection,
                        factoryDataSource,
                        factoryDataSource.connectionTimeoutMillis
                    );
                }
            } catch (SQLException error) {
                outcome.completeExceptionally(
                    factoryDataSource.classifyCheckoutFailure(error, attemptBaseline, deadline)
                );
            } catch (Throwable error) {
                outcome.completeExceptionally(error);
            }
        }

        private static Connection abandonCheckout(
            CompletableFuture<Connection> outcome,
            ConnectionFactoryDataSource factoryDataSource,
            Exception cause
        ) throws SQLException {
            SQLException causalFailure = factoryDataSource.causalFailure();
            Throwable failure;
            if (causalFailure == null) {
                SQLException abandonedFailure = new PhysicalConnectionStateUnknownException(cause);
                factoryDataSource.poison(abandonedFailure);
                failure = AgentRpcError.resource("checkout", abandonedFailure);
            } else {
                failure = AgentRpcError.resource("checkout", causalFailure);
            }
            if (outcome.completeExceptionally(failure)) {
                throwCheckoutFailure(failure);
                throw new IllegalStateException("unreachable");
            }
            try {
                return outcome.get();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throwCheckoutFailure(failure);
                throw new IllegalStateException("unreachable");
            } catch (ExecutionException error) {
                throwCheckoutFailure(error.getCause());
                throw new IllegalStateException("unreachable");
            }
        }

        private static void throwCheckoutFailure(Throwable error) throws SQLException {
            if (error instanceof AgentRpcError rpcError) {
                throw rpcError;
            }
            if (error instanceof SQLException sqlError) {
                throw sqlError;
            }
            if (error instanceof RuntimeException runtimeError) {
                throw runtimeError;
            }
            if (error instanceof Error fatal) {
                throw fatal;
            }
            throw new SQLException("Failed to checkout JDBC connection", error);
        }

        @Override
        public void close() {
            executor.shutdownNow();
        }
    }

    private static final class ConnectionReleaseExecutor implements AutoCloseable {
        private final ExecutorService executor;

        private ConnectionReleaseExecutor(int maximumConcurrentReleases) {
            executor = boundedExecutor(maximumConcurrentReleases, "dbx-jdbc-release");
        }

        private void release(
            HikariDataSource dataSource,
            Connection connection,
            boolean evict,
            ConnectionFactoryDataSource factoryDataSource,
            long timeoutMillis
        ) {
            release(dataSource, connection, evict, factoryDataSource, timeoutMillis, false);
        }

        private void release(
            HikariDataSource dataSource,
            Connection connection,
            boolean evict,
            ConnectionFactoryDataSource factoryDataSource,
            long timeoutMillis,
            boolean attemptInlineWhenRejected
        ) {
            CompletableFuture<Void> outcome = submit(
                dataSource,
                connection,
                evict,
                factoryDataSource,
                attemptInlineWhenRejected
            );
            if (outcome == null) {
                return;
            }
            OperationDeadline deadline = new OperationDeadline(timeoutMillis);
            try {
                outcome.get(deadline.remainingNanos(), TimeUnit.NANOSECONDS);
            } catch (TimeoutException error) {
                factoryDataSource.poison(new PhysicalConnectionStateUnknownException(error));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                factoryDataSource.poison(new PhysicalConnectionStateUnknownException(error));
            } catch (ExecutionException error) {
                factoryDataSource.poison(new PhysicalConnectionStateUnknownException(error.getCause()));
            }
        }

        private void releaseLate(
            HikariDataSource dataSource,
            Connection connection,
            ConnectionFactoryDataSource factoryDataSource,
            long timeoutMillis
        ) {
            release(dataSource, connection, true, factoryDataSource, timeoutMillis, true);
        }

        private CompletableFuture<Void> submit(
            HikariDataSource dataSource,
            Connection connection,
            boolean evict,
            ConnectionFactoryDataSource factoryDataSource,
            boolean attemptInlineWhenRejected
        ) {
            CompletableFuture<Void> outcome = new CompletableFuture<>();
            try {
                executor.execute(() -> completeRelease(dataSource, connection, evict, outcome));
                return outcome;
            } catch (RejectedExecutionException error) {
                factoryDataSource.poison(new JdbcOperationCapacityException("release", error));
                if (attemptInlineWhenRejected) {
                    completeRelease(dataSource, connection, evict, outcome);
                    return outcome;
                }
                return null;
            }
        }

        private static void completeRelease(
            HikariDataSource dataSource,
            Connection connection,
            boolean evict,
            CompletableFuture<Void> outcome
        ) {
            Throwable failure = null;
            try {
                if (evict) {
                    dataSource.evictConnection(connection);
                }
            } catch (Throwable error) {
                failure = error;
            }
            try {
                connection.close();
            } catch (Throwable error) {
                if (failure == null) {
                    failure = error;
                } else {
                    failure.addSuppressed(error);
                }
            }
            if (failure == null) {
                outcome.complete(null);
            } else {
                outcome.completeExceptionally(failure);
            }
        }

        @Override
        public void close() {
            executor.shutdownNow();
        }
    }

    private static final class PoolCloseExecutor implements AutoCloseable {
        private final ExecutorService executor;
        private final AtomicReference<SQLException> runtimeFailure;

        private PoolCloseExecutor(int maximumConcurrentCloses, AtomicReference<SQLException> runtimeFailure) {
            this.executor = boundedExecutor(maximumConcurrentCloses, "dbx-jdbc-pool-close");
            this.runtimeFailure = runtimeFailure;
        }

        private void close(
            HikariDataSource dataSource,
            ConnectionFactoryDataSource factoryDataSource,
            OperationDeadline deadline
        ) {
            CompletableFuture<Void> outcome = new CompletableFuture<>();
            try {
                executor.execute(() -> {
                    try {
                        dataSource.close();
                        outcome.complete(null);
                    } catch (Throwable error) {
                        outcome.completeExceptionally(error);
                    }
                });
            } catch (RejectedExecutionException error) {
                poison(factoryDataSource, new JdbcOperationCapacityException("pool_close", error));
                return;
            }
            try {
                outcome.get(deadline.remainingNanos(), TimeUnit.NANOSECONDS);
                SQLException failure = factoryDataSource.causalFailure();
                if (failure != null && requiresRuntimeReplacement(failure)) {
                    runtimeFailure.compareAndSet(null, failure);
                }
            } catch (TimeoutException error) {
                poison(factoryDataSource, new PhysicalConnectionStateUnknownException(error));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                poison(factoryDataSource, new PhysicalConnectionStateUnknownException(error));
            } catch (ExecutionException error) {
                poison(factoryDataSource, new PhysicalConnectionStateUnknownException(error.getCause()));
            }
        }

        private void poison(ConnectionFactoryDataSource factoryDataSource, SQLException failure) {
            factoryDataSource.poison(failure);
            runtimeFailure.compareAndSet(null, failure);
        }

        @Override
        public void close() {
            executor.shutdownNow();
        }
    }

    private static final class PhysicalConnectionCloser implements AutoCloseable {
        private final ExecutorService executor;

        private PhysicalConnectionCloser(int maximumConcurrentCloses) {
            executor = boundedExecutor(maximumConcurrentCloses, "dbx-jdbc-physical-close");
        }

        private boolean close(
            Connection connection,
            ConnectionFactoryDataSource factoryDataSource,
            long timeoutMillis
        ) {
            try {
                call("physical_close", () -> {
                    connection.close();
                    return null;
                }, factoryDataSource, timeoutMillis);
                return true;
            } catch (SQLException ignored) {
                return false;
            }
        }

        private boolean abort(
            Connection connection,
            Executor abortExecutor,
            ConnectionFactoryDataSource factoryDataSource,
            long timeoutMillis
        ) {
            try {
                call("physical_abort", () -> {
                    connection.abort(abortExecutor);
                    return null;
                }, factoryDataSource, timeoutMillis);
                factoryDataSource.poison(new PhysicalConnectionStateUnknownException(
                    new SQLException("JDBC connection abort cannot confirm physical resource release")
                ));
            } catch (SQLException ignored) {
            }
            return false;
        }

        private boolean isClosed(
            Connection connection,
            ConnectionFactoryDataSource factoryDataSource,
            long timeoutMillis
        ) throws SQLException {
            return call("physical_is_closed", connection::isClosed, factoryDataSource, timeoutMillis);
        }

        private void setNetworkTimeout(
            Connection connection,
            Executor networkTimeoutExecutor,
            int networkTimeoutMillis,
            ConnectionFactoryDataSource factoryDataSource,
            long timeoutMillis
        ) throws SQLException {
            call("physical_set_network_timeout", () -> {
                connection.setNetworkTimeout(networkTimeoutExecutor, networkTimeoutMillis);
                return null;
            }, factoryDataSource, timeoutMillis);
        }

        private <T> T call(
            String operation,
            PhysicalConnectionCall<T> call,
            ConnectionFactoryDataSource factoryDataSource,
            long timeoutMillis
        ) throws SQLException {
            CompletableFuture<T> outcome = new CompletableFuture<>();
            try {
                executor.execute(() -> {
                    try {
                        outcome.complete(call.run());
                    } catch (Throwable error) {
                        outcome.completeExceptionally(error);
                    }
                });
            } catch (RejectedExecutionException error) {
                SQLException failure = new JdbcOperationCapacityException(operation, error);
                factoryDataSource.poison(failure);
                throw failure;
            }
            OperationDeadline deadline = new OperationDeadline(timeoutMillis);
            try {
                return outcome.get(deadline.remainingNanos(), TimeUnit.NANOSECONDS);
            } catch (TimeoutException error) {
                SQLException failure = new PhysicalConnectionStateUnknownException(error);
                factoryDataSource.poison(failure);
                throw failure;
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                SQLException failure = new PhysicalConnectionStateUnknownException(error);
                factoryDataSource.poison(failure);
                throw failure;
            } catch (ExecutionException error) {
                SQLException failure = new PhysicalConnectionStateUnknownException(error.getCause());
                factoryDataSource.poison(failure);
                throw failure;
            }
        }

        @Override
        public void close() {
            executor.shutdownNow();
        }
    }

    @FunctionalInterface
    private interface PhysicalConnectionCall<T> {
        T run() throws SQLException;
    }

    private interface HikariSetupTrackedConnection {
        void completeHikariSetup();
    }

    private static final class PhysicalConnectionOpener implements AutoCloseable {
        private final ExecutorService executor;

        private PhysicalConnectionOpener(int maximumConcurrentOpens) {
            executor = boundedExecutor(maximumConcurrentOpens, "dbx-jdbc-physical-connect");
        }

        private Connection open(
            ConnectionFactory connectionFactory,
            PhysicalConnectionBudget physicalConnectionBudget,
            PhysicalConnectionCloser physicalConnectionCloser,
            ConnectionFactoryDataSource factoryDataSource,
            OperationDeadline deadline,
            long closeTimeoutMillis
        ) throws Exception {
            CompletableFuture<Connection> outcome = new CompletableFuture<>();
            try {
                executor.execute(() -> completeOpen(
                    connectionFactory,
                    physicalConnectionBudget,
                    physicalConnectionCloser,
                    factoryDataSource,
                    closeTimeoutMillis,
                    outcome
                ));
            } catch (RejectedExecutionException error) {
                throw new JdbcOperationCapacityException("physical_connect", error);
            }
            try {
                return outcome.get(deadline.remainingNanos(), TimeUnit.NANOSECONDS);
            } catch (TimeoutException error) {
                return abandon(outcome, error);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return abandon(outcome, error);
            } catch (ExecutionException error) {
                throwOpenFailure(error.getCause());
                throw new IllegalStateException("unreachable");
            }
        }

        private static void completeOpen(
            ConnectionFactory connectionFactory,
            PhysicalConnectionBudget physicalConnectionBudget,
            PhysicalConnectionCloser physicalConnectionCloser,
            ConnectionFactoryDataSource factoryDataSource,
            long closeTimeoutMillis,
            CompletableFuture<Connection> outcome
        ) {
            Connection connection = null;
            try {
                connection = Objects.requireNonNull(
                    connectionFactory.open(),
                    "JDBC connection factory returned null"
                );
                if (!outcome.complete(connection)
                    && physicalConnectionCloser.close(connection, factoryDataSource, closeTimeoutMillis)) {
                    physicalConnectionBudget.release();
                }
            } catch (Throwable error) {
                if (!outcome.completeExceptionally(error)
                    && !contains(error, PhysicalConnectionStateUnknownException.class)) {
                    physicalConnectionBudget.release();
                }
            }
        }

        private static Connection abandon(
            CompletableFuture<Connection> outcome,
            Exception cause
        ) throws Exception {
            PhysicalConnectionStateUnknownException failure = new PhysicalConnectionStateUnknownException(cause);
            if (outcome.completeExceptionally(failure)) {
                throw failure;
            }
            try {
                return outcome.get();
            } catch (ExecutionException error) {
                throwOpenFailure(error.getCause());
                throw new IllegalStateException("unreachable");
            }
        }

        private static void throwOpenFailure(Throwable error) throws Exception {
            if (error instanceof Error fatal) {
                throw fatal;
            }
            if (error instanceof Exception exception) {
                throw exception;
            }
            throw new SQLException("Failed to open JDBC connection", error);
        }

        @Override
        public void close() {
            executor.shutdownNow();
        }
    }

    private static final class PhysicalConnectionBudget {
        private final int maximum;
        private final Semaphore permits;

        private PhysicalConnectionBudget(int maximum) {
            this.maximum = maximum;
            this.permits = new Semaphore(maximum, true);
        }

        private void acquire(OperationDeadline deadline) throws SQLException {
            try {
                if (permits.tryAcquire(deadline.remainingNanos(), TimeUnit.NANOSECONDS)) {
                    return;
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new SQLException("Interrupted while waiting for the JDBC physical connection budget", error);
            }
            throw new PhysicalConnectionLimitException(maximum);
        }

        private Connection wrap(
            Connection connection,
            PhysicalConnectionCloser physicalConnectionCloser,
            ConnectionFactoryDataSource factoryDataSource,
            long closeTimeoutMillis,
            ConnectionFactoryDataSource.HikariSetupAttempt setupAttempt
        ) {
            AtomicBoolean released = new AtomicBoolean();
            return (Connection) Proxy.newProxyInstance(
                JdbcConnectionPoolRegistry.class.getClassLoader(),
                new Class<?>[] {Connection.class, HikariSetupTrackedConnection.class},
                (proxy, method, arguments) -> {
                    if ("completeHikariSetup".equals(method.getName()) && method.getParameterCount() == 0) {
                        setupAttempt.completeSuccessfully();
                        return null;
                    }
                    boolean close = "close".equals(method.getName()) && method.getParameterCount() == 0;
                    boolean abort = "abort".equals(method.getName()) && method.getParameterCount() == 1;
                    if (close || abort) {
                        synchronized (released) {
                            if (released.get()) {
                                return null;
                            }
                            boolean terminated = close
                                ? physicalConnectionCloser.close(
                                    connection,
                                    factoryDataSource,
                                    closeTimeoutMillis
                                )
                                : physicalConnectionCloser.abort(
                                    connection,
                                    (Executor) arguments[0],
                                    factoryDataSource,
                                    closeTimeoutMillis
                                );
                            if (terminated) {
                                setupAttempt.completeAfterPhysicalClose();
                                if (released.compareAndSet(false, true)) {
                                    release();
                                }
                                return null;
                            }
                            throw new PhysicalConnectionStateUnknownException(
                                new SQLException("Physical JDBC connection termination did not complete")
                            );
                        }
                    }
                    if ("isClosed".equals(method.getName()) && method.getParameterCount() == 0) {
                        return released.get() || physicalConnectionCloser.isClosed(
                            connection,
                            factoryDataSource,
                            closeTimeoutMillis
                        );
                    }
                    if ("setNetworkTimeout".equals(method.getName()) && method.getParameterCount() == 2) {
                        physicalConnectionCloser.setNetworkTimeout(
                            connection,
                            (Executor) arguments[0],
                            (Integer) arguments[1],
                            factoryDataSource,
                            closeTimeoutMillis
                        );
                        return null;
                    }
                    try {
                        return method.invoke(connection, arguments);
                    } catch (InvocationTargetException error) {
                        Throwable cause = error.getCause();
                        if (cause instanceof SQLException sqlError) {
                            setupAttempt.recordFailure(sqlError);
                        }
                        throw cause;
                    }
                }
            );
        }

        private void release() {
            permits.release();
        }

        private int activeCount() {
            return maximum - permits.availablePermits();
        }

    }

    static final class PhysicalConnectionStateUnknownException extends SQLException {
        PhysicalConnectionStateUnknownException(Throwable cause) {
            super("Physical JDBC connection state could not be confirmed", cause);
        }
    }

    private static final class JdbcOperationCapacityException extends SQLTransientConnectionException {
        private JdbcOperationCapacityException(String operation, Throwable cause) {
            super("JDBC " + operation + " executor capacity is exhausted", cause);
        }
    }

    private static final class PhysicalConnectionLimitException extends SQLTransientConnectionException {
        private PhysicalConnectionLimitException(int maximum) {
            super("Agent runtime JDBC physical connection limit reached: " + maximum);
        }
    }

    static boolean requiresRuntimeReplacement(Throwable error) {
        return contains(error, PhysicalConnectionStateUnknownException.class);
    }

    private static <T extends Throwable> T find(Throwable error, Class<T> type) {
        java.util.Set<Throwable> visited = Collections.newSetFromMap(new IdentityHashMap<>());
        Throwable current = error;
        while (current != null && visited.add(current)) {
            if (type.isInstance(current)) {
                return type.cast(current);
            }
            current = current.getCause();
        }
        return null;
    }

    private static boolean contains(Throwable error, Class<? extends Throwable> type) {
        return contains(error, type, Collections.newSetFromMap(new IdentityHashMap<>()));
    }

    private static boolean contains(
        Throwable error,
        Class<? extends Throwable> type,
        java.util.Set<Throwable> visited
    ) {
        Throwable current = error;
        while (current != null && visited.add(current)) {
            if (type.isInstance(current)) {
                return true;
            }
            if (current instanceof SQLException sqlError && sqlError.getNextException() != null
                && contains(sqlError.getNextException(), type, visited)) {
                return true;
            }
            current = current.getCause();
        }
        return false;
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
