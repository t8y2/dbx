package com.dbx.agent.oscar;

import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.JdbcAgentProfile;
import java.util.List;
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

    @Test
    void deduplicatesDatabaseNamesIgnoringCaseAndPreservesJdbcCasing() {
        List<DatabaseInfo> databases = OscarAgent.deduplicateDatabases(List.of(
            new DatabaseInfo("OSRDB"),
            new DatabaseInfo("osrdb"),
            new DatabaseInfo("REPORTING")
        ));

        Assertions.assertEquals(
            List.of("OSRDB", "REPORTING"),
            databases.stream().map(DatabaseInfo::getName).toList()
        );
    }
}
