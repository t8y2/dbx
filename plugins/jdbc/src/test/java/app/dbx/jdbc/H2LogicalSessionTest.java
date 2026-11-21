package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.*;

final class H2LogicalSessionTest {
    static final ObjectMapper MAPPER = new ObjectMapper();
    static final List<Physical> PHYSICAL = new CopyOnWriteArrayList<>();
    final List<String> sessions = new ArrayList<>();

    @AfterEach
    void cleanup() throws Exception {
        for (String session : sessions) request(session, "closeJdbcSession", null);
        request(null, "close", null);
        var driverKey = DbxJdbcPlugin.class.getDeclaredField("logicalDriverKey");
        driverKey.setAccessible(true);
        driverKey.set(null, null);
        PHYSICAL.clear();
    }

    @Test
    void coldConcurrentConnectsShareTheFirstDriverRegistration() throws Exception {
        var driverField = DbxJdbcPlugin.class.getDeclaredField("registeredDriver");
        driverField.setAccessible(true);
        driverField.set(null, null);
        var pending = new ArrayList<java.util.concurrent.CompletableFuture<JsonNode>>();
        synchronized (DbxJdbcPlugin.class) {
            for (int sessionIndex = 0; sessionIndex < 8; sessionIndex++) {
                String sessionId = "cold-" + sessionIndex;
                sessions.add(sessionId);
                ok(request(sessionId, "openJdbcSession", null));
                pending.add(java.util.concurrent.CompletableFuture.supplyAsync(() -> {
                    try { return request(sessionId, "connect", null); }
                    catch (Exception error) { throw new RuntimeException(error); }
                }));
            }
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (logicalSessions().size() != 8 && System.nanoTime() < deadline) Thread.yield();
            assertEquals(8, logicalSessions().size());
        }
        for (var response : pending) ok(response.get(5, TimeUnit.SECONDS));
        assertEquals(8, PHYSICAL.size());
    }

    private static java.util.Map<?, ?> logicalSessions() throws Exception {
        var field = DbxJdbcPlugin.class.getDeclaredField("LOGICAL_SESSIONS");
        field.setAccessible(true);
        return (java.util.Map<?, ?>) field.get(null);
    }

    @Test
    void closedAndFailedSessionsDoNotAccumulateOrReopenOnLateRequests() throws Exception {
        connect("metadata");
        ok(request("metadata", "beginManualTransaction", null));
        for (int cycleIndex = 0; cycleIndex < 200; cycleIndex++) {
            String sessionId = "cycle-" + cycleIndex;
            connect(sessionId);
            ok(request(sessionId, "closeJdbcSession", null));
            ok(request(sessionId, "closeJdbcSession", null));
            assertTrue(request(sessionId, "connect", null).has("error"));
            assertTrue(request(sessionId, "executeQuery", "SELECT 1").has("error"));
            ObjectNode failed = params("failed-" + cycleIndex);
            ok(call("openJdbcSession", failed));
            ((ObjectNode) failed.path("connection")).put("connection_string", "jdbc:h2:file:fail");
            assertTrue(call("connect", failed).has("error"));
            assertEquals(1, logicalSessions().size());
        }
        assertEquals(201, PHYSICAL.size());
        assertFalse(PHYSICAL.get(0).autoCommit);
        assertFalse(PHYSICAL.get(0).closed);
        ok(request("metadata", "rollbackManualTransaction", null));
        ok(request("metadata", "closeJdbcSession", null));
        assertTrue(logicalSessions().isEmpty());
    }

    @Test
    void closeInvalidatesAConnectRetainedAtIngressBeforeItRuns() throws Exception {
        ok(request("queued", "openJdbcSession", null));
        ObjectNode queued = MAPPER.createObjectNode().put("id", 1).put("method", "connect");
        queued.set("params", params("queued"));
        Method retain = DbxJdbcPlugin.class.getDeclaredMethod("retainLogicalState", JsonNode.class);
        retain.setAccessible(true);
        Object retained = retain.invoke(null, queued);
        ok(request("queued", "closeJdbcSession", null));
        assertTrue(logicalSessions().isEmpty());
        Method handler = DbxJdbcPlugin.class.getDeclaredMethod("handleRequest", JsonNode.class, retained.getClass());
        handler.setAccessible(true);
        assertTrue(((JsonNode) handler.invoke(null, queued, retained)).has("error"));
        assertTrue(request("queued", "connect", null).has("error"));
        assertTrue(PHYSICAL.isEmpty());
    }

