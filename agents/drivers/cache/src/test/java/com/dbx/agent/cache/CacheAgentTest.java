package com.dbx.agent.cache;

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
import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CacheAgentTest {
    @Test
    void skipsSchemaSwitchingBecauseCacheRejectsSetSchemaContext() {
        CacheAgent agent = new CacheAgent();

        assertEquals("", agent.setSchemaSQL("SQLUser"));
    }

    @Test
    void buildsCacheJdbcUrlWithDefaultPort() {
        assertEquals(
            "jdbc:Cache://db.local:1972/USER",
            CacheAgent.CACHE_PROFILE.getUrlTemplate()
                .replace("{host}", "db.local")
                .replace("{port}", "1972")
                .replace("{database}", "USER")
        );
        assertEquals("com.intersys.jdbc.CacheDriver", CacheAgent.CACHE_PROFILE.getDriverClass());
    }

    @Test
    void dedupesSchemasCaseInsensitively() {
        assertEquals(
            Arrays.asList("APP", "SQLUSER", "z_user"),
            CacheAgent.dedupeCaseInsensitiveSchemas(Arrays.asList("APP", "SQLUSER", "SQLUser", "app", "z_user"))
        );
    }

    @Test
    void ignoresBlankSchemasWhenDeduping() {
        assertEquals(
            Collections.singletonList("SQLUSER"),
            CacheAgent.dedupeCaseInsensitiveSchemas(Arrays.asList("", " ", null, "SQLUSER"))
        );
    }

    @Test
    void readsVendorOtherValuesThroughGetObject() {
        List<String> calls = new ArrayList<>();
        ResultSet resultSet = proxy(ResultSet.class, (method, args) -> {
            if ("getObject".equals(method.getName())) {
                calls.add("getObject");
                return new Object() {
                    @Override
                    public String toString() {
                        return "%List(1,2)";
                    }
                };
            }
            if ("getString".equals(method.getName())) {
                calls.add("getString");
                throw new AssertionError("Caché %LIST must not use getString");
            }
            if ("wasNull".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });

        Object value = new CacheAgent().resultValue(resultSet, 1, Types.OTHER);

        assertEquals("%List(1,2)", value);
        assertEquals(Collections.singletonList("getObject"), calls);
    }

    @Test
    void preservesStringPathForStandardValues() {
        List<String> calls = new ArrayList<>();
        ResultSet resultSet = proxy(ResultSet.class, (method, args) -> {
            if ("getString".equals(method.getName())) {
                calls.add("getString");
                return "ordinary";
            }
            if ("wasNull".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });

        Object value = new CacheAgent().resultValue(resultSet, 1, Types.VARCHAR);

        assertEquals("ordinary", value);
        assertEquals(Collections.singletonList("getString"), calls);
    }

    @Test
    void preservesNullForVendorOtherValues() {
        List<String> calls = new ArrayList<>();
        ResultSet resultSet = proxy(ResultSet.class, (method, args) -> {
            if ("getObject".equals(method.getName())) {
                calls.add("getObject");
                return null;
            }
            if ("wasNull".equals(method.getName())) {
                return true;
            }
            return defaultValue(method.getReturnType());
        });

        Object value = new CacheAgent().resultValue(resultSet, 1, Types.OTHER);

        assertNull(value);
        assertEquals(Collections.singletonList("getObject"), calls);
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

        List<ColumnInfo> columns = CacheAgent.cacheColumns(conn, CacheAgent.CACHE_PROFILE, "USER", "SQLUser", "People");

        assertEquals(2, columns.size());
        assertEquals("ID", columns.get(0).getName());
        assertEquals("INTEGER", columns.get(0).getData_type());
        assertFalse(columns.get(0).getIs_nullable());
        assertTrue(columns.get(0).getIs_primary_key());
        assertEquals("42", columns.get(0).getColumn_default());
        assertEquals("identifier", columns.get(0).getComment());
        assertEquals(Integer.valueOf(10), columns.get(0).getNumeric_precision());
        assertEquals(Integer.valueOf(0), columns.get(0).getNumeric_scale());
        assertNull(columns.get(0).getCharacter_maximum_length());
        assertEquals("NAME", columns.get(1).getName());
        assertEquals("VARCHAR", columns.get(1).getData_type());
        assertTrue(columns.get(1).getIs_nullable());
        assertNull(columns.get(1).getColumn_default());
        assertNull(columns.get(1).getComment());
        assertNull(columns.get(1).getNumeric_precision());
        assertNull(columns.get(1).getNumeric_scale());
        assertEquals(Integer.valueOf(64), columns.get(1).getCharacter_maximum_length());
        assertEquals(1, calls.size());
        assertFalse(calls.get(0).contains("LIMIT"));
        assertTrue(calls.get(0).contains("PRIMARY_KEY"));
        assertTrue(calls.get(0).contains("DESCRIPTION"));
        assertTrue(calls.get(0).contains("INFORMATION_SCHEMA.COLUMNS"));
        assertTrue(calls.get(0).contains("UPPER(TABLE_SCHEMA) = UPPER(?)"));
    }

    @Test
    void readsDescriptionsWithoutSchemaFilter() {
        List<String> calls = new ArrayList<>();
        Connection conn = fakeConnection(
            calls,
            true,
            Collections.emptyList(),
            null,
            Collections.emptyList()
        );

        List<ColumnInfo> columns = CacheAgent.cacheColumns(conn, CacheAgent.CACHE_PROFILE, "", null, "People");

        assertEquals("identifier", columns.get(0).getComment());
        assertNull(columns.get(1).getComment());
        assertEquals(1, calls.size());
        assertTrue(calls.get(0).contains("DESCRIPTION"));
        assertFalse(calls.get(0).contains("TABLE_SCHEMA"));
    }

    @Test
    void usesJdbcPrimaryKeysWhenColumnRowsHaveNoPrimaryKey() {
        List<String> calls = new ArrayList<>();
        Connection conn = fakeConnection(
            calls,
            false,
            List.of(Map.of("COLUMN_NAME", "ID")),
            null,
            Collections.emptyList()
        );

        List<ColumnInfo> columns = CacheAgent.cacheColumns(conn, CacheAgent.CACHE_PROFILE, "USER", "SQLUser", "People");

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
            new SQLException("Caché metadata unavailable"),
            List.of(Map.of("COLUMN_NAME", "ID"))
        );

        List<ColumnInfo> columns = CacheAgent.cacheColumns(conn, CacheAgent.CACHE_PROFILE, "USER", "SQLUser", "People");

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

        List<ColumnInfo> columns = CacheAgent.cacheColumns(conn, CacheAgent.CACHE_PROFILE, "USER", "SQLUser", "People");

        assertFalse(columns.get(0).getIs_primary_key());
        assertFalse(columns.get(1).getIs_primary_key());
        assertTrue(calls.get(2).contains("INFORMATION_SCHEMA.KEY_COLUMN_USAGE"));
    }

    @Test
    void fallsBackToJdbcMetadataWhenInformationSchemaIsUnavailable() {
        List<String> calls = new ArrayList<>();
        Connection conn = proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                calls.add((String) args[0]);
                throw new SQLException("SQLCODE -361: unknown table INFORMATION_SCHEMA.COLUMNS");
            }
            if ("getMetaData".equals(method.getName())) {
                return jdbcFallbackMetadata(calls);
            }
            return defaultValue(method.getReturnType());
        });

        List<ColumnInfo> columns = CacheAgent.cacheColumns(conn, CacheAgent.CACHE_PROFILE, "USER", "SQLUser", "People");

        assertEquals(1, columns.size());
        assertEquals("ID", columns.get(0).getName());
        assertEquals("INTEGER", columns.get(0).getData_type());
        assertTrue(columns.get(0).getIs_primary_key());
        assertEquals(3, calls.size());
        assertTrue(calls.get(0).contains("INFORMATION_SCHEMA.COLUMNS"));
        assertEquals("JDBC_PRIMARY_KEYS", calls.get(1));
        assertEquals("JDBC_COLUMNS", calls.get(2));
    }

    private static DatabaseMetaData jdbcFallbackMetadata(List<String> calls) {
        return proxy(DatabaseMetaData.class, (method, args) -> {
            String name = method.getName();
            if ("getPrimaryKeys".equals(name)) {
                calls.add("JDBC_PRIMARY_KEYS");
                return fakeResultSet(List.of(Map.of("COLUMN_NAME", "ID")));
            }
            if ("getColumns".equals(name)) {
                calls.add("JDBC_COLUMNS");
                return fakeResultSet(List.of(Map.of(
                    "COLUMN_NAME", "ID",
                    "TYPE_NAME", "INTEGER",
                    "NULLABLE", 0,
                    "COLUMN_DEF", "0",
                    "REMARKS", "identifier",
                    "COLUMN_SIZE", 10,
                    "DECIMAL_DIGITS", 0
                )));
            }
            return defaultValue(method.getReturnType());
        });
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
                throw new AssertionError("Caché 2012+ columns must not use JDBC DatabaseMetaData.getColumns()");
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
                        "COLUMN_DEFAULT", "42",
                        "PRIMARY_KEY", inlinePrimaryKey ? "YES" : "NO",
                        "DESCRIPTION", "identifier",
                        "NUMERIC_PRECISION", 10,
                        "NUMERIC_SCALE", 0
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
            if ("getInt".equals(name)) {
                Object value = rows.get(index[0]).get((String) args[0]);
                wasNull[0] = value == null;
                return value instanceof Number ? ((Number) value).intValue() : 0;
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
