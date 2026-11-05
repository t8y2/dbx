package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.lang.reflect.InvocationTargetException;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

/** Real child JVM + stdin server; only JDBC is scripted. No database or helper DDL. */
class PlDebugRuntimeProcessTest {
    @TempDir Path directory;

    @Test
    void shutdownRetainsALateConnectAndClosesItOnceBeforeProcessExit() throws Exception {
        verifyDrain("connect");
    }

    @Test
    void shutdownRetainsTheOriginalPhysicalCloseRatherThanClosingItAgain() throws Exception {
        verifyDrain("close");
    }

    @Test
    void lateTargetCanRunPrivateOutputCleanupOnItsOwnWorkerWithoutLifecycleSelfWait() throws Exception {
        JsonObject result = verifyDrain("target");
        assertEquals(1, result.get("targetExecutions").getAsInt());
        assertEquals(1, result.get("cleanupExecutions").getAsInt());
        JsonObject threads = result.getAsJsonObject("threads");
        assertEquals("dbx-pl-debug-target", threads.get("target").getAsString());
        assertEquals("dbx-pl-debug-target", threads.get("output").getAsString());
        assertEquals("dbx-pl-debug-lifecycle", threads.get("rollback").getAsString());
        assertEquals("dbx-jdbc-physical-close", threads.get("physicalClose").getAsString());
    }

    @Test
    void anUnendingDriverKeepsDrainUnknownUntilTheOwningParentForciblyIsolatesIt() throws Exception {
        try (Child child = new Child("connect", directory.resolve("never"))) {
            child.open();
            child.send(2, "pl_debug_start", startParams());
            Socket gate = child.acceptGate();
            assertTrue(child.response(2).has("error"));
            child.shutdown();
            assertFalse(child.process.waitFor(2_500, TimeUnit.MILLISECONDS));
            assertFalse(Files.exists(child.resultPath));
            child.process.destroyForcibly();
            assertTrue(child.process.waitFor(5, TimeUnit.SECONDS));
            assertFalse(Files.exists(child.resultPath), "forced isolation must not leave a controlled-release receipt");
            gate.close();
        }
    }

    @Test
    void shutdownWithoutDedicatedResourcesDoesNotWaitForDedicatedCleanup() throws Exception {
        try (Child child = new Child("ordinary", directory.resolve("ordinary"))) {
            child.shutdown();
            assertTrue(child.process.waitFor(5, TimeUnit.SECONDS), child.error());
            assertEquals(0, child.process.exitValue(), child.error());
            assertTrue(Files.exists(child.resultPath));
        }
    }

    @Test
    void rejectingTheSecondPhysicalAllocationNeverDispatchesTheTargetOrReplaysItsStart() throws Exception {
        try (Child child = new Child("budget", directory.resolve("budget"))) {
            child.open();
            child.send(2, "pl_debug_start", startParams());
            JsonObject rejected = child.response(2);
            assertEquals("resource", rejected.getAsJsonObject("error").getAsJsonObject("data").get("category").getAsString());
            child.send(4, "pl_debug_start", startParams());
            JsonObject replay = child.response(4).getAsJsonObject("result");
            assertEquals(false, replay.get("targetDispatched").getAsBoolean());
            assertEquals("failed", replay.get("startState").getAsString());
            assertEquals("released", replay.get("releaseState").getAsString());
            child.shutdown();
            assertTrue(child.process.waitFor(5, TimeUnit.SECONDS), child.error());
            assertEquals(0, child.process.exitValue(), child.error());
            JsonObject result = JsonParser.parseString(Files.readString(child.resultPath)).getAsJsonObject();
            assertEquals(0, result.get("targetExecutions").getAsInt());
            assertEquals(2, result.get("physicalOpens").getAsInt(), "only the original ordinary and first dedicated connection may open");
            assertEquals(1, result.get("debuggeeCloses").getAsInt());
            assertEquals(0, result.get("debuggerCloses").getAsInt());
        }
    }

