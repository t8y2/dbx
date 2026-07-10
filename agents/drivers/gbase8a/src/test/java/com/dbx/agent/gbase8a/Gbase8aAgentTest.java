package com.dbx.agent.gbase8a;

import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

class Gbase8aAgentTest {
    @Test
    void listObjectsIncludesRoutinesFromInformationSchema() {
        List<String> sql = new ArrayList<>();
        Gbase8aAgent agent = new Gbase8aAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql,
            resultSet(
                new String[]{"TABLE_NAME", "TABLE_TYPE"},
                new Object[][]{{"orders", "BASE TABLE"}}
            ),
            resultSet(
                new String[]{"ROUTINE_NAME", "ROUTINE_TYPE", "ROUTINE_COMMENT"},
                new Object[][]{{"refresh_orders", "PROCEDURE", "proc comment"}, {"format_order", "FUNCTION", null}}
            )
        ));

        List<ObjectInfo> objects = agent.listObjects("app");

        Assertions.assertEquals(3, objects.size());
        Assertions.assertEquals("orders", objects.get(0).getName());
        Assertions.assertEquals("TABLE", objects.get(0).getObject_type());
        Assertions.assertEquals("refresh_orders", objects.get(1).getName());
        Assertions.assertEquals("PROCEDURE", objects.get(1).getObject_type());
        Assertions.assertEquals("app", objects.get(1).getSchema());
        Assertions.assertEquals("proc comment", objects.get(1).getComment());
        Assertions.assertEquals("format_order", objects.get(2).getName());
        Assertions.assertEquals("FUNCTION", objects.get(2).getObject_type());
        Assertions.assertEquals("app", objects.get(2).getSchema());
        Assertions.assertTrue(sql.get(1).contains("FROM information_schema.ROUTINES"), sql.get(1));
        Assertions.assertTrue(sql.get(1).contains("ROUTINE_SCHEMA = ?"), sql.get(1));
    }

    @Test
    void constrainedListTablesPushesFilterTypeAndLimit() {
        List<String> sql = new ArrayList<>();
        Gbase8aAgent agent = new Gbase8aAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql,
            resultSet(
                new String[]{"TABLE_NAME", "TABLE_TYPE"},
                new Object[][]{{"user_order", "BASE TABLE"}}
            )
        ));

        List<TableInfo> tables = agent.listTables(
            "app",
            new MetadataListConstraints("user", 1, 1, List.of("TABLE"))
        );

        Assertions.assertEquals(1, tables.size());
        Assertions.assertEquals("user_order", tables.get(0).getName());
        Assertions.assertTrue(sql.get(0).contains("TABLE_TYPE IN (?)"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UPPER(TABLE_NAME) LIKE ?"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("LIMIT ?"), sql.get(0));
    }

    @Test
    void constrainedListObjectsKeepsCustomRoutineMetadata() {
        List<String> sql = new ArrayList<>();
        Gbase8aAgent agent = new Gbase8aAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql,
            resultSet(
                new String[]{"ROUTINE_NAME", "ROUTINE_TYPE", "ROUTINE_COMMENT"},
                new Object[][]{{"refresh_orders", "PROCEDURE", "proc comment"}, {"format_order", "FUNCTION", null}}
            )
        ));

        List<ObjectInfo> objects = agent.listObjects(
            "app",
            new MetadataListConstraints("format", 1, null, List.of("FUNCTION"))
        );

        Assertions.assertEquals(1, objects.size());
        Assertions.assertEquals("format_order", objects.get(0).getName());
        Assertions.assertEquals("FUNCTION", objects.get(0).getObject_type());
        Assertions.assertTrue(sql.get(0).contains("ROUTINE_TYPE IN (?)"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UPPER(ROUTINE_NAME) LIKE ?"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("LIMIT ?"), sql.get(0));
    }

    @Test
    void getObjectSourceUsesShowCreateForRoutines() {
        List<String> sql = new ArrayList<>();
        Gbase8aAgent agent = new Gbase8aAgent();
        TestSupport.setPrivateConnection(agent, statementConnection(sql, resultSet(
            new String[]{"Procedure", "sql_mode", "Create Procedure"},
            new Object[][]{{"refresh_orders", "", "CREATE PROCEDURE `refresh_orders`() SELECT 1"}}
        )));

        ObjectSource source = agent.getObjectSource("app", "refresh_orders", "procedure");

        Assertions.assertEquals("PROCEDURE", source.getObject_type());
        Assertions.assertEquals("app", source.getSchema());
        Assertions.assertEquals("CREATE PROCEDURE `refresh_orders`() SELECT 1", source.getSource());
        Assertions.assertEquals("SHOW CREATE PROCEDURE `app`.`refresh_orders`", sql.get(0));
    }

    @Test
    void getObjectSourceFindsDefinitionAcrossDriverResultLayouts() {
        List<String> sql = new ArrayList<>();
        Gbase8aAgent agent = new Gbase8aAgent();
        TestSupport.setPrivateConnection(agent, statementConnection(sql, resultSet(
            new String[]{"Function", "Create Function", "character_set_client", "Database Collation"},
            new Object[][]{{"format_order", "CREATE FUNCTION `format_order`() RETURNS INT RETURN 1", "utf8", "utf8_bin"}}
        )));

        ObjectSource source = agent.getObjectSource("app`prod", "format`order", "FUNCTION");

        Assertions.assertEquals("CREATE FUNCTION `format_order`() RETURNS INT RETURN 1", source.getSource());
        Assertions.assertEquals("SHOW CREATE FUNCTION `app``prod`.`format``order`", sql.get(0));
    }

    @Test
    void getObjectSourceSupportsViewsAndRejectsOtherObjectTypes() {
        List<String> sql = new ArrayList<>();
        Gbase8aAgent agent = new Gbase8aAgent();
        TestSupport.setPrivateConnection(agent, statementConnection(sql, resultSet(
            new String[]{"View", "Create View"},
            new Object[][]{{"active_orders", "CREATE VIEW `active_orders` AS SELECT 1"}}
        )));

        ObjectSource source = agent.getObjectSource("app", "active_orders", "VIEW");

        Assertions.assertEquals("CREATE VIEW `active_orders` AS SELECT 1", source.getSource());
        Assertions.assertEquals("SHOW CREATE VIEW `app`.`active_orders`", sql.get(0));
        Assertions.assertThrows(
            IllegalArgumentException.class,
            () -> agent.getObjectSource("app", "orders", "TABLE")
        );
    }

    private static Connection preparedConnection(List<String> sql, ResultSet... resultSets) {
        int[] resultSetIndex = {0};
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                int current = Math.min(resultSetIndex[0], resultSets.length - 1);
                resultSetIndex[0] += 1;
                return resultSets[current];
            }
            if ("setString".equals(method.getName()) || "setInt".equals(method.getName()) || "close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection statementConnection(List<String> sql, ResultSet resultSet) {
        Statement statement = proxy(Statement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return resultSet;
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
            if ("getColumnLabel".equals(method.getName())) {
                return columns[((Number) args[0]).intValue() - 1];
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next":
                    index[0] += 1;
                    return index[0] < rows.length;
                case "getString":
                    Object value = columnValue(columns, rows[index[0]], args[0]);
                    return value == null ? null : String.valueOf(value);
                case "getMetaData":
                    return metadata;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Object columnValue(String[] columns, Object[] row, Object key) {
        if (key instanceof Number) {
            return row[((Number) key).intValue() - 1];
        }
        for (int i = 0; i < columns.length; i++) {
            if (columns[i].equalsIgnoreCase(String.valueOf(key))) {
                return row[i];
            }
        }
        return null;
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