    @Test
    void closeDuringPhysicalConnectClosesOnlyItsRetainedConnection() throws Exception {
        connect("survivor");
        ok(request("in-flight", "openJdbcSession", null));
        FakeDriver.connectStarted = new CountDownLatch(1);
        FakeDriver.connectReleased = new CountDownLatch(1);
        ObjectNode connectingParams = params("in-flight");
        ((ObjectNode) connectingParams.path("connection")).put("connection_string", "jdbc:h2:file:slow");
        var connecting = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try { return call("connect", connectingParams); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
        assertTrue(FakeDriver.connectStarted.await(5, TimeUnit.SECONDS));
        var closing = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try { return request("in-flight", "closeJdbcSession", null); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (logicalSessions().size() != 1 && System.nanoTime() < deadline) Thread.yield();
        assertEquals(1, logicalSessions().size());
        assertTrue(request("in-flight", "connect", null).has("error"));
        ok(request("survivor", "executeQuery", "SELECT 1"));
        FakeDriver.connectReleased.countDown();
        connecting.get(5, TimeUnit.SECONDS);
        ok(closing.get(5, TimeUnit.SECONDS));
        assertEquals(2, PHYSICAL.size());
        assertTrue(PHYSICAL.get(1).closed);
        assertFalse(PHYSICAL.get(0).closed);
    }

    @Test
    void incompatibleDriverCannotReplaceTheLiveDriverOrClassLoader() throws Exception {
        connect("owner");
        var loaderField = DbxJdbcPlugin.class.getDeclaredField("registeredDriverClassLoader");
        loaderField.setAccessible(true);
        Object loader = loaderField.get(null);
        ObjectNode incompatible = params("different");
        ok(call("openJdbcSession", incompatible));
        ((ObjectNode) incompatible.path("connection")).put("jdbc_driver_class", "different.Driver");
        assertTrue(call("connect", incompatible).path("error").path("message").asText().contains("same selected driver"));
        assertSame(loader, loaderField.get(null));
        assertEquals(1, logicalSessions().size());
        assertFalse(PHYSICAL.get(0).closed);
        ok(request("owner", "executeQuery", "SELECT 1"));
    }

    @Test
    void isolatesConnectionsTransactionsAndCursorOwnership() throws Exception {
        connect("metadata");
        connect("tab-a");
        connect("tab-b");
        assertEquals(3, PHYSICAL.size());
        ok(request("tab-a", "beginManualTransaction", null));
        assertFalse(PHYSICAL.get(1).autoCommit);
        assertTrue(PHYSICAL.get(2).autoCommit);
        ok(request("tab-b", "beginManualTransaction", null));
        ok(request("tab-a", "commitManualTransaction", null));
        assertEquals(1, PHYSICAL.get(1).commits);
        assertEquals(0, PHYSICAL.get(2).commits);
        ok(request("tab-b", "rollbackManualTransaction", null));
        assertEquals(1, PHYSICAL.get(2).rollbacks);
        JsonNode page = request("tab-a", "executeQueryPage", "SELECT 1");
        ok(page);
        String cursor = page.path("result").path("session_id").asText();
        assertFalse(cursor.isBlank());
        ObjectNode params = params("tab-b").put("sessionId", cursor);
        assertTrue(call("fetchQueryPage", params).has("error"));
        params.put("jdbcSessionId", "tab-a");
        JsonNode next = call("fetchQueryPage", params);
        ok(next);
        assertEquals(2, next.path("result").path("rows").path(0).path(0).asInt());
        ok(call("closeQuerySession", params));
        assertTrue(call("fetchQueryPage", params).has("error"));
        ok(request("tab-a", "closeJdbcSession", null));
        assertTrue(PHYSICAL.get(1).closed);
        assertFalse(PHYSICAL.get(0).closed);
        assertFalse(PHYSICAL.get(2).closed);
        ok(request("tab-b", "executeQuery", "SELECT 1"));
    }

    @Test
    void failedConnectAndCancellationDoNotCloseOtherSessions() throws Exception {
        connect("survivor");
        ObjectNode bad = params("failed");
        ok(call("openJdbcSession", bad));
        ((ObjectNode) bad.path("connection")).put("connection_string", "jdbc:h2:file:fail");
        assertTrue(call("connect", bad).has("error"));
        assertFalse(PHYSICAL.get(0).closed);
        connect("cancelled");
        Physical cancelled = PHYSICAL.get(1);
        var query = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try { return request("cancelled", "executeQuery", "WAIT"); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
        assertTrue(cancelled.started.await(5, TimeUnit.SECONDS));
        ok(request("survivor", "executeQuery", "SELECT 1"));
        ok(request("cancelled", "closeJdbcSession", null));
        assertTrue(query.get(5, TimeUnit.SECONDS).has("error"));
        assertTrue(cancelled.closed);
        assertFalse(PHYSICAL.get(0).closed);
        assertTrue(request("cancelled", "executeQuery", "SELECT 1").has("error"));
        ok(request("survivor", "executeQuery", "SELECT 1"));
    }

    @Test
    void processColdStartAcceptsEightConnectsBeforeResponsesAreRead() throws Exception {
        Process process = startProcess();
        try (var writer = new java.io.BufferedWriter(new java.io.OutputStreamWriter(process.getOutputStream()));
             var reader = new java.io.BufferedReader(new java.io.InputStreamReader(process.getInputStream()))) {
            for (int sessionIndex = 0; sessionIndex < 8; sessionIndex++) {
                send(writer, sessionIndex, "openJdbcSession", params("cold-" + sessionIndex));
                ok(read(reader));
            }
            for (int sessionIndex = 0; sessionIndex < 8; sessionIndex++) {
                send(writer, sessionIndex + 8, "connect", params("cold-" + sessionIndex));
            }
            java.util.Set<Integer> responseIds = new java.util.HashSet<>();
            for (int responseIndex = 0; responseIndex < 8; responseIndex++) {
                JsonNode response = read(reader);
                ok(response);
                assertTrue(responseIds.add(response.path("id").asInt()));
            }
            send(writer, 16, "close", MAPPER.createObjectNode());
            ok(read(reader));
            assertTrue(process.waitFor(5, TimeUnit.SECONDS));
            assertEquals(0, process.exitValue());
        } finally {
            process.destroyForcibly();
        }
    }

    private Process startProcess() throws Exception {
        java.util.Set<String> paths = new java.util.LinkedHashSet<>();
        for (Class<?> type : List.of(DbxJdbcPlugin.class, getClass(), ObjectMapper.class,
            com.fasterxml.jackson.core.JsonFactory.class, com.fasterxml.jackson.annotation.JsonProperty.class)) {
            paths.add(java.nio.file.Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI()).toString());
        }
        for (ClassLoader loader = getClass().getClassLoader(); loader != null; loader = loader.getParent()) {
            if (loader instanceof java.net.URLClassLoader urls) {
                for (java.net.URL url : urls.getURLs()) paths.add(java.nio.file.Path.of(url.toURI()).toString());
            }
        }
        return new ProcessBuilder(
            java.nio.file.Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-cp", String.join(java.io.File.pathSeparator, paths), DbxJdbcPlugin.class.getName()
        ).redirectError(ProcessBuilder.Redirect.INHERIT).start();
    }

    @Test
    void processDispatchesOtherSessionsAndCancellationWhileQueryRuns() throws Exception {
        Process process = startProcess();
        try (var writer = new java.io.BufferedWriter(new java.io.OutputStreamWriter(process.getOutputStream()));
             var reader = new java.io.BufferedReader(new java.io.InputStreamReader(process.getInputStream()))) {
            send(writer, 10, "openJdbcSession", params("a"));
            ok(read(reader));
            send(writer, 1, "connect", params("a"));
            ok(read(reader));
            send(writer, 11, "openJdbcSession", params("b"));
            ok(read(reader));
            send(writer, 2, "connect", params("b"));
            ok(read(reader));
            send(writer, 3, "executeQuery", params("a").put("sql", "WAIT"));
            send(writer, 4, "executeQuery", params("b").put("sql", "SELECT 1"));
            JsonNode survivor = read(reader);
            assertEquals(4, survivor.path("id").asInt());
            ok(survivor);
            send(writer, 5, "closeJdbcSession", params("a"));
            JsonNode first = read(reader);
            JsonNode second = read(reader);
            assertTrue(first.has("error") || second.has("error"));
            send(writer, 6, "closeJdbcSession", params("b"));
            ok(read(reader));
            send(writer, 7, "close", MAPPER.createObjectNode());
            ok(read(reader));
            assertTrue(process.waitFor(5, TimeUnit.SECONDS));
            assertEquals(0, process.exitValue());
        } finally {
            process.destroyForcibly();
        }
    }

    private static void send(java.io.BufferedWriter writer, int id, String method, ObjectNode params) throws Exception {
        ObjectNode request = MAPPER.createObjectNode().put("id", id).put("method", method);
        request.set("params", params);
        writer.write(request.toString());
        writer.newLine();
        writer.flush();
    }

    private static JsonNode read(java.io.BufferedReader reader) throws Exception {
        String line = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try { return reader.readLine(); }
            catch (java.io.IOException error) { throw new RuntimeException(error); }
        }).get(5, TimeUnit.SECONDS);
        assertNotNull(line);
        return MAPPER.readTree(line);
    }

