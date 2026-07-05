package com.dbx.agent.gbase8s;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.MetadataListConstraints;
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
import java.util.ArrayList;
import java.util.List;

class Gbase8sAgentTest {
    @Test
    void declaresGbase8sProfile() {
        Gbase8sAgent agent = new Gbase8sAgent();

        Assertions.assertEquals("com.gbasedbt.jdbc.Driver", agent.getProfile().getDriverClass());
        Assertions.assertEquals("jdbc:gbasedbt-sqli://{host}:{port}/{database}:GBASEDBTSERVER=gbase8s", agent.getProfile().getUrlTemplate());
        Assertions.assertEquals(9088, agent.getProfile().getDefaultPort());
        Assertions.assertTrue(agent.getProfile().getSkipExecutionContext());
    }

    @Test
    void buildsGbase8sJdbcUrlWithExplicitServerAndLocaleParameters() {
        String url = Gbase8sAgent.buildUrl(
            new ConnectParams(
                "172.26.128.159",
                20013,
                "testdb",
                "",
                "",
                "GBASEDBTSERVER=gbase01;CLIENT_LOCALE=zh_cn.utf8;DB_LOCALE=zh_cn.utf8",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:gbasedbt-sqli://172.26.128.159:20013/testdb:GBASEDBTSERVER=gbase01;CLIENT_LOCALE=zh_cn.utf8;DB_LOCALE=zh_cn.utf8",
            url
        );
    }

    @Test
    void fallsBackToHostAsGbaseServerWhenNoExplicitServerIsConfigured() {
        String url = Gbase8sAgent.buildUrl(
            new ConnectParams(
                "gbase-host",
                9088,
                "sysmaster",
                "",
                "",
                "",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:gbasedbt-sqli://gbase-host:9088/sysmaster:GBASEDBTSERVER=gbase-host",
            url
        );
    }

    @Test
    void fallsBackToGbaseServerNameWhenHostIsAnIpAddress() {
        String url = Gbase8sAgent.buildUrl(
            new ConnectParams(
                "172.26.128.159",
                0,
                "sysmaster",
                "",
                "",
                "",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:gbasedbt-sqli://172.26.128.159:9088/sysmaster:GBASEDBTSERVER=gbase8s",
            url
        );
    }

    @Test
    void usesConnectionStringWhenConfigured() {
        String url = Gbase8sAgent.buildUrl(
            new ConnectParams(
                "ignored",
                0,
                "",
                "",
                "",
                "",
                "jdbc:gbasedbt-sqli://db.example.com:20013/app:GBASEDBTSERVER=gbase01",
                false
            )
        );

        Assertions.assertEquals("jdbc:gbasedbt-sqli://db.example.com:20013/app:GBASEDBTSERVER=gbase01", url);
    }

    @Test
    void constrainedListTablesUsesGbase8sSystemTableQuery() {
        List<String> sql = new ArrayList<>();
        Gbase8sAgent agent = new Gbase8sAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"tabname", "tabtype"},
            new Object[][]{
                {"user_order", "T"}
            }
        )));

        List<TableInfo> tables = agent.listTables(
            "app",
            new MetadataListConstraints("user", 1, 1, List.of("TABLE"))
        );

        Assertions.assertEquals(1, tables.size());
        Assertions.assertEquals("user_order", tables.get(0).getName());
        Assertions.assertTrue(sql.get(0).contains("FROM systables"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("SELECT SKIP 1 FIRST 1"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UPPER(tabname) LIKE ?"), sql.get(0));
    }

    private static Connection preparedConnection(List<String> sql, ResultSet resultSet) {
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                return resultSet;
            }
            if ("setString".equals(method.getName()) || "close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("getCatalog".equals(method.getName())) {
                return "appdb";
            }
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
