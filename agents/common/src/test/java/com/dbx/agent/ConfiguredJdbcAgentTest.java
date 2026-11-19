package com.dbx.agent;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ConfiguredJdbcAgentTest {
    @Test
    void tableDdlKeepsColumnCommentsDisabledForGenericConfiguredAgents() {
        List<String> calls = new ArrayList<>();
        ConfiguredJdbcAgent agent = ddlAgent(calls, false);

        assertEquals(
            "CREATE TABLE \"APP\".\"ITEMS\" (\n  \"ID\" INTEGER NOT NULL DEFAULT 1,\n  PRIMARY KEY (\"ID\")\n);\n"
                + "\nCOMMENT ON TABLE \"APP\".\"ITEMS\" IS 'table''s comment';",
            agent.getTableDdl("APP", "ITEMS")
        );
        assertEquals(Arrays.asList("indexes", "foreignKeys", "tableComment", "columns"), calls);
    }

    @Test
    void tableDdlKeepsGenericOptionalMetadataFailureFallbacks() {
        List<String> calls = new ArrayList<>();
        ConfiguredJdbcAgent agent = ddlAgent(calls, true);

        assertEquals(
            "CREATE TABLE \"APP\".\"ITEMS\" (\n  \"ID\" INTEGER NOT NULL DEFAULT 1,\n  PRIMARY KEY (\"ID\")\n);\n",
            agent.getTableDdl("APP", "ITEMS")
        );
        assertEquals(Arrays.asList("indexes", "foreignKeys", "tableComment", "columns"), calls);
    }

    private static ConfiguredJdbcAgent ddlAgent(List<String> calls, boolean failOptionalMetadata) {
        return new ConfiguredJdbcAgent(new JdbcAgentProfile("com.example.Driver", "jdbc:example:{database}")) {
            @Override
            public List<ColumnInfo> getColumns(String schema, String table) {
                calls.add("columns");
                return Collections.singletonList(new ColumnInfo(
                    "ID", "INTEGER", false, "1", true, null, "column's 注释\nsecond line", null, null, null
                ));
            }

            @Override
            public List<IndexInfo> listIndexes(String schema, String table) {
                calls.add("indexes");
                if (failOptionalMetadata) {
                    throw new IllegalStateException("indexes unavailable");
                }
                return Collections.emptyList();
            }

            @Override
            public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
                calls.add("foreignKeys");
                if (failOptionalMetadata) {
                    throw new IllegalStateException("foreign keys unavailable");
                }
                return Collections.emptyList();
            }

            @Override
            public String getTableComment(String schema, String table) {
                calls.add("tableComment");
                if (failOptionalMetadata) {
                    throw new IllegalStateException("table comment unavailable");
                }
                return "table's comment";
            }
        };
    }

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
