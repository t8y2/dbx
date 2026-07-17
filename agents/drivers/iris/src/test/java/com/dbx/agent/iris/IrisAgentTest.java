package com.dbx.agent.iris;

import com.dbx.agent.ColumnInfo;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
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
    void readsColumnsWithNativeInformationSchemaQueries() {
        List<String> sql = new ArrayList<>();
        Connection conn = fakeConnection(sql);

        List<ColumnInfo> columns = IrisAgent.irisColumns(conn, "SQLUser", "People");

        assertEquals(2, columns.size());
        assertEquals("ID", columns.get(0).getName());
        assertEquals("INTEGER", columns.get(0).getData_type());
        assertFalse(columns.get(0).getIs_nullable());
        assertTrue(columns.get(0).getIs_primary_key());
        assertEquals("NAME", columns.get(1).getName());
        assertEquals(Integer.valueOf(64), columns.get(1).getCharacter_maximum_length());
        assertFalse(sql.get(0).contains("LIMIT"));
        assertTrue(sql.get(0).contains("INFORMATION_SCHEMA.KEY_COLUMN_USAGE"));
        assertTrue(sql.get(1).contains("INFORMATION_SCHEMA.COLUMNS"));
    }

    private static Connection fakeConnection(List<String> sqlLog) {
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                String sql = (String) args[0];
                sqlLog.add(sql);
                return fakeStatement(sql);
            }
            if ("getMetaData".equals(method.getName())) {
                throw new AssertionError("IRIS columns must not use JDBC DatabaseMetaData.getColumns()");
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static PreparedStatement fakeStatement(String sql) {
        return proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                if (sql.contains("KEY_COLUMN_USAGE")) {
                    return fakeResultSet(List.of(Map.of("COLUMN_NAME", "ID")));
                }
                return fakeResultSet(List.of(
                    Map.of(
                        "COLUMN_NAME", "ID",
                        "DATA_TYPE", "INTEGER",
                        "IS_NULLABLE", "NO",
                        "NUMERIC_PRECISION", 10
                    ),
                    Map.of(
                        "COLUMN_NAME", "NAME",
                        "DATA_TYPE", "VARCHAR",
                        "IS_NULLABLE", "YES",
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
