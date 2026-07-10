package com.dbx.agent;

import java.sql.BatchUpdateException;
import java.sql.Connection;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;

public final class BatchExecutor {
    private BatchExecutor() {
    }

    public static QueryResult executeBatchStatements(
        Connection conn,
        List<String> statements,
        String schema,
        Function<String, String> setSchemaSql
    ) {
        return unchecked(() -> {
            long start = System.currentTimeMillis();
            applySchema(conn, schema, setSchemaSql);
            long totalAffected = 0;
            int statementCount = 0;
            try (Statement stmt = conn.createStatement()) {
                for (String statement : statements) {
                    String trimmed = JdbcExecutor.trimSql(statement);
                    if (trimmed.isEmpty()) {
                        continue;
                    }
                    stmt.addBatch(trimmed);
                    statementCount++;
                }
                if (statementCount > 0) {
                    totalAffected = affectedRows(executeBatch(stmt));
                }
            } catch (BatchUpdateException e) {
                long[] counts = e.getLargeUpdateCounts();
                int failedIndex = counts == null ? 1 : counts.length + 1;
                throw new RuntimeException("Statement " + failedIndex + " failed: " + e.getMessage(), e);
            }
            return new QueryResult(
                Collections.emptyList(),
                Collections.emptyList(),
                totalAffected,
                System.currentTimeMillis() - start,
                false
            );
        });
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

    private static void applySchema(Connection conn, String schema, Function<String, String> setSchemaSql) throws Exception {
        JdbcSchemaSwitcher.apply(conn, schema, setSchemaSql);
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
