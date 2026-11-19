package com.dbx.agent.h2;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

class H2AgentProcessTest {
    @TempDir
    Path tempDirectory;

    @Test
    @Timeout(90)
    void fileSessionsShareTheDriverAcrossProfilesAndConnectionTests() throws Exception {
        try (RpcProcess rpc = new RpcProcess(Path.of(System.getProperty("dbx.h2.agent.jar")))) {
            for (String profile : List.of("h2-v1", "h2-v2", "h2-v3")) {
                String database = "file:" + tempDirectory.resolve(profile).toString().replace('\\', '/');
                JsonObject first = connectParams(profile + "-first", profile);
                first.addProperty("database", database);
                rpc.result(rpc.request("open_session", first));
                rpc.result(rpc.request("execute_query", queryParams(profile + "-first", "CREATE TABLE SHARED_DATA (ID INT PRIMARY KEY)")));
                rpc.result(rpc.request("execute_query", queryParams(profile + "-first", "INSERT INTO SHARED_DATA VALUES (42)")));

                JsonObject second = connectParams(profile + "-second", profile);
                second.addProperty("database", database + ";IFEXISTS=TRUE");
                second.addProperty("sessionRole", "metadata");
                rpc.result(rpc.request("open_session", second));
                Assertions.assertEquals("42", firstCell(rpc.result(rpc.request("execute_query", queryParams(profile + "-second", "SELECT ID FROM SHARED_DATA")))));

                JsonObject auto = connectParams(profile + "-auto", "h2");
                auto.addProperty("database", database + ";IFEXISTS=TRUE");
                rpc.result(rpc.request("open_session", auto));
                Assertions.assertTrue(rpc.result(rpc.request("test_connection", auto)).get("ok").getAsBoolean());
                rpc.result(rpc.request("close_session", sessionParams(profile + "-first")));
                Assertions.assertEquals("42", firstCell(rpc.result(rpc.request("execute_query", queryParams(profile + "-auto", "SELECT ID FROM SHARED_DATA")))));
                rpc.result(rpc.request("close_session", sessionParams(profile + "-second")));
                rpc.result(rpc.request("close_session", sessionParams(profile + "-auto")));
            }
        }
    }

    @Test
    @Timeout(60)
    void autoServerFileSessionsSupportConnectionTestsAndDatabaseSelection() throws Exception {
        try (RpcProcess rpc = new RpcProcess(Path.of(System.getProperty("dbx.h2.agent.jar")))) {
            JsonObject params = connectParams("file-metadata", "h2");
            String database = "file:" + tempDirectory.resolve("auto-server") + ";AUTO_SERVER=TRUE";
            params.addProperty("database", database);
            params.addProperty("connection_string", "jdbc:h2:" + database);
            Assertions.assertTrue(rpc.result(rpc.request("test_connection", params)).get("ok").getAsBoolean());
            params.addProperty("sessionRole", "metadata");
            rpc.result(rpc.request("open_session", params));
            rpc.resultArray(rpc.request("list_databases", sessionParams("file-metadata")));
            JsonObject workload = params.deepCopy();
            workload.addProperty("agentSessionId", "file-workload");
            workload.addProperty("sessionRole", "workload");
            rpc.result(rpc.request("open_session", workload));
            Assertions.assertEquals("1", firstCell(rpc.result(rpc.request("execute_query", queryParams("file-workload", "SELECT 1")))));
        }
    }

    @Test
    @Timeout(60)
    void autoFileSessionReopensAfterConnectionTestWithDelayedClose() throws Exception {
        Path jar = Path.of(System.getProperty("dbx.h2.agent.jar"));
        for (String profile : List.of("h2-v1", "h2-v2", "h2-v3")) {
            String database = "file:" + tempDirectory.resolve("delayed-" + profile) + ";AUTO_SERVER=TRUE";
            JsonObject params = connectParams("delayed-close", profile);
            params.addProperty("database", database);
            // Persist the setting, then start a fresh Agent just like a client restart.
            try (RpcProcess creator = new RpcProcess(jar)) {
                creator.result(creator.request("open_session", params));
                creator.result(creator.request("execute_query", queryParams("delayed-close", "SET DB_CLOSE_DELAY -1")));
            }
            params.addProperty("driver_profile", "h2");
            try (RpcProcess rpc = new RpcProcess(jar)) {
                Assertions.assertTrue(rpc.result(rpc.request("test_connection", params)).get("ok").getAsBoolean());
                Assertions.assertTrue(rpc.result(rpc.request("test_connection", params)).get("ok").getAsBoolean());
                rpc.result(rpc.request("open_session", params));
                Assertions.assertEquals("1", firstCell(rpc.result(rpc.request("execute_query", queryParams("delayed-close", "SELECT 1")))));
                rpc.result(rpc.request("close_session", sessionParams("delayed-close")));
                rpc.result(rpc.request("open_session", params));
            }
        }
    }

