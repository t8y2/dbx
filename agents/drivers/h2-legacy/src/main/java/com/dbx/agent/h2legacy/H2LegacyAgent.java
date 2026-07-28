package com.dbx.agent.h2legacy;

import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.h2.H2Agent;

public final class H2LegacyAgent extends H2Agent {
    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(H2LegacyAgent::new).run();
    }
}
