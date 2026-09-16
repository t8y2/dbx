package com.dbx.agent.saphana;

import com.dbx.agent.ObjectSource;
import com.dbx.agent.test.TestSupport;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class SapHanaAgentTest {
    @Test
    void getObjectSourceReadsProcedureDefinitionFromSystemCatalog() {
        List<String> calls = new ArrayList<>();
        String definition = "CREATE PROCEDURE \"APP\".\"REFRESH_ORDERS\" () AS BEGIN END";
        SapHanaAgent agent = agentWithDefinition(calls, definition, true);

        ObjectSource source = agent.getObjectSource("APP", "REFRESH_ORDERS", " procedure ");

        Assertions.assertEquals("REFRESH_ORDERS", source.getName());
        Assertions.assertEquals("PROCEDURE", source.getObject_type());
        Assertions.assertEquals("APP", source.getSchema());
        Assertions.assertEquals(definition, source.getSource());
        Assertions.assertEquals(
            List.of(
                "sql:SELECT DEFINITION FROM SYS.PROCEDURES WHERE SCHEMA_NAME = ? AND PROCEDURE_NAME = ?",
                "param:1=APP",
                "param:2=REFRESH_ORDERS"
            ),
            calls
        );
    }

    @Test
    void getObjectSourceReturnsEmptyTextWhenHanaHidesProcedureDefinition() {
        SapHanaAgent agent = agentWithDefinition(new ArrayList<>(), null, true);

        ObjectSource source = agent.getObjectSource("SYS", "BACKUP_DATA", "PROCEDURE");

        Assertions.assertEquals("", source.getSource());
    }

    @Test
    void getObjectSourceKeepsOtherObjectTypesUnsupported() {
        SapHanaAgent agent = new SapHanaAgent();

        UnsupportedOperationException error = Assertions.assertThrows(
            UnsupportedOperationException.class,
            () -> agent.getObjectSource("APP", "ACTIVE_ORDERS", "VIEW")
        );

        Assertions.assertEquals("Object source is not supported", error.getMessage());
    }

    private static SapHanaAgent agentWithDefinition(List<String> calls, String definition, boolean hasRow) {
        ResultSet resultSet = proxy(ResultSet.class, (method, args) -> {
            if ("next".equals(method.getName())) {
                return hasRow;
            }
            if ("getString".equals(method.getName())) {
                return definition;
            }
            return defaultValue(method.getReturnType());
        });
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("setString".equals(method.getName())) {
                calls.add("param:" + args[0] + "=" + args[1]);
                return null;
            }
            if ("executeQuery".equals(method.getName())) {
                return resultSet;
            }
            return defaultValue(method.getReturnType());
        });
        Connection connection = proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                calls.add("sql:" + args[0]);
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });

        SapHanaAgent agent = new SapHanaAgent();
        TestSupport.setPrivateConnection(agent, connection);
        return agent;
    }

    private static <T> T proxy(Class<T> type, Handler handler) {
        return type.cast(Proxy.newProxyInstance(
            type.getClassLoader(),
            new Class<?>[]{type},
            (proxy, method, args) -> handler.handle(method, args)
        ));
    }

    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive()) return null;
        if (type == boolean.class) return false;
        if (type == byte.class) return (byte) 0;
        if (type == short.class) return (short) 0;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        if (type == float.class) return 0f;
        if (type == double.class) return 0d;
        if (type == char.class) return '\0';
        return null;
    }

    @FunctionalInterface
    private interface Handler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
