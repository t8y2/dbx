package com.dbx.agent.iris;

import com.dbx.agent.ColumnInfo;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class IrisAgentTest {
    @Test
    void skipsSchemaSwitchingBecauseIrisRejectsSetSchemaContext() {
        IrisAgent agent = new IrisAgent();

        assertEquals("", agent.setSchemaSQL("Ens"));
    }

    @Test
    void dedupesSchemasCaseInsensitively() {
        assertEquals(
            Arrays.asList("APP", "SQLUSER", "z_user"),
            IrisAgent.dedupeCaseInsensitiveSchemas(Arrays.asList("APP", "SQLUSER", "SQLUser", "app", "z_user"))
        );
    }

    @Test
    void ignoresBlankSchemasWhenDeduping() {
        assertEquals(
            Collections.singletonList("SQLUSER"),
            IrisAgent.dedupeCaseInsensitiveSchemas(Arrays.asList("", " ", null, "SQLUSER"))
        );
    }

    @Test
    void readsColumnsAndUsesInlinePrimaryKey() {
        List<String> calls = new ArrayList<>();
        Connection conn = fakeConnection(
            calls,
            true,
            Collections.emptyList(),
            null,
            Collections.emptyList()
        );

        List<ColumnInfo> columns = IrisAgent.irisColumns(conn, "SQLUser", "People");

        assertEquals(2, columns.size());
        assertEquals("ID", columns.get(0).getName());
        assertEquals("INTEGER", columns.get(0).getData_type());
        assertFalse(columns.get(0).getIs_nullable());
        assertTrue(columns.get(0).getIs_primary_key());
        assertEquals("NAME", columns.get(1).getName());
        assertEquals(Integer.valueOf(64), columns.get(1).getCharacter_maximum_length());
        assertEquals(1, calls.size());
        assertFalse(calls.get(0).contains("LIMIT"));
        assertTrue(calls.get(0).contains("PRIMARY_KEY"));
        assertTrue(calls.get(0).contains("INFORMATION_SCHEMA.COLUMNS"));
    }

    @Test
    void usesJdbcPrimaryKeysWhenColumnRowsHaveNoPrimaryKey() {
        List<String> calls = new ArrayList<>();
        Connection conn = fakeConnection(
            calls,
            false,
            List.of(Map.of("COLUMN_NAME", "ID")),
            null,
            List.of(Map.of("COLUMN_NAME", "NATIVE_ID"))
        );

        List<ColumnInfo> columns = IrisAgent.irisColumns(conn, "SQLUser", "People");

        assertTrue(columns.get(0).getIs_primary_key());
        assertEquals(2, calls.size());
        assertTrue(calls.get(0).contains("INFORMATION_SCHEMA.COLUMNS"));
        assertEquals("JDBC_PRIMARY_KEYS", calls.get(1));
    }

    @Test
    void fallsBackToNativePrimaryKeysWhenJdbcMetadataFails() {
        List<String> calls = new ArrayList<>();
        Connection conn = fakeConnection(
            calls,
            false,
            Collections.emptyList(),
            new SQLException("IRIS metadata unavailable"),
            List.of(Map.of("COLUMN_NAME", "ID"))
        );

        List<ColumnInfo> columns = IrisAgent.irisColumns(conn, "SQLUser", "People");

        assertTrue(columns.get(0).getIs_primary_key());
        assertTrue(calls.get(0).contains("INFORMATION_SCHEMA.COLUMNS"));
        assertEquals("JDBC_PRIMARY_KEYS", calls.get(1));
        assertTrue(calls.get(2).contains("INFORMATION_SCHEMA.KEY_COLUMN_USAGE"));
    }

    @Test
    void leavesColumnsWithoutPrimaryKeysWhenBothSourcesAreEmpty() {
        List<String> calls = new ArrayList<>();
        Connection conn = fakeConnection(
            calls,
            false,
            Collections.emptyList(),
            null,
            Collections.emptyList()
        );

        List<ColumnInfo> columns = IrisAgent.irisColumns(conn, "SQLUser", "People");

        assertFalse(columns.get(0).getIs_primary_key());
        assertFalse(columns.get(1).getIs_primary_key());
        assertTrue(calls.get(2).contains("INFORMATION_SCHEMA.KEY_COLUMN_USAGE"));
    }

    private static Connection fakeConnection(
        List<String> callLog,
        boolean inlinePrimaryKey,
        List<Map<String, Object>> jdbcPrimaryKeys,
        SQLException jdbcPrimaryKeyFailure,
        List<Map<String, Object>> nativePrimaryKeys
    ) {
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                String sql = (String) args[0];
                callLog.add(sql);
                return fakeStatement(sql, inlinePrimaryKey, nativePrimaryKeys);
            }
            if ("getMetaData".equals(method.getName())) {
                return fakeMetadata(callLog, jdbcPrimaryKeys, jdbcPrimaryKeyFailure);
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static DatabaseMetaData fakeMetadata(
        List<String> callLog,
        List<Map<String, Object>> jdbcPrimaryKeys,
        SQLException jdbcPrimaryKeyFailure
    ) {
        return proxy(DatabaseMetaData.class, (method, args) -> {
            if ("getPrimaryKeys".equals(method.getName())) {
                callLog.add("JDBC_PRIMARY_KEYS");
                assertEquals(null, args[0]);
                assertEquals("SQLUser", args[1]);
                assertEquals("People", args[2]);
                if (jdbcPrimaryKeyFailure != null) {
                    throw jdbcPrimaryKeyFailure;
                }
                return fakeResultSet(jdbcPrimaryKeys);
            }
            if ("getColumns".equals(method.getName())) {
                throw new AssertionError("IRIS columns must not use JDBC DatabaseMetaData.getColumns()");
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static PreparedStatement fakeStatement(
        String sql,
        boolean inlinePrimaryKey,
        List<Map<String, Object>> nativePrimaryKeys
    ) {
        return proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                if (sql.contains("KEY_COLUMN_USAGE")) {
                    return fakeResultSet(nativePrimaryKeys);
                }
                return fakeResultSet(List.of(
                    Map.of(
                        "COLUMN_NAME", "ID",
                        "DATA_TYPE", "INTEGER",
                        "IS_NULLABLE", "NO",
                        "PRIMARY_KEY", inlinePrimaryKey ? "YES" : "NO",
                        "NUMERIC_PRECISION", 10
                    ),
                    Map.of(
                        "COLUMN_NAME", "NAME",
                        "DATA_TYPE", "VARCHAR",
                        "IS_NULLABLE", "YES",
                        "PRIMARY_KEY", "NO",
                        "CHARACTER_MAXIMUM_LENGTH", 64
                    )
                ));
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet fakeResultSet(List<Map<String, Object>> rows) {
        final int[] index = {-1};
        final boolean[] wasNull = {false};
        return proxy(ResultSet.class, (method, args) -> {
            String name = method.getName();
            if ("next".equals(name)) {
                index[0] += 1;
                return index[0] < rows.size();
            }
            if ("getString".equals(name)) {
                Object value = rows.get(index[0]).get((String) args[0]);
                wasNull[0] = value == null;
                return value == null ? null : String.valueOf(value);
            }
            if ("getObject".equals(name)) {
                Object value = rows.get(index[0]).get((String) args[0]);
                wasNull[0] = value == null;
                return value;
            }
            if ("wasNull".equals(name)) {
                return wasNull[0];
            }
            return defaultValue(method.getReturnType());
        });
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                return handler.handle(method, args == null ? new Object[0] : args);
            }
        };
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler);
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) {
            return false;
        }
        if (Integer.TYPE.equals(type)) {
            return 0;
        }
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
