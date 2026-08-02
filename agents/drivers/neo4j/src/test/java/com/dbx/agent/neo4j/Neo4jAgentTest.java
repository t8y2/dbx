package com.dbx.agent.neo4j;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.QueryResult;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
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
        List<String> calls = new ArrayList<>();
        Neo4jAgent agent = connectedAgent(fakeConnection(calls));

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
        List<String> calls = new ArrayList<>();
        Neo4jAgent agent = connectedAgent(fakeConnection(calls));

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

    @Test
    void listsConfiguredMemgraphDatabaseWhenCatalogDiscoveryRequiresEnterprise() {
        SQLException catalogError = new SQLException(
            "Your license has an invalid type. To use multi-tenancy you need to have an enterprise license."
        );
        Neo4jAgent agent = connectedAgent(fakeCatalogConnection(Collections.emptyList(), catalogError, null), "memgraph");

        Assertions.assertEquals(
            Collections.singletonList(new DatabaseInfo("memgraph")),
            agent.listDatabases()
        );
    }

    @Test
    void keepsDiscoveredNeo4jDatabasesSorted() {
        Neo4jAgent agent = connectedAgent(
            fakeCatalogConnection(Arrays.asList("system", "neo4j"), null, "neo4j"),
            "neo4j"
        );

        Assertions.assertEquals(
            Arrays.asList(new DatabaseInfo("neo4j"), new DatabaseInfo("system")),
            agent.listDatabases()
        );
    }

    private static Neo4jAgent connectedAgent(Connection connection) {
        return connectedAgent(connection, "");
    }

    private static Neo4jAgent connectedAgent(Connection connection, String database) {
        Neo4jAgent agent = new Neo4jAgent() {
            @Override
            protected void loadDriver(ConnectParams params) {
            }

            @Override
            protected Connection openConnection(ConnectParams params) {
                return connection;
            }
        };
        ConnectParams params = new ConnectParams();
        params.setDatabase(database);
        agent.connect(params);
        return agent;
    }

    private static Connection fakeCatalogConnection(
        List<String> catalogs,
        SQLException catalogError,
        String currentCatalog
    ) {
        DatabaseMetaData metadata = proxy(DatabaseMetaData.class, (unused, method, args) -> {
            switch (method.getName()) {
                case "getCatalogs":
                    if (catalogError != null) {
                        throw catalogError;
                    }
                    return fakeCatalogResultSet(catalogs);
                case "getIdentifierQuoteString":
                    return "`";
                default:
                    return defaultValue(method.getReturnType());
            }
        });
        return proxy(Connection.class, (unused, method, args) -> {
            switch (method.getName()) {
                case "getMetaData":
                    return metadata;
                case "getCatalog":
                    return currentCatalog;
                case "close":
                    return null;
                case "isClosed":
                    return false;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet fakeCatalogResultSet(List<String> catalogs) {
        int[] index = {-1};
        return proxy(ResultSet.class, (unused, method, args) -> {
            switch (method.getName()) {
                case "next":
                    index[0] += 1;
                    return index[0] < catalogs.size();
                case "getString":
                    return catalogs.get(index[0]);
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
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
