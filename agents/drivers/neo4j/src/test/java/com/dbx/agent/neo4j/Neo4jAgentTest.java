package com.dbx.agent.neo4j;

import com.dbx.agent.QueryResult;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class Neo4jAgentTest {
    @Test
    void executesCypherWritesWithReturnThroughStatementExecute() throws Exception {
        Neo4jAgent agent = new Neo4jAgent();
        List<String> calls = new ArrayList<>();
        setConnectionForTest(agent, fakeConnection(calls));

        QueryResult result = agent.executeQuery("CREATE (n:Person {name: 'Ada'}) RETURN n", null);

        Assertions.assertEquals(Collections.singletonList("n"), result.getColumns());
        Assertions.assertEquals(
            Collections.singletonList(Collections.singletonList("(:Person {name: Ada})")),
            result.getRows()
        );
        Assertions.assertTrue(calls.contains("execute"));
        Assertions.assertFalse(calls.contains("executeUpdate"));
    }

    @Test
    void executesTransactionsThroughStatementExecute() throws Exception {
        Neo4jAgent agent = new Neo4jAgent();
        List<String> calls = new ArrayList<>();
        setConnectionForTest(agent, fakeConnection(calls));

        QueryResult result = agent.executeTransaction(
            Arrays.asList(
                "MATCH (n:Employee) WHERE elementId(n) = '4:abc:7' SET n.name = 'Grace'",
                "CREATE (n:Employee {name: 'Linus'})"
            ),
            null
        );

        Assertions.assertEquals(0L, result.getAffected_rows());
        Assertions.assertEquals(
            Arrays.asList("setAutoCommit:false", "execute", "execute", "commit", "setAutoCommit:true"),
            calls
        );
        Assertions.assertFalse(calls.contains("executeUpdate"));
    }

    private static void setConnectionForTest(Neo4jAgent agent, Connection connection) throws Exception {
        java.lang.reflect.Field field = Neo4jAgent.class.getDeclaredField("connection");
        field.setAccessible(true);
        field.set(agent, connection);
    }

    private static Connection fakeConnection(List<String> calls) {
        Statement statement = fakeStatement(calls);
        return proxy(Connection.class, (unused, method, args) -> {
            switch (method.getName()) {
                case "createStatement":
                    return statement;
                case "setAutoCommit":
                    calls.add("setAutoCommit:" + args[0]);
                    return null;
                case "getAutoCommit":
                    return true;
                case "commit":
                    calls.add("commit");
                    return null;
                case "rollback":
                    calls.add("rollback");
                    return null;
                case "close":
                    return null;
                case "isClosed":
                    return false;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Statement fakeStatement(List<String> calls) {
        ResultSet resultSet = fakeResultSet();
        return proxy(Statement.class, (unused, method, args) -> {
            switch (method.getName()) {
                case "execute":
                    calls.add("execute");
                    return true;
                case "executeUpdate":
                    calls.add("executeUpdate");
                    throw new SQLException("syntax error or access rule violation - invalid syntax");
                case "executeQuery":
                    calls.add("executeQuery");
                    return resultSet;
                case "getResultSet":
                    return resultSet;
                case "getUpdateCount":
                    return 0;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet fakeResultSet() {
        int[] index = {-1};
        ResultSetMetaData metadata = fakeMetadata();
        return proxy(ResultSet.class, (unused, method, args) -> {
            switch (method.getName()) {
                case "next":
                    index[0] += 1;
                    return index[0] == 0;
                case "getMetaData":
                    return metadata;
                case "getObject":
                    return "(:Person {name: Ada})";
                case "wasNull":
                    return false;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSetMetaData fakeMetadata() {
        return proxy(ResultSetMetaData.class, (unused, method, args) -> {
            switch (method.getName()) {
                case "getColumnCount":
                    return 1;
                case "getColumnLabel":
                    return "n";
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler);
    }

    private static Object defaultValue(Class<?> type) {
        if (type == Boolean.TYPE) {
            return false;
        }
        if (type == Byte.TYPE) {
            return (byte) 0;
        }
        if (type == Short.TYPE) {
            return (short) 0;
        }
        if (type == Integer.TYPE) {
            return 0;
        }
        if (type == Long.TYPE) {
            return 0L;
        }
        if (type == Float.TYPE) {
            return 0F;
        }
        if (type == Double.TYPE) {
            return 0.0D;
        }
        if (type == Character.TYPE) {
            return '\0';
        }
        return null;
    }
}