    @Test
    @Timeout(60)
    void failedFirstAutoFileOpenDoesNotMaskAuthenticationError() throws Exception {
        Path jar = Path.of(System.getProperty("dbx.h2.agent.jar"));
        for (String profile : List.of("h2-v1", "h2-v2", "h2-v3")) {
            JsonObject params = connectParams("failed-first", profile);
            params.addProperty("database", "file:" + tempDirectory.resolve("failed-first-" + profile)
                + ";AUTO_SERVER=TRUE;DB_CLOSE_DELAY=-1");
            params.addProperty("password", "owner-secret");
            try (RpcProcess creator = new RpcProcess(jar)) {
                creator.result(creator.request("open_session", params));
            }
            params.addProperty("driver_profile", "h2");
            try (RpcProcess rpc = new RpcProcess(jar)) {
                JsonObject denied = params.deepCopy();
                denied.addProperty("password", "wrong-secret");
                for (int attempt = 0; attempt < 2; attempt++) {
                    JsonObject response = rpc.request("test_connection", denied);
                    Assertions.assertTrue(response.has("error"));
                    JsonObject errorData = response.getAsJsonObject("error").getAsJsonObject("data");
                    Assertions.assertTrue(errorData.has("sqlState"), response.toString());
                    Assertions.assertEquals("28000", errorData.get("sqlState").getAsString(), response.toString());
                }
                rpc.result(rpc.request("open_session", params));
                Assertions.assertEquals("1", firstCell(rpc.result(rpc.request("execute_query", queryParams("failed-first", "SELECT 1")))));
            }
        }
    }

    @Test
    @Timeout(60)
    void delayedCloseEngineStillChecksProfileAndCredentials() throws Exception {
        try (RpcProcess rpc = new RpcProcess(Path.of(System.getProperty("dbx.h2.agent.jar")))) {
            JsonObject owner = connectParams("delayed-owner", "h2-v1");
            owner.addProperty("database", "file:" + tempDirectory.resolve("protected-delayed") + ";DB_CLOSE_DELAY=-1");
            owner.addProperty("password", "owner-secret");
            Assertions.assertTrue(rpc.result(rpc.request("test_connection", owner)).get("ok").getAsBoolean());
            JsonObject other = owner.deepCopy();
            other.addProperty("driver_profile", "h2-v3");
            JsonObject mismatch = rpc.request("test_connection", other);
            Assertions.assertTrue(mismatch.has("error"));
            Assertions.assertTrue(mismatch.getAsJsonObject("error").get("message").getAsString().contains("different driver"));
            other.addProperty("driver_profile", "h2");
            other.addProperty("password", "wrong-secret");
            Assertions.assertTrue(rpc.request("test_connection", other).has("error"));
            owner.addProperty("driver_profile", "h2");
            Assertions.assertTrue(rpc.result(rpc.request("test_connection", owner)).get("ok").getAsBoolean());
        }
    }

    @Test
    @Timeout(60)
    void shutdownReleasesRetainedEngineAndAllowsFormatRedetection() throws Exception {
        try (RpcProcess rpc = new RpcProcess(Path.of(System.getProperty("dbx.h2.agent.jar")))) {
            Path base = tempDirectory.resolve("shutdown-delayed");
            JsonObject params = connectParams("before-shutdown", "h2-v1");
            params.addProperty("database", "file:" + base + ";DB_CLOSE_DELAY=60");
            Assertions.assertTrue(rpc.result(rpc.request("test_connection", params)).get("ok").getAsBoolean());
            params.addProperty("driver_profile", "h2");
            rpc.result(rpc.request("open_session", params));
            JsonObject shutdown = rpc.request("execute_query", queryParams("before-shutdown", "SHUTDOWN"));
            if (shutdown.has("error")) {
                // H2 1.x can report database-closed when the executor inspects SHUTDOWN's result.
                Assertions.assertEquals(90121, shutdown.getAsJsonObject("error").getAsJsonObject("data").get("vendorCode").getAsInt());
            } else {
                rpc.result(shutdown);
            }
            rpc.result(rpc.request("close_session", sessionParams("before-shutdown")));
            Files.delete(Path.of(base + ".mv.db"));

            params.addProperty("database", "file:" + base);
            params.addProperty("driver_profile", "h2-v2");
            Assertions.assertTrue(rpc.result(rpc.request("test_connection", params)).get("ok").getAsBoolean());
            params.addProperty("driver_profile", "h2");
            JsonObject reopened = rpc.result(rpc.request("test_connection", params));
            Assertions.assertTrue(reopened.getAsJsonObject("databaseInfo").get("driverVersion").getAsString().startsWith("2.1.214"));
        }
    }

