package com.dbx.agent;

import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import java.lang.reflect.Proxy;
import java.sql.*;
import java.util.List;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class JsonRpcBatchLifecycleTest {
    @Test
    void ordinaryBatchHonorsRpcStatementTimeout() throws Exception {
        Fixture fixture = new Fixture();
        fixture.expectedTimeout = 7;
        QueryResult result = (QueryResult) fixture.server.dispatchForRuntime("execute_batch", params(7));
        assertEquals(2, result.getAffected_rows());
    }

    @Test
    void cancellationAtAgentDispatchBoundaryPreventsBatchAndTransactionWrites() throws Exception {
        for (String method : List.of("execute_batch", "execute_transaction")) {
            Fixture fixture = new Fixture();
            fixture.cancelBeforeExecutor = true;
            assertThrows(Exception.class, () -> fixture.server.dispatchForRuntime(method, params(0)));
            assertEquals(0, fixture.writes.get());
            assertEquals(0, fixture.commits.get());
        }
    }

    @Test
    void cancellationBeforeUnsupportedLargeBatchFallbackDoesNotExecuteBatchAgain() throws Exception {
        Fixture fixture = new Fixture();
        fixture.cancelWhenLargeBatchUnsupported = true;
        assertThrows(Exception.class, () -> fixture.server.dispatchForRuntime("execute_batch", params(0)));
        assertEquals(0, fixture.fallbackWrites.get());
    }

    @Test
    void cancelledTransactionWithUnconfirmedRollbackClosesWithoutEnablingAutoCommit() throws Exception {
        Fixture fixture = new Fixture();
        fixture.cancelBeforeExecutor = false;
        fixture.cancelDuringWrite = true;
        fixture.rollbackFails = true;
        Exception failure = assertThrows(Exception.class, () -> fixture.server.dispatchForRuntime("execute_transaction", params(0)));
        assertEquals(0, fixture.autoCommitRestored.get());
        assertEquals(1, fixture.connectionCloses.get());
        assertTrue(failure.toString().contains("rollback was not confirmed"));
    }

    @Test
    void transactionAndFallbackStatementsHonorTimeoutWithoutLeakingToLaterRpc() throws Exception {
        Fixture fixture = new Fixture();
        fixture.expectedTimeout = 7;
        assertEquals(2, ((QueryResult) fixture.server.dispatchForRuntime("execute_transaction", params(7))).getAffected_rows());
        fixture.fallback = true;
        fixture.server.dispatchForRuntime("execute_batch", params(7));
        fixture.expectedTimeout = 0;
        fixture.server.dispatchForRuntime("execute_transaction", params(0));
    }

    @Test
    void cancellingJdbcBatchRejectsItsLateSuccessAndLeavesNextRpcUsable() throws Exception {
        Fixture fixture = new Fixture();
        fixture.block = true;
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<?> result = worker.submit(() -> fixture.server.dispatchForRuntime("execute_batch", params(0)));
            assertTrue(fixture.started.await(3, TimeUnit.SECONDS));
            fixture.server.cancelActiveStatements();
            fixture.release.countDown();
            assertThrows(ExecutionException.class, () -> result.get(3, TimeUnit.SECONDS));
            assertEquals(1, fixture.cancels.get());
            fixture.block = false;
            assertEquals(2, ((QueryResult) fixture.server.dispatchForRuntime("execute_batch", params(0))).getAffected_rows());
        } finally {
            fixture.release.countDown();
            worker.shutdownNow();
        }
    }

    @Test
    void cancellationStopsFallbackBatchBeforeTheNextWrite() throws Exception {
        Fixture fixture = new Fixture();
        fixture.fallback = true;
        fixture.block = true;
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<?> result = worker.submit(() -> fixture.server.dispatchForRuntime("execute_batch", params(0)));
            assertTrue(fixture.started.await(3, TimeUnit.SECONDS));
            fixture.server.cancelActiveStatements();
            fixture.release.countDown();
            assertThrows(ExecutionException.class, () -> result.get(3, TimeUnit.SECONDS));
            assertEquals(1, fixture.writes.get());
            assertEquals(1, fixture.cancels.get());
        } finally {
            fixture.release.countDown();
            worker.shutdownNow();
        }
    }

    @Test
    void cancellationRollsBackTransactionInsteadOfCommittingOrStartingNextWrite() throws Exception {
        Fixture fixture = new Fixture();
        fixture.block = true;
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<?> result = worker.submit(() -> fixture.server.dispatchForRuntime("execute_transaction", params(0)));
            assertTrue(fixture.started.await(3, TimeUnit.SECONDS));
            fixture.server.cancelActiveStatements();
            fixture.release.countDown();
            assertThrows(ExecutionException.class, () -> result.get(3, TimeUnit.SECONDS));
            assertEquals(1, fixture.writes.get());
            assertEquals(1, fixture.cancels.get());
            assertEquals(0, fixture.commits.get());
            assertEquals(1, fixture.rollbacks.get());
        } finally {
            fixture.release.countDown();
            worker.shutdownNow();
        }
    }

    private static com.google.gson.JsonObject params(int timeout) {
        return JsonParser.parseString("{\"statements\":[\"UPDATE T SET C=1\",\"UPDATE T SET C=2\"],\"timeoutSecs\":" + timeout + "}").getAsJsonObject();
    }

    private static final class Fixture {
        int expectedTimeout;
        boolean fallback;
        boolean block;
        boolean cancelBeforeExecutor;
        boolean cancelWhenLargeBatchUnsupported;
        boolean cancelDuringWrite;
        boolean rollbackFails;
        final AtomicInteger fallbackWrites = new AtomicInteger();
        final AtomicInteger autoCommitRestored = new AtomicInteger();
        final AtomicInteger connectionCloses = new AtomicInteger();
        final CountDownLatch started = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        final AtomicInteger writes = new AtomicInteger();
        final AtomicInteger cancels = new AtomicInteger();
        final AtomicInteger commits = new AtomicInteger();
        final AtomicInteger rollbacks = new AtomicInteger();
        final JsonRpcServer server;
        Fixture() {
            Connection connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class}, (p, m, a) -> {
                if (m.getName().equals("createStatement")) return statement();
                if (m.getName().equals("getAutoCommit")) return true;
                if (m.getName().equals("isValid")) return true;
                if (m.getName().equals("commit")) { commits.incrementAndGet(); return null; }
                if (m.getName().equals("rollback")) { rollbacks.incrementAndGet(); if (rollbackFails) throw new SQLException("rollback network failure", "08006"); return null; }
                if (m.getName().equals("setAutoCommit") && Boolean.TRUE.equals(a[0])) { autoCommitRestored.incrementAndGet(); return null; }
                if (m.getName().equals("close")) { connectionCloses.incrementAndGet(); return null; }
                if (m.getName().equals("getMetaData")) return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{DatabaseMetaData.class}, (q, n, b) -> {
                    if (n.getName().equals("supportsTransactions")) return true;
                    if (n.getName().equals("getIdentifierQuoteString")) return "\"";
                    return defaultValue(n.getReturnType());
                });
                return defaultValue(m.getReturnType());
            });
            ConfiguredJdbcAgent agent = new ConfiguredJdbcAgent(new JdbcAgentProfile("unused", "jdbc:test", 1, false, Set.of(), List.of())) {
                @Override protected void loadDriver(ConnectParams params) { }
                @Override protected Connection openConnection(ConnectParams params) { return connection; }
                @Override public QueryResult executeBatch(List<String> statements, String schema) {
                    if (cancelBeforeExecutor) server.cancelActiveStatements();
                    return super.executeBatch(statements, schema);
                }
                @Override public QueryResult executeTransaction(List<String> statements, String schema) {
                    if (cancelBeforeExecutor) server.cancelActiveStatements();
                    return super.executeTransaction(statements, schema);
                }
            };
            agent.connect(new ConnectParams());
            server = new JsonRpcServer(agent);
        }
        Statement statement() {
            AtomicInteger timeout = new AtomicInteger();
            return (Statement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Statement.class}, (p, m, a) -> {
                if (m.getName().equals("setQueryTimeout")) { timeout.set((int) a[0]); return null; }
                if (m.getName().equals("addBatch") && fallback) throw new SQLFeatureNotSupportedException();
                if (m.getName().equals("cancel")) { cancels.incrementAndGet(); return null; }
                if (m.getName().equals("execute") || m.getName().equals("executeUpdate")) {
                    if (timeout.get() != expectedTimeout) throw new SQLTimeoutException("Statement has no requested execution timeout");
                    writes.incrementAndGet();
                    if (cancelDuringWrite) server.cancelActiveStatements();
                    if (block && writes.get() == 1) { started.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); }
                    return m.getName().equals("execute") ? false : 1;
                }
                if (m.getName().equals("executeLargeBatch")) {
                    writes.incrementAndGet();
                    if (cancelWhenLargeBatchUnsupported) {
                        server.cancelActiveStatements();
                        throw new SQLFeatureNotSupportedException();
                    }
                    if (timeout.get() != expectedTimeout) throw new SQLTimeoutException("Statement has no requested execution timeout");
                    if (block) { started.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); }
                    return new long[]{1, 1};
                }
                if (m.getName().equals("executeBatch")) { fallbackWrites.incrementAndGet(); return new int[]{1, 1}; }
                return defaultValue(m.getReturnType());
            });
        }
    }
    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
}