    private JsonObject verifyDrain(String mode) throws Exception {
        try (Child child = new Child(mode, directory.resolve(mode))) {
            child.open();
            child.send(2, "pl_debug_start", startParams());
            Socket gate;
            if (mode.equals("connect")) {
                gate = child.acceptGate();
                assertTrue(child.response(2).has("error"));
                child.shutdown();
            } else {
                JsonObject start = child.response(2);
                assertTrue(start.has("result"), start.toString());
                child.shutdown();
                gate = child.acceptGate();
            }
            assertFalse(child.process.waitFor(2_500, TimeUnit.MILLISECONDS), "daemon cleanup must not let main exit before drain: " + child.error());
            assertFalse(Files.exists(child.resultPath));
            gate.getOutputStream().write(1);
            gate.getOutputStream().flush();
            assertTrue(child.process.waitFor(12, TimeUnit.SECONDS), child.error());
            assertEquals(0, child.process.exitValue(), child.error());
            JsonObject result = JsonParser.parseString(Files.readString(child.resultPath)).getAsJsonObject();
            assertEquals("released", result.getAsJsonObject("status").get("releaseState").getAsString());
            assertEquals(1, result.get("debuggeeCloses").getAsInt());
            assertEquals(mode.equals("connect") ? 0 : 1, result.get("debuggerCloses").getAsInt());
            if (!mode.equals("connect")) {
                assertEquals("cancelled", result.getAsJsonObject("status").get("executionOutcome").getAsString());
                assertEquals("controlled_work_rolled_back", result.getAsJsonObject("status").get("transactionOutcome").getAsString());
            }
            return result;
        }
    }

    private static String startParams() {
        return "{\"agentSessionId\":\"debug\",\"operationId\":\"shutdown-target\",\"schema\":\"SCOTT\",\"objectType\":\"ANONYMOUS\",\"source\":\"BEGIN\\n  NULL;\\nEND;\"}";
    }

    private static final class Child implements AutoCloseable {
        final ServerSocket listener = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress());
        final Path resultPath;
        final Path errorPath;
        final Process process;
        final BufferedWriter input;
        final BlockingQueue<String> output = new LinkedBlockingQueue<>();
        Socket gate;

