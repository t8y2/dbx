package com.dbx.agent.dameng;

import com.dbx.agent.JsonRpcServer;
import com.dbx.agent.test.TestSupport;
import dm.jdbc.driver.DmdbTimestamp;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.sql.Types;
import javax.sql.rowset.serial.SerialBlob;
import javax.sql.rowset.serial.SerialClob;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DamengAgentPagingTest {
    @Test
    void executeQueryPageStringifiesTimestampValuesBeforeJsonRpcSerialization() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(
            agent,
            singleValueConnection(
                "CURRENT_TIMESTAMP",
                Types.TIMESTAMP,
                DmdbTimestamp.valueOf("2026-05-20 12:34:56.123456789"),
                null,
                null
            )
        );
        JsonRpcServer server = new JsonRpcServer(agent);

        String response = handleRequest(server, """
            {
              "jsonrpc": "2.0",
              "id": 1,
              "method": "execute_query_page",
              "params": {
                "sql": "SELECT CURRENT_TIMESTAMP",
                "schema": "SYS",
                "pageSize": 100
              }
            }
            """);

        assertFalse(response.contains("\"error\""), response);
        assertTrue(response.contains("2026-05-20 12:34:56.123456"), response);
    }

    @Test
    void executeQueryPageReadsClobValuesAsText() throws Exception {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(
            agent,
            singleValueConnection(
                "content",
                Types.CLOB,
                new SerialClob("真实文本".toCharArray()),
                "真实文本",
                null
            )
        );
        JsonRpcServer server = new JsonRpcServer(agent);

        String response = handleRequest(server, """
            {
              "jsonrpc": "2.0",
              "id": 1,
              "method": "execute_query_page",
              "params": {
                "sql": "SELECT content FROM sample",
                "schema": "SYS",
                "pageSize": 100
              }
            }
            """);

        assertFalse(response.contains("\"error\""), response);
        assertTrue(response.contains("真实文本"), response);
        assertFalse(response.contains("SerialClob"), response);
    }

    @Test
    void executeQueryPageFormatsBlobValuesAsHexText() throws Exception {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(
            agent,
            singleValueConnection(
                "payload",
                Types.BLOB,
                new SerialBlob(new byte[]{0x01, 0x2A, (byte) 0xFF}),
                null,
                new byte[]{0x01, 0x2A, (byte) 0xFF}
            )
        );
        JsonRpcServer server = new JsonRpcServer(agent);

        String response = handleRequest(server, """
            {
              "jsonrpc": "2.0",
              "id": 1,
              "method": "execute_query_page",
              "params": {
                "sql": "SELECT payload FROM sample",
                "schema": "SYS",
                "pageSize": 100
              }
            }
            """);

        assertFalse(response.contains("\"error\""), response);
        assertTrue(response.contains("0x012aff"), response);
        assertFalse(response.contains("SerialBlob"), response);
    }

    private static Connection singleValueConnection(
        String columnLabel,
        int sqlType,
        Object objectValue,
        String stringValue,
        byte[] bytesValue
    ) {
        Statement statement = singleValueStatement(columnLabel, sqlType, objectValue, stringValue, bytesValue);
        return proxy(Connection.class, (method, args) -> {
            String name = method.getName();
            if ("createStatement".equals(name)) {
                return statement;
            }
            if ("getAutoCommit".equals(name)) {
                return true;
            }
            if ("setAutoCommit".equals(name) || "commit".equals(name) || "rollback".equals(name) || "close".equals(name)) {
                return null;
            }
            if ("isClosed".equals(name)) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Statement singleValueStatement(
        String columnLabel,
        int sqlType,
        Object objectValue,
        String stringValue,
        byte[] bytesValue
    ) {
        ResultSet resultSet = singleValueResultSet(columnLabel, sqlType, objectValue, stringValue, bytesValue);
        return proxy(Statement.class, (method, args) -> {
            String name = method.getName();
            if ("execute".equals(name)) {
                return true;
            }
            if ("getResultSet".equals(name)) {
                return resultSet;
            }
            if ("getUpdateCount".equals(name)) {
                return 0;
            }
            if ("setMaxRows".equals(name) || "setFetchSize".equals(name) || "close".equals(name)) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet singleValueResultSet(
        String columnLabel,
        int sqlType,
        Object objectValue,
        String stringValue,
        byte[] bytesValue
    ) {
        final int[] index = {-1};
        ResultSetMetaData metadata = singleValueMetadata(columnLabel, sqlType);
        return proxy(ResultSet.class, (method, args) -> {
            String name = method.getName();
            if ("next".equals(name)) {
                index[0] += 1;
                return index[0] == 0;
            }
            if ("getMetaData".equals(name)) {
                return metadata;
            }
            if ("getObject".equals(name)) {
                return objectValue;
            }
            if ("getString".equals(name)) {
                return stringValue;
            }
            if ("getBytes".equals(name)) {
                return bytesValue;
            }
            if ("wasNull".equals(name)) {
                return false;
            }
            if ("close".equals(name)) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSetMetaData singleValueMetadata(String columnLabel, int sqlType) {
        return proxy(ResultSetMetaData.class, (method, args) -> {
            String name = method.getName();
            if ("getColumnCount".equals(name)) {
                return 1;
            }
            if ("getColumnLabel".equals(name)) {
                return columnLabel;
            }
            if ("getColumnType".equals(name)) {
                return sqlType;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static String handleRequest(JsonRpcServer server, String request) {
        try {
            Method method = JsonRpcServer.class.getDeclaredMethod("handleRequest", String.class);
            method.setAccessible(true);
            return (String) method.invoke(server, request);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
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
