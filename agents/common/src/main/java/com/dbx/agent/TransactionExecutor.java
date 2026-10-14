package com.dbx.agent;

import java.sql.Connection;
import java.sql.Statement;
import java.sql.SQLTransientConnectionException;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;
import java.util.function.Supplier;

public final class TransactionExecutor {
    private TransactionExecutor() {
    }

    public static QueryResult executeUpdateStatements(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql
    ) {
        return executeUpdateStatements(conn, statements, schema, setSchemaSql, () -> "");
    }

    public static QueryResult executeUpdateStatements(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql
    ) {
        return executeStatements(conn, statements, schema, setSchemaSql, resetSchemaSql, new StatementRunner() {
            @Override
            public long run(Statement stmt, String sql) throws Exception {
                return stmt.executeUpdate(sql);
            }
        });
    }

    public static QueryResult executeStatements(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql,
        StatementRunner runner
    ) {
        return executeStatements(conn, statements, schema, setSchemaSql, () -> "", runner);
    }

    public static QueryResult executeStatements(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql,
        StatementRunner runner
    ) {
        return unchecked(() -> {
            try (JdbcExecutor.NativeOperation operation = JdbcExecutor.current().beginNativeOperation()) {
                long start = System.currentTimeMillis();
                operation.checkCancelled();
                if (!supportsTransactions(conn)) {
                    // An explicit transaction request must not degrade to auto-commit:
                    // callers rely on it to avoid partial writes when a later statement fails.
                    throw new UnsupportedOperationException("Transactions are not supported by this JDBC driver");
                }

                boolean savedAutoCommit = conn.getAutoCommit();
                conn.setAutoCommit(false);
                boolean finished = false;
                boolean discarded = false;
                try {
                    long totalAffected = executeAll(conn, statements, schema, setSchemaSql, resetSchemaSql, runner, operation);
                    operation.checkCancelled();
                    conn.commit();
                    finished = true;
                    return result(totalAffected, start);
                } catch (Exception e) {
                    try {
                        conn.rollback();
                        finished = true;
                    } catch (Exception rollbackFailure) {
                        SQLTransientConnectionException unsafe = new SQLTransientConnectionException(
                            "Transaction rollback was not confirmed; discard this connection and treat the operation outcome as unknown", "08007", e);
                        unsafe.addSuppressed(rollbackFailure);
                        discarded = true;
                        try { AgentExecutionContext.discardConnection(conn); } catch (Exception closeFailure) { unsafe.addSuppressed(closeFailure); }
                        throw unsafe;
                    }
                    throw e;
                } finally {
                    if (finished) conn.setAutoCommit(savedAutoCommit);
                    else if (!discarded) AgentExecutionContext.discardConnection(conn);
                }
            }
        });
    }

    private static long executeAll(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql,
        StatementRunner runner,
        JdbcExecutor.NativeOperation operation
    ) throws Exception {
        applySchema(conn, schema, setSchemaSql, resetSchemaSql);
        long totalAffected = 0;
        for (String statement : statements) {
            operation.checkCancelled();
            try (var tracked = JdbcExecutor.current().trackStatement(conn.createStatement())) {
                Statement stmt = tracked.statement();
                if (AgentExecutionContext.statementTimeoutSecs() > 0) {
                    stmt.setQueryTimeout(AgentExecutionContext.statementTimeoutSecs());
                }
                operation.checkCancelled();
                totalAffected += runner.run(stmt, JdbcExecutor.trimSql(statement));
            }
        }
        return totalAffected;
    }

    private static void applySchema(
        Connection conn,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql
    ) throws Exception {
        JdbcSchemaSwitcher.apply(conn, schema, setSchemaSql, resetSchemaSql);
    }

    private static boolean supportsTransactions(Connection conn) {
        try {
            return conn.getMetaData().supportsTransactions();
        } catch (Exception ignored) {
            return true;
        }
    }

    private static QueryResult result(long totalAffected, long start) {
        return new QueryResult(
            Collections.emptyList(),
            Collections.emptyList(),
            totalAffected,
            System.currentTimeMillis() - start,
            false
        );
    }

    private static <T> T unchecked(ThrowingSupplier<T> supplier) {
        try {
            return supplier.get();
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public interface StatementRunner {
        long run(Statement stmt, String sql) throws Exception;
    }

    private interface ThrowingSupplier<T> {
        T get() throws Exception;
    }
}
