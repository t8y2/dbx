package app.dbx.jdbc;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.StringReader;
import java.io.Writer;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

final class LargeResponseRecoveryTest {
    private static final int HOST_LINE_LIMIT = 64 * 1024 * 1024;

    @Test
    void oracleCancellationDefaultsToInBandWithoutOverridingAnExplicitProperty() throws Exception {
        var apply = DbxJdbcPlugin.class.getDeclaredMethod("applyOracleProperties",
            com.fasterxml.jackson.databind.JsonNode.class, java.util.Properties.class);
        apply.setAccessible(true);
        var connection = new ObjectMapper().createObjectNode();
        var defaults = new java.util.Properties();
        apply.invoke(null, connection, defaults);
        assertEquals("true", defaults.getProperty("oracle.net.disableOob"));
        var explicit = new java.util.Properties();
        explicit.setProperty("oracle.net.disableOob", "false");
        apply.invoke(null, connection, explicit);
        assertEquals("false", explicit.getProperty("oracle.net.disableOob"));
        assertNull(defaults.getProperty("oracle.jdbc.javaNetNio"));
    }

    @Test
    void oversizedDriverErrorIsAlsoBoundedAndKeepsItsRequestId() throws Exception {
        var mapper = new ObjectMapper();
        var response = mapper.createObjectNode().put("id", 17);
        response.set("error", mapper.createObjectNode().put("message", "x".repeat(HOST_LINE_LIMIT)));
        var write = DbxJdbcPlugin.class.getDeclaredMethod("writeResponse", BufferedWriter.class,
            com.fasterxml.jackson.databind.node.ObjectNode.class);
        write.setAccessible(true);
        LineCollector output = new LineCollector();
        write.invoke(null, new BufferedWriter(output), response);
        assertEquals(1, output.lines.size());
        assertTrue(output.lengths.get(0) < HOST_LINE_LIMIT);
        var error = mapper.readTree(output.lines.get(0));
        assertEquals(17, error.path("id").asInt());
        assertTrue(error.path("error").path("message").asText().contains("not retried"));
        assertFalse(error.has("result"));
    }

    @Test
    void oversizedLogicalPagePreservesOtherCursorsAndTheManualTransaction() throws Exception {
        try {
            call("openJdbcSession", "large");
            call("openJdbcSession", "survivor");
            call("connect", "large");
            call("connect", "survivor");
            call("executeQuery", "large", "CREATE TABLE IF NOT EXISTS PRESERVED(ID INT)");
            call("beginManualTransaction", "large");
            call("executeQuery", "large", "INSERT INTO PRESERVED VALUES(1)");
            var page = call("executeQueryPage", "survivor", "SELECT X FROM SYSTEM_RANGE(1,3)");
            String cursor = page.path("result").path("session_id").asText();
            assertFalse(cursor.isBlank(), page.toString());
            var oversized = call("executeQueryPage", "large", "SELECT CAST(REPEAT('x',67108864) AS CLOB) FROM SYSTEM_RANGE(1,2)");
            assertTrue(oversized.has("error"));
            var next = call("executeQuery", "large", "SELECT 42");
            assertEquals(42, next.path("result").path("rows").path(0).path(0).asInt());
            var params = params("survivor").put("sessionId", cursor);
            assertEquals(2, invoke("fetchQueryPage", params).path("result").path("rows").path(0).path(0).asInt());
            call("rollbackManualTransaction", "large");
            assertEquals(0, call("executeQuery", "large", "SELECT COUNT(*) FROM PRESERVED")
                .path("result").path("rows").path(0).path(0).asInt());
        } finally {
            call("closeJdbcSession", "large");
            call("closeJdbcSession", "survivor");
            invoke("close", new ObjectMapper().createObjectNode());
            var driverKey = DbxJdbcPlugin.class.getDeclaredField("logicalDriverKey");
            driverKey.setAccessible(true);
            driverKey.set(null, null);
        }
    }

    private static com.fasterxml.jackson.databind.node.ObjectNode params(String session) {
        var mapper = new ObjectMapper();
        var params = mapper.createObjectNode().put("jdbcSessionId", session).put("pageSize", 1).put("maxRows", 10);
        params.set("connection", mapper.createObjectNode().put("connection_string", "jdbc:h2:mem:large-logical;DB_CLOSE_DELAY=-1").put("jdbc_driver_class", "org.h2.Driver"));
        return params;
    }

