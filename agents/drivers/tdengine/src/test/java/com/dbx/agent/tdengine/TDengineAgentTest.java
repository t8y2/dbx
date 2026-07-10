package com.dbx.agent.tdengine;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.test.TestSupport;
import com.dbx.agent.test.JdbcAgentFake;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class TDengineAgentExecutionTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new TDengineAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SHOW DATABASES";
    }
}

class TDengineAgentMetadataTest {
    @Test
    void buildsWebsocketJdbcUrlWithDefaultPortAndDatabase() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("127.0.0.1", 0, "meters", "root", "taosdata", "", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-WS://127.0.0.1:6041/meters", url);
    }

    @Test
    void preservesCustomWebsocketPortAndUrlParams() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("td.local", 6042, "", "", "", "timezone=UTC&charset=UTF-8", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-WS://td.local:6042/?timezone=UTC&charset=UTF-8", url);
    }

    @Test
    void supportsRestTransportViaCompatibilityUrlParam() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("127.0.0.1", 0, "testdb", "", "", "dbx.transport=rest&charset=UTF-8", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-RS://127.0.0.1:6041/testdb?charset=UTF-8", url);
    }

    @Test
    void stripsTransportControlParamFromJdbcQuery() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("127.0.0.1", 6041, "", "", "", "transport=ws&timezone=UTC", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-WS://127.0.0.1:6041/?timezone=UTC", url);
    }

    @Test
    void usesTdengineMetadataStatements() {
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listDatabases();
        agent.listTables("power");
        agent.getColumns("power", "meters");

        Assertions.assertEquals(
            Arrays.asList(
                "SHOW DATABASES",
                "SHOW `power`.STABLES",
                "SHOW `power`.TABLES",
                "DESCRIBE `power`.`meters`"
            ),
            JdbcMetadataSqlFake.statements
        );
    }

    @Test
    void marksTimestampAndCompositeKeyDescribeColumnsAsPrimaryKeys() throws Exception {
        ResultSet resultSet = describeResultSet(new String[][] {
            {"ts", "TIMESTAMP", "8", ""},
            {"seq", "INT", "4", "COMPOSITE KEY"},
            {"voltage", "FLOAT", "4", ""},
            {"site", "VARCHAR(32)", "32", "TAG"}
        });

        List<ColumnInfo> columns = TDengineAgent.readDescribeColumns(resultSet);

        Assertions.assertTrue(columns.get(0).getIs_primary_key());
        Assertions.assertFalse(columns.get(0).getIs_nullable());
        Assertions.assertTrue(columns.get(1).getIs_primary_key());
        Assertions.assertFalse(columns.get(1).getIs_nullable());
        Assertions.assertFalse(columns.get(2).getIs_primary_key());
        Assertions.assertFalse(columns.get(3).getIs_primary_key());
        Assertions.assertEquals("TAG", columns.get(3).getExtra());
    }

    @Test
    void doesNotExposeDatabasesAsSchemas() {
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        Assertions.assertTrue(agent.listSchemas().isEmpty());
        Assertions.assertTrue(JdbcMetadataSqlFake.statements.isEmpty());
    }

    @Test
    void setsDatabaseBeforeExecutionWhenSchemaIsProvided() {
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        agent.executeQuery("SELECT 1", "power", new ExecuteQueryOptions());

        // JdbcSchemaSwitcher executes the USE statement (recorded as "execute")
        // before the query runs, so the database is switched prior to execution.
        Assertions.assertEquals(
            Arrays.asList("execute", "setMaxRows:10001", "execute"),
            JdbcAgentFake.calls
        );
    }

    @Test
    void decodesTdengineByteArrayTextValues() {
        Assertions.assertEquals(
            "d1001",
            TDengineAgent.decodeTdengineValue("d1001".getBytes(StandardCharsets.UTF_8))
        );
    }

    @Test
    void formatsTdengineTimestampsAsSqlLiterals() {
        Assertions.assertEquals(
            "2026-05-16 09:35:58.123",
            TDengineAgent.decodeTdengineValue(Timestamp.valueOf("2026-05-16 09:35:58.123"))
        );
    }

    @Test
    void unknownTransportValueDefaultsToWebsocketAndKeepsOtherParams() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("127.0.0.1", 6041, "", "", "", "transport=foo&timezone=UTC", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-WS://127.0.0.1:6041/?timezone=UTC", url);
    }

    @Test
    void sanitizeConnectionStringStripsTransportControlParams() {
        String sanitized = TDengineJdbcUrl.sanitizeConnectionString(
            "jdbc:TAOS-WS://127.0.0.1:6041/db?dbx.transport=rest&charset=UTF-8&transport=ws"
        );

        Assertions.assertEquals("jdbc:TAOS-WS://127.0.0.1:6041/db?charset=UTF-8", sanitized);
    }

    @Test
    void sanitizeConnectionStringKeepsFragmentAndNonControlParams() {
        String sanitized = TDengineJdbcUrl.sanitizeConnectionString(
            "jdbc:TAOS-RS://127.0.0.1:6041/db?timezone=UTC&dbx.transport=rest#anchor"
        );

        Assertions.assertEquals("jdbc:TAOS-RS://127.0.0.1:6041/db?timezone=UTC#anchor", sanitized);
    }

    private static ResultSet describeResultSet(String[][] rows) {
        int[] rowIndex = {-1};
        return (ResultSet) Proxy.newProxyInstance(
            ResultSet.class.getClassLoader(),
            new Class<?>[] {ResultSet.class},
            (proxy, method, args) -> {
                if ("next".equals(method.getName())) {
                    rowIndex[0] += 1;
                    return rowIndex[0] < rows.length;
                }
                if ("getString".equals(method.getName())) {
                    return rows[rowIndex[0]][((Integer) args[0]) - 1];
                }
                if ("close".equals(method.getName())) {
                    return null;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
    }
}
