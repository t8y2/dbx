package com.dbx.agent.sundb;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import java.lang.reflect.Method;
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
    void usesTheSunDbJdbcDriverClass() throws Exception {
        Method driverClass = SundbAgent.class.getDeclaredMethod("driverClass");
        driverClass.setAccessible(true);

        Assertions.assertEquals(
            "csii.sundb.jdbc.SundbDriver",
            driverClass.invoke(new SundbAgent())
        );
    }
}
