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
    private static final Map<Connection, ResetState> RESET_STATE_BY_CONNECTION =
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
            if (!restore(conn, true)) {
                throw new SQLException("Failed to restore the original JDBC schema context");
            }
            return;
        }

        ResetState resetState = resetState(conn);
        SchemaSqlResult schemaSqlResult = applySchemaSql(conn, () -> setSchemaSql.apply(schema));
        Exception schemaSqlError = schemaSqlResult.error;
        if (schemaSqlError == null) {
            resetState.mode = ResetMode.SQL;
            rememberResetSql(resetState, resetSchemaSql);
            return;
        }

        try {
            conn.setSchema(schema);
            resetState.mode = ResetMode.SCHEMA;
            return;
        } catch (SQLException | UnsupportedOperationException | AbstractMethodError ignored) {
            // Some JDBC drivers only expose schema switching through SQL.
        }
        try {
            conn.setCatalog(schema);
            resetState.mode = ResetMode.CATALOG;
            return;
        } catch (SQLException | UnsupportedOperationException | AbstractMethodError ignored) {
            // Last fallback failed as well; surface the SQL-switch error below.
        }

        if (schemaSqlResult.attempted) {
            throw schemaSqlError;
        }
    }

    static boolean resetBeforeReturn(Connection conn) {
        return restore(conn, false);
    }

    static void forget(Connection conn) {
        RESET_STATE_BY_CONNECTION.remove(conn);
    }

    private static boolean restore(Connection conn, boolean preserveOnFailure) {
        ResetState resetState = RESET_STATE_BY_CONNECTION.remove(conn);
        if (resetState == null) {
            return true;
        }
        try {
            boolean restored = resetState.restore(conn);
            if (!restored && preserveOnFailure) {
                RESET_STATE_BY_CONNECTION.put(conn, resetState);
            }
            return restored;
        } catch (Exception ignored) {
            if (preserveOnFailure) {
                RESET_STATE_BY_CONNECTION.put(conn, resetState);
            }
            return false;
        }
    }

    private static ResetState resetState(Connection conn) {
        synchronized (RESET_STATE_BY_CONNECTION) {
            return RESET_STATE_BY_CONNECTION.computeIfAbsent(conn, JdbcSchemaSwitcher::captureResetState);
        }
    }

    private static ResetState captureResetState(Connection conn) {
        JdbcValue<String> schema = readJdbcValue(conn, true);
        JdbcValue<String> catalog = readJdbcValue(conn, false);
        return new ResetState(schema, catalog);
    }

    private static JdbcValue<String> readJdbcValue(Connection conn, boolean schema) {
        try {
            return new JdbcValue<>(true, schema ? conn.getSchema() : conn.getCatalog());
        } catch (SQLException | UnsupportedOperationException | AbstractMethodError ignored) {
            return new JdbcValue<>(false, null);
        }
    }

    private static void rememberResetSql(ResetState resetState, Supplier<String> resetSchemaSql) {
        try {
            String sql = resetSchemaSql.get();
            if (sql != null && !sql.trim().isEmpty()) {
                resetState.resetSql = sql;
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

    private enum ResetMode {
        SQL,
        SCHEMA,
        CATALOG
    }

    private static final class JdbcValue<T> {
        private final boolean supported;
        private final T value;

        private JdbcValue(boolean supported, T value) {
            this.supported = supported;
            this.value = value;
        }
    }

    private static final class ResetState {
        private final JdbcValue<String> schema;
        private final JdbcValue<String> catalog;
        private ResetMode mode;
        private String resetSql;

        private ResetState(JdbcValue<String> schema, JdbcValue<String> catalog) {
            this.schema = schema;
            this.catalog = catalog;
        }

        private boolean restore(Connection conn) throws Exception {
            if (mode == ResetMode.SQL && resetSql != null) {
                SchemaSqlResult result = applySchemaSql(conn, () -> resetSql);
                return result.attempted && result.error == null;
            }
            if (mode == ResetMode.SCHEMA) {
                return restoreSchema(conn);
            }
            if (mode == ResetMode.CATALOG) {
                return restoreCatalog(conn);
            }
            if (mode == ResetMode.SQL) {
                if (schema.supported && schema.value != null && restoreSchema(conn)) {
                    return true;
                }
                return catalog.supported && catalog.value != null && restoreCatalog(conn);
            }
            return true;
        }

        private boolean restoreSchema(Connection conn) {
            if (!schema.supported) {
                return false;
            }
            try {
                conn.setSchema(schema.value);
                return true;
            } catch (SQLException | UnsupportedOperationException | AbstractMethodError ignored) {
                return false;
            }
        }

        private boolean restoreCatalog(Connection conn) {
            if (!catalog.supported) {
                return false;
            }
            try {
                conn.setCatalog(catalog.value);
                return true;
            } catch (SQLException | UnsupportedOperationException | AbstractMethodError ignored) {
                return false;
            }
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
