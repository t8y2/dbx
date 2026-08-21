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

class H2AgentProcessTest {
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
