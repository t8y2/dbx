package com.dbx.agent.gbase8c;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class Gbase8cAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new Gbase8cAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL sample_proc()";
    }

    @Test
    void buildsTheVendorJdbcUrlFromTheConnectionFields() {
        // 厂商驱动只认 jdbc:gbase8c:// 与 com.gbase8c.Driver（实测 jdbc:postgresql:// 会被
        // 拒绝、jar 内也没有 Maven 坐标），所以 URL 模板与驱动类是这套集成的对外契约。
        ConnectParams params = new ConnectParams("10.1.2.3", 5432, "warehouse", "gbase", "secret", "", "", false);

        Assertions.assertEquals("jdbc:gbase8c://10.1.2.3:5432/warehouse", Gbase8cAgent.GBASE8C_PROFILE.buildUrl(params));
        Assertions.assertEquals("com.gbase8c.Driver", Gbase8cAgent.GBASE8C_PROFILE.getDriverClass());
    }
}
