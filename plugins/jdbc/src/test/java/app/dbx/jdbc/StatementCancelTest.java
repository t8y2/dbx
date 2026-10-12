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
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

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

    private void startServer() throws Exception {
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
                DbxJdbcPlugin.serve(reader, writer);
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
