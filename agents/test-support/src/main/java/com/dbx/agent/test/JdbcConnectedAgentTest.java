package com.dbx.agent.test;

import com.dbx.agent.DatabaseAgent;

import java.util.function.Consumer;

public abstract class JdbcConnectedAgentTest {
    protected abstract DatabaseAgent createConnectedAgent(String databaseName);

    protected void withAgent(String databaseName, Consumer<DatabaseAgent> block) {
        DatabaseAgent agent = createConnectedAgent(databaseName);
        try {
            block.accept(agent);
        } finally {
            agent.disconnect();
        }
    }
}
