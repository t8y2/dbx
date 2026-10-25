package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.UUID;

/** Connection ownership only: native SQL, configuration phases and dispatch deduplication stay in Core. */
final class NativeJobSession {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final String operationId;
    private final String connectionKey;
    private final String token = UUID.randomUUID().toString();
    private final ObjectNode receipt;
    private Connection owned;
    private boolean closeAttempted;

    static final class ProtocolFailure extends SQLException {
        final String reason;
        final boolean notStarted;

        ProtocolFailure(String reason, boolean notStarted) {
            super(reason);
            this.reason = reason;
            this.notStarted = notStarted;
        }
    }

    NativeJobSession(JsonNode params, String connectionKey) throws ProtocolFailure {
        operationId = operationId(params);
        this.connectionKey = connectionKey;
        receipt = failure(operationId, "not_started", null, null);
        receipt.put("sessionToken", token);
    }

    static String operationId(JsonNode params) throws ProtocolFailure {
        String id = text(params, "operationId");
        if (id.isEmpty() || id.length() > 128 || id.indexOf('\0') >= 0) {
            throw new ProtocolFailure("native_job_request_invalid", true);
        }
        return id;
    }

    static boolean isOpen(String method) {
        return "openNativeJobSession".equals(method) || "open_native_job_session".equals(method);
    }

    static boolean isClose(String method) {
        return "closeNativeJobSession".equals(method) || "close_native_job_session".equals(method);
    }

    static boolean isControl(String method) {
        return isOpen(method) || isClose(method);
    }

    static String sql(JsonNode params) throws ProtocolFailure {
        String sql = text(params, "sql");
        if (sql.isBlank()) throw new ProtocolFailure("native_job_request_invalid", true);
        return sql;
    }

    static ObjectNode failure(String operationId, String phase, String reason, Throwable cause) {
        ObjectNode result = MAPPER.createObjectNode().put("operationId", operationId).put("phase", phase);
        if (reason != null) result.put("reason", reason);
        JdbcErrorDiagnostics.appendSql(result, cause);
        return result;
    }

    void open(Connection connection) {
        owned = connection;
        try {
            owned.setAutoCommit(false);
            receipt.put("phase", "opened");
        } catch (SQLException | RuntimeException | LinkageError error) {
            openFailed(connection, error);
        }
    }

    void openFailed(Connection connection, Throwable error) {
        owned = connection;
        receipt.put("reason", "native_job_session_open_failed");
        JdbcErrorDiagnostics.appendSql(receipt, error);
        dispose();
    }

    void authorize(String method, JsonNode params, String key) throws SQLException {
        if (isClose(method)) return;
        if (!connectionKey.equals(key)) throw new ProtocolFailure("native_job_connection_changed", true);
        if (isOpen(method)) return;
        if (!"executeQuery".equals(method) && !"connectionInfo".equals(method)) {
            throw new ProtocolFailure("native_job_session_reserved", true);
        }
        requireOperation(text(params, "nativeJobOperationId"));
        if (!token.equals(text(params, "nativeJobSessionToken"))) {
            throw new ProtocolFailure("native_job_session_token_invalid", true);
        }
        connection();
    }

    ObjectNode openedFor(String id) throws SQLException {
        requireOperation(id);
        if ("opened".equals(receipt.path("phase").asText())) connection();
        return receipt.deepCopy();
    }

    Connection connection() throws SQLException {
        if (!"opened".equals(receipt.path("phase").asText()) || owned == null || owned.isClosed()) {
            throw new ProtocolFailure("native_job_session_unavailable", true);
        }
        return owned;
    }

    ObjectNode close(JsonNode params) throws SQLException {
        requireOperation(operationId(params));
        String requestedToken = text(params, "sessionToken");
        if (!requestedToken.isEmpty() && !token.equals(requestedToken)) {
            throw new ProtocolFailure("native_job_session_token_invalid", true);
        }
        return dispose();
    }

    ObjectNode dispose() {
        if (closeAttempted) return receipt.deepCopy();
        closeAttempted = true;
        Connection connection = owned;
        owned = null;
        try {
            if (connection != null) connection.close();
            receipt.put("phase", "closed");
        } catch (SQLException | RuntimeException | LinkageError error) {
            receipt.put("phase", "unknown").put("reason", "native_job_session_dispose_unknown");
            JdbcErrorDiagnostics.appendSql(receipt, error);
        }
        return receipt.deepCopy();
    }

    boolean disposalConfirmed() {
        return closeAttempted && "closed".equals(receipt.path("phase").asText());
    }

    private void requireOperation(String id) throws ProtocolFailure {
        if (!operationId.equals(id)) throw new ProtocolFailure("native_job_operation_mismatch", true);
    }

    private static String text(JsonNode params, String key) throws ProtocolFailure {
        JsonNode value = params.path(key);
        if (value.isMissingNode() || value.isNull()) return "";
        if (!value.isTextual()) throw new ProtocolFailure("native_job_request_invalid", true);
        return value.textValue();
    }
}
