package com.dbx.agent;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ConfiguredJdbcAgentTest {
    @Test
    void buildsJdbcUrlFromProfileTemplateAndUrlParams() {
        JdbcAgentProfile profile = new JdbcAgentProfile(
            "com.example.Driver",
            "jdbc:example://{host}:{port}/{database}"
        );

        String url = profile.buildUrl(
            new ConnectParams(
                "127.0.0.1",
                1234,
                "demo",
                "",
                "",
                "ssl=false",
                "",
                false
            )
        );

        assertEquals("jdbc:example://127.0.0.1:1234/demo?ssl=false", url);
    }

    @Test
    void usesExplicitConnectionStringBeforeTemplate() {
        JdbcAgentProfile profile = new JdbcAgentProfile(
            "com.example.Driver",
            "jdbc:example://{host}:{port}/{database}"
        );

        String url = profile.buildUrl(
            new ConnectParams(
                "127.0.0.1",
                1234,
                "demo",
                "",
                "",
                "",
                "jdbc:example://server:4321/prod",
                false
            )
        );

        assertEquals("jdbc:example://server:4321/prod", url);
    }

    @Test
    void usesDefaultPortWhenParamsOmitPort() {
        JdbcAgentProfile profile = new JdbcAgentProfile(
            "com.example.Driver",
            "jdbc:example://{host}:{port}/{database}",
            9999
        );

        String url = profile.buildUrl(
            new ConnectParams(
                "127.0.0.1",
                0,
                "demo",
                "",
                "",
                "",
                "",
                false
            )
        );

        assertEquals("jdbc:example://127.0.0.1:9999/demo", url);
    }

    @Test
    void canDisableSchemaSwitchingForDriversThatDoNotSupportContextChanges() {
        ConfiguredJdbcAgent agent = new ConfiguredJdbcAgent(
            new JdbcAgentProfile(
                "com.example.Driver",
                "jdbc:example://{host}:{port}/{database}",
                0,
                true
            )
        ) {};

        assertEquals("", agent.setSchemaSQL("APP"));
    }
}
