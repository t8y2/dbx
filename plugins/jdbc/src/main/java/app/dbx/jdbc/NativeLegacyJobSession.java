package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.util.Objects;

/** One confirmed native SUBMIT, separate from the editor's transaction and cursors. */
final class NativeLegacyJobSession {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss")
        .withResolverStyle(ResolverStyle.STRICT);
    private final String operationId;
    private final String what;
    private final String nextDate;
    private final String interval;
    private final boolean enabled;
    private final long instance;
    private final String dialect;
    private final String zone;
    private final String schema;
    private final int timeoutSecs;
    private final ObjectNode result;
    private Connection connection;
    private boolean transactionActive;
    private boolean disposalConfirmed = true;

    static final class InvalidRequest extends RuntimeException {
        final String reason;

        InvalidRequest(String reason) {
            super(reason);
            this.reason = reason;
        }
    }

    // Do not use a record: its generated toString would include the job body.
    NativeLegacyJobSession(JsonNode request) {
        operationId = text(request, "operationId", "");
        what = text(request, "what", "");
        nextDate = text(request, "nextDate", "");
        interval = text(request, "interval", "");
        schema = text(request, "schema", "");
        dialect = text(request, "dialect", "oracle");
        zone = request.hasNonNull("zone") ? text(request, "zone", "") : null;
        if (operationId.isEmpty() || operationId.length() > 128 || operationId.indexOf('\0') >= 0
            || schema.indexOf('\0') >= 0 || !request.path("enabled").isBoolean()) {
            throw new InvalidRequest("native_job_request_invalid");
        }
        enabled = request.path("enabled").asBoolean();
        JsonNode instanceValue = request.path("instance");
        JsonNode timeoutValue = request.path("timeoutSecs");
        if ((!instanceValue.isMissingNode() && (!instanceValue.isIntegralNumber() || !instanceValue.canConvertToLong()))
            || (!timeoutValue.isMissingNode() && (!timeoutValue.isIntegralNumber() || !timeoutValue.canConvertToInt()))) {
            throw new InvalidRequest("native_job_request_invalid");
        }
        instance = instanceValue.asLong(0);
        timeoutSecs = timeoutValue.asInt(0);
        if (instance < 0 || timeoutSecs < 0
            || (!dialect.equals("oracle") && !dialect.equals("oceanbase-oracle"))
            || (oceanbase() ? instance != 0 || (zone != null && (zone.isEmpty() || zone.indexOf('\0') >= 0)) : zone != null)) {
            throw new InvalidRequest("native_job_request_invalid");
        }
        if (what.isBlank()) throw new InvalidRequest("native_job_action_required");
        try {
            if (!nextDate.matches("[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}")
                || LocalDateTime.parse(nextDate, DATE).getYear() < 1) {
                throw new InvalidRequest("native_job_date_invalid");
            }
        } catch (DateTimeParseException error) {
            throw new InvalidRequest("native_job_date_invalid");
        }
        result = failure(operationId, "not_started", null, null);
    }

    private static String text(JsonNode request, String key, String fallback) {
        JsonNode value = request.path(key);
        if (value.isMissingNode() || value.isNull()) return fallback;
        if (!value.isTextual()) throw new InvalidRequest("native_job_request_invalid");
        return value.textValue();
    }

    static boolean isMethod(String method) {
        return switch (method) {
            case "prepareLegacyJob", "prepare_legacy_job", "commitLegacyJob", "commit_legacy_job",
                "rollbackLegacyJob", "rollback_legacy_job", "legacyJobStatus", "legacy_job_status" -> true;
            default -> false;
        };
    }

    static boolean isPrepare(String method) {
        return "prepareLegacyJob".equals(method) || "prepare_legacy_job".equals(method);
    }

    boolean sameRequest(NativeLegacyJobSession other) {
        return operationId.equals(other.operationId) && what.equals(other.what) && nextDate.equals(other.nextDate)
            && interval.equals(other.interval) && enabled == other.enabled && instance == other.instance
            && schema.equals(other.schema) && timeoutSecs == other.timeoutSecs
            && dialect.equals(other.dialect) && Objects.equals(zone, other.zone);
    }

    private boolean oceanbase() { return dialect.equals("oceanbase-oracle"); }