    void connect(String session) throws Exception {
        sessions.add(session);
        ok(request(session, "openJdbcSession", null));
        ok(request(session, "connect", null));
    }

    static void ok(JsonNode response) { assertFalse(response.has("error"), response.toString()); }

    static ObjectNode params(String session) {
        ObjectNode config = MAPPER.createObjectNode();
        config.put("connection_string", "jdbc:h2:file:sample");
        config.put("jdbc_driver_class", FakeDriver.class.getName());
        ObjectNode params = MAPPER.createObjectNode();
        params.set("connection", config);
        if (session != null) params.put("jdbcSessionId", session);
        params.put("pageSize", 1);
        return params;
    }

    static JsonNode request(String session, String method, String sql) throws Exception {
        ObjectNode params = params(session);
        if (sql != null) params.put("sql", sql);
        return call(method, params);
    }

    static JsonNode call(String name, ObjectNode params) throws Exception {
        Method handler = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handler.setAccessible(true);
        ObjectNode request = MAPPER.createObjectNode().put("id", 1).put("method", name);
        request.set("params", params);
        return (JsonNode) handler.invoke(null, request.toString());
    }

    public static final class FakeDriver implements Driver {
        static volatile CountDownLatch connectStarted;
        static volatile CountDownLatch connectReleased;
        public Connection connect(String url, Properties properties) throws SQLException {
            if (!acceptsURL(url)) return null;
            if (url.endsWith("fail")) throw new SQLException("connect failed");
            if (url.endsWith("slow")) {
                connectStarted.countDown();
                try {
                    if (!connectReleased.await(5, TimeUnit.SECONDS)) throw new SQLException("connect timed out");
                } catch (InterruptedException error) {
                    throw new SQLException(error);
                }
            }
            Physical physical = new Physical();
            PHYSICAL.add(physical);
            return physical.connection();
        }
        public boolean acceptsURL(String url) { return url.startsWith("jdbc:h2:file:"); }
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties properties) { return new DriverPropertyInfo[0]; }
        public int getMajorVersion() { return 1; }
        public int getMinorVersion() { return 0; }
        public boolean jdbcCompliant() { return true; }
        public Logger getParentLogger() { return Logger.getGlobal(); }
    }

    static final class Physical {
        boolean autoCommit = true;
        boolean closed;
        int commits;
        int rollbacks;
        final CountDownLatch started = new CountDownLatch(1);
        final CountDownLatch cancelled = new CountDownLatch(1);

        Connection connection() {
            return proxy(Connection.class, (proxyInstance, invokedMethod, arguments) -> switch (invokedMethod.getName()) {
                case "getAutoCommit" -> autoCommit;
                case "setAutoCommit" -> { autoCommit = (boolean) arguments[0]; yield null; }
                case "isClosed" -> closed;
                case "close" -> { closed = true; yield null; }
                case "commit" -> { commits++; yield null; }
                case "rollback" -> { rollbacks++; yield null; }
                case "createStatement" -> statement();
                default -> defaultValue(invokedMethod.getReturnType());
            });
        }

        Statement statement() {
            ResultSet rs = resultSet();
            return proxy(Statement.class, (proxyInstance, invokedMethod, arguments) -> switch (invokedMethod.getName()) {
                case "execute" -> {
                    if ("WAIT".equals(arguments[0])) {
                        started.countDown();
                        if (!cancelled.await(5, TimeUnit.SECONDS)) throw new SQLException("cancel timed out");
                        throw new SQLException("statement cancelled");
                    }
                    yield true;
                }
                case "getResultSet" -> rs;
                case "cancel" -> { cancelled.countDown(); yield null; }
                default -> defaultValue(invokedMethod.getReturnType());
            });
        }

        ResultSet resultSet() {
            int[] row = { 0 };
            ResultSetMetaData meta = proxy(ResultSetMetaData.class, (proxyInstance, invokedMethod, arguments) -> switch (invokedMethod.getName()) {
                case "getColumnCount" -> 1;
                case "getColumnType" -> Types.INTEGER;
                case "getColumnName", "getColumnLabel" -> "value";
                default -> defaultValue(invokedMethod.getReturnType());
            });
            return proxy(ResultSet.class, (proxyInstance, invokedMethod, arguments) -> switch (invokedMethod.getName()) {
                case "next" -> ++row[0] <= 3;
                case "getMetaData" -> meta;
                case "getObject" -> row[0];
                default -> defaultValue(invokedMethod.getReturnType());
            });
        }
    }

    static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(H2LogicalSessionTest.class.getClassLoader(), new Class<?>[] { type }, handler));
    }

    static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
}
