package com.dbx.agent;

import com.google.gson.Gson;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class NativeLegacyJobTest {
    private static final Gson GSON = new Gson();

    @Test
    void pooledAndDedicatedRpcUseOnePhysicalConnectionAndNoCommitBeforeInitialReadback() throws Exception {
        for (boolean pooled : List.of(false, true)) {
            for (String zone : new String[]{null, "zone1"}) {
                try (Environment env = new Environment(pooled)) {
                    JsonObject request = prepare();
                    request.add("zone", zone == null ? JsonNull.INSTANCE : GSON.toJsonTree(zone));
                    JsonObject prepared = env.call("prepare_legacy_job", request);
                    assertEquals("prepared", text(prepared, "phase"));
                    Physical physical = env.agent.physical.getLast();
                    assertEquals("41", text(prepared, "jobId"));
                    assertEquals(zone, physical.zone);
                    assertFalse(physical.real.getAutoCommit());
                    assertEquals(0, physical.commits);
                    assertTrue(physical.events.indexOf("submit") < physical.events.indexOf("broken"));
                    assertTrue(physical.events.indexOf("broken") < physical.events.indexOf("read"));
                    assertTrue(physical.events.indexOf("broken") < physical.events.indexOf("next-date"));
                    assertTrue(physical.events.indexOf("next-date") < physical.events.indexOf("read"));
                    assertEquals(Types.VARCHAR, physical.outType);
                    assertFalse(prepared.has("disposalConfirmed"));
                    assertEquals(prepared, env.call("prepare_legacy_job", request));
                    JsonObject committed = env.call("commit_legacy_job", finish("41"));
                    assertEquals("committed", text(committed, "phase"));
                    assertTrue(committed.get("disposalConfirmed").getAsBoolean());
                    assertEquals(1, physical.commits);
                    assertEquals(0, physical.rollbacks);
                    assertEquals(1, physical.closes);
                }
            }
        }
    }

    @Test
    void changedOperationDefinitionOrZoneCannotResubmitAndOrdinaryCallsCannotBorrowTheTransaction() throws Exception {
        try (Environment env = new Environment(true)) {
            JsonObject original = prepare();
            JsonObject prepared = env.call("prepare_legacy_job", original);
            Physical physical = env.agent.physical.getLast();
            for (String field : List.of("zone", "dialect", "what", "operationId")) {
                JsonObject changed = original.deepCopy();
                changed.addProperty(field, "different");
                assertNotEquals("prepared", text(env.call("prepare_legacy_job", changed), "phase"));
            }
            for (String method : List.of("execute_query", "connect", "connection_info", "begin_manual_transaction", "open_native_job_session")) {
                assertThrows(Exception.class, () -> env.server.dispatchForRuntime(method, new JsonObject()), method);
            }
            assertEquals(prepared, env.call("legacy_job_status", finish(null)));
            assertEquals(1, Collections.frequency(physical.events, "submit"));
            assertEquals("native_job_identity_mismatch", text(env.call("commit_legacy_job", finish(null)), "reason"));
            assertEquals("rolled_back", text(env.call("rollback_legacy_job", finish(null)), "phase"));
            assertEquals(1, physical.rollbacks);
            assertEquals(0, physical.commits);
        }
    }

    @Test
    void outGetterAndInitialReadFailuresRollBackAndDoNotLeakBodies() throws Exception {
        for (String failure : List.of("out-read", "broken", "next-date", "mismatch", "zone-mismatch")) {
            try (Environment env = new Environment(false)) {
                Physical physical = env.agent.physical.getLast();
                physical.failure = failure;
                JsonObject failed = env.call("prepare_legacy_job", prepare());
                assertEquals("rolled_back", text(failed, "phase"));
                if (failure.equals("out-read")) assertEquals("native_job_out_read_failed", text(failed, "reason"));
                assertTrue(failed.get("disposalConfirmed").getAsBoolean());
                assertEquals(1, physical.rollbacks);
                assertEquals(0, physical.commits);
                assertFalse(failed.toString().contains("private"));
            }
        }
    }

    @Test
    void unknownCommitIsNeverReplayedOrRolledBackAndCloseFailureCannotBeErased() throws Exception {
        for (String failure : List.of("commit", "close")) {
            try (Environment env = new Environment(false)) {
                env.call("prepare_legacy_job", prepare());
                Physical physical = env.agent.physical.getLast();
                physical.failure = failure;
                JsonObject terminal = env.call("commit_legacy_job", finish("41"));
                assertEquals(failure.equals("commit") ? "unknown" : "committed", text(terminal, "phase"));
                assertEquals(!failure.equals("close"), terminal.get("disposalConfirmed").getAsBoolean());
                assertEquals(terminal, env.call("legacy_job_status", finish(null)));
                assertEquals(terminal, env.call("commit_legacy_job", finish("41")));
                assertEquals(terminal, env.call("rollback_legacy_job", finish(null)));
                assertEquals(1, physical.commits);
                assertEquals(0, physical.rollbacks);
                assertEquals(1, physical.closes);
            }
        }
    }

    @Test
    void editorTransactionSurvivesRejectedPreparationAndAnotherDriverCannotOptInImplicitly() throws Exception {
        try (Environment env = new Environment(true)) {
            env.server.dispatchForRuntime("begin_manual_transaction", new JsonObject());
            Connection editor = env.agent.getConnection();
            assertThrows(Exception.class, () -> env.server.dispatchForRuntime("prepare_legacy_job", prepare()));
            assertSame(editor, env.agent.getConnection());
            assertFalse(editor.isClosed());
            assertFalse(editor.getAutoCommit());
            env.server.dispatchForRuntime("rollback_manual_transaction", new JsonObject());
        }
        JsonRpcServer ordinary = new JsonRpcServer(new FakeAgent() {
            public boolean supportsNativeLegacyJobs() { return false; }
        });
        assertThrows(Exception.class, () -> ordinary.dispatchForRuntime("prepare_legacy_job", prepare()));
    }

    @Test
    void actualMultiSessionEntryPreservesBlobCapabilityAndDoesNotConfuseLogicalCloseWithDisposal() throws Exception {
        List<FakeAgent> agents = new java.util.concurrent.CopyOnWriteArrayList<>();
        java.util.function.Supplier<DatabaseAgent> factory = () -> {
            FakeAgent agent = new FakeAgent();
            agents.add(agent);
            return agent;
        };
        try (MultiSessionJsonRpcServer server = MultiSessionJsonRpcServer.withNativeLegacyJobs(factory, true);
             MultiSessionJsonRpcServer ordinary = MultiSessionJsonRpcServer.withBlobBindings(factory)) {
            JsonObject handshake = rpc(server, "handshake", new JsonObject());
            assertTrue(handshake.toString().contains("native_job_legacy_ob_v1"));
            assertTrue(handshake.toString().contains("blob_bind_statements_v1"));
            assertFalse(rpc(ordinary, "handshake", new JsonObject()).toString().contains("native_job_legacy_ob_v1"));
            assertTrue(agents.isEmpty(), "handshake must not instantiate or connect a sample agent");
            JsonObject connection = JsonParser.parseString("{\"agentSessionId\":\"original\",\"database\":\"jobs\",\"username\":\"Owner\",\"password\":\"\",\"sessionRole\":\"metadata\"}").getAsJsonObject();
            rpc(server, "open_session", connection);
            JsonObject request = prepare();
            request.addProperty("agentSessionId", "original");
            assertEquals("prepared", text(rpc(server, "prepare_legacy_job", request), "phase"));
            Physical physical = agents.getFirst().physical.getLast();
            physical.failure = "close";
            JsonObject finish = finish("41");
            finish.addProperty("agentSessionId", "original");
            JsonObject committed = rpc(server, "commit_legacy_job", finish);
            assertEquals("committed", text(committed, "phase"));
            assertFalse(committed.get("disposalConfirmed").getAsBoolean());
            assertEquals(committed, rpc(server, "legacy_job_status", finish));
            assertTrue(rpc(server, "close_session", connection).get("ok").getAsBoolean());
            connection.addProperty("agentSessionId", "replacement");
            rpc(server, "open_session", connection);
            finish.addProperty("agentSessionId", "replacement");
            JsonObject missing = rpc(server, "commit_legacy_job", finish);
            assertEquals("unknown", text(missing, "phase"));
            assertFalse(missing.has("jobId"));
            assertEquals(1, physical.commits);
            assertEquals(0, physical.rollbacks);
            assertEquals(1, physical.closes);
        } finally {
            for (FakeAgent agent : agents) for (Physical physical : agent.physical) physical.real.close();
        }
    }

    private static JsonObject rpc(MultiSessionJsonRpcServer server, String method, JsonObject params) {
        JsonObject request = new JsonObject();
        request.addProperty("id", 1);
        request.addProperty("method", method);
        request.add("params", params);
        JsonObject response = JsonParser.parseString(server.handleRequest(request.toString())).getAsJsonObject();
        assertFalse(response.has("error"), response.toString());
        return response.getAsJsonObject("result");
    }

    private static JsonObject prepare() {
        return JsonParser.parseString("""
            {"operationId":"operation","dialect":"oceanbase-oracle","what":"private_call();","nextDate":"2026-10-21 10:20:30",
             "interval":"SYSDATE+1","enabled":false,"instance":0,"schema":"Owner","timeoutSecs":2}
            """).getAsJsonObject();
    }
    private static JsonObject finish(String id) {
        JsonObject params = new JsonObject();
        params.addProperty("operationId", "operation");
        if (id != null) params.addProperty("jobId", id);
        return params;
    }

    private static String text(JsonObject value, String field) {
        return value.has(field) ? value.get(field).getAsString() : "";
    }

    private static final class Environment implements AutoCloseable {
        final FakeAgent agent = new FakeAgent();
        final JsonRpcServer server = new JsonRpcServer(agent);
        final JdbcConnectionPoolRegistry registry;

        Environment(boolean pooled) throws Exception {
            registry = new JdbcConnectionPoolRegistry(new JdbcConnectionPoolRegistry.PoolSettings(true, 1, 0, 2_000L, 1_000L, 10_000L, 30_000L, 60_000L, 0, 3, 1));
            if (pooled) agent.attachConnectionPoolRegistry(registry);
            server.dispatchForRuntime("connect", JsonParser.parseString("{\"database\":\"jobs\",\"username\":\"Owner\",\"password\":\"\",\"sessionRole\":\"metadata\"}").getAsJsonObject());
        }

        JsonObject call(String method, JsonObject params) throws Exception {
            return GSON.toJsonTree(server.dispatchForRuntime(method, params)).getAsJsonObject();
        }

        public void close() throws Exception {
            try { server.dispatchForRuntime("disconnect", new JsonObject()); } catch (Exception ignored) {}
            registry.close();
            for (Physical physical : agent.physical) physical.real.close();
        }
    }

    private static class FakeAgent extends AbstractJdbcAgent {
        final String url = "jdbc:h2:mem:legacy_" + UUID.randomUUID();
        final List<Physical> physical = new ArrayList<>();

        public boolean supportsNativeLegacyJobs() { return true; }
        protected String driverClass() { return "org.h2.Driver"; }
        protected String buildJdbcUrl(ConnectParams params) { return url; }
        protected Connection openConnection(ConnectParams params) throws Exception {
            Physical connection = new Physical(DriverManager.getConnection(url, "sa", ""));
            physical.add(connection);
            return connection.connection();
        }
        public List<DatabaseInfo> listDatabases() { return List.of(); }
        public List<String> listSchemas() { return List.of(); }
        public List<TableInfo> listTables(String schema) { return List.of(); }
        public List<ColumnInfo> getColumns(String schema, String table) { return List.of(); }
        public List<IndexInfo> listIndexes(String schema, String table) { return List.of(); }
        public List<ForeignKeyInfo> listForeignKeys(String schema, String table) { return List.of(); }
        public List<TriggerInfo> listTriggers(String schema, String table) { return List.of(); }
    }
    private static final class Physical {
        final Connection real;
        final List<String> events = new ArrayList<>();
        String failure = "", what, nextDate, interval, zone, broken;
        int commits, rollbacks, closes, outType;

        Physical(Connection real) { this.real = real; }

        void stage(String name) throws SQLException {
            events.add(name);
            if (failure.equals(name)) throw new SQLException("private body must not escape", "08006", 4007);
        }

        Connection connection() {
            return proxy(Connection.class, (p, m, a) -> {
                switch (m.getName()) {
                    case "getMetaData": {
                        DatabaseMetaData metadata = real.getMetaData();
                        return proxy(DatabaseMetaData.class, (mp, mm, ma) ->
                            mm.getName().equals("getDatabaseProductName") ? "OceanBase" : invoke(mm, metadata, ma));
                    }
                    case "commit": commits++; stage("commit"); break;
                    case "rollback": rollbacks++; stage("rollback"); break;
                    case "close": closes++; stage("close"); break;
                    case "prepareCall": return statement((String) a[0], CallableStatement.class);
                    case "prepareStatement":
                        if (((String) a[0]).contains("USER_JOBS") || ((String) a[0]).equals("SELECT USER AS DBX_SESSION_USER FROM DUAL")) {
                            return statement((String) a[0], PreparedStatement.class);
                        }
                        break;
                    case "createStatement": {
                        Statement actual = real.createStatement();
                        return proxy(Statement.class, (sp, sm, sa) -> {
                            if (sm.getName().equals("execute") && ((String) sa[0]).startsWith("ALTER SESSION SET CURRENT_SCHEMA")) {
                                stage("schema");
                                return false;
                            }
                            return invoke(sm, actual, sa);
                        });
                    }
                }
                return invoke(m, real, a);
            });
        }

        <T> T statement(String sql, Class<T> type) {
            Map<Integer, Object> bindings = new HashMap<>();
            return proxy(type, (p, m, a) -> switch (m.getName()) {
                case "setString", "setLong", "setInt" -> { bindings.put((int) a[0], a[1]); yield null; }
                case "setNull" -> { bindings.put((int) a[0], null); yield null; }
                case "registerOutParameter" -> { assertEquals(5, a[0]); outType = (int) a[1]; yield null; }
                case "getString" -> { stage("out-read"); yield "41"; }
                case "execute" -> {
                    if (sql.contains("DBMS_JOB.SUBMIT")) {
                        assertTrue(sql.contains("zone => ?"));
                        assertFalse(sql.contains("instance => ?"));
                        stage("submit");
                        what = (String) bindings.get(1);
                        nextDate = (String) bindings.get(2);
                        interval = (String) bindings.get(3);
                        zone = (String) bindings.get(4);
                    } else if (sql.contains("DBMS_JOB.NEXT_DATE")) {
                        stage("next-date");
                        assertEquals("41", bindings.get(1));
                        nextDate = (String) bindings.get(2);
                    } else {
                        assertTrue(sql.contains("DBMS_JOB.BROKEN"));
                        stage("broken");
                        assertEquals("41", bindings.get(1));
                        broken = (int) bindings.get(2) == 1 ? "Y" : "N";
                        assertEquals(nextDate, bindings.get(3));
                        if ("Y".equals(broken)) nextDate = "4000-01-01 00:00:00";
                    }
                    yield false;
                }
                case "executeQuery" -> {
                    if (sql.equals("SELECT USER AS DBX_SESSION_USER FROM DUAL")) yield rows(new String[]{"Owner"});
                    assertFalse(sql.contains("TO_CHAR(INSTANCE)"));
                    stage("read");
                    yield rows(new String[]{"41", failure.equals("mismatch") ? "different;" : what, nextDate, interval,
                        broken, failure.equals("zone-mismatch") ? "other-zone" : zone, "Owner", "Owner", "Owner"});
                }
                default -> defaultValue(m.getReturnType());
            });
        }

        ResultSet rows(String[] values) {
            int[] row = {0};
            return proxy(ResultSet.class, (p, m, a) -> switch (m.getName()) {
                case "next" -> ++row[0] == 1;
                case "getString" -> values[(int) a[0] - 1];
                default -> defaultValue(m.getReturnType());
            });
        }
    }

    private static Object invoke(java.lang.reflect.Method method, Object receiver, Object[] args) throws Throwable {
        try { return method.invoke(receiver, args); }
        catch (InvocationTargetException error) { throw error.getCause(); }
    }

    private static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(NativeLegacyJobTest.class.getClassLoader(), new Class<?>[]{type}, handler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
}
