package com.dbx.agent;

import com.google.gson.JsonObject;

/**
 * Per-session handler for protocol v2 agents that do not implement the JDBC
 * {@link DatabaseAgent} contract. Implementations own every resource created
 * for a logical DBX connection and must release it from {@link #close()}.
 */
public interface SessionRpcHandler {
    default Object handshake() {
        return AgentProtocol.multiSessionHandshakeResult();
    }

    Object connect(JsonObject params) throws Exception;

    Object handle(String method, JsonObject params) throws Exception;

    default void cancel() {
    }

    void close();
}