    private static com.fasterxml.jackson.databind.JsonNode call(String method, String session) throws Exception {
        return invoke(method, params(session));
    }

    private static com.fasterxml.jackson.databind.JsonNode call(String method, String session, String sql) throws Exception {
        return invoke(method, params(session).put("sql", sql));
    }

    private static com.fasterxml.jackson.databind.JsonNode invoke(String method, com.fasterxml.jackson.databind.node.ObjectNode params) throws Exception {
        var request = new ObjectMapper().createObjectNode().put("id", 1).put("method", method);
        request.set("params", params);
        var handle = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handle.setAccessible(true);
        return (com.fasterxml.jackson.databind.JsonNode) handle.invoke(null, request.toString());
    }

    @Test
    void responseBudgetCountsUtf8EscapingAndTheLineTerminator() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        for (String value : List.of("plain", "中文", "🙂", "\"\\\n\r\t")) {
            var id = mapper.getNodeFactory().numberNode(1);
            var result = mapper.createObjectNode().put("value", value);
            var params = mapper.createObjectNode();
            var response = mapper.createObjectNode();
            response.set("id", id);
            response.set("result", result);
            int actual = mapper.writeValueAsBytes(response).length + 1;
            assertDoesNotThrow(() -> DbxJdbcPlugin.checkResponseBudget(id, result, params, actual));
            assertThrows(java.sql.SQLException.class,
                () -> DbxJdbcPlugin.checkResponseBudget(id, result, params, actual - 1));
        }
    }

    @Test
    void oversizedQueryReturnsAnErrorWithoutBreakingTheNextQuery() throws Exception {
        String connection = "\"connection\":{\"connection_string\":\"jdbc:h2:mem:large-response\",\"jdbc_driver_class\":\"org.h2.Driver\"}";
        String input = "{\"id\":1,\"method\":\"connect\",\"params\":{" + connection + "}}\n"
            + "{\"id\":2,\"method\":\"executeQuery\",\"params\":{" + connection
            + ",\"sql\":\"SELECT CAST(REPEAT('x',67108864) AS CLOB)\"}}\n"
            + "{\"id\":3,\"method\":\"executeQuery\",\"params\":{" + connection + ",\"sql\":\"SELECT 42\"}}\n"
            + "{\"id\":4,\"method\":\"close\",\"params\":{}}\n";
        LineCollector output = new LineCollector();
        try {
            DbxJdbcPlugin.serve(new BufferedReader(new StringReader(input)), new BufferedWriter(output));
            assertTrue(output.lengths.stream().allMatch(length -> length <= HOST_LINE_LIMIT),
                "No response may exceed the production host JSONL limit: " + output.lengths);
            ObjectMapper mapper = new ObjectMapper();
            var large = output.lines.stream().map(line -> {
                try { return mapper.readTree(line); }
                catch (Exception error) { throw new AssertionError(error); }
            }).filter(line -> line.path("id").asInt() == 2).findFirst().orElseThrow();
            assertTrue(large.has("error"), "The oversized result must fail explicitly");
            var next = output.lines.stream().filter(line -> line.contains("\"id\":3")).findFirst().orElseThrow();
            assertEquals(42, mapper.readTree(next).path("result").path("rows").path(0).path(0).asInt());
        } finally {
            var shuttingDown = DbxJdbcPlugin.class.getDeclaredField("shuttingDown");
            shuttingDown.setAccessible(true);
            shuttingDown.set(null, false);
        }
    }

    private static final class LineCollector extends Writer {
        final List<Long> lengths = new ArrayList<>();
        final List<String> lines = new ArrayList<>();
        private final StringBuilder prefix = new StringBuilder();
        private long length;

        @Override
        public void write(char[] chars, int offset, int count) {
            for (int i = offset; i < offset + count; i++) {
                char c = chars[i];
                length++;
                if (c == '\n') {
                    lengths.add(length);
                    lines.add(prefix.toString());
                    prefix.setLength(0);
                    length = 0;
                } else if (prefix.length() < 4096) {
                    prefix.append(c);
                }
            }
        }

        @Override public void flush() {}
        @Override public void close() {}
    }
}
