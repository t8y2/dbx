package com.dbx.agent.highgo;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.Arrays;

class HighgoAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new HighgoAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL sample_proc()";
    }

    @Test
    void declaresHighgoPostgresLikeProfile() {
        HighgoAgent agent = new HighgoAgent();

        Assertions.assertEquals("com.highgo.jdbc.Driver", agent.getProfile().getDriverClass());
        Assertions.assertEquals("jdbc:highgo://{host}:{port}/{database}", agent.getProfile().getUrlTemplate());
    }

    @Test
    void readsViewSourceWithQuotedRegclassParameter() {
        HighgoAgent agent = new HighgoAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.getObjectSource("bad\"schema", "view's name", "VIEW");

        Assertions.assertEquals(
            Arrays.asList(
                "SELECT pg_catalog.pg_get_viewdef(pg_catalog.to_regclass(?), true)",
                "param:1=\"bad\"\"schema\".\"view's name\""
            ),
            JdbcMetadataSqlFake.statements
        );
    }
}
