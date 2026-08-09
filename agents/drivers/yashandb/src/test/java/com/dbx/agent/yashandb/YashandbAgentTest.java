package com.dbx.agent.yashandb;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.TestSupport;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class YashandbAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new YashandbAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SELECT 1 FROM DUAL";
    }

    @Test
    void declaresYashandbJdbcProfile() {
        JdbcAgentProfile profile = YashandbAgent.YASHANDB_PROFILE;

        Assertions.assertEquals("com.yashandb.jdbc.Driver", profile.getDriverClass());
        Assertions.assertEquals("jdbc:yasdb://{host}:{port}/{database}", profile.getUrlTemplate());
        Assertions.assertTrue(profile.getSkipExecutionContext());
        Assertions.assertEquals(Collections.emptySet(), profile.getExcludedSchemas());
    }

    @Test
    void readsFunctionSourceFromAllSourceInLineOrder() {
        YashandbAgent agent = new YashandbAgent();
        List<String> sql = new ArrayList<>();
        List<String> parameters = new ArrayList<>();
        TestSupport.setPrivateConnection(
            agent,
            objectSourceConnection(
                sql,
                parameters,
                "FUNCTION REFRESH_ORDERS RETURN NUMBER IS\n",
                "BEGIN\n",
                "  RETURN 1;\n",
                "END;\n"
            )
        );

        ObjectSource source = agent.getObjectSource("APP", "REFRESH_ORDERS", "function");

        Assertions.assertEquals(List.of(YashandbAgent.OBJECT_SOURCE_SQL), sql);
        Assertions.assertEquals(List.of("1=APP", "2=REFRESH_ORDERS", "3=FUNCTION"), parameters);
        Assertions.assertEquals("APP", source.getSchema());
        Assertions.assertEquals("REFRESH_ORDERS", source.getName());
        Assertions.assertEquals("FUNCTION", source.getObject_type());
        Assertions.assertEquals(
            "FUNCTION REFRESH_ORDERS RETURN NUMBER IS\nBEGIN\n  RETURN 1;\nEND;\n",
            source.getSource()
        );
        Assertions.assertFalse(source.isEditable());
    }

    @Test
    void readsProcedureSourceAndPreservesBoundIdentifierText() {
        YashandbAgent agent = new YashandbAgent();
        List<String> sql = new ArrayList<>();
        List<String> parameters = new ArrayList<>();
        TestSupport.setPrivateConnection(agent, objectSourceConnection(sql, parameters, "PROCEDURE SYNC_DATA IS\n", "BEGIN NULL; END;\n"));

        ObjectSource source = agent.getObjectSource("App\"Team", "Sync'Data", " PROCEDURE ");

        Assertions.assertEquals(List.of("1=App\"Team", "2=Sync'Data", "3=PROCEDURE"), parameters);
        Assertions.assertEquals("PROCEDURE SYNC_DATA IS\nBEGIN NULL; END;\n", source.getSource());
    }

    @Test
    void rejectsUnsupportedObjectSourceTypesBeforeQuerying() {
        YashandbAgent agent = new YashandbAgent();

        IllegalArgumentException error = Assertions.assertThrows(
            IllegalArgumentException.class,
            () -> agent.getObjectSource("APP", "ACTIVE_USERS", "VIEW")
        );

        Assertions.assertEquals("Unsupported object type: VIEW", error.getMessage());
    }

    private static Connection objectSourceConnection(List<String> sql, List<String> parameters, String... lines) {
        ResultSet resultSet = sourceRows(lines);
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("setString".equals(method.getName())) {
                parameters.add(args[0] + "=" + args[1]);
                return null;
            }
            if ("executeQuery".equals(method.getName())) {
                return resultSet;
            }
            if ("close".equals(method.getName())) {
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

    private static ResultSet sourceRows(String[] lines) {
        int[] index = {-1};
        return proxy(ResultSet.class, (method, args) -> {
            if ("next".equals(method.getName())) {
                index[0] += 1;
                return index[0] < lines.length;
            }
            if ("getString".equals(method.getName())) {
                return lines[index[0]];
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
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
