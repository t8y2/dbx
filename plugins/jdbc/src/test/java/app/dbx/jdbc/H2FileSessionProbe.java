package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

public final class H2FileSessionProbe {
    private static final ObjectMapper JSON = new ObjectMapper();

    public static void main(String[] args) throws Exception {
        if (args.length != 4) throw new IllegalArgumentException("plugin.jar h2-2.1.214.jar temporary-directory baseline|patched|cold");
        Path plugin = Path.of(args[0]).toAbsolutePath();
        Path driver = Path.of(args[1]).toAbsolutePath();
        Path directory = Path.of(args[2]).toAbsolutePath();
        Files.createDirectories(directory);
        ObjectNode connection = JSON.createObjectNode();
        connection.put("connection_string", "jdbc:h2:file:" + directory.resolve("ownership") + ";LOCK_TIMEOUT=2000");
        connection.put("jdbc_driver_class", "org.h2.Driver");
        connection.putArray("jdbc_driver_paths").add(driver.toString());
        connection.put("username", "sa");
        if (args[3].equals("cold")) {
            coldConcurrentStarts(plugin, connection, directory);
            return;
        }
        try (Sidecar owner = new Sidecar(plugin)) {
            if (args[3].equals("baseline")) {
                owner.ok("connect", params(connection, null));
                owner.ok("executeQuery", params(connection, null).put("sql", "CREATE TABLE IF NOT EXISTS test(id INT PRIMARY KEY)"));
                try (Sidecar competitor = new Sidecar(plugin)) {
                    JsonNode locked = competitor.call("connect", params(connection, null));
                    check(locked.has("error"), "baseline unexpectedly opened the same file in two JVMs");
                    check(locked.path("error").path("message").asText().toLowerCase().matches("(?s).*(lock|already in use).*"), locked.toString());
                    System.out.println("PASS baseline metadata JVM opens file; tab JVM reports file ownership error");
                }
                return;
            }
            check(owner.ok("jdbcSessionProtocol", JSON.createObjectNode()).path("version").asInt() == 2, "logical session protocol");
            for (String session : List.of("metadata", "a", "b")) {
                owner.ok("openJdbcSession", params(connection, session));
                owner.ok("connect", params(connection, session));
            }
            query(owner, connection, "metadata", "DROP TABLE IF EXISTS test");
            query(owner, connection, "metadata", "CREATE TABLE test(id INT PRIMARY KEY)");
            owner.ok("listTables", params(connection, "metadata").put("schema", "PUBLIC"));
            for (String session : List.of("a", "b")) owner.ok("beginManualTransaction", params(connection, session));
            owner.ok("executeInManualTransaction", params(connection, "a").put("sql", "INSERT INTO test VALUES(1)"));
            owner.ok("executeInManualTransaction", params(connection, "b").put("sql", "INSERT INTO test VALUES(2)"));
            check(count(owner, connection, "metadata") == 0, "uncommitted rows leaked");
            owner.ok("commitManualTransaction", params(connection, "a"));
            check(count(owner, connection, "metadata") == 1, "commit affected another transaction");
            owner.ok("rollbackManualTransaction", params(connection, "b"));
            check(count(owner, connection, "metadata") == 1, "rollback affected committed row");
            query(owner, connection, "b", "INSERT INTO test VALUES(3),(4)");
            JsonNode page = owner.ok("executeQueryPage", params(connection, "a").put("sql", "SELECT id FROM test ORDER BY id").put("pageSize", 1));
            String cursor = page.path("session_id").asText();
            check(owner.call("fetchQueryPage", params(connection, "b").put("sessionId", cursor)).has("error"), "foreign cursor accepted");
            check(owner.ok("fetchQueryPage", params(connection, "a").put("sessionId", cursor).put("pageSize", 1)).path("rows").path(0).path(0).asInt() == 3, "cursor paging");
            owner.ok("closeQuerySession", params(connection, "a").put("sessionId", cursor));
            check(owner.call("fetchQueryPage", params(connection, "a").put("sessionId", cursor)).has("error"), "closed cursor accepted");
            ObjectNode missing = connection.deepCopy();
            missing.put("connection_string", "jdbc:h2:file:" + directory.resolve("missing") + ";IFEXISTS=TRUE");
            owner.ok("openJdbcSession", params(missing, "failed"));
            check(owner.call("connect", params(missing, "failed")).has("error"), "failed connection accepted");
            check(count(owner, connection, "b") == 3, "failed connect broke another session");
            ObjectNode other = connection.deepCopy();
            other.put("connection_string", "jdbc:h2:file:" + directory.resolve("separate"));
            owner.ok("openJdbcSession", params(other, "other"));
            owner.ok("connect", params(other, "other"));
            check(owner.call("executeQuery", params(other, "other").put("sql", "SELECT * FROM test")).has("error"), "separate files were conflated");
            owner.ok("closeJdbcSession", params(other, "other"));
            try (Sidecar competitor = new Sidecar(plugin)) {
                check(competitor.call("connect", params(connection, null)).has("error"), "file locking was disabled");
            }
            owner.ok("beginManualTransaction", params(connection, "a"));
            owner.ok("executeInManualTransaction", params(connection, "a").put("sql", "INSERT INTO test VALUES(99)"));
            owner.send("executeInManualTransaction", params(connection, "a").put("sql", "SELECT SUM(X) FROM SYSTEM_RANGE(1, 1000000000)"));
            Thread.sleep(100);
            owner.send("closeJdbcSession", params(connection, "a"));
            JsonNode first = owner.read();
            JsonNode second = owner.read();
            check(first.has("error") || second.has("error"), "cancellation did not reach the active statement");
            check(count(owner, connection, "b") == 3, "cancelled transaction was not rolled back independently");
            owner.ok("closeJdbcSession", params(connection, "b"));
            check(count(owner, connection, "metadata") == 3, "closing tab broke metadata");
            owner.ok("closeJdbcSession", params(connection, "metadata"));
            System.out.println("PASS patched shared JVM: independent transactions, cursors, cancellation, failures, files and locks");
        }
        try (Sidecar reopened = new Sidecar(plugin)) {
            reopened.ok("openJdbcSession", params(connection, "reopened"));
            reopened.ok("connect", params(connection, "reopened"));
            check(count(reopened, connection, "reopened") == 3, "last-runtime teardown/reopen");
            reopened.ok("closeJdbcSession", params(connection, "reopened"));
        }
        System.out.println("PASS final runtime teardown and file reopen");
        coldConcurrentStarts(plugin, connection, directory);
    }

