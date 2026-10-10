package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.CompletionAssistantCandidateKind;
import com.dbx.agent.CompletionAssistantMatchMode;
import com.dbx.agent.CompletionAssistantObjectKind;
import com.dbx.agent.CompletionAssistantRequest;
import com.dbx.agent.CompletionAssistantResponse;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;

class OceanBaseOracleAgentTest {
    @Test
    void buildsOceanBaseJdbcUrl() {
        ConnectParams params = new ConnectParams();
        params.setHost("oceanbase.example.com");
        params.setPort(0);
        params.setDatabase("sys");

        Assertions.assertEquals(
            "jdbc:oceanbase://oceanbase.example.com:2883/sys?compatibleOjdbcVersion=8",
            OceanBaseOracleAgent.buildUrl(params)
        );
    }

    @Test
    void appendsQueryParametersToJdbcUrl() {
        ConnectParams params = new ConnectParams();
        params.setHost("oceanbase.example.com");
        params.setPort(2881);
        params.setDatabase("sys");
        params.setUrl_params("useSSL=false");

        Assertions.assertEquals(
            "jdbc:oceanbase://oceanbase.example.com:2881/sys?useSSL=false&compatibleOjdbcVersion=8",
            OceanBaseOracleAgent.buildUrl(params)
        );
    }

    @Test
    void keepsExplicitCompatibleOjdbcVersion() {
        ConnectParams params = new ConnectParams();
        params.setHost("oceanbase.example.com");
        params.setPort(2881);
        params.setDatabase("sys");
        params.setUrl_params("compatibleOjdbcVersion=6&useSSL=false");

        Assertions.assertEquals(
            "jdbc:oceanbase://oceanbase.example.com:2881/sys?compatibleOjdbcVersion=6&useSSL=false",
            OceanBaseOracleAgent.buildUrl(params)
        );
    }

