package com.dbx.agent.uxdb;

import com.dbx.agent.ConnectParams;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class UxdbAgentTest {
    @Test
    void profileUsesOfficialJdbcSettings() {
        assertEquals("com.uxsino.uxdb.Driver", UxdbAgent.UXDB_PROFILE.getDriverClass());
        assertEquals("ux_catalog", UxdbAgent.UXDB_PROFILE.getCatalogSchema());
        assertEquals("ux_catalog.ux_database", UxdbAgent.UXDB_PROFILE.catalogRelation("database"));
        assertEquals(
            "jdbc:uxdb://localhost:52025/uxdb",
            UxdbAgent.UXDB_PROFILE.buildUrl(new ConnectParams("localhost", 0, "uxdb", "uxdb", "", "", "", false))
        );
    }

    @Test
    void usesPostgresStyleSchemaSearchPath() {
        assertEquals("SET search_path TO \"public\"", new UxdbAgent().setSchemaSQL("public"));
        assertEquals("RESET search_path", new UxdbAgent().resetSchemaSQL());
    }
}
