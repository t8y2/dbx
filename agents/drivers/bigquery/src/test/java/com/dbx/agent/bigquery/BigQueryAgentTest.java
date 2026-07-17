package com.dbx.agent.bigquery;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;

class BigQueryAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new BigQueryAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL dataset.proc()";
    }
}
