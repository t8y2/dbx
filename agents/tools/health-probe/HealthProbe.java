package com.dbx.agent;

import com.dbx.agent.oceanbaseoracle.OceanBaseOracleAgent;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;

/** Standalone measurement process only. Not packaged in the production agent. */
public final class HealthProbe {
    private static final String SQL = "SELECT 1 FROM DUAL";
    private static final Gson GSON = new Gson();

    public static void main(String[] args) {
        try { run(args); }
        catch (Throwable failure) {
            // JDBC failures can contain URLs, usernames and SQL. Do not print them.
            System.err.println("Health probe failed; no raw exception was emitted. Check the sanitized evidence file and configuration.");
            System.exit(1);
        }
    }

    private static void run(String[] args) throws Exception {
        if (args.length != 2 || !(args[0].equals("pooled") || args[0].equals("direct"))) throw new IllegalArgumentException();
        int samples = Integer.parseInt(args[1]);
        if (samples < 5 || samples > 100 || !"1".equals(System.getenv("DBX_HEALTH_DEDICATED"))) throw new IllegalArgumentException();
        JsonObject connect = JsonParser.parseString(required("DBX_HEALTH_CONNECT_JSON")).getAsJsonObject();
        // Only the existing driver and a dedicated Oracle-mode endpoint are used.
        connect.remove("jdbc_driver_paths");
        connect.addProperty("jdbc_driver_class", "com.oceanbase.jdbc.Driver");
        String relayPort = System.getenv("DBX_HEALTH_RELAY_PORT");
        if (relayPort != null && !relayPort.isBlank()) {
            if (connect.has("connection_string") && !connect.get("connection_string").getAsString().isBlank()) throw new IllegalArgumentException("Relay requires host/port parameters");
            int port = Integer.parseInt(relayPort);
            if (port < 1 || port > 65535) throw new IllegalArgumentException("Relay port");
            connect.addProperty("host", "127.0.0.1");
            connect.addProperty("port", port);
        }
        Path output = Path.of(required("DBX_HEALTH_OUTPUT"));
        Class.forName("com.oceanbase.jdbc.Driver");
        Driver delegate = new com.oceanbase.jdbc.Driver();
        for (Driver driver : Collections.list(DriverManager.getDrivers())) {
            if (driver.getClass().getName().equals("com.oceanbase.jdbc.Driver")) DriverManager.deregisterDriver(driver);
        }
        Counters counts = new Counters();
        Driver observed = new ObservedDriver(delegate, counts);
        DriverManager.registerDriver(observed);
        try (BufferedWriter writer = Files.newBufferedWriter(output, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
             JdbcConnectionPoolRegistry pool = new JdbcConnectionPoolRegistry()) {
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            if (args[0].equals("pooled")) ((AbstractJdbcAgent) agent).attachConnectionPoolRegistry(pool);
            JsonRpcServer rpc = new JsonRpcServer(agent);
            Map<String, Object> environment = new LinkedHashMap<>();
            environment.put("kind", "environment");
            environment.put("format", "dbx-health-probe-v1");
            environment.put("at", Instant.now().toString());
            environment.put("engine", "oceanbase-oracle");
            environment.put("mode", args[0]);
            environment.put("java", System.getProperty("java.version"));
            environment.put("os", System.getProperty("os.name"));
            environment.put("jdbc_driver", delegate.getMajorVersion() + "." + delegate.getMinorVersion());
            environment.put("samples_per_scenario", samples);
            environment.put("scope", "production RPC dispatch and JDBC boundary; no IPC, wire packet or GUI measurement");
            environment.put("wire_requests", "not_measured");
            environment.put("wire_observer", relayPort == null || relayPort.isBlank() ? "not_configured" : "external metadata relay; correlate separate wire evidence");
            environment.put("native_oracle", "not_measured");
            emit(writer, environment);
            try {
                for (int index = 0; index < samples; index++) {
                    sample(writer, rpc, counts, "connect", index, AgentProtocol.METHOD_CONNECT, connect, false);
                    if (index == 0 && !counts.physical.isEmpty()) {
                        var metadata = counts.physical.get(0).getMetaData();
                        emit(writer, Map.of("kind", "database_version", "database_version", metadata.getDatabaseProductVersion(),
                            "driver_version", metadata.getDriverVersion(), "scope", "metadata read outside query timing samples"));
                    }
                    sample(writer, rpc, counts, "cold_query", index, AgentProtocol.METHOD_EXECUTE_QUERY, query(), false);
                    sample(writer, rpc, counts, "warm_query", index, AgentProtocol.METHOD_EXECUTE_QUERY, query(), false);
                    Thread.sleep(5_100L);
                    sample(writer, rpc, counts, "idle_query", index, AgentProtocol.METHOD_EXECUTE_QUERY, query(), false);
                    // Close only this process's dedicated physical connections. A hot
                    // direct request may fail before its next validation window; record it.
                    counts.closeDedicatedConnections();
                    sample(writer, rpc, counts, "invalid_hot", index, AgentProtocol.METHOD_EXECUTE_QUERY, query(), false);
                    Thread.sleep(5_100L);
                    sample(writer, rpc, counts, "invalid_expired", index, AgentProtocol.METHOD_EXECUTE_QUERY, query(), false);
                    rpc.dispatchForRuntime(AgentProtocol.METHOD_DISCONNECT, new JsonObject());
                    sample(writer, rpc, counts, "reconnect", index, AgentProtocol.METHOD_CONNECT, connect, false);
                    sample(writer, rpc, counts, "after_reconnect", index, AgentProtocol.METHOD_EXECUTE_QUERY, query(), false);
                    sample(writer, rpc, counts, "cancel_race", index, AgentProtocol.METHOD_EXECUTE_QUERY, query(), true);
                    sample(writer, rpc, counts, "after_cancel", index, AgentProtocol.METHOD_EXECUTE_QUERY, query(), false);
                    rpc.dispatchForRuntime(AgentProtocol.METHOD_DISCONNECT, new JsonObject());
                }
            } finally { agent.disconnect(); }
        } finally { DriverManager.deregisterDriver(observed); }
    }

    private static JsonObject query() {
        JsonObject query = new JsonObject();
        query.addProperty("sql", SQL);
        query.addProperty("maxRows", 1);
        query.addProperty("timeoutSecs", 5);
        return query;
    }

    private static void sample(BufferedWriter writer, JsonRpcServer rpc, Counters counts, String scenario, int index,
                               String method, JsonObject params, boolean cancel) throws Exception {
        long[] before = counts.values();
        long started = System.nanoTime();
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("kind", "sample");
        row.put("scenario", scenario);
        row.put("index", index);
        row.put("at", Instant.now().toString());
        var cancellation = Executors.newSingleThreadScheduledExecutor();
        try {
            if (cancel) cancellation.schedule(rpc::cancelActiveStatements, 1, TimeUnit.MILLISECONDS);
            Object result = rpc.dispatchForRuntime(method, params);
            row.put("outcome", cancel ? "completed_during_cancel_race" : "success");
            if (result instanceof QueryResult queryResult) {
                boolean correct = queryResult.getRows().size() == 1 && queryResult.getRows().get(0).size() == 1
                    && "1".equals(String.valueOf(queryResult.getRows().get(0).get(0)));
                row.put("correct_result", correct);
                if (!correct) row.put("outcome", "incorrect_result");
                row.put("agent_stages_ms", queryResult.getQuery_timings_ms());
                row.put("reported_execution_ms", queryResult.getExecution_time_ms());
            }
        } catch (Exception error) {
            row.put("outcome", "error");
            SQLException sql = sqlCause(error);
            // SQLSTATE and vendor number only, never messages, SQL or connect parameters.
            row.put("sqlstate", sql != null && sql.getSQLState() != null && sql.getSQLState().matches("[0-9A-Z]{5}") ? sql.getSQLState() : "unknown");
            if (sql != null) row.put("vendor_code", sql.getErrorCode());
        } finally {
            row.put("dispatch_ms", (System.nanoTime() - started) / 1_000_000.0);
            row.put("completed_at", Instant.now().toString());
            cancellation.shutdownNow();
            if (!cancellation.awaitTermination(10, TimeUnit.SECONDS)) throw new IllegalStateException("cancel worker did not stop");
            long[] after = counts.values();
            row.put("jdbc_isValid_calls", after[0] - before[0]);
            row.put("jdbc_isValid_ms", (after[1] - before[1]) / 1_000_000.0);
            row.put("jdbc_statement_execute_calls", after[2] - before[2]);
            row.put("jdbc_statement_execute_ms", (after[3] - before[3]) / 1_000_000.0);
            row.put("physical_connect_calls", after[4] - before[4]);
            row.put("jdbc_cancel_calls", after[5] - before[5]);
            emit(writer, row);
        }
    }

    private static SQLException sqlCause(Throwable error) {
        for (int depth = 0; error != null && depth < 20; depth++, error = error.getCause()) if (error instanceof SQLException sql) return sql;
        return null;
    }
    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Missing configuration");
        return value;
    }
    private static void emit(BufferedWriter writer, Map<String, Object> row) throws Exception { writer.write(GSON.toJson(row)); writer.newLine(); writer.flush(); }

