package com.dbx.agent.oscar;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;

public final class OscarAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile OSCAR_PROFILE = new JdbcAgentProfile(
        "com.oscar.Driver",
        "jdbc:oscar://{host}:{port}/{database}",
        2003
    );

    public OscarAgent() {
        super(OSCAR_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(OscarAgent::new).run();
    }
}
