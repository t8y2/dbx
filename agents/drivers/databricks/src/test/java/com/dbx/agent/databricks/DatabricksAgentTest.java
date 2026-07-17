package com.dbx.agent.databricks;

import com.dbx.agent.ConnectParams;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DatabricksAgentTest {
    @Test
    void buildsHttpPathUrl() {
        ConnectParams params = new ConnectParams();
        params.setHost("adb-123.azuredatabricks.net");
        params.setPort(443);
        params.setDatabase("default");
        params.setUrl_params("httpPath=/sql/1.0/warehouses/abc;AuthMech=3");

        assertEquals(
            "jdbc:databricks://adb-123.azuredatabricks.net:443/default;httpPath=/sql/1.0/warehouses/abc;AuthMech=3",
            DatabricksAgent.DATABRICKS_PROFILE.buildUrl(params)
        );
    }
}
