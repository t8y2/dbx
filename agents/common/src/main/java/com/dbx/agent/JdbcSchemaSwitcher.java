package com.dbx.agent;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.function.Function;

final class JdbcSchemaSwitcher {
    private JdbcSchemaSwitcher() {
    }

    static void apply(Connection conn, String schema, Function<String, String> setSchemaSql) throws Exception {
        if (schema == null || schema.trim().isEmpty()) {
            return;
        }

        SchemaSqlResult schemaSqlResult = applySchemaSql(conn, schema, setSchemaSql);
        Exception schemaSqlError = schemaSqlResult.error;
        if (schemaSqlError == null) {
            return;
        }

        try {
            conn.setSchema(schema);
            return;
        } catch (SQLException | AbstractMethodError ignored) {
            // Some JDBC drivers only expose schema switching through SQL.
        }
        try {
            conn.setCatalog(schema);
            return;
        } catch (SQLException | AbstractMethodError ignored) {
            // Last fallback failed as well; surface the SQL-switch error below.
        }

        if (schemaSqlResult.attempted) {
            throw schemaSqlError;
        }
    }

    private static SchemaSqlResult applySchemaSql(Connection conn, String schema, Function<String, String> setSchemaSql) {
        String schemaSql;
        try {
            schemaSql = setSchemaSql.apply(schema);
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