    @Test
    @Timeout(60)
    void autoFileSessionCanBeOpenedAgainWhileThePoolKeepsItOpen() throws Exception {
        try (RpcProcess rpc = new RpcProcess(Path.of(System.getProperty("dbx.h2.agent.jar")))) {
            JsonObject first = connectParams("auto-first", "h2");
            first.addProperty("database", "file:" + tempDirectory.resolve("auto").toString().replace('\\', '/'));
            rpc.result(rpc.request("open_session", first));
            rpc.result(rpc.request("close_session", sessionParams("auto-first")));
            JsonObject second = first.deepCopy();
            second.addProperty("agentSessionId", "auto-second");
            rpc.result(rpc.request("open_session", second));
            Assertions.assertTrue(rpc.result(rpc.request("test_connection", second)).get("ok").getAsBoolean());
        }
    }

    @Test
    @Timeout(60)
    void concurrentAutoFileSessionsShareOneEngine() throws Exception {
        try (RpcProcess rpc = new RpcProcess(Path.of(System.getProperty("dbx.h2.agent.jar")))) {
            List<Integer> requests = new java.util.ArrayList<>();
            for (int index = 0; index < 6; index++) {
                JsonObject params = connectParams("concurrent-" + index, "h2");
                params.addProperty("database", "file:" + tempDirectory.resolve("concurrent").toString().replace('\\', '/')
                    + ";LOCK_TIMEOUT=" + (1000 + index));
                requests.add(rpc.send("open_session", params));
            }
            for (int request : requests) {
                rpc.result(rpc.await(request, Duration.ofSeconds(20)));
            }
            rpc.result(rpc.request("execute_query", queryParams("concurrent-0", "CREATE TABLE SHARED_VALUE (ID INT)")));
            rpc.result(rpc.request("execute_query", queryParams("concurrent-0", "INSERT INTO SHARED_VALUE VALUES (7)")));
            for (int index = 1; index < 6; index++) {
                Assertions.assertEquals("7", firstCell(rpc.result(rpc.request("execute_query", queryParams("concurrent-" + index, "SELECT ID FROM SHARED_VALUE")))));
            }
        }
    }

    @Test
    @Timeout(60)
    void autoServerFileCanBeOpenedFromAnotherAgentProcess() throws Exception {
        Path jar = Path.of(System.getProperty("dbx.h2.agent.jar"));
        for (String profile : List.of("h2-v1", "h2-v2", "h2-v3")) {
            try (RpcProcess owner = new RpcProcess(jar); RpcProcess other = new RpcProcess(jar)) {
                JsonObject params = connectParams("auto-server-owner", profile);
                String database = "file:" + tempDirectory.resolve("shared-server-" + profile);
                params.addProperty("database", database + ";AUTO_SERVER=TRUE;DB_CLOSE_DELAY=-1");
                params.addProperty("password", "owner-secret");
                owner.result(owner.request("open_session", params));
                owner.result(owner.request("execute_query", queryParams("auto-server-owner", "CREATE TABLE OWNER_DATA (ID INT)")));
                owner.result(owner.request("execute_query", queryParams("auto-server-owner", "INSERT INTO OWNER_DATA VALUES (99)")));

                JsonObject test = params.deepCopy();
                test.addProperty("driver_profile", "h2-v3");
                Assertions.assertTrue(other.result(other.request("test_connection", test)).get("ok").getAsBoolean());
                test.addProperty("driver_profile", "h2");
                test.addProperty("agentSessionId", "auto-server-guest");
                JsonObject denied = test.deepCopy();
                denied.addProperty("database", database);
                Assertions.assertTrue(other.request("test_connection", denied).has("error"));
                denied.addProperty("database", database + ";AUTO_SERVER=FALSE");
                Assertions.assertTrue(other.request("test_connection", denied).has("error"));
                denied = test.deepCopy();
                denied.addProperty("password", "wrong-secret");
                Assertions.assertTrue(other.request("test_connection", denied).has("error"));
                Assertions.assertTrue(other.result(other.request("test_connection", test)).get("ok").getAsBoolean());
                other.result(other.request("open_session", test));
                Assertions.assertEquals("99", firstCell(other.result(other.request("execute_query", queryParams("auto-server-guest", "SELECT ID FROM OWNER_DATA")))));
                Assertions.assertTrue(other.resultArray(other.request("list_objects", metadataParams("auto-server-guest", "PUBLIC")))
                    .asList().stream().anyMatch(value -> "OWNER_DATA".equals(value.getAsJsonObject().get("name").getAsString())));
                Assertions.assertEquals("99", firstCell(owner.result(owner.request("execute_query", queryParams("auto-server-owner", "SELECT ID FROM OWNER_DATA")))));
            }
        }
    }

