package com.dbx.agent;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    void registrySurfacesInitialPhysicalConnectionFailureWithoutWaitingForBorrowTimeout() {
        JdbcConnectionPoolRegistry.PoolSettings settings = new JdbcConnectionPoolRegistry.PoolSettings(
            1,
            0,
            5_000L,
            1_000L,
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
            assertTrue(elapsedMillis < 1_000L, () -> "initial failure took " + elapsedMillis + "ms");
            assertTrue(error.getMessage().contains("auth failed"), error::toString);
        }
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
        JsonObject request = new JsonObject();
        request.addProperty("jsonrpc", "2.0");
        request.addProperty("id", requestIds.incrementAndGet());
        request.addProperty("method", method);
        request.add("params", params);
        JsonObject response = JsonParser.parseString(server.handleRequest(GSON.toJson(request))).getAsJsonObject();
        assertFalse(response.has("error"), () -> response.toString());
        return response;
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
        return new JdbcConnectionPoolRegistry.PoolSettings(
            maximumPoolSize,
            0,
            2_000L,
            1_000L,
            10_000L,
            30_000L,
            60_000L
        );
    }

    private static Connection openH2(String url, AtomicInteger physicalOpens) throws Exception {
        physicalOpens.incrementAndGet();
        return DriverManager.getConnection(url, "sa", "");
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
