package com.dbx.agent;

import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;

class BatchExecutorTest {
    @Test
    void executeBatchStatementsUsesJdbcBatch() {
        List<String> batchedSql = new ArrayList<>();
        AtomicInteger executeLargeBatchCalls = new AtomicInteger();
        AtomicInteger executeUpdateCalls = new AtomicInteger();

        Statement statement = statementProxy(batchedSql, executeLargeBatchCalls, executeUpdateCalls);
        Connection connection = connectionProxy(statement);

        QueryResult result = BatchExecutor.executeBatchStatements(
            connection,
            Arrays.asList(" INSERT INTO items VALUES (1); ", "UPDATE items SET name = 'Ada' WHERE id = 1;"),
            null,
            schema -> null
        );

        assertEquals(Arrays.asList("INSERT INTO items VALUES (1)", "UPDATE items SET name = 'Ada' WHERE id = 1"), batchedSql);
        assertEquals(1, executeLargeBatchCalls.get());
        assertEquals(0, executeUpdateCalls.get());
        assertEquals(2L, result.getAffected_rows());
    }

    private static Statement statementProxy(
        List<String> batchedSql,
        AtomicInteger executeLargeBatchCalls,
        AtomicInteger executeUpdateCalls
    ) {
        InvocationHandler handler = (Object unused, Method method, Object[] args) -> {
            switch (method.getName()) {
                case "addBatch":
                    batchedSql.add((String) args[0]);
                    return null;
                case "executeLargeBatch":
                    executeLargeBatchCalls.incrementAndGet();
                    return new long[]{1L, Statement.SUCCESS_NO_INFO};
                case "executeUpdate":
                    executeUpdateCalls.incrementAndGet();
                    throw new AssertionError("executeBatchStatements must not execute statements one by one");
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        return (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(), new Class<?>[]{Statement.class}, handler);
    }

    private static Connection connectionProxy(Statement statement) {
        InvocationHandler handler = (Object unused, Method method, Object[] args) -> {
            if ("createStatement".equals(method.getName())) {
                return statement;
            }
            return defaultValue(method.getReturnType());
        };
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, handler);
    }

    private static Object defaultValue(Class<?> type) {
        if (type == Boolean.TYPE) {
            return false;
        }
        if (type == Byte.TYPE) {
            return (byte) 0;
        }
        if (type == Short.TYPE) {
            return (short) 0;
        }
        if (type == Integer.TYPE) {
            return 0;
        }
        if (type == Long.TYPE) {
            return 0L;
        }
        if (type == Float.TYPE) {
            return 0f;
        }
        if (type == Double.TYPE) {
            return 0.0d;
        }
        if (type == Character.TYPE) {
            return '\0';
        }
        return null;
    }
}