    static ObjectNode failure(String operationId, String phase, String reason, Throwable cause) {
        ObjectNode result = MAPPER.createObjectNode().put("operationId", operationId).put("phase", phase);
        if (reason != null) result.put("reason", reason);
        diagnostics(result, cause);
        return result;
    }

    private static void diagnostics(ObjectNode result, Throwable cause) {
        JdbcErrorDiagnostics.appendSql(result, cause);
    }

    void openFailed(Throwable cause) {
        result.put("reason", "native_job_session_open_failed");
        diagnostics(result, cause);
    }

    ObjectNode status(String requestedOperation) {
        if (!operationId.equals(requestedOperation)) {
            return failure(requestedOperation, "unknown", "native_job_session_unavailable", null);
        }
        return result.deepCopy();
    }

    void prepare(Connection ownedConnection) {
        connection = ownedConnection;
        String reason = "native_job_dialect_unverified";
        try {
            var metadata = connection.getMetaData();
            if (metadata == null || !(oceanbase() ? "OceanBase" : "Oracle").equalsIgnoreCase(metadata.getDatabaseProductName())) {
                result.put("reason", reason);
                closeConnection();
                return;
            }
            reason = "native_job_schema_not_selected";
            if (!schema.isEmpty()) {
                try (Statement statement = connection.createStatement()) {
                    statement.setQueryTimeout(timeoutSecs);
                    statement.execute("ALTER SESSION SET CURRENT_SCHEMA = \"" + schema.replace("\"", "\"\"") + "\"");
                }
            }
            reason = "native_job_transaction_not_started";
            connection.setAutoCommit(false);
            transactionActive = true;
            String sessionUser = null;
            if (oceanbase()) {
                reason = "native_job_initial_identity_unverified";
                try (PreparedStatement statement = connection.prepareStatement("SELECT USER AS DBX_SESSION_USER FROM DUAL")) {
                    statement.setQueryTimeout(timeoutSecs);
                    try (ResultSet rows = statement.executeQuery()) {
                        if (rows.next()) sessionUser = rows.getString(1);
                        if (sessionUser == null || sessionUser.isEmpty() || rows.next()) {
                            rollback(reason, null);
                            return;
                        }
                    }
                }
            }
            result.put("phase", "submitting");
            reason = "native_job_submit_failed";
            String placement = oceanbase() ? "zone" : "instance";
            try (CallableStatement statement = connection.prepareCall("""
                DECLARE native_id BINARY_INTEGER;
                BEGIN
                  SYS.DBMS_JOB.SUBMIT(job => native_id, what => ?, next_date => TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS'), interval => ?, no_parse => FALSE, %s => ?, force => FALSE);
                  ? := TO_CHAR(native_id);
                END;
                """.formatted(placement))) {
                statement.setQueryTimeout(timeoutSecs);
                statement.setString(1, what);
                statement.setString(2, nextDate);
                statement.setString(3, interval);
                if (oceanbase()) {
                    if (zone == null) statement.setNull(4, Types.VARCHAR);
                    else statement.setString(4, zone);
                } else statement.setLong(4, instance);
                statement.registerOutParameter(5, Types.VARCHAR);
                statement.execute();
                reason = "native_job_out_read_failed";
                String id = statement.getString(5);
                if (numericId(id)) result.put("jobId", id);
            }
            if (!result.has("jobId")) {
                rollback("native_job_out_id_unverified", null);
                return;
            }
            result.put("phase", "configuring");
            reason = "native_job_initial_state_failed";
            try (CallableStatement statement = connection.prepareCall(
                "BEGIN SYS.DBMS_JOB.BROKEN(TO_NUMBER(?), ? = 1, TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')); END;")) {
                statement.setQueryTimeout(timeoutSecs);
                statement.setString(1, result.path("jobId").asText());
                statement.setInt(2, enabled ? 0 : 1);
                statement.setString(3, nextDate);
                statement.execute();
            }
            if (oceanbase()) {
                // OB BROKEN(TRUE) replaces NEXT_DATE even when the requested date is supplied.
                try (CallableStatement statement = connection.prepareCall(
                    "BEGIN SYS.DBMS_JOB.NEXT_DATE(TO_NUMBER(?), TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')); END;")) {
                    statement.setQueryTimeout(timeoutSecs);
                    statement.setString(1, result.path("jobId").asText());
                    statement.setString(2, nextDate);
                    statement.execute();
                }
            }
            reason = "native_job_initial_read_failed";
            boolean verified;
            try (PreparedStatement statement = connection.prepareStatement("""
                SELECT TO_CHAR(JOB), WHAT, TO_CHAR(NEXT_DATE, 'YYYY-MM-DD HH24:MI:SS'), INTERVAL,
                  BROKEN, %s, LOG_USER, PRIV_USER, SCHEMA_USER
                FROM SYS.USER_JOBS WHERE JOB = TO_NUMBER(?)
                """.formatted(oceanbase() ? "INSTANCE" : "TO_CHAR(INSTANCE)"))) {
                statement.setQueryTimeout(timeoutSecs);
                statement.setString(1, result.path("jobId").asText());
                try (ResultSet rows = statement.executeQuery()) {
                    verified = rows.next() && result.path("jobId").asText().equals(rows.getString(1))
                        && what.equals(rows.getString(2)) && nextDate.equals(rows.getString(3))
                        && interval.equals(Objects.requireNonNullElse(rows.getString(4), ""))
                        && (enabled ? "N" : "Y").equals(rows.getString(5))
                        && (oceanbase() ? Objects.equals(zone, rows.getString(6)) : Long.toString(instance).equals(rows.getString(6)))
                        && (!oceanbase() || (sessionUser.equals(rows.getString(7)) && sessionUser.equals(rows.getString(8))))
                        && (schema.isEmpty() || schema.equals(rows.getString(9))) && !rows.next();
                }
            }
            if (!verified) {
                rollback("native_job_initial_state_unverified", null);
                return;
            }
            result.put("phase", "prepared");
        } catch (SQLException | RuntimeException | LinkageError error) {
            if (transactionActive) {
                rollback(reason, error);
            } else {
                result.put("reason", reason);
                diagnostics(result, error);
                closeConnection();
            }
        }
    }

