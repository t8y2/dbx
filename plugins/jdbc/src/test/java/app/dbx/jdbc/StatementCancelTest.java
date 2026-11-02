package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Statement;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

final class StatementCancelTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String SLOW_SQL =
        "SELECT COUNT(*) FROM SYSTEM_RANGE(1, 100000) A, SYSTEM_RANGE(1, 100000) B WHERE A.X + B.X > 0";

    private final Map<Integer, BlockingQueue<JsonNode>> responses = new ConcurrentHashMap<>();
    private BufferedWriter toPlugin;
    private Thread server;

    @AfterEach
    void stopServer() throws Exception {
        if (server == null) return;
        toPlugin.close();
        server.join(TimeUnit.SECONDS.toMillis(15));
        var shuttingDown = DbxJdbcPlugin.class.getDeclaredField("shuttingDown");
        shuttingDown.setAccessible(true);
        shuttingDown.set(null, false);
    }

    @Test
    void cancelStatementStopsTheAbandonedQuerySoTheNextOneRunsImmediately() throws Exception {
        startServer();
        assertNull(send(1, "connect", params()).path("error").textValue());

        ObjectNode slow = params().put("sql", SLOW_SQL).put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, "slow-token");
        write(2, "executeQuery", slow);
        Thread.sleep(500);
        assertNull(responses.get(2).peek(), "the slow query must still be running when it is cancelled");

        long started = System.nanoTime();
        ObjectNode staleCancel = MAPPER.createObjectNode().put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, "finished-token");
        assertFalse(send(3, DbxJdbcPlugin.CANCEL_STATEMENT_METHOD, staleCancel).path("result").path("cancelled").asBoolean());
        ObjectNode cancel = MAPPER.createObjectNode().put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, "slow-token");
        assertTrue(send(4, DbxJdbcPlugin.CANCEL_STATEMENT_METHOD, cancel).path("result").path("cancelled").asBoolean());

        JsonNode next = send(5, "executeQuery", params().put("sql", "SELECT 1"));
        assertEquals(1, next.path("result").path("rows").path(0).path(0).asInt(), next.toString());
        assertTrue(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started) < 5);
        assertTrue(await(2).has("error"), "the cancelled query reports an error");
    }

    @Test
    void cancelStatementRemembersARequestWhileItIsQueued() throws Exception {
        ExecutorService defaultRequests = Executors.newSingleThreadExecutor();
        startServer(defaultRequests);
        assertNull(send(1, "connect", params()).path("error").textValue());

        CountDownLatch workerBlocked = new CountDownLatch(1);
        CountDownLatch releaseWorker = new CountDownLatch(1);
        defaultRequests.execute(() -> {
            workerBlocked.countDown();
            try {
                releaseWorker.await();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        });
        assertTrue(workerBlocked.await(5, TimeUnit.SECONDS));

        try {
            ObjectNode queued = params()
                .put("sql", "CREATE TABLE CANCELLED_BEFORE_START(ID INT)")
                .put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, "queued-token");
            write(2, "executeQuery", queued);
            ObjectNode cancel = MAPPER.createObjectNode().put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, "queued-token");
            assertTrue(send(3, DbxJdbcPlugin.CANCEL_STATEMENT_METHOD, cancel)
                .path("result").path("cancelled").asBoolean());
        } finally {
            releaseWorker.countDown();
        }

        assertTrue(await(2).has("error"));
        JsonNode tables = send(4, "executeQuery", params().put(
            "sql",
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'CANCELLED_BEFORE_START'"
        ));
        assertEquals(0, tables.path("result").path("rows").path(0).path(0).asInt(), tables.toString());
    }

    @Test
    void cancelStatementUsesTheStatementCapturedWithTheMatchingToken() throws Exception {
        AtomicInteger abandonedCancels = new AtomicInteger();
        AtomicInteger replacementCancels = new AtomicInteger();
        Statement abandoned = statement(abandonedCancels);
        Statement replacement = statement(replacementCancels);
        DbxJdbcPlugin.CancellationRequest abandonedRequest = DbxJdbcPlugin.registerCancellationRequest(
            request(1, "abandoned-token")
        );
        DbxJdbcPlugin.CancellationRequest replacementRequest = DbxJdbcPlugin.registerCancellationRequest(
            request(2, "replacement-token")
        );
        DbxJdbcPlugin.trackActiveStatement(abandoned, abandonedRequest);

        CountDownLatch statementCaptured = new CountDownLatch(1);
        CountDownLatch replacementTracked = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread cancel = new Thread(() -> {
            try {
                DbxJdbcPlugin.StatementCancellation cancellation =
                    DbxJdbcPlugin.markCancellationRequested("abandoned-token");
                assertTrue(cancellation.matched());
                statementCaptured.countDown();
                assertTrue(replacementTracked.await(5, TimeUnit.SECONDS));
                DbxJdbcPlugin.cancelCapturedStatement(cancellation.statement());
            } catch (Throwable error) {
                failure.set(error);
            }
        });
        cancel.start();

        try {
            assertTrue(statementCaptured.await(5, TimeUnit.SECONDS));
            DbxJdbcPlugin.trackActiveStatement(replacement, replacementRequest);
            replacementTracked.countDown();
            cancel.join(TimeUnit.SECONDS.toMillis(5));
            assertFalse(cancel.isAlive());
            assertNull(failure.get());
            assertEquals(1, abandonedCancels.get());
            assertEquals(0, replacementCancels.get());
        } finally {
            replacementTracked.countDown();
            DbxJdbcPlugin.finishCancellationRequest(abandonedRequest);
            DbxJdbcPlugin.finishCancellationRequest(replacementRequest);
        }
    }

    @Test
    void cancellingAnActiveLobChunkPreservesOtherRefsAndIgnoresStaleTokens() throws Exception {
        var block = new java.util.concurrent.atomic.AtomicBoolean();
        var entered = new CountDownLatch(1);
        var cancelled = new CountDownLatch(1);
        var connection = DeferredLobValuesTest.connection(() -> {
            if (!block.get()) return;
            entered.countDown();
            try { assertTrue(cancelled.await(5, TimeUnit.SECONDS)); }
            catch (InterruptedException error) { throw new AssertionError(error); }
        }, cancelled::countDown);
        var stateField = DbxJdbcPlugin.class.getDeclaredField("DEFAULT_CONNECTION_STATE");
        stateField.setAccessible(true);
        Object state = stateField.get(null);
        var connectionField = state.getClass().getDeclaredField("sharedConnection");
        connectionField.setAccessible(true);
        var valuesField = state.getClass().getDeclaredField("largeValues");
        valuesField.setAccessible(true);
        var values = (DeferredLobValues) valuesField.get(state);
        values.clear();
        connectionField.set(state, connection);
        var first = values.capture(connection, new javax.sql.rowset.serial.SerialBlob(new byte[300]), false);
        var survivor = values.capture(connection, new javax.sql.rowset.serial.SerialBlob(new byte[300]), false);
        try {
            startServer();
            block.set(true);
            write(1, "read_large_value_chunk", params().put("valueRef", first.ref()).put("offset", 0).put("limit", 10).put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, "lob-token"));
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            assertFalse(send(2, DbxJdbcPlugin.CANCEL_STATEMENT_METHOD, MAPPER.createObjectNode().put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, "stale-token")).path("result").path("cancelled").asBoolean());
            assertEquals(1, cancelled.getCount());
            assertTrue(send(3, DbxJdbcPlugin.CANCEL_STATEMENT_METHOD, MAPPER.createObjectNode().put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, "lob-token")).path("result").path("cancelled").asBoolean());
            assertTrue(await(1).has("error"));
            block.set(false);
            assertEquals("expired", send(4, "read_large_value_chunk", params().put("valueRef", first.ref()).put("offset", 0).put("limit", 1)).path("result").path("status").asText());
            assertEquals("ok", send(5, "read_large_value_chunk", params().put("valueRef", survivor.ref()).put("offset", 0).put("limit", 1)).path("result").path("status").asText());
            assertFalse(send(6, DbxJdbcPlugin.CANCEL_STATEMENT_METHOD, MAPPER.createObjectNode().put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, "lob-token")).path("result").path("cancelled").asBoolean());
        } finally {
            block.set(false);
            cancelled.countDown();
            stopServer();
            server = null;
            values.clear();
            connectionField.set(state, null);
        }
    }

    private void startServer() throws Exception {
        startServer(Executors.newSingleThreadExecutor());
    }

    private void startServer(ExecutorService defaultRequests) throws Exception {
        PipedOutputStream hostOut = new PipedOutputStream();
        PipedInputStream pluginIn = new PipedInputStream(hostOut, 1 << 16);
        PipedOutputStream pluginOut = new PipedOutputStream();
        PipedInputStream hostIn = new PipedInputStream(pluginOut, 1 << 16);
        toPlugin = new BufferedWriter(new OutputStreamWriter(hostOut, StandardCharsets.UTF_8));
        server = new Thread(() -> {
            try (
                BufferedReader reader = new BufferedReader(new InputStreamReader(pluginIn, StandardCharsets.UTF_8));
                BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(pluginOut, StandardCharsets.UTF_8))
            ) {
                DbxJdbcPlugin.serve(reader, writer, defaultRequests);
            } catch (Exception ignored) {
                // The pipe closes when the test ends.
            }
        });
        server.setDaemon(true);
        server.start();
        Thread responseReader = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(hostIn, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    JsonNode response = MAPPER.readTree(line);
                    queue(response.path("id").asInt()).add(response);
                }
            } catch (Exception ignored) {
                // The pipe closes when the test ends.
            }
        });
        responseReader.setDaemon(true);
        responseReader.start();
    }

    private static ObjectNode params() {
        ObjectNode connection = MAPPER.createObjectNode();
        connection.put("connection_string", "jdbc:h2:mem:statement-cancel");
        connection.put("jdbc_driver_class", "org.h2.Driver");
        ObjectNode params = MAPPER.createObjectNode();
        params.set("connection", connection);
        return params;
    }

    private static ObjectNode request(int id, String token) {
        ObjectNode request = MAPPER.createObjectNode().put("id", id).put("method", "executeQuery");
        request.set("params", params().put(DbxJdbcPlugin.CANCEL_TOKEN_PARAM, token));
        return request;
    }

    private static Statement statement(AtomicInteger cancels) {
        return (Statement) Proxy.newProxyInstance(
            StatementCancelTest.class.getClassLoader(),
            new Class<?>[] { Statement.class },
            (proxy, method, args) -> {
                if ("cancel".equals(method.getName())) cancels.incrementAndGet();
                Class<?> returnType = method.getReturnType();
                if (!returnType.isPrimitive()) return null;
                if (returnType == boolean.class) return false;
                if (returnType == byte.class) return (byte) 0;
                if (returnType == short.class) return (short) 0;
                if (returnType == int.class) return 0;
                if (returnType == long.class) return 0L;
                if (returnType == float.class) return 0F;
                if (returnType == double.class) return 0D;
                if (returnType == char.class) return '\0';
                return null;
            }
        );
    }

    private BlockingQueue<JsonNode> queue(int id) {
        return responses.computeIfAbsent(id, ignored -> new LinkedBlockingQueue<>());
    }

    private void write(int id, String method, ObjectNode params) throws Exception {
        queue(id);
        ObjectNode request = MAPPER.createObjectNode().put("jsonrpc", "2.0").put("id", id).put("method", method);
        request.set("params", params);
        toPlugin.write(request.toString());
        toPlugin.newLine();
        toPlugin.flush();
    }

    private JsonNode send(int id, String method, ObjectNode params) throws Exception {
        write(id, method, params);
        return await(id);
    }

    private JsonNode await(int id) throws Exception {
        JsonNode response = queue(id).poll(10, TimeUnit.SECONDS);
        assertNotNull(response, "no response for request " + id);
        return response;
    }
}
