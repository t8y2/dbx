package com.dbx.agent.test;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import org.junit.jupiter.api.Test;

import java.util.Collections;

import static org.junit.jupiter.api.Assertions.assertEquals;

public abstract class JdbcFakeExecutionBehaviorTest {
    protected abstract DatabaseAgent createAgent();

    protected abstract String resultSetSql();

    @Test
    protected void executesNonSelectStatementsThatReturnResultSets() {
        DatabaseAgent agent = createAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        QueryResult result = agent.executeQuery(resultSetSql(), null, new ExecuteQueryOptions());

        assertEquals(Collections.singletonList("VALUE"), result.getColumns());
        assertEquals(Collections.singletonList(Collections.singletonList("row-value")), result.getRows());
        assertEquals(asList("setMaxRows:10001", "execute"), JdbcAgentFake.calls);
    }

    @Test
    protected void appliesExecutionRowAndFetchLimitsToJdbcStatements() {
        DatabaseAgent agent = createAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        QueryResult result = agent.executeQuery(resultSetSql(), null, new ExecuteQueryOptions(1, 25));

        assertEquals(Collections.singletonList(Collections.singletonList("row-value")), result.getRows());
        assertEquals(asList("setMaxRows:2", "setFetchSize:25", "execute"), JdbcAgentFake.calls);
    }

    @Test
    protected void pagedQueryExecutionPassesCallerFetchSizeToStatement() {
        DatabaseAgent agent = createAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        agent.executeQueryPage(resultSetSql(), null, new QueryPageOptions(100, 500, 1000));

        assertEquals(asList("setFetchSize:500", "execute"), JdbcAgentFake.calls);
    }

    @Test
    protected void tableReadPassesCallerFetchSizeToStatement() {
        DatabaseAgent agent = createAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        agent.startTableRead(resultSetSql(), null, new QueryPageOptions(100, 500, 1000));

        assertEquals(asList("setFetchSize:500", "execute"), JdbcAgentFake.calls);
    }

    protected static java.util.List<String> asList(String first, String second) {
        return java.util.Arrays.asList(first, second);
    }

    protected static java.util.List<String> asList(String first, String second, String third) {
        return java.util.Arrays.asList(first, second, third);
    }
}