    ObjectNode finish(String requestedOperation, String id, boolean commit) {
        if (!operationId.equals(requestedOperation)) return status(requestedOperation);
        if (!"prepared".equals(result.path("phase").asText())) return status(operationId);
        if ((commit || !id.isEmpty()) && (!numericId(id) || !id.equals(result.path("jobId").asText()))) {
            return failure(operationId, "unknown", "native_job_identity_mismatch", null);
        }
        if (!commit) {
            rollback("native_job_canceled_before_commit", null);
            return status(operationId);
        }
        result.put("phase", "commit_sent");
        // Once COMMIT is sent, disposal must not issue another COMMIT or ROLLBACK.
        transactionActive = false;
        try {
            connection.commit();
            result.put("phase", "committed");
        } catch (SQLException | RuntimeException | LinkageError error) {
            result.put("phase", "unknown").put("reason", "native_job_commit_unknown");
            diagnostics(result, error);
        } finally {
            closeConnection();
        }
        return status(operationId);
    }

    private void rollback(String reason, Throwable cause) {
        result.put("reason", reason);
        diagnostics(result, cause);
        transactionActive = false;
        try {
            connection.rollback();
            result.put("phase", "rolled_back");
        } catch (SQLException | RuntimeException | LinkageError error) {
            result.put("phase", "unknown").put("reason", "native_job_rollback_unknown");
            diagnostics(result, error);
            disposalConfirmed = false;
        } finally {
            closeConnection();
        }
    }

    void dispose() {
        if (transactionActive) rollback("native_job_session_closed_before_commit", null);
        else closeConnection();
    }

    boolean disposalConfirmed() {
        return disposalConfirmed;
    }

    private void closeConnection() {
        Connection owned = connection;
        connection = null;
        if (owned == null) return;
        try {
            owned.close();
        } catch (SQLException | RuntimeException | LinkageError error) {
            disposalConfirmed = false;
            diagnostics(result, error);
        }
        if (oceanbase()) result.put("disposalConfirmed", disposalConfirmed);
    }

    private static boolean numericId(String id) {
        return id != null && id.matches("[1-9][0-9]*");
    }
}
