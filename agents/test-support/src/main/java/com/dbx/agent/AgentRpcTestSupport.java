package com.dbx.agent;

/** Exercises the production wire codec without exposing it as an agent API. */
public final class AgentRpcTestSupport {
    private AgentRpcTestSupport() {}

    public static String handleRequest(DatabaseAgent agent, String request) {
        return new JsonRpcServer(agent).handleRequest(request);
    }
}
