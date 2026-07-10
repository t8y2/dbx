package com.dbx.agent;

import java.sql.Connection;
import java.sql.Statement;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;

public final class TransactionExecutor {
    private TransactionExecutor() {
    }

    public static QueryResult executeUpdateStatements(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql
    ) {
        return executeStatements(conn, statements, schema, setSchemaSql, new StatementRunner() {
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
        return unchecked(() -> {
            long start = System.currentTimeMillis();
            if (!supportsTransactions(conn)) {
                long totalAffected = executeAll(conn, statements, schema, setSchemaSql, runner);
                return result(totalAffected, start);
            }

            boolean savedAutoCommit = conn.getAutoCommit();
            conn.setAutoCommit(false);
            try {
                long totalAffected = executeAll(conn, statements, schema, setSchemaSql, runner);
                conn.commit();
                return result(totalAffected, start);
            } catch (Exception e) {
                conn.rollback();
                throw e;
            } finally {
                conn.setAutoCommit(savedAutoCommit);
            }
        });
    }

    private static long executeAll(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql,
        StatementRunner runner
    ) throws Exception {
        applySchema(conn, schema, setSchemaSql);
        long totalAffected = 0;
        for (String statement : statements) {
            try (Statement stmt = conn.createStatement()) {
                totalAffected += runner.run(stmt, JdbcExecutor.trimSql(statement));
            }
        }
        return totalAffected;
    }

    private static void applySchema(Connection conn, String schema, Function<String, String> setSchemaSql) throws Exception {
        JdbcSchemaSwitcher.apply(conn, schema, setSchemaSql);
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
