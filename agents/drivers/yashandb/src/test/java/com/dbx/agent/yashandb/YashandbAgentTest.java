package com.dbx.agent.yashandb;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import java.util.Collections;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class YashandbAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new YashandbAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SELECT 1 FROM DUAL";
    }

    @Test
    void declaresYashandbJdbcProfile() {
        JdbcAgentProfile profile = YashandbAgent.YASHANDB_PROFILE;

        Assertions.assertEquals("com.yashandb.jdbc.Driver", profile.getDriverClass());
        Assertions.assertEquals("jdbc:yasdb://{host}:{port}/{database}", profile.getUrlTemplate());
        Assertions.assertTrue(profile.getSkipExecutionContext());
        Assertions.assertEquals(Collections.emptySet(), profile.getExcludedSchemas());
    }
}
