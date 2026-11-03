package com.dbx.agent;

import com.dbx.agent.transwarp.TranswarpAgent;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class TranswarpTransactionCancellationTest {
    @Test
    void rpcTimeoutReachesTheCustomTransactionStatement() throws Exception {
        Fixture fixture = new Fixture();
        fixture.run(7);
        assertEquals(7, fixture.timeout.get());
        fixture.run(0);
        assertEquals(0, fixture.timeout.get());
        assertEquals(2, fixture.commits.get());
    }

    @Test
    void cancellationRejectsLateBeginOrWriteSuccessWithoutCommitting() throws Exception {
        assertCancellation(false);
        assertCancellation(true);
    }

    private void assertCancellation(boolean failOnCancel) throws Exception {
        for (String blockedSql : List.of("BEGIN TRANSACTION", "UPDATE T SET C=1")) {
            Fixture fixture = new Fixture();
            fixture.blockedSql = blockedSql;
            fixture.failOnCancel = failOnCancel;
            ExecutorService worker = Executors.newSingleThreadExecutor();
            try {
                Future<?> result = worker.submit(() -> { fixture.run(7); return null; });
                assertTrue(fixture.started.await(3, TimeUnit.SECONDS));
                fixture.server.cancelActiveStatements();
                fixture.release.countDown();
                assertThrows(ExecutionException.class, () -> result.get(3, TimeUnit.SECONDS));
                assertEquals(1, fixture.cancels.get());
                assertEquals(blockedSql.startsWith("BEGIN") ? 0 : 1, fixture.writes.get());
                assertEquals(0, fixture.commits.get());
                assertEquals(1, fixture.rollbacks.get());
                fixture.blockedSql = null;
                fixture.run(0);
                assertEquals(1, fixture.commits.get());
            } finally {
                fixture.release.countDown();
                worker.shutdownNow();
            }
        }
    }

    private static final class Fixture {
        String blockedSql;
        boolean failOnCancel;
        final AtomicInteger timeout = new AtomicInteger();
        final AtomicInteger writes = new AtomicInteger();
        final AtomicInteger commits = new AtomicInteger();
        final AtomicInteger rollbacks = new AtomicInteger();
        final AtomicInteger cancels = new AtomicInteger();
        final CountDownLatch started = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        final JsonRpcServer server;

        Fixture() throws Exception {
            Connection connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
                if (method.getName().equals("createStatement")) {
                    timeout.set(0);
                    return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Statement.class}, (stmt, call, values) -> {
                        if (call.getName().equals("setQueryTimeout")) { timeout.set((int) values[0]); return null; }
                        if (call.getName().equals("cancel")) { cancels.incrementAndGet(); return null; }
                        if (call.getName().equals("getUpdateCount")) return 1;
                        if (call.getName().equals("execute")) {
                            String sql = (String) values[0];
                            if (sql.startsWith("UPDATE")) writes.incrementAndGet();
                            if (sql.equals("COMMIT")) commits.incrementAndGet();
                            if (sql.equals("ROLLBACK")) rollbacks.incrementAndGet();
                            if (sql.equals(blockedSql)) {
                                started.countDown();
                                assertTrue(release.await(3, TimeUnit.SECONDS));
                                if (failOnCancel) throw new java.sql.SQLTimeoutException("Statement cancelled");
                            }
                        }
                        return defaultValue(call.getReturnType());
                    });
                }
                return defaultValue(method.getReturnType());
            });
            TranswarpAgent agent = new TranswarpAgent();
            // Inject only the external JDBC boundary; dispatch and driver override are real.
            var field = AbstractJdbcAgent.class.getDeclaredField("connection");
            field.setAccessible(true);
            field.set(agent, connection);
            server = new JsonRpcServer(agent);
        }

        void run(int seconds) throws Exception {
            server.dispatchForRuntime("execute_transaction", JsonParser.parseString("{\"statements\":[\"UPDATE T SET C=1\",\"UPDATE T SET C=2\"],\"timeoutSecs\":" + seconds + "}").getAsJsonObject());
        }
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
}
