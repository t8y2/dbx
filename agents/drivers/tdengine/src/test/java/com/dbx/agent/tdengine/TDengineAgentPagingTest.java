package com.dbx.agent.tdengine;

import com.dbx.agent.JsonRpcServer;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.sql.Types;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TDengineAgentPagingTest {
    @Test
    void executeQueryPageDecodesBinaryVarcharValuesAsStrings() {
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, binaryVarcharConnection());
        JsonRpcServer server = new JsonRpcServer(agent);

        String response = handleRequest(server, """
            {
              "jsonrpc": "2.0",
              "id": 1,
              "method": "execute_query_page",
              "params": {
                "sql": "SELECT v FROM sample",
                "schema": "power",
                "pageSize": 100
              }
            }
            """);

        assertFalse(response.contains("\"error\""), response);
        assertTrue(response.contains("\"hello\""), response);
        assertFalse(response.contains("[104,101,108,108,111]"), response);
    }

    private static Connection binaryVarcharConnection() {
        Statement statement = binaryVarcharStatement();
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

    private static Statement binaryVarcharStatement() {
        ResultSet resultSet = binaryVarcharResultSet();
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

    private static ResultSet binaryVarcharResultSet() {
        final int[] index = {-1};
        ResultSetMetaData metadata = binaryVarcharMetadata();
        byte[] value = "hello".getBytes(StandardCharsets.UTF_8);
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
                return value;
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

    private static ResultSetMetaData binaryVarcharMetadata() {
        return proxy(ResultSetMetaData.class, (method, args) -> {
            String name = method.getName();
            if ("getColumnCount".equals(name)) {
                return 1;
            }
            if ("getColumnLabel".equals(name)) {
                return "v";
            }
            if ("getColumnType".equals(name)) {
                return Types.VARCHAR;
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
