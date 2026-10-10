package com.dbx.agent.oceanbaseoracle;

import com.oceanbase.jdbc.OceanBaseStatement;
import com.dbx.agent.BlobBoundExecutor;
import java.sql.SQLException;
import java.sql.Statement;

final class OceanBaseLobStatements {
    private OceanBaseLobStatements() { }

    static final BlobBoundExecutor.PreparedStatementConfigurer BINDING = new BlobBoundExecutor.PreparedStatementConfigurer() {
        @Override public void configure(java.sql.PreparedStatement statement) throws SQLException {
            OceanBaseLobStatements.configure(statement);
        }
        @Override public boolean isRollbackConfirmedBusinessError(SQLException error) {
            if (!(error instanceof java.sql.SQLTransientConnectionException)
                || error.getErrorCode() != 20001 || !"HY000".equals(error.getSQLState())) return false;
            for (Throwable cause = error.getCause(); cause != null; cause = cause.getCause()) {
                if (cause instanceof java.sql.SQLRecoverableException || cause instanceof java.sql.SQLTimeoutException
                    || cause instanceof SQLException sql && sql.getSQLState() != null && sql.getSQLState().startsWith("08")) return false;
            }
            return true;
        }
        @Override public boolean isUnsupportedSavepointRelease(SQLException error) {
            // OB Oracle mode rejects release locally; the transaction end releases its savepoints.
            return error.getErrorCode() == 17023 && "99999".equals(error.getSQLState())
                && !(error instanceof java.sql.SQLTimeoutException)
                && !(error instanceof java.sql.SQLRecoverableException);
        }
    };

    static void configure(Statement statement) throws SQLException {
        OceanBaseStatement vendor;
        try {
            vendor = statement instanceof OceanBaseStatement ? (OceanBaseStatement) statement
                : statement.unwrap(OceanBaseStatement.class);
        } catch (SQLException error) {
            throw new SQLException("Unsupported OceanBase LOB statement", error);
        }
        if (vendor == null) throw new SQLException("Unsupported OceanBase LOB statement");
        // Set only the native LOB mode; binding, cancellation and close retain the pool proxy.
        vendor.setInternal();
    }
}
