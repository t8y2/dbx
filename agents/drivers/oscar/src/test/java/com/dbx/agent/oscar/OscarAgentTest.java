package com.dbx.agent.oscar;

import com.dbx.agent.JdbcAgentProfile;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class OscarAgentTest {
    @Test
    void declaresOscarJdbcProfile() {
        JdbcAgentProfile profile = OscarAgent.OSCAR_PROFILE;

        Assertions.assertEquals("com.oscar.Driver", profile.getDriverClass());
        Assertions.assertEquals("jdbc:oscar://{host}:{port}/{database}", profile.getUrlTemplate());
        Assertions.assertEquals(2003, profile.getDefaultPort());
    }
}
