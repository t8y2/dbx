package com.dbx.agent;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Collections;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.function.Function;
import java.util.function.Supplier;

final class JdbcSchemaSwitcher {
    private static final Map<Connection, String> RESET_SQL_BY_CONNECTION =
        Collections.synchronizedMap(new WeakHashMap<>());

    private JdbcSchemaSwitcher() {
    }

    static void apply(Connection conn, String schema, Function<String, String> setSchemaSql) throws Exception {
        apply(conn, schema, setSchemaSql, () -> "");
    }

    static void apply(
        Connection conn,
        String schema,
        Function<String, String> setSchemaSql,
        Supplier<String> resetSchemaSql
    ) throws Exception {
        if (schema == null || schema.trim().isEmpty()) {
            String resetSql = RESET_SQL_BY_CONNECTION.remove(conn);
            if (resetSql == null) {
                return;
            }
            SchemaSqlResult resetResult = applySchemaSql(conn, () -> resetSql);
            if (resetResult.attempted && resetResult.error != null) {
                RESET_SQL_BY_CONNECTION.put(conn, resetSql);
                throw resetResult.error;
            }
            return;
        }

        SchemaSqlResult schemaSqlResult = applySchemaSql(conn, () -> setSchemaSql.apply(schema));
        Exception schemaSqlError = schemaSqlResult.error;
        if (schemaSqlError == null) {
            rememberResetSql(conn, resetSchemaSql);
            return;
        }

        try {
            conn.setSchema(schema);
            rememberResetSql(conn, resetSchemaSql);
            return;
        } catch (SQLException | AbstractMethodError ignored) {
            // Some JDBC drivers only expose schema switching through SQL.
        }
        try {
            conn.setCatalog(schema);
            rememberResetSql(conn, resetSchemaSql);
            return;
        } catch (SQLException | AbstractMethodError ignored) {
            // Last fallback failed as well; surface the SQL-switch error below.
        }

        if (schemaSqlResult.attempted) {
            throw schemaSqlError;
        }
    }

    private static void rememberResetSql(Connection conn, Supplier<String> resetSchemaSql) {
        try {
            String sql = resetSchemaSql.get();
            if (sql != null && !sql.trim().isEmpty()) {
                RESET_SQL_BY_CONNECTION.put(conn, sql);
            }
        } catch (RuntimeException ignored) {
            // Drivers without a reset command keep the legacy no-op behavior.
        }
    }

    private static SchemaSqlResult applySchemaSql(Connection conn, Supplier<String> schemaSqlSupplier) {
        String schemaSql;
        try {
            schemaSql = schemaSqlSupplier.get();
        } catch (RuntimeException e) {
            return new SchemaSqlResult(true, e);
        }
        if (schemaSql == null || schemaSql.trim().isEmpty()) {
            return new SchemaSqlResult(false, new SQLException("No schema switch SQL provided"));
        }
        try (Statement stmt = conn.createStatement()) {
            stmt.execute(schemaSql);
            return new SchemaSqlResult(true, null);
        } catch (SQLException | AbstractMethodError e) {
            return new SchemaSqlResult(true, e instanceof SQLException ? (SQLException) e : new SQLException(e));
        }
    }

    private static final class SchemaSqlResult {
        private final boolean attempted;
        private final Exception error;

        private SchemaSqlResult(boolean attempted, Exception error) {
            this.attempted = attempted;
            this.error = error;
        }
    }
}
