package com.dbx.agent.databend;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

class DatabendAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new DatabendAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SELECT 1";
    }

    @Test
    void buildsDefaultJdbcUrl() {
        ConnectParams params = new ConnectParams();
        params.setHost("db.example.com");
        params.setPort(0);
        params.setDatabase("default");

        Assertions.assertEquals(
            "jdbc:databend://db.example.com:8000/default",
            DatabendAgent.DATABEND_PROFILE.buildUrl(params)
        );
    }

    @Test
    void appendsQueryParametersToJdbcUrl() {
        ConnectParams params = new ConnectParams();
        params.setHost("db.example.com");
        params.setPort(20080);
        params.setDatabase("default");
        params.setUrl_params("sslmode=disable");

        Assertions.assertEquals(
            "jdbc:databend://db.example.com:20080/default?sslmode=disable",
            DatabendAgent.DATABEND_PROFILE.buildUrl(params)
        );
    }

    @Test
    void usesDoubleQuotedDatabaseAsExecutionContext() {
        Assertions.assertEquals(
            "USE \"analytics\"\"prod\"",
            DatabendAgent.DATABEND_PROFILE.schemaSwitchSql("analytics\"prod")
        );
    }

    @Test
    void constrainedListObjectsKeepsDatabendProcedures() {
        List<String> sql = new ArrayList<>();
        DatabendAgent agent = new DatabendAgent();
        TestSupport.setPrivateConnection(agent, databendMetadataConnection(sql, resultSet(
            new String[]{"name", "comment"},
            new Object[][]{
                {"refresh_orders", "proc comment"},
                {"format_order", null}
            }
        )));

        List<ObjectInfo> objects = agent.listObjects(
            "default",
            new MetadataListConstraints("format", 1, null, List.of("PROCEDURE"))
        );

        Assertions.assertEquals(1, objects.size());
        Assertions.assertEquals("format_order", objects.get(0).getName());
        Assertions.assertEquals("PROCEDURE", objects.get(0).getObject_type());
        Assertions.assertTrue(sql.stream().anyMatch(value -> value.contains("FROM system.procedures")), sql.toString());
        Assertions.assertTrue(sql.stream().anyMatch(value -> value.contains("UPPER(name) LIKE ?")), sql.toString());
        Assertions.assertTrue(sql.stream().anyMatch(value -> value.contains("LIMIT ?")), sql.toString());
    }

    private static Connection databendMetadataConnection(List<String> sql, ResultSet procedures) {
        DatabaseMetaData metadata = proxy(DatabaseMetaData.class, (method, args) -> {
            if ("getTableTypes".equals(method.getName()) || "getTables".equals(method.getName())) {
                return emptyResultSet();
            }
            return defaultValue(method.getReturnType());
        });
        Statement statement = proxy(Statement.class, (method, args) -> {
            if ("execute".equals(method.getName()) || "close".equals(method.getName())) {
                return "execute".equals(method.getName()) ? false : null;
            }
            if ("executeQuery".equals(method.getName())) {
                return procedures;
            }
            return defaultValue(method.getReturnType());
        });
        PreparedStatement preparedStatement = proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                return procedures;
            }
            if ("setString".equals(method.getName()) || "setInt".equals(method.getName()) || "close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("getMetaData".equals(method.getName())) {
                return metadata;
            }
            if ("createStatement".equals(method.getName())) {
                return statement;
            }
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return preparedStatement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet emptyResultSet() {
        return resultSet(new String[]{"VALUE"}, new Object[][]{});
    }

    private static ResultSet resultSet(String[] columns, Object[][] rows) {
        int[] index = {-1};
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next":
                    index[0] += 1;
                    return index[0] < rows.length;
                case "getString":
                    Object value = columnValue(columns, rows[index[0]], args[0]);
                    return value == null ? null : String.valueOf(value);
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
