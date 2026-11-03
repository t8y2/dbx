package com.dbx.agent;

final class AgentExecutionContext {
    private static final ThreadLocal<JdbcExecutor> JDBC_EXECUTOR = new ThreadLocal<>();
    private record StatementExecution(int timeoutSecs, JdbcExecutor.NativeOperation operation, AbstractJdbcAgent owner) { }
    private static final ThreadLocal<StatementExecution> STATEMENT_EXECUTION = new ThreadLocal<>();

    private AgentExecutionContext() {
    }

    static JdbcExecutor jdbcExecutor() {
        JdbcExecutor executor = JDBC_EXECUTOR.get();
        return executor == null ? JdbcExecutor.INSTANCE : executor;
    }

    static int statementTimeoutSecs() {
        StatementExecution execution = STATEMENT_EXECUTION.get();
        return execution == null ? 0 : execution.timeoutSecs();
    }

    static JdbcExecutor.NativeOperation statementOperation() {
        StatementExecution execution = STATEMENT_EXECUTION.get();
        return execution == null ? null : execution.operation();
    }

    static void discardConnection(java.sql.Connection connection) throws java.sql.SQLException {
        StatementExecution execution = STATEMENT_EXECUTION.get();
        if (execution != null && execution.owner() != null) execution.owner().discardConnection(connection);
        else connection.close();
    }

    static <T> T withStatementTimeout(int timeoutSecs, JdbcExecutor.NativeOperation operation, AbstractJdbcAgent owner,
        DatabaseAgent.ThrowingSupplier<T> supplier) throws Exception {
        if (timeoutSecs < 0) throw new IllegalArgumentException("Query timeout cannot be negative");
        StatementExecution previous = STATEMENT_EXECUTION.get();
        STATEMENT_EXECUTION.set(new StatementExecution(timeoutSecs, operation, owner));
        try {
            return supplier.get();
        } finally {
            if (previous == null) STATEMENT_EXECUTION.remove();
            else STATEMENT_EXECUTION.set(previous);
        }
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
