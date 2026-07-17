package com.dbx.agent.hive;

import com.dbx.agent.test.TestSupport;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import com.dbx.agent.ColumnInfo;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.util.List;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class HiveAgentMetadataTest {
    @Test
    void quotesSchemaAndTableIdentifiersInMetadataSql() {
        HiveAgent agent = new HiveAgent();
        Connection fake = JdbcMetadataSqlFake.connection();
        TestSupport.setPrivateConnection(agent, fake);

        agent.listTables("bad`schema");
        agent.getColumns("bad`schema", "bad`table");

        Assertions.assertEquals(
            List.of(
                "USE `bad``schema`",
                "SHOW TABLES",
                "USE `bad``schema`",
                "DESCRIBE `bad``table`"
            ),
            JdbcMetadataSqlFake.statements
        );
    }

    @Test
    void fallsBackToJdbcMetadataWhenDescribeCannotCreateResultSet() {
        HiveAgent agent = new HiveAgent();
        Connection fake = describeFailingMetadataConnection();
        TestSupport.setPrivateConnection(agent, fake);

        List<ColumnInfo> columns = agent.getColumns("default", "events");

        Assertions.assertEquals(2, columns.size());
        Assertions.assertEquals("id", columns.get(0).getName());
        Assertions.assertEquals("bigint", columns.get(0).getData_type());
        Assertions.assertFalse(columns.get(0).getIs_nullable());
        Assertions.assertEquals("name", columns.get(1).getName());
        Assertions.assertEquals("string", columns.get(1).getData_type());
        Assertions.assertEquals(Integer.valueOf(255), columns.get(1).getCharacter_maximum_length());
    }

    private static Connection describeFailingMetadataConnection() {
        DatabaseMetaData meta = proxy(DatabaseMetaData.class, (method, args) -> {
            if ("getColumns".equals(method.getName())) {
                return rows(
                    row(
                        "COLUMN_NAME", "id",
                        "TYPE_NAME", "bigint",
                        "NULLABLE", DatabaseMetaData.columnNoNulls,
                        "COLUMN_DEF", null,
                        "REMARKS", "identifier",
                        "COLUMN_SIZE", 19,
                        "DECIMAL_DIGITS", 0
                    ),
                    row(
                        "COLUMN_NAME", "name",
                        "TYPE_NAME", "string",
                        "NULLABLE", DatabaseMetaData.columnNullable,
                        "COLUMN_DEF", null,
                        "REMARKS", null,
                        "COLUMN_SIZE", 255,
                        "DECIMAL_DIGITS", 0
                    )
                );
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            String name = method.getName();
            if ("createStatement".equals(name)) {
                return describeFailingStatement();
            }
            if ("getMetaData".equals(name)) {
                return meta;
            }
            if ("isClosed".equals(name)) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Statement describeFailingStatement() {
        return proxy(Statement.class, (method, args) -> {
            String name = method.getName();
            if ("execute".equals(name)) {
                return false;
            }
            if ("executeQuery".equals(name)) {
                throw new SQLException("Could not create ResultSet: Required field 'type' is unset! Struct:TPrimitiveTypeEntry(type:null)");
            }
            return defaultValue(method.getReturnType());
        });
    }

    @SafeVarargs
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
                if ("close".equals(name)) {
                    return null;
                }
                Object value = rows[index].get(args[0]);
                if ("getString".equals(name)) {
                    return value == null ? null : String.valueOf(value);
                }
                if ("getObject".equals(name)) {
                    return value;
                }
                if ("getInt".equals(name)) {
                    return value instanceof Number ? ((Number) value).intValue() : 0;
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

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = (proxy, method, args) -> handler.handle(method, args);
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
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
