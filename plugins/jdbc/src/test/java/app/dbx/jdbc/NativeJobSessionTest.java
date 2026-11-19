package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.UUID;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.*;

final class NativeJobSessionTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<Physical> PHYSICAL = new ArrayList<>();
    private final List<String> sessions = new ArrayList<>();
    private final ObjectNode connection = MAPPER.createObjectNode()
        .put("connection_string", "jdbc:dbx-job:" + UUID.randomUUID())
        .put("jdbc_driver_class", TrackingDriver.class.getName()).put("username", "sa").put("password", "");

    @AfterEach
    void cleanup() throws Exception {
        for (String session : sessions) call("closeJdbcSession", params(session));
        call("close", MAPPER.createObjectNode());
        var logicalDriverKey = DbxJdbcPlugin.class.getDeclaredField("logicalDriverKey");
        logicalDriverKey.setAccessible(true);
        logicalDriverKey.set(null, null);
        PHYSICAL.clear();
    }

    @Test
    void protocolAdvertisesConnectionOwnershipWithoutOpeningADatabase() throws Exception {
        JsonNode protocol = result(call("jdbcSessionProtocol", params(null)));
        assertTrue(protocol.path("capabilities").toString().contains("native_job_session_v1"));
        assertTrue(PHYSICAL.isEmpty());
    }

    @Test
    void defaultAndLogicalRoutesKeepOnePhysicalConnectionAcrossInternalCommitsAndExactSql() throws Exception {
        for (String session : new String[]{null, "owned"}) {
            openLogical(session);
            ObjectNode open = params(session).put("operationId", "operation");
            JsonNode opened = result(call("openNativeJobSession", open));
            assertEquals("opened", opened.path("phase").asText());
            Physical physical = PHYSICAL.getLast();
            assertFalse(physical.connection.getAutoCommit());
            assertEquals(opened, result(call("open_native_job_session", open)));
            int count = PHYSICAL.size();
            String table = session == null ? "default_job_session_probe" : "logical_job_session_probe";
            query(session, opened, "CREATE TABLE " + table + " (id INT)");
            query(session, opened, "INSERT INTO " + table + " VALUES (1)");
            query(session, opened, "COMMIT");
            String exact = " SELECT ';' AS marker; ";
            assertEquals(";", query(session, opened, exact).path("rows").path(0).path(0).asText());
            assertEquals(exact, physical.sql.getLast(), "native SQL must not be trimmed, rewritten or retried");
            assertEquals(1, query(session, opened, "SELECT COUNT(*) FROM " + table).path("rows").path(0).path(0).asInt());
            assertFalse(physical.connection.getAutoCommit());
            assertEquals(count, PHYSICAL.size());
            JsonNode closed = close(session, opened);
            assertEquals("closed", closed.path("phase").asText());
            assertEquals(closed, close(session, opened));
            assertEquals(1, physical.closes);
            assertEquals(0, physical.commits);
            assertEquals(0, physical.rollbacks);
            assertTrue(physical.connection.isClosed());
        }
    }

    @Test
    void reservationRejectsOrdinaryQueriesForeignTokensConfigurationChangesAndOtherProtocols() throws Exception {
        openLogical("owned");
        JsonNode opened = result(call("openNativeJobSession", params("owned").put("operationId", "operation")));
        Physical physical = PHYSICAL.getLast();
        for (String method : List.of("connect", "testConnection", "beginManualTransaction", "executeQueryPage", "prepareLegacyJob")) {
            JsonNode rejected = call(method, params("owned"));
            assertTrue(rejected.has("error") || rejected.path("result").path("phase").asText().equals("unknown"), method);
        }
        assertTrue(call("executeQuery", params("owned").put("sql", "SELECT 1")).has("error"));
        ObjectNode changed = authorized("owned", opened).put("sql", "SELECT 1");
        ((ObjectNode) changed.path("connection")).put("username", "other");
        assertTrue(call("executeQuery", changed).has("error"));
        ObjectNode token = authorized("owned", opened).put("sql", "SELECT 1").put("nativeJobSessionToken", "foreign");
        assertTrue(call("executeQuery", token).has("error"));
        ObjectNode driver = authorized("owned", opened).put("sql", "SELECT 1");
        ((ObjectNode) driver.path("connection")).put("jdbc_driver_class", "foreign.Driver");
        assertTrue(call("executeQuery", driver).has("error"));
        assertEquals(1, query("owned", opened, "SELECT 1").path("rows").path(0).path(0).asInt());
        assertEquals(1, PHYSICAL.size());
        assertEquals(List.of("SELECT 1"), physical.sql);
    }

    @Test
    void aClosedConnectionAndItsOldTokenCannotReopenOnEitherRoute() throws Exception {
        for (String session : new String[]{null, "lost"}) {
            openLogical(session);
            JsonNode opened = result(call("openNativeJobSession", params(session).put("operationId", "operation")));
            PHYSICAL.getLast().connection.close();
            assertTrue(call("executeQuery", authorized(session, opened).put("sql", "SELECT 1")).has("error"));
            int count = PHYSICAL.size();
            String replacement = session == null ? "replacement-default" : "replacement-logical";
            openLogical(replacement);
            assertTrue(call("executeQuery", authorized(replacement, opened).put("sql", "SELECT 1")).has("error"));
            assertEquals(count, PHYSICAL.size());
            if (session == null) call("close", MAPPER.createObjectNode());
        }
    }

    @Test
    void unknownPhysicalCloseIsCachedAndReportedByDefaultAndLogicalCleanup() throws Exception {
        for (String session : new String[]{null, "close-unknown"}) {
            openLogical(session);
            JsonNode opened = result(call("openNativeJobSession", params(session).put("operationId", "operation")));
            Physical physical = PHYSICAL.getLast();
            physical.failClose = true;
            JsonNode unknown = close(session, opened);
            assertEquals("unknown", unknown.path("phase").asText());
            assertEquals(unknown, close(session, opened));
            assertEquals(1, physical.closes);
            JsonNode cleanup = call(session == null ? "close" : "closeJdbcSession",
                session == null ? MAPPER.createObjectNode() : params(session));
            assertTrue(cleanup.has("error"));
            assertEquals(1, physical.closes);
        }
    }

    @Test
    void globalCloseDoesNotForgetUnknownDisposalInAnOwnedLogicalMember() throws Exception {
        openLogical("unknown-member");
        result(call("openNativeJobSession", params("unknown-member").put("operationId", "operation")));
        PHYSICAL.getLast().failClose = true;
        assertTrue(call("close", MAPPER.createObjectNode()).has("error"));
        assertEquals(1, PHYSICAL.getLast().closes);
    }

    @Test
    void lostOpenResponseCanDisposeOnlyItsKnownOperationWithoutTheToken() throws Exception {
        openLogical("lost-open");
        result(call("openNativeJobSession", params("lost-open").put("operationId", "operation")));
        JsonNode wrong = call("closeNativeJobSession", params("lost-open").put("operationId", "other"));
        assertNotEquals("closed", wrong.path("result").path("phase").asText());
        JsonNode closed = result(call("close_native_job_session", params("lost-open").put("operationId", "operation")));
        assertEquals("closed", closed.path("phase").asText());
        assertEquals(1, PHYSICAL.getLast().closes);
    }

    @Test
    void anEditorTransactionSurvivesRejectedOwnershipAndRemainsUsable() throws Exception {
        openLogical("editor");
        result(call("beginManualTransaction", params("editor")));
        Physical editor = PHYSICAL.getLast();
        JsonNode denied = call("openNativeJobSession", params("editor").put("operationId", "operation"));
        assertNotEquals("opened", denied.path("result").path("phase").asText());
        assertFalse(editor.connection.isClosed());
        assertFalse(editor.connection.getAutoCommit());
        assertEquals(0, editor.closes);
        result(call("rollbackManualTransaction", params("editor")));
        assertEquals("opened", result(call("openNativeJobSession", params("editor").put("operationId", "operation"))).path("phase").asText());
    }

    @Test
    void anOpenCursorSurvivesRejectionThenReleasesItsConnectionForNativeOwnership() throws Exception {
        openLogical("cursor");
        JsonNode page = result(call("executeQueryPage", params("cursor")
            .put("sql", "SELECT X FROM SYSTEM_RANGE(1, 3)").put("pageSize", 1)));
        String cursor = page.path("session_id").asText();
        assertFalse(cursor.isEmpty());
        Physical physical = PHYSICAL.getLast();
        JsonNode denied = result(call("openNativeJobSession", params("cursor").put("operationId", "operation")));
        assertEquals("native_job_session_busy", denied.path("reason").asText());
        assertEquals(0, physical.closes);
        result(call("fetchQueryPage", params("cursor").put("sessionId", cursor).put("pageSize", 1)));
        result(call("closeQuerySession", params("cursor").put("sessionId", cursor)));
        assertEquals("opened", result(call("openNativeJobSession", params("cursor").put("operationId", "operation"))).path("phase").asText());
        assertEquals(1, PHYSICAL.size());
    }

    private void openLogical(String session) throws Exception {
        if (session == null) return;
        sessions.add(session);
        result(call("openJdbcSession", params(session)));
    }

    private ObjectNode params(String session) {
        ObjectNode params = MAPPER.createObjectNode();
        params.set("connection", connection.deepCopy());
        if (session != null) params.put("jdbcSessionId", session);
        return params;
    }

    private ObjectNode authorized(String session, JsonNode opened) {
        return params(session).put("nativeJobOperationId", opened.path("operationId").asText())
            .put("nativeJobSessionToken", opened.path("sessionToken").asText());
    }

    private JsonNode query(String session, JsonNode opened, String sql) throws Exception {
        return result(call("executeQuery", authorized(session, opened).put("sql", sql)));
    }

    private JsonNode close(String session, JsonNode opened) throws Exception {
        return result(call("closeNativeJobSession", params(session).put("operationId", opened.path("operationId").asText())
            .put("sessionToken", opened.path("sessionToken").asText())));
    }

    private static JsonNode call(String method, ObjectNode params) throws Exception {
        ObjectNode request = MAPPER.createObjectNode().put("id", 1).put("method", method);
        request.set("params", params);
        var entry = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        entry.setAccessible(true);
        return (JsonNode) entry.invoke(null, request.toString());
    }

    private static JsonNode result(JsonNode response) {
        assertFalse(response.has("error"), response.toString());
        return response.path("result");
    }

    private static final class Physical {
        Connection connection;
        boolean failClose;
        int commits;
        int rollbacks;
        int closes;
        final List<String> sql = new ArrayList<>();
    }

    public static final class TrackingDriver implements Driver {
        @Override public boolean acceptsURL(String url) { return url != null && url.startsWith("jdbc:dbx-job:"); }
        @Override public Connection connect(String url, Properties properties) throws SQLException {
            if (!acceptsURL(url)) return null;
            Connection real = DriverManager.getConnection("jdbc:h2:mem:" + url.substring("jdbc:dbx-job:".length())
                + ";DB_CLOSE_DELAY=-1", properties);
            Physical physical = new Physical();
            physical.connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class},
                (proxy, method, arguments) -> {
                    if ("commit".equals(method.getName())) physical.commits++;
                    if ("rollback".equals(method.getName())) physical.rollbacks++;
                    if ("close".equals(method.getName())) physical.closes++;
                    try {
                        Object value = method.invoke(real, arguments);
                        if ("close".equals(method.getName()) && physical.failClose) throw new SQLException("close acknowledgement lost", "08006");
                        if ("createStatement".equals(method.getName())) {
                            Statement statement = (Statement) value;
                            return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Statement.class}, (p, m, args) -> {
                                if (m.getName().startsWith("execute") && args != null && args.length > 0 && args[0] instanceof String sql) physical.sql.add(sql);
                                try { return m.invoke(statement, args); }
                                catch (InvocationTargetException error) { throw error.getCause(); }
                            });
                        }
                        return value;
                    } catch (InvocationTargetException error) { throw error.getCause(); }
                });
            PHYSICAL.add(physical);
            return physical.connection;
        }
        @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties properties) { return new DriverPropertyInfo[0]; }
        @Override public int getMajorVersion() { return 1; }
        @Override public int getMinorVersion() { return 0; }
        @Override public boolean jdbcCompliant() { return false; }
        @Override public Logger getParentLogger() { return Logger.getGlobal(); }
    }
}