        Child(String mode, Path root) throws Exception {
            Files.createDirectories(root);
            resultPath = root.resolve("completed.json");
            errorPath = root.resolve("stderr.log");
            listener.setSoTimeout(10_000);
            process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Xmx128m", "-cp", childClasspath(), PlDebugRuntimeProcessTest.class.getName(),
                mode, Integer.toString(listener.getLocalPort()), resultPath.toString()).redirectError(errorPath.toFile()).start();
            input = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
            Thread reader = new Thread(() -> {
                try (BufferedReader stream = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = stream.readLine()) != null) output.add(line);
                } catch (Exception ignored) { }
            }, "pl-debug-test-child-output");
            reader.setDaemon(true);
            reader.start();
            String ready = output.poll(10, TimeUnit.SECONDS);
            assertNotNull(ready, error());
            assertTrue(JsonParser.parseString(ready).getAsJsonObject().get("ready").getAsBoolean(), ready);
        }

        void send(int id, String method, String params) throws Exception {
            input.write("{\"id\":" + id + ",\"method\":\"" + method + "\",\"params\":" + params + "}\n");
            input.flush();
        }

        void open() throws Exception {
            send(1, "open_session", "{\"agentSessionId\":\"debug\",\"host\":\"fixture\",\"jdbc_driver_class\":\""
                + GateDriver.class.getName() + "\"}");
            JsonObject opened = response(1);
            assertTrue(opened.has("result"), opened.toString());
        }

        void shutdown() throws Exception {
            send(3, "shutdown", "{}");
            assertTrue(response(3).has("result"));
        }

        JsonObject response(int id) throws Exception {
            String line = output.poll(10, TimeUnit.SECONDS);
            assertNotNull(line, error());
            JsonObject response = JsonParser.parseString(line).getAsJsonObject();
            assertEquals(id, response.get("id").getAsInt(), response.toString());
            return response;
        }

        Socket acceptGate() throws Exception { gate = listener.accept(); return gate; }
        String error() throws Exception { return Files.exists(errorPath) ? Files.readString(errorPath) : "child has no diagnostic"; }

        @Override public void close() throws Exception {
            if (process.isAlive()) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
            if (gate != null) gate.close();
            input.close();
            listener.close();
        }
    }

    private static String childClasspath() throws Exception {
        LinkedHashSet<String> paths = new LinkedHashSet<>();
        for (Class<?> type : new Class<?>[]{PlDebugRuntimeProcessTest.class, OceanBaseOracleAgent.class,
            AbstractJdbcAgent.class, Gson.class, Class.forName("com.zaxxer.hikari.HikariDataSource"),
            Class.forName("org.slf4j.LoggerFactory"), org.junit.jupiter.api.Assertions.class,
            Class.forName("org.junit.platform.commons.util.Preconditions"), Class.forName("org.opentest4j.AssertionFailedError")}) {
            paths.add(Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI()).toString());
        }
        return String.join(java.io.File.pathSeparator, paths);
    }

    public static void main(String[] args) throws Exception {
        String mode = args[0];
        int port = Integer.parseInt(args[1]);
        System.setProperty("dbx.agent.jdbc.pool.enabled", "false");
        System.setProperty("dbx.agent.jdbc.pool.connectionTimeoutMillis", "250");
        if (mode.equals("budget")) System.setProperty("dbx.agent.jdbc.pool.globalMaximumPhysicalConnections", "1");
        AtomicInteger opens = new AtomicInteger();
        AtomicInteger debuggeeCloses = new AtomicInteger();
        AtomicInteger debuggerCloses = new AtomicInteger();
        Map<String, String> threads = new ConcurrentHashMap<>();
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            GateDriver driver = new GateDriver(() -> {
                    int index = opens.getAndIncrement();
                    if (index == 0) return proxy(Connection.class, (method, values) -> empty(method.getReturnType()));
                    boolean debuggee = index == 1;
                    if (debuggee && mode.equals("connect")) awaitGate(port);
                    Connection raw = jdbc.connection(debuggee);
                    return proxy(Connection.class, (method, values) -> {
                        if (method.getName().equals("close")) {
                            threads.put("physicalClose", Thread.currentThread().getName());
                            if (debuggee) debuggeeCloses.incrementAndGet();
                            else debuggerCloses.incrementAndGet();
                            if (debuggee && mode.equals("close")) awaitGate(port);
                        }
                        if (debuggee && method.getName().equals("rollback")) threads.put("rollback", Thread.currentThread().getName());
                        Object result;
                        try { result = method.invoke(raw, values); }
                        catch (InvocationTargetException error) { throw error.getCause(); }
                        if (debuggee && method.getName().equals("prepareCall")) {
                            String sql = (String) values[0];
                            CallableStatement statement = (CallableStatement) result;
                            boolean target = sql.contains("SAVEPOINT DBX_PD_");
                            boolean output = !target && sql.contains("SYS.DBMS_OUTPUT.GET_LINE");
                            return proxy(CallableStatement.class, (member, arguments) -> {
                                boolean execute = member.getName().equals("execute");
                                if (execute && target) threads.put("target", Thread.currentThread().getName());
                                if (execute && output) threads.put("output", Thread.currentThread().getName());
                                try { return member.invoke(statement, arguments); }
                                catch (InvocationTargetException error) { throw error.getCause(); }
                                finally {
                                    if (execute && target && mode.equals("target")) awaitGate(port);
                                }
                            });
                        }
                        return result;
                    });
            });
            java.sql.DriverManager.registerDriver(driver);
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            new MultiSessionJsonRpcServer(() -> agent).run();
            Map<String, Object> result = new LinkedHashMap<>();
            if (!mode.equals("ordinary")) result.put("status", agent.plDebugStatus("shutdown-target"));
            result.put("debuggeeCloses", debuggeeCloses.get());
            result.put("physicalOpens", opens.get());
            result.put("debuggerCloses", debuggerCloses.get());
            result.put("targetExecutions", jdbc.targetExecutions.get());
            result.put("cleanupExecutions", jdbc.cleanupExecutions.get());
            result.put("threads", threads);
            Files.writeString(Path.of(args[2]), new Gson().toJson(result));
            java.sql.DriverManager.deregisterDriver(driver);
        }
    }

    private static final class GateDriver implements java.sql.Driver {
        private final java.util.concurrent.Callable<Connection> factory;
        private GateDriver(java.util.concurrent.Callable<Connection> factory) { this.factory = factory; }
        @Override public Connection connect(String url, java.util.Properties info) throws java.sql.SQLException {
            try { return factory.call(); }
            catch (java.sql.SQLException error) { throw error; }
            catch (Exception error) { throw new java.sql.SQLException("Scripted JDBC boundary failed", error); }
        }
        @Override public boolean acceptsURL(String url) { return url != null && url.startsWith("jdbc:"); }
        @Override public java.sql.DriverPropertyInfo[] getPropertyInfo(String url, java.util.Properties info) { return new java.sql.DriverPropertyInfo[0]; }
        @Override public int getMajorVersion() { return 1; }
        @Override public int getMinorVersion() { return 0; }
        @Override public boolean jdbcCompliant() { return false; }
        @Override public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getLogger("pl-debug-test"); }
    }

    private static void awaitGate(int port) throws Exception {
        try (Socket gate = new Socket(java.net.InetAddress.getLoopbackAddress(), port)) {
            if (gate.getInputStream().read() < 0) throw new IllegalStateException("Test parent closed the gate without releasing it");
        }
    }
}
