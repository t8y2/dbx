package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.ConnectParams;
import com.oceanbase.jdbc.UrlParser;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class OceanBaseBatchOptionsTest {
    @Test
    void agentFailFastPropertyOverridesExplicitContinueBatchOnErrorUrl() throws Exception {
        ConnectParams params = new ConnectParams();
        params.setConnection_string("jdbc:oceanbase://localhost:2881/SYS?continueBatchOnError=true");
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        assertFalse(UrlParser.parse(OceanBaseOracleAgent.buildUrl(params), agent.buildConnectionProperties(params))
            .getOptions().continueBatchOnError);
    }
}
