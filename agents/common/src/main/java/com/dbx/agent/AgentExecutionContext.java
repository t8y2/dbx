package com.dbx.agent;

final class AgentExecutionContext {
    private static final ThreadLocal<JdbcExecutor> JDBC_EXECUTOR = new ThreadLocal<>();

    private AgentExecutionContext() {
    }

    static JdbcExecutor jdbcExecutor() {
        JdbcExecutor executor = JDBC_EXECUTOR.get();
        return executor == null ? JdbcExecutor.INSTANCE : executor;
    }

    static <T> T withJdbcExecutor(JdbcExecutor executor, DatabaseAgent.ThrowingSupplier<T> supplier) throws Exception {
        JdbcExecutor previous = JDBC_EXECUTOR.get();
        JDBC_EXECUTOR.set(executor);
        try {
            return supplier.get();
        } finally {
            if (previous == null) {
                JDBC_EXECUTOR.remove();
            } else {
                JDBC_EXECUTOR.set(previous);
            }
        }
    }
}