    @Test
    @Timeout(60)
    void externalProcessLockIsNotBypassedAndOwnerKeepsWorking() throws Exception {
        Path jar = Path.of(System.getProperty("dbx.h2.agent.jar"));
        try (RpcProcess owner = new RpcProcess(jar); RpcProcess other = new RpcProcess(jar)) {
            JsonObject params = connectParams("owner", "h2-v3");
            params.addProperty("database", "file:" + tempDirectory.resolve("externally-locked").toString().replace('\\', '/'));
            owner.result(owner.request("open_session", params));
            owner.result(owner.request("execute_query", queryParams("owner", "CREATE TABLE OWNER_DATA (ID INT)")));
            owner.result(owner.request("execute_query", queryParams("owner", "INSERT INTO OWNER_DATA VALUES (99)")));
            JsonObject test = params.deepCopy();
            test.addProperty("driver_profile", "h2");
            Assertions.assertTrue(other.request("test_connection", test).has("error"));
            test.addProperty("driver_profile", "h2-v3");
            Assertions.assertTrue(other.request("test_connection", test).has("error"));
            Assertions.assertEquals("99", firstCell(owner.result(owner.request("execute_query", queryParams("owner", "SELECT ID FROM OWNER_DATA")))));
        }
    }

    @Test
    @Timeout(45)
    void shadedAgentSupportsIsolatedMultiVersionSessions() throws Exception {
        Path agentJar = Path.of(System.getProperty("dbx.h2.agent.jar"));
        Assertions.assertTrue(Files.isRegularFile(agentJar), () -> "Missing shaded H2 Agent: " + agentJar);

        try (RpcProcess rpc = new RpcProcess(agentJar)) {
            JsonObject handshake = rpc.result(rpc.request("handshake", new JsonObject()));
            Assertions.assertEquals(2, handshake.get("protocolVersion").getAsInt());

            Map<String, String> versions = new LinkedHashMap<>();
            versions.put("h2-v1", "1.4.200");
            versions.put("h2-v2", "2.1.214");
            versions.put("h2-v3", "2.4.240");

            int index = 0;
            for (Map.Entry<String, String> entry : versions.entrySet()) {
                String sessionId = "session-" + entry.getKey();
                JsonObject connected = rpc.result(rpc.request("open_session", connectParams(sessionId, entry.getKey())));
                Assertions.assertTrue(connected.get("ok").getAsBoolean(), entry.getKey());

                JsonObject info = rpc.result(rpc.request("connection_info", sessionParams(sessionId)));
                String driverVersion = info.getAsJsonObject("databaseInfo").get("driverVersion").getAsString();
                Assertions.assertTrue(driverVersion.startsWith(entry.getValue()), entry.getKey() + ": " + driverVersion);

                String table = "RPC_TABLE_" + (++index);
                rpc.result(rpc.request("execute_query", queryParams(sessionId, "CREATE TABLE " + table + " (ID INT PRIMARY KEY, TEXT_VALUE VARCHAR(32))")));
                rpc.result(rpc.request("execute_query", queryParams(sessionId, "INSERT INTO " + table + " VALUES (1, '" + entry.getKey() + "')")));
                JsonArray tables = rpc.resultArray(rpc.request("list_tables", metadataParams(sessionId, "PUBLIC")));
                Assertions.assertTrue(tables.asList().stream().anyMatch(value -> table.equals(value.getAsJsonObject().get("name").getAsString())), entry.getKey());
                Assertions.assertEquals(entry.getKey(), firstCell(rpc.result(rpc.request("execute_query", queryParams(sessionId, "SELECT TEXT_VALUE FROM " + table)))));
            }

            JsonObject transaction = sessionParams("session-h2-v2");
            JsonArray statements = new JsonArray();
            statements.add("CREATE TABLE TX_PROBE (ID INT PRIMARY KEY)");
            statements.add("INSERT INTO TX_PROBE VALUES (1)");
            statements.add("INSERT INTO TX_PROBE VALUES (2)");
            transaction.add("statements", statements);
            Assertions.assertEquals(2, rpc.result(rpc.request("execute_transaction", transaction)).get("affected_rows").getAsLong());
            Assertions.assertEquals("2", firstCell(rpc.result(rpc.request("execute_query", queryParams("session-h2-v2", "SELECT COUNT(*) FROM TX_PROBE")))));

            JsonObject firstPageParams = queryParams("session-h2-v3", "SELECT X FROM SYSTEM_RANGE(1, 5)");
            firstPageParams.addProperty("pageSize", 2);
            JsonObject firstPage = rpc.result(rpc.request("execute_query_page", firstPageParams));
            Assertions.assertEquals(2, firstPage.getAsJsonArray("rows").size());
            Assertions.assertTrue(firstPage.get("has_more").getAsBoolean());
            String querySessionId = firstPage.get("session_id").getAsString();

            JsonObject fetchParams = sessionParams("session-h2-v3");
            fetchParams.addProperty("sessionId", querySessionId);
            fetchParams.addProperty("pageSize", 2);
            JsonObject secondPage = rpc.result(rpc.request("fetch_query_page", fetchParams));
            Assertions.assertEquals(2, secondPage.getAsJsonArray("rows").size());
            Assertions.assertTrue(secondPage.get("has_more").getAsBoolean());
            JsonObject finalPage = rpc.result(rpc.request("fetch_query_page", fetchParams));
            Assertions.assertEquals(1, finalPage.getAsJsonArray("rows").size());
            Assertions.assertFalse(finalPage.get("has_more").getAsBoolean());

            int slowQueryId = rpc.send("execute_query", queryParams("session-h2-v3", "SELECT SUM(SIN(X)) FROM SYSTEM_RANGE(1, 1000000000)"));
            Thread.sleep(100);
            JsonObject cancelled = rpc.result(rpc.request("cancel_session", sessionParams("session-h2-v3")));
            Assertions.assertTrue(cancelled.get("ok").getAsBoolean());
            JsonObject slowResponse = rpc.await(slowQueryId, Duration.ofSeconds(15));
            Assertions.assertTrue(slowResponse.has("error"), () -> "Expected cancelled query error, got " + slowResponse);
            Assertions.assertTrue(rpc.result(rpc.request("validate_session", sessionParams("session-h2-v3"))).get("ok").getAsBoolean());

            for (String profile : versions.keySet()) {
                String sessionId = "session-" + profile;
                Assertions.assertTrue(rpc.result(rpc.request("close_session", sessionParams(sessionId))).get("ok").getAsBoolean());
                Assertions.assertTrue(rpc.request("validate_session", sessionParams(sessionId)).has("error"));
            }
        }
    }

