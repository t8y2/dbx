package com.dbx.agent;

import java.lang.reflect.Proxy;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class JdbcNativeStatementTrackingTest {
    @Test
    void trackedStatementKeepsOriginalIdentityAndCancellationIsSessionLocal() throws Exception {
        JdbcExecutor target = new JdbcExecutor();
        JdbcExecutor sibling = new JdbcExecutor();
        AtomicInteger targetCancels = new AtomicInteger();
        AtomicInteger siblingCancels = new AtomicInteger();
        PreparedStatement original = statement(targetCancels, null);
        try (var a = target.trackStatement(original); var b = sibling.trackStatement(statement(siblingCancels, null))) {
            assertSame(original, a.statement());
            target.cancelActiveStatements();
            assertEquals(1, targetCancels.get());
            assertEquals(0, siblingCancels.get());
            assertTrue(target.hasActiveStatements());
            assertTrue(sibling.hasActiveStatements());
        }
        assertFalse(target.hasActiveStatements());
        assertFalse(sibling.hasActiveStatements());
    }

    @Test
    void registrationIsRemovedEvenWhenJdbcCloseFails() {
        JdbcExecutor executor = new JdbcExecutor();
        SQLException failure = new SQLException("close failed");
        var tracked = executor.trackStatement(statement(new AtomicInteger(), failure));
        assertSame(failure, assertThrows(SQLException.class, tracked::close));
        assertFalse(executor.hasActiveStatements());
        assertDoesNotThrow(tracked::close);
    }

    @Test
    void cancellationLatchesAcrossStatementGapsButDoesNotPoisonNextNativeOperation() {
        JdbcExecutor executor = new JdbcExecutor();
        try (var operation = executor.beginNativeOperation()) {
            assertFalse(executor.hasActiveStatements());
            executor.cancelActiveStatements();
            assertThrows(CancellationException.class, operation::checkCancelled);
        }
        try (var next = executor.beginNativeOperation()) {
            assertDoesNotThrow(next::checkCancelled);
        }
    }

    private static PreparedStatement statement(AtomicInteger cancels, SQLException closeError) {
        return (PreparedStatement) Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(),
            new Class<?>[]{PreparedStatement.class}, (proxy, method, args) -> {
                if ("cancel".equals(method.getName())) cancels.incrementAndGet();
                if ("close".equals(method.getName()) && closeError != null) throw closeError;
                if ("hashCode".equals(method.getName())) return System.identityHashCode(proxy);
                if ("equals".equals(method.getName())) return proxy == args[0];
                if (method.getReturnType() == boolean.class) return false;
                if (method.getReturnType() == int.class) return 0;
                return null;
            });
    }
}
