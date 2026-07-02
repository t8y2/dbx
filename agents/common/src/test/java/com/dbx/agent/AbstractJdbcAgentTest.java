package com.dbx.agent;

import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AbstractJdbcAgentTest {
    @Test
    void ownsConnectionLifecycleAndConnectedState() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);

        assertThrows(IllegalStateException.class, () -> agent.executeQuery("SELECT 1", null, new ExecuteQueryOptions()));

        agent.connect(new ConnectParams("localhost", 0, "demo", "user", "secret", "", "", false));

        assertNotNull(agent.getConnection());
        assertEquals("demo", agent.database());
        assertEquals(1, tracking.openCount);
        assertEquals(1, agent.afterConnectCount);

        agent.disconnect();

        assertNull(agent.getConnection());
        assertEquals(1, tracking.closeCount);
    }

    @Test
    void testsConnectionsThroughSharedLifecycle() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);

        assertTrue(agent.testConnection(new ConnectParams()));

        assertEquals(1, tracking.openCount);
        assertEquals(1, tracking.isValidCount);
        assertEquals(1, tracking.closeCount);
    }

    @Test
    void delegatesQueryExecutionWithSchemaAndValueReader() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);
        agent.connect(new ConnectParams());

        QueryResult result = agent.executeQuery("SELECT VALUE", "APP", new ExecuteQueryOptions(25, 7));

        assertEquals(Collections.singletonList("VALUE"), result.getColumns());
        assertEquals(Collections.singletonList(Collections.<Object>singletonList("row-value")), result.getRows());
        assertFalse(result.getTruncated());
        assertEquals(Arrays.asList("setSchema:APP", "setMaxRows:26", "setFetchSize:7", "execute:SELECT VALUE"), tracking.calls);
    }

    @Test
    void delegatesQueryTimeoutToStatement() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);
        agent.connect(new ConnectParams());

        agent.executeQuery("SELECT VALUE", null, new ExecuteQueryOptions(25, 7, 12));

        assertEquals(Arrays.asList("setMaxRows:26", "setQueryTimeout:12", "setFetchSize:7", "execute:SELECT VALUE"), tracking.calls);
    }

    @Test
    void delegatesPagedQueryTimeoutToStatement() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);
        agent.connect(new ConnectParams());

        agent.executeQueryPage("SELECT VALUE", null, new QueryPageOptions(10, 7, 25, 12));

        assertEquals(Arrays.asList("setQueryTimeout:12", "setFetchSize:7", "execute:SELECT VALUE"), tracking.calls);
    }

    @Test
    void preservesPlSqlBlockTerminatorDuringQueryExecution() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);
        agent.connect(new ConnectParams());

        agent.executeQuery("BEGIN\n  NULL;\nEND;\n/", null, new ExecuteQueryOptions());

        assertEquals(Arrays.asList("setMaxRows:10001", "execute:BEGIN\n  NULL;\nEND;"), tracking.calls);
    }

    @Test
    void executesTransactionControlSqlThroughStatements() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);
        agent.connect(new ConnectParams());

        // Dump files can contain explicit transaction SQL while the JDBC connection is in auto-commit mode.
        agent.executeQuery("BEGIN;", null, new ExecuteQueryOptions());
        agent.executeQuery("BEGIN TRANSACTION;", null, new ExecuteQueryOptions());
        agent.executeQuery("COMMIT;", null, new ExecuteQueryOptions());
        agent.executeQuery("ROLLBACK;", null, new ExecuteQueryOptions());

        assertEquals(
            Arrays.asList(
                "setMaxRows:10001",
                "execute:BEGIN",
                "setMaxRows:10001",
                "execute:BEGIN TRANSACTION",
                "setMaxRows:10001",
                "execute:COMMIT",
                "setMaxRows:10001",
                "execute:ROLLBACK"
            ),
            tracking.calls
        );
    }

    @Test
    void executesPagedTransactionControlSqlThroughStatements() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);
        agent.connect(new ConnectParams());

        agent.executeQueryPage("COMMIT;", null, new QueryPageOptions());

        assertEquals(Collections.singletonList("execute:COMMIT"), tracking.calls);
    }

    @Test
    void delegatesTransactionsThroughSharedFoundation() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);
        agent.connect(new ConnectParams());

        QueryResult result = agent.executeTransaction(Arrays.asList("UPDATE A;", "UPDATE B"), "APP");

        assertEquals(2L, result.getAffected_rows());
        assertEquals(
            Arrays.asList(
                "setAutoCommit:false",
                "setSchema:APP",
                "executeUpdate:UPDATE A",
                "executeUpdate:UPDATE B",
                "commit",
                "setAutoCommit:true"
            ),
            tracking.calls
        );
    }

    @Test
    void preservesPlSqlBlockTerminatorDuringTransactionExecution() {
        TrackingConnection tracking = new TrackingConnection();
        TestAgent agent = new TestAgent(tracking);
        agent.connect(new ConnectParams());

        agent.executeTransaction(Collections.singletonList("DECLARE\n  v NUMBER;\nBEGIN\n  NULL;\nEND;"), null);

        assertEquals(
            Arrays.asList(
                "setAutoCommit:false",
                "executeUpdate:DECLARE\n  v NUMBER;\nBEGIN\n  NULL;\nEND;",
                "commit",
                "setAutoCommit:true"
            ),
            tracking.calls
        );
    }

    @Test
    void inheritedDdlFallbackToleratesMissingOptionalMetadata() {
        TestAgent agent = new TestAgent(new TrackingConnection()) {
            @Override
            public List<ColumnInfo> getColumns(String schema, String table) {
                return Collections.singletonList(new ColumnInfo("ID", "INTEGER", false, null, true));
            }

            @Override
            public List<IndexInfo> listIndexes(String schema, String table) {
                throw new RuntimeException("indexes unavailable");
            }

            @Override
            public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
                throw new RuntimeException("foreign keys unavailable");
            }
        };

        assertEquals(
            "CREATE TABLE \"APP\".\"ORDERS\" (\n" +
                "  \"ID\" INTEGER NOT NULL,\n" +
                "  PRIMARY KEY (\"ID\")\n" +
                ");\n",
            agent.getTableDdl("APP", "ORDERS")
        );
    }

    private static class TestAgent extends AbstractJdbcAgent {
        private final TrackingConnection tracking;
        private int afterConnectCount;

        private TestAgent(TrackingConnection tracking) {
            this.tracking = tracking;
        }

        @Override
        protected String driverClass() {
            return TestAgent.class.getName();
        }

        @Override
        protected String buildJdbcUrl(ConnectParams params) {
            return "jdbc:test";
        }

        @Override
        protected Connection openConnection(ConnectParams params) {
            tracking.openCount += 1;
            return tracking.connection();
        }

        @Override
        protected void afterConnect(ConnectParams params, Connection connection) {
            afterConnectCount += 1;
        }

        @Override
        public List<DatabaseInfo> listDatabases() {
            return Collections.emptyList();
        }

        @Override
        public List<String> listSchemas() {
            return Collections.emptyList();
        }

        @Override
        public List<TableInfo> listTables(String schema) {
            return Collections.emptyList();
        }

        @Override
        public List<ColumnInfo> getColumns(String schema, String table) {
            return Collections.emptyList();
        }

        @Override
        public List<IndexInfo> listIndexes(String schema, String table) {
            return Collections.emptyList();
        }

        @Override
        public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
            return Collections.emptyList();
        }

        @Override
        public List<TriggerInfo> listTriggers(String schema, String table) {
            return Collections.emptyList();
        }

        @Override
        public String setSchemaSQL(String schema) {
            return "USE " + schema;
        }

        private String database() {
            return getConfiguredDatabase();
        }
    }

    private static final class TrackingConnection {
        private final List<String> calls = new ArrayList<String>();
        private int openCount;
        private int closeCount;
        private int isValidCount;
        private boolean autoCommit = true;

        private Connection connection() {
            return proxy(Connection.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String name = method.getName();
                    if ("createStatement".equals(name)) {
                        return statement();
                    }
                    if ("getMetaData".equals(name)) {
                        return databaseMetaData();
                    }
                    if ("isValid".equals(name)) {
                        isValidCount += 1;
                        return true;
                    }
                    if ("close".equals(name)) {
                        closeCount += 1;
                        return null;
                    }
                    if ("getAutoCommit".equals(name)) {
                        return autoCommit;
                    }
                    if ("setSchema".equals(name)) {
                        calls.add("setSchema:" + args[0]);
                        return null;
                    }
                    if ("setCatalog".equals(name)) {
                        calls.add("setCatalog:" + args[0]);
                        return null;
                    }
                    if ("setAutoCommit".equals(name)) {
                        autoCommit = (Boolean) args[0];
                        calls.add("setAutoCommit:" + args[0]);
                        return null;
                    }
                    if ("commit".equals(name)) {
                        calls.add("commit");
                        return null;
                    }
                    if ("rollback".equals(name)) {
                        calls.add("rollback");
                        return null;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }

        private DatabaseMetaData databaseMetaData() {
            return proxy(DatabaseMetaData.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    if ("supportsTransactions".equals(method.getName())) {
                        return true;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }

        private Statement statement() {
            return proxy(Statement.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String name = method.getName();
                    if ("execute".equals(name)) {
                        calls.add("execute:" + args[0]);
                        return true;
                    }
                    if ("getResultSet".equals(name)) {
                        return resultSet();
                    }
                    if ("getUpdateCount".equals(name)) {
                        return 1;
                    }
                    if ("executeUpdate".equals(name)) {
                        calls.add("executeUpdate:" + args[0]);
                        return 1;
                    }
                    if ("setMaxRows".equals(name)) {
                        calls.add("setMaxRows:" + args[0]);
                        return null;
                    }
                    if ("setFetchSize".equals(name)) {
                        calls.add("setFetchSize:" + args[0]);
                        return null;
                    }
                    if ("setQueryTimeout".equals(name)) {
                        calls.add("setQueryTimeout:" + args[0]);
                        return null;
                    }
                    if ("close".equals(name)) {
                        return null;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }

        private ResultSet resultSet() {
            final int[] index = {-1};
            return proxy(ResultSet.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String name = method.getName();
                    if ("next".equals(name)) {
                        index[0] += 1;
                        return index[0] == 0;
                    }
                    if ("getMetaData".equals(name)) {
                        return resultSetMetaData();
                    }
                    if ("getString".equals(name)) {
                        return "row-value";
                    }
                    if ("wasNull".equals(name)) {
                        return false;
                    }
                    if ("close".equals(name)) {
                        return null;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }

        private ResultSetMetaData resultSetMetaData() {
            return proxy(ResultSetMetaData.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String name = method.getName();
                    if ("getColumnCount".equals(name)) {
                        return 1;
                    }
                    if ("getColumnLabel".equals(name)) {
                        return "VALUE";
                    }
                    if ("getColumnType".equals(name)) {
                        return Types.VARCHAR;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }
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
