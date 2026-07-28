package com.dbx.agent.yashandb;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;

public final class YashandbAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile YASHANDB_PROFILE = new JdbcAgentProfile(
        "com.yashandb.jdbc.Driver",
        "jdbc:yasdb://{host}:{port}/{database}",
        1688,
        true
    );

    public YashandbAgent() {
        super(YASHANDB_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(YashandbAgent::new).run();
    }
}
