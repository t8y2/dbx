package com.dbx.agent.db2;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
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

    @Test
    void constrainedTableMetadataPassesRemarks() {
        Db2Agent agent = new Db2Agent();
        TestSupport.setPrivateConnection(agent, preparedConnection(
            row("TABNAME", "MY_TABLE", "TYPE", "T", "REMARKS", "Test table comment")
        ));

        List<TableInfo> tables = agent.listTables("APP",
            new MetadataListConstraints(null, 25, null, List.of("TABLE")));

        assertEquals(1, tables.size());
        assertEquals("MY_TABLE", tables.get(0).getName());
        assertEquals("TABLE", tables.get(0).getTable_type());
        assertEquals("Test table comment", tables.get(0).getComment());
    }

    @Test
    void constrainedObjectMetadataPassesRemarks() {
        Db2Agent agent = new Db2Agent();
        TestSupport.setPrivateConnection(agent, preparedConnection(
            row("OBJECT_NAME", "MY_VIEW", "OBJECT_TYPE", "VIEW", "OBJECT_COMMENT", "Test view comment")
        ));

        List<ObjectInfo> objects = agent.listObjects("APP",
            new MetadataListConstraints("my", 10, null, List.of("VIEW")));

        assertEquals(1, objects.size());
        assertEquals("MY_VIEW", objects.get(0).getName());
        assertEquals("VIEW", objects.get(0).getObject_type());
        assertEquals("Test view comment", objects.get(0).getComment());
    }

    private static Connection preparedConnection(Map<String, Object>... rows) {
        final ResultSet resultSet = rows(rows);
        return proxy(Connection.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("prepareStatement".equals(name)) {
                    return proxy(PreparedStatement.class, new MethodHandler() {
                        @Override
                        public Object handle(Method stmtMethod, Object[] stmtArgs) {
                            String m = stmtMethod.getName();
                            if ("setString".equals(m) || "setObject".equals(m) || "setInt".equals(m)) {
                                return null;
                            }
                            if ("executeQuery".equals(m)) {
                                return resultSet;
                            }
                            if ("close".equals(m)) {
                                return null;
                            }
                            return defaultValue(stmtMethod.getReturnType());
                        }
                    });
                }
                if ("isClosed".equals(name)) {
                    return false;
                }
                return defaultValue(method.getReturnType());
            }
        });
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
                    if (args[0] instanceof Number) {
                        int colIndex = ((Number) args[0]).intValue() - 1;
                        String key = rows[index].keySet().stream().skip(colIndex).findFirst().orElse(null);
                        Object value = rows[index].get(key);
                        return value == null ? null : String.valueOf(value);
                    }
                    Object value = rows[index].get(args[0]);
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
