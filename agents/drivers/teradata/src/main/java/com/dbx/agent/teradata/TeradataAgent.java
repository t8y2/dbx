package com.dbx.agent.teradata;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;

public final class TeradataAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile TERADATA_PROFILE = new JdbcAgentProfile(
        "com.teradata.jdbc.TeraDriver",
        "jdbc:teradata://{host}/DBS_PORT={port},DATABASE={database}",
        1025
    );

    public TeradataAgent() {
        super(TERADATA_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(TeradataAgent::new).run();
    }
}
