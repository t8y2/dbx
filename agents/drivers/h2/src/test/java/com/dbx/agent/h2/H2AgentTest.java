package com.dbx.agent.h2;

import com.dbx.agent.BaseDatabaseAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.JdbcExecutionBehaviorTest;
import com.dbx.agent.test.JdbcMetadataBehaviorTest;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class H2AgentMigrationTest {
    @Test
    void agentExtendsBaseDatabaseAgent() {
        Assertions.assertTrue(BaseDatabaseAgent.class.isAssignableFrom(H2Agent.class));
    }

    @Test
    void buildUrlUsesExplicitConnectionString() {
        ConnectParams params = new ConnectParams(
            "127.0.0.1",
            9092,
            "test",
            "sa",
            "",
            "",
            "jdbc:h2:file:/tmp/dbx-h2-test;AUTO_SERVER=TRUE",
            false
        );

        Assertions.assertEquals("jdbc:h2:file:/tmp/dbx-h2-test;AUTO_SERVER=TRUE", H2Agent.buildUrl(params));
    }

    @Test
    void buildUrlKeepsTcpModeWhenNoConnectionString() {
        ConnectParams params = new ConnectParams("127.0.0.1", 9092, "test", "sa", "", "", "", false);

        Assertions.assertEquals("jdbc:h2:tcp://127.0.0.1:9092/test", H2Agent.buildUrl(params));
    }

    @Test
    @SuppressWarnings("unchecked")
    void exposesDatabaseMetadataForTestAndConnectedConnection() {
        ConnectParams params = new ConnectParams("", 0, "mem:dbx-agent-info;DB_CLOSE_DELAY=-1", "sa", "", "", "", false);
        H2Agent agent = new H2Agent();

        Map<String, Object> result = agent.testConnectionWithInfo(params);
        Assertions.assertEquals(true, result.get("ok"));
        Map<String, String> testedInfo = (Map<String, String>) result.get("databaseInfo");
        assertH2DatabaseInfo(testedInfo);

        agent.connect(params);
        try {
            assertH2DatabaseInfo(agent.getDatabaseInfo());
        } finally {
            agent.disconnect();
        }
    }

    private static void assertH2DatabaseInfo(Map<String, String> info) {
        Assertions.assertEquals("H2", info.get("productName"));
        Assertions.assertFalse(info.get("productVersion").isEmpty());
        Assertions.assertFalse(info.get("driverName").isEmpty());
        Assertions.assertFalse(info.get("driverVersion").isEmpty());
        Assertions.assertFalse(info.get("jdbcVersion").isEmpty());
        Assertions.assertEquals("upper", info.get("unquotedIdentifierCase"));
        Assertions.assertFalse(info.containsKey("quotedIdentifierCase"));
    }
}

class H2ExecutionBehaviorTest extends JdbcExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createConnectedAgent(String databaseName) {
        return H2AgentTestSupport.createH2Agent(databaseName);
    }

    @Override
    protected String resultSetSql() {
        return "CALL 42";
    }

    @Override
    protected List<String> expectedResultSetColumns() {
        return List.of("42");
    }

    @Override
    protected List<List<Object>> expectedResultSetRows() {
        return List.of(List.<Object>of(42));
    }

    @Override
    protected String rowsSql(int rowCount) {
        return "SELECT X FROM SYSTEM_RANGE(1, " + rowCount + ")";
    }

    @Test
    void displaysJsonColumnsAsText() {
        withAgent("dbx-agent-h2-json", agent -> {
            agent.executeQuery(
                "CREATE TABLE EVENTS (ID INT PRIMARY KEY, ACTION_PARAMS JSON, RAW_BYTES VARBINARY)",
                null,
                new ExecuteQueryOptions()
            );
            agent.executeQuery(
                "INSERT INTO EVENTS VALUES (1, JSON '[]', X'5B5D'), (2, JSON '[{\"type\":\"ACCESS_CONTROL\"}]', X'00FF')",
                null,
                new ExecuteQueryOptions()
            );

            QueryResult result = agent.executeQuery(
                "SELECT ACTION_PARAMS, RAW_BYTES FROM EVENTS ORDER BY ID",
                null,
                new ExecuteQueryOptions()
            );

            Assertions.assertEquals(
                List.of(
                    List.of("[]", "0x5b5d"),
                    List.of("[{\"type\":\"ACCESS_CONTROL\"}]", "0x00ff")
                ),
                result.getRows()
            );
        });
    }
}

class H2MetadataBehaviorTest extends JdbcMetadataBehaviorTest {
    @Override
    protected DatabaseAgent createConnectedAgent(String databaseName) {
        return H2AgentTestSupport.createH2Agent(databaseName);
    }

    @Override
    protected List<String> metadataFixtureSql() {
        return List.of(
            "CREATE TABLE BETA_TABLE (ID INT PRIMARY KEY)",
            "CREATE TABLE ALPHA_TABLE (ID INT PRIMARY KEY)",
            "CREATE TABLE COLUMN_ORDER_SAMPLE (ID INT PRIMARY KEY, NAME VARCHAR(64), CREATED_AT TIMESTAMP)"
        );
    }

    @Override
    protected String metadataSchema() {
        return "PUBLIC";
    }

    @Override
    protected List<String> expectedTablesInOrder() {
        return List.of("ALPHA_TABLE", "BETA_TABLE", "COLUMN_ORDER_SAMPLE");
    }

    @Override
    protected String metadataColumnsTable() {
        return "COLUMN_ORDER_SAMPLE";
    }

    @Override
    protected List<String> expectedColumnsInOrder() {
        return List.of("ID", "NAME", "CREATED_AT");
    }

    @Test
    void constrainedTableMetadataFiltersTypesAndPages() {
        withAgent("dbx-agent-h2-constrained-metadata", agent -> {
            for (String sql : metadataFixtureSql()) {
                agent.executeQuery(sql, null, new ExecuteQueryOptions());
            }

            List<TableInfo> tables = agent.listTables(
                metadataSchema(),
                new MetadataListConstraints("table", 1, 1, List.of("TABLE"))
            );

            Assertions.assertEquals(1, tables.size());
            Assertions.assertEquals("BETA_TABLE", tables.get(0).getName());
        });
    }
}

final class H2AgentTestSupport {
    private H2AgentTestSupport() {
    }

    static DatabaseAgent createH2Agent(String databaseName) {
        H2Agent agent = new H2Agent();
        agent.connect(new ConnectParams("", 0, "mem:" + databaseName + ";DB_CLOSE_DELAY=-1", "", "", "", "", false));
        return agent;
    }
}
