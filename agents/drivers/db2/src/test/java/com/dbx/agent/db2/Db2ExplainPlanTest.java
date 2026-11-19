package com.dbx.agent.db2;

import com.dbx.agent.test.TestSupport;
import com.dbx.agent.JdbcExecutor;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class Db2ExplainPlanTest {
    @Test
    void agentReturnsTaggedPlanWithoutExecutingBusinessQuery() {
        JdbcBoundary jdbc = new JdbcBoundary();
        JsonObject plan = JsonParser.parseString(jdbc.agent().getExplainInfo(
            "SELECT * FROM ORDERS WHERE NOTE = ';'; -- trailing comment", "DBX", "APP", 9, "explain"
        )).getAsJsonObject();
        assertEquals(1, plan.get("version").getAsInt());
        assertEquals("db2", plan.get("databaseType").getAsString());
        assertTrue(plan.get("requestTag").getAsString().matches("[0-9a-f]{20}"));
        assertEquals("12345678901234567890.123", plan.getAsJsonArray("operators").get(0)
            .getAsJsonObject().get("totalCost").getAsString());
        JsonObject stream = plan.getAsJsonArray("streams").get(0).getAsJsonObject();
        assertEquals("D", stream.get("sourceType").getAsString());
        assertEquals("-1", stream.get("sourceId").getAsString());
        assertEquals("ORDERS", stream.get("objectName").getAsString());
        assertEquals("(Q1.NOTE = ';')", plan.getAsJsonArray("predicates").get(0)
            .getAsJsonObject().get("text").getAsString());
        assertEquals(1, jdbc.executed.stream().filter(sql -> sql.startsWith("EXPLAIN PLAN")).count());
        assertTrue(jdbc.executed.stream().noneMatch(sql -> sql.startsWith("SELECT * FROM ORDERS")));
        assertTrue(jdbc.executed.stream().anyMatch(sql -> sql.endsWith("FOR SELECT * FROM ORDERS WHERE NOTE = ';'\n")));
        assertEquals(List.of(false, true), jdbc.autocommitChanges);
        assertEquals(2, jdbc.rollbacks);
        assertEquals(0, jdbc.commits);
        assertEquals("SESSION_DEFAULT", jdbc.schema);
        assertEquals(0, jdbc.openStatements);
        assertEquals(0, jdbc.openResultSets);
        assertTrue(jdbc.timeouts.stream().allMatch(timeout -> timeout == 9));
        for (String query : jdbc.prepared) {
            if (query.contains(" r JOIN ")) {
                for (String key : List.of("EXPLAIN_REQUESTER", "EXPLAIN_TIME", "SOURCE_NAME", "SOURCE_SCHEMA",
                    "SOURCE_VERSION", "EXPLAIN_LEVEL", "STMTNO", "SECTNO")) {
                    assertTrue(query.contains("r." + key + " = s." + key), key);
                }
                assertTrue(query.contains("s.EXPLAIN_REQUESTER = ? AND s.QUERYTAG = ?"));
                assertTrue(query.contains("s.EXPLAIN_LEVEL = 'P'"));
            }
        }
        assertTrue(jdbc.boundTags.stream().allMatch(tag -> tag.equals(plan.get("requestTag").getAsString())));
        assertTrue(jdbc.prepared.stream().filter(sql -> sql.contains("EXPLAIN_") && !sql.contains("SYSCAT"))
            .allMatch(sql -> sql.contains("\"AUTH_USER\".")));
    }

    @Test
    void systoolsFallbackIsIndependentOfBusinessSchemaAndIncludesAliases() {
        JdbcBoundary jdbc = new JdbcBoundary();
        jdbc.explainSchema = "SYSTOOLS";
        jdbc.agent().getExplainInfo("WITH x AS (SELECT 1 FROM SYSIBM.SYSDUMMY1) SELECT * FROM x", null, "Mixed \"Schema", -1, null);
        assertTrue(jdbc.executed.contains("SET SCHEMA \"Mixed \"\"Schema\""));
        assertEquals("SESSION_DEFAULT", jdbc.schema);
        assertTrue(jdbc.timeouts.isEmpty());
        assertTrue(jdbc.prepared.stream().filter(sql -> sql.contains(" r JOIN ")).allMatch(sql -> sql.contains("\"SYSTOOLS\".")));
        assertFalse(jdbc.prepared.get(0).contains("TYPE"));
        assertEquals("AUTH_USER", jdbc.catalogRequester);
    }

    @Test
    void existingTransactionIsRejectedWithoutRollbackOrCommit() {
        JdbcBoundary jdbc = new JdbcBoundary();
        jdbc.autocommit = false;
        IllegalStateException error = assertThrows(IllegalStateException.class,
            () -> jdbc.agent().getExplainInfo("SELECT 1 FROM SYSIBM.SYSDUMMY1", null, "APP", 0, "explain"));
        assertTrue(error.getMessage().contains("isolated connection"));
        assertEquals(0, jdbc.rollbacks);
        assertEquals(0, jdbc.commits);
        assertTrue(jdbc.executed.isEmpty());
        assertTrue(jdbc.autocommitChanges.isEmpty());
    }

    @Test
    void acceptsSupportedQueryPrefixes() {
        for (String sql : Arrays.asList("SELECT * FROM \"APP\".\"ORDERS\"",
            "WITH q AS (SELECT 1 FROM SYSIBM.SYSDUMMY1) SELECT * FROM q", "VALUES 1",
            "/* plan */ select * FROM APP.ORDERS",
            "-- plan\nwith q AS (SELECT 1 FROM SYSIBM.SYSDUMMY1) SELECT * FROM q",
            "/* plan */ values (1)",
            "/* outer /* inner */ trailing */ SELECT 1 FROM SYSIBM.SYSDUMMY1",
            "/* outer /* inner */ DELETE */ VALUES ('a;''b')",
            "WITH q AS (/* outer /* inner */ UPDATE */ SELECT 1 FROM SYSIBM.SYSDUMMY1) SELECT * FROM q")) {
            assertEquals(sql + "\n", Db2ExplainPlan.singleQuery(sql));
        }
    }

    @Test
    void rejectsInvalidInputsAndModesBeforeChangingConnection() {
        for (String sql : Arrays.asList(null, "", "DELETE FROM APP.ORDERS", "SELECT 1; DROP TABLE APP.ORDERS",
            "TABLE APP.ORDERS", "table \"APP\".\"ORDERS\";", "/* plan */ TABLE APP.ORDERS",
            "SELECT 1;;", "SELECT 'unterminated", "SELECT 1 /* unterminated", "SELECT 1 /* outer /* inner */")) {
            JdbcBoundary jdbc = new JdbcBoundary();
            assertThrows(IllegalArgumentException.class, () -> jdbc.agent().getExplainInfo(sql, null, null, 5, "explain"));
            assertTrue(jdbc.autocommitChanges.isEmpty());
            assertTrue(jdbc.executed.isEmpty());
        }
        JdbcBoundary jdbc = new JdbcBoundary();
        assertThrows(IllegalArgumentException.class,
            () -> jdbc.agent().getExplainInfo("SELECT 1", null, null, 5, "autotrace"));
        assertTrue(jdbc.autocommitChanges.isEmpty());
        assertEquals("/* leading /* nested */ comment */ VALUES ('a;''b')\n",
            Db2ExplainPlan.singleQuery("/* leading /* nested */ comment */ VALUES ('a;''b'); -- end"));
        assertEquals("SELECT \"semi;column\" FROM T -- comment\n",
            Db2ExplainPlan.singleQuery("SELECT \"semi;column\" FROM T -- comment"));
    }

    @Test
    void preservesSqlCodeStateAndChainWhileAddingPermissionHint() {
        JdbcBoundary jdbc = new JdbcBoundary();
        SQLException nativeError = new SQLException("SQL0551N not authorized", "42501", -551);
        nativeError.setNextException(new SQLException("Additional diagnostic", "42501", -551));
        jdbc.explainError = nativeError;
        RuntimeException error = assertThrows(RuntimeException.class,
            () -> jdbc.agent().getExplainInfo("SELECT * FROM ORDERS", null, "APP", 5, "explain"));
        SQLException diagnostic = sqlCause(error);
        assertEquals(-551, diagnostic.getErrorCode());
        assertEquals("42501", diagnostic.getSQLState());
        assertSame(nativeError, diagnostic.getCause());
        assertSame(nativeError, diagnostic.getNextException());
        assertTrue(error.getMessage().contains("INSERT/SELECT"));
        assertEquals(List.of(false, true), jdbc.autocommitChanges);
        assertEquals("SESSION_DEFAULT", jdbc.schema);
        assertEquals(2, jdbc.rollbacks);
        assertEquals(0, jdbc.openStatements);
        assertEquals(0, jdbc.openResultSets);
    }

    @Test
    void missingTablesGiveInitializationInstructionAndReleaseTransaction() {
        JdbcBoundary jdbc = new JdbcBoundary();
        jdbc.explainSchema = null;
        jdbc.explainError = new SQLException("SQL0219N Explain table does not exist", "42704", -219);
        RuntimeException error = assertThrows(RuntimeException.class,
            () -> jdbc.agent().getExplainInfo("SELECT 1", null, "APP", 0, "explain"));
        assertTrue(error.getMessage().contains("SYSINSTALLOBJECTS"));
        assertTrue(error.getMessage().contains("CURRENT USER"));
        assertEquals(-219, sqlCause(error).getErrorCode());
        assertEquals("42704", sqlCause(error).getSQLState());
        assertTrue(jdbc.executed.stream().anyMatch(sql -> sql.startsWith("EXPLAIN")));
        assertEquals(2, jdbc.rollbacks);
        assertTrue(jdbc.autocommit);
        assertEquals("SESSION_DEFAULT", jdbc.schema);
    }

    @Test
    void rollbackFailureClosesConnectionWithoutEnablingAutocommit() {
        JdbcBoundary jdbc = new JdbcBoundary();
        jdbc.rollbackError = new SQLException("rollback failed", "08006", -30081);
        RuntimeException error = assertThrows(RuntimeException.class,
            () -> jdbc.agent().getExplainInfo("SELECT 1", null, "APP", 1, "explain"));
        assertEquals("08006", sqlCause(error).getSQLState());
        assertTrue(jdbc.closed);
        assertEquals(List.of(false), jdbc.autocommitChanges);
        assertEquals(0, jdbc.commits);
    }

    @Test
    void cleanupFailureIsSuppressedUnderOriginalDatabaseError() {
        JdbcBoundary jdbc = new JdbcBoundary();
        jdbc.explainError = new SQLException("SQL0104N unexpected token", "42601", -104);
        jdbc.rollbackError = new SQLException("rollback failed", "08006", -30081);
        RuntimeException error = assertThrows(RuntimeException.class,
            () -> jdbc.agent().getExplainInfo("SELECT 1", null, null, 1, "explain"));
        assertSame(jdbc.explainError, sqlCause(error));
        assertEquals(1, jdbc.explainError.getSuppressed().length);
        assertSame(jdbc.rollbackError, jdbc.explainError.getSuppressed()[0]);
        assertTrue(jdbc.closed);
        assertEquals(List.of(false), jdbc.autocommitChanges);
    }

    @Test
    void distinctRequestsUseDistinctTagsAndNeverCommit() {
        JdbcBoundary jdbc = new JdbcBoundary();
        Db2Agent agent = jdbc.agent();
        String first = JsonParser.parseString(agent.getExplainInfo("SELECT 1", null, null, 0, null))
            .getAsJsonObject().get("requestTag").getAsString();
        String second = JsonParser.parseString(agent.getExplainInfo("SELECT 2", null, null, 0, null))
            .getAsJsonObject().get("requestTag").getAsString();
        assertNotEquals(first, second);
        assertEquals(2, jdbc.rollbacks);
        assertEquals(0, jdbc.commits);
    }

    @Test
    void rejectsMissingAmbiguousOrEmptyPlanInsteadOfSilentlyReturningAnotherRequest() {
        for (int count : List.of(0, 2)) {
            JdbcBoundary jdbc = new JdbcBoundary();
            jdbc.statementCount = count;
            assertThrows(RuntimeException.class,
                () -> jdbc.agent().getExplainInfo("SELECT 1", null, null, 0, null));
            assertEquals(1, jdbc.rollbacks);
            assertTrue(jdbc.autocommit);
            assertEquals(0, jdbc.openResultSets);
        }
        JdbcBoundary jdbc = new JdbcBoundary();
        jdbc.operatorCount = 0;
        RuntimeException error = assertThrows(RuntimeException.class,
            () -> jdbc.agent().getExplainInfo("SELECT 1", null, null, 0, null));
        assertTrue(error.getMessage().contains("no operators"));
        assertEquals(1, jdbc.rollbacks);
    }

    @Test
    void cancellationReachesBlockedNativeExplainAndCleansUpItsTransaction() throws Exception {
        JdbcBoundary jdbc = new JdbcBoundary();
        jdbc.explainStarted = new CountDownLatch(1);
        jdbc.cancelSignal = new CountDownLatch(1);
        JdbcExecutor executor = JdbcExecutor.current();
        Db2Agent agent = jdbc.agent();
        try (var worker = Executors.newSingleThreadExecutor()) {
            var pending = worker.submit(() -> agent.getExplainInfo("SELECT * FROM ORDERS", null, "APP", 0, "explain"));
            try {
                assertTrue(jdbc.explainStarted.await(3, TimeUnit.SECONDS), "Native Explain entered its blocking call");
                assertTrue(executor.hasActiveStatements(), "Native Statement registered with the session executor");
                executor.cancelActiveStatements();
                ExecutionException error = assertThrows(ExecutionException.class, () -> pending.get(2, TimeUnit.SECONDS));
                assertEquals("57014", sqlCause(error).getSQLState());
                assertEquals(1, jdbc.cancelCalls);
                assertFalse(executor.hasActiveStatements());
                assertEquals(2, jdbc.rollbacks);
                assertEquals(0, jdbc.commits);
                assertTrue(jdbc.autocommit);
                assertEquals("SESSION_DEFAULT", jdbc.schema);
                assertEquals(0, jdbc.openStatements);
                assertEquals(0, jdbc.openResultSets);
            } finally {
                jdbc.cancelSignal.countDown();
            }
        }
    }
    @Test
    void cancellationInNativeStatementGapPreventsExplainAndStillRestoresSchema() throws Exception {
        JdbcBoundary jdbc = new JdbcBoundary();
        jdbc.gapStarted = new CountDownLatch(1);
        jdbc.gapResume = new CountDownLatch(1);
        JdbcExecutor executor = JdbcExecutor.current();
        Db2Agent agent = jdbc.agent();
        try (var worker = Executors.newSingleThreadExecutor()) {
            var pending = worker.submit(() -> agent.getExplainInfo("SELECT * FROM ORDERS", null, "APP", 0, "explain"));
            try {
                assertTrue(jdbc.gapStarted.await(3, TimeUnit.SECONDS));
                assertFalse(executor.hasActiveStatements(), "Previous schema Statement already closed");
                executor.cancelActiveStatements();
                jdbc.gapResume.countDown();
                ExecutionException error = assertThrows(ExecutionException.class, () -> pending.get(2, TimeUnit.SECONDS));
                assertInstanceOf(CancellationException.class, error.getCause());
                assertTrue(jdbc.executed.stream().noneMatch(sql -> sql.startsWith("EXPLAIN")));
                assertEquals(2, jdbc.rollbacks);
                assertTrue(jdbc.autocommit);
                assertEquals("SESSION_DEFAULT", jdbc.schema);
                assertEquals(0, jdbc.openStatements);
                assertFalse(executor.hasActiveStatements());
            } finally {
                jdbc.gapResume.countDown();
            }
        }
    }
    private static SQLException sqlCause(Throwable error) {
        while (!(error instanceof SQLException) && error.getCause() != null) error = error.getCause();
        return assertInstanceOf(SQLException.class, error);
    }

    /** JDBC is the mocked boundary; production Agent and serialization run unchanged. */
    private static final class JdbcBoundary {
        boolean autocommit = true;
        boolean closed;
        String schema = "SESSION_DEFAULT";
        String explainSchema = "AUTH_USER";
        String catalogRequester;
        int rollbacks;
        int commits;
        int openStatements;
        int openResultSets;
        int statementCount = 1;
        int operatorCount = 1;
        SQLException explainError;
        SQLException rollbackError;
        CountDownLatch explainStarted;
        CountDownLatch cancelSignal;
        int cancelCalls;
        CountDownLatch gapStarted;
        CountDownLatch gapResume;
        int nativeStatementCreations;
        final List<Boolean> autocommitChanges = new ArrayList<>();
        final List<String> executed = new ArrayList<>();
        final List<String> prepared = new ArrayList<>();
        final List<Integer> timeouts = new ArrayList<>();
        final List<String> boundTags = new ArrayList<>();

        Db2Agent agent() {
            Db2Agent agent = new Db2Agent();
            TestSupport.setPrivateConnection(agent, proxy(Connection.class, (object, method, args) -> {
                return switch (method.getName()) {
                    case "isClosed" -> closed;
                    case "getAutoCommit" -> autocommit;
                    case "setAutoCommit" -> {
                        autocommit = (Boolean) args[0];
                        autocommitChanges.add(autocommit);
                        yield null;
                    }
                    case "rollback" -> {
                        rollbacks++;
                        if (rollbackError != null) throw rollbackError;
                        yield null;
                    }
                    case "commit" -> { commits++; yield null; }
                    case "close" -> { closed = true; yield null; }
                    case "createStatement" -> {
                        nativeStatementCreations++;
                        if (nativeStatementCreations == 3 && gapStarted != null) {
                            gapStarted.countDown();
                            if (!gapResume.await(5, TimeUnit.SECONDS)) throw new SQLException("Native gap was not released");
                        }
                        yield statement(null);
                    }
                    case "prepareStatement" -> {
                        String query = (String) args[0];
                        prepared.add(query);
                        yield statement(query);
                    }
                    default -> defaultValue(method.getReturnType());
                };
            }));
            return agent;
        }

        Statement statement(String query) {
            openStatements++;
            Map<Integer, String> params = new LinkedHashMap<>();
            return proxy(PreparedStatement.class, (object, method, args) -> {
                switch (method.getName()) {
                    case "setQueryTimeout": timeouts.add((Integer) args[0]); return null;
                    case "setMaxRows": return null;
                    case "cancel": cancelCalls++; if (cancelSignal != null) cancelSignal.countDown(); return null;
                    case "setString": params.put((Integer) args[0], (String) args[1]); return null;
                    case "close": openStatements--; return null;
                    case "execute":
                        String sql = (String) args[0];
                        executed.add(sql);
                        if (sql.startsWith("EXPLAIN") && explainStarted != null) {
                            explainStarted.countDown();
                            if (!cancelSignal.await(5, TimeUnit.SECONDS)) throw new SQLException("Native Statement was not cancelled", "HYT00");
                            throw new SQLException("Native Statement cancelled", "57014", -952);
                        }
                        if (sql.startsWith("EXPLAIN") && explainError != null) throw explainError;
                        if (sql.startsWith("SET SCHEMA")) {
                            schema = sql.substring("SET SCHEMA ".length() + 1, sql.length() - 1).replace("\"\"", "\"");
                        }
                        return false;
                    case "executeQuery":
                        if (query == null) {
                            executed.add((String) args[0]);
                            return rows(new String[][]{{"AUTH_USER", schema}});
                        }
                        if (query.contains("SYSCAT.TABLES")) {
                            catalogRequester = params.get(1);
                            return rows(explainSchema == null ? new String[0][] : new String[][]{{explainSchema}});
                        }
                        boundTags.add(params.get(2));
                        if (!query.contains(" r JOIN ")) {
                            String[][] values = new String[statementCount][];
                            Arrays.fill(values, new String[]{"AUTH_USER", "2026-10-07 01:02:03.123456", "SQLC2P31", "NULLID", "", "P", "1", "201"});
                            return rows(values);
                        }
                        if (query.contains("\"EXPLAIN_OPERATOR\"")) {
                            return rows(operatorCount == 0 ? new String[0][] :
                                new String[][]{{"1", "TBSCAN", "12345678901234567890.123", "1.25", "999", "2.125"}});
                        }
                        if (query.contains("\"EXPLAIN_STREAM\"")) {
                            return rows(new String[][]{{"0", "D", "-1", "O", "1", "200.5", "APP", "ORDERS"}});
                        }
                        if (query.contains("\"EXPLAIN_PREDICATE\"")) {
                            return rows(new String[][]{{"1", "(Q1.NOTE = ';')", "SARG      "}});
                        }
                        throw new AssertionError(query);
                    default: return defaultValue(method.getReturnType());
                }
            });
        }

        ResultSet rows(String[][] values) {
            openResultSets++;
            int[] cursor = {-1};
            return proxy(ResultSet.class, (object, method, args) -> {
                return switch (method.getName()) {
                    case "next" -> ++cursor[0] < values.length;
                    case "getString" -> values[cursor[0]][(Integer) args[0] - 1];
                    case "close" -> { openResultSets--; yield null; }
                    default -> defaultValue(method.getReturnType());
                };
            });
        }
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
}
