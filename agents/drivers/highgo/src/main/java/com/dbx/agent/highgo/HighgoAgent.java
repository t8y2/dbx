package com.dbx.agent.highgo;

import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.PostgresLikeAgent;
import com.dbx.agent.PostgresLikeAgentProfile;

public final class HighgoAgent extends PostgresLikeAgent {
    public static final PostgresLikeAgentProfile HIGHGO_PROFILE = new PostgresLikeAgentProfile(
        "com.highgo.jdbc.Driver",
        "jdbc:highgo://{host}:{port}/{database}"
    );

    public HighgoAgent() {
        super(HIGHGO_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(HighgoAgent::new).run();
    }
}
