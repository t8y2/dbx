package com.dbx.agent.dameng;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.JdbcAgentFake;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.SocketTimeoutException;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.SQLTransientConnectionException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DamengAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new DamengAgent();
    }

    @Override
    protected String resultSetSql() {
        return "VALUES (1)";
    }

    @Test
    void executeQueryReturnsPlanRowsForExplainStatements() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        QueryResult result = agent.executeQuery(
            "/* inspect */ EXPLAIN SELECT 1 FROM DUAL;",
            null,
            new ExecuteQueryOptions()
        );

        assertEquals(List.of("PLAN"), result.getColumns());
        assertEquals(List.of(List.of("row-value")), result.getRows());
        assertEquals(List.of("executeQuery"), JdbcAgentFake.calls);
    }

    @Test
    void physicalConnectionsDoNotEnableDbmsOutput() throws Exception {
        List<String> executedSql = new ArrayList<>();
        List<Integer> queryTimeouts = new ArrayList<>();
        List<Integer> networkTimeouts = new ArrayList<>();
        DamengAgent agent = new DamengAgent();

        agent.afterPhysicalConnect(null, printMessageConnection(null, executedSql, queryTimeouts, networkTimeouts));

        assertTrue(queryTimeouts.isEmpty());
        assertTrue(networkTimeouts.isEmpty());
        assertTrue(executedSql.isEmpty());
    }

    @Test
    void ordinaryQueriesDoNotEnableDbmsOutput() {
        List<String> executedSql = new ArrayList<>();
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, printMessageConnection(null, executedSql));

        agent.executeQuery("SELECT 1 FROM DUAL", null, new ExecuteQueryOptions());

        assertEquals(List.of("SELECT 1 FROM DUAL"), executedSql);
    }

    @Test
    void outputStatementsEnableDbmsOutputAfterCommentsWithKeywordBoundaries() {
        assertLazilyEnablesDbmsOutput("CALL LOG_ONLY_PROCEDURE()");
        assertLazilyEnablesDbmsOutput(" -- leading comment\nBEGIN NULL; END;");
        assertLazilyEnablesDbmsOutput("/* leading block */ DECLARE value INT; BEGIN NULL; END;");
        assertLazilyEnablesDbmsOutput("EXEC LOG_ONLY_PROCEDURE");
        assertLazilyEnablesDbmsOutput("EXECUTE LOG_ONLY_PROCEDURE");

        assertDoesNotEnableDbmsOutput("CALLBACK()");
        assertDoesNotEnableDbmsOutput("BEGINNING SELECT 1");
        assertDoesNotEnableDbmsOutput("DECLARE_VALUE INT");
        assertDoesNotEnableDbmsOutput("EXECUTOR RUN");
        assertDoesNotEnableDbmsOutput("EXECUTE_IMMEDIATE 'SELECT 1'");
        assertDoesNotEnableDbmsOutput("/* CALL hidden in a comment */ SELECT 1");
    }

    @Test
    void legacyDamengSkipsUnavailableDbmsOutputInitialization() {
        List<String> executedSql = new ArrayList<>();
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, printMessageConnection(null, executedSql));
        setLegacyJdbcMetadata(agent, true);

        agent.executeQuery("BEGIN NULL; END;", null, new ExecuteQueryOptions());

        assertEquals(List.of("BEGIN NULL; END;"), executedSql);
    }

    @Test
    void outputStatementsEnableDbmsOutputOncePerPhysicalConnection() {
        List<String> firstConnectionSql = new ArrayList<>();
        List<String> secondConnectionSql = new ArrayList<>();
        Object firstPhysicalConnection = new Object();
        Object secondPhysicalConnection = new Object();
        DamengAgent agent = new DamengAgent();

        TestSupport.setPrivateConnection(
            agent,
            printMessageConnection(null, firstConnectionSql, firstPhysicalConnection, null)
        );
        agent.executeQuery("CALL FIRST_PROCEDURE()", null, new ExecuteQueryOptions());
        TestSupport.setPrivateConnection(
            agent,
            printMessageConnection(null, firstConnectionSql, firstPhysicalConnection, null)
        );
        agent.executeQuery("BEGIN NULL; END;", null, new ExecuteQueryOptions());

        TestSupport.setPrivateConnection(
            agent,
            printMessageConnection(null, secondConnectionSql, secondPhysicalConnection, null)
        );
        agent.executeQuery("EXEC SECOND_PROCEDURE", null, new ExecuteQueryOptions());

        assertEquals(List.of(
            "BEGIN DBMS_OUTPUT.ENABLE(1000000); END;",
            "CALL FIRST_PROCEDURE()",
            "BEGIN NULL; END;"
        ), firstConnectionSql);
        assertEquals(List.of(
            "BEGIN DBMS_OUTPUT.ENABLE(1000000); END;",
            "EXEC SECOND_PROCEDURE"
        ), secondConnectionSql);
    }

    @Test
    void unsupportedOrRestrictedDbmsOutputDoesNotBlockUserSql() {
        assertDbmsOutputFailureFallsBack(new SQLFeatureNotSupportedException("unsupported", "0A000"));
        assertDbmsOutputFailureFallsBack(new SQLException("permission denied", "42000"));
    }

    @Test
    void dbmsOutputTimeoutDisablesFutureAttempts() {
        DamengAgent agent = new DamengAgent();
        SQLException timeout = new SQLException("network communication failed");
        timeout.initCause(new SocketTimeoutException("Read timed out"));
        List<String> firstConnectionSql = new ArrayList<>();
        List<String> retryConnectionSql = new ArrayList<>();
        List<Integer> firstNetworkTimeouts = new ArrayList<>();

        TestSupport.setPrivateConnection(agent, statementConnection(
            null,
            firstConnectionSql,
            new ArrayList<>(),
            firstNetworkTimeouts,
            new Object(),
            timeout
        ));
        RuntimeException error = assertThrows(
            RuntimeException.class,
            () -> agent.executeQuery("CALL FIRST_PROCEDURE()", null, new ExecuteQueryOptions())
        );
        assertSame(timeout, error.getCause());
        assertEquals(List.of("BEGIN DBMS_OUTPUT.ENABLE(1000000); END;"), firstConnectionSql);
        assertEquals(List.of(5_000), firstNetworkTimeouts);

        TestSupport.setPrivateConnection(agent, printMessageConnection(
            null,
            retryConnectionSql,
            new Object(),
            null
        ));
        agent.executeQuery("CALL RETRY_PROCEDURE()", null, new ExecuteQueryOptions());
        assertEquals(List.of("CALL RETRY_PROCEDURE()"), retryConnectionSql);
    }

    @Test
    void dbmsOutputInitializationPropagatesConnectionFailures() {
        SQLException transientFailure = new SQLTransientConnectionException("connection closed");
        SQLException sqlStateFailure = new SQLException("connection failure", "08006");
        SQLException wrappedFailure = new SQLException("permission denied", "42000");
        wrappedFailure.initCause(new SQLTransientConnectionException("connection closed"));

        assertDbmsOutputFailurePropagates(transientFailure);
        assertDbmsOutputFailurePropagates(sqlStateFailure);
        assertDbmsOutputFailurePropagates(wrappedFailure);
    }

    @Test
    void dbmsOutputInitializationPropagatesUnrelatedSetupFailures() {
        SQLException failure = new SQLException("resource busy", "HY000");

        assertDbmsOutputFailurePropagates(failure);
    }

    @Test
    void executeQueryReturnsDamengPrintMessagesForLogOnlyProcedures() {
        List<String> executedSql = new ArrayList<>();
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, printMessageConnection("first\n中文日志\n", executedSql));

        QueryResult result = agent.executeQuery(
            "CALL LOG_ONLY_PROCEDURE('input')",
            null,
            new ExecuteQueryOptions()
        );

        assertEquals(List.of("Message"), result.getColumns());
        assertEquals(List.of(List.of("first"), List.of("中文日志")), result.getRows());
        assertEquals(List.of(
            "BEGIN DBMS_OUTPUT.ENABLE(1000000); END;",
            "CALL LOG_ONLY_PROCEDURE('input')"
        ), executedSql);
    }

    @Test
    void legacyStatementWithoutJdbc4UnwrapReturnsNoPrintMessages() {
        Statement statement = (Statement) Proxy.newProxyInstance(
            DamengAgentTest.class.getClassLoader(),
            new Class<?>[]{Statement.class},
            (unused, method, args) -> {
                if ("unwrap".equals(method.getName())) {
                    throw new AbstractMethodError("legacy JDBC driver");
                }
                return defaultValue(method.getReturnType());
            }
        );

        assertEquals(List.of(), DamengAgent.statementPrintMessages(statement));
    }

    @Test
    void pagedOutputStatementsEnableDbmsOutputLazily() {
        List<String> executedSql = new ArrayList<>();
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, printMessageConnection("paged message", executedSql));

        QueryPageResult result = agent.executeQueryPage(
            "/* output */ CALL PAGED_LOG_PROCEDURE()",
            null,
            new QueryPageOptions(100, 100, 1000)
        );

        assertEquals(List.of(
            "BEGIN DBMS_OUTPUT.ENABLE(1000000); END;",
            "/* output */ CALL PAGED_LOG_PROCEDURE()"
        ), executedSql);
        assertEquals(List.of(List.of("paged message")), result.getRows());
    }

    @Test
    void executeQueryPageReturnsPlanRowsForExplainStatements() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        QueryPageResult result = agent.executeQueryPage(
            "EXPLAIN SELECT 1 FROM DUAL",
            null,
            new QueryPageOptions(100, 100, 1000)
        );

        assertEquals(List.of("PLAN"), result.getColumns());
        assertEquals(List.of(List.of("row-value")), result.getRows());
        assertNull(result.getSession_id());
        assertFalse(result.getHas_more());
        assertEquals(List.of("executeQuery"), JdbcAgentFake.calls);
    }

    @Test
    void explainTargetSqlOnlyMatchesStandaloneLeadingKeyword() {
        assertEquals("SELECT 1 FROM DUAL", DamengAgent.explainTargetSql("-- comment\n explain SELECT 1 FROM DUAL;;"));
        assertNull(DamengAgent.explainTargetSql("EXPLAINER SELECT 1"));
        assertNull(DamengAgent.explainTargetSql("SELECT 'EXPLAIN' FROM DUAL"));
    }

    @Test
    void objectSourceTypesMapToDamengMetadataTypes() {
        assertEquals("VIEW", DamengAgent.damengDdlObjectType("VIEW"));
        assertEquals("MATERIALIZED_VIEW", DamengAgent.damengDdlObjectType("MATERIALIZED VIEW"));
        assertEquals("MATERIALIZED_VIEW", DamengAgent.damengDdlObjectType("MATERIALIZED_VIEW"));
        assertEquals("PROCEDURE", DamengAgent.damengDdlObjectType("PROCEDURE"));
        assertEquals("FUNCTION", DamengAgent.damengDdlObjectType("function"));
        assertEquals("SEQUENCE", DamengAgent.damengDdlObjectType("sequence"));
        assertEquals("PKG_SPEC", DamengAgent.damengDdlObjectType("package"));
        assertEquals("PKG_BODY", DamengAgent.damengDdlObjectType("package body"));
        assertEquals("PKG_BODY", DamengAgent.damengDdlObjectType("PACKAGE_BODY"));
        assertEquals("TRIGGER", DamengAgent.damengDdlObjectType("trigger"));
        assertThrows(IllegalArgumentException.class, () -> DamengAgent.damengDdlObjectType("TABLE"));
    }

    @Test
    void spatialIndexDdlPreservesDamengIndexType() {
        IndexInfo index = new IndexInfo(
            "IDX_TEST_LINESTRING",
            List.of("LINESTRING"),
            false,
            false,
            null,
            "SPATIAL",
            null,
            null
        );

        assertEquals(
            "CREATE SPATIAL INDEX \"SYSDBA\".\"IDX_TEST_LINESTRING\" ON \"SYSDBA\".\"TEST\" (\"LINESTRING\");",
            DamengAgent.indexDdl("SYSDBA", "TEST", index)
        );
    }

    @Test
    void ordinaryIndexDdlKeepsExistingSyntax() {
        IndexInfo index = new IndexInfo(
            "IDX_TEST_NAME",
            List.of("NAME"),
            false,
            false,
            null,
            "NORMAL",
            null,
            null
        );

        assertEquals(
            "CREATE INDEX \"SYSDBA\".\"IDX_TEST_NAME\" ON \"SYSDBA\".\"TEST\" (\"NAME\");",
            DamengAgent.indexDdl("SYSDBA", "TEST", index)
        );

        index.setIs_unique(true);
        assertEquals(
            "CREATE UNIQUE INDEX \"SYSDBA\".\"IDX_TEST_NAME\" ON \"SYSDBA\".\"TEST\" (\"NAME\");",
            DamengAgent.indexDdl("SYSDBA", "TEST", index)
        );
    }

    @Test
    void constrainedTableQueryPushesFilterTypeAndPagingToDameng() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "APP",
            new MetadataListConstraints("ord", 50, 100, List.of("TABLE", "VIEW"))
        );

        assertTrue(query.sql().contains("FROM ALL_OBJECTS o"));
        assertTrue(query.sql().contains("FROM SYS.SYSOBJECTS materialized_view"));
        assertTrue(query.sql().contains("schema_object.NAME AS OWNER"));
        assertTrue(query.sql().contains("o.OBJECT_TYPE = 'MATERIALIZED VIEW'"));
        assertTrue(query.sql().contains("mv.MVIEW_NAME IS NOT NULL"));
        assertTrue(query.sql().contains("IN (?, ?)"));
        assertTrue(query.sql().contains("UPPER(o.OBJECT_NAME) LIKE ? ESCAPE '~'"));
        assertTrue(query.sql().endsWith("LIMIT ? OFFSET ?"));
        assertEquals(List.of("APP", "TABLE", "VIEW", "%O%R%D%", 50, 100), query.args());
    }

    @Test
    void constrainedTableQueryClassifiesMaterializedViewsForAnotherOwner() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "REPORTING",
            new MetadataListConstraints(null, 20, null, List.of("MATERIALIZED_VIEW"))
        );

        assertTrue(query.sql().contains("MATERIALIZED_VIEW"));
        assertTrue(query.sql().contains("schema_object.ID = materialized_view.SCHID"));
        assertTrue(query.sql().contains("mv.OWNER = o.OWNER"));
        assertEquals(List.of("REPORTING", "MATERIALIZED_VIEW", 20), query.args());
    }

    @Test
    void constrainedTableOnlyQuerySkipsMaterializedViewCatalog() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "APP",
            new MetadataListConstraints(null, 20, null, List.of("TABLE"))
        );

        assertFalse(query.sql().contains("SYS.SYSOBJECTS materialized_view"));
        assertFalse(query.sql().contains("USER_MVIEWS"));
        assertFalse(query.sql().contains("mv.MVIEW_NAME"));
        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?)"));
        assertEquals(List.of("APP", "TABLE", 20), query.args());
    }

    @Test
    void accessibleTableQueryBulkClassifiesViewsAndPreservesPaging() {
        DamengAgent.MetadataQuery query = DamengAgent.buildAccessibleConstrainedTablesQuery(
            "REPORTING",
            new MetadataListConstraints("sales", 20, 40, List.of("VIEW", "MATERIALIZED_VIEW"))
        );

        assertTrue(query.sql().contains("FROM ALL_OBJECTS o"));
        assertTrue(query.sql().contains("FROM ALL_DEPENDENCIES"));
        assertTrue(query.sql().contains("TYPE IN ('MATERIALIZED VIEW', 'MATERIALIZED_VIEW')"));
        assertFalse(query.sql().contains("SYS.SYSOBJECTS"));
        assertFalse(query.sql().contains("USER_MVIEWS"));
        assertFalse(query.sql().contains("DBMS_METADATA.GET_DDL"));
        assertTrue(query.sql().contains("mv.MVIEW_NAME IS NOT NULL"));
        assertTrue(query.sql().contains("UPPER(o.OBJECT_NAME) LIKE ? ESCAPE '~'"));
        assertTrue(query.sql().endsWith("LIMIT ? OFFSET ?"));
        assertEquals(List.of("REPORTING", "VIEW", "MATERIALIZED_VIEW", "%S%A%L%E%S%", 20, 40), query.args());
    }

    @Test
    void constrainedObjectQueryClassifiesMaterializedViewsBeforeFiltering() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedObjectsQuery(
            "APP",
            new MetadataListConstraints(null, 20, null, List.of("VIEW", "MATERIALIZED_VIEW"))
        );

        assertTrue(query.sql().contains("FROM SYS.SYSOBJECTS materialized_view"));
        assertTrue(query.sql().contains("mv.MVIEW_NAME IS NOT NULL"));
        assertTrue(query.sql().contains("WHEN 'MATERIALIZED_VIEW' THEN 2"));
        assertEquals(List.of("APP", "VIEW", "MATERIALIZED_VIEW", 20), query.args());
    }

    @Test
    void constrainedObjectQueryPushesRoutineOnlySearchToDameng() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedObjectsQuery(
            "APP",
            new MetadataListConstraints("sync", 20, null, List.of("PROCEDURE", "FUNCTION"))
        );

        assertFalse(query.sql().contains("SYS.SYSOBJECTS materialized_view"));
        assertFalse(query.sql().contains("USER_MVIEWS"));
        assertFalse(query.sql().contains("mv.MVIEW_NAME"));
        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?, ?)"));
        assertTrue(query.sql().contains("WHEN 'PROCEDURE' THEN 3"));
        assertTrue(query.sql().endsWith("LIMIT ?"));
        assertEquals(List.of("APP", "PROCEDURE", "FUNCTION", "%S%Y%N%C%", 20), query.args());
    }

    @Test
    void constrainedObjectQueryIncludesSequencesAndPackages() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedObjectsQuery(
            "APP",
            new MetadataListConstraints(null, 20, null, List.of("SEQUENCE", "PACKAGE", "PACKAGE_BODY"))
        );

        assertFalse(query.sql().contains("SYS.SYSOBJECTS materialized_view"));
        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?, ?, ?)"));
        assertEquals(List.of("APP", "SEQUENCE", "PACKAGE", "PACKAGE BODY", 20), query.args());
    }

    @Test
    void rawObjectQueryIncludesDamengPackageBodyCatalogType() {
        DamengAgent.MetadataQuery query = DamengAgent.buildRawConstrainedObjectsQuery(
            "APP",
            new MetadataListConstraints(null, null, null, List.of("SEQUENCE", "PACKAGE", "PACKAGE_BODY"))
        );

        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?, ?, ?)"));
        assertEquals(List.of("APP", "SEQUENCE", "PACKAGE", "PACKAGE BODY"), query.args());
    }

    @Test
    void constrainedTableQueryEscapesDamengLikeWildcardsWithSingleCharacter() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "APP",
            new MetadataListConstraints("a_%~\\", 20, null, List.of("TABLE"))
        );

        assertTrue(query.sql().contains("UPPER(o.OBJECT_NAME) LIKE ? ESCAPE '~'"));
        assertEquals(List.of("APP", "TABLE", "%A%~_%~%%~~%\\%", 20), query.args());
    }

    @Test
    void accessibleObjectQueryBulkClassifiesViewsAndPreservesPaging() {
        DamengAgent.MetadataQuery query = DamengAgent.buildAccessibleConstrainedObjectsQuery(
            "REPORTING",
            new MetadataListConstraints("sales", 10, 30, List.of("VIEW", "MATERIALIZED_VIEW"))
        );

        assertTrue(query.sql().contains("FROM ALL_DEPENDENCIES"));
        assertTrue(query.sql().contains("TYPE IN ('MATERIALIZED VIEW', 'MATERIALIZED_VIEW')"));
        assertFalse(query.sql().contains("SYS.SYSOBJECTS"));
        assertFalse(query.sql().contains("USER_MVIEWS"));
        assertFalse(query.sql().contains("DBMS_METADATA.GET_DDL"));
        assertTrue(query.sql().contains("mv.MVIEW_NAME IS NOT NULL"));
        assertTrue(query.sql().endsWith("LIMIT ? OFFSET ?"));
        assertEquals(List.of("REPORTING", "VIEW", "MATERIALIZED_VIEW", "%S%A%L%E%S%", 10, 30), query.args());
    }

    private static Connection printMessageConnection(String printMessage, List<String> executedSql) {
        return printMessageConnection(printMessage, executedSql, new ArrayList<>());
    }

    private static Connection printMessageConnection(
        String printMessage,
        List<String> executedSql,
        List<Integer> queryTimeouts
    ) {
        return printMessageConnection(printMessage, executedSql, queryTimeouts, new ArrayList<>());
    }

    private static Connection printMessageConnection(
        String printMessage,
        List<String> executedSql,
        List<Integer> queryTimeouts,
        List<Integer> networkTimeouts
    ) {
        return statementConnection(
            printMessage,
            executedSql,
            queryTimeouts,
            networkTimeouts,
            new Object(),
            null
        );
    }

    private static Connection printMessageConnection(
        String printMessage,
        List<String> executedSql,
        Object physicalConnection,
        SQLException dbmsOutputFailure
    ) {
        return statementConnection(
            printMessage,
            executedSql,
            new ArrayList<>(),
            new ArrayList<>(),
            physicalConnection,
            dbmsOutputFailure
        );
    }

    private static Connection statementConnection(
        String printMessage,
        List<String> executedSql,
        List<Integer> queryTimeouts,
        List<Integer> networkTimeouts,
        Object physicalConnection,
        SQLException dbmsOutputFailure
    ) {
        InvocationHandler statementHandler = (Object unused, Method method, Object[] args) -> {
            switch (method.getName()) {
                case "execute":
                    String sql = (String) args[0];
                    executedSql.add(sql);
                    if (dbmsOutputFailure != null && sql.contains("DBMS_OUTPUT.ENABLE")) {
                        throw dbmsOutputFailure;
                    }
                    return false;
                case "setQueryTimeout":
                    queryTimeouts.add((Integer) args[0]);
                    return null;
                case "getPrintMsg":
                    return printMessage;
                case "getUpdateCount":
                    return -1;
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        Statement statement = (Statement) Proxy.newProxyInstance(
            DamengAgentTest.class.getClassLoader(),
            new Class<?>[]{Statement.class, PrintMessageStatement.class},
            statementHandler
        );
        InvocationHandler connectionHandler = (Object unused, Method method, Object[] args) -> {
            switch (method.getName()) {
                case "createStatement":
                    return statement;
                case "getNetworkTimeout":
                    return 0;
                case "setNetworkTimeout":
                    networkTimeouts.add((Integer) args[1]);
                    return null;
                case "isWrapperFor":
                    return ((Class<?>) args[0]).getName().equals("dm.jdbc.driver.DmdbConnection");
                case "unwrap":
                    return ((Class<?>) args[0]).getName().equals("dm.jdbc.driver.DmdbConnection")
                        ? physicalConnection
                        : null;
                case "equals":
                    return unused == args[0];
                case "hashCode":
                    return System.identityHashCode(unused);
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        return (Connection) Proxy.newProxyInstance(
            DamengAgentTest.class.getClassLoader(),
            new Class<?>[]{Connection.class},
            connectionHandler
        );
    }

    private static void assertLazilyEnablesDbmsOutput(String sql) {
        List<String> executedSql = new ArrayList<>();
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, printMessageConnection(null, executedSql));

        agent.executeQuery(sql, null, new ExecuteQueryOptions());

        assertEquals(2, executedSql.size());
        assertEquals("BEGIN DBMS_OUTPUT.ENABLE(1000000); END;", executedSql.get(0));
    }

    private static void assertDoesNotEnableDbmsOutput(String sql) {
        List<String> executedSql = new ArrayList<>();
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, printMessageConnection(null, executedSql));

        agent.executeQuery(sql, null, new ExecuteQueryOptions());

        assertEquals(List.of(sql), executedSql);
    }

    private static void assertDbmsOutputFailureFallsBack(SQLException failure) {
        List<String> executedSql = new ArrayList<>();
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, printMessageConnection(null, executedSql, new Object(), failure));

        assertDoesNotThrow(() -> agent.executeQuery("CALL LOG_ONLY_PROCEDURE()", null, new ExecuteQueryOptions()));
        assertDoesNotThrow(() -> agent.executeQuery("BEGIN NULL; END;", null, new ExecuteQueryOptions()));

        assertEquals(List.of(
            "BEGIN DBMS_OUTPUT.ENABLE(1000000); END;",
            "CALL LOG_ONLY_PROCEDURE()",
            "BEGIN NULL; END;"
        ), executedSql);
    }

    private static void assertDbmsOutputFailurePropagates(SQLException failure) {
        List<String> executedSql = new ArrayList<>();
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, printMessageConnection(null, executedSql, new Object(), failure));

        RuntimeException error = assertThrows(
            RuntimeException.class,
            () -> agent.executeQuery("CALL LOG_ONLY_PROCEDURE()", null, new ExecuteQueryOptions())
        );

        assertSame(failure, error.getCause());
        assertEquals(List.of("BEGIN DBMS_OUTPUT.ENABLE(1000000); END;"), executedSql);
    }

    private static void setLegacyJdbcMetadata(DamengAgent agent, boolean value) {
        try {
            Field field = DamengAgent.class.getDeclaredField("legacyJdbcMetadata");
            field.setAccessible(true);
            field.set(agent, value);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("Unable to set legacy JDBC metadata mode", error);
        }
    }

    private static Object defaultValue(Class<?> type) {
        if (type == Boolean.TYPE) return false;
        if (type == Byte.TYPE) return (byte) 0;
        if (type == Short.TYPE) return (short) 0;
        if (type == Integer.TYPE) return 0;
        if (type == Long.TYPE) return 0L;
        if (type == Float.TYPE) return 0f;
        if (type == Double.TYPE) return 0.0d;
        if (type == Character.TYPE) return '\0';
        return null;
    }

    public interface PrintMessageStatement {
        String getPrintMsg();
    }
}
