package com.dbx.agent;

import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class JdbcDedicatedConnectionTest {
    @Test
    void explicitJdbcUrlUsesTheSameConnectionPropertiesWithoutChangingTheDefaultUrl() throws Exception {
        String defaultUrl = "jdbc:h2:mem:default_" + UUID.randomUUID();
        String dedicatedUrl = "jdbc:h2:mem:explicit_" + UUID.randomUUID();
        AtomicInteger propertiesBuilt = new AtomicInteger();
        var agent = new ConfiguredJdbcAgent(new JdbcAgentProfile("org.h2.Driver", defaultUrl, 0, false, Set.of(), List.of("TABLE"))) {
            @Override protected java.util.Properties buildConnectionProperties(ConnectParams params) {
                var properties = super.buildConnectionProperties(params);
                properties.setProperty("MODE", "Oracle");
                propertiesBuilt.incrementAndGet();
                return properties;
            }
        };
        ConnectParams params = params();
        params.setUsername("sa");
        params.setPassword("");
        try (Connection ordinary = agent.openConnection(params);
             Connection dedicated = agent.openConnection(params, dedicatedUrl)) {
            assertEquals(defaultUrl, ordinary.getMetaData().getURL());
            assertEquals(dedicatedUrl, dedicated.getMetaData().getURL());
            for (Connection connection : List.of(ordinary, dedicated)) {
                try (var statement = connection.createStatement(); var result = statement.executeQuery("SELECT '' IS NULL")) {
                    assertTrue(result.next());
                    assertTrue(result.getBoolean(1));
                }
            }
        }
        assertEquals(2, propertiesBuilt.get());
    }

    @Test
    void expiredDedicatedDeadlineDoesNotAllocateOrInitialize() throws Exception {
        AtomicInteger opens = new AtomicInteger();
        AtomicInteger initializes = new AtomicInteger();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(false, 1))) {
            var owner = registry.registerDedicatedOwner(() -> {
                opens.incrementAndGet(); return tracked(new AtomicInteger(), null, new AtomicInteger());
            }, connection -> initializes.incrementAndGet(), () -> {}, () -> {});
            assertThrows(java.sql.SQLTimeoutException.class, () -> owner.openUntil(System.nanoTime() - 1));
            assertEquals(0, opens.get());
            assertEquals(0, initializes.get());
            assertEquals(0, registry.activePhysicalConnectionCount());
            assertTrue(owner.closeUnreturnedConnectionsUntil(System.nanoTime()));
            owner.close();
        }
    }

    @Test
    void aLateOpenKeepsItsPermitAndCannotBeMisreportedAsReleasedWithoutAHandle() throws Exception {
        CountDownLatch entering = new CountDownLatch(1), allow = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger(), initializes = new AtomicInteger();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(false, 1));
             ExecutorService client = Executors.newSingleThreadExecutor()) {
            var owner = registry.registerDedicatedOwner(() -> {
                entering.countDown(); await(allow); return tracked(closes, null, new AtomicInteger());
            }, connection -> initializes.incrementAndGet(), () -> {}, () -> {});
            try {
                Future<Exception> result = client.submit(() -> assertThrows(Exception.class,
                    () -> owner.openUntil(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(100))));
                assertTrue(entering.await(2, TimeUnit.SECONDS));
                assertInstanceOf(JdbcConnectionPoolRegistry.PhysicalConnectionStateUnknownException.class, result.get(2, TimeUnit.SECONDS));
                assertFalse(owner.closeUnreturnedConnectionsUntil(System.nanoTime()));
                assertEquals(1, registry.activePhysicalConnectionCount());
                allow.countDown();
                awaitReleased(owner);
                assertEquals(0, initializes.get());
                assertEquals(1, closes.get());
                owner.close();
            } finally { allow.countDown(); }
        }
    }

    @Test
    void aLateInitializerUsesTheSameCallerDeadlineAndNeverDelivers() throws Exception {
        CountDownLatch entering = new CountDownLatch(1), allow = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(false, 1));
             ExecutorService client = Executors.newSingleThreadExecutor()) {
            var owner = registry.registerDedicatedOwner(() -> tracked(closes, null, new AtomicInteger()), connection -> {
                entering.countDown(); await(allow);
            }, () -> {}, () -> {});
            try {
                Future<Exception> result = client.submit(() -> assertThrows(Exception.class,
                    () -> owner.openUntil(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(100))));
                assertTrue(entering.await(2, TimeUnit.SECONDS));
                assertInstanceOf(JdbcConnectionPoolRegistry.PhysicalConnectionStateUnknownException.class, result.get(2, TimeUnit.SECONDS));
                assertFalse(owner.closeUnreturnedConnectionsUntil(System.nanoTime()));
                assertEquals(0, closes.get());
                allow.countDown();
                awaitReleased(owner);
                assertEquals(1, closes.get());
                owner.close();
            } finally { allow.countDown(); }
        }
    }

    @Test
    void aZeroBudgetCloseSubmitsOnceAndAllWaitersObserveTheSameFlight() throws Exception {
        CountDownLatch allow = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(false, 1))) {
            var owner = registry.registerDedicatedOwner(() -> tracked(closes, allow, new AtomicInteger()), connection -> {}, () -> {}, () -> {});
            Connection connection = owner.openUntil(System.nanoTime() + TimeUnit.SECONDS.toNanos(2));
            try {
                assertTimeout(Duration.ofMillis(500), () -> assertFalse(owner.closeConnectionUntil(connection, System.nanoTime())));
                assertFalse(owner.closeConnectionUntil(connection, System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(30)));
                assertEquals(1, closes.get());
                assertFalse(owner.resourcesReleased());
                allow.countDown();
                awaitReleased(owner);
                assertTrue(owner.closeConnectionUntil(connection, System.nanoTime()));
                assertEquals(1, closes.get());
                owner.close();
            } finally { allow.countDown(); }
        }
    }

    @Test
    void aFailedDeadlineCloseNeedsAnExplicitRetryAndRejectsForeignConnections() throws Exception {
        AtomicInteger closes = new AtomicInteger(), completions = new AtomicInteger();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(false, 1));
             Connection foreign = DriverManager.getConnection("jdbc:h2:mem:foreign_" + UUID.randomUUID(), "sa", "")) {
            var owner = registry.registerDedicatedOwner(() -> tracked(closes, null, new AtomicInteger(1)), connection -> {}, () -> {}, completions::incrementAndGet);
            Connection connection = owner.open();
            assertThrows(SQLException.class, () -> owner.closeConnectionUntil(foreign, System.nanoTime()));
            assertFalse(foreign.isClosed());
            assertThrows(SQLException.class, () -> owner.closeConnectionUntil(connection, System.nanoTime() + TimeUnit.SECONDS.toNanos(1)));
            assertEquals(1, closes.get());
            assertFalse(owner.resourcesReleased());
            assertTrue(owner.closeConnectionUntil(connection, System.nanoTime() + TimeUnit.SECONDS.toNanos(1)));
            assertEquals(2, closes.get());
            owner.close();
        }
    }

    @Test
    void zeroBudgetUnreturnedCleanupSubmitsEveryCloseBeforeObservingTheSharedDeadline() throws Exception {
        CountDownLatch initialized = new CountDownLatch(2), secondCloses = new CountDownLatch(2), allowClose = new CountDownLatch(1);
        List<AtomicInteger> closes = new java.util.concurrent.CopyOnWriteArrayList<>();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(false, 2));
             ExecutorService client = Executors.newFixedThreadPool(2)) {
            var owner = registry.registerDedicatedOwner(() -> {
                Connection raw = DriverManager.getConnection("jdbc:h2:mem:unreturned_" + UUID.randomUUID(), "sa", "");
                AtomicInteger count = new AtomicInteger();
                closes.add(count);
                return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
                    if (method.getName().equals("close")) {
                        if (count.incrementAndGet() == 1) throw new SQLException("first close failed");
                        secondCloses.countDown();
                        await(allowClose);
                    }
                    try { return method.invoke(raw, args); }
                    catch (InvocationTargetException error) { throw error.getCause(); }
                });
            }, connection -> {
                initialized.countDown(); await(initialized); throw new SQLException("initializer failed");
            }, () -> {}, () -> {});
            try {
                Future<Exception> first = client.submit(() -> assertThrows(Exception.class, () -> owner.openUntil(System.nanoTime() + TimeUnit.SECONDS.toNanos(2))));
                Future<Exception> second = client.submit(() -> assertThrows(Exception.class, () -> owner.openUntil(System.nanoTime() + TimeUnit.SECONDS.toNanos(2))));
                first.get(4, TimeUnit.SECONDS);
                second.get(4, TimeUnit.SECONDS);
                assertEquals(2, closes.size());
                assertFalse(owner.closeUnreturnedConnectionsUntil(System.nanoTime()));
                assertTrue(secondCloses.await(2, TimeUnit.SECONDS));
                assertTrue(closes.stream().allMatch(count -> count.get() == 2));
                allowClose.countDown();
                awaitReleased(owner);
                owner.close();
            } finally {
                allowClose.countDown();
                owner.closeUnreturnedConnectionsUntil(System.nanoTime() + TimeUnit.SECONDS.toNanos(2));
                if (owner.resourcesReleased()) owner.close();
            }
        }
    }

    @Test
    void aDedicatedOpenerUsesTheOriginalPhysicalBudgetWithoutChangingOrdinaryQueries() throws Exception {
        AtomicInteger ordinaryOpens = new AtomicInteger();
        AtomicInteger specialOpens = new AtomicInteger();
        AtomicInteger specialCloses = new AtomicInteger();
        ProbeAgent agent = new ProbeAgent(ordinaryOpens);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(false, 1))) {
            agent.attachConnectionPoolRegistry(registry);
            ConnectParams original = params();
            agent.connect(original);
            try {
                try (AbstractJdbcAgent.DedicatedConnectionOwner owner = agent.dedicated(frozen -> {
                    assertEquals("dedicated", frozen.getDatabase());
                    specialOpens.incrementAndGet();
                    return tracked(specialCloses, null, new AtomicInteger());
                })) {
                    try (Connection connection = owner.open()) {
                        assertEquals(1, registry.activePhysicalConnectionCount());
                        assertThrows(Exception.class, owner::open);
                        assertEquals(1, specialOpens.get());
                        assertTrue(connection.createStatement().execute("SELECT 1"));
                    }
                    assertTrue(owner.resourcesReleased());
                }
                assertEquals(1, specialCloses.get());
                assertEquals(1, ordinaryOpens.get());
                assertEquals("dedicated", original.getDatabase());
                assertEquals(0, registry.poolCount());
                assertTrue(agent.getConnection().createStatement().execute("SELECT 1"));
            } finally {
                agent.disconnect();
            }
        }
    }

    @Test
    void detachedConnectionsShareThePhysicalBudgetRatherThanBorrowingTheOrdinaryLease() throws Exception {
        AtomicInteger opens = new AtomicInteger();
        ProbeAgent agent = new ProbeAgent(opens);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(true, 2))) {
            agent.attachConnectionPoolRegistry(registry);
            agent.connect(params());
            try (AbstractJdbcAgent.DedicatedConnectionOwner owner = agent.dedicated();
                 Connection detached = owner.open()) {
                assertEquals(2, registry.activePhysicalConnectionCount(), "the idle pooled connection and dedicated connection both consume the runtime budget");
                assertThrows(Exception.class, owner::open);
                assertEquals(2, opens.get(), "capacity rejection must occur before another driver connection is opened");
                assertTrue(detached.createStatement().execute("SELECT 1"));
                assertEquals(1, registry.poolCount(), "dedicated connections must not create another Hikari pool");
            } finally {
                agent.disconnect();
            }
            assertEquals(1, registry.activePhysicalConnectionCount());
        }
    }

    @Test
    void attachingThePhysicalRegistryDoesNotEnableDisabledOrdinaryPooling() {
        ProbeAgent agent = new ProbeAgent(new AtomicInteger());
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(false, 2))) {
            agent.attachConnectionPoolRegistry(registry);
            agent.connect(params());
            try {
                assertFalse(agent.usesConnectionPool(), "pool-disabled query sessions must retain their direct connection contract");
                assertNotNull(agent.getConnection());
                assertEquals(0, registry.poolCount());
            } finally {
                agent.disconnect();
            }
        }
    }

    @Test
    void lateConnectRemainsOwnedAcrossRetirementAndDoesNotInitializeOrDeliver() throws Exception {
        CountDownLatch opened = new CountDownLatch(1);
        CountDownLatch allowOpen = new CountDownLatch(1);
        AtomicInteger initializes = new AtomicInteger();
        AtomicInteger closes = new AtomicInteger();
        AtomicInteger retirements = new AtomicInteger();
        JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(true, 1));
        try (ExecutorService client = Executors.newFixedThreadPool(2)) {
            AbstractJdbcAgent.DedicatedConnectionOwner owner = registry.registerDedicatedOwner(() -> {
                opened.countDown();
                await(allowOpen);
                return tracked(closes, null, new AtomicInteger());
            }, connection -> initializes.incrementAndGet(), retirements::incrementAndGet, () -> {});
            try {
                Future<Exception> start = client.submit(() -> assertThrows(Exception.class, owner::open));
                assertTrue(opened.await(2, TimeUnit.SECONDS));
                assertInstanceOf(JdbcConnectionPoolRegistry.PhysicalConnectionStateUnknownException.class, start.get(2, TimeUnit.SECONDS));
                assertEquals(1, registry.activePhysicalConnectionCount());
                assertFalse(owner.resourcesReleased());
                registry.close();
                assertEquals(1, retirements.get());
                Future<?> drain = client.submit(registry::awaitDedicatedDrain);
                assertThrows(java.util.concurrent.TimeoutException.class, () -> drain.get(100, TimeUnit.MILLISECONDS));
                allowOpen.countDown();
                awaitReleased(owner);
                assertEquals(0, initializes.get(), "retirement must be checked again after raw connect returns");
                assertEquals(1, closes.get());
                assertEquals(0, registry.activePhysicalConnectionCount());
                assertFalse(drain.isDone(), "owner cleanup responsibility is separate from physical permits");
                owner.close();
                drain.get(2, TimeUnit.SECONDS);
            } finally {
                allowOpen.countDown();
            }
        } finally {
            registry.close();
        }
    }

    @Test
    void blockedInitializationCannotBeRacedByCleanupAndConsumesTheOriginalDeadline() throws Exception {
        CountDownLatch initializing = new CountDownLatch(1);
        CountDownLatch allowInitialize = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(true, 1));
             ExecutorService client = Executors.newSingleThreadExecutor()) {
            AbstractJdbcAgent.DedicatedConnectionOwner owner = registry.registerDedicatedOwner(
                () -> tracked(closes, null, new AtomicInteger()), connection -> {
                    initializing.countDown();
                    await(allowInitialize);
                }, () -> {}, () -> {});
            try {
                Future<Exception> start = client.submit(() -> assertThrows(Exception.class, owner::open));
                assertTrue(initializing.await(2, TimeUnit.SECONDS));
                assertInstanceOf(JdbcConnectionPoolRegistry.PhysicalConnectionStateUnknownException.class, start.get(2, TimeUnit.SECONDS));
                owner.closeUnreturnedConnections();
                assertEquals(0, closes.get(), "the original initializer still owns this physical connection");
                assertEquals(1, registry.activePhysicalConnectionCount());
                allowInitialize.countDown();
                awaitReleased(owner);
                assertEquals(1, closes.get());
                assertEquals(0, registry.activePhysicalConnectionCount());
                owner.close();
            } finally {
                allowInitialize.countDown();
            }
        }
    }

    @Test
    void initializationFailurePreservesItsDiagnosticAndUnconfirmedCloseCanBeExplicitlyRetried() throws Exception {
        AtomicInteger closes = new AtomicInteger();
        AtomicInteger closeFailures = new AtomicInteger(1);
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(true, 1))) {
            AbstractJdbcAgent.DedicatedConnectionOwner owner = registry.registerDedicatedOwner(
                () -> tracked(closes, null, closeFailures), connection -> {
                    throw new SQLException("injected initializer failure", "42000", 902);
                }, () -> {}, () -> {});
            SQLException error = assertThrows(SQLException.class, owner::open);
            assertEquals("42000", error.getSQLState());
            assertEquals(902, error.getErrorCode());
            assertEquals(1, error.getSuppressed().length);
            assertEquals(1, closes.get());
            assertEquals(1, registry.activePhysicalConnectionCount());
            assertFalse(owner.resourcesReleased());
            assertThrows(IllegalStateException.class, owner::close);
            owner.closeUnreturnedConnections();
            awaitReleased(owner);
            assertEquals(2, closes.get());
            assertEquals(0, registry.activePhysicalConnectionCount());
            owner.close();
        }
    }

    @Test
    void repeatedCloseWaitsForTheSameInFlightPhysicalCloseAndReturnsItsPermitOnlyOnce() throws Exception {
        CountDownLatch allowClose = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(true, 1))) {
            AbstractJdbcAgent.DedicatedConnectionOwner owner = registry.registerDedicatedOwner(
                () -> tracked(closes, allowClose, new AtomicInteger()), connection -> {}, () -> {}, () -> {});
            Connection connection = owner.open();
            try {
                assertThrows(SQLException.class, connection::close);
                assertThrows(SQLException.class, connection::close);
                assertEquals(1, closes.get(), "a timeout is not permission to issue a second raw close");
                assertEquals(1, registry.activePhysicalConnectionCount());
                allowClose.countDown();
                awaitReleased(owner);
                connection.close();
                assertEquals(1, closes.get());
                assertEquals(0, registry.activePhysicalConnectionCount());
                owner.close();
            } finally {
                allowClose.countDown();
            }
        }
    }

    @Test
    void physicalBudgetWaitAndConnectShareOneDeadline() throws Exception {
        CountDownLatch connecting = new CountDownLatch(1);
        CountDownLatch allowConnect = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(settings(true, 1));
             ExecutorService client = Executors.newSingleThreadExecutor()) {
            AbstractJdbcAgent.DedicatedConnectionOwner first = registry.registerDedicatedOwner(
                () -> tracked(closes, null, new AtomicInteger()), connection -> {}, () -> {}, () -> {});
            Connection occupied = first.open();
            AbstractJdbcAgent.DedicatedConnectionOwner next = registry.registerDedicatedOwner(() -> {
                connecting.countDown();
                await(allowConnect);
                return tracked(closes, null, new AtomicInteger());
            }, connection -> {}, () -> {}, () -> {});
            try {
                Future<Exception> result = client.submit(() -> assertThrows(Exception.class, next::open));
                assertFalse(connecting.await(600, TimeUnit.MILLISECONDS), "the driver must not open over budget");
                occupied.close();
                assertTrue(connecting.await(200, TimeUnit.MILLISECONDS));
                assertTimeoutPreemptively(Duration.ofMillis(800), () -> result.get(2, TimeUnit.SECONDS));
                assertEquals(1, registry.activePhysicalConnectionCount());
                allowConnect.countDown();
                awaitReleased(next);
                first.close();
                next.close();
                assertEquals(2, closes.get());
            } finally {
                allowConnect.countDown();
                occupied.close();
            }
        }
    }

    private static Connection tracked(AtomicInteger closes, CountDownLatch allowClose, AtomicInteger closeFailures) throws SQLException {
        Connection raw = DriverManager.getConnection("jdbc:h2:mem:dedicated_raw_" + UUID.randomUUID(), "sa", "");
        return (Connection) Proxy.newProxyInstance(JdbcDedicatedConnectionTest.class.getClassLoader(), new Class<?>[]{Connection.class},
            (proxy, method, arguments) -> {
                if ("close".equals(method.getName())) {
                    closes.incrementAndGet();
                    if (allowClose != null) await(allowClose);
                    if (closeFailures.getAndUpdate(value -> Math.max(0, value - 1)) > 0) throw new SQLException("injected physical close failure");
                }
                try { return method.invoke(raw, arguments); }
                catch (InvocationTargetException error) { throw error.getCause(); }
            });
    }

    private static void await(CountDownLatch latch) {
        boolean interrupted = false;
        while (true) {
            try { latch.await(); break; }
            catch (InterruptedException ignored) { interrupted = true; }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    private static void awaitReleased(AbstractJdbcAgent.DedicatedConnectionOwner owner) throws InterruptedException {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (!owner.resourcesReleased() && System.nanoTime() < end) Thread.sleep(5);
        assertTrue(owner.resourcesReleased());
    }

    static JdbcConnectionPoolRegistry.PoolSettings settings(boolean enabled, int maximum) {
        return new JdbcConnectionPoolRegistry.PoolSettings(enabled, 2, 0, 1_000, 250, 60_000, 120_000, 60_000, 1, maximum, 1);
    }

    static ConnectParams params() {
        ConnectParams params = new ConnectParams();
        params.setDatabase("dedicated");
        return params;
    }

    static class ProbeAgent extends ConfiguredJdbcAgent {
        private final AtomicInteger opens;
        private final String url;

        ProbeAgent(AtomicInteger opens) {
            this(opens, "jdbc:h2:mem:dedicated_" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1");
        }

        private ProbeAgent(AtomicInteger opens, String url) {
            super(new JdbcAgentProfile("org.h2.Driver", url, 0, false, Set.of(), List.of("TABLE")));
            this.opens = opens;
            this.url = url;
        }

        @Override protected Connection openConnection(ConnectParams params) throws Exception {
            opens.incrementAndGet();
            return DriverManager.getConnection(url, "sa", "");
        }

        DedicatedConnectionOwner dedicated() { return registerDedicatedConnections(() -> {}, () -> {}); }
        DedicatedConnectionOwner dedicated(DedicatedConnectionOpener opener) { return registerDedicatedConnections(() -> {}, () -> {}, opener); }
    }
}
