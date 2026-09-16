package com.dbx.agent.spark;

import com.dbx.agent.test.TestSupport;
import java.lang.reflect.Field;
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

class SparkAgentTest {
    @Test
    void getTableDdlUsesNativeSparkDdlWithCommentsAndProviderClauses() {
        List<String> sql = new ArrayList<>();
        String nativeDdl = "CREATE TABLE spark_catalog.default.events (\n" +
            "  id INT COMMENT '编号注释',\n" +
            "  name STRING,\n" +
            "  amount DECIMAL(12,2) COMMENT '金额')\n" +
            "USING parquet\n" +
            "COMMENT 'Spark 表注释'";
        SparkAgent agent = new SparkAgent();
        TestSupport.setPrivateConnection(agent, connection(sql, nativeDdl, false));

        String ddl = agent.getTableDdl("default", "events");

        Assertions.assertEquals(nativeDdl, ddl);
        Assertions.assertEquals(
            List.of("SHOW CREATE TABLE `default`.`events`"),
            sql
        );
    }

    @Test
    void getTableDdlQualifiesConfiguredCatalogWithoutChangingContext() throws Exception {
        List<String> sql = new ArrayList<>();
        SparkAgent agent = new SparkAgent();
        setConfiguredCatalog(agent, "lake`catalog");
        TestSupport.setPrivateConnection(agent, connection(sql, "CREATE TABLE native_ddl", false));

        String ddl = agent.getTableDdl("analytics", "orders`archive");

        Assertions.assertEquals("CREATE TABLE native_ddl", ddl);
        Assertions.assertEquals(
            List.of("SHOW CREATE TABLE `lake``catalog`.`analytics`.`orders``archive`"),
            sql
        );
    }

    @Test
    void getTableDdlFallsBackToMetadataWhenShowCreateFails() {
        List<String> sql = new ArrayList<>();
        SparkAgent agent = new SparkAgent();
        TestSupport.setPrivateConnection(agent, connection(sql, null, true));

        String ddl = agent.getTableDdl("default", "events");

        Assertions.assertEquals(
            "CREATE TABLE \"default\".\"events\" (\n" +
                "  \"id\" int,\n" +
                "  \"name\" string\n" +
                ");\n",
            ddl
        );
        Assertions.assertEquals(
            List.of(
                "SHOW CREATE TABLE `default`.`events`",
                "USE `default`",
                "DESCRIBE `events`"
            ),
            sql
        );
    }

    private static Connection connection(List<String> sql, String nativeDdl, boolean failShowCreate) {
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
                    return resultSet(
                        new String[]{"createtab_stmt"},
                        new Object[][]{{nativeDdl}}
                    );
                }
                if (query.startsWith("DESCRIBE")) {
                    return resultSet(
                        new String[]{"col_name", "data_type", "comment"},
                        new Object[][]{
                            {"id", "int", "编号注释"},
                            {"name", "string", null}
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
                int column = key instanceof Number
                    ? ((Number) key).intValue() - 1
                    : findColumn(columns, String.valueOf(key));
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

    private static void setConfiguredCatalog(SparkAgent agent, String catalog) throws Exception {
        Field field = SparkAgent.class.getDeclaredField("configuredCatalog");
        field.setAccessible(true);
        field.set(agent, catalog);
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                return handler.handle(method, args == null ? new Object[0] : args);
            }
        };
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
