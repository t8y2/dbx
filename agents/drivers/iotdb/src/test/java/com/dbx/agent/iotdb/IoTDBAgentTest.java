package com.dbx.agent.iotdb;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class IoTDBAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new IoTDBAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SELECT * FROM sample_table";
    }

    @Test
    void buildsOfficialJdbcUrl() {
        ConnectParams params = new ConnectParams();
        params.setHost("iotdb.example.com");
        params.setPort(6667);
        params.setUrl_params("sql_dialect=table&useSSL=false");

        Assertions.assertEquals(
            "jdbc:iotdb://iotdb.example.com:6667/?sql_dialect=table&useSSL=false",
            IoTDBAgent.IOTDB_PROFILE.buildUrl(params)
        );
    }
}
