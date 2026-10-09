package com.dbx.agent;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/** Real RPC dispatch, agent execution and H2 queries; only the JDBC fault boundary is wrapped. */
class QueryHealthValidationTest {
    private static JsonObject query() {
        JsonObject params = new JsonObject();
        params.addProperty("sql", "SELECT 1");
        params.addProperty("maxRows", 1);
        params.addProperty("timeoutSecs", 2);
        return params;
    }

    private static JsonRpcServer connect(CountingAgent agent) throws Exception {
        JsonRpcServer server = new JsonRpcServer(agent);
        server.dispatchForRuntime(AgentProtocol.METHOD_CONNECT, new JsonObject());
        return server;
    }

    private static QueryResult execute(JsonRpcServer server) throws Exception {
        return (QueryResult) server.dispatchForRuntime(AgentProtocol.METHOD_EXECUTE_QUERY, query());
    }

    @Test
    void firstDirectQueryValidatesOnceAndImmediateWarmQueryReusesValidation() throws Exception {
        CountingAgent agent = new CountingAgent();
        try {
            JsonRpcServer server = connect(agent);
            assertEquals(0, agent.validations.get());
            assertEquals(1, execute(server).getRows().get(0).get(0));
            assertEquals(1, agent.validations.get());
            assertEquals(1, execute(server).getRows().get(0).get(0));
            assertEquals(1, agent.validations.get());
            assertEquals(1, agent.opens.get());
        } finally { agent.disconnect(); }
    }

    @Test
    void invalidConnectionIsReplacedBeforeFirstQuery() throws Exception {
        CountingAgent agent = new CountingAgent();
        try {
            JsonRpcServer server = connect(agent);
            agent.invalid = true;
            assertEquals(1, execute(server).getRows().get(0).get(0));
            assertEquals(2, agent.opens.get());
            assertEquals(1, agent.validations.get());
            assertFalse(agent.getConnection().isClosed());
        } finally { agent.disconnect(); }
    }

    @Test
    void reconnectFailureRemainsAFailureAndDoesNotExecuteUserQuery() throws Exception {
        CountingAgent agent = new CountingAgent();
        try {
            JsonRpcServer server = connect(agent);
            agent.invalid = true;
            agent.failOpen = true;
            assertThrows(Exception.class, () -> execute(server));
            assertEquals(0, agent.executions.get());
            assertEquals(2, agent.opens.get());
        } finally { agent.disconnect(); }
    }

    @Test
    void explicitValidationDoesNotReconnectAnInvalidConnection() throws Exception {
        CountingAgent agent = new CountingAgent();
        try {
            JsonRpcServer server = connect(agent);
            agent.invalid = true;
            assertThrows(IllegalStateException.class, () -> server.dispatchForRuntime(AgentProtocol.METHOD_VALIDATE_CONNECTION, new JsonObject()));
            assertEquals(1, agent.opens.get());
            assertEquals(0, agent.executions.get());
        } finally { agent.disconnect(); }
    }

    @Test
    void directAgentExecutionDoesNotAddASecondHealthProbe() throws Exception {
        CountingAgent agent = new CountingAgent();
        try {
            agent.connect(new ConnectParams());
            agent.executeQuery("SELECT 1", null, new ExecuteQueryOptions(1, null, 2, false));
            assertEquals(0, agent.validations.get());
            assertEquals(1, agent.executions.get());
        } finally { agent.disconnect(); }
    }

    @Test
    void pooledRpcDoesNotRunTheDirectFiveSecondHealthCheck() throws Exception {
        CountingAgent agent = new CountingAgent();
        try (JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry()) {
            agent.attachConnectionPoolRegistry(registry);
            JsonRpcServer server = connect(agent);
            execute(server);
            // Hikari may probe once if scheduling crosses its warm-lease window;
            // the RPC layer must not add a second probe for this checkout.
            int checks = agent.validations.get();
            execute(server);
            assertTrue(agent.validations.get() - checks <= 1);
            assertEquals(1, agent.opens.get());
            agent.disconnect();
        }
    }

    @Test
    void cancellationReachesTheActiveStatementAndDoesNotReconnectOrProbeAgain() throws Exception {
        CountingAgent agent = new CountingAgent();
        var worker = Executors.newSingleThreadExecutor();
        try {
            JsonRpcServer server = connect(agent);
            agent.blockQuery = true;
            var pending = worker.submit(() -> execute(server));
            assertTrue(agent.started.await(2, TimeUnit.SECONDS));
            server.cancelActiveStatements();
            assertThrows(java.util.concurrent.ExecutionException.class, () -> pending.get(2, TimeUnit.SECONDS));
            assertEquals(1, agent.cancels.get());
            assertEquals(1, agent.validations.get());
            assertEquals(1, agent.opens.get());
            agent.blockQuery = false;
            assertEquals(1, execute(server).getRows().get(0).get(0));
        } finally {
            agent.cancelled.countDown();
            worker.shutdownNow();
            agent.disconnect();
        }
    }

    private static final class CountingAgent extends ConfiguredJdbcAgent {
        final AtomicInteger opens = new AtomicInteger();
        final AtomicInteger validations = new AtomicInteger();
        final AtomicInteger executions = new AtomicInteger();
        final AtomicInteger cancels = new AtomicInteger();
        final CountDownLatch started = new CountDownLatch(1);
        final CountDownLatch cancelled = new CountDownLatch(1);
        volatile boolean invalid;
        volatile boolean failOpen;
        volatile boolean blockQuery;
        private final String url = "jdbc:h2:mem:health_" + UUID.randomUUID();

        CountingAgent() { super(new JdbcAgentProfile("org.h2.Driver", "jdbc:h2:mem:unused", 0, false, Set.of(), List.of("TABLE"))); }

        @Override protected Connection openConnection(ConnectParams params) throws Exception {
            opens.incrementAndGet();
            if (failOpen) throw new SQLException("dedicated reconnect failure", "08001");
            invalid = false;
            Connection delegate = DriverManager.getConnection(url);
            return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
                if ("isValid".equals(method.getName())) {
                    validations.incrementAndGet();
                    if (invalid) return false;
                }
                try {
                    Object value = method.invoke(delegate, args);
                    if ("createStatement".equals(method.getName())) return statement((Statement) value);
                    return value;
                } catch (InvocationTargetException error) { throw error.getCause(); }
            });
        }

        private Statement statement(Statement delegate) {
            return (Statement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Statement.class}, (proxy, method, args) -> {
                if ("cancel".equals(method.getName())) { cancels.incrementAndGet(); cancelled.countDown(); }
                if ("execute".equals(method.getName())) {
                    executions.incrementAndGet();
                    if (blockQuery) {
                        started.countDown();
                        if (!cancelled.await(2, TimeUnit.SECONDS)) throw new SQLException("fixture deadline");
                        throw new SQLException("cancelled", "57014");
                    }
                }
                try { return method.invoke(delegate, args); }
                catch (InvocationTargetException error) { throw error.getCause(); }
            });
        }
    }
}
