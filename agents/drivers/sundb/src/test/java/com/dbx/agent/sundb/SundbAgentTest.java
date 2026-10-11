package com.dbx.agent.sundb;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class SundbAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new SundbAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL sample_proc()";
    }

    @Test
    void usesTheSunDbJdbcDriverClass() {
        Assertions.assertEquals("csii.sundb.jdbc.SundbDriver", SundbAgent.SUNDB_PROFILE.getDriverClass());
        Assertions.assertEquals(
            "csii.sundb.jdbc.SundbDriver",
            ((SundbAgent) createAgent()).getProfile().getDriverClass()
        );
    }
}
