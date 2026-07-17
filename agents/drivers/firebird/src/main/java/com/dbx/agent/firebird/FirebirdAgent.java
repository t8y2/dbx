package com.dbx.agent.firebird;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;

public final class FirebirdAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile FIREBIRD_PROFILE = new JdbcAgentProfile(
        "org.firebirdsql.jdbc.FBDriver",
        "jdbc:firebirdsql://{host}:{port}/{database}",
        3050,
        true
    );

    public FirebirdAgent() {
        super(FIREBIRD_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(FirebirdAgent::new).run();
    }
}
