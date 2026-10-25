package com.dbx.agent;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class NativeJobSessionTest {
    private static final Gson GSON = new Gson();

    @Test
    void capabilityIsExplicitAndDoesNotChangeOrdinaryOrLegacyHandshakes() {
        java.util.concurrent.atomic.AtomicInteger factories = new java.util.concurrent.atomic.AtomicInteger();
        java.util.function.Supplier<DatabaseAgent> factory = () -> {
            factories.incrementAndGet();
            return new H2Agent();
        };
        try (MultiSessionJsonRpcServer ordinary = new MultiSessionJsonRpcServer(factory);
             MultiSessionJsonRpcServer nativeJobs = MultiSessionJsonRpcServer.withNativeJobSessions(factory)) {
            String request = "{\"id\":1,\"method\":\"handshake\",\"params\":{}}";
            assertFalse(ordinary.handleRequest(request).contains("native_job_session_v1"));
            assertTrue(nativeJobs.handleRequest(request).contains("native_job_session_v1"));
            assertFalse(new JsonRpcServer(new H2Agent()).handleRequest(request).contains("native_job_session_v1"));
            assertEquals(0, factories.get(), "handshake must not create a sample database agent");
        }
    }

    @Test
    void workloadSessionsRemainOrdinaryAndCannotBePromotedToNativeJobOwnership() throws Exception {
        try (Environment env = new Environment(true, 3)) {
            JsonObject workload = env.connection.deepCopy();
            workload.addProperty("sessionRole", "workload");
            env.server.dispatchForRuntime("connect", workload);
            assertThrows(Exception.class, () -> env.open("operation"));
            assertNotNull(env.server.dispatchForRuntime("execute_query", json("{\"sql\":\"SELECT 1\"}")));
        }
    }

    @Test
    void internalCommitDoesNotReleaseOrReplaceTheOwnedPhysicalConnection() throws Exception {
        for (boolean pooled : List.of(false, true)) {
            try (Environment env = new Environment(pooled, 3)) {
                int initialPhysical = env.registry.activePhysicalConnectionCount();
                JsonObject opened = env.open("operation");
                assertEquals("opened", opened.get("phase").getAsString());
                Connection owned = env.agent.getConnection();
                assertFalse(owned.getAutoCommit());
                assertEquals(initialPhysical + (pooled ? 1 : 0), env.registry.activePhysicalConnectionCount());
                assertEquals(opened, env.open("operation"), "lost open receipts must not open another connection");
                int opens = env.agent.physical.size();
                env.query(opened, "CREATE TABLE job_session_probe (id INT)");
                env.query(opened, "INSERT INTO job_session_probe VALUES (1)");
                env.query(opened, "COMMIT");
                QueryResult rows = env.query(opened, "SELECT COUNT(*) FROM job_session_probe");
                assertEquals(1L, ((Number) rows.getRows().get(0).get(0)).longValue());
                assertSame(owned, env.agent.getConnection());
                assertFalse(owned.getAutoCommit());
                assertEquals(opens, env.agent.physical.size());
                int commits = env.agent.commits;
                int rollbacks = env.agent.rollbacks;
                JsonObject closed = env.close(opened);
                assertEquals("closed", closed.get("phase").getAsString());
                assertTrue(owned.isClosed());
                assertEquals(initialPhysical, env.registry.activePhysicalConnectionCount());
                assertEquals(closed, env.close(opened));
                assertEquals(commits, env.agent.commits, "lease cleanup must not commit job configuration");
                assertEquals(rollbacks, env.agent.rollbacks, "lease cleanup is not a configuration rollback");
                assertThrows(Exception.class, () -> env.query(opened, "SELECT 1"));
            }
        }
    }

    @Test
    void reservedSessionRejectsOrdinaryCallsChangedIdentityAndForeignTokensBeforeSql() throws Exception {
        try (Environment env = new Environment(true, 3)) {
            JsonObject opened = env.open("operation");
            int opens = env.agent.physical.size();
            for (String method : List.of("connect", "test_connection", "begin_manual_transaction", "execute_query_page")) {
                assertThrows(Exception.class, () -> env.server.dispatchForRuntime(method, env.connection.deepCopy()), method);
            }
            assertThrows(Exception.class, () -> env.server.dispatchForRuntime("execute_query", json("{\"sql\":\"SELECT 1\"}")));
            for (String field : List.of("nativeJobOperationId", "nativeJobSessionToken")) {
                JsonObject invalid = env.authorized(opened);
                invalid.addProperty(field, "foreign");
                invalid.addProperty("sql", "SELECT 1");
                assertThrows(Exception.class, () -> env.server.dispatchForRuntime("execute_query", invalid));
            }
            assertThrows(Exception.class, () -> env.open("other-operation"));
            assertEquals(opens, env.agent.physical.size());
            assertEquals(1L, ((Number) env.query(opened, "SELECT 1").getRows().get(0).get(0)).longValue());
        }
    }

    @Test
    void disconnectedPhysicalSessionCannotReconnectOrReuseItsTokenInAnotherLogicalSession() throws Exception {
        try (Environment original = new Environment(true, 3); Environment replacement = new Environment(true, 3)) {
            JsonObject opened = original.open("operation");
            int opens = original.agent.physical.size();
            original.agent.getConnection().close();
            assertThrows(Exception.class, () -> original.query(opened, "SELECT 1"));
            assertThrows(Exception.class, () -> replacement.query(opened, "SELECT 1"));
            assertEquals(opens, original.agent.physical.size());
            JsonObject own = replacement.open("operation");
            assertNotEquals(opened.get("sessionToken"), own.get("sessionToken"));
            assertThrows(Exception.class, () -> replacement.query(opened, "SELECT 1"));
            replacement.query(own, "SELECT 1");
        }
    }

    @Test
    void failedPhysicalCloseRemainsUnknownOnRepeatedCloseAndLogicalCleanup() throws Exception {
        try (Environment env = new Environment(true, 3)) {
            JsonObject opened = env.open("operation");
            env.agent.failClose = env.agent.physical.get(env.agent.physical.size() - 1);
            JsonObject closed = env.close(opened);
            assertEquals("unknown", closed.get("phase").getAsString());
            int closes = env.agent.closes;
            assertEquals(closed, env.close(opened));
            assertEquals(closes, env.agent.closes, "unknown close must not be retried and relabeled confirmed");
            assertThrows(Exception.class, () -> env.server.dispatchForRuntime("disconnect", new JsonObject()));
            assertEquals(closes, env.agent.closes);
        }
    }

    @Test
    void aLostOpenReceiptCanCloseOnlyThatOperationsConnectionWithoutKnowingItsToken() throws Exception {
        try (Environment env = new Environment(true, 3)) {
            env.open("operation");
            assertThrows(Exception.class, () -> env.server.dispatchForRuntime("close_native_job_session", json("{\"operationId\":\"foreign\"}")));
            JsonObject closed = result(env.server.dispatchForRuntime("close_native_job_session", json("{\"operationId\":\"operation\"}")));
            assertEquals("closed", closed.get("phase").getAsString());
            assertEquals(closed, env.open("operation"));
        }
    }

    @Test
    void anExistingManualTransactionIsNotBorrowedOrClosedByOpeningANativeJobLease() throws Exception {
        try (Environment env = new Environment(true, 3)) {
            env.server.dispatchForRuntime("begin_manual_transaction", new JsonObject());
            Connection editor = env.agent.getConnection();
            int opens = env.agent.physical.size();
            assertThrows(Exception.class, () -> env.open("operation"));
            assertSame(editor, env.agent.getConnection());
            assertFalse(editor.isClosed());
            assertFalse(editor.getAutoCommit());
            assertEquals(opens, env.agent.physical.size());
            env.server.dispatchForRuntime("rollback_manual_transaction", new JsonObject());
            assertEquals("opened", env.open("operation").get("phase").getAsString());
        }
    }

    @Test
    void anExistingCursorSurvivesRejectedReservationAndCanFinishBeforeANewLease() throws Exception {
        try (Environment env = new Environment(true, 3)) {
            QueryPageResult page = (QueryPageResult) env.server.dispatchForRuntime("execute_query_page",
                json("{\"sql\":\"SELECT X FROM SYSTEM_RANGE(1, 3)\",\"pageSize\":1}"));
            assertNotNull(page.getSession_id());
            Connection cursor = env.agent.getConnection();
            assertThrows(Exception.class, () -> env.open("operation"));
            assertSame(cursor, env.agent.getConnection());
            JsonObject fetch = new JsonObject();
            fetch.addProperty("sessionId", page.getSession_id());
            fetch.addProperty("pageSize", 1);
            assertNotNull(env.server.dispatchForRuntime("fetch_query_page", fetch));
            env.server.dispatchForRuntime("close_query_session", fetch);
            assertEquals("opened", env.open("operation").get("phase").getAsString());
        }
    }

    @Test
    void independentNativeConnectionStillHonorsTheExistingRuntimePhysicalBudget() throws Exception {
        try (Environment env = new Environment(true, 1)) {
            assertEquals(1, env.registry.activePhysicalConnectionCount());
            Exception exhausted = assertThrows(Exception.class, () -> env.open("operation"));
            JsonObject diagnostics = AgentRpcError.toJson(exhausted, "open_native_job_session", null).getAsJsonObject("data");
            assertEquals("resource", diagnostics.get("category").getAsString());
            assertTrue(diagnostics.get("retryable").getAsBoolean());
            assertEquals(1, env.agent.physical.size());
            assertEquals(1, env.registry.activePhysicalConnectionCount());
            assertNotNull(env.server.dispatchForRuntime("execute_query", json("{\"sql\":\"SELECT 1\"}")));
        }
    }

    private static JsonObject json(String value) {
        return JsonParser.parseString(value).getAsJsonObject();
    }

    private static JsonObject result(Object value) {
        return GSON.toJsonTree(value).getAsJsonObject();
    }

    private static final class Environment implements AutoCloseable {
        final JdbcConnectionPoolRegistry registry;
        final H2Agent agent = new H2Agent();
        final JsonRpcServer server = new JsonRpcServer(agent);
        final JsonObject connection = json("{\"database\":\"jobs\",\"username\":\"sa\",\"password\":\"\",\"sessionRole\":\"metadata\"}");

        Environment(boolean pooled, int budget) throws Exception {
            registry = new JdbcConnectionPoolRegistry(new JdbcConnectionPoolRegistry.PoolSettings(
                true, 1, 0, 2_000L, 1_000L, 10_000L, 30_000L, 60_000L, 0, budget, 1));
            if (pooled) agent.attachConnectionPoolRegistry(registry);
            server.dispatchForRuntime("connect", connection.deepCopy());
        }

        JsonObject open(String id) throws Exception {
            JsonObject params = new JsonObject();
            params.addProperty("operationId", id);
            return result(server.dispatchForRuntime("open_native_job_session", params));
        }

        JsonObject authorized(JsonObject opened) {
            JsonObject params = new JsonObject();
            params.add("nativeJobOperationId", opened.get("operationId"));
            params.add("nativeJobSessionToken", opened.get("sessionToken"));
            return params;
        }

        QueryResult query(JsonObject opened, String sql) throws Exception {
            JsonObject params = authorized(opened);
            params.addProperty("sql", sql);
            return (QueryResult) server.dispatchForRuntime("execute_query", params);
        }

        JsonObject close(JsonObject opened) throws Exception {
            JsonObject params = new JsonObject();
            params.add("operationId", opened.get("operationId"));
            params.add("sessionToken", opened.get("sessionToken"));
            return result(server.dispatchForRuntime("close_native_job_session", params));
        }

        @Override public void close() {
            try { server.dispatchForRuntime("disconnect", new JsonObject()); }
            catch (Exception ignored) { }
            registry.close();
        }
    }

    private static final class H2Agent extends AbstractJdbcAgent {
        final String url = "jdbc:h2:mem:job_" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        final List<Connection> physical = new ArrayList<>();
        Connection failClose;
        int commits;
        int rollbacks;
        int closes;

        @Override public boolean supportsNativeJobSessions() { return true; }
        @Override protected String driverClass() { return "org.h2.Driver"; }
        @Override protected String buildJdbcUrl(ConnectParams params) { return url; }
        @Override protected Connection openConnection(ConnectParams params) throws Exception {
            Connection real = DriverManager.getConnection(url, "sa", "");
            Connection tracked = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{Connection.class}, (proxy, method, arguments) -> {
                    if ("commit".equals(method.getName())) commits++;
                    if ("rollback".equals(method.getName())) rollbacks++;
                    if ("close".equals(method.getName())) closes++;
                    try {
                        Object value = method.invoke(real, arguments);
                        if ("close".equals(method.getName()) && proxy == failClose) {
                            throw new SQLException("physical close acknowledgement lost", "08006");
                        }
                        return value;
                    } catch (InvocationTargetException error) { throw error.getCause(); }
                });
            physical.add(tracked);
            return tracked;
        }
        @Override public List<DatabaseInfo> listDatabases() { return Collections.emptyList(); }
        @Override public List<String> listSchemas() { return Collections.emptyList(); }
        @Override public List<TableInfo> listTables(String schema) { return Collections.emptyList(); }
        @Override public List<ColumnInfo> getColumns(String schema, String table) { return Collections.emptyList(); }
        @Override public List<IndexInfo> listIndexes(String schema, String table) { return Collections.emptyList(); }
        @Override public List<ForeignKeyInfo> listForeignKeys(String schema, String table) { return Collections.emptyList(); }
        @Override public List<TriggerInfo> listTriggers(String schema, String table) { return Collections.emptyList(); }
    }
}