    // Regression test for a legacy (H2 1.x) *remote* server: the file-format
    // auto-detector (H2FileFormatDetector) cannot inspect a TCP database's
    // storage file, so driver selection falls back to the newest bundled
    // driver (H2 2.4.240). That mismatched driver's own JDBC metadata
    // (getDatabaseMajorVersion()) then reports its own version rather than the
    // server's, which used to make the agent send an H2 2.x-only
    // INFORMATION_SCHEMA.ROUTINES query to a database that doesn't have that
    // catalog table, failing list_objects entirely (dbx#8356).
    @Test
    @Timeout(45)
    void listObjectsAutoDetectsLegacyServerOverTcp() throws Exception {
        Path h2V1Jar = Path.of(System.getProperty("dbx.h2.v1.driver.jar"));
        Assertions.assertTrue(Files.isRegularFile(h2V1Jar), () -> "Missing bundled H2 1.4.200 driver jar: " + h2V1Jar);
        Path agentJar = Path.of(System.getProperty("dbx.h2.agent.jar"));
        Assertions.assertTrue(Files.isRegularFile(agentJar), () -> "Missing shaded H2 Agent: " + agentJar);

        try (LegacyTcpServer server = new LegacyTcpServer(h2V1Jar)) {
            try (RpcProcess rpc = new RpcProcess(agentJar)) {
                String sessionId = "session-legacy-tcp";
                JsonObject params = sessionParams(sessionId);
                params.addProperty("host", "127.0.0.1");
                params.addProperty("port", server.port());
                // A fresh, unique database per run: the TCP server process's
                // working directory (and any .mv.db file it writes) persists
                // across separate test invocations, so a fixed name would leak
                // schema objects between runs.
                params.addProperty("database", "./legacy-tcp-test-" + java.util.UUID.randomUUID());
                params.addProperty("username", "sa");
                params.addProperty("password", "");
                params.addProperty("connection_string", "");
                params.addProperty("ssl", false);
                // driver_profile intentionally omitted: exercise the "auto" path.

                JsonObject connected = rpc.result(rpc.request("open_session", params));
                Assertions.assertTrue(connected.get("ok").getAsBoolean());

                rpc.result(rpc.request("execute_query", queryParams(sessionId, "CREATE TABLE LEGACY_TABLE (ID INT PRIMARY KEY)")));
                rpc.result(rpc.request("execute_query", queryParams(sessionId, "CREATE ALIAS LEGACY_FUNC FOR \"java.lang.Integer.reverse\"")));

                JsonArray objects = rpc.resultArray(rpc.request("list_objects", metadataParams(sessionId, "PUBLIC")));
                List<String> names = objects.asList().stream().map(value -> value.getAsJsonObject().get("name").getAsString()).toList();
                Assertions.assertTrue(names.contains("LEGACY_TABLE"), names.toString());
                Assertions.assertTrue(names.contains("LEGACY_FUNC"), names.toString());

                Assertions.assertTrue(rpc.result(rpc.request("close_session", sessionParams(sessionId))).get("ok").getAsBoolean());
            }
        }
    }

