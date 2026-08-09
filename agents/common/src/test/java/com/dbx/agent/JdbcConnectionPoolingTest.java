package com.dbx.agent;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Statement;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

class JdbcConnectionPoolingTest {
    private static final Gson GSON = new Gson();

    @Test
    void registryReusesOnePhysicalConnectionAcrossSequentialLeases() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        String url = h2Url("registry_reuse");
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(poolSettings(4))) {
            for (int index = 0; index < 100; index++) {
                try (JdbcConnectionPoolRegistry.Lease lease = registry.borrow(
                    "same-identity",
                    () -> openH2(url, physicalOpens)
                )) {
                    try (Statement statement = lease.connection().createStatement()) {
                        assertTrue(statement.execute("SELECT 1"));
                    }
                }
            }
            assertEquals(1, physicalOpens.get());
            assertEquals(1, registry.poolCount());
        }
    }

    @Test
    void registryCapsConcurrentPhysicalConnections() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger activeLeases = new AtomicInteger();
        AtomicInteger maximumActiveLeases = new AtomicInteger();
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch firstTwoBorrowed = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(8);
        String url = h2Url("registry_cap");

        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(poolSettings(2))) {
            List<Future<?>> futures = new java.util.ArrayList<>();
            for (int index = 0; index < 8; index++) {
                futures.add(workers.submit(() -> {
                    start.await();
                    try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                        "same-identity",
                        () -> openH2(url, physicalOpens)
                    )) {
                        int active = activeLeases.incrementAndGet();
                        maximumActiveLeases.accumulateAndGet(active, Math::max);
                        firstTwoBorrowed.countDown();
                        release.await();
                        activeLeases.decrementAndGet();
                    }
                    return null;
                }));
            }

            start.countDown();
            assertTrue(firstTwoBorrowed.await(2, TimeUnit.SECONDS));
            Thread.sleep(150L);
            assertEquals(2, physicalOpens.get());
            assertEquals(2, maximumActiveLeases.get());
            release.countDown();
            for (Future<?> future : futures) {
                future.get(3, TimeUnit.SECONDS);
            }
            assertEquals(2, physicalOpens.get());
        } finally {
            release.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void registrySeparatesDifferentConnectionIdentities() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        String url = h2Url("registry_identity");
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(poolSettings(2))) {
            try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                "identity-a",
                () -> openH2(url, physicalOpens)
            )) {
            }
            try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                "identity-b",
                () -> openH2(url, physicalOpens)
            )) {
            }

            assertEquals(2, physicalOpens.get());
            assertEquals(2, registry.poolCount());
        }
    }

    @Test
    void registryBoundsInitialPhysicalConnectionFailureByBorrowTimeout() {
        JdbcConnectionPoolRegistry.PoolSettings settings = new JdbcConnectionPoolRegistry.PoolSettings(
            1,
            0,
            250L,
            250L,
            10_000L,
            30_000L,
            60_000L
        );
        long startedAtMillis = System.currentTimeMillis();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings)) {
            SQLException error = assertThrows(
                SQLException.class,
                () -> registry.borrow("failing", () -> {
                    throw new SQLException("auth failed");
                })
            );
            long elapsedMillis = System.currentTimeMillis() - startedAtMillis;
            assertTrue(elapsedMillis < 450L, () -> "initial failure took " + elapsedMillis + "ms");
            assertTrue(throwableText(error).contains("auth failed"), error::toString);
        }
    }

    @Test
    void metadataLeaseUsesReservedCapacityWhenWorkloadIsSaturated() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        String url = h2Url("metadata_reserve");
        JdbcConnectionPoolRegistry.PoolSettings settings = poolSettings(4, 1, 32, 2);
        ExecutorService worker = Executors.newSingleThreadExecutor();

        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings)) {
            JdbcConnectionPoolRegistry.Lease first = registry.borrow(
                "same-identity",
                JdbcSessionRole.WORKLOAD,
                () -> openH2(url, physicalOpens)
            );
            JdbcConnectionPoolRegistry.Lease second = registry.borrow(
                "same-identity",
                JdbcSessionRole.WORKLOAD,
                () -> openH2(url, physicalOpens)
            );
            JdbcConnectionPoolRegistry.Lease third = registry.borrow(
                "same-identity",
                JdbcSessionRole.WORKLOAD,
                () -> openH2(url, physicalOpens)
            );
            Future<?> waitingWorkload = worker.submit(() -> {
                try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                    "same-identity",
                    JdbcSessionRole.WORKLOAD,
                    () -> openH2(url, physicalOpens)
                )) {
                    return null;
                }
            });

            Thread.sleep(100L);
            assertFalse(waitingWorkload.isDone());
            try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                "same-identity",
                JdbcSessionRole.METADATA,
                () -> openH2(url, physicalOpens)
            )) {
                assertEquals(4, physicalOpens.get());
            }

            first.close();
            waitingWorkload.get(2, TimeUnit.SECONDS);
            second.close();
            third.close();
        } finally {
            worker.shutdownNow();
        }
    }

    @Test
    void metadataSessionCompletesThroughProtocolWhenWorkloadSessionsAreSaturated() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger agentIndexes = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        CountDownLatch workloadsStarted = new CountDownLatch(3);
        CountDownLatch releaseWorkloads = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(3);
        String url = h2Url("metadata_protocol_reserve");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> {
                int agentIndex = agentIndexes.incrementAndGet();
                return new H2TestAgent(url, physicalOpens) {
                    @Override
                    public List<DatabaseInfo> listDatabases() {
                        if (agentIndex <= 3) {
                            workloadsStarted.countDown();
                            awaitUninterruptibly(releaseWorkloads);
                        }
                        return Collections.emptyList();
                    }
                };
            },
            poolSettings(4, 1, 32, 2)
        )) {
            List<Future<JsonObject>> workloadRequests = new java.util.ArrayList<>();
            for (int index = 0; index < 3; index++) {
                String sessionId = "workload-" + index;
                openSession(server, requestIds, sessionId);
                workloadRequests.add(workers.submit(() -> request(
                    server,
                    requestIds,
                    AgentProtocol.METHOD_LIST_DATABASES,
                    sessionParams(sessionId)
                )));
            }
            assertTrue(workloadsStarted.await(2, TimeUnit.SECONDS));

            JsonObject metadataParams = sessionParams("metadata");
            metadataParams.addProperty("sessionRole", "metadata");
            metadataParams.addProperty("database", "pooling");
            metadataParams.addProperty("username", "sa");
            metadataParams.addProperty("password", "");
            result(rawRequest(server, requestIds, AgentProtocol.METHOD_OPEN_SESSION, metadataParams));
            JsonObject metadataResponse = request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("metadata")
            );
            assertTrue(metadataResponse.getAsJsonArray("result").isEmpty());
            assertEquals(4, physicalOpens.get());

            releaseWorkloads.countDown();
            for (Future<JsonObject> workloadRequest : workloadRequests) {
                workloadRequest.get(2, TimeUnit.SECONDS);
            }
        } finally {
            releaseWorkloads.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void poolSizeOneDisablesMetadataReserveWithoutBlockingWorkload() throws Exception {
        JdbcConnectionPoolRegistry.PoolSettings settings = poolSettings(1, 2, 32, 2);
        assertEquals(0, settings.effectiveMetadataReserve());
        assertEquals(1, settings.effectiveMaxQuarantinedOperations());

        AtomicInteger physicalOpens = new AtomicInteger();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings);
             JdbcConnectionPoolRegistry.Lease lease = registry.borrow(
                 "single-connection",
                 JdbcSessionRole.WORKLOAD,
                 () -> openH2(h2Url("single_connection_reserve"), physicalOpens)
             )) {
            assertEquals(1, physicalOpens.get());
            assertTrue(lease.quarantine());
            lease.evict();
        }
    }

    @Test
    void closingQuarantinedLeaseEvictsItInsteadOfReturningItToPool() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        String url = h2Url("quarantined_close");
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(poolSettings(2))) {
            JdbcConnectionPoolRegistry.Lease quarantined = registry.borrow(
                "same-identity",
                () -> openH2(url, physicalOpens)
            );
            assertFalse(quarantined.quarantine());
            quarantined.close();

            try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                "same-identity",
                () -> openH2(url, physicalOpens)
            )) {
                assertEquals(2, physicalOpens.get());
            }
        }
    }

    @Test
    void registryCapsPhysicalConnectionsAcrossConnectionIdentities() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        JdbcConnectionPoolRegistry.PoolSettings settings = new JdbcConnectionPoolRegistry.PoolSettings(
            true,
            4,
            0,
            250L,
            250L,
            10_000L,
            30_000L,
            0L,
            0,
            2,
            2
        );
        JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings);
        JdbcConnectionPoolRegistry.Lease first = null;
        JdbcConnectionPoolRegistry.Lease second = null;
        try {
            first = registry.borrow("identity-a", () -> openH2(h2Url("global_a"), physicalOpens));
            second = registry.borrow("identity-b", () -> openH2(h2Url("global_b"), physicalOpens));
            assertEquals(2, registry.activePhysicalConnectionCount());

            AgentRpcError capacity = assertThrows(
                AgentRpcError.class,
                () -> registry.borrow("identity-c", () -> openH2(h2Url("global_c"), physicalOpens))
            );
            JsonObject capacityData = AgentRpcError.toJson(
                capacity,
                AgentProtocol.METHOD_OPEN_SESSION,
                "capacity"
            ).getAsJsonObject("data");
            assertEquals("keep", capacityData.get("sessionDisposition").getAsString());
            assertEquals(2, registry.activePhysicalConnectionCount());

            first.close();
            first = null;
            registry.retireUnusedPools();
            awaitPhysicalConnectionCount(registry, 1);
            try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                "identity-c",
                () -> openH2(h2Url("global_c"), physicalOpens)
            )) {
                assertEquals(2, registry.activePhysicalConnectionCount());
            }
        } finally {
            if (first != null) {
                first.close();
            }
            if (second != null) {
                second.close();
            }
            registry.close();
        }
        assertEquals(0, registry.activePhysicalConnectionCount());
    }

    @Test
    void globalPhysicalCapacityBackpressureKeepsActiveLeaseUsable() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        CountDownLatch abortCalled = new CountDownLatch(1);
        String url = h2Url("shared_capacity");
        try (Connection ignored = openH2(url, physicalOpens)) {
            // Keep H2 bootstrap outside the 250ms capacity watchdog exercised below.
        }
        physicalOpens.set(0);
        JdbcConnectionPoolRegistry.PoolSettings settings = new JdbcConnectionPoolRegistry.PoolSettings(
            true,
            2,
            0,
            250L,
            250L,
            10_000L,
            30_000L,
            60_000L,
            0,
            1,
            2
        );
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings);
             JdbcConnectionPoolRegistry.Lease active = registry.borrow(
                 "shared-capacity",
                 () -> abortTrackingConnection(
                     openH2(url, physicalOpens),
                     abortCalled
                 )
             )) {
            AgentRpcError capacity = assertThrows(
                AgentRpcError.class,
                () -> registry.borrow(
                    "shared-capacity",
                    () -> openH2(url, physicalOpens)
                )
            );
            JsonObject data = AgentRpcError.toJson(
                capacity,
                AgentProtocol.METHOD_OPEN_SESSION,
                "shared-capacity"
            ).getAsJsonObject("data");
            assertEquals("keep", data.get("sessionDisposition").getAsString());
            assertFalse(abortCalled.await(1, TimeUnit.SECONDS));
            assertTrue(active.connection().isValid(1));
            assertEquals(1, registry.activePhysicalConnectionCount());
        }
    }

    @Test
    void physicalBudgetIsRetainedWhenDriverCloseCannotBeConfirmed() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger closeAttempts = new AtomicInteger();
        JdbcConnectionPoolRegistry.PoolSettings settings = shortTimeoutPoolSettings(2, 1);
        JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings);
        try {
            JdbcConnectionPoolRegistry.Lease lease = registry.borrow(
                "identity-a",
                () -> closeFailingConnection(openH2(h2Url("close_unknown"), physicalOpens), closeAttempts)
            );
            lease.quarantine();
            lease.close();

            awaitCount(closeAttempts, 1);
            assertEquals(1, registry.activePhysicalConnectionCount());
            assertThrows(
                AgentRpcError.class,
                () -> registry.borrow("identity-b", () -> openH2(h2Url("close_unknown_b"), physicalOpens))
            );
        } finally {
            registry.close();
        }
    }

    @Test
    void hikariPreCloseNetworkTimeoutIsBoundedAndPoisonsIdentity() throws Exception {
        AtomicBoolean blockNetworkTimeout = new AtomicBoolean();
        CountDownLatch networkTimeoutStarted = new CountDownLatch(1);
        CountDownLatch releaseNetworkTimeout = new CountDownLatch(1);
        String url = h2Url("pre_close_network_timeout");
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(shortTimeoutPoolSettings(1, 1))) {
            JdbcConnectionPoolRegistry.Lease lease = registry.borrow(
                "pre-close-network-timeout",
                () -> networkTimeoutBlockingConnection(
                    openH2(url, new AtomicInteger()),
                    blockNetworkTimeout,
                    networkTimeoutStarted,
                    releaseNetworkTimeout
                )
            );
            blockNetworkTimeout.set(true);
            lease.quarantine();
            lease.close();
            assertTrue(networkTimeoutStarted.await(1, TimeUnit.SECONDS));
            Thread.sleep(350L);

            AgentRpcError retry = assertThrows(
                AgentRpcError.class,
                () -> registry.borrow(
                    "pre-close-network-timeout",
                    () -> openH2(url, new AtomicInteger())
                )
            );
            JsonObject data = AgentRpcError.toJson(retry, AgentProtocol.METHOD_OPEN_SESSION, "retry")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", data.get("sessionDisposition").getAsString());
        } finally {
            releaseNetworkTimeout.countDown();
        }
    }

    @Test
    void asynchronousAbortRetainsPhysicalBudgetWhenOnlyLogicalCloseIsConfirmed() throws Exception {
        CountDownLatch abortScheduled = new CountDownLatch(1);
        CountDownLatch releaseTermination = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(shortTimeoutPoolSettings(1, 1));
        registry.borrow(
            "async-abort",
            () -> asynchronousAbortConnection(
                openH2(h2Url("async_abort"), new AtomicInteger()),
                abortScheduled,
                releaseTermination
            )
        );
        try {
            Future<?> close = worker.submit(registry::close);
            assertTrue(abortScheduled.await(1, TimeUnit.SECONDS));
            assertEquals(1, registry.activePhysicalConnectionCount());
            releaseTermination.countDown();
            close.get(2, TimeUnit.SECONDS);
            awaitPhysicalConnectionCount(registry, 0);
        } finally {
            releaseTermination.countDown();
            registry.close();
            worker.shutdownNow();
        }
    }

    @Test
    void physicalBudgetIsRetainedWhenInitializationReportsUnknownConnectionState() {
        JdbcConnectionPoolRegistry.PoolSettings settings = shortTimeoutPoolSettings(2, 1);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings)) {
            assertThrows(
                AgentRpcError.class,
                () -> registry.borrow(
                    "identity-a",
                    () -> {
                        throw new JdbcConnectionPoolRegistry.PhysicalConnectionStateUnknownException(
                            new SQLException("initialization failed and close did not complete")
                        );
                    }
                )
            );
            assertEquals(1, registry.activePhysicalConnectionCount());
        }
    }

    @Test
    void quarantineThresholdIsCountedOncePerLeaseAndReleasedOnClose() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        String url = h2Url("quarantine_threshold");
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(poolSettings(4, 0, 32, 2))) {
            JdbcConnectionPoolRegistry.Lease first = registry.borrow(
                "same-identity",
                () -> openH2(url, physicalOpens)
            );
            JdbcConnectionPoolRegistry.Lease second = registry.borrow(
                "same-identity",
                () -> openH2(url, physicalOpens)
            );

            assertFalse(first.quarantine());
            assertFalse(first.quarantine());
            assertTrue(second.quarantine());
            first.evict();
            second.evict();

            JdbcConnectionPoolRegistry.Lease replacement = registry.borrow(
                "same-identity",
                () -> openH2(url, physicalOpens)
            );
            assertFalse(replacement.quarantine());
            replacement.evict();
        }
    }

    @Test
    void missingOrUnknownSessionRoleDefaultsToWorkload() {
        assertEquals(JdbcSessionRole.WORKLOAD, JdbcSessionRole.from(null));
        assertEquals(JdbcSessionRole.WORKLOAD, JdbcSessionRole.from(""));
        assertEquals(JdbcSessionRole.WORKLOAD, JdbcSessionRole.from("future-role"));
        assertEquals(JdbcSessionRole.METADATA, JdbcSessionRole.from(" metadata "));
    }

    @Test
    void registryBorrowTimeoutBoundsBlockedPhysicalConnect() throws Exception {
        AtomicInteger connectAttempts = new AtomicInteger();
        CountDownLatch connectStarted = new CountDownLatch(1);
        CountDownLatch releaseConnect = new CountDownLatch(1);
        JdbcConnectionPoolRegistry.PoolSettings settings = new JdbcConnectionPoolRegistry.PoolSettings(
            1,
            0,
            250L,
            250L,
            10_000L,
            30_000L,
            60_000L
        );
        JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings);
        long startedAtMillis = System.currentTimeMillis();
        try {
            AgentRpcError initial = assertThrows(AgentRpcError.class, () -> registry.borrow("blocked-connect", () -> {
                connectAttempts.incrementAndGet();
                connectStarted.countDown();
                awaitUninterruptibly(releaseConnect);
                throw new SQLException("late connect");
            }));
            long elapsedMillis = System.currentTimeMillis() - startedAtMillis;
            assertTrue(connectStarted.await(1, TimeUnit.SECONDS));
            assertTrue(elapsedMillis < 450L, () -> "blocked connect took " + elapsedMillis + "ms");
            JsonObject initialData = AgentRpcError.toJson(initial, AgentProtocol.METHOD_OPEN_SESSION, "initial")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", initialData.get("sessionDisposition").getAsString());
            AgentRpcError retry = assertThrows(
                AgentRpcError.class,
                () -> registry.borrow("blocked-connect", () -> openH2(h2Url("blocked_retry"), new AtomicInteger()))
            );
            JsonObject retryData = AgentRpcError.toJson(retry, AgentProtocol.METHOD_OPEN_SESSION, "retry")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", retryData.get("sessionDisposition").getAsString());
            assertEquals(1, connectAttempts.get());
            releaseConnect.countDown();
            awaitPhysicalConnectionCount(registry, 0);
        } finally {
            releaseConnect.countDown();
            registry.close();
        }
    }

    @Test
    void registryBorrowTimeoutBoundsBlockedHikariValidationAndPoisonsIdentity() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicBoolean blockValidation = new AtomicBoolean();
        CountDownLatch validationStarted = new CountDownLatch(1);
        CountDownLatch releaseValidation = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        String url = h2Url("blocked_validation");
        try (Connection ignored = openH2(url, physicalOpens)) {
            // Keep H2 bootstrap outside the 250ms validation watchdog exercised below.
        }
        physicalOpens.set(0);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(shortTimeoutPoolSettings(1, 32))) {
            try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                "blocked-validation",
                () -> validationBlockingConnection(
                    openH2(url, physicalOpens),
                    blockValidation,
                    validationStarted,
                    releaseValidation
                )
            )) {
                assertEquals(1, physicalOpens.get());
            }
            blockValidation.set(true);
            Thread.sleep(600L); // Hikari skips validation for connections used within its 500ms alive-bypass window.

            long startedAtNanos = System.nanoTime();
            Future<JdbcConnectionPoolRegistry.Lease> blocked = worker.submit(
                () -> registry.borrow("blocked-validation", () -> openH2(url, physicalOpens))
            );
            assertTrue(validationStarted.await(1, TimeUnit.SECONDS));
            AgentRpcError timeout = futureFailure(blocked, AgentRpcError.class, 2, TimeUnit.SECONDS);
            long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);
            assertTrue(elapsedMillis < 450L, () -> "blocked validation took " + elapsedMillis + "ms");
            JsonObject timeoutData = AgentRpcError.toJson(timeout, AgentProtocol.METHOD_OPEN_SESSION, "blocked")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", timeoutData.get("sessionDisposition").getAsString());

            AgentRpcError retry = assertThrows(
                AgentRpcError.class,
                () -> registry.borrow("blocked-validation", () -> openH2(url, physicalOpens))
            );
            JsonObject retryData = AgentRpcError.toJson(retry, AgentProtocol.METHOD_OPEN_SESSION, "retry")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", retryData.get("sessionDisposition").getAsString());
            assertEquals(1, physicalOpens.get());
            releaseValidation.countDown();
            awaitPhysicalConnectionCount(registry, 0);
        } finally {
            releaseValidation.countDown();
            worker.shutdownNow();
        }
    }

    @Test
    void physicalBudgetWaitAndConnectShareOneBorrowDeadline() throws Exception {
        CountDownLatch connectStarted = new CountDownLatch(1);
        CountDownLatch releaseConnect = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        JdbcConnectionPoolRegistry.PoolSettings settings = new JdbcConnectionPoolRegistry.PoolSettings(
            true,
            1,
            0,
            500L,
            500L,
            10_000L,
            30_000L,
            0L,
            0,
            1,
            2
        );
        JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings);
        JdbcConnectionPoolRegistry.Lease held = registry.borrow(
            "deadline-holder",
            () -> openH2(h2Url("deadline_holder"), new AtomicInteger())
        );
        try {
            long startedAtNanos = System.nanoTime();
            Future<JdbcConnectionPoolRegistry.Lease> blocked = worker.submit(() -> registry.borrow(
                "deadline-waiter",
                () -> {
                    connectStarted.countDown();
                    awaitUninterruptibly(releaseConnect);
                    throw new SQLException("late connect");
                }
            ));
            Thread.sleep(400L);
            held.close();
            held = null;
            registry.retireUnusedPools();
            assertTrue(connectStarted.await(1, TimeUnit.SECONDS));

            AgentRpcError timeout = futureFailure(blocked, AgentRpcError.class, 2, TimeUnit.SECONDS);
            long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);
            assertTrue(elapsedMillis < 700L, () -> "budget and connect took " + elapsedMillis + "ms");
            JsonObject data = AgentRpcError.toJson(timeout, AgentProtocol.METHOD_OPEN_SESSION, "deadline")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", data.get("sessionDisposition").getAsString());
        } finally {
            if (held != null) {
                held.close();
            }
            releaseConnect.countDown();
            worker.shutdownNow();
            registry.close();
        }
    }

    @Test
    void metadataCapacityTimeoutKeepsIdentityRoutable() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        ExecutorService worker = Executors.newSingleThreadExecutor();
        String url = h2Url("metadata_capacity");
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(shortTimeoutPoolSettings(1, 32))) {
            JdbcConnectionPoolRegistry.Lease held = registry.borrow(
                "metadata-capacity",
                JdbcSessionRole.METADATA,
                () -> openH2(url, physicalOpens)
            );
            try {
                Future<JdbcConnectionPoolRegistry.Lease> waiting = worker.submit(() -> registry.borrow(
                    "metadata-capacity",
                    JdbcSessionRole.METADATA,
                    () -> openH2(url, physicalOpens)
                ));
                AgentRpcError capacity = futureFailure(waiting, AgentRpcError.class, 2, TimeUnit.SECONDS);
                JsonObject data = AgentRpcError.toJson(capacity, AgentProtocol.METHOD_OPEN_SESSION, "metadata")
                    .getAsJsonObject("data");
                assertTrue(data.get("retryable").getAsBoolean());
                assertEquals("keep", data.get("sessionDisposition").getAsString());
            } finally {
                held.close();
            }

            try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                "metadata-capacity",
                JdbcSessionRole.METADATA,
                () -> openH2(url, physicalOpens)
            )) {
                assertEquals(1, physicalOpens.get());
            }
        } finally {
            worker.shutdownNow();
        }
    }

    @Test
    void blockedValidationDoesNotSerializeHealthyMetadataCheckout() throws Exception {
        AtomicBoolean blockNextValidation = new AtomicBoolean();
        AtomicInteger physicalOpens = new AtomicInteger();
        CountDownLatch validationStarted = new CountDownLatch(1);
        CountDownLatch releaseValidation = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        String url = h2Url("parallel_validation");
        JdbcConnectionPoolRegistry.PoolSettings settings = new JdbcConnectionPoolRegistry.PoolSettings(
            true,
            2,
            0,
            500L,
            500L,
            10_000L,
            30_000L,
            60_000L,
            1,
            2,
            2
        );
        try (Connection ignored = openH2(url, physicalOpens)) {
            // Keep H2 bootstrap outside the concurrent validation watchdog.
        }
        physicalOpens.set(0);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings)) {
            JdbcConnectionPoolRegistry.ConnectionFactory factory = () -> validationBlockingOnceConnection(
                openH2(url, physicalOpens),
                blockNextValidation,
                validationStarted,
                releaseValidation
            );
            JdbcConnectionPoolRegistry.Lease first = registry.borrow("parallel-validation", factory);
            first.close();
            Thread.sleep(600L);

            blockNextValidation.set(true);
            Future<JdbcConnectionPoolRegistry.Lease> blocked = worker.submit(
                () -> registry.borrow("parallel-validation", factory)
            );
            assertTrue(validationStarted.await(1, TimeUnit.SECONDS));
            long metadataStartedAt = System.nanoTime();
            try (JdbcConnectionPoolRegistry.Lease metadata = registry.borrow(
                "parallel-validation",
                JdbcSessionRole.METADATA,
                factory
            )) {
                long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - metadataStartedAt);
                assertTrue(elapsedMillis < 400L, () -> "metadata checkout took " + elapsedMillis + "ms");
                assertTrue(metadata.connection().isValid(1));
            }
            AgentRpcError timeout = futureFailure(blocked, AgentRpcError.class, 2, TimeUnit.SECONDS);
            JsonObject timeoutData = AgentRpcError.toJson(timeout, AgentProtocol.METHOD_OPEN_SESSION, "blocked")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", timeoutData.get("sessionDisposition").getAsString());

            AgentRpcError retry = assertThrows(
                AgentRpcError.class,
                () -> registry.borrow("parallel-validation", factory)
            );
            JsonObject retryData = AgentRpcError.toJson(retry, AgentProtocol.METHOD_OPEN_SESSION, "retry")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", retryData.get("sessionDisposition").getAsString());
        } finally {
            releaseValidation.countDown();
            worker.shutdownNow();
        }
    }

    @RepeatedTest(5)
    void deterministicHikariSetupFailureDoesNotPoisonIdentity() throws Exception {
        AtomicBoolean failSetup = new AtomicBoolean(true);
        AtomicInteger physicalOpens = new AtomicInteger();
        String url = h2Url("setup_failure");
        try (Connection ignored = openH2(url, physicalOpens)) {
            // Keep H2 bootstrap outside the setup classification watchdog.
        }
        physicalOpens.set(0);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(shortTimeoutPoolSettings(1, 32))) {
            SQLException setupFailure = assertThrows(SQLException.class, () -> registry.borrow(
                "setup-failure",
                () -> setupFailingConnection(openH2(url, physicalOpens), failSetup)
            ));
            JsonObject setupData = AgentRpcError.toJson(
                setupFailure,
                AgentProtocol.METHOD_OPEN_SESSION,
                "setup-failure"
            ).getAsJsonObject("data");
            assertEquals("keep", setupData.get("sessionDisposition").getAsString());

            failSetup.set(false);
            try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                "setup-failure",
                () -> setupFailingConnection(openH2(url, physicalOpens), failSetup)
            )) {
                assertTrue(physicalOpens.get() >= 2);
            }
        }
    }

    @RepeatedTest(5)
    void unsupportedNetworkTimeoutDoesNotPoisonIdentity() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        String url = h2Url("unsupported_network_timeout");
        try (Connection ignored = openH2(url, physicalOpens)) {
            // Keep H2 bootstrap outside the setup classification watchdog.
        }
        physicalOpens.set(0);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(shortTimeoutPoolSettings(1, 32))) {
            for (int attempt = 0; attempt < 2; attempt++) {
                try (JdbcConnectionPoolRegistry.Lease lease = registry.borrow(
                    "unsupported-network-timeout",
                    () -> unsupportedNetworkTimeoutConnection(openH2(url, physicalOpens))
                )) {
                    assertTrue(lease.connection().isValid(1));
                }
            }
            assertEquals(1, physicalOpens.get());
        }
    }

    @Test
    void blockedSetupAfterKnownFailurePoisonsCurrentAttemptGeneration() throws Exception {
        AtomicInteger connectionAttempts = new AtomicInteger();
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicBoolean failFirstSetup = new AtomicBoolean(true);
        CountDownLatch setupStarted = new CountDownLatch(1);
        CountDownLatch releaseSetup = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        String url = h2Url("known_then_blocked_setup");
        try (Connection ignored = openH2(url, physicalOpens)) {
            // Keep H2 bootstrap outside the setup generation watchdog.
        }
        physicalOpens.set(0);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(shortTimeoutPoolSettings(1, 32))) {
            JdbcConnectionPoolRegistry.ConnectionFactory factory = () -> {
                Connection connection = openH2(url, physicalOpens);
                if (connectionAttempts.getAndIncrement() == 0) {
                    return setupFailingConnection(connection, failFirstSetup);
                }
                return setupBlockingConnection(connection, setupStarted, releaseSetup);
            };
            Future<JdbcConnectionPoolRegistry.Lease> blocked = worker.submit(
                () -> registry.borrow("known-then-blocked-setup", factory)
            );
            assertTrue(setupStarted.await(1, TimeUnit.SECONDS));

            AgentRpcError timeout = futureFailure(blocked, AgentRpcError.class, 2, TimeUnit.SECONDS);
            JsonObject data = AgentRpcError.toJson(timeout, AgentProtocol.METHOD_OPEN_SESSION, "blocked")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", data.get("sessionDisposition").getAsString());

            AgentRpcError retry = assertThrows(
                AgentRpcError.class,
                () -> registry.borrow("known-then-blocked-setup", factory)
            );
            JsonObject retryData = AgentRpcError.toJson(retry, AgentProtocol.METHOD_OPEN_SESSION, "retry")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", retryData.get("sessionDisposition").getAsString());
        } finally {
            releaseSetup.countDown();
            worker.shutdownNow();
        }
    }

    @Test
    void blockedHikariSetupPoisonsIdentityWithinBorrowDeadline() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        CountDownLatch setupStarted = new CountDownLatch(1);
        CountDownLatch releaseSetup = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        String url = h2Url("blocked_setup");
        try (Connection ignored = openH2(url, physicalOpens)) {
            // Keep H2 bootstrap outside the 250ms setup watchdog exercised below.
        }
        physicalOpens.set(0);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(shortTimeoutPoolSettings(1, 32))) {
            long startedAtNanos = System.nanoTime();
            Future<JdbcConnectionPoolRegistry.Lease> blocked = worker.submit(() -> registry.borrow(
                "blocked-setup",
                () -> setupBlockingConnection(
                    openH2(url, physicalOpens),
                    setupStarted,
                    releaseSetup
                )
            ));
            assertTrue(setupStarted.await(1, TimeUnit.SECONDS));
            AgentRpcError timeout = futureFailure(blocked, AgentRpcError.class, 2, TimeUnit.SECONDS);
            long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);
            assertTrue(elapsedMillis < 450L, () -> "blocked setup took " + elapsedMillis + "ms");
            JsonObject data = AgentRpcError.toJson(timeout, AgentProtocol.METHOD_OPEN_SESSION, "blocked-setup")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", data.get("sessionDisposition").getAsString());

            AgentRpcError retry = assertThrows(
                AgentRpcError.class,
                () -> registry.borrow("blocked-setup", () -> openH2(url, physicalOpens))
            );
            JsonObject retryData = AgentRpcError.toJson(retry, AgentProtocol.METHOD_OPEN_SESSION, "retry")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", retryData.get("sessionDisposition").getAsString());
        } finally {
            releaseSetup.countDown();
            worker.shutdownNow();
        }
    }

    @Test
    void poolRetirementDoesNotOutliveBorrowDeadline() throws Exception {
        AtomicBoolean blockShutdown = new AtomicBoolean();
        AtomicInteger physicalOpens = new AtomicInteger();
        CountDownLatch shutdownStarted = new CountDownLatch(1);
        CountDownLatch releaseShutdown = new CountDownLatch(1);
        JdbcConnectionPoolRegistry.PoolSettings settings = new JdbcConnectionPoolRegistry.PoolSettings(
            true,
            1,
            0,
            250L,
            250L,
            10_000L,
            30_000L,
            0L,
            0,
            32,
            2
        );
        JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings);
        try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
            "retired-pool",
            () -> closeBlockingConnection(
                openH2(h2Url("blocked_pool_close"), physicalOpens),
                blockShutdown,
                shutdownStarted,
                releaseShutdown
            )
        )) {
            assertEquals(1, physicalOpens.get());
        }
        try {
            blockShutdown.set(true);
            long startedAtNanos = System.nanoTime();
            registry.retireUnusedPools();
            assertTrue(shutdownStarted.await(1, TimeUnit.SECONDS));
            long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);
            assertTrue(elapsedMillis < 450L, () -> "pool retirement took " + elapsedMillis + "ms");
            AgentRpcError error = assertThrows(AgentRpcError.class, () -> registry.borrow(
                "different-identity",
                () -> openH2(h2Url("different_identity"), physicalOpens)
            ));
            JsonObject data = AgentRpcError.toJson(error, AgentProtocol.METHOD_OPEN_SESSION, "pool-close")
                .getAsJsonObject("data");
            assertEquals("replace_runtime", data.get("sessionDisposition").getAsString());
        } finally {
            releaseShutdown.countDown();
            registry.close();
        }
    }

    @Test
    void onlyCausalPhysicalConnectionFailuresRequireRuntimeReplacement() {
        assertFalse(JdbcConnectionPoolRegistry.requiresRuntimeReplacement(new SQLException("authentication failed")));
        assertTrue(JdbcConnectionPoolRegistry.requiresRuntimeReplacement(
            new JdbcConnectionPoolRegistry.PhysicalConnectionStateUnknownException(new SQLException("connect stuck"))
        ));
    }

    @Test
    void registryRetiresOnlyUnusedPools() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        String url = h2Url("registry_retire");
        JdbcConnectionPoolRegistry.PoolSettings settings = new JdbcConnectionPoolRegistry.PoolSettings(
            1,
            0,
            2_000L,
            1_000L,
            10_000L,
            30_000L,
            0L
        );
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings)) {
            JdbcConnectionPoolRegistry.Lease lease = registry.borrow(
                "retired-identity",
                () -> openH2(url, physicalOpens)
            );
            registry.retireUnusedPools();
            assertEquals(1, registry.poolCount());

            lease.close();
            registry.retireUnusedPools();
            assertEquals(0, registry.poolCount());

            try (JdbcConnectionPoolRegistry.Lease ignored = registry.borrow(
                "retired-identity",
                () -> openH2(url, physicalOpens)
            )) {
            }
            assertEquals(2, physicalOpens.get());
        }
    }

    @Test
    void ordinaryMultiSessionRequestsReuseOnePhysicalConnection() {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        String url = h2Url("multi_reuse");
        try (MultiSessionJsonRpcServer server = server(url, physicalOpens, 4)) {
            for (int index = 0; index < 25; index++) {
                String sessionId = "session-" + index;
                openSession(server, requestIds, sessionId);
                JsonObject result = query(server, requestIds, sessionId, "SELECT 1", null);
                assertEquals(1, result.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsInt());
                closeSession(server, requestIds, sessionId);
            }
            assertEquals(1, physicalOpens.get());
        }
    }

    @Test
    void poolingCanBeDisabledForDriverCompatibility() {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        String url = h2Url("pool_disabled");
        JdbcConnectionPoolRegistry.PoolSettings disabled = new JdbcConnectionPoolRegistry.PoolSettings(
            false,
            4,
            0,
            2_000L,
            1_000L,
            10_000L,
            30_000L,
            60_000L
        );
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> new H2TestAgent(url, physicalOpens),
            disabled
        )) {
            openSession(server, requestIds, "legacy-a");
            openSession(server, requestIds, "legacy-b");
            assertEquals(2, physicalOpens.get());
        }
    }

    @Test
    void pagedCursorPinsConnectionUntilItIsClosed() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        String url = h2Url("cursor_pin");
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (MultiSessionJsonRpcServer server = server(url, physicalOpens, 1)) {
            openSession(server, requestIds, "cursor-owner");
            openSession(server, requestIds, "waiting-session");

            JsonObject pageParams = sessionParams("cursor-owner");
            pageParams.addProperty("sql", "SELECT X FROM SYSTEM_RANGE(1, 3)");
            pageParams.addProperty("pageSize", 1);
            JsonObject firstPage = result(request(
                server,
                requestIds,
                AgentProtocol.METHOD_EXECUTE_QUERY_PAGE,
                pageParams
            ));
            assertTrue(firstPage.get("has_more").getAsBoolean());
            String querySessionId = firstPage.get("session_id").getAsString();

            Future<JsonObject> waiting = worker.submit(
                () -> query(server, requestIds, "waiting-session", "SELECT 2", null)
            );
            Thread.sleep(200L);
            assertFalse(waiting.isDone());
            assertEquals(1, physicalOpens.get());

            JsonObject closeParams = sessionParams("cursor-owner");
            closeParams.addProperty("sessionId", querySessionId);
            assertTrue(request(
                server,
                requestIds,
                AgentProtocol.METHOD_CLOSE_QUERY_SESSION,
                closeParams
            ).get("result").getAsBoolean());

            assertEquals(
                2,
                waiting.get(2, TimeUnit.SECONDS)
                    .getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsInt()
            );
            assertEquals(1, physicalOpens.get());
        } finally {
            worker.shutdownNow();
        }
    }

    @Test
    void validationSkipsBusySharedPoolWithoutWaiting() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        String url = h2Url("busy_validation");
        try (MultiSessionJsonRpcServer server = server(url, physicalOpens, 1)) {
            openSession(server, requestIds, "cursor-owner");
            openSession(server, requestIds, "validation-session");

            JsonObject pageParams = sessionParams("cursor-owner");
            pageParams.addProperty("sql", "SELECT X FROM SYSTEM_RANGE(1, 3)");
            pageParams.addProperty("pageSize", 1);
            JsonObject firstPage = result(request(
                server,
                requestIds,
                AgentProtocol.METHOD_EXECUTE_QUERY_PAGE,
                pageParams
            ));
            assertTrue(firstPage.get("has_more").getAsBoolean());
            String querySessionId = firstPage.get("session_id").getAsString();

            long startedAtNanos = System.nanoTime();
            JsonObject validation = result(request(
                server,
                requestIds,
                AgentProtocol.METHOD_VALIDATE_SESSION,
                sessionParams("validation-session")
            ));
            long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);
            assertTrue(elapsedMillis < 200L, () -> "busy validation took " + elapsedMillis + "ms");
            assertTrue(validation.get("ok").getAsBoolean());
            assertEquals(1, physicalOpens.get());

            JsonObject closeParams = sessionParams("cursor-owner");
            closeParams.addProperty("sessionId", querySessionId);
            assertTrue(request(
                server,
                requestIds,
                AgentProtocol.METHOD_CLOSE_QUERY_SESSION,
                closeParams
            ).get("result").getAsBoolean());
            assertEquals(
                2,
                query(server, requestIds, "validation-session", "SELECT 2", null)
                    .getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsInt()
            );
        }
    }

    @Test
    void maintenanceExpiresAbandonedCursorAndReturnsItsConnection() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        String url = h2Url("cursor_expire");
        try (MultiSessionJsonRpcServer server = server(url, physicalOpens, 1)) {
            openSession(server, requestIds, "abandoned-cursor");
            openSession(server, requestIds, "next-session");

            JsonObject pageParams = sessionParams("abandoned-cursor");
            pageParams.addProperty("sql", "SELECT X FROM SYSTEM_RANGE(1, 3)");
            pageParams.addProperty("pageSize", 1);
            JsonObject firstPage = result(request(
                server,
                requestIds,
                AgentProtocol.METHOD_EXECUTE_QUERY_PAGE,
                pageParams
            ));
            assertTrue(firstPage.get("has_more").getAsBoolean());

            server.runMaintenance(System.currentTimeMillis() + 1_000L, 0L);
            JsonObject result = query(server, requestIds, "next-session", "SELECT 9", null);

            assertEquals(9, result.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsInt());
            assertEquals(1, physicalOpens.get());
        }
    }

    @Test
    void maintenanceSkipsBusySessionWithoutWaiting() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        CountDownLatch requestStarted = new CountDownLatch(1);
        CountDownLatch releaseRequest = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        String url = h2Url("maintenance_busy_session");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> new H2TestAgent(url, physicalOpens) {
                @Override
                public List<DatabaseInfo> listDatabases() {
                    requestStarted.countDown();
                    try {
                        releaseRequest.await();
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new RuntimeException(error);
                    }
                    return Collections.emptyList();
                }
            },
            poolSettings(2)
        )) {
            openSession(server, requestIds, "busy-session");
            Future<JsonObject> busyRequest = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("busy-session")
            ));
            assertTrue(requestStarted.await(2, TimeUnit.SECONDS));

            Future<?> maintenance = workers.submit(() -> server.runMaintenance());
            maintenance.get(500, TimeUnit.MILLISECONDS);
            assertFalse(busyRequest.isDone());

            releaseRequest.countDown();
            busyRequest.get(2, TimeUnit.SECONDS);
        } finally {
            releaseRequest.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void closingBusySessionDetachesImmediatelyAndPoisonsItsLease() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger physicalCloses = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        AtomicBoolean blockNextMetadataCall = new AtomicBoolean(true);
        CountDownLatch requestStarted = new CountDownLatch(1);
        CountDownLatch releaseRequest = new CountDownLatch(1);
        ExecutorService workers = Executors.newSingleThreadExecutor();
        String url = h2Url("quarantine_busy_session");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> new H2TestAgent(url, physicalOpens) {
                @Override
                protected Connection openConnection(ConnectParams params) throws Exception {
                    return trackedConnection(openH2(url, physicalOpens), physicalCloses);
                }

                @Override
                public List<DatabaseInfo> listDatabases() {
                    if (blockNextMetadataCall.compareAndSet(true, false)) {
                        requestStarted.countDown();
                        awaitUninterruptibly(releaseRequest);
                    }
                    return Collections.emptyList();
                }
            },
            poolSettings(2)
        )) {
            openSession(server, requestIds, "blocked");
            Future<JsonObject> blocked = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("blocked")
            ));
            assertTrue(requestStarted.await(2, TimeUnit.SECONDS));

            long closeStarted = System.currentTimeMillis();
            closeSession(server, requestIds, "blocked");
            assertTrue(System.currentTimeMillis() - closeStarted < 500L);

            JsonObject staleResponse = rawRequest(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("blocked")
            );
            assertTrue(staleResponse.has("error"), staleResponse::toString);

            openSession(server, requestIds, "replacement");
            JsonObject replacement = query(server, requestIds, "replacement", "SELECT 1", null);
            assertEquals(1, replacement.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsInt());
            assertEquals(2, physicalOpens.get());

            releaseRequest.countDown();
            blocked.get(2, TimeUnit.SECONDS);
            awaitCount(physicalCloses, 1);
        } finally {
            releaseRequest.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void closingIdlePinnedSingleConnectionSessionDoesNotRequireRuntimeReplacement() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        String url = h2Url("pinned_single_close");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> new H2TestAgent(url, physicalOpens),
            poolSettings(1, 0, 32, 2)
        )) {
            openSession(server, requestIds, "pinned");
            query(server, requestIds, "pinned", "SET SCHEMA PUBLIC", null);

            JsonObject response = rawRequest(
                server,
                requestIds,
                AgentProtocol.METHOD_CLOSE_SESSION,
                sessionParams("pinned")
            );

            assertTrue(response.has("result"), response::toString);
            openSession(server, requestIds, "replacement");
            JsonObject result = query(server, requestIds, "replacement", "SELECT 1", null);
            assertEquals(1, result.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsInt());
        }
    }

    @Test
    void blockedPinnedConnectionClosePoisonsIdentityForNextSession() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        AtomicBoolean blockClose = new AtomicBoolean();
        CountDownLatch closeStarted = new CountDownLatch(1);
        CountDownLatch releaseClose = new CountDownLatch(1);
        String url = h2Url("pinned_blocked_close");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> new H2TestAgent(url, physicalOpens) {
                @Override
                protected Connection openConnection(ConnectParams params) throws Exception {
                    return closeBlockingConnection(
                        openH2(url, physicalOpens),
                        blockClose,
                        closeStarted,
                        releaseClose
                    );
                }
            },
            shortTimeoutPoolSettings(1, 32)
        )) {
            openSession(server, requestIds, "pinned");
            query(server, requestIds, "pinned", "SET SCHEMA PUBLIC", null);
            blockClose.set(true);

            JsonObject close = rawRequest(
                server,
                requestIds,
                AgentProtocol.METHOD_CLOSE_SESSION,
                sessionParams("pinned")
            );
            assertTrue(close.has("result"), close::toString);
            assertTrue(closeStarted.await(1, TimeUnit.SECONDS));
            Thread.sleep(400L);

            JsonObject replacementParams = sessionParams("replacement");
            replacementParams.addProperty("database", "pooling");
            replacementParams.addProperty("username", "sa");
            replacementParams.addProperty("password", "");
            JsonObject retry = rawRequest(
                server,
                requestIds,
                AgentProtocol.METHOD_OPEN_SESSION,
                replacementParams
            );
            assertTrue(retry.has("error"), retry::toString);
            JsonObject data = retry.getAsJsonObject("error").getAsJsonObject("data");
            assertEquals("replace_runtime", data.get("sessionDisposition").getAsString());
        } finally {
            releaseClose.countDown();
        }
    }

    @Test
    void closingSessionDoesNotWaitForAnotherRequestBlockedOnPoolCheckout() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger agentIndexes = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        CountDownLatch holderStarted = new CountDownLatch(1);
        CountDownLatch releaseHolder = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        String url = h2Url("quarantine_checkout_wait");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> {
                int agentIndex = agentIndexes.incrementAndGet();
                return new H2TestAgent(url, physicalOpens) {
                    @Override
                    public List<DatabaseInfo> listDatabases() {
                        if (agentIndex == 1) {
                            holderStarted.countDown();
                            awaitUninterruptibly(releaseHolder);
                        }
                        return Collections.emptyList();
                    }
                };
            },
            poolSettings(1, 0, 32, 1)
        )) {
            openSession(server, requestIds, "holder");
            openSession(server, requestIds, "waiting");
            Future<JsonObject> holder = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("holder")
            ));
            assertTrue(holderStarted.await(2, TimeUnit.SECONDS));
            Future<JsonObject> waiting = workers.submit(() -> rawRequest(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("waiting")
            ));
            Thread.sleep(100L);

            long closeStarted = System.nanoTime();
            closeSession(server, requestIds, "waiting");
            long closeElapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - closeStarted);
            assertTrue(closeElapsedMillis < 500L, () -> "close waited " + closeElapsedMillis + "ms");

            releaseHolder.countDown();
            holder.get(2, TimeUnit.SECONDS);
            assertTrue(waiting.get(2, TimeUnit.SECONDS).has("error"));
        } finally {
            releaseHolder.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void workloadPermitTimeoutKeepsSessionAndRuntimeRoutable() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger agentIndexes = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        CountDownLatch holderStarted = new CountDownLatch(1);
        CountDownLatch releaseHolder = new CountDownLatch(1);
        ExecutorService workers = Executors.newSingleThreadExecutor();
        String url = h2Url("workload_backpressure");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> {
                int agentIndex = agentIndexes.incrementAndGet();
                return new H2TestAgent(url, physicalOpens) {
                    @Override
                    public List<DatabaseInfo> listDatabases() {
                        if (agentIndex == 1) {
                            holderStarted.countDown();
                            awaitUninterruptibly(releaseHolder);
                        }
                        return Collections.emptyList();
                    }
                };
            },
            shortTimeoutPoolSettings(1, 32)
        )) {
            openSession(server, requestIds, "holder");
            openSession(server, requestIds, "waiting");
            Future<JsonObject> holder = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("holder")
            ));
            assertTrue(holderStarted.await(2, TimeUnit.SECONDS));

            JsonObject saturated = rawRequest(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("waiting")
            );
            JsonObject data = saturated.getAsJsonObject("error").getAsJsonObject("data");
            assertEquals("resource", data.get("category").getAsString());
            assertTrue(data.get("retryable").getAsBoolean());
            assertEquals("keep", data.get("sessionDisposition").getAsString());

            releaseHolder.countDown();
            holder.get(2, TimeUnit.SECONDS);
            JsonObject recovered = request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("waiting")
            );
            assertTrue(recovered.getAsJsonArray("result").isEmpty());
        } finally {
            releaseHolder.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void requestExecutorBackpressureKeepsExistingSessionsAndRuntimeRoutable() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger agentIndexes = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        CountDownLatch holderStarted = new CountDownLatch(1);
        CountDownLatch releaseHolder = new CountDownLatch(1);
        BlockingQueue<JsonObject> responses = new LinkedBlockingQueue<>();
        String url = h2Url("request_executor_backpressure");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> {
                int agentIndex = agentIndexes.incrementAndGet();
                return new H2TestAgent(url, physicalOpens) {
                    @Override
                    public List<DatabaseInfo> listDatabases() {
                        if (agentIndex == 1) {
                            holderStarted.countDown();
                            awaitUninterruptibly(releaseHolder);
                        }
                        return Collections.emptyList();
                    }
                };
            },
            poolSettings(2),
            new MultiSessionJsonRpcServer.RuntimeLimits(1, 1)
        )) {
            openSession(server, requestIds, "holder");
            openSession(server, requestIds, "waiting");

            int holderRequestId = requestIds.incrementAndGet();
            server.executeRequest(
                jsonRpcRequest(holderRequestId, AgentProtocol.METHOD_LIST_DATABASES, sessionParams("holder")),
                responses::add
            );
            assertTrue(holderStarted.await(2, TimeUnit.SECONDS));

            int waitingRequestId = requestIds.incrementAndGet();
            server.executeRequest(
                jsonRpcRequest(waitingRequestId, AgentProtocol.METHOD_LIST_DATABASES, sessionParams("waiting")),
                responses::add
            );
            JsonObject saturated = responses.poll(2, TimeUnit.SECONDS);
            assertNotNull(saturated);
            assertEquals(waitingRequestId, saturated.get("id").getAsInt());
            JsonObject data = saturated.getAsJsonObject("error").getAsJsonObject("data");
            assertEquals("resource", data.get("category").getAsString());
            assertTrue(data.get("retryable").getAsBoolean());
            assertEquals("keep", data.get("sessionDisposition").getAsString());

            releaseHolder.countDown();
            JsonObject holder = responses.poll(2, TimeUnit.SECONDS);
            assertNotNull(holder);
            assertEquals(holderRequestId, holder.get("id").getAsInt());
            assertFalse(holder.has("error"), () -> holder.toString());

            request(server, requestIds, AgentProtocol.METHOD_LIST_DATABASES, sessionParams("holder"));
            request(server, requestIds, AgentProtocol.METHOD_LIST_DATABASES, sessionParams("waiting"));
            assertEquals(2, agentIndexes.get());
        } finally {
            releaseHolder.countDown();
        }
    }

    @Test
    void idleAffinityLeaseDoesNotCountAsQuarantinedOperation() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        String url = h2Url("idle_affinity_quarantine");
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(poolSettings(4, 0, 32, 2))) {
            for (int index = 0; index < 2; index++) {
                H2TestAgent agent = new H2TestAgent(url, physicalOpens);
                agent.attachConnectionPoolRegistry(registry);
                JsonRpcServer server = new JsonRpcServer(agent);
                JsonObject connectParams = new JsonObject();
                connectParams.addProperty("database", "pooling");
                connectParams.addProperty("username", "sa");
                connectParams.addProperty("password", "");
                server.dispatchForRuntime(AgentProtocol.METHOD_CONNECT, connectParams);

                JsonObject queryParams = new JsonObject();
                queryParams.addProperty("sql", "SET SCHEMA PUBLIC");
                server.dispatchForRuntime(AgentProtocol.METHOD_EXECUTE_QUERY, queryParams);

                assertFalse(server.quarantine());
                server.dispatchForRuntime(AgentProtocol.METHOD_DISCONNECT, new JsonObject());
            }
        }
    }

    @Test
    void cleanupSaturationReturnsStructuredRuntimeReplacementError() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        CountDownLatch requestsStarted = new CountDownLatch(2);
        CountDownLatch releaseRequests = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        String url = h2Url("cleanup_saturation");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> new H2TestAgent(url, physicalOpens) {
                @Override
                public List<DatabaseInfo> listDatabases() {
                    requestsStarted.countDown();
                    awaitUninterruptibly(releaseRequests);
                    return Collections.emptyList();
                }
            },
            poolSettings(2, 0, 32, 8),
            new MultiSessionJsonRpcServer.RuntimeLimits(4, 1)
        )) {
            openSession(server, requestIds, "first");
            openSession(server, requestIds, "second");
            Future<JsonObject> first = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("first")
            ));
            Future<JsonObject> second = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("second")
            ));
            assertTrue(requestsStarted.await(2, TimeUnit.SECONDS));

            closeSession(server, requestIds, "first");
            JsonObject saturated = rawRequest(
                server,
                requestIds,
                AgentProtocol.METHOD_CLOSE_SESSION,
                sessionParams("second")
            );
            JsonObject data = saturated.getAsJsonObject("error").getAsJsonObject("data");
            assertEquals("resource", data.get("category").getAsString());
            assertEquals("replace_runtime", data.get("sessionDisposition").getAsString());

            releaseRequests.countDown();
            first.get(2, TimeUnit.SECONDS);
            second.get(2, TimeUnit.SECONDS);
        } finally {
            releaseRequests.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void quarantineThresholdReturnsStructuredRuntimeReplacementError() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        CountDownLatch requestsStarted = new CountDownLatch(2);
        CountDownLatch releaseRequests = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        String url = h2Url("quarantine_runtime_replacement");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> new H2TestAgent(url, physicalOpens) {
                @Override
                public List<DatabaseInfo> listDatabases() {
                    requestsStarted.countDown();
                    awaitUninterruptibly(releaseRequests);
                    return Collections.emptyList();
                }
            },
            poolSettings(4, 0, 32, 2),
            new MultiSessionJsonRpcServer.RuntimeLimits(4, 2)
        )) {
            openSession(server, requestIds, "first");
            openSession(server, requestIds, "second");
            Future<JsonObject> first = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("first")
            ));
            Future<JsonObject> second = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("second")
            ));
            assertTrue(requestsStarted.await(2, TimeUnit.SECONDS));

            closeSession(server, requestIds, "first");
            JsonObject threshold = rawRequest(
                server,
                requestIds,
                AgentProtocol.METHOD_CLOSE_SESSION,
                sessionParams("second")
            );
            JsonObject data = threshold.getAsJsonObject("error").getAsJsonObject("data");
            assertEquals("resource", data.get("category").getAsString());
            assertEquals("replace_runtime", data.get("sessionDisposition").getAsString());

            releaseRequests.countDown();
            first.get(2, TimeUnit.SECONDS);
            second.get(2, TimeUnit.SECONDS);
        } finally {
            releaseRequests.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void jdbcConnectionErrorsCarryStructuredQuarantineData() {
        JsonObject error = AgentRpcError.toJson(
            new RuntimeException(new SQLException("connection lost", "08006")),
            AgentProtocol.METHOD_EXECUTE_QUERY,
            "session-1"
        );
        JsonObject data = error.getAsJsonObject("data");
        assertEquals("connection", data.get("category").getAsString());
        assertFalse(data.get("retryable").getAsBoolean());
        assertEquals("quarantine", data.get("sessionDisposition").getAsString());
        assertEquals("session-1", data.get("agentSessionId").getAsString());
    }

    @Test
    void jdbcConnectErrorsRemainRetryableAfterRuntimeRecovery() {
        JsonObject error = AgentRpcError.toJson(
            new RuntimeException(new SQLException("connection refused", "08001")),
            AgentProtocol.METHOD_OPEN_SESSION,
            "session-1"
        );

        assertTrue(error.getAsJsonObject("data").get("retryable").getAsBoolean());
    }

    @Test
    void independentSessionsExecuteConcurrentlyThroughSharedPool() throws Exception {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        CountDownLatch bothRequestsStarted = new CountDownLatch(2);
        CountDownLatch releaseRequests = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        String url = h2Url("independent_sessions");
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(
            () -> new H2TestAgent(url, physicalOpens) {
                @Override
                public List<DatabaseInfo> listDatabases() {
                    bothRequestsStarted.countDown();
                    try {
                        releaseRequests.await();
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new RuntimeException(error);
                    }
                    return Collections.emptyList();
                }
            },
            poolSettings(2)
        )) {
            openSession(server, requestIds, "metadata-a");
            openSession(server, requestIds, "metadata-b");

            Future<JsonObject> first = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("metadata-a")
            ));
            Future<JsonObject> second = workers.submit(() -> request(
                server,
                requestIds,
                AgentProtocol.METHOD_LIST_DATABASES,
                sessionParams("metadata-b")
            ));

            assertTrue(bothRequestsStarted.await(2, TimeUnit.SECONDS));
            assertFalse(first.isDone());
            assertFalse(second.isDone());
            assertEquals(2, physicalOpens.get());

            releaseRequests.countDown();
            first.get(2, TimeUnit.SECONDS);
            second.get(2, TimeUnit.SECONDS);
        } finally {
            releaseRequests.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void statefulSqlKeepsSessionAffinityAndEvictsOnClose() {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        String url = h2Url("stateful_evict");
        try (MultiSessionJsonRpcServer server = server(url, physicalOpens, 2)) {
            openSession(server, requestIds, "stateful");
            query(server, requestIds, "stateful", "CREATE LOCAL TEMPORARY TABLE TEMP_SESSION(ID INT)", null);
            query(server, requestIds, "stateful", "INSERT INTO TEMP_SESSION VALUES (7)", null);
            JsonObject sameSession = query(server, requestIds, "stateful", "SELECT ID FROM TEMP_SESSION", null);
            assertEquals(7, sameSession.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsInt());
            closeSession(server, requestIds, "stateful");

            openSession(server, requestIds, "fresh");
            JsonObject freshSession = query(
                server,
                requestIds,
                "fresh",
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'TEMP_SESSION'",
                null
            );
            assertEquals(0, freshSession.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsInt());
            assertEquals(2, physicalOpens.get());
        }
    }

    @Test
    void schemaContextDoesNotLeakAcrossLogicalSessions() {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        String url = h2Url("schema_reset");
        try (MultiSessionJsonRpcServer server = server(url, physicalOpens, 2)) {
            openSession(server, requestIds, "schema-owner");
            query(server, requestIds, "schema-owner", "CREATE SCHEMA IF NOT EXISTS APP", null);
            JsonObject appResult = query(server, requestIds, "schema-owner", "SELECT CURRENT_SCHEMA", "APP");
            assertEquals("APP", appResult.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsString());
            closeSession(server, requestIds, "schema-owner");

            openSession(server, requestIds, "fresh-schema");
            JsonObject publicResult = query(server, requestIds, "fresh-schema", "SELECT CURRENT_SCHEMA", null);
            assertEquals("PUBLIC", publicResult.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsString());
            assertEquals(1, physicalOpens.get());
        }
    }

    @Test
    void explicitSessionSchemaIsPreservedUntilStatefulSessionCloses() {
        AtomicInteger physicalOpens = new AtomicInteger();
        AtomicInteger requestIds = new AtomicInteger();
        String url = h2Url("stateful_schema");
        try (MultiSessionJsonRpcServer server = server(url, physicalOpens, 2)) {
            openSession(server, requestIds, "stateful-schema");
            query(server, requestIds, "stateful-schema", "CREATE SCHEMA IF NOT EXISTS APP", null);
            query(server, requestIds, "stateful-schema", "CREATE SCHEMA IF NOT EXISTS OTHER", null);
            query(server, requestIds, "stateful-schema", "SET SCHEMA OTHER", "APP");

            JsonObject retained = query(server, requestIds, "stateful-schema", "SELECT CURRENT_SCHEMA", null);
            assertEquals("OTHER", retained.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsString());
            closeSession(server, requestIds, "stateful-schema");

            openSession(server, requestIds, "fresh-after-stateful");
            JsonObject fresh = query(server, requestIds, "fresh-after-stateful", "SELECT CURRENT_SCHEMA", null);
            assertEquals("PUBLIC", fresh.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsString());
            assertEquals(2, physicalOpens.get());
        }
    }

    @Test
    void affinityDetectionCoversCommonSessionStateStatements() {
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("SET search_path TO app"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("-- comment\nUSE sales"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("CREATE TEMPORARY TABLE t(id int)"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("CREATE TABLE #session_rows(id int)"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("SELECT * INTO #session_rows FROM users"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity(
            "WITH source_rows AS (SELECT * FROM users) SELECT * INTO #session_rows FROM source_rows"
        ));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity(
            "WITH source_rows AS (SELECT * FROM users) SELECT * INTO [#session_rows] FROM source_rows"
        ));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("CREATE MULTISET VOLATILE TABLE vt(id int)"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("DATABASE analytics"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("UNSET current_namespace"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("ADD JAR '/tmp/session-udf.jar'"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("SELECT 1; /* switch */ SET ROLE app_user"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("SELECT 1; # switch\nSET sql_mode = 'ANSI'"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("/*M!100100 SET @OLD_TIME_ZONE=@@TIME_ZONE */"));
        assertTrue(JdbcConnectionAffinity.requiresSessionAffinity("SELECT GET_LOCK('dbx', 5)"));
        assertFalse(JdbcConnectionAffinity.requiresSessionAffinity("SELECT * FROM users"));
        assertFalse(JdbcConnectionAffinity.requiresSessionAffinity("CREATE TABLE users(id int)"));
        assertFalse(JdbcConnectionAffinity.requiresSessionAffinity("SELECT 'SET ROLE app_user; CREATE TEMP TABLE t(id int)'"));
        assertFalse(JdbcConnectionAffinity.requiresSessionAffinity("SELECT $$SET ROLE app_user$$"));
        assertFalse(JdbcConnectionAffinity.requiresSessionAffinity("SELECT '# SET ROLE app_user'"));
        assertFalse(JdbcConnectionAffinity.requiresSessionAffinity("SELECT '#session_rows'"));
        assertFalse(JdbcConnectionAffinity.requiresSessionAffinity("SELECT payload #>> '{path}' FROM events"));
    }

    private static MultiSessionJsonRpcServer server(String url, AtomicInteger physicalOpens, int maximumPoolSize) {
        return new MultiSessionJsonRpcServer(
            () -> new H2TestAgent(url, physicalOpens),
            poolSettings(maximumPoolSize)
        );
    }

    private static void openSession(
        MultiSessionJsonRpcServer server,
        AtomicInteger requestIds,
        String sessionId
    ) {
        JsonObject params = sessionParams(sessionId);
        params.addProperty("database", "pooling");
        params.addProperty("username", "sa");
        params.addProperty("password", "");
        result(request(server, requestIds, AgentProtocol.METHOD_OPEN_SESSION, params));
    }

    private static void closeSession(
        MultiSessionJsonRpcServer server,
        AtomicInteger requestIds,
        String sessionId
    ) {
        result(request(
            server,
            requestIds,
            AgentProtocol.METHOD_CLOSE_SESSION,
            sessionParams(sessionId)
        ));
    }

    private static JsonObject query(
        MultiSessionJsonRpcServer server,
        AtomicInteger requestIds,
        String sessionId,
        String sql,
        String schema
    ) {
        JsonObject params = sessionParams(sessionId);
        params.addProperty("sql", sql);
        if (schema != null) {
            params.addProperty("schema", schema);
        }
        return result(request(server, requestIds, AgentProtocol.METHOD_EXECUTE_QUERY, params));
    }

    private static JsonObject request(
        MultiSessionJsonRpcServer server,
        AtomicInteger requestIds,
        String method,
        JsonObject params
    ) {
        JsonObject response = rawRequest(server, requestIds, method, params);
        assertFalse(response.has("error"), () -> response.toString());
        return response;
    }

    private static JsonObject rawRequest(
        MultiSessionJsonRpcServer server,
        AtomicInteger requestIds,
        String method,
        JsonObject params
    ) {
        JsonObject request = jsonRpcRequest(requestIds.incrementAndGet(), method, params);
        return JsonParser.parseString(server.handleRequest(GSON.toJson(request))).getAsJsonObject();
    }

    private static JsonObject jsonRpcRequest(int requestId, String method, JsonObject params) {
        JsonObject request = new JsonObject();
        request.addProperty("jsonrpc", "2.0");
        request.addProperty("id", requestId);
        request.addProperty("method", method);
        request.add("params", params);
        return request;
    }

    private static JsonObject result(JsonObject response) {
        assertNotNull(response.get("result"));
        return response.getAsJsonObject("result");
    }

    private static JsonObject sessionParams(String sessionId) {
        JsonObject params = new JsonObject();
        params.addProperty("agentSessionId", sessionId);
        return params;
    }

    private static JdbcConnectionPoolRegistry.PoolSettings poolSettings(int maximumPoolSize) {
        return poolSettings(maximumPoolSize, 0, 32, 2);
    }

    private static Connection openH2(String url, AtomicInteger physicalOpens) throws Exception {
        physicalOpens.incrementAndGet();
        return DriverManager.getConnection(url, "sa", "");
    }

    private static JdbcConnectionPoolRegistry.PoolSettings poolSettings(
        int maximumPoolSize,
        int metadataReserve,
        int globalMaximumPhysicalConnections,
        int maxQuarantinedOperations
    ) {
        return new JdbcConnectionPoolRegistry.PoolSettings(
            true,
            maximumPoolSize,
            0,
            2_000L,
            1_000L,
            10_000L,
            30_000L,
            60_000L,
            metadataReserve,
            globalMaximumPhysicalConnections,
            maxQuarantinedOperations
        );
    }

    private static JdbcConnectionPoolRegistry.PoolSettings shortTimeoutPoolSettings(
        int maximumPoolSize,
        int globalMaximumPhysicalConnections
    ) {
        return new JdbcConnectionPoolRegistry.PoolSettings(
            true,
            maximumPoolSize,
            0,
            250L,
            250L,
            10_000L,
            30_000L,
            60_000L,
            0,
            globalMaximumPhysicalConnections,
            2
        );
    }

    private static Connection trackedConnection(Connection delegate, AtomicInteger closeCount) {
        AtomicBoolean closed = new AtomicBoolean();
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("close".equals(method.getName()) && closed.compareAndSet(false, true)) {
                    closeCount.incrementAndGet();
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection closeBlockingConnection(
        Connection delegate,
        AtomicBoolean blockClose,
        CountDownLatch closeStarted,
        CountDownLatch releaseClose
    ) {
        AtomicBoolean closing = new AtomicBoolean();
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("close".equals(method.getName())
                    && blockClose.get()
                    && closing.compareAndSet(false, true)) {
                    closeStarted.countDown();
                    awaitUninterruptibly(releaseClose);
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection validationBlockingConnection(
        Connection delegate,
        AtomicBoolean blockValidation,
        CountDownLatch validationStarted,
        CountDownLatch releaseValidation
    ) {
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("isValid".equals(method.getName()) && blockValidation.get()) {
                    validationStarted.countDown();
                    awaitUninterruptibly(releaseValidation);
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection validationBlockingOnceConnection(
        Connection delegate,
        AtomicBoolean blockNextValidation,
        CountDownLatch validationStarted,
        CountDownLatch releaseValidation
    ) {
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("isValid".equals(method.getName()) && blockNextValidation.compareAndSet(true, false)) {
                    validationStarted.countDown();
                    awaitUninterruptibly(releaseValidation);
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection setupFailingConnection(Connection delegate, AtomicBoolean failSetup) {
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("getAutoCommit".equals(method.getName()) && failSetup.get()) {
                    throw new SQLException("simulated deterministic Hikari setup failure");
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection setupBlockingConnection(
        Connection delegate,
        CountDownLatch setupStarted,
        CountDownLatch releaseSetup
    ) {
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("getAutoCommit".equals(method.getName())) {
                    setupStarted.countDown();
                    awaitUninterruptibly(releaseSetup);
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection abortTrackingConnection(Connection delegate, CountDownLatch abortCalled) {
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("abort".equals(method.getName())) {
                    abortCalled.countDown();
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection networkTimeoutBlockingConnection(
        Connection delegate,
        AtomicBoolean blockNetworkTimeout,
        CountDownLatch networkTimeoutStarted,
        CountDownLatch releaseNetworkTimeout
    ) {
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("setNetworkTimeout".equals(method.getName()) && blockNetworkTimeout.get()) {
                    networkTimeoutStarted.countDown();
                    awaitUninterruptibly(releaseNetworkTimeout);
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection unsupportedNetworkTimeoutConnection(Connection delegate) {
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("setNetworkTimeout".equals(method.getName())) {
                    throw new SQLException("Does not support setNetworkTimeout");
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection asynchronousAbortConnection(
        Connection delegate,
        CountDownLatch abortScheduled,
        CountDownLatch releaseTermination
    ) {
        AtomicBoolean closed = new AtomicBoolean();
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("abort".equals(method.getName())) {
                    Executor executor = (Executor) args[0];
                    closed.set(true);
                    executor.execute(() -> {
                        abortScheduled.countDown();
                        awaitUninterruptibly(releaseTermination);
                        try {
                            delegate.close();
                        } catch (SQLException ignored) {
                        }
                    });
                    return null;
                }
                if ("close".equals(method.getName())) {
                    awaitUninterruptibly(releaseTermination);
                    delegate.close();
                    closed.set(true);
                    return null;
                }
                if ("isClosed".equals(method.getName())) {
                    return closed.get();
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static Connection closeFailingConnection(Connection delegate, AtomicInteger closeAttempts) {
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
                if ("close".equals(method.getName())) {
                    closeAttempts.incrementAndGet();
                    throw new SQLException("simulated close failure");
                }
                if ("isClosed".equals(method.getName())) {
                    return false;
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException error) {
                    throw error.getCause();
                }
            }
        );
    }

    private static void awaitUninterruptibly(CountDownLatch latch) {
        boolean interrupted = false;
        while (true) {
            try {
                latch.await();
                break;
            } catch (InterruptedException ignored) {
                interrupted = true;
            }
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static <T extends Throwable> T futureFailure(
        Future<?> future,
        Class<T> expectedType,
        long timeout,
        TimeUnit unit
    ) throws Exception {
        try {
            future.get(timeout, unit);
            fail("Expected " + expectedType.getSimpleName());
            throw new IllegalStateException("unreachable");
        } catch (ExecutionException error) {
            assertTrue(expectedType.isInstance(error.getCause()), () -> "Unexpected failure: " + error.getCause());
            return expectedType.cast(error.getCause());
        }
    }

    private static void awaitCount(AtomicInteger counter, int expected) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (counter.get() < expected && System.nanoTime() < deadline) {
            Thread.sleep(10L);
        }
        assertTrue(counter.get() >= expected, () -> "counter remained at " + counter.get());
    }

    private static void awaitPhysicalConnectionCount(
        JdbcConnectionPoolRegistry registry,
        int expected
    ) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (registry.activePhysicalConnectionCount() != expected && System.nanoTime() < deadline) {
            Thread.sleep(10L);
        }
        assertEquals(expected, registry.activePhysicalConnectionCount());
    }

    private static String throwableText(Throwable error) {
        StringBuilder text = new StringBuilder();
        Throwable current = error;
        while (current != null) {
            text.append(current).append('\n');
            current = current.getCause();
        }
        return text.toString();
    }

    private static String h2Url(String prefix) {
        return "jdbc:h2:mem:" + prefix + "_" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
    }

    private static class H2TestAgent extends AbstractJdbcAgent {
        private final String url;
        private final AtomicInteger physicalOpens;

        private H2TestAgent(String url, AtomicInteger physicalOpens) {
            this.url = url;
            this.physicalOpens = physicalOpens;
        }

        @Override
        protected String driverClass() {
            return "org.h2.Driver";
        }

        @Override
        protected String buildJdbcUrl(ConnectParams params) {
            return url;
        }

        @Override
        protected Connection openConnection(ConnectParams params) throws Exception {
            return openH2(url, physicalOpens);
        }

        @Override
        public List<DatabaseInfo> listDatabases() {
            return Collections.emptyList();
        }

        @Override
        public List<String> listSchemas() {
            return Collections.emptyList();
        }

        @Override
        public List<TableInfo> listTables(String schema) {
            return Collections.emptyList();
        }

        @Override
        public List<ColumnInfo> getColumns(String schema, String table) {
            return Collections.emptyList();
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
    }
}