    private static void coldConcurrentStarts(Path plugin, ObjectNode connection, Path directory) throws Exception {
        for (int attemptIndex = 0; attemptIndex < 5; attemptIndex++) {
            ObjectNode coldConnection = connection.deepCopy();
            coldConnection.put("connection_string", "jdbc:h2:file:" + directory.resolve("cold-" + attemptIndex));
            try (Sidecar owner = new Sidecar(plugin)) {
                for (int sessionIndex = 0; sessionIndex < 8; sessionIndex++) {
                    owner.ok("openJdbcSession", params(coldConnection, "cold-" + sessionIndex));
                }
                for (int sessionIndex = 0; sessionIndex < 8; sessionIndex++) {
                    owner.send("connect", params(coldConnection, "cold-" + sessionIndex));
                }
                java.util.Set<Long> responseIds = new java.util.HashSet<>();
                for (int responseIndex = 0; responseIndex < 8; responseIndex++) {
                    JsonNode response = owner.read();
                    check(!response.has("error"), "cold start: " + response);
                    check(responseIds.add(response.path("id").asLong()), "duplicate connect response");
                }
                for (int sessionIndex = 0; sessionIndex < 8; sessionIndex++) {
                    String sessionId = "cold-" + sessionIndex;
                    query(owner, coldConnection, sessionId, "SELECT 1");
                    owner.ok("closeJdbcSession", params(coldConnection, sessionId));
                    check(owner.call("connect", params(coldConnection, sessionId)).has("error"), "late connect reopened closed session");
                }
            }
        }
        System.out.println("PASS cold concurrent starts: five fresh JVMs, eight connects each, late connects rejected");
    }

    private static int count(Sidecar process, ObjectNode connection, String session) throws Exception {
        return query(process, connection, session, "SELECT COUNT(*) FROM test").path("rows").path(0).path(0).asInt();
    }

    private static JsonNode query(Sidecar process, ObjectNode connection, String session, String sql) throws Exception {
        return process.ok("executeQuery", params(connection, session).put("sql", sql));
    }

    private static ObjectNode params(ObjectNode connection, String session) {
        ObjectNode params = JSON.createObjectNode();
        params.set("connection", connection);
        if (session != null) params.put("jdbcSessionId", session);
        return params;
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static final class Sidecar implements AutoCloseable {
        final Process process;
        final BufferedReader input;
        final BufferedWriter output;
        long id;

        Sidecar(Path plugin) throws Exception {
            List<String> command = new ArrayList<>();
            command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
            command.add("-jar");
            command.add(plugin.toString());
            process = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.INHERIT).start();
            input = new BufferedReader(new InputStreamReader(process.getInputStream(), java.nio.charset.StandardCharsets.UTF_8));
            output = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), java.nio.charset.StandardCharsets.UTF_8));
        }

        void send(String method, ObjectNode params) throws Exception {
            ObjectNode request = JSON.createObjectNode().put("id", ++id).put("method", method);
            request.set("params", params);
            output.write(request.toString());
            output.newLine();
            output.flush();
        }

        JsonNode read() throws Exception {
            String line = input.readLine();
            check(line != null, "JDBC process exited before responding");
            return JSON.readTree(line);
        }

        JsonNode call(String method, ObjectNode params) throws Exception { send(method, params); return read(); }

        JsonNode ok(String method, ObjectNode params) throws Exception {
            JsonNode response = call(method, params);
            check(!response.has("error"), response.toString());
            return response.path("result");
        }

        public void close() throws Exception {
            if (process.isAlive()) {
                call("close", JSON.createObjectNode());
                if (!process.waitFor(5, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    throw new AssertionError("JDBC runtime did not terminate");
                }
            }
            input.close();
            output.close();
        }
    }
}
