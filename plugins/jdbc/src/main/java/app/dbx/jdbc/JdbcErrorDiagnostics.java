package app.dbx.jdbc;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.SQLRecoverableException;
import java.sql.SQLTimeoutException;
import java.sql.SQLTransientConnectionException;

/** Typed diagnostics only; native messages may contain job bodies or connection details. */
final class JdbcErrorDiagnostics {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private JdbcErrorDiagnostics() { }

    private static SQLException sqlError(Throwable cause) {
        for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
            if (cause instanceof SQLException sql) return sql;
        }
        return null;
    }

    static void appendSql(ObjectNode target, Throwable cause) {
        SQLException sql = sqlError(cause);
        if (sql == null) return;
        if (sql.getErrorCode() != 0) target.put("vendorCode", sql.getErrorCode());
        String state = sql.getSQLState();
        if (state != null && state.matches("[A-Z0-9]{5}")) target.put("sqlState", state);
    }

    static ObjectNode queryFailure(Throwable cause) {
        SQLException sql = sqlError(cause);
        String category = "protocol";
        if (sql != null) {
            category = sql instanceof SQLTimeoutException ? "timeout"
                : sql instanceof SQLRecoverableException || sql instanceof SQLTransientConnectionException
                    || sql instanceof SQLNonTransientConnectionException
                    || (sql.getSQLState() != null && sql.getSQLState().startsWith("08")) ? "connection" : "sql";
        }
        ObjectNode diagnostics = MAPPER.createObjectNode().put("category", category);
        appendSql(diagnostics, cause);
        ObjectNode result = MAPPER.createObjectNode().put("execution_error", true);
        result.putObject("error").set("diagnostics", diagnostics);
        return result;
    }
}
