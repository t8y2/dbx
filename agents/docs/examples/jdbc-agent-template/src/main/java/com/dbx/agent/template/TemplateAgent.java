package com.dbx.agent.template;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.JsonRpcServer;

public final class TemplateAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile TEMPLATE_PROFILE = new JdbcAgentProfile(
        "com.example.jdbc.TemplateDriver",
        "jdbc:template://{host}:{port}/{database}",
        1234
    );

    public TemplateAgent() {
        super(TEMPLATE_PROFILE);
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "SET SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    public static void main(String[] args) {
        new JsonRpcServer(new TemplateAgent()).run();
    }
}
