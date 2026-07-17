package com.dbx.agent.sundb;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;

class SundbAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new SundbAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL sample_proc()";
    }
}
