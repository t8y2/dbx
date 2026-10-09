package com.dbx.agent;

import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class JdbcBoundedCursorTest {
    @Test
    void boundsTheWholeCursorAndPreservesDuplicateColumnsAndLookahead() {
        for (int max : new int[]{0, 1, 3, 10000, Integer.MAX_VALUE}) {
            for (int count : new int[]{0, 1, 2, 3, 4, 5}) {
                Fixture f = new Fixture(count);
                QueryPageResult page = f.start(new QueryPageOptions(1, null, max));
                List<List<Object>> rows = new ArrayList<>(page.getRows());
                while (page.getHas_more()) {
                    page = f.executor.fetchPage(page.getSession_id(), 1);
                    rows.addAll(page.getRows());
                }
                int expected = Math.min(count, Math.max(max, 1));
                assertEquals(expected, rows.size());
                for (int i = 0; i < expected; i++) assertEquals(List.of(i + 1, i + 1), rows.get(i));
                assertEquals(List.of("NAME", "NAME"), page.getColumns());
                assertEquals(count > expected, page.getTruncated());
                assertEquals(JdbcExecutor.statementMaxRows(max), f.statementLimit);
                assertEquals(1, f.fetchSize);
                f.assertClosed();
            }
        }
    }

    @Test
    void usesPositiveDefaultFetchSizeAndPreservesExplicitFetchSize() {
        for (Integer fetch : new Integer[]{null, 0, -1, 7}) {
            Fixture f = new Fixture(5);
            f.start(new QueryPageOptions(0, fetch, 3));
            assertEquals(fetch != null && fetch > 0 ? fetch : 1, f.fetchSize);
            f.executor.closeAllQuerySessions();
            f.assertClosed();
        }
        Fixture defaults = new Fixture(1);
        defaults.start(new QueryPageOptions());
        assertEquals(10001, defaults.statementLimit);
        assertEquals(100, defaults.fetchSize);
        defaults.assertClosed();
    }

    @Test
    void leavesOrdinaryCursorPolicyUnchanged() {
        Fixture f = new Fixture(5);
        f.executor.executePage(f.connection, "SELECT name, name FROM people", null, schema -> "",
            new QueryPageOptions(1, null, 3));
        assertEquals(0, f.statementLimit);
        assertEquals(0, f.fetchSize);
        f.executor.cancelActiveStatements();
        f.assertClosed();
    }

    @Test
    void cleansUpLimitFetchExecuteAndReadFailures() {
        for (String failure : List.of("setMaxRows", "setFetchSize", "execute", "next")) {
            Fixture f = new Fixture(5);
            f.failure = failure;
            RuntimeException error = assertThrows(RuntimeException.class, () -> f.start(new QueryPageOptions()));
            assertTrue(error.toString().contains("fixture " + failure));
            f.assertClosed();
        }
        Fixture f = new Fixture(5);
        QueryPageResult page = f.start(new QueryPageOptions(1, null, 3));
        f.failure = "next";
        assertThrows(RuntimeException.class, () -> f.executor.fetchPage(page.getSession_id(), 1));
        f.assertClosed();
    }

    @Test
    void cancelsActiveExecutionAndIdleBoundedCursor() {
        Fixture executing = new Fixture(5);
        executing.cancelOnExecute = true;
        assertThrows(RuntimeException.class, () -> executing.start(new QueryPageOptions()));
        assertEquals(1, executing.cancels);
        executing.assertClosed();

        Fixture idle = new Fixture(5);
        idle.start(new QueryPageOptions(1, null, 3));
        idle.executor.cancelActiveStatements();
        assertEquals(1, idle.cancels);
        idle.assertClosed();

        Fixture fetching = new Fixture(5);
        QueryPageResult page = fetching.start(new QueryPageOptions(1, null, 3));
        fetching.cancelOnNext = true;
        assertThrows(RuntimeException.class, () -> fetching.executor.fetchPage(page.getSession_id(), 1));
        assertEquals(1, fetching.cancels);
        fetching.assertClosed();
    }

    private static final class Fixture {
        final JdbcExecutor executor = new JdbcExecutor();
        final int count;
        int row;
        int statementLimit;
        int fetchSize;
        int closes;
        int cancels;
        String failure;
        boolean cancelOnExecute;
        boolean cancelOnNext;
        final ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (object, method, args) -> {
            switch (method.getName()) {
                case "getColumnCount": return 2;
                case "getColumnLabel": return "NAME";
                case "getColumnType": return Types.INTEGER;
                case "getColumnTypeName": return "NUMBER";
                default: return zero(method.getReturnType());
            }
        });
        final ResultSet result = proxy(ResultSet.class, (object, method, args) -> {
            fail(method.getName());
            switch (method.getName()) {
                case "getMetaData": return metadata;
                case "next": return nextRow();
                case "getInt": case "getObject": return row;
                default: return zero(method.getReturnType());
            }
        });
        final Statement statement = proxy(Statement.class, (object, method, args) -> {
            fail(method.getName());
            switch (method.getName()) {
                case "hashCode": return System.identityHashCode(object);
                case "equals": return object == args[0];
                case "setMaxRows": statementLimit = (Integer) args[0]; return null;
                case "setFetchSize": fetchSize = (Integer) args[0]; return null;
                case "execute":
                    if (cancelOnExecute) {
                        executor.cancelActiveStatements();
                        throw new SQLException("fixture canceled");
                    }
                    return true;
                case "getResultSet": return result;
                case "close": closes++; return null;
                case "cancel": cancels++; return null;
                default: return zero(method.getReturnType());
            }
        });
        final Connection connection = proxy(Connection.class, (object, method, args) ->
            "createStatement".equals(method.getName()) ? statement : zero(method.getReturnType()));

        Fixture(int count) { this.count = count; }

        boolean nextRow() throws SQLException {
            if (cancelOnNext) {
                executor.cancelActiveStatements();
                throw new SQLException("fixture canceled during fetch");
            }
            return ++row <= count && (statementLimit == 0 || row <= statementLimit);
        }

        void fail(String method) throws SQLException {
            if (method.equals(failure)) throw new SQLException("fixture " + method);
        }

        QueryPageResult start(QueryPageOptions options) {
            return executor.executeBoundedPage(connection, "SELECT name, name FROM people", null,
                schema -> "", () -> "", options, executor::defaultResultValue);
        }

        void assertClosed() {
            assertTrue(closes > 0);
            assertFalse(executor.hasActiveStatements());
            assertFalse(executor.hasOpenSessions());
        }
    }

    private static Object zero(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }
}
