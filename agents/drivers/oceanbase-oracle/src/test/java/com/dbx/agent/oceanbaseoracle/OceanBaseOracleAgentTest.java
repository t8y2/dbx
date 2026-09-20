package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.AgentProtocol;
import com.dbx.agent.ColumnInfo;
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

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
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

    @Test
    void readsServerExecutionOnlyFromOneMatchingAuditRow() {
        List<String> statements = new ArrayList<>();
        List<String> parameters = new ArrayList<>();
        List<Integer> maxRows = new ArrayList<>();
        Assertions.assertEquals(370L, OceanBaseOracleAgent.serverExecuteTimeUs(
            auditTimingConnection(1, 500, false, statements, parameters, maxRows), 500, 1001
        ));
        Assertions.assertEquals(List.of(1001, 1001), maxRows,
            "trace and audit statements must preserve the target statement's session row limit");
        Assertions.assertEquals(List.of("trace-1"), parameters);
        Assertions.assertTrue(statements.get(1).contains("IS_INNER_SQL = 0 AND IS_EXECUTOR_RPC = 0"));
        Assertions.assertEquals(null, OceanBaseOracleAgent.serverExecuteTimeUs(auditTimingConnection(0, 500, false, new ArrayList<>(), new ArrayList<>(), new ArrayList<>()), 500, 0));
        Assertions.assertEquals(null, OceanBaseOracleAgent.serverExecuteTimeUs(auditTimingConnection(2, 500, false, new ArrayList<>(), new ArrayList<>(), new ArrayList<>()), 500, 0));
        Assertions.assertEquals(null, OceanBaseOracleAgent.serverExecuteTimeUs(auditTimingConnection(1, 1, false, new ArrayList<>(), new ArrayList<>(), new ArrayList<>()), 500, 0));
        Assertions.assertEquals(null, OceanBaseOracleAgent.serverExecuteTimeUs(auditTimingConnection(1, 500, true, new ArrayList<>(), new ArrayList<>(), new ArrayList<>()), 500, 0));
    }


    @Test
    void doesNotAuditAnOpenCursorAfterAnotherSessionMethodCanReplaceItsTrace() {
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

        agent.beforeAgentMethod(AgentProtocol.METHOD_LIST_TABLES, null);
        QueryPageResult last = agent.fetchQueryPage(first.getSession_id(), 1);
        Assertions.assertFalse(last.getHas_more());
        Assertions.assertNull(last.getServer_execute_time_us());
        Assertions.assertEquals(2, statementsCreated[0], "no LAST_TRACE_ID query may run for an invalidated cursor");
    }

    @Test
    void treatsZeroQueryTimeoutAsUnlimitedForOceanBaseSession() {
        List<String> sql = new ArrayList<>();
        List<Integer> queryTimeouts = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        Connection connection = executionConnection(sql, queryTimeouts, List.of());
        TestSupport.setPrivateConnection(agent, connection);

        agent.executeQuery("INSERT INTO ITEMS (ID) VALUES (1)", null, new ExecuteQueryOptions(10, null, 0));

        Assertions.assertEquals(List.of(
            "ALTER SESSION SET ob_query_timeout = 3216672000000000",
            "INSERT INTO ITEMS (ID) VALUES (1)"
        ), sql);
        Assertions.assertEquals(List.of(), queryTimeouts);
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

        Assertions.assertEquals(List.of(
            "ALTER SESSION SET ob_query_timeout = 12000000",
            "SELECT 1 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 13000000",
            "SELECT 2 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 14000000",
            "SELECT 3 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 3216672000000000"
        ), sql);
        Assertions.assertEquals(List.of(12, 13, 14), queryTimeouts);
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

        Assertions.assertEquals(List.of(
            "ALTER SESSION SET ob_query_timeout = 12000000",
            "SELECT 1 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 13000000",
            "SELECT 2 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 14000000",
            "SELECT 3 FROM DUAL"
        ), sql);
        Assertions.assertEquals(List.of(12, 13, 14), queryTimeouts);
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
        Assertions.assertEquals(List.of("ALTER SESSION SET ob_query_timeout = 12000000"), sql);
        Assertions.assertTrue(queryTimeouts.isEmpty());
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
            new String[]{"OBJECT_NAME", "OBJECT_TYPE"},
            new Object[][]{
                {"FORMAT_USER", "FUNCTION"}
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
    void fallsBackToAllSourceForOracleRoutineAndPackageTypes() {
        for (String[] object : new String[][]{
            {"PROCEDURE", "PROCEDURE"},
            {"FUNCTION", "FUNCTION"},
            {"PACKAGE", "PACKAGE"},
            {"PACKAGE_BODY", "PACKAGE BODY"}
        }) {
            List<String> sql = new ArrayList<>();
            List<String> params = new ArrayList<>();
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            TestSupport.setPrivateConnection(agent, objectSourceFallbackConnection(
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
                List.of(object[0], "MixedRoutine", "MixedOwner", "MixedOwner", "MixedRoutine", object[1]),
                params
            );
            Assertions.assertTrue(sql.get(1).contains("ALL_SOURCE"), sql.get(1));
            Assertions.assertTrue(sql.get(1).contains("ORDER BY LINE"), sql.get(1));
        }
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
                "IS_PK"
            },
            rows
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
