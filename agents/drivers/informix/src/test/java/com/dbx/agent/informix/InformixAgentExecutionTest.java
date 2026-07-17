package com.dbx.agent.informix;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;

class InformixAgentExecutionTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new InformixAgent();
    }

    @Override
    protected String resultSetSql() {
        return "EXECUTE PROCEDURE sample_proc()";
    }
}