    @Test
    void schemaListingReturnsEveryNonBlankUserWithoutHardSystemExclusions() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, schemaConnection(sql, resultSet(
            new String[]{"USERNAME"},
            new Object[][]{
                {"SYS"},
                {null},
                {"   "},
                {"APEX_240100"},
                {"APP$USER"},
                {"REPORTING"}
            }
        )));

        Assertions.assertEquals(
            List.of("SYS", "APEX_240100", "APP$USER", "REPORTING"),
            agent.listSchemas()
        );
        String schemaSql = sql.get(0).toUpperCase(Locale.ROOT);
        Assertions.assertTrue(schemaSql.contains("FROM ALL_USERS"), schemaSql);
        Assertions.assertTrue(schemaSql.contains("USERNAME IS NOT NULL"), schemaSql);
        Assertions.assertFalse(schemaSql.contains("NOT IN"), schemaSql);
        Assertions.assertFalse(schemaSql.contains("USERNAME NOT LIKE"), schemaSql);
        Assertions.assertTrue(schemaSql.contains("CURRENT_SCHEMA') THEN 0"), schemaSql);
        Assertions.assertTrue(schemaSql.contains("SESSION_USER') THEN 1"), schemaSql);
        Assertions.assertTrue(schemaSql.endsWith("ELSE 2\nEND, USERNAME"), schemaSql);
    }

    @Test
    void appendsCompatibleOjdbcVersionToCustomJdbcUrl() {
        ConnectParams params = new ConnectParams();
        params.setConnection_string("jdbc:oceanbase://custom-host:2881/sys?useSSL=false");

        Assertions.assertEquals(
            "jdbc:oceanbase://custom-host:2881/sys?useSSL=false&compatibleOjdbcVersion=8",
            OceanBaseOracleAgent.buildUrl(params)
        );
    }

    @Test
    void convertsQueryTimeoutToOceanBaseSessionMicroseconds() {
        Assertions.assertEquals(
            "ALTER SESSION SET ob_query_timeout = 300000000",
            OceanBaseOracleAgent.queryTimeoutSql(300)
        );
        Assertions.assertEquals(
            "ALTER SESSION SET ob_query_timeout = 3216672000000000",
            OceanBaseOracleAgent.queryTimeoutSql(0)
        );
        Assertions.assertEquals(
            "ALTER SESSION SET ob_query_timeout = 2147483647000000",
            OceanBaseOracleAgent.queryTimeoutSql(Integer.MAX_VALUE)
        );
    }

    @Test
    void rejectsNegativeQueryTimeout() {
        Assertions.assertThrows(IllegalArgumentException.class, () -> OceanBaseOracleAgent.queryTimeoutSql(-1));
    }

    @ParameterizedTest
    @CsvSource({"10, 1000, false", "1, 1000, false", "1, 1, true", "2, 2, false"})
    void returnsCursorRowsWithoutAdditionalAuditQueries(int pageSize, int maxRows, boolean truncated) {
        List<Integer> auditLimits = new ArrayList<>();
        List<String> auditSql = new ArrayList<>();
        Connection auditConnection = auditTimingConnection(1, 2, false, auditSql, new ArrayList<>(), auditLimits);
        int[] row = {-1};
        int[] queryLimit = {0};
        int[] queryFetchSize = {0};
        boolean[] queryStarted = {false};
        boolean[] resultClosed = {false};
        boolean[] statementClosed = {false};
        ResultSetMetaData meta = proxy(ResultSetMetaData.class, (method, args) -> {
            if ("getColumnCount".equals(method.getName())) return 1;
            if ("getColumnLabel".equals(method.getName())) return "N";
            if ("getColumnType".equals(method.getName())) return Types.INTEGER;
            if ("getColumnTypeName".equals(method.getName())) return "NUMBER";
            return defaultValue(method.getReturnType());
        });
        ResultSet cursor = proxy(ResultSet.class, (method, args) -> {
            if ("next".equals(method.getName())) return ++row[0] < 2;
            if ("getMetaData".equals(method.getName())) return meta;
            if ("getObject".equals(method.getName()) || "getInt".equals(method.getName())) return row[0] + 1;
            if ("close".equals(method.getName())) resultClosed[0] = true;
            return defaultValue(method.getReturnType());
        });
        Statement statement = proxy(Statement.class, (method, args) -> {
            if ("setMaxRows".equals(method.getName())) queryLimit[0] = (Integer) args[0];
            if ("setFetchSize".equals(method.getName())) queryFetchSize[0] = (Integer) args[0];
            if ("execute".equals(method.getName())) {
                queryStarted[0] = !String.valueOf(args[0]).startsWith("ALTER SESSION");
                statementClosed[0] = false;
                return queryStarted[0];
            }
            if ("getResultSet".equals(method.getName())) return cursor;
            if ("close".equals(method.getName())) statementClosed[0] = true;
            return defaultValue(method.getReturnType());
        });
        Connection connection = proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                if (!queryStarted[0]) return statement;
                Assertions.assertTrue(resultClosed[0] && statementClosed[0], "close the cursor before reading its trace");
                return auditConnection.createStatement();
            }
            if ("prepareStatement".equals(method.getName())) return auditConnection.prepareStatement((String) args[0]);
            return defaultValue(method.getReturnType());
        });
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, connection);
        QueryPageResult result = agent.executeQueryPage("SELECT N FROM T", null, new QueryPageOptions(pageSize, null, maxRows, 5));
        List<List<Object>> rows = new ArrayList<>(result.getRows());
        if (result.getHas_more()) {
            Assertions.assertNull(result.getServer_execute_time_us());
            Assertions.assertTrue(auditSql.isEmpty(), "do not sample an open cursor");
            result = agent.fetchQueryPage(result.getSession_id(), pageSize);
            rows.addAll(result.getRows());
        }
        Assertions.assertFalse(result.getHas_more());
        Assertions.assertEquals(truncated, result.getTruncated());
        Assertions.assertEquals(truncated ? List.of(List.of(1)) : List.of(List.of(1), List.of(2)), rows);
        Assertions.assertEquals(maxRows + 1, queryLimit[0]);
        Assertions.assertTrue(queryFetchSize[0] > 0);
        Assertions.assertTrue(auditSql.isEmpty(), "completed queries must not read trace or audit records");
        Assertions.assertTrue(auditLimits.isEmpty());
        Assertions.assertNull(result.getServer_execute_time_us());
    }

    @Test
    void finishesCursorWithoutCreatingDiagnosticStatements() {
        int[] row = {-1};
        ResultSetMetaData meta = proxy(ResultSetMetaData.class, (method, args) -> {
            if ("getColumnCount".equals(method.getName())) return 1;
            if ("getColumnLabel".equals(method.getName())) return "N";
            if ("getColumnType".equals(method.getName())) return Types.INTEGER;
            if ("getColumnTypeName".equals(method.getName())) return "NUMBER";
            return defaultValue(method.getReturnType());
        });
        ResultSet cursor = proxy(ResultSet.class, (method, args) -> {
            if ("next".equals(method.getName())) return ++row[0] < 2;
            if ("getMetaData".equals(method.getName())) return meta;
            if ("getObject".equals(method.getName()) || "getInt".equals(method.getName())) return row[0] + 1;
            return defaultValue(method.getReturnType());
        });
        int[] statementsCreated = {0};
        Statement statement = proxy(Statement.class, (method, args) -> {
            if ("execute".equals(method.getName())) return !String.valueOf(args[0]).startsWith("ALTER SESSION");
            if ("getResultSet".equals(method.getName())) return cursor;
            return defaultValue(method.getReturnType());
        });
        Connection connection = proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                statementsCreated[0]++;
                return statement;
            }
            if ("isClosed".equals(method.getName())) return false;
            return defaultValue(method.getReturnType());
        });
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, connection);
        QueryPageResult first = agent.executeQueryPage("SELECT N FROM T", null, new QueryPageOptions(1, null, 10, 5));
        Assertions.assertTrue(first.getHas_more());
        Assertions.assertEquals(2, statementsCreated[0]);


        QueryPageResult last = agent.fetchQueryPage(first.getSession_id(), 1);
        Assertions.assertFalse(last.getHas_more());
        Assertions.assertNull(last.getServer_execute_time_us());
        Assertions.assertEquals(2, statementsCreated[0], "no diagnostic query may run when the cursor finishes");
    }

    @Test
    void treatsZeroQueryTimeoutAsUnlimitedForOceanBaseSession() {
        List<String> sql = new ArrayList<>();
        List<Integer> queryTimeouts = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        Connection connection = executionConnection(sql, queryTimeouts, List.of());
        TestSupport.setPrivateConnection(agent, connection);

        agent.executeQuery("INSERT INTO ITEMS (ID) VALUES (1)", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertEquals(withDbmsOutputEnable(
            "ALTER SESSION SET ob_query_timeout = 3216672000000000",
            "INSERT INTO ITEMS (ID) VALUES (1)"
        ), sql);
        Assertions.assertEquals(withDbmsOutputEnableTimeout(), queryTimeouts);
    }

    /**
     * Every statement now opens the capture gate, so the first statement on a
     * physical connection runs {@code DBMS_OUTPUT.ENABLE} before it: that is the
     * Go agent's behaviour too, and it is what lets a SELECT that calls a
     * printing function be captured.
     */
    private static List<String> withDbmsOutputEnable(String... statements) {
        List<String> expected = new ArrayList<>();
        expected.add("BEGIN DBMS_OUTPUT.ENABLE(1000000); END;");
        expected.addAll(List.of(statements));
        return expected;
    }

    /**
     * The ENABLE probe carries its own 5s statement timeout, so the recorded
     * statement timeouts start with it.
     */
    private static List<Integer> withDbmsOutputEnableTimeout(Integer... timeouts) {
        List<Integer> expected = new ArrayList<>();
        expected.add(5);
        expected.addAll(List.of(timeouts));
        return expected;
    }

    @Test
    void supportsCommitAndRollbackForInteractiveTransactions() {
        List<String> calls = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, transactionConnection(calls));

        agent.beginManualTransaction(null);
        Assertions.assertEquals(List.of("setAutoCommit:false"), calls);
        agent.commitManualTransaction();
        Assertions.assertEquals(List.of("setAutoCommit:false", "commit", "setAutoCommit:true"), calls);

        agent.beginManualTransaction(null);
        agent.rollbackManualTransaction();
        Assertions.assertEquals(
            List.of("setAutoCommit:false", "commit", "setAutoCommit:true", "setAutoCommit:false", "rollback", "setAutoCommit:true"),
            calls
        );
    }

    @Test
    void failedCommitKeepsTransactionOpenSoItCanBeRolledBack() throws SQLException {
        List<String> calls = new ArrayList<>();
        boolean[] failCommit = {true};
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        Connection connection = transactionConnection(calls, failCommit);
        TestSupport.setPrivateConnection(agent, connection);

        agent.beginManualTransaction(null);
        Assertions.assertThrows(RuntimeException.class, agent::commitManualTransaction);
        Assertions.assertFalse(connection.getAutoCommit());

        failCommit[0] = false;
        Assertions.assertDoesNotThrow(agent::rollbackManualTransaction);
        Assertions.assertTrue(connection.getAutoCommit());
        Assertions.assertEquals(
            List.of("setAutoCommit:false", "commit", "rollback", "setAutoCommit:true"),
            calls
        );
    }

    @Test
    void synchronizesSessionTimeoutForEveryQueryEntryPoint() {
        List<String> sql = new ArrayList<>();
        List<Integer> queryTimeouts = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        Connection connection = executionConnection(sql, queryTimeouts, List.of());
        TestSupport.setPrivateConnection(agent, connection);

        agent.executeQuery("SELECT 1 FROM DUAL", null, new ExecuteQueryOptions(10, null, 12));
        agent.executeQueryPage("SELECT 2 FROM DUAL", null, new QueryPageOptions(10, null, 10, 13));
        agent.startTableRead("SELECT 3 FROM DUAL", null, new QueryPageOptions(10, null, 10, 14));
        Assertions.assertDoesNotThrow(() -> agent.beforePooledConnectionReturn(connection));

        Assertions.assertEquals(withDbmsOutputEnable(
            "ALTER SESSION SET ob_query_timeout = 12000000",
            "SELECT 1 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 13000000",
            "SELECT 2 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 14000000",
            "SELECT 3 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 3216672000000000"
        ), sql);
        Assertions.assertEquals(withDbmsOutputEnableTimeout(12, 13, 14), queryTimeouts);
    }

    @Test
    void executesEveryQueryEntryPointWhenSessionTimeoutIsRejectedAsReadOnly() {
        SQLException sqlStateError = new SQLException("wrapped");
        sqlStateError.setNextException(new SQLException("read only", "25006"));
        SQLException vendorError = new SQLException("wrapped", new SQLException("read only", null, 1456));
        SQLException messageError = new SQLException("wrapped", new SQLException(
            "(conn=1) OBE-01456: may not perform insert/delete/update operation inside a READ ONLY transaction"
        ));
        List<String> sql = new ArrayList<>();
        List<Integer> queryTimeouts = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        Connection connection = executionConnection(
            sql,
            queryTimeouts,
            List.of(sqlStateError, vendorError, messageError)
        );
        TestSupport.setPrivateConnection(agent, connection);

        agent.executeQuery("SELECT 1 FROM DUAL", null, new ExecuteQueryOptions(10, null, 12));
        agent.executeQueryPage("SELECT 2 FROM DUAL", null, new QueryPageOptions(10, null, 10, 13));
        agent.startTableRead("SELECT 3 FROM DUAL", null, new QueryPageOptions(10, null, 10, 14));
        Assertions.assertDoesNotThrow(() -> agent.beforePooledConnectionReturn(connection));

        Assertions.assertEquals(withDbmsOutputEnable(
            "ALTER SESSION SET ob_query_timeout = 12000000",
            "SELECT 1 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 13000000",
            "SELECT 2 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 14000000",
            "SELECT 3 FROM DUAL"
        ), sql);
        Assertions.assertEquals(withDbmsOutputEnableTimeout(12, 13, 14), queryTimeouts);
    }

    @Test
    void rejectsUnrelatedSessionTimeoutErrorsBeforeExecutingQuery() {
        SQLException alterError = new SQLException("insufficient privileges", "42000", 1031);
        List<String> sql = new ArrayList<>();
        List<Integer> queryTimeouts = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, executionConnection(sql, queryTimeouts, List.of(alterError)));

        RuntimeException error = Assertions.assertThrows(
            RuntimeException.class,
            () -> agent.executeQuery("SELECT 1 FROM DUAL", null, new ExecuteQueryOptions(10, null, 12))
        );

        Assertions.assertSame(alterError, error.getCause());
        Assertions.assertEquals(
            withDbmsOutputEnable("ALTER SESSION SET ob_query_timeout = 12000000"),
            sql
        );
        Assertions.assertEquals(withDbmsOutputEnableTimeout(), queryTimeouts);
    }

    @Test
    void readsBlobValuesAsHexWithoutStringConversion() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, queryConnection(blobResultSet()));

        QueryResult result = agent.executeQuery(
            "SELECT PAYLOAD, EMPTY_PAYLOAD, DESCRIPTION FROM DOCUMENTS",
            null,
            new ExecuteQueryOptions(10, null, 5)
        );

        Assertions.assertEquals(List.of("PAYLOAD", "EMPTY_PAYLOAD", "DESCRIPTION"), result.getColumns());
        Assertions.assertEquals(
            List.of(Arrays.asList("0x012aff", null, "plain text")),
            result.getRows()
        );
    }

    @Test
    void enablesDbmsOutputOncePerPhysicalConnectionBeforeTheStatement() {
        DbmsOutputSession session = new DbmsOutputSession();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        agent.executeQuery("BEGIN DBMS_OUTPUT.PUT_LINE('one'); END;", null, new ExecuteQueryOptions(10, null, 0));
        agent.executeQuery("BEGIN DBMS_OUTPUT.PUT_LINE('two'); END;", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertEquals(1, session.enableAttempts, "ENABLE must run once per physical connection");
        Assertions.assertEquals(
            List.of(
                "BEGIN DBMS_OUTPUT.ENABLE(1000000); END;",
                "ALTER SESSION SET ob_query_timeout = 3216672000000000",
                "BEGIN DBMS_OUTPUT.PUT_LINE('one'); END;",
                "ALTER SESSION SET ob_query_timeout = 3216672000000000",
                "BEGIN DBMS_OUTPUT.PUT_LINE('two'); END;"
            ),
            session.executedSql
        );
        Assertions.assertEquals(List.of(5_000, 1_234), session.networkTimeouts, "the probe timeout must be restored");
    }

    @Test
    void enablesDbmsOutputAgainForADifferentPhysicalConnection() {
        DbmsOutputSession first = new DbmsOutputSession();
        DbmsOutputSession second = new DbmsOutputSession();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, first.connection());
        agent.executeQuery("BEGIN NULL; END;", null, new ExecuteQueryOptions(10, null, 0));

        TestSupport.setPrivateConnection(agent, second.connection());
        agent.executeQuery("BEGIN NULL; END;", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertEquals(1, first.enableAttempts);
        Assertions.assertEquals(1, second.enableAttempts);
    }

    @Test
    void dbmsOutputEnableFailureIsNotRetriedAndLeavesQueryResultsIntact() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.enableFails = true;
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult first = agent.executeQuery("BEGIN PRINT_ONE; END;", null, new ExecuteQueryOptions(10, null, 0));
        QueryResult second = agent.executeQuery("BEGIN PRINT_TWO; END;", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertEquals(1, session.enableAttempts, "a failed ENABLE must not be retried");
        Assertions.assertEquals(List.of(5_000, 1_234), session.networkTimeouts, "the probe timeout must be restored");
        Assertions.assertEquals(7, first.getAffected_rows());
        Assertions.assertEquals(7, second.getAffected_rows());
        Assertions.assertEquals(0, session.getLineCalls, "no drain is attempted once ENABLE failed");
        Assertions.assertTrue(first.getMessages().isEmpty());
        Assertions.assertTrue(second.getMessages().isEmpty());
        Assertions.assertEquals(
            List.of(
                "BEGIN DBMS_OUTPUT.ENABLE(1000000); END;",
                "ALTER SESSION SET ob_query_timeout = 3216672000000000",
                "BEGIN PRINT_ONE; END;",
                "ALTER SESSION SET ob_query_timeout = 3216672000000000",
                "BEGIN PRINT_TWO; END;"
            ),
            session.executedSql,
            "both statements must still run without a second ENABLE"
        );
    }

    @Test
    void drainsDbmsOutputLinesInOrderUntilStatusOne() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.buffer.addAll(List.of("first line", "", "third line"));
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult result = agent.executeQuery(
            "BEGIN DBMS_OUTPUT.PUT_LINE('x'); END;", null, new ExecuteQueryOptions(10, null, 0)
        );

        Assertions.assertEquals(
            List.of(
                Map.of("severity", "INFO", "message", "first line"),
                Map.of("severity", "INFO", "message", ""),
                Map.of("severity", "INFO", "message", "third line")
            ),
            result.getMessages()
        );
        // Three lines plus the terminal status = 1 poll.
        Assertions.assertEquals(1, session.getLineCalls, "batched fetch: one round trip carries the whole buffer");
    }

    @Test
    void attachesDbmsOutputToTheStatementThatProducedIt() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.printedBySqlMarker.put("PRINT_ONE", "from first");
        session.printedBySqlMarker.put("PRINT_TWO", "from second");
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult first = agent.executeQuery("BEGIN PRINT_ONE; END;", null, new ExecuteQueryOptions(10, null, 0));
        QueryResult second = agent.executeQuery("BEGIN PRINT_TWO; END;", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertEquals(
            List.of(Map.of("severity", "INFO", "message", "from first")),
            first.getMessages()
        );
        Assertions.assertEquals(
            List.of(Map.of("severity", "INFO", "message", "from second")),
            second.getMessages()
        );
    }

    /**
     * E1: a plain {@code SELECT} can print too, because it may call a stored
     * function that writes to {@code DBMS_OUTPUT}. The Go agent enables and
     * drains on every statement; the Java agent used to gate both on the
     * statement kind (BEGIN/DECLARE/CALL/EXEC), so a session whose first
     * statement was {@code SELECT f() FROM dual} never enabled the buffer and the
     * function's lines were lost for good.
     */
    @Test
    void capturesDbmsOutputFromASelectThatCallsAPrintingFunction() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.printedBySqlMarker.put("PRINT_F", "from the function");
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult result = agent.executeQuery(
            "SELECT PRINT_F FROM DUAL", null, new ExecuteQueryOptions(10, null, 0)
        );

        Assertions.assertEquals(1, session.enableAttempts, "the SELECT must enable the buffer");
        Assertions.assertTrue(
            session.executedSql.contains("BEGIN DBMS_OUTPUT.ENABLE(1000000); END;"),
            "ENABLE must run before the SELECT, not after it"
        );
        Assertions.assertEquals(
            List.of(Map.of("severity", "INFO", "message", "from the function")),
            result.getMessages()
        );
        Assertions.assertTrue(
            session.preparedSql.contains(OceanBaseOracleAgent.DBMS_OUTPUT_GET_LINE_SQL),
            "the SELECT must drain through the GET_LINE wrapper"
        );
    }

    /**
     * The plain-query path must not pay more than one probe round trip: a query
     * that printed nothing is drained once, gets no messages, and leaves the
     * "messages" key absent rather than an empty array.
     */
    @Test
    void drainsEveryStatementOnceAndKeepsPlainQueriesCheap() throws Exception {
        DbmsOutputSession session = new DbmsOutputSession();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult result = agent.executeQuery("SELECT 1 FROM DUAL", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertEquals(1, session.enableAttempts);
        Assertions.assertEquals(1, session.getLineCalls, "an empty buffer costs exactly the probe");
        Assertions.assertTrue(result.getMessages().isEmpty());
        Assertions.assertNull(privateField(result, "messages"));
    }

    /**
     * A data-modifying statement is captured as well: the printing function can be
     * called from an INSERT, so gating on BEGIN/CALL/EXEC alone would lose it.
     */
    @Test
    void capturesDbmsOutputFromAnInsertIntoSelect() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.printedBySqlMarker.put("INSERT INTO T VALUES (PRINT_F)", "from the insert");
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult result = agent.executeQuery(
            "INSERT INTO T VALUES (PRINT_F)", null, new ExecuteQueryOptions(10, null, 0)
        );

        Assertions.assertEquals(
            List.of(Map.of("severity", "INFO", "message", "from the insert")),
            result.getMessages()
        );
    }

    /**
     * The drain is the same GET_LINE wrapper the Go agent's helper package uses:
     * a local VARCHAR2(32767) so an over-long line leaves the buffer before the
     * assignment to the OUT register can fail.
     */
    @Test
    void drainsThroughTheVarchar32767GetLineWrapper() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.buffer.add("one line");
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        agent.executeQuery("BEGIN NULL; END;", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertTrue(
            session.preparedSql.contains(OceanBaseOracleAgent.DBMS_OUTPUT_GET_LINE_SQL),
            "the drain must use the agent's GET_LINE wrapper"
        );
    }

    @Test
    void omitsTheMessagesKeyWhenDbmsOutputIsEmpty() throws Exception {
        DbmsOutputSession session = new DbmsOutputSession();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult result = agent.executeQuery(
            "BEGIN DBMS_OUTPUT.DISABLE; END;", null, new ExecuteQueryOptions(10, null, 0)
        );

        Assertions.assertTrue(result.getMessages().isEmpty());
        // JsonRpcServer serializes QueryResult fields with a plain Gson, which
        // drops nulls; a null backing field is therefore an absent "messages" key.
        Assertions.assertNull(privateField(result, "messages"));
    }

    @Test
    void truncatesDbmsOutputAtTheDrainCapAndReportsIt() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.buffer.addAll(List.of("one", "two", "three", "four", "five"));
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        setField(agent, "dbmsOutputMaxLines", 3);
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult result = agent.executeQuery(
            "BEGIN PRINT_MANY; END;", null, new ExecuteQueryOptions(10, null, 0)
        );

        Assertions.assertEquals(
            List.of(
                Map.of("severity", "INFO", "message", "one"),
                Map.of("severity", "INFO", "message", "two"),
                Map.of("severity", "INFO", "message", "three"),
                Map.of("severity", "INFO", "message", OceanBaseOracleAgent.dbmsOutputTruncatedMessage(3))
            ),
            result.getMessages()
        );
        // The probe, the three attached lines and the one line past the cap: the
        // fourth line is what proves the buffer is bigger than 3, and it is
        // consumed, not attached.
        Assertions.assertEquals(1, session.getLineCalls, "batched fetch: one round trip carries the whole buffer");
        Assertions.assertEquals(
            1,
            session.clearCalls,
            "the lines behind the cap belong to this statement, not to the next one"
        );
        Assertions.assertTrue(session.buffer.isEmpty());
    }

    /**
     * The Java twin of the Go agent's "exactly the bound is not truncation": a
     * buffer of exactly {@code dbmsOutputMaxLines} lines must be reported whole,
     * with no notice, because the drain only stops early when it actually left
     * something behind.
     */
    @Test
    void keepsABufferOfExactlyTheDrainCapUntruncated() {
        DbmsOutputSession session = new DbmsOutputSession();
        for (int line = 1; line <= 3; line++) {
            session.buffer.add("line " + line);
        }
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        setField(agent, "dbmsOutputMaxLines", 3);
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult result = agent.executeQuery(
            "BEGIN PRINT_MANY; END;", null, new ExecuteQueryOptions(10, null, 0)
        );

        Assertions.assertEquals(3, result.getMessages().size());
        Assertions.assertEquals(
            List.of(
                Map.of("severity", "INFO", "message", "line 1"),
                Map.of("severity", "INFO", "message", "line 2"),
                Map.of("severity", "INFO", "message", "line 3")
            ),
            result.getMessages()
        );
        // Probe(1) + cap(3) + the read that finds nothing left; the empty result
        // is what proves exactly three lines were waiting.
        Assertions.assertEquals(1, session.getLineCalls, "batched fetch: one round trip carries the whole buffer");
        Assertions.assertEquals(0, session.clearCalls, "an exhausted buffer needs no purge");
        Assertions.assertTrue(session.buffer.isEmpty());
    }

    /**
     * The cap boundary at a size the fake can drive exactly: a buffer of exactly
     * {@code dbmsOutputMaxLines} lines is reported whole with no notice, and one
     * more line turns into the notice inside the same response -- the alignment
     * question E2 answers. The same boundary at the real cap of 10000 is verified
     * against a live server, where the block's payload budget also applies
     * (see the Java line report's E2 evidence).
     */
    @Test
    void reportsTheCapBoundaryExactlyAtNLineAndAtOneLinePastIt() {
        DbmsOutputSession exact = new DbmsOutputSession();
        for (int line = 1; line <= 5; line++) {
            exact.buffer.add("line " + line);
        }
        OceanBaseOracleAgent exactAgent = new OceanBaseOracleAgent();
        setField(exactAgent, "dbmsOutputMaxLines", 5);
        TestSupport.setPrivateConnection(exactAgent, exact.connection());

        QueryResult exactResult = exactAgent.executeQuery(
            "BEGIN PRINT_MANY; END;", null, new ExecuteQueryOptions(10, null, 0)
        );

        Assertions.assertEquals(5, exactResult.getMessages().size(), "exactly N is not truncation");
        Assertions.assertEquals(
            Map.of("severity", "INFO", "message", "line 5"),
            exactResult.getMessages().get(4)
        );
        Assertions.assertEquals(0, exact.clearCalls);

        DbmsOutputSession over = new DbmsOutputSession();
        for (int line = 1; line <= 6; line++) {
            over.buffer.add("line " + line);
        }
        OceanBaseOracleAgent overAgent = new OceanBaseOracleAgent();
        setField(overAgent, "dbmsOutputMaxLines", 5);
        TestSupport.setPrivateConnection(overAgent, over.connection());

        QueryResult overResult = overAgent.executeQuery(
            "BEGIN PRINT_MANY; END;", null, new ExecuteQueryOptions(10, null, 0)
        );

        Assertions.assertEquals(6, overResult.getMessages().size(), "N attached plus the one line past the cap");
        Assertions.assertEquals(
            Map.of("severity", "INFO", "message", "line 5"),
            overResult.getMessages().get(4)
        );
        Assertions.assertEquals(
            Map.of("severity", "INFO", "message", OceanBaseOracleAgent.dbmsOutputTruncatedMessage(5)),
            overResult.getMessages().get(5),
            "the truncation notice must be the last message"
        );
        Assertions.assertEquals(1, over.clearCalls, "the leftovers must be purged");
        Assertions.assertTrue(over.buffer.isEmpty());
    }

    /**
     * The truncation notice used to be the 512th entry the shared cap allowed;
     * that cap now has to admit the whole aligned drain plus its notice.
     */
    @Test
    void theSharedMessageCapAdmitsTheAlignedDrainPlusItsNotice() {
        QueryResult result = new QueryResult();
        for (int index = 0; index < 10_001; index++) {
            result.addInformationalMessage("line " + index, null);
        }
        Assertions.assertEquals(10_001, result.getMessages().size());
        QueryResult overflowing = new QueryResult();
        for (int index = 0; index < 10_002; index++) {
            overflowing.addInformationalMessage("line " + index, null);
        }
        Assertions.assertEquals(10_001, overflowing.getMessages().size());
    }

    @Test
    void reEnablesDbmsOutputAfterTheScriptDisabledIt() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.printedBySqlMarker.put("PRINT_AFTER", "after disable");
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        agent.executeQuery("BEGIN DBMS_OUTPUT.PUT_LINE('one'); END;", null, new ExecuteQueryOptions(10, null, 0));
        agent.executeQuery("BEGIN DBMS_OUTPUT.DISABLE; END;", null, new ExecuteQueryOptions(10, null, 0));
        QueryResult after = agent.executeQuery("BEGIN PRINT_AFTER; END;", null, new ExecuteQueryOptions(10, null, 0));

        // The DISABLE purged the buffer, so the next statement on the same pooled
        // connection must enable it again instead of printing into a dead buffer.
        Assertions.assertEquals(2, session.enableAttempts, "ENABLE must run again after DISABLE");
        Assertions.assertEquals(
            List.of(Map.of("severity", "INFO", "message", "after disable")),
            after.getMessages()
        );
    }

    @Test
    void reEnablesDbmsOutputOnlyWhenTheDisableCallIsRealCode() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.printedBySqlMarker.put("PRINT_AFTER", "after comments");
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        agent.executeQuery("BEGIN NULL; -- DBMS_OUTPUT.DISABLE\nEND;", null, new ExecuteQueryOptions(10, null, 0));
        agent.executeQuery("BEGIN /* DBMS_OUTPUT.DISABLE */ NULL; END;", null, new ExecuteQueryOptions(10, null, 0));
        QueryResult after = agent.executeQuery("BEGIN PRINT_AFTER; END;", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertEquals(1, session.enableAttempts, "a commented-out DISABLE must not reset the session");
        Assertions.assertEquals(
            List.of(Map.of("severity", "INFO", "message", "after comments")),
            after.getMessages()
        );
    }

    @Test
    void detectsDbmsOutputDisableCallsOutsideCommentsAndLiterals() {
        Assertions.assertTrue(OceanBaseOracleAgent.disablesDbmsOutput("BEGIN DBMS_OUTPUT.DISABLE; END;"));
        Assertions.assertTrue(OceanBaseOracleAgent.disablesDbmsOutput("begin dbms_output . disable ; end;"));
        Assertions.assertTrue(OceanBaseOracleAgent.disablesDbmsOutput("BEGIN \"DBMS_OUTPUT\".\"DISABLE\"; END;"));
        Assertions.assertFalse(OceanBaseOracleAgent.disablesDbmsOutput(null));
        Assertions.assertFalse(
            OceanBaseOracleAgent.disablesDbmsOutput("BEGIN DBMS_OUTPUT.PUT_LINE('DBMS_OUTPUT.DISABLE'); END;")
        );
        Assertions.assertFalse(OceanBaseOracleAgent.disablesDbmsOutput("-- DBMS_OUTPUT.DISABLE\nBEGIN NULL; END;"));
        Assertions.assertFalse(OceanBaseOracleAgent.disablesDbmsOutput("/* DBMS_OUTPUT.DISABLE */ BEGIN NULL; END;"));
        Assertions.assertFalse(OceanBaseOracleAgent.disablesDbmsOutput("SELECT 'x--y' FROM T /* DBMS_OUTPUT */"));
    }

    @Test
    void drainsTheBufferOfAFailedStatementSoTheNextStatementDoesNotInheritIt() {
        DbmsOutputSession session = new DbmsOutputSession();
        session.printedBySqlMarker.put("PRINT_FAIL", "from the failed statement");
        session.printedBySqlMarker.put("PRINT_AFTER", "from the next statement");
        session.failOnMarker = "PRINT_FAIL";
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        Assertions.assertThrows(RuntimeException.class, () -> agent.executeQuery(
            "BEGIN PRINT_FAIL; END;", null, new ExecuteQueryOptions(10, null, 0)
        ));
        Assertions.assertTrue(session.buffer.isEmpty(), "the failed statement's lines must be drained, not kept");

        QueryResult next = agent.executeQuery("BEGIN PRINT_AFTER; END;", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertEquals(
            List.of(Map.of("severity", "INFO", "message", "from the next statement")),
            next.getMessages(),
            "the failed statement's output must never be reported against the next statement"
        );
    }

    @Test
    void alignsTheDrainWithTheMessageCapAndPurgesTheLeftoverBuffer() {
        DbmsOutputSession session = new DbmsOutputSession();
        for (int line = 1; line <= 600; line++) {
            session.buffer.add("line " + line);
        }
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult result = agent.executeQuery(
            "BEGIN PRINT_MANY; END;", null, new ExecuteQueryOptions(10, null, 0)
        );

        // 600 lines fit inside the aligned cap of 10000, so all of them are
        // attached: the batch that carries them, then the read that finds the
        // buffer empty.
        Assertions.assertEquals(2, session.getLineCalls, "one batch plus the terminal read");
        Assertions.assertEquals(600, result.getMessages().size(), "every line fits inside the aligned cap, so none is dropped and no truncation notice is added");
        Assertions.assertEquals(
            Map.of("severity", "INFO", "message", "line 600"),
            result.getMessages().get(599)
        );
        // The whole buffer fit inside the aligned cap, so the terminal read found it
        // empty: nothing was left behind and there was nothing to purge. The purge
        // path belongs to a drain that stops on its own line bound with lines queued.
        Assertions.assertEquals(0, session.clearCalls, "an exhausted buffer leaves no leftovers to purge");
        Assertions.assertTrue(session.buffer.isEmpty());
    }

    @Test
    void keepsDrainingAfterAnOversizeLineHitsTheOutBufferLimit() {
        DbmsOutputSession session = new DbmsOutputSession();
        String oversize = "x".repeat(5_000);
        session.buffer.addAll(List.of("before", oversize, "after"));
        session.oversizeLines.add(oversize);
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        QueryResult result = agent.executeQuery(
            "BEGIN PRINT_LONG; END;", null, new ExecuteQueryOptions(10, null, 0)
        );

        Assertions.assertEquals(
            List.of(
                Map.of("severity", "INFO", "message", "before"),
                Map.of("severity", "INFO", "message", "after"),
                Map.of("severity", "INFO", "message", OceanBaseOracleAgent.DBMS_OUTPUT_OVERSIZE_LINE_MESSAGE)
            ),
            result.getMessages(),
            "the lines behind an over-long line must still be captured; the batch "
                + "reports the line it could not deliver behind the lines it did"
        );
        Assertions.assertEquals(0, session.clearCalls, "a dropped line does not truncate the buffer");
    }

    @Test
    void plDebugProbeRejectsAUserWithoutDebugConnectSession() {
        PlDebugProbeSession session = PlDebugProbeSession.fullyDebugcapable();
        // The Go agent's real-world defect: EXECUTE on DBMS_DEBUG is granted to
        // PUBLIC, so the dictionary lists every subroutine while the session holds
        // no DBMS_DEBUG privilege at all.
        session.sessionPrivileges = new ArrayList<>(List.of("CREATE SESSION"));
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        Map<String, Object> probe = agent.plDebugProbe();

        assertUnsupportedExplains(probe);
        Assertions.assertEquals(Boolean.FALSE, probe.get("debugConnectSession"));
        Assertions.assertEquals(Boolean.TRUE, probe.get("dbmsDebug"), "dictionary visibility must stay reported");
        String reason = String.valueOf(probe.get("reason"));
        Assertions.assertTrue(reason.contains("DEBUG CONNECT SESSION"), reason);
        Assertions.assertTrue(reason.contains("APP_USER"), reason);
        Assertions.assertTrue(reason.contains("GRANT DEBUG CONNECT SESSION TO \"APP_USER\""), reason);
        Assertions.assertTrue(reason.contains("ORA-01031"), reason);
        // The verdict is Oracle-first, so a server that does not use this
        // privilege has to be able to recognise the false negative.
        Assertions.assertTrue(reason.contains("ignored"), reason);
    }

    @Test
    void plDebugProbeAcceptsADirectGrantAsPositiveEvidence() {
        PlDebugProbeSession session = PlDebugProbeSession.fullyDebugcapable();
        session.sessionPrivileges = null;
        session.userSysPrivileges = new ArrayList<>(
            List.of("CREATE SESSION", "DEBUG CONNECT SESSION", "DEBUG ANY PROCEDURE")
        );
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        Map<String, Object> probe = agent.plDebugProbe();

        Assertions.assertEquals(Boolean.TRUE, probe.get("supported"));
        Assertions.assertEquals(Boolean.TRUE, probe.get("debugConnectSession"));
        Assertions.assertEquals(Boolean.TRUE, probe.get("debugAnyProcedure"));
        Assertions.assertFalse(probe.containsKey("reason"));
        Assertions.assertFalse(probe.containsKey("warnings"));
    }

    @Test
    void plDebugProbeTreatsAReadableDirectGrantViewWithoutThePrivilegeAsUnknown() {
        // USER_SYS_PRIVS holds direct grants only: a user whose DEBUG CONNECT
        // SESSION comes from a role shows nothing there, so a miss must not be
        // read as "granted nothing".
        PlDebugProbeSession session = PlDebugProbeSession.fullyDebugcapable();
        session.sessionPrivileges = null;
        session.userSysPrivileges = new ArrayList<>(List.of("CREATE SESSION"));
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        Map<String, Object> probe = agent.plDebugProbe();

        Assertions.assertEquals(Boolean.TRUE, probe.get("supported"), "a direct-grant miss must not veto");
        Assertions.assertFalse(probe.containsKey("reason"));
        Assertions.assertFalse(probe.containsKey("debugConnectSession"), "the privilege stays unverified");
        String warning = String.valueOf(probe.get("warnings"));
        Assertions.assertTrue(warning.contains("could not be verified"), warning);
        Assertions.assertTrue(warning.contains("role"), warning);
    }

    @Test
    void plDebugProbeWarnsWhenDebugAnyProcedureIsMissing() {
        PlDebugProbeSession session = PlDebugProbeSession.fullyDebugcapable();
        session.sessionPrivileges = new ArrayList<>(List.of("CREATE SESSION", "DEBUG CONNECT SESSION"));
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        Map<String, Object> probe = agent.plDebugProbe();

        Assertions.assertEquals(Boolean.TRUE, probe.get("supported"), "the privilege only limits foreign objects");
        Assertions.assertEquals(Boolean.FALSE, probe.get("debugAnyProcedure"));
        Assertions.assertFalse(probe.containsKey("reason"));
        String warning = String.valueOf(probe.get("warnings"));
        Assertions.assertTrue(warning.contains("DEBUG ANY PROCEDURE"), warning);
        Assertions.assertTrue(warning.contains("GRANT DEBUG ANY PROCEDURE TO \"APP_USER\""), warning);
    }

    @Test
    void plDebugProbeKeepsTheDictionaryVerdictWhenThePrivilegeViewQueryThrows() {
        PlDebugProbeSession session = PlDebugProbeSession.fullyDebugcapable();
        // Both privilege queries raise (no view, or no right to read it): the
        // question is unanswerable, which is not the same as "granted nothing".
        session.sessionPrivileges = null;
        session.userSysPrivileges = null;
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        Map<String, Object> probe = agent.plDebugProbe();

        Assertions.assertEquals(Boolean.TRUE, probe.get("supported"), "an unreadable view must not veto");
        Assertions.assertFalse(probe.containsKey("reason"));
        Assertions.assertFalse(probe.containsKey("debugConnectSession"));
        String warning = String.valueOf(probe.get("warnings"));
        Assertions.assertTrue(warning.contains("could not be verified"), warning);
        Assertions.assertTrue(warning.contains("SESSION_PRIVS"), warning);
    }

    @Test
    void plDebugProbeRejectsAReadablePrivilegeViewThatGrantedNothing() {
        // Oracle answers SELECT PRIVILEGE FROM SESSION_PRIVS with zero rows for a
        // user that was never granted DEBUG CONNECT SESSION, and
        // DBMS_DEBUG.INITIALIZE then raises ORA-01031. A successful empty answer
        // is therefore the missing grant, not an unknown one.
        PlDebugProbeSession withoutGrant = PlDebugProbeSession.fullyDebugcapable();
        withoutGrant.sessionPrivileges = new ArrayList<>();
        OceanBaseOracleAgent first = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(first, withoutGrant.connection());

        Map<String, Object> emptyViewProbe = first.plDebugProbe();

        assertUnsupportedExplains(emptyViewProbe);
        Assertions.assertEquals(Boolean.FALSE, emptyViewProbe.get("debugConnectSession"));
        String reason = String.valueOf(emptyViewProbe.get("reason"));
        Assertions.assertTrue(reason.contains("DEBUG CONNECT SESSION"), reason);
        Assertions.assertTrue(reason.contains("GRANT DEBUG CONNECT SESSION TO \"APP_USER\""), reason);
        // The OceanBase escape hatch: the false negative has to be recognisable.
        Assertions.assertTrue(reason.contains("ignored"), reason);
    }

    @Test
    void plDebugProbeReportsMissingSubroutinesAndDbmsOutputWithAReason() {
        PlDebugProbeSession missingSubroutines = PlDebugProbeSession.fullyDebugcapable();
        missingSubroutines.debugProcedures.retainAll(List.of("INITIALIZE", "GET_VALUES"));
        missingSubroutines.sessionPrivileges = new ArrayList<>(List.of("DEBUG CONNECT SESSION"));
        OceanBaseOracleAgent first = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(first, missingSubroutines.connection());

        Map<String, Object> missingProbe = first.plDebugProbe();

        assertUnsupportedExplains(missingProbe);
        Assertions.assertTrue(
            String.valueOf(missingProbe.get("reason")).contains("missing required subroutines"),
            String.valueOf(missingProbe.get("reason"))
        );
        Assertions.assertEquals(
            List.of("ATTACH_SESSION", "DEBUG_ON", "DEBUG_OFF", "SET_TIMEOUT_BEHAVIOUR", "SET_BREAKPOINT", "CONTINUE"),
            missingProbe.get("missingProcedures")
        );

        PlDebugProbeSession invisibleOutput = PlDebugProbeSession.fullyDebugcapable();
        invisibleOutput.outputProcedures.clear();
        invisibleOutput.sessionPrivileges = new ArrayList<>(List.of("DEBUG CONNECT SESSION", "DEBUG ANY PROCEDURE"));
        OceanBaseOracleAgent second = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(second, invisibleOutput.connection());

        Map<String, Object> outputProbe = second.plDebugProbe();

        assertUnsupportedExplains(outputProbe);
        Assertions.assertEquals(Boolean.FALSE, outputProbe.get("dbmsOutput"));
        String outputReason = String.valueOf(outputProbe.get("reason"));
        Assertions.assertTrue(outputReason.contains("DBMS_OUTPUT"), outputReason);
        Assertions.assertTrue(outputReason.contains("GRANT EXECUTE ON DBMS_OUTPUT TO \"APP_USER\""), outputReason);
    }

    private static void assertUnsupportedExplains(Map<String, Object> probe) {
        Assertions.assertEquals(Boolean.FALSE, probe.get("supported"));
        Object reason = probe.get("reason");
        Assertions.assertNotNull(reason, "every supported=false verdict must carry a reason");
        Assertions.assertFalse(String.valueOf(reason).isBlank(), "the reason must be actionable");
    }

    @Test
    void plDebugProbeWarnsAboutMissingGetValuesWithoutDisablingTheDebugger() {
        PlDebugProbeSession session = PlDebugProbeSession.fullyDebugcapable();
        session.debugProcedures.remove("GET_VALUES");
        session.sessionPrivileges = new ArrayList<>(List.of("DEBUG CONNECT SESSION", "DEBUG ANY PROCEDURE"));
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, session.connection());

        Map<String, Object> probe = agent.plDebugProbe();

        Assertions.assertEquals(Boolean.TRUE, probe.get("supported"));
        Assertions.assertEquals(Boolean.FALSE, probe.get("variablesSupported"));
        Assertions.assertFalse(probe.containsKey("reason"), "a degraded feature is not an unsupported server");
        Assertions.assertTrue(probe.get("warnings").toString().contains("GET_VALUES"));
    }

    @Test
    void constrainedListTablesUsesOceanBaseOracleMetadataSql() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"OBJECT_NAME", "TABLE_TYPE", "COMMENTS"},
            new Object[][]{
                {"USER_SETTINGS", "TABLE", null}
            }
        )));

        List<TableInfo> tables = agent.listTables(
            "APP",
            new MetadataListConstraints("user", 1, 1, List.of("TABLE"))
        );

        Assertions.assertEquals(1, tables.size());
        Assertions.assertEquals("USER_SETTINGS", tables.get(0).getName());
        Assertions.assertTrue(sql.get(0).contains("ALL_OBJECTS"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UPPER(o.OBJECT_NAME) LIKE ?"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("ROWNUM <= ?"), sql.get(0));
    }

    @Test
    void constrainedListObjectsUsesOceanBaseOracleMetadataSql() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"OBJECT_NAME", "OBJECT_TYPE", "COMMENTS"},
            new Object[][]{
                {"FORMAT_USER", "FUNCTION", null}
            }
        )));

        List<ObjectInfo> objects = agent.listObjects(
            "APP",
            new MetadataListConstraints("user", 1, 1, List.of("FUNCTION"))
        );

        Assertions.assertEquals(1, objects.size());
        Assertions.assertEquals("FORMAT_USER", objects.get(0).getName());
        Assertions.assertEquals("FUNCTION", objects.get(0).getObject_type());
        Assertions.assertTrue(sql.get(0).contains("OBJECT_TYPE IN (?)"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("ROWNUM <= ?"), sql.get(0));
    }

    @Test
    void globalCompletionTableSearchOmitsOwnerFilter() {
        CompletionAssistantRequest request = completionRequest("DWD", null, "STAG", true);
        OceanBaseOracleAgent.CompletionTablesQuery query = OceanBaseOracleAgent.buildCompletionTablesQuery(request, "DWD", 21);

        Assertions.assertTrue(query.sql.contains("FROM ALL_OBJECTS"), query.sql);
        Assertions.assertTrue(query.sql.contains("FROM ALL_SYNONYMS"), query.sql);
        Assertions.assertTrue(query.sql.contains("UPPER(o.OBJECT_NAME) LIKE ?"), query.sql);
        Assertions.assertFalse(query.sql.contains("UPPER(o.OWNER) = ?"), query.sql);
        Assertions.assertFalse(query.sql.contains("UPPER(s.OWNER) = ?"), query.sql);
        Assertions.assertTrue(query.sql.contains("ROWNUM <= ?"), query.sql);
        Assertions.assertEquals(List.of("STAG%", "STAG%", "DWD", "STAG", 21), query.args);
    }

    @Test
    void completionTableSearchFoldsLowercaseMasksForFuzzyMatch() {
        CompletionAssistantRequest request = completionRequest("dwd", null, "ord", true);
        setField(request, "match_mode", CompletionAssistantMatchMode.CONTAINS);
        OceanBaseOracleAgent.CompletionTablesQuery query = OceanBaseOracleAgent.buildCompletionTablesQuery(request, "dwd", 21);

        Assertions.assertTrue(query.sql.contains("UPPER(o.OBJECT_NAME) LIKE ?"), query.sql);
        Assertions.assertTrue(query.sql.contains("UPPER(OWNER) = ?"), query.sql);
        Assertions.assertTrue(query.sql.contains("UPPER(OBJECT_NAME) = ?"), query.sql);
        Assertions.assertFalse(query.sql.contains("LIKE UPPER(?)"), query.sql);
        Assertions.assertEquals(List.of("%ORD%", "%ORD%", "DWD", "ORD", 21), query.args);
    }

    @Test
    void scopedCompletionTableSearchFiltersOwnerCaseInsensitively() {
        CompletionAssistantRequest request = completionRequest("dwd", "staging", "ord", false);
        OceanBaseOracleAgent.CompletionTablesQuery query = OceanBaseOracleAgent.buildCompletionTablesQuery(request, "dwd", 21);

        Assertions.assertTrue(query.sql.contains("UPPER(o.OWNER) = ?"), query.sql);
        Assertions.assertTrue(query.sql.contains("UPPER(s.OWNER) = ?"), query.sql);
        Assertions.assertEquals(List.of("ORD%", "STAGING", "ORD%", "STAGING", "DWD", "ORD", 21), query.args);
    }

    @Test
    void completionAssistantSearchReturnsBoundedStandaloneRoutines() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"OWNER", "OBJECT_NAME", "OBJECT_TYPE"},
            new Object[][]{{"APP", "CALC", "PROCEDURE"}, {"APP", "CALCULATE", "FUNCTION"}, {"OTHER", "CALCULATE", "FUNCTION"}}
        )));
        CompletionAssistantRequest request = completionRequest("APP", null, "CAL", true);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.ROUTINE));
        setField(request, "max_results", 2);

        CompletionAssistantResponse response = agent.completionAssistantSearch(request);

        Assertions.assertEquals(List.of("CALC", "CALCULATE"), response.getCandidates().stream().map(candidate -> candidate.getName()).toList());
        Assertions.assertEquals(List.of("procedure", "function"), response.getCandidates().stream().map(candidate -> candidate.getKind().name().toLowerCase(Locale.ROOT)).toList());
        Assertions.assertEquals("APP", response.getCandidates().get(0).getSchema());
        Assertions.assertNull(response.getCandidates().get(0).getParent_name());
        Assertions.assertTrue(response.getIncomplete());
        Assertions.assertFalse(response.getFallback_used());
        Assertions.assertTrue(sql.get(0).contains("ROWNUM <= ?"));
        Assertions.assertTrue(new com.google.gson.Gson().toJsonTree(response).getAsJsonObject().has("routine_search_supported"));
    }

    @Test
    void mixedRoutineSearchPreservesRequestedSequences() {
        for (CompletionAssistantObjectKind routineKind : List.of(CompletionAssistantObjectKind.ROUTINE, CompletionAssistantObjectKind.FUNCTION)) {
            List<String> sql = new ArrayList<>();
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
                new String[]{"OWNER", "OBJECT_NAME", "OBJECT_TYPE"},
                new Object[][]{{"APP", "ORDER_SEQ", "SEQUENCE"}}
            )));
            CompletionAssistantRequest request = completionRequest("APP", null, "ORDER", false);
            setField(request, "object_kinds", List.of(routineKind, CompletionAssistantObjectKind.SEQUENCE));
            CompletionAssistantResponse response = agent.completionAssistantSearch(request);
            Assertions.assertTrue(sql.get(0).contains("'SEQUENCE'"));
            Assertions.assertEquals(CompletionAssistantCandidateKind.SEQUENCE, response.getCandidates().get(0).getKind());
        }
    }

    @Test
    void sequenceOnlySearchUsesOceanBaseFilteringWithoutAddingFunctions() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"OWNER", "OBJECT_NAME", "OBJECT_TYPE"},
            new Object[][]{{"APP", "ORDER_SEQ", "SEQUENCE"}}
        )));
        CompletionAssistantRequest request = completionRequest("APP", null, "ORDER", false);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.SEQUENCE));
        CompletionAssistantResponse response = agent.completionAssistantSearch(request);
        Assertions.assertEquals(1, response.getCandidates().size());
        Assertions.assertEquals(CompletionAssistantCandidateKind.SEQUENCE, response.getCandidates().get(0).getKind());
        Assertions.assertTrue(sql.get(0).contains("OBJECT_TYPE IN ('SEQUENCE')"));
        Assertions.assertFalse(sql.get(0).contains("'FUNCTION'"));
        Assertions.assertFalse(response.getFallback_used());
    }

    @Test
    void routineSearchPreservesQuotedOwnersAndEscapesLiteralMasks() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, params, resultSet(
            new String[]{"OWNER", "OBJECT_NAME", "OBJECT_TYPE"},
            new Object[][]{{"Mixed.Owner", "中文_%", "PROCEDURE"}}
        )));
        CompletionAssistantRequest request = completionRequest("APP", "Mixed.Owner", "中文_%", false);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.PROCEDURE));
        setField(request, "case_sensitive", true);
        setField(request, "match_mode", CompletionAssistantMatchMode.CONTAINS);
        setField(request, "max_results", 1);
        CompletionAssistantResponse response = agent.completionAssistantSearch(request);
        Assertions.assertEquals(List.of("%中文\\_\\%%", "Mixed.Owner", "APP"), params);
        Assertions.assertTrue(sql.get(0).contains("OBJECT_TYPE IN ('PROCEDURE')"));
        Assertions.assertTrue(sql.get(0).contains("OWNER = ?"));
        Assertions.assertFalse(sql.get(0).contains("UPPER(OBJECT_NAME)"));
        Assertions.assertEquals("中文_%", response.getCandidates().get(0).getName());
        Assertions.assertFalse(response.getIncomplete(), "Exactly the requested count is complete");
    }

    @Test
    void routineSearchDoesNotReturnStandaloneCandidatesForAPackageRequest() {
        CompletionAssistantRequest request = completionRequest("APP", null, "P", false);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.ROUTINE));
        setField(request, "parent_name", "PKG");
        Assertions.assertThrows(RuntimeException.class, () -> new OceanBaseOracleAgent().completionAssistantSearch(request));
    }

    @Test
    void packageCompletionKeepsNoArgumentMembersAndBoundedOverloadsWithCompleteSignatures() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, params,
            resultSet(new String[]{"OBJECT_ID"}, new Object[][]{{101}}),
            resultSet(new String[]{"PROCEDURE_NAME", "SUBPROGRAM_ID", "ROUTINE_KIND"},
                new Object[][]{{"RUN", 1, "PROCEDURE"}, {"RUN", 2, "FUNCTION"}, {"RUN", 3, "FUNCTION"}}),
            resultSet(new String[]{"SUBPROGRAM_ID", "POSITION", "ARGUMENT_NAME", "IN_OUT", "DATA_TYPE", "TYPE_OWNER", "TYPE_NAME", "TYPE_SUBNAME", "DEFAULTED"},
                new Object[][]{
                    {2, 0, null, "OUT", "NUMBER", null, null, null, "N"},
                    {2, 1, "INPUT", "IN", "NUMBER", null, null, null, "Y"},
                    {2, 2, "RESULT", "IN/OUT", "PL/SQL RECORD", "Mixed.Owner", "Types", "Payload", "N"}
                })
        ));
        CompletionAssistantRequest request = completionRequest("APP", "Mixed.Owner", "Ru_%", false);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.ROUTINE));
        setField(request, "parent_name", "Mixed.Package");
        setField(request, "case_sensitive", true);
        setField(request, "max_results", 2);
        CompletionAssistantResponse response = agent.completionAssistantSearch(request);

        Assertions.assertTrue(response.getIncomplete());
        Assertions.assertEquals(2, response.getCandidates().size());
        var procedure = response.getCandidates().get(0);
        var function = response.getCandidates().get(1);
        Assertions.assertEquals("", procedure.getSignature());
        Assertions.assertEquals("INPUT IN NUMBER DEFAULT, RESULT IN/OUT \"Mixed.Owner\".\"Types\".\"Payload\"", function.getSignature());
        Assertions.assertEquals("NUMBER", function.getData_type());
        Assertions.assertEquals("Mixed.Owner", function.getParent_schema());
        Assertions.assertEquals("Mixed.Package", function.getParent_name());
        Assertions.assertNotEquals(procedure.getRoutine_id(), function.getRoutine_id());
        Assertions.assertTrue(sql.get(0).contains("OBJECT_TYPE = 'PACKAGE'"));
        Assertions.assertTrue(sql.get(1).contains("p.OBJECT_ID = ?"));
        Assertions.assertTrue(sql.get(1).contains("ROWNUM <= ?"));
        Assertions.assertTrue(sql.get(2).contains("DATA_LEVEL = 0"));
        Assertions.assertTrue(sql.get(2).contains("SUBPROGRAM_ID IN (?,?)"));
        Assertions.assertFalse(sql.get(2).contains("ROWNUM"));
        Assertions.assertTrue(params.contains("Ru\\_\\%%"));
        var wire = new com.google.gson.Gson().toJsonTree(response).getAsJsonObject().getAsJsonArray("candidates");
        Assertions.assertEquals("", wire.get(0).getAsJsonObject().get("signature").getAsString());
        Assertions.assertEquals(function.getRoutine_id(), wire.get(1).getAsJsonObject().get("routine_id").getAsString());
    }

    @Test
    void packageCompletionResolvesInternalTypeOwnerThroughDatabaseIdentity() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql,
            resultSet(new String[]{"OBJECT_ID"}, new Object[][]{{101}}),
            resultSet(new String[]{"PROCEDURE_NAME", "SUBPROGRAM_ID", "ROUTINE_KIND"}, new Object[][]{{"OBJ", 6, "PROCEDURE"}}),
            resultSet(new String[]{"SUBPROGRAM_ID", "POSITION", "ARGUMENT_NAME", "IN_OUT", "DATA_TYPE", "TYPE_OWNER", "TYPE_NAME", "TYPE_SUBNAME", "DEFAULTED", "TYPE_SCHEMA"},
                new Object[][]{{6, 1, "X", "IN", "EXT", "514099   ", "Base.Type", null, "N", " Actual.Owner "}})
        ));
        CompletionAssistantRequest request = completionRequest("APP", "APP", "", false);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.ROUTINE));
        setField(request, "parent_name", "PKG");
        Assertions.assertEquals("X IN \" Actual.Owner \".\"Base.Type\"", agent.completionAssistantSearch(request).getCandidates().get(0).getSignature());
        Assertions.assertTrue(sql.get(2).contains("type_owner_object.OBJECT_TYPE = 'DATABASE'"));
        Assertions.assertTrue(sql.get(2).contains("TO_CHAR(type_owner_object.OBJECT_ID) = TRIM(a.TYPE_OWNER)"));
    }

    @Test
    void packageCompletionKeepsLiteralNumericTypeOwner() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(),
            resultSet(new String[]{"OBJECT_ID"}, new Object[][]{{101}}),
            resultSet(new String[]{"PROCEDURE_NAME", "SUBPROGRAM_ID", "ROUTINE_KIND"}, new Object[][]{{"OBJ", 6, "PROCEDURE"}}),
            resultSet(new String[]{"SUBPROGRAM_ID", "POSITION", "ARGUMENT_NAME", "IN_OUT", "DATA_TYPE", "TYPE_OWNER", "TYPE_NAME", "TYPE_SUBNAME", "DEFAULTED"},
                new Object[][]{{6, 1, "X", "IN", "EXT", "514099", "Base.Type", null, "N"}})
        ));
        CompletionAssistantRequest request = completionRequest("APP", "APP", "", false);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.ROUTINE));
        setField(request, "parent_name", "PKG");
        Assertions.assertEquals("X IN \"514099\".\"Base.Type\"", agent.completionAssistantSearch(request).getCandidates().get(0).getSignature());
    }

    @Test
    void packageCompletionDoesNotInventUnresolvedInternalTypeOwner() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(),
            resultSet(new String[]{"OBJECT_ID"}, new Object[][]{{101}}),
            resultSet(new String[]{"PROCEDURE_NAME", "SUBPROGRAM_ID", "ROUTINE_KIND"}, new Object[][]{{"OBJ", 6, "PROCEDURE"}}),
            resultSet(new String[]{"SUBPROGRAM_ID", "POSITION", "ARGUMENT_NAME", "IN_OUT", "DATA_TYPE", "TYPE_OWNER", "TYPE_NAME", "TYPE_SUBNAME", "DEFAULTED", "TYPE_SCHEMA"},
                new Object[][]{{6, 1, "X", "IN", "EXT", "514099   ", "Base.Type", null, "N", null}})
        ));
        CompletionAssistantRequest request = completionRequest("APP", "APP", "", false);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.ROUTINE));
        setField(request, "parent_name", "PKG");
        Assertions.assertNull(agent.completionAssistantSearch(request).getCandidates().get(0).getSignature());
    }

    @Test
    void packageCompletionDoesNotInventMissingParameterMetadata() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(),
            resultSet(new String[]{"OBJECT_ID"}, new Object[][]{{101}}),
            resultSet(new String[]{"PROCEDURE_NAME", "SUBPROGRAM_ID", "ROUTINE_KIND"}, new Object[][]{{"RUN", 1, "PROCEDURE"}}),
            resultSet(new String[]{"SUBPROGRAM_ID", "POSITION", "ARGUMENT_NAME", "IN_OUT", "DATA_TYPE", "TYPE_OWNER", "TYPE_NAME", "TYPE_SUBNAME", "DEFAULTED"},
                new Object[][]{{1, 1, "P", "IN", null, null, null, null, "N"}})
        ));
        CompletionAssistantRequest request = completionRequest("APP", "APP", "", false);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.ROUTINE));
        setField(request, "parent_name", "PKG");
        Assertions.assertNull(agent.completionAssistantSearch(request).getCandidates().get(0).getSignature());
    }

    @Test
    void packageCompletionDistinguishesVisibleEmptyPackageFromInvisiblePackage() {
        CompletionAssistantRequest request = completionRequest("APP", "APP", "", false);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.ROUTINE));
        setField(request, "parent_name", "PKG");
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(),
            resultSet(new String[]{"OBJECT_ID"}, new Object[][]{{101}}),
            resultSet(new String[]{"PROCEDURE_NAME", "SUBPROGRAM_ID", "ROUTINE_KIND"}, new Object[][]{})));
        Assertions.assertTrue(agent.completionAssistantSearch(request).getCandidates().isEmpty());
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(),
            resultSet(new String[]{"OBJECT_ID"}, new Object[][]{})));
        RuntimeException error = Assertions.assertThrows(RuntimeException.class, () -> agent.completionAssistantSearch(request));
        Assertions.assertTrue(error.toString().contains("Package is not visible"));
    }

    @Test
    void completionAssistantSearchReturnsGlobalTableCandidates() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"OWNER", "OBJECT_NAME", "OBJECT_TYPE", "TARGET_OWNER", "TARGET_NAME"},
            new Object[][]{
                {"DWD", "ORDERS", "TABLE", null, null},
                {"STAGING", "ORDERS", "TABLE", null, null}
            }
        )));

        CompletionAssistantResponse response = agent.completionAssistantSearch(completionRequest("DWD", null, "ORD", true));

        Assertions.assertEquals(2, response.getCandidates().size());
        Assertions.assertEquals("ORDERS", response.getCandidates().get(0).getName());
        Assertions.assertEquals("DWD", response.getCandidates().get(0).getSchema());
        Assertions.assertEquals("STAGING", response.getCandidates().get(1).getSchema());
        Assertions.assertFalse(sql.get(0).contains("UPPER(o.OWNER) = ?"), sql.get(0));
    }

    @Test
    void readsViewDdlWithDbmsMetadataForSchemaCompare() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, objectSourceConnection(
            sql,
            params,
            resultSet(
                new String[]{"DDL"},
                new Object[][]{{"CREATE OR REPLACE VIEW \"APP\".\"ACTIVE_USERS\" AS SELECT ID FROM USERS"}}
            )
        ));

        ObjectSource source = agent.getObjectSource("MixedOwner", "MixedView", "VIEW");

        Assertions.assertEquals("VIEW", source.getObject_type());
        Assertions.assertEquals("MixedOwner", source.getSchema());
        Assertions.assertTrue(source.getSource().startsWith("CREATE OR REPLACE VIEW"), source.getSource());
        Assertions.assertEquals(List.of("VIEW", "MixedView", "MixedOwner"), params);
        Assertions.assertTrue(sql.get(0).contains("DBMS_METADATA.GET_DDL"), sql.get(0));
    }

    @Test
    void setSchemaSQLPreservesSelectedSchemaName() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        Assertions.assertEquals("ALTER SESSION SET CURRENT_SCHEMA = \"MixedOwner\"", agent.setSchemaSQL("MixedOwner"));
        Assertions.assertEquals("", agent.setSchemaSQL(""));
        Assertions.assertEquals("", agent.setSchemaSQL(null));
    }

    @Test
    void getColumnsPreservesMetadataIdentifierSpelling() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(
            sql,
            params,
            columnResultSet(new Object[][]{{"MIXED_ID", "NUMBER", "N", 19, 0, 22, null, null, null, 1}}),
            columnResultSet(new Object[][]{{"UPPER_ID", "NUMBER", "N", 19, 0, 22, null, null, null, 1}})
        ));

        List<ColumnInfo> mixedColumns = agent.getColumns("MixedOwner", "Mixed");
        List<ColumnInfo> upperColumns = agent.getColumns("MixedOwner", "MIXED");

        Assertions.assertEquals(List.of("MIXED_ID"), mixedColumns.stream().map(ColumnInfo::getName).toList());
        Assertions.assertEquals(List.of("UPPER_ID"), upperColumns.stream().map(ColumnInfo::getName).toList());
        Assertions.assertEquals(
            List.of("MixedOwner", "Mixed", "MixedOwner", "Mixed", "MixedOwner", "MIXED", "MixedOwner", "MIXED"),
            params
        );
        Assertions.assertTrue(sql.get(0).contains("FROM ALL_TAB_COLUMNS"), sql.get(0));
    }

    @Test
    void getObjectSourcePreservesMetadataIdentifierSpelling() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, objectSourceConnection(
            sql,
            params,
            resultSet(
                new String[]{"DDL"},
                new Object[][]{{"CREATE OR REPLACE VIEW \"APP\".\"ACTIVE_USERS\" AS SELECT ID FROM USERS"}}
            )
        ));

        ObjectSource source = agent.getObjectSource("MixedOwner", "MixedView", "VIEW");

        Assertions.assertEquals("MixedView", source.getName());
        Assertions.assertEquals("MixedOwner", source.getSchema());
        Assertions.assertEquals(List.of("VIEW", "MixedView", "MixedOwner"), params);
    }

    @Test
    void getTableDdlPreservesMetadataIdentifierSpelling() {
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(), params,
            resultSet(
                new String[]{"DDL"},
                new Object[][]{{"CREATE TABLE \"Mixed\" (\"ID\" NUMBER)"}}
            ),
            resultSet(new String[]{"INDEX_NAME"}, new Object[][]{}),
            resultSet(new String[]{"COMMENTS"}, new Object[][]{{null}}),
            resultSet(new String[]{"COLUMN_NAME", "COMMENTS"}, new Object[][]{}),
            resultSet(new String[]{"GRANTEE", "PRIVILEGE", "GRANTABLE"}, new Object[][]{})
        ));

        String ddl = agent.getTableDdl("MixedOwner", "Mixed");

        Assertions.assertTrue(ddl.contains("CREATE TABLE"), ddl);
        Assertions.assertEquals("TABLE", params.get(0));
        Assertions.assertEquals("Mixed", params.get(1));
        Assertions.assertEquals("MixedOwner", params.get(2));
    }

    @Test
    void fallsBackToAllViewsWhenDbmsMetadataIsUnavailable() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, objectSourceFallbackConnection(
            sql,
            params,
            resultSet(new String[]{"TEXT"}, new Object[][]{{"SELECT ID FROM USERS"}})
        ));

        ObjectSource source = agent.getObjectSource("MixedOwner", "MixedView", "VIEW");

        Assertions.assertEquals("SELECT ID FROM USERS", source.getSource());
        Assertions.assertEquals(List.of("VIEW", "MixedView", "MixedOwner", "MixedOwner", "MixedView"), params);
        Assertions.assertTrue(sql.get(1).contains("ALL_VIEWS"), sql.get(1));
    }

    @Test
    void readsOracleRoutineAndPackageTypesFromAllSourceFirst() {
        for (String[] object : new String[][]{
            {"PROCEDURE", "PROCEDURE"},
            {"FUNCTION", "FUNCTION"},
            {"PACKAGE", "PACKAGE"},
            {"PACKAGE_BODY", "PACKAGE BODY"}
        }) {
            List<String> sql = new ArrayList<>();
            List<String> params = new ArrayList<>();
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            TestSupport.setPrivateConnection(agent, objectSourceConnection(
                sql,
                params,
                resultSet(
                    new String[]{"TEXT"},
                    new Object[][]{{object[1] + " ACCOUNT_API AS\n"}, {"END ACCOUNT_API;\n"}}
                )
            ));

            ObjectSource source = agent.getObjectSource("MixedOwner", "MixedRoutine", object[0]);

            Assertions.assertEquals(object[0], source.getObject_type());
            Assertions.assertTrue(source.getSource().startsWith("CREATE OR REPLACE " + object[1]), source.getSource());
            Assertions.assertEquals(
                List.of("MixedOwner", "MixedRoutine", object[1]),
                params
            );
            Assertions.assertEquals(1, sql.size());
            Assertions.assertTrue(sql.get(0).contains("ALL_SOURCE"), sql.get(0));
            Assertions.assertTrue(sql.get(0).contains("ORDER BY LINE"), sql.get(0));
        }
    }

    @Test
    void fallsBackToDbmsMetadataWhenAllSourceIsUnavailable() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, objectSourceFallbackConnection(
            sql,
            params,
            resultSet(
                new String[]{"DDL"},
                new Object[][]{{"CREATE OR REPLACE PROCEDURE APP.P1 AS BEGIN NULL; END;"}}
            )
        ));

        ObjectSource source = agent.getObjectSource("APP", "P1", "PROCEDURE");

        Assertions.assertTrue(source.getSource().startsWith("CREATE OR REPLACE PROCEDURE"), source.getSource());
        Assertions.assertTrue(sql.get(0).contains("ALL_SOURCE"), sql.get(0));
        Assertions.assertTrue(sql.get(1).contains("DBMS_METADATA.GET_DDL"), sql.get(1));
        Assertions.assertEquals(List.of("APP", "P1", "PROCEDURE", "PROCEDURE", "P1", "APP"), params);
    }

    @Test
    void synonymSourcePreservesOwnersQuotedNamesAndRemoteLinkDomains() {
        for (String owner : List.of("Mixed.Owner", "PUBLIC")) {
            List<String> sql = new ArrayList<>();
            List<String> params = new ArrayList<>();
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            TestSupport.setPrivateConnection(agent, preparedConnection(sql, params, resultSet(
                new String[]{"TABLE_OWNER", "TABLE_NAME", "DB_LINK"},
                new Object[][]{{"Target.Owner", "A\"B", "REMOTE.EXAMPLE"}}
            )));
            ObjectSource source = agent.getObjectSource(owner, "Syn.Name", "SYNONYM");
            String declaration = owner.equals("PUBLIC") ? "PUBLIC SYNONYM \"Syn.Name\"" : "SYNONYM \"Mixed.Owner\".\"Syn.Name\"";
            Assertions.assertEquals("CREATE OR REPLACE " + declaration + " FOR \"Target.Owner\".\"A\"\"B\"@REMOTE.EXAMPLE;", source.getSource());
            Assertions.assertEquals(List.of(owner, "Syn.Name"), params);
            Assertions.assertEquals(1, sql.size());
            Assertions.assertTrue(sql.get(0).contains("ALL_SYNONYMS"));
        }
    }

    @Test
    void synonymSourceHandlesMissingAndLocalTargetsWithoutGuessing() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(), resultSet(
            new String[]{"TABLE_OWNER", "TABLE_NAME", "DB_LINK"}, new Object[][]{{null, "T", null}}
        )));
        Assertions.assertEquals("CREATE OR REPLACE SYNONYM \"APP\".\"S\" FOR \"T\";", agent.getObjectSource("APP", "S", "SYNONYM").getSource());
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(), resultSet(
            new String[]{"TABLE_OWNER", "TABLE_NAME", "DB_LINK"}, new Object[][]{}
        )));
        Assertions.assertEquals("", agent.getObjectSource("APP", "missing", "SYNONYM").getSource());
    }

    @Test
    void synonymSourceRejectsUnsafeRemoteMetadata() {
        for (String link : List.of("x; DROP TABLE T", "x--", "a..b")) {
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(), resultSet(
                new String[]{"TABLE_OWNER", "TABLE_NAME", "DB_LINK"}, new Object[][]{{"APP", "T", link}}
            )));
            Assertions.assertThrows(RuntimeException.class, () -> agent.getObjectSource("APP", "S", "SYNONYM"));
        }
    }

    @Test
    void sequenceFallbackUsesExactIntegerMetadataWithoutConsumingNextValue() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, objectSourceFallbackConnection(sql, params, resultSet(
            new String[]{"MIN_VALUE", "MAX_VALUE", "INCREMENT_BY", "CYCLE_FLAG", "ORDER_FLAG", "CACHE_SIZE", "LAST_NUMBER"},
            new Object[][]{{"-999", "9999999999999999999999999999", "-2", "N", "Y", "0", "40"}}
        )));
        String source = agent.getObjectSource("Mixed.Owner", "S\"Q", "SEQUENCE").getSource();
        Assertions.assertEquals("CREATE SEQUENCE \"Mixed.Owner\".\"S\"\"Q\"\n  MINVALUE -999\n  MAXVALUE 9999999999999999999999999999\n  INCREMENT BY -2\n  START WITH 40\n  NOCACHE\n  NOCYCLE\n  ORDER;", source);
        Assertions.assertEquals(List.of("SEQUENCE", "S\"Q", "Mixed.Owner", "Mixed.Owner", "S\"Q"), params);
        Assertions.assertFalse(sql.stream().anyMatch(query -> query.contains("NEXTVAL")));
    }

    @Test
    void sequenceFallbackRejectsIncompleteOrNonIntegerMetadata() {
        for (String maximum : Arrays.asList(null, "1.5", "1E28", "1; DROP TABLE T")) {
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            TestSupport.setPrivateConnection(agent, objectSourceFallbackConnection(new ArrayList<>(), new ArrayList<>(), resultSet(
                new String[]{"MIN_VALUE", "MAX_VALUE", "INCREMENT_BY", "CYCLE_FLAG", "ORDER_FLAG", "CACHE_SIZE", "LAST_NUMBER"},
                new Object[][]{{"1", maximum, "1", "N", "N", "20", "40"}}
            )));
            Assertions.assertThrows(RuntimeException.class, () -> agent.getObjectSource("APP", "SEQ", "SEQUENCE"));
        }
    }

    @Test
    void rejectsUnsupportedObjectSourceTypesBeforeQuerying() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();

        IllegalArgumentException error = Assertions.assertThrows(
            IllegalArgumentException.class,
            () -> agent.getObjectSource("APP", "USERS", "TABLE")
        );

        Assertions.assertTrue(error.getMessage().contains("Unsupported object type: TABLE"), error.getMessage());
    }

    @Test
    void getColumnsIncludesDefaultAndCommentMetadata() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, columnResultSet(
            new Object[][]{
                {"DISPLAY_NAME", "VARCHAR2", "Y", null, null, 64, 64, "'anonymous'", "User's display name", 0}
            }
        )));

        List<ColumnInfo> columns = agent.getColumns("APP", "USERS");

        Assertions.assertEquals(1, columns.size());
        ColumnInfo column = columns.get(0);
        Assertions.assertEquals("DISPLAY_NAME", column.getName());
        Assertions.assertEquals("VARCHAR2(64)", column.getData_type());
        Assertions.assertTrue(column.getIs_nullable());
        Assertions.assertEquals("'anonymous'", column.getColumn_default());
        Assertions.assertFalse(column.getIs_primary_key());
        Assertions.assertEquals("User's display name", column.getComment());
        Assertions.assertEquals(64, column.getCharacter_maximum_length());
        Assertions.assertTrue(sql.get(0).contains("c.DATA_DEFAULT"), sql.get(0));
    }

    @Test
    void getColumnsPreservesCharacterUnitsAndNegativeScale() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, columnResultSet(new Object[][]{
            {"VB", "VARCHAR2", "Y", null, null, 8, 8, null, null, 0, "B"},
            {"VC", "VARCHAR2", "Y", null, null, 32, 8, null, null, 0, "C"},
            {"NC", "NVARCHAR2", "Y", null, null, 32, 8, null, null, 0, "C"},
            {"CB", "CHAR", "Y", null, null, 12, 4, null, null, 0, "B"},
            {"CC", "CHAR", "Y", null, null, 32, 8, null, null, 0, "C"},
            {"NR", "NUMBER", "Y", 10, -2, 22, 0, null, null, 0, null},
            {"NZ", "NUMBER", "Y", 10, 0, 22, 0, null, null, 0, null},
            {"NP", "NUMBER", "Y", 10, 2, 22, 0, null, null, 0, null},
            {"NU", "NUMBER", "Y", null, null, 22, 0, null, null, 0, null},
            {"VU", "VARCHAR2", "Y", null, null, 32, 8, null, null, 0, null}
        })));
        List<ColumnInfo> columns = agent.getColumns("APP", "USERS");
        Assertions.assertEquals(List.of("VARCHAR2(8 BYTE)", "VARCHAR2(8 CHAR)", "NVARCHAR2(8)", "CHAR(12 BYTE)", "CHAR(8 CHAR)", "NUMBER(10,-2)", "NUMBER(10)", "NUMBER(10,2)", "NUMBER", "VARCHAR2(8)"),
            columns.stream().map(ColumnInfo::getData_type).toList());
        Assertions.assertTrue(sql.get(0).contains("c.CHAR_USED"));
    }

    @Test
    void getColumnsResolvesTheCurrentSchemaWhenSchemaIsEmpty() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, currentSchemaColumnConnection(
            sql,
            params,
            resultSet(new String[]{"CURRENT_SCHEMA"}, new Object[][]{{"MixedOwner"}}),
            columnResultSet(new Object[][]{
                {"PARAM_VALUE", "VARCHAR2", "Y", null, null, 100, 100, null, null, 0}
            })
        ));

        List<ColumnInfo> columns = agent.getColumns("", "TBPARAM");

        Assertions.assertEquals(List.of("PARAM_VALUE"), columns.stream().map(ColumnInfo::getName).toList());
        Assertions.assertEquals(List.of("MixedOwner", "TBPARAM", "MixedOwner", "TBPARAM"), params);
        Assertions.assertTrue(sql.get(0).contains("SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')"), sql.get(0));
        Assertions.assertTrue(sql.get(1).contains("FROM ALL_TAB_COLUMNS"), sql.get(1));
    }

    @Test
    void tableDdlIncludesDefaultsAndOnlyNonBlankColumnComments() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(),
            resultSet(
                new String[]{"DDL"},
                new Object[][]{{"CREATE TABLE \"AUDIT_LOG\" (\"CREATED_AT\" TIMESTAMP DEFAULT SYSDATE NOT NULL, \"INTERNAL_NOTE\" VARCHAR2(100))"}}
            ),
            resultSet(
                new String[]{"INDEX_NAME"},
                new Object[][]{}
            ),
            resultSet(
                new String[]{"COMMENTS"},
                new Object[][]{{null}}
            ),
            columnResultSet(new Object[][]{
                {"CREATED_AT", "TIMESTAMP", "N", null, null, null, null, "SYSDATE", "Created timestamp", 0},
                {"INTERNAL_NOTE", "VARCHAR2", "Y", null, null, 100, 100, null, "   ", 0}
            }),
            resultSet(
                new String[]{"GRANTEE", "PRIVILEGE", "GRANTABLE"},
                new Object[][]{}
            ),
            resultSet(
                new String[]{"GRANTEE", "COLUMN_NAME", "PRIVILEGE", "GRANTABLE"},
                new Object[][]{}
            )
        ));

        String ddl = agent.getTableDdl("APP", "AUDIT_LOG");

        Assertions.assertTrue(ddl.contains("\"CREATED_AT\" TIMESTAMP DEFAULT SYSDATE NOT NULL"), ddl);
        Assertions.assertTrue(
            ddl.contains("COMMENT ON COLUMN \"APP\".\"AUDIT_LOG\".\"CREATED_AT\" IS 'Created timestamp';"),
            ddl
        );
        Assertions.assertTrue(ddl.contains("\"INTERNAL_NOTE\" VARCHAR2(100)"), ddl);
        Assertions.assertFalse(ddl.contains("\"INTERNAL_NOTE\" IS"), ddl);
        Assertions.assertFalse(ddl.contains("GRANT "), ddl);
    }

    @Test
    void tableDdlAppendsObjectGrantsFromDictionaryViews() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql,
            resultSet(
                new String[]{"DDL"},
                new Object[][]{{"CREATE TABLE \"USERS\" (\"ID\" NUMBER PRIMARY KEY, \"NAME\" VARCHAR2(100)) PARTITION BY RANGE(\"ID\") (PARTITION P1 VALUES LESS THAN(MAXVALUE))"}}
            ),
            resultSet(
                new String[]{"INDEX_NAME"},
                new Object[][]{}
            ),
            resultSet(
                new String[]{"COMMENTS"},
                new Object[][]{{null}}
            ),
            columnResultSet(new Object[][]{
                {"ID", "NUMBER", "N", 19, 0, null, null, null, null, 1},
                {"NAME", "VARCHAR2", "Y", null, null, 100, 100, null, null, 0}
            }),
            resultSet(
                new String[]{"GRANTEE", "PRIVILEGE", "GRANTABLE"},
                new Object[][]{
                    {"READER", "SELECT", "NO"},
                    {"READER", "INSERT", "NO"},
                    {"ADMIN", "SELECT", "YES"}
                }
            ),
            resultSet(
                new String[]{"GRANTEE", "COLUMN_NAME", "PRIVILEGE", "GRANTABLE"},
                new Object[][]{
                    {"ANALYST", "NAME", "UPDATE", "NO"}
                }
            )
        ));

        String ddl = agent.getTableDdl("APP", "USERS");

        Assertions.assertTrue(ddl.contains("CREATE TABLE \"APP\".\"USERS\""), ddl);
        Assertions.assertTrue(ddl.contains("GRANT SELECT, INSERT ON \"APP\".\"USERS\" TO \"READER\";"), ddl);
        Assertions.assertTrue(
            ddl.contains("GRANT SELECT ON \"APP\".\"USERS\" TO \"ADMIN\" WITH GRANT OPTION;"),
            ddl
        );
        Assertions.assertTrue(
            ddl.contains("GRANT UPDATE (\"NAME\") ON \"APP\".\"USERS\" TO \"ANALYST\";"),
            ddl
        );
        Assertions.assertTrue(
            sql.stream().anyMatch(statement -> statement.toUpperCase(Locale.ROOT).contains("FROM DBA_TAB_PRIVS")),
            String.valueOf(sql)
        );
        Assertions.assertTrue(
            sql.stream().anyMatch(statement -> statement.toUpperCase(Locale.ROOT).contains("FROM DBA_COL_PRIVS")),
            String.valueOf(sql)
        );
    }

    @Test
    void tableDdlFallsBackToAllTabPrivsWhenDbaViewUnavailable() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, dbaFallbackPrivilegeConnection(sql,
            resultSet(
                new String[]{"DDL"},
                new Object[][]{{"CREATE TABLE \"USERS\" (\"ID\" NUMBER PRIMARY KEY, \"NAME\" VARCHAR2(100)) PARTITION BY RANGE(\"ID\") (PARTITION P1 VALUES LESS THAN(MAXVALUE))"}}
            ),
            resultSet(
                new String[]{"INDEX_NAME"},
                new Object[][]{}
            ),
            resultSet(
                new String[]{"COMMENTS"},
                new Object[][]{{null}}
            ),
            columnResultSet(new Object[][]{
                {"ID", "NUMBER", "N", 19, 0, null, null, null, null, 1}
            }),
            resultSet(
                new String[]{"GRANTEE", "PRIVILEGE", "GRANTABLE"},
                new Object[][]{
                    {"READER", "SELECT", "NO"}
                }
            ),
            resultSet(
                new String[]{"GRANTEE", "COLUMN_NAME", "PRIVILEGE", "GRANTABLE"},
                new Object[][]{}
            )
        ));

        String ddl = agent.getTableDdl("APP", "USERS");

        Assertions.assertTrue(ddl.contains("GRANT SELECT ON \"APP\".\"USERS\" TO \"READER\";"), ddl);
        Assertions.assertTrue(
            sql.stream().anyMatch(statement -> statement.toUpperCase(Locale.ROOT).contains("FROM DBA_TAB_PRIVS")),
            String.valueOf(sql)
        );
        Assertions.assertTrue(
            sql.stream().anyMatch(statement -> statement.toUpperCase(Locale.ROOT).contains("FROM ALL_TAB_PRIVS")),
            String.valueOf(sql)
        );
        Assertions.assertTrue(
            sql.stream().anyMatch(statement -> statement.toUpperCase(Locale.ROOT).contains("FROM SYS.DBA_TAB_PRIVS")),
            String.valueOf(sql)
        );
    }

    @Test
    void tableDdlKeepsCreateTableWhenPrivilegeQueriesFail() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, privilegeFailingDdlConnection(sql,
            resultSet(
                new String[]{"DDL"},
                new Object[][]{{"CREATE TABLE \"USERS\" (\"ID\" NUMBER PRIMARY KEY, \"NAME\" VARCHAR2(100)) PARTITION BY RANGE(\"ID\") (PARTITION P1 VALUES LESS THAN(MAXVALUE))"}}
            ),
            resultSet(
                new String[]{"INDEX_NAME"},
                new Object[][]{}
            ),
            resultSet(
                new String[]{"COMMENTS"},
                new Object[][]{{null}}
            ),
            columnResultSet(new Object[][]{
                {"ID", "NUMBER", "N", 19, 0, null, null, null, null, 1}
            })
        ));

        String ddl = agent.getTableDdl("APP", "USERS");

        Assertions.assertTrue(ddl.contains("CREATE TABLE \"APP\".\"USERS\""), ddl);
        Assertions.assertFalse(ddl.contains("GRANT "), ddl);
        Assertions.assertTrue(
            sql.stream().anyMatch(statement -> statement.toUpperCase(Locale.ROOT).contains("FROM DBA_TAB_PRIVS")),
            String.valueOf(sql)
        );
    }

    @Test
    void tableDdlPreservesPartitionsAndNativeLocalIndexes() {
        var agent = new OceanBaseOracleAgent();
        String nativeTable = "CREATE TABLE \"T\" (\"ID\" NUMBER, CONSTRAINT \"CK\" CHECK (\"ID\" > 0)) "
            + "REPLICA_NUM = 1 PARTITION BY RANGE(\"ID\") (PARTITION P1 VALUES LESS THAN(MAXVALUE))";
        String nativeIndex = "CREATE INDEX \"APP\".\"IX\" ON \"APP\".\"T\"(\"ID\") LOCAL;";
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(),
            resultSet(new String[]{"DDL"}, new Object[][]{{nativeTable}}),
            resultSet(new String[]{"INDEX_NAME"}, new Object[][]{{"IX"}}),
            resultSet(new String[]{"DDL"}, new Object[][]{{nativeIndex}}),
            resultSet(new String[]{"COMMENTS"}, new Object[][]{{"Owner's table"}}),
            resultSet(new String[]{"COLUMN_NAME", "COMMENTS"}, new Object[][]{}),
            resultSet(new String[]{"GRANTEE", "PRIVILEGE", "GRANTABLE"}, new Object[][]{}),
            resultSet(new String[]{"GRANTEE", "COLUMN_NAME", "PRIVILEGE", "GRANTABLE"}, new Object[][]{})
        ));
        String ddl = agent.getTableDdl("APP", "T");
        Assertions.assertTrue(ddl.startsWith(nativeTable.replace("CREATE TABLE \"T\"", "CREATE TABLE \"APP\".\"T\"") + ";"), ddl);
        Assertions.assertTrue(ddl.contains(nativeIndex), ddl);
        Assertions.assertTrue(ddl.contains("COMMENT ON TABLE \"APP\".\"T\" IS 'Owner''s table';"), ddl);
    }

    @Test
    void emptyMetadataDdlFailsInsteadOfReturningAnIncompleteTable() {
        var agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(),
            resultSet(new String[]{"DDL"}, new Object[][]{{" "}})));
        Assertions.assertThrows(RuntimeException.class, () -> agent.getTableDdl("APP", "T"));
    }

    @Test
    void partitionsPreserveDictionaryOrderCompositeKeysAndNullHashBounds() {
        List<String> sql = new ArrayList<>();
        var agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql,
            resultSet(new String[]{"COLUMN_NAME"}, new Object[][]{{"ID"}, {"A\"B"}}),
            resultSet(new String[]{"NAME", "POSITION", "HIGH_VALUE", "PARTITION_TYPE"}, new Object[][]{
                {"P1", 1, "100, 'East'", "RANGE"}, {"PM", 2, "MAXVALUE, MAXVALUE", "RANGE"}}),
            resultSet(new String[]{"COLUMN_NAME"}, new Object[][]{{"REGION"}}),
            resultSet(new String[]{"NAME", "POSITION", "HIGH_VALUE", "PARTITION_TYPE"}, new Object[][]{
                {"S1", 1, null, "HASH"}})
        ));
        var partitions = agent.listPartitions("APP", "T");
        Assertions.assertEquals(List.of("P1", "PM"), partitions.stream().map(com.dbx.agent.PartitionInfo::name).toList());
        Assertions.assertEquals("\"ID\", \"A\"\"B\"", partitions.get(0).partition_key());
        Assertions.assertEquals("100, 'East'", partitions.get(0).value());
        var subpartitions = agent.listSubpartitions("APP", "T");
        Assertions.assertEquals("", subpartitions.get(0).value());
        Assertions.assertEquals("HASH", subpartitions.get(0).partition_type());
        Assertions.assertTrue(sql.get(0).contains("ORDER BY COLUMN_POSITION"));
        Assertions.assertTrue(sql.get(1).contains("WHERE p.TABLE_OWNER = ? AND p.TABLE_NAME = ?"));
        Assertions.assertTrue(sql.get(3).contains("ALL_TAB_SUBPARTITIONS"));
    }

    /**
     * Fake OceanBase session answering the two DBMS_OUTPUT calls the agent uses.
     * A statement appends the lines whose marker its SQL text contains, and
     * {@code DBMS_OUTPUT.GET_LINE} hands the buffer back one line at a time and
     * then reports {@code status = 1}, exactly like Oracle's buffer.
     */
    private static final class DbmsOutputSession {
        /** The statement that purges the buffer, as the agent writes it. */
        static final String CLEAR_SQL = "BEGIN DBMS_OUTPUT.DISABLE; DBMS_OUTPUT.ENABLE(1000000); END;";

        final List<String> executedSql = new ArrayList<>();
        /** Every {@code prepareCall} text, so the drain's own call can be asserted. */
        final List<String> preparedSql = new ArrayList<>();
        /** Lines scripted per statement, keyed by a marker inside its SQL text. */
        final Map<String, String> printedBySqlMarker = new java.util.LinkedHashMap<>();
        /** Lines already buffered, consumed by GET_LINE. */
        final List<String> buffer = new ArrayList<>();
        /** Lines the OUT buffer cannot hold: the read fails with ORA-06502. */
        final List<String> oversizeLines = new ArrayList<>();
        final List<Integer> networkTimeouts = new ArrayList<>();
        /** Statement text that must fail, after it has printed its lines. */
        String failOnMarker;
        boolean enableFails;
        int enableAttempts;
        int getLineCalls;
        int clearCalls;
        /** Lines the last batched fetch returned, as the real block's payload would. */
        List<String> currentBatch = new ArrayList<>();
        /** The line bound the drain passed as {@code :1}. */
        int lastBatchLimit;
        /** True while the last batch met a line the block cannot deliver. */
        boolean droppedBatch;
        /** True while the last batch stopped on the payload budget, not on an empty buffer. */
        boolean leftoverBatch;
        /** True when the last batch's read found the session buffer empty. */
        boolean bufferExhausted;
        /** Set when GET_LINE must report status 1 because a script disabled the buffer. */
        boolean bufferDisabled;

        Connection connection() {
            Statement statement = proxy(Statement.class, (method, args) -> {
                switch (method.getName()) {
                    case "execute":
                        String statementSql = String.valueOf(args[0]);
                        executedSql.add(statementSql);
                        if (CLEAR_SQL.equals(statementSql)) {
                            clearCalls += 1;
                            buffer.clear();
                        } else if (statementSql.contains("DBMS_OUTPUT.ENABLE")) {
                            enableAttempts += 1;
                            if (enableFails) {
                                throw new SQLException("DBMS_OUTPUT is not available", "42000", 1044);
                            }
                        } else {
                            for (Map.Entry<String, String> printed : printedBySqlMarker.entrySet()) {
                                if (statementSql.contains(printed.getKey())) {
                                    buffer.add(printed.getValue());
                                    break;
                                }
                            }
                            if (failOnMarker != null && statementSql.contains(failOnMarker)) {
                                throw new SQLException("ORA-00933: SQL command not properly ended", "42000", 933);
                            }
                        }
                        return false;
                    case "getUpdateCount":
                        return 7;
                    case "setQueryTimeout":
                    case "setMaxRows":
                    case "setFetchSize":
                    case "close":
                        return null;
                    default:
                        return defaultValue(method.getReturnType());
                }
            });
            CallableStatement call = proxy(CallableStatement.class, (method, args) -> {
                switch (method.getName()) {
                    case "registerOutParameter":
                    case "close":
                        return null;
                    case "setInt":
                        // :1 is the batch's line bound; the fake serves up to it.
                        if (((Number) args[0]).intValue() == 1) {
                            lastBatchLimit = ((Number) args[1]).intValue();
                        }
                        return null;
                    case "execute":
                        getLineCalls += 1;
                        currentBatch = new ArrayList<>();
                        droppedBatch = false;
                        leftoverBatch = false;
                        // The block reads up to :1 lines: it stops when the line
                        // bound is reached or the buffer reports itself empty, and
                        // whatever is left is reported through :5. The caller
                        // passes :1 one line past its own bound, which is what
                        // makes the truncation decision possible.
                        int lineBound = lastBatchLimit > 0 ? lastBatchLimit : Integer.MAX_VALUE;
                        int payloadBytes = 0;
                        if (!bufferDisabled) {
                            while (!buffer.isEmpty() && currentBatch.size() < lineBound) {
                                if (!currentBatch.isEmpty()
                                    && payloadBytes >= OceanBaseOracleAgent.DBMS_OUTPUT_BATCH_BYTES) {
                                    leftoverBatch = true;
                                    break;
                                }
                                String next = buffer.remove(0);
                                if (oversizeLines.contains(next)) {
                                    // A line the OUT register cannot hold is
                                    // dropped by the block and reported through :6.
                                    droppedBatch = true;
                                    continue;
                                }
                                currentBatch.add(next);
                                payloadBytes += next.length() + 1;
                            }
                            leftoverBatch = leftoverBatch || !buffer.isEmpty();
                        }
                        // The block discovers "the buffer is empty" on the read
                        // that follows the last line, which is what this call was:
                        // the fake only reports it when nothing is left.
                        bufferExhausted = buffer.isEmpty() || bufferDisabled;
                        return false;
                    case "getString":
                        if (((Number) args[0]).intValue() == 6) {
                            return droppedBatch
                                ? "1" + OceanBaseOracleAgent.DBMS_OUTPUT_DROP_SEPARATOR
                                : "";
                        }
                        StringBuilder payload = new StringBuilder();
                        for (String line : currentBatch) {
                            payload.append(line).append('\n');
                        }
                        return payload.toString();
                    case "getInt":
                        int parameter = ((Number) args[0]).intValue();
                        if (parameter == 4) {
                            // :4 is "the session buffer reported itself empty":
                            // Oracle reports that on the read AFTER the last line.
                            return bufferExhausted ? 1 : 0;
                        }
                        // :5 says a line was left because the payload budget or the
                        // line bound stopped the batch.
                        return leftoverBatch ? 1 : 0;
                    default:
                        return defaultValue(method.getReturnType());
                }
            });
            return proxy(Connection.class, (method, args) -> {
                switch (method.getName()) {
                    case "createStatement":
                        return statement;
                    case "prepareCall":
                        preparedSql.add(String.valueOf(args[0]));
                        return call;
                    case "getNetworkTimeout":
                        return 1_234;
                    case "setNetworkTimeout":
                        networkTimeouts.add(((Number) args[1]).intValue());
                        return null;
                    case "isClosed":
                        return false;
                    default:
                        return defaultValue(method.getReturnType());
                }
            });
        }
    }

    /**
     * Fake session answering the dictionary, privilege and user queries the
     * PL/SQL capability probe runs. Privilege lists model the rows of a
     * privilege view; a null list makes that view unreadable.
     */
    private static final class PlDebugProbeSession {
        final List<String> debugProcedures = new ArrayList<>();
        final List<String> outputProcedures = new ArrayList<>(List.of("ENABLE", "GET_LINE", "PUT_LINE"));
        /** Rows of SESSION_PRIVS; null makes the view fail. */
        List<String> sessionPrivileges = new ArrayList<>(List.of("CREATE SESSION", "DEBUG CONNECT SESSION"));
        /** Rows of USER_SYS_PRIVS; null makes the view fail. */
        List<String> userSysPrivileges = new ArrayList<>(List.of("CREATE SESSION", "DEBUG CONNECT SESSION"));
        String user = "APP_USER";

        static PlDebugProbeSession fullyDebugcapable() {
            PlDebugProbeSession session = new PlDebugProbeSession();
            session.debugProcedures.addAll(List.of(
                "INITIALIZE", "ATTACH_SESSION", "DEBUG_ON", "DEBUG_OFF",
                "SET_TIMEOUT_BEHAVIOUR", "SET_BREAKPOINT", "CONTINUE", "GET_VALUES"
            ));
            return session;
        }

        Connection connection() {
            return proxy(Connection.class, (method, args) -> {
                if ("prepareStatement".equals(method.getName())) {
                    return statement(String.valueOf(args[0]));
                }
                if ("isClosed".equals(method.getName())) {
                    return false;
                }
                return defaultValue(method.getReturnType());
            });
        }

        private PreparedStatement statement(String statementSql) {
            String[] bound = {null};
            return proxy(PreparedStatement.class, (method, args) -> {
                switch (method.getName()) {
                    case "setString":
                        bound[0] = String.valueOf(args[1]);
                        return null;
                    case "executeQuery":
                        return query(statementSql, bound[0]);
                    case "close":
                        return null;
                    default:
                        return defaultValue(method.getReturnType());
                }
            });
        }

        private ResultSet query(String statementSql, String boundValue) throws SQLException {
            String normalized = statementSql.toUpperCase(Locale.ROOT);
            if (normalized.contains("ALL_PROCEDURES")) {
                List<String> procedures = "DBMS_DEBUG".equalsIgnoreCase(boundValue)
                    ? debugProcedures
                    : outputProcedures;
                return resultSet(new String[]{"PROCEDURE_NAME"}, rowsOf(procedures));
            }
            if (normalized.contains("ALL_OBJECTS")) {
                return resultSet(new String[]{"COUNT(*)"}, new Object[][]{{0}});
            }
            if (normalized.contains("SESSION_PRIVS")) {
                return rowsOfPrivileges(sessionPrivileges);
            }
            if (normalized.contains("USER_SYS_PRIVS")) {
                return rowsOfPrivileges(userSysPrivileges);
            }
            if (normalized.contains("USER FROM DUAL")) {
                return resultSet(new String[]{"USER"}, new Object[][]{{user}});
            }
            throw new AssertionError("unexpected probe SQL: " + statementSql);
        }

        private static ResultSet rowsOfPrivileges(List<String> privileges) throws SQLException {
            if (privileges == null) {
                throw new SQLException("privilege view unavailable");
            }
            return resultSet(new String[]{"PRIVILEGE"}, rowsOf(privileges));
        }
    }

    private static Object[][] rowsOf(List<String> values) {
        Object[][] rows = new Object[values.size()][];
        for (int index = 0; index < values.size(); index++) {
            rows[index] = new Object[]{values.get(index)};
        }
        return rows;
    }

    private static ResultSet columnResultSet(Object[][] rows) {
        return resultSet(
            new String[]{
                "COLUMN_NAME",
                "DATA_TYPE",
                "NULLABLE",
                "DATA_PRECISION",
                "DATA_SCALE",
                "DATA_LENGTH",
                "CHAR_LENGTH",
                "DATA_DEFAULT",
                "COMMENTS",
                "IS_PK",
                "CHAR_USED"
            },
            java.util.Arrays.stream(rows).map(row -> java.util.Arrays.copyOf(row, 11)).toArray(Object[][]::new)
        );
    }

    private static Connection preparedConnection(List<String> sql, ResultSet... resultSets) {
        return preparedConnection(sql, null, resultSets);
    }

    private static Connection preparedConnection(List<String> sql, List<String> params, ResultSet... resultSets) {
        int[] resultSetIndex = {0};
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                int current = Math.min(resultSetIndex[0], resultSets.length - 1);
                resultSetIndex[0] += 1;
                return resultSets[current];
            }
            if ("setString".equals(method.getName())) {
                if (params != null) {
                    params.add(String.valueOf(args[1]));
                }
                return null;
            }
            if ("setInt".equals(method.getName()) || "close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection privilegeFailingDdlConnection(List<String> sql, ResultSet... resultSets) {
        int[] resultSetIndex = {0};
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                String statementSql = String.valueOf(args[0]);
                sql.add(statementSql);
                String normalized = statementSql.toUpperCase(Locale.ROOT);
                if (normalized.contains("DBA_TAB_PRIVS")
                    || normalized.contains("ALL_TAB_PRIVS")
                    || normalized.contains("DBA_COL_PRIVS")
                    || normalized.contains("ALL_COL_PRIVS")) {
                    PreparedStatement failing = proxy(PreparedStatement.class, (statementMethod, statementArgs) -> {
                        if ("executeQuery".equals(statementMethod.getName())) {
                            throw new SQLException("privilege view unavailable");
                        }
                        if ("setString".equals(statementMethod.getName())
                            || "setInt".equals(statementMethod.getName())
                            || "close".equals(statementMethod.getName())) {
                            return null;
                        }
                        return defaultValue(statementMethod.getReturnType());
                    });
                    return failing;
                }
                PreparedStatement statement = proxy(PreparedStatement.class, (statementMethod, statementArgs) -> {
                    if ("executeQuery".equals(statementMethod.getName())) {
                        int current = Math.min(resultSetIndex[0], resultSets.length - 1);
                        resultSetIndex[0] += 1;
                        return resultSets[current];
                    }
                    if ("setString".equals(statementMethod.getName())
                        || "setInt".equals(statementMethod.getName())
                        || "close".equals(statementMethod.getName())) {
                        return null;
                    }
                    return defaultValue(statementMethod.getReturnType());
                });
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection dbaFallbackPrivilegeConnection(List<String> sql, ResultSet... resultSets) {
        int[] resultSetIndex = {0};
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                String statementSql = String.valueOf(args[0]);
                sql.add(statementSql);
                String normalized = statementSql.toUpperCase(Locale.ROOT);
                if (normalized.contains("DBA_TAB_PRIVS") || normalized.contains("DBA_COL_PRIVS")) {
                    PreparedStatement failing = proxy(PreparedStatement.class, (statementMethod, statementArgs) -> {
                        if ("executeQuery".equals(statementMethod.getName())) {
                            throw new SQLException("DBA privilege view unavailable");
                        }
                        if ("setString".equals(statementMethod.getName())
                            || "setInt".equals(statementMethod.getName())
                            || "close".equals(statementMethod.getName())) {
                            return null;
                        }
                        return defaultValue(statementMethod.getReturnType());
                    });
                    return failing;
                }
                PreparedStatement statement = proxy(PreparedStatement.class, (statementMethod, statementArgs) -> {
                    if ("executeQuery".equals(statementMethod.getName())) {
                        int current = Math.min(resultSetIndex[0], resultSets.length - 1);
                        resultSetIndex[0] += 1;
                        return resultSets[current];
                    }
                    if ("setString".equals(statementMethod.getName())
                        || "setInt".equals(statementMethod.getName())
                        || "close".equals(statementMethod.getName())) {
                        return null;
                    }
                    return defaultValue(statementMethod.getReturnType());
                });
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection schemaConnection(List<String> sql, ResultSet resultSet) {
        Statement statement = proxy(Statement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return resultSet;
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection currentSchemaColumnConnection(List<String> sql, List<String> params, ResultSet currentSchema, ResultSet columns) {
        Statement schemaStatement = proxy(Statement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return currentSchema;
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        PreparedStatement columnStatement = proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                return columns;
            }
            if ("setString".equals(method.getName())) {
                params.add(String.valueOf(args[1]));
                return null;
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return schemaStatement;
            }
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return columnStatement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection objectSourceConnection(List<String> sql, List<String> params, ResultSet resultSet) {
        PreparedStatement statement = objectSourceStatement(params, resultSet, false);
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection objectSourceFallbackConnection(List<String> sql, List<String> params, ResultSet fallbackResultSet) {
        int[] statementIndex = {0};
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                boolean fail = statementIndex[0]++ == 0;
                return objectSourceStatement(params, fallbackResultSet, fail);
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static PreparedStatement objectSourceStatement(List<String> params, ResultSet resultSet, boolean fail) {
        return proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                if (fail) {
                    throw new SQLException("DBMS_METADATA is unavailable");
                }
                return resultSet;
            }
            if ("setString".equals(method.getName())) {
                params.add(String.valueOf(args[1]));
                return null;
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection executionConnection(List<String> sql) {
        return executionConnection(sql, new ArrayList<>(), List.of());
    }

    private static Connection transactionConnection(List<String> calls) {
        return transactionConnection(calls, new boolean[] {false});
    }

    private static Connection transactionConnection(List<String> calls, boolean[] failCommit) {
        boolean[] autoCommit = {true};
        return proxy(Connection.class, (method, args) -> {
            switch (method.getName()) {
                case "getAutoCommit":
                    return autoCommit[0];
                case "setAutoCommit":
                    autoCommit[0] = (Boolean) args[0];
                    calls.add("setAutoCommit:" + autoCommit[0]);
                    return null;
                case "commit":
                    calls.add("commit");
                    if (failCommit[0]) {
                        throw new SQLException("commit failed");
                    }
                    return null;
                case "rollback":
                    calls.add("rollback");
                    return null;
                case "isClosed":
                    return false;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Connection executionConnection(
        List<String> sql,
        List<Integer> queryTimeouts,
        List<SQLException> alterFailures
    ) {
        int[] alterFailureIndex = {0};
        Statement statement = proxy(Statement.class, (method, args) -> {
            if ("execute".equals(method.getName())) {
                String statementSql = String.valueOf(args[0]);
                sql.add(statementSql);
                if (statementSql.startsWith("ALTER SESSION") && alterFailureIndex[0] < alterFailures.size()) {
                    throw alterFailures.get(alterFailureIndex[0]++);
                }
                return false;
            }
            if ("getUpdateCount".equals(method.getName())) {
                return 0;
            }
            if ("setQueryTimeout".equals(method.getName())) {
                queryTimeouts.add(((Number) args[0]).intValue());
                return null;
            }
            if ("close".equals(method.getName()) || "setMaxRows".equals(method.getName())
                || "setFetchSize".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection queryConnection(ResultSet resultSet) {
        Statement statement = proxy(Statement.class, (method, args) -> {
            switch (method.getName()) {
                case "execute":
                    return !String.valueOf(args[0]).startsWith("ALTER SESSION");
                case "getResultSet":
                    return resultSet;
                case "getUpdateCount":
                    return 0;
                case "close":
                case "setMaxRows":
                case "setFetchSize":
                case "setQueryTimeout":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection auditTimingConnection(int auditRows, long returnedRows, boolean denied,
                                                    List<String> sql, List<String> parameters, List<Integer> maxRows) {
        ResultSet trace = resultSet(new String[]{"TRACE_ID"}, new Object[][]{{"trace-1"}});
        int[] auditIndex = {-1};
        ResultSet audit = proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next":
                    auditIndex[0]++;
                    return auditIndex[0] < auditRows;
                case "getLong":
                    return ((Number) args[0]).intValue() == 1 ? 370L : returnedRows;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
        Statement traceStatement = proxy(Statement.class, (method, args) -> {
            if ("setQueryTimeout".equals(method.getName())) Assertions.assertEquals(1, args[0]);
            if ("setMaxRows".equals(method.getName())) maxRows.add((Integer) args[0]);
            if ("executeQuery".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return trace;
            }
            return defaultValue(method.getReturnType());
        });
        PreparedStatement auditStatement = proxy(PreparedStatement.class, (method, args) -> {
            if ("setQueryTimeout".equals(method.getName())) Assertions.assertEquals(1, args[0]);
            if ("setMaxRows".equals(method.getName())) maxRows.add((Integer) args[0]);
            if ("setString".equals(method.getName())) parameters.add(String.valueOf(args[1]));
            if ("executeQuery".equals(method.getName())) {
                if (denied) throw new SQLException("audit access denied", "42000", 1044);
                return audit;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) return traceStatement;
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return auditStatement;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet blobResultSet() {
        String[] columns = {"PAYLOAD", "EMPTY_PAYLOAD", "DESCRIPTION"};
        int[] sqlTypes = {Types.BLOB, Types.BLOB, Types.VARCHAR};
        String[] typeNames = {"BLOB", "BLOB", "VARCHAR2"};
        int[] rowIndex = {-1};
        boolean[] wasNull = {false};
        ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (method, args) -> {
            switch (method.getName()) {
                case "getColumnCount":
                    return columns.length;
                case "getColumnLabel":
                    return columns[((Number) args[0]).intValue() - 1];
                case "getColumnType":
                    return sqlTypes[((Number) args[0]).intValue() - 1];
                case "getColumnTypeName":
                    return typeNames[((Number) args[0]).intValue() - 1];
                default:
                    return defaultValue(method.getReturnType());
            }
        });
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next":
                    rowIndex[0] += 1;
                    return rowIndex[0] == 0;
                case "getMetaData":
                    return metadata;
                case "getBytes":
                    int bytesColumn = ((Number) args[0]).intValue();
                    if (bytesColumn == 1) {
                        wasNull[0] = false;
                        return new byte[]{0x01, 0x2A, (byte) 0xFF};
                    }
                    if (bytesColumn == 2) {
                        wasNull[0] = true;
                        return null;
                    }
                    throw new AssertionError("Text columns should not be read with getBytes");
                case "getString":
                    int stringColumn = ((Number) args[0]).intValue();
                    if (stringColumn != 3) {
                        throw new SQLFeatureNotSupportedException("ORA_BLOB.getString() is unsupported");
                    }
                    wasNull[0] = false;
                    return "plain text";
                case "wasNull":
                    return wasNull[0];
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet resultSet(String[] columns, Object[][] rows) {
        int[] index = {-1};
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next":
                    index[0] += 1;
                    return index[0] < rows.length;
                case "getString":
                    Object value = columnValue(columns, rows[index[0]], args[0]);
                    return value == null ? null : String.valueOf(value);
                case "getObject":
                    return columnValue(columns, rows[index[0]], args[0]);
                case "getInt":
                    Object intValue = columnValue(columns, rows[index[0]], args[0]);
                    if (intValue instanceof Number) {
                        return ((Number) intValue).intValue();
                    }
                    if (intValue == null) {
                        return 0;
                    }
                    return Integer.parseInt(String.valueOf(intValue));
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Object columnValue(String[] columns, Object[] row, Object key) {
        if (key instanceof Number) {
            return row[((Number) key).intValue() - 1];
        }
        for (int i = 0; i < columns.length; i++) {
            if (columns[i].equalsIgnoreCase(String.valueOf(key))) {
                return row[i];
            }
        }
        return null;
    }

    private static CompletionAssistantRequest completionRequest(
        String schema,
        String parentSchema,
        String mask,
        boolean globalSearch
    ) {
        CompletionAssistantRequest request = new CompletionAssistantRequest();
        setField(request, "database", "OBORCL");
        setField(request, "schema", schema);
        setField(request, "parent_schema", parentSchema);
        setField(request, "mask", mask);
        setField(request, "global_search", globalSearch);
        setField(request, "max_results", 20);
        setField(request, "object_kinds", List.of(CompletionAssistantObjectKind.TABLE, CompletionAssistantObjectKind.VIEW));
        return request;
    }

    private static void setField(Object target, String name, Object value) {
        try {
            var field = target.getClass().getDeclaredField(name);
            field.setAccessible(true);
            field.set(target, value);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    private static Object privateField(Object target, String name) throws ReflectiveOperationException {
        var field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                return handler.handle(method, args == null ? new Object[0] : args);
            }
        };
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == Boolean.TYPE) return false;
        if (type == Byte.TYPE) return (byte) 0;
        if (type == Short.TYPE) return (short) 0;
        if (type == Integer.TYPE) return 0;
        if (type == Long.TYPE) return 0L;
        if (type == Float.TYPE) return 0f;
        if (type == Double.TYPE) return 0d;
        if (type == Character.TYPE) return (char) 0;
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}













