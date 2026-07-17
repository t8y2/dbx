package com.dbx.agent.db2;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class Db2AgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new Db2Agent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL ADMIN_CMD('list applications')";
    }

    @Test
    void buildsJdbcUrlWithDb2PropertySuffix() {
        ConnectParams params = new ConnectParams();
        params.setHost("db.example.com");
        params.setPort(50000);
        params.setDatabase("SAMPLE");
        params.setUrl_params("sslConnection=true");

        assertEquals("jdbc:db2://db.example.com:50000/SAMPLE:sslConnection=true;", Db2Agent.buildUrl(params));
    }

    @Test
    void listsAllCatalogSchemasWithoutOwnerTypeFiltering() {
        Db2Agent agent = new Db2Agent();
        AtomicReference<String> executedSql = new AtomicReference<>();
        TestSupport.setPrivateConnection(agent, connection(
            executedSql,
            rows(row("SCHEMANAME", "APP"), row("SCHEMANAME", "SZ"), row("SCHEMANAME", "TOOLS"))
        ));

        List<String> schemas = agent.listSchemas();

        assertEquals(Arrays.asList("APP", "SZ", "TOOLS"), schemas);
        assertEquals("SELECT SCHEMANAME FROM SYSCAT.SCHEMATA ORDER BY SCHEMANAME", executedSql.get());
        assertFalse(executedSql.get().contains("OWNERTYPE"));
    }

    @Test
    void constrainedTableMetadataUsesDb2CatalogPushdown() {
        Db2Agent agent = new Db2Agent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("APP", new MetadataListConstraints("ord", 25, 50, List.of("TABLE")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        assertTrue(sql.contains("FROM SYSCAT.TABLES"));
        assertTrue(sql.contains("TYPE IN (?)"));
        assertTrue(sql.contains("UPPER(TABNAME) LIKE ? ESCAPE '\\\\'"));
        assertTrue(sql.endsWith("OFFSET 50 ROWS FETCH NEXT 25 ROWS ONLY"));
        assertEquals(Arrays.asList("param:1=APP", "param:2=T", "param:3=%O%R%D%"), JdbcMetadataSqlFake.statements.subList(1, 4));
    }

    @Test
    void constrainedObjectMetadataUsesDb2CatalogPushdown() {
        Db2Agent agent = new Db2Agent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listObjects("APP", new MetadataListConstraints("sync", 10, null, List.of("PROCEDURE")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        assertTrue(sql.contains("FROM SYSCAT.PROCEDURES"));
        assertTrue(sql.contains("ORDER BY CASE OBJECT_TYPE"));
        assertTrue(sql.endsWith("FETCH FIRST 10 ROWS ONLY"));
        assertEquals(Arrays.asList("param:1=APP", "param:2=%S%Y%N%C%"), JdbcMetadataSqlFake.statements.subList(1, 3));
    }

    private static Connection connection(AtomicReference<String> executedSql, ResultSet resultSet) {
        Statement statement = proxy(Statement.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                if ("executeQuery".equals(method.getName())) {
                    executedSql.set(String.valueOf(args[0]));
                    return resultSet;
                }
                if ("close".equals(method.getName())) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            }
        });
        return proxy(Connection.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                if ("createStatement".equals(method.getName())) {
                    return statement;
                }
                if ("isClosed".equals(method.getName())) {
                    return false;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet rows(Map<String, Object>... rows) {
        return proxy(ResultSet.class, new MethodHandler() {
            private int index = -1;

            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("next".equals(name)) {
                    index += 1;
                    return index < rows.length;
                }
                if ("getString".equals(name)) {
                    Object key = args[0] instanceof Number ? rows[index].keySet().iterator().next() : args[0];
                    Object value = rows[index].get(key);
                    return value == null ? null : String.valueOf(value);
                }
                if ("close".equals(name)) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static Map<String, Object> row(Object... values) {
        Map<String, Object> row = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) {
            row.put(String.valueOf(values[i]), values[i + 1]);
        }
        return row;
    }

    private static <T> T proxy(Class<T> type, final MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) {
                return handler.handle(method, args);
            }
        };
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) {
            return false;
        }
        if (Byte.TYPE.equals(type)) {
            return (byte) 0;
        }
        if (Short.TYPE.equals(type)) {
            return (short) 0;
        }
        if (Integer.TYPE.equals(type)) {
            return 0;
        }
        if (Long.TYPE.equals(type)) {
            return 0L;
        }
        if (Float.TYPE.equals(type)) {
            return 0f;
        }
        if (Double.TYPE.equals(type)) {
            return 0.0d;
        }
        if (Character.TYPE.equals(type)) {
            return '\0';
        }
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args);
    }
}
