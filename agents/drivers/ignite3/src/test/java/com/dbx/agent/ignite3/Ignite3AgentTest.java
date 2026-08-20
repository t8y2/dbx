package com.dbx.agent.ignite3;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;

class Ignite3AgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new Ignite3Agent();
    }

    @Override
    protected String resultSetSql() {
        return "SELECT 1";
    }
}