    private static final class LegacyTcpServer implements AutoCloseable {
        private final Process process;
        private final int port;

        private LegacyTcpServer(Path h2V1Jar) throws Exception {
            this.port = findFreePort();
            Path java = Path.of(System.getProperty("java.home"), "bin", "java");
            process = new ProcessBuilder(
                java.toString(), "-cp", h2V1Jar.toString(), "org.h2.tools.Server",
                "-tcp", "-tcpPort", Integer.toString(port), "-ifNotExists"
            ).redirectErrorStream(true).start();
            // -tcpDaemon is intentionally omitted: it marks the *listener* thread
            // as a daemon for embedding inside a host JVM that outlives it. Here
            // the server *is* the whole process, so a daemon-only listener thread
            // would let the JVM exit (dropping sessions) the moment main() returns.
            drainOutput();
            waitUntilListening();
        }

        private void drainOutput() {
            Thread thread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    while (reader.readLine() != null) {
                        // Discard: only draining to prevent the pipe buffer from filling.
                    }
                } catch (java.io.IOException ignored) {
                }
            }, "legacy-h2-server-stdout");
            thread.setDaemon(true);
            thread.start();
        }

        private int port() {
            return port;
        }

        private static int findFreePort() throws Exception {
            try (java.net.ServerSocket socket = new java.net.ServerSocket(0)) {
                return socket.getLocalPort();
            }
        }

        private void waitUntilListening() throws Exception {
            long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
            while (System.nanoTime() < deadline) {
                try (java.net.Socket probe = new java.net.Socket()) {
                    probe.connect(new java.net.InetSocketAddress("127.0.0.1", port), 200);
                    return;
                } catch (java.io.IOException notReady) {
                    Thread.sleep(100);
                }
            }
            throw new AssertionError("Legacy H2 TCP server never started listening on port " + port);
        }

        @Override
        public void close() {
            process.destroy();
            try {
                if (!process.waitFor(5, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private static JsonObject connectParams(String sessionId, String profile) {
        JsonObject params = sessionParams(sessionId);
        params.addProperty("host", "");
        params.addProperty("port", 0);
        params.addProperty("database", "mem:rpc-" + profile + ";DB_CLOSE_DELAY=-1");
        params.addProperty("username", "sa");
        params.addProperty("password", "");
        params.addProperty("connection_string", "");
        params.addProperty("driver_profile", profile);
        params.addProperty("ssl", false);
        return params;
    }

    private static JsonObject sessionParams(String sessionId) {
        JsonObject params = new JsonObject();
        params.addProperty("agentSessionId", sessionId);
        return params;
    }

    private static JsonObject queryParams(String sessionId, String sql) {
        JsonObject params = sessionParams(sessionId);
        params.addProperty("sql", sql);
        return params;
    }

    private static JsonObject metadataParams(String sessionId, String schema) {
        JsonObject params = sessionParams(sessionId);
        params.addProperty("schema", schema);
        return params;
    }

    private static String firstCell(JsonObject result) {
        return result.getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsString();
    }

    private static final class RpcProcess implements AutoCloseable {
        private final Process process;
        private final BufferedWriter input;
        private final BlockingQueue<JsonObject> responses = new LinkedBlockingQueue<>();
        private final Map<Integer, JsonObject> pending = new ConcurrentHashMap<>();
        private final CompletableFuture<Void> ready = new CompletableFuture<>();
        private final AtomicInteger requestIds = new AtomicInteger();
        private final StringBuilder stderr = new StringBuilder();

        private RpcProcess(Path agentJar) throws Exception {
            Path java = Path.of(System.getProperty("java.home"), "bin", "java");
            process = new ProcessBuilder(java.toString(), "-jar", agentJar.toString()).start();
            input = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
            startStdoutReader();
            startStderrReader();
            ready.get(10, TimeUnit.SECONDS);
        }

        private void startStdoutReader() {
            Thread thread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        JsonObject message = JsonParser.parseString(line).getAsJsonObject();
                        if (message.has("ready")) {
                            ready.complete(null);
                        } else {
                            responses.add(message);
                        }
                    }
                } catch (Throwable error) {
                    ready.completeExceptionally(error);
                }
            }, "h2-agent-rpc-stdout");
            thread.setDaemon(true);
            thread.start();
        }

        private void startStderrReader() {
            Thread thread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        synchronized (stderr) {
                            stderr.append(line).append('\n');
                        }
                    }
                } catch (Exception ignored) {
                }
            }, "h2-agent-rpc-stderr");
            thread.setDaemon(true);
            thread.start();
        }

        private JsonObject request(String method, JsonObject params) throws Exception {
            return await(send(method, params), Duration.ofSeconds(15));
        }

        private int send(String method, JsonObject params) throws Exception {
            int id = requestIds.incrementAndGet();
            JsonObject request = new JsonObject();
            request.addProperty("jsonrpc", "2.0");
            request.addProperty("id", id);
            request.addProperty("method", method);
            request.add("params", params);
            synchronized (input) {
                input.write(request.toString());
                input.newLine();
                input.flush();
            }
            return id;
        }

        private JsonObject await(int id, Duration timeout) throws Exception {
            JsonObject buffered = pending.remove(id);
            if (buffered != null) {
                return buffered;
            }
            long deadline = System.nanoTime() + timeout.toNanos();
            while (System.nanoTime() < deadline) {
                long remaining = deadline - System.nanoTime();
                JsonObject response = responses.poll(Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining)), TimeUnit.MILLISECONDS);
                if (response == null) {
                    break;
                }
                int responseId = response.get("id").getAsInt();
                if (responseId == id) {
                    return response;
                }
                pending.put(responseId, response);
            }
            throw new AssertionError("Timed out waiting for H2 Agent response " + id + "; stderr=" + stderrText());
        }

        private JsonObject result(JsonObject response) {
            Assertions.assertFalse(response.has("error"), () -> response + "\nstderr=" + stderrText());
            return response.getAsJsonObject("result");
        }

        private JsonArray resultArray(JsonObject response) {
            Assertions.assertFalse(response.has("error"), () -> response + "\nstderr=" + stderrText());
            return response.getAsJsonArray("result");
        }

        private String stderrText() {
            synchronized (stderr) {
                return stderr.toString();
            }
        }

        @Override
        public void close() throws Exception {
            if (process.isAlive()) {
                try {
                    result(request("shutdown", new JsonObject()));
                } catch (Throwable ignored) {
                }
            }
            input.close();
            if (!process.waitFor(5, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
        }
    }
}
