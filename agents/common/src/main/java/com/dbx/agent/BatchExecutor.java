package com.dbx.agent;

import java.sql.BatchUpdateException;
import java.sql.Connection;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;
import java.util.function.Supplier;

public final class BatchExecutor {
    private BatchExecutor() {
    }

    public static QueryResult executeBatchStatements(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql
    ) {
        return executeBatchStatements(conn, statements, schema, setSchemaSql, () -> "");
    }

    public static QueryResult executeBatchStatements(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql
    ) {
        return unchecked(() -> {
            long start = System.currentTimeMillis();
            applySchema(conn, schema, setSchemaSql, resetSchemaSql);
            Long batchAffected = tryExecuteBatch(conn, statements);
            long totalAffected = batchAffected == null ? executeIndividually(conn, statements) : batchAffected;
            return new QueryResult(
                Collections.emptyList(),
                Collections.emptyList(),
                totalAffected,
                System.currentTimeMillis() - start,
                false
            );
        });
    }

    private static Long tryExecuteBatch(Connection conn, List<String> statements) throws Exception {
        try (Statement stmt = conn.createStatement()) {
            try {
                int statementCount = 0;
                for (String statement : statements) {
                    String trimmed = JdbcExecutor.trimSql(statement);
                    if (trimmed.isEmpty()) {
                        continue;
                    }
                    stmt.addBatch(trimmed);
                    statementCount++;
                }
                return statementCount == 0 ? 0L : affectedRows(executeBatch(stmt));
            } catch (BatchUpdateException e) {
                long[] counts = e.getLargeUpdateCounts();
                int failedIndex = counts == null ? 1 : counts.length + 1;
                throw new RuntimeException("Statement " + failedIndex + " failed: " + e.getMessage(), e);
            } catch (SQLFeatureNotSupportedException | UnsupportedOperationException | AbstractMethodError e) {
                return null;
            }
        }
    }

    private static long executeIndividually(Connection conn, List<String> statements) throws Exception {
        long totalAffected = 0;
        int statementIndex = 0;
        try (Statement stmt = conn.createStatement()) {
            for (String statement : statements) {
                String trimmed = JdbcExecutor.trimSql(statement);
                if (trimmed.isEmpty()) {
                    continue;
                }
                statementIndex++;
                try {
                    if (!stmt.execute(trimmed)) {
                        long updateCount = updateCount(stmt);
                        if (updateCount >= 0) {
                            totalAffected += updateCount;
                        }
                    }
                } catch (Exception e) {
                    throw new RuntimeException("Statement " + statementIndex + " failed: " + e.getMessage(), e);
                }
            }
        }
        return totalAffected;
    }

    private static long affectedRows(long[] updateCounts) {
        long total = 0;
        if (updateCounts == null) {
            return total;
        }
        for (long count : updateCounts) {
            if (count >= 0) {
                total += count;
            } else if (count == Statement.SUCCESS_NO_INFO) {
                total += 1;
            }
        }
        return total;
    }

    private static long[] executeBatch(Statement stmt) throws Exception {
        try {
            return stmt.executeLargeBatch();
        } catch (SQLFeatureNotSupportedException | UnsupportedOperationException | AbstractMethodError e) {
            int[] counts = stmt.executeBatch();
            long[] largeCounts = new long[counts.length];
            for (int i = 0; i < counts.length; i++) {
                largeCounts[i] = counts[i];
            }
            return largeCounts;
        }
    }

    private static long updateCount(Statement stmt) throws Exception {
        try {
            return stmt.getLargeUpdateCount();
        } catch (SQLFeatureNotSupportedException | UnsupportedOperationException | AbstractMethodError e) {
            return stmt.getUpdateCount();
        }
    }

    private static void applySchema(
        Connection conn,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql
    ) throws Exception {
        JdbcSchemaSwitcher.apply(conn, schema, setSchemaSql, resetSchemaSql);
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

    private interface ThrowingSupplier<T> {
        T get() throws Exception;
    }
}