    private static final class Counters {
        final AtomicLong probes = new AtomicLong(), probeNanos = new AtomicLong(), executions = new AtomicLong(), executeNanos = new AtomicLong(), opens = new AtomicLong(), cancels = new AtomicLong();
        final List<Connection> physical = new CopyOnWriteArrayList<>();
        long[] values() { return new long[]{probes.get(), probeNanos.get(), executions.get(), executeNanos.get(), opens.get(), cancels.get()}; }
        void closeDedicatedConnections() throws SQLException { for (Connection connection : physical) connection.close(); physical.clear(); }
        Connection observe(Connection delegate) {
            physical.add(delegate);
            return (Connection) Proxy.newProxyInstance(HealthProbe.class.getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
                boolean probe = method.getName().equals("isValid");
                if (probe) probes.incrementAndGet();
                long started = System.nanoTime();
                try {
                    Object value = invoke(delegate, method, args);
                    if (value instanceof Statement statement && method.getName().equals("createStatement")) return observe(statement);
                    return value;
                } finally { if (probe) probeNanos.addAndGet(System.nanoTime() - started); }
            });
        }
        Statement observe(Statement delegate) {
            return (Statement) Proxy.newProxyInstance(HealthProbe.class.getClassLoader(), new Class<?>[]{Statement.class}, (proxy, method, args) -> {
                boolean execute = method.getName().startsWith("execute");
                if (execute) executions.incrementAndGet();
                if (method.getName().equals("cancel")) cancels.incrementAndGet();
                long started = System.nanoTime();
                try { return invoke(delegate, method, args); }
                finally { if (execute) executeNanos.addAndGet(System.nanoTime() - started); }
            });
        }
        private static Object invoke(Object target, Method method, Object[] args) throws Throwable {
            try { return method.invoke(target, args); }
            catch (InvocationTargetException error) { throw error.getCause(); }
        }
    }

    private record ObservedDriver(Driver delegate, Counters counts) implements Driver {
        @Override public Connection connect(String url, Properties info) throws SQLException {
            if (!delegate.acceptsURL(url)) return null;
            counts.opens.incrementAndGet();
            return counts.observe(delegate.connect(url, info));
        }
        @Override public boolean acceptsURL(String url) throws SQLException { return delegate.acceptsURL(url); }
        @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException { return delegate.getPropertyInfo(url, info); }
        @Override public int getMajorVersion() { return delegate.getMajorVersion(); }
        @Override public int getMinorVersion() { return delegate.getMinorVersion(); }
        @Override public boolean jdbcCompliant() { return delegate.jdbcCompliant(); }
        @Override public Logger getParentLogger() throws java.sql.SQLFeatureNotSupportedException { return delegate.getParentLogger(); }
    }
}
