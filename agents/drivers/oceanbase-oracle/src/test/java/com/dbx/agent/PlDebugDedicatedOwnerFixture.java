package com.dbx.agent;

import java.sql.Connection;

/** Uses the actual dedicated-owner proxy and its bounded physical setter. */
public final class PlDebugDedicatedOwnerFixture implements AutoCloseable {
    public static MultiSessionJsonRpcServer unpooledServer(java.util.function.Supplier<? extends DatabaseAgent> factory) {
        return new MultiSessionJsonRpcServer(factory,
            new JdbcConnectionPoolRegistry.PoolSettings(false,2,0,1000,250,60000,120000,60000,1,2,1));
    }
    private final JdbcConnectionPoolRegistry registry = new JdbcConnectionPoolRegistry(
        new JdbcConnectionPoolRegistry.PoolSettings(false, 2, 0, 1000, 250, 60000, 120000, 60000, 1, 2, 1));
    private final AbstractJdbcAgent.DedicatedConnectionOwner owner;
    public final Connection connection;

    public PlDebugDedicatedOwnerFixture(Connection raw) throws Exception {
        owner = registry.registerDedicatedOwner(() -> raw, value -> {}, () -> {}, () -> {});
        connection = owner.open();
    }

    public boolean resourcesReleased() { return owner.resourcesReleased(); }

    public void close() throws Exception {
        connection.close();
        owner.close();
        registry.close();
    }
}
