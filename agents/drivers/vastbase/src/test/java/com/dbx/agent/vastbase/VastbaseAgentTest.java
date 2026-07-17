package com.dbx.agent.vastbase;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class VastbaseAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new VastbaseAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL sample_proc()";
    }

    @Test
    void declaresVastbasePostgresLikeProfile() {
        VastbaseAgent agent = new VastbaseAgent();

        Assertions.assertEquals("cn.com.vastbase.Driver", agent.getProfile().getDriverClass());
        Assertions.assertEquals("jdbc:vastbase://{host}:{port}/{database}", agent.getProfile().getUrlTemplate());
    }
}
