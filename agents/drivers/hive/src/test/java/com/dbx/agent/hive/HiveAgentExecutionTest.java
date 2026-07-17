package com.dbx.agent.hive;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryResult;
import com.dbx.agent.test.JdbcAgentFake;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.junit.jupiter.api.Assertions.assertEquals;

class HiveAgentExecutionTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new HiveAgent();
    }

    @Override
    protected String resultSetSql() {
        return "MSCK REPAIR TABLE sample";
    }

    // Override: HiveAgent.executeQuery forces fetchSize=50 to keep Thrift
    // FetchResults batches small (prevents "Error retrieving next row" on
    // tables with large binary/struct columns).
    @Override
    @Test
    protected void executesNonSelectStatementsThatReturnResultSets() {
        DatabaseAgent agent = createAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        QueryResult result = agent.executeQuery(resultSetSql(), null, new ExecuteQueryOptions());

        assertEquals(Collections.singletonList("VALUE"), result.getColumns());
        assertEquals(Collections.singletonList(Collections.singletonList("row-value")), result.getRows());
        assertEquals(Arrays.asList("setMaxRows:10001", "setFetchSize:50", "execute"), JdbcAgentFake.calls);
    }

    @Override
    @Test
    protected void appliesExecutionRowAndFetchLimitsToJdbcStatements() {
        DatabaseAgent agent = createAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        QueryResult result = agent.executeQuery(resultSetSql(), null, new ExecuteQueryOptions(1, 25));

        assertEquals(Collections.singletonList(Collections.singletonList("row-value")), result.getRows());
        assertEquals(Arrays.asList("setMaxRows:2", "setFetchSize:50", "execute"), JdbcAgentFake.calls);
    }

    @Override
    @Test
    protected void pagedQueryExecutionPassesCallerFetchSizeToStatement() {
        DatabaseAgent agent = createAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        agent.executeQueryPage(resultSetSql(), null, new QueryPageOptions(100, 500, 1000));

        assertEquals(Arrays.asList("setFetchSize:50", "execute"), JdbcAgentFake.calls);
    }

    @Override
    @Test
    protected void tableReadPassesCallerFetchSizeToStatement() {
        DatabaseAgent agent = createAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        agent.startTableRead(resultSetSql(), null, new QueryPageOptions(100, 500, 1000));

        assertEquals(Arrays.asList("setFetchSize:50", "execute"), JdbcAgentFake.calls);
    }
}
