package com.dbx.agent;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class JdbcAgentProfileExtendedTest {
    @Test
    void appendsQueryParamsToJdbcUrlTemplates() {
        JdbcAgentProfile profile = new JdbcAgentProfile(
            "example.Driver",
            "jdbc:example://{host}:{port}/{database}",
            1234
        );
        ConnectParams params = new ConnectParams();
        params.setHost("db.example.com");
        params.setPort(0);
        params.setDatabase("analytics");
        params.setUrl_params("ssl=true");

        assertEquals("jdbc:example://db.example.com:1234/analytics?ssl=true", profile.buildUrl(params));
    }

    @Test
    void appendsSemicolonParamsToSemicolonJdbcUrlTemplates() {
        JdbcAgentProfile profile = new JdbcAgentProfile(
            "example.Driver",
            "jdbc:exa:{host}:{port};schema={database}",
            8563
        );
        ConnectParams params = new ConnectParams();
        params.setHost("db.example.com");
        params.setPort(0);
        params.setDatabase("analytics");
        params.setUrl_params("encryption=1");

        assertEquals("jdbc:exa:db.example.com:8563;schema=analytics;encryption=1", profile.buildUrl(params));
    }

    @Test
    void appendsCommaParamsToTeradataJdbcUrlTemplates() {
        JdbcAgentProfile profile = new JdbcAgentProfile(
            "example.Driver",
            "jdbc:teradata://{host}/DBS_PORT={port},DATABASE={database}",
            1025
        );
        ConnectParams params = new ConnectParams();
        params.setHost("db.example.com");
        params.setPort(0);
        params.setDatabase("analytics");
        params.setUrl_params("LOGMECH=LDAP");

        assertEquals("jdbc:teradata://db.example.com/DBS_PORT=1025,DATABASE=analytics,LOGMECH=LDAP", profile.buildUrl(params));
    }

    @Test
    void appendsColonPropertiesToDb2JdbcUrlTemplates() {
        JdbcAgentProfile profile = new JdbcAgentProfile(
            "example.Driver",
            "jdbc:db2://{host}:{port}/{database}",
            50000
        );
        ConnectParams params = new ConnectParams();
        params.setHost("db.example.com");
        params.setPort(0);
        params.setDatabase("analytics");
        params.setUrl_params("sslConnection=true");

        assertEquals("jdbc:db2://db.example.com:50000/analytics:sslConnection=true;", profile.buildUrl(params));
    }

    @Test
    void preservesExplicitConnectionStringForVendorSpecificUrls() {
        JdbcAgentProfile profile = new JdbcAgentProfile(
            "example.Driver",
            "jdbc:example://{host}:{port}/{database}",
            1234
        );
        ConnectParams params = new ConnectParams();
        params.setConnection_string("jdbc:example:special://host/path;token=secret");

        assertEquals("jdbc:example:special://host/path;token=secret", profile.buildUrl(params));
    }

    @Test
    void exposesDialectProfileOptions() {
        JdbcAgentProfile profile = new JdbcAgentProfile(
            "example.Driver",
            "jdbc:example://{host}:{port}/{database}",
            1234,
            false,
            java.util.Collections.singleton("SYS"),
            java.util.Arrays.asList("TABLE", "VIEW"),
            "`",
            "USE",
            false,
            true,
            true,
            true
        );

        assertEquals("USE `analytics``prod`", profile.schemaSwitchSql("analytics`prod"));
        assertEquals("`orders`", profile.quoteIdentifier("orders"));
        assertEquals(false, profile.getCatalogFallbackEnabled());
        assertEquals(true, profile.getNativeTableDdlSupported());
        assertEquals(true, profile.getObjectSourceSupported());
        assertEquals(true, profile.getTriggersSupported());
    }
}
