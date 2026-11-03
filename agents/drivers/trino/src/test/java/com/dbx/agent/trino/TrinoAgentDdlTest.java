package com.dbx.agent.trino;

import com.dbx.agent.test.TestSupport;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * #11977: Trino DDL must come from {@code SHOW CREATE TABLE} so the
 * {@code WITH (...)} connector-property clause survives. Building the DDL from
 * column metadata alone produced a statement that no longer round-tripped.
 */
class TrinoAgentDdlTest {
    private static final String TABLE_WITH_PROPERTIES = "CREATE TABLE hive.native_map.fact_pid_limited (\n" +
        "   pid varchar,\n" +
        "   record_id bigint,\n" +
        "   amount varchar,\n" +
        "   payload varchar\n" +
        ")\n" +
        "WITH (\n" +
        "   bucket_count = 32,\n" +
        "   bucketed_by = ARRAY['pid'],\n" +
        "   bucketing_version = 2,\n" +
        "   format = 'ORC',\n" +
        "   sorted_by = ARRAY[]\n" +
        ")";

    @Test
    void getTableDdlKeepsTheWithClauseFromShowCreateTable() {
        List<String> sql = new ArrayList<>();
        TrinoAgent agent = new TrinoAgent();
        TestSupport.setPrivateConnection(agent, connection(sql, TABLE_WITH_PROPERTIES, null, false));

        String ddl = agent.getTableDdl("native_map", "fact_pid_limited");

        Assertions.assertEquals(TABLE_WITH_PROPERTIES, ddl);
        Assertions.assertTrue(ddl.contains("WITH ("), ddl);
        Assertions.assertTrue(ddl.contains("bucket_count = 32"), ddl);
        Assertions.assertEquals(List.of("SHOW CREATE TABLE \"native_map\".\"fact_pid_limited\""), sql);
    }

    @Test
    void getTableDdlQualifiesTheSessionCatalogWhenKnown() {
        List<String> sql = new ArrayList<>();
        TrinoAgent agent = new TrinoAgent();
        TestSupport.setPrivateConnection(agent, connection(sql, "CREATE TABLE native_ddl", "hive", false));

        String ddl = agent.getTableDdl("native_map", "orders");

        Assertions.assertEquals("CREATE TABLE native_ddl", ddl);
        Assertions.assertEquals(List.of("SHOW CREATE TABLE \"hive\".\"native_map\".\"orders\""), sql);
    }

    @Test
    void getTableDdlEscapesEmbeddedQuotesInIdentifiers() {
        List<String> sql = new ArrayList<>();
        TrinoAgent agent = new TrinoAgent();
        TestSupport.setPrivateConnection(agent, connection(sql, "CREATE TABLE native_ddl", null, false));

        agent.getTableDdl("we\"ird", "or\"ders");

        Assertions.assertEquals(List.of("SHOW CREATE TABLE \"we\"\"ird\".\"or\"\"ders\""), sql);
    }

    @Test
    void getTableDdlFallsBackToColumnMetadataWhenShowCreateTableFails() {
        List<String> sql = new ArrayList<>();
        TrinoAgent agent = new TrinoAgent();
        TestSupport.setPrivateConnection(agent, connection(sql, null, null, true));

        String ddl = agent.getTableDdl("native_map", "fact_pid_limited");

        // The fallback still produces usable DDL, just without connector properties.
        Assertions.assertTrue(ddl.startsWith("CREATE TABLE"), ddl);
        Assertions.assertFalse(ddl.contains("WITH ("), ddl);
        Assertions.assertEquals("SHOW CREATE TABLE \"native_map\".\"fact_pid_limited\"", sql.get(0));
    }

    private static Connection connection(List<String> sql, String nativeDdl, String catalog, boolean failShowCreate) {
        Statement statement = proxy(Statement.class, (method, args) -> {
            if ("execute".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return false;
            }
            if ("executeQuery".equals(method.getName())) {
                String query = String.valueOf(args[0]);
                sql.add(query);
                if (query.startsWith("SHOW CREATE TABLE")) {
                    if (failShowCreate) {
                        throw new SQLException("SHOW CREATE TABLE is unavailable");
                    }
                    return resultSet(new String[]{"Create Table"}, new Object[][]{{nativeDdl}});
                }
                if (query.startsWith("DESCRIBE")) {
                    return resultSet(
                        new String[]{"Column", "Type", "Extra", "Comment"},
                        new Object[][]{
                            {"pid", "varchar", "", null},
                            {"record_id", "bigint", "", null}
                        }
                    );
                }
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return statement;
            }
            if ("getCatalog".equals(method.getName())) {
                return catalog;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet resultSet(String[] columns, Object[][] rows) {
        int[] index = {-1};
        ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (method, args) -> {
            if ("getColumnCount".equals(method.getName())) {
                return columns.length;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(ResultSet.class, (method, args) -> {
            if ("next".equals(method.getName())) {
                index[0] += 1;
                return index[0] < rows.length;
            }
            if ("getString".equals(method.getName())) {
                Object key = args[0];
                int column = key instanceof Number ? ((Number) key).intValue() - 1 : findColumn(columns, String.valueOf(key));
                Object value = rows[index[0]][column];
                return value == null ? null : String.valueOf(value);
            }
            if ("getMetaData".equals(method.getName())) {
                return metadata;
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static int findColumn(String[] columns, String name) {
        for (int i = 0; i < columns.length; i++) {
            if (columns[i].equalsIgnoreCase(name)) {
                return i;
            }
        }
        throw new IllegalArgumentException("Unknown column: " + name);
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = (proxy, method, args) -> handler.handle(method, args == null ? new Object[0] : args);
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == Boolean.TYPE) return false;
        if (type == Byte.TYPE) return (byte) 0;
        if (type == Short.TYPE) return (short) 0;
        if (type == Integer.TYPE) return 0;
        if (type == Long.TYPE) return 0L;
        if (type == Float.TYPE) return 0f;
        if (type == Double.TYPE) return 0d;
        if (type == Character.TYPE) return (char) 0;
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
