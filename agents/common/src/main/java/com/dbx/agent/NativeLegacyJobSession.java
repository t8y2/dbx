package com.dbx.agent;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Types;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.util.Objects;

/** Owns one OB SUBMIT transaction until Core records its OUT ID and authorizes the first commit. */
final class NativeLegacyJobSession {
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss")
        .withResolverStyle(ResolverStyle.STRICT);
    private final AbstractJdbcAgent agent;
    private final String operationId;
    private final String what;
    private final String nextDate;
    private final String interval;
    private final String schema;
    private final String zone;
    private final boolean enabled;
    private final int timeoutSecs;
    private final JsonObject receipt;
    private Connection connection;
    private boolean transactionActive;
    private boolean closeAttempted;
    private boolean disposalConfirmed = true;

    NativeLegacyJobSession(AbstractJdbcAgent agent, JsonObject params) {
        this.agent = agent;
        operationId = NativeJobSession.operationId(params);
        what = text(params, "what", "");
        nextDate = text(params, "nextDate", "");
        interval = text(params, "interval", "");
        schema = text(params, "schema", "");
        zone = params.has("zone") && !params.get("zone").isJsonNull() ? text(params, "zone", "") : null;
        if (!"oceanbase-oracle".equals(text(params, "dialect", "")) || integer(params, "instance") != 0
            || what.isBlank() || what.indexOf('\0') >= 0 || interval.indexOf('\0') >= 0 || schema.indexOf('\0') >= 0
            || (zone != null && (zone.isEmpty() || zone.indexOf('\0') >= 0))
            || !params.has("enabled") || !params.get("enabled").isJsonPrimitive()
            || !params.getAsJsonPrimitive("enabled").isBoolean()) {
            throw new IllegalArgumentException("native_job_request_invalid");
        }
        enabled = params.get("enabled").getAsBoolean();
        timeoutSecs = integer(params, "timeoutSecs");
        try {
            if (!nextDate.matches("[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}")
                || LocalDateTime.parse(nextDate, DATE).getYear() < 1) throw new IllegalArgumentException();
        } catch (RuntimeException invalid) {
            throw new IllegalArgumentException("native_job_date_invalid");
        }
        receipt = failure(operationId, "not_started", null);
    }

    static boolean isControl(String method) {
        return AgentProtocol.NATIVE_JOB_LEGACY_METHODS.contains(method);
    }

    static JsonObject failure(String operationId, String phase, String reason) {
        JsonObject result = new JsonObject();
        result.addProperty("operationId", operationId);
        result.addProperty("phase", phase);
        if (reason != null) result.addProperty("reason", reason);
        return result;
    }

    boolean sameRequest(NativeLegacyJobSession other) {
        return operationId.equals(other.operationId) && what.equals(other.what) && nextDate.equals(other.nextDate)
            && interval.equals(other.interval) && schema.equals(other.schema) && Objects.equals(zone, other.zone)
            && enabled == other.enabled && timeoutSecs == other.timeoutSecs;
    }

    void prepare() {
        String reason = "native_job_session_open_failed";
        try {
            connection = agent.openNativeJobConnection();
            reason = "native_job_dialect_unverified";
            if (!"OceanBase".equalsIgnoreCase(connection.getMetaData().getDatabaseProductName())) {
                receipt.addProperty("reason", reason);
                close();
                return;
            }
            transactionActive = true;
            reason = "native_job_schema_not_selected";
            if (!schema.isEmpty()) {
                try (var statement = connection.createStatement()) {
                    statement.setQueryTimeout(timeoutSecs);
                    statement.execute("ALTER SESSION SET CURRENT_SCHEMA = \"" + schema.replace("\"", "\"\"") + "\"");
                }
            }
            reason = "native_job_initial_identity_unverified";
            String user;
            try (PreparedStatement statement = connection.prepareStatement("SELECT USER AS DBX_SESSION_USER FROM DUAL")) {
                statement.setQueryTimeout(timeoutSecs);
                try (ResultSet rows = statement.executeQuery()) {
                    if (!rows.next()) throw new IllegalStateException(reason);
                    user = rows.getString(1);
                    if (user == null || user.isEmpty() || rows.next()) throw new IllegalStateException(reason);
                }
            }
            receipt.addProperty("phase", "submitting");
            reason = "native_job_submit_failed";
            try (CallableStatement statement = connection.prepareCall("""
                DECLARE native_id BINARY_INTEGER;
                BEGIN
                  SYS.DBMS_JOB.SUBMIT(job => native_id, what => ?, next_date => TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS'), interval => ?, no_parse => FALSE, zone => ?, force => FALSE);
                  ? := TO_CHAR(native_id);
                END;
                """)) {
                statement.setQueryTimeout(timeoutSecs);
                statement.setString(1, what);
                statement.setString(2, nextDate);
                statement.setString(3, interval);
                if (zone == null) statement.setNull(4, Types.VARCHAR);
                else statement.setString(4, zone);
                statement.registerOutParameter(5, Types.VARCHAR);
                statement.execute();
                reason = "native_job_out_read_failed";
                String id = statement.getString(5);
                if (numericId(id)) receipt.addProperty("jobId", id);
            }
            if (!receipt.has("jobId")) {
                rollback("native_job_out_id_unverified", null);
                return;
            }
            receipt.addProperty("phase", "configuring");
            reason = "native_job_initial_state_failed";
            try (CallableStatement statement = connection.prepareCall(
                "BEGIN SYS.DBMS_JOB.BROKEN(TO_NUMBER(?), ? = 1, TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')); END;")) {
                statement.setQueryTimeout(timeoutSecs);
                statement.setString(1, receipt.get("jobId").getAsString());
                statement.setInt(2, enabled ? 0 : 1);
                statement.setString(3, nextDate);
                statement.execute();
            }
            // OB BROKEN(TRUE) replaces NEXT_DATE with 4000-01-01 even when a date is supplied.
            try (CallableStatement statement = connection.prepareCall(
                "BEGIN SYS.DBMS_JOB.NEXT_DATE(TO_NUMBER(?), TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')); END;")) {
                statement.setQueryTimeout(timeoutSecs);
                statement.setString(1, receipt.get("jobId").getAsString());
                statement.setString(2, nextDate);
                statement.execute();
            }
            reason = "native_job_initial_read_failed";
            boolean verified;
            try (PreparedStatement statement = connection.prepareStatement("""
                SELECT TO_CHAR(JOB), WHAT, TO_CHAR(NEXT_DATE, 'YYYY-MM-DD HH24:MI:SS'), INTERVAL,
                  BROKEN, INSTANCE, LOG_USER, PRIV_USER, SCHEMA_USER
                FROM SYS.USER_JOBS WHERE JOB = TO_NUMBER(?)
                """)) {
                statement.setQueryTimeout(timeoutSecs);
                statement.setString(1, receipt.get("jobId").getAsString());
                try (ResultSet rows = statement.executeQuery()) {
                    verified = rows.next() && receipt.get("jobId").getAsString().equals(rows.getString(1))
                        && what.equals(rows.getString(2)) && nextDate.equals(rows.getString(3))
                        && interval.equals(Objects.requireNonNullElse(rows.getString(4), ""))
                        && (enabled ? "N" : "Y").equals(rows.getString(5)) && Objects.equals(zone, rows.getString(6))
                        && user.equals(rows.getString(7)) && user.equals(rows.getString(8))
                        && (schema.isEmpty() || schema.equals(rows.getString(9))) && !rows.next();
                }
            }
            if (!verified) {
                rollback("native_job_initial_state_unverified", null);
                return;
            }
            receipt.addProperty("phase", "prepared");
        } catch (Exception | LinkageError error) {
            if (transactionActive) rollback(reason, error);
            else {
                receipt.addProperty("reason", reason);
                diagnostics(error);
                if (connection == null) {
                    boolean unknown = JdbcConnectionPoolRegistry.requiresRuntimeReplacement(error);
                    receipt.addProperty("phase", unknown ? "unknown" : "not_started");
                    receipt.addProperty("disposalConfirmed", !unknown);
                    disposalConfirmed = !unknown;
                    closeAttempted = true;
                } else close();
            }
        }
    }

    JsonObject status(String id) {
        return operationId.equals(id) ? receipt.deepCopy()
            : failure(id, "unknown", "native_job_session_unavailable");
    }

    JsonObject finish(String operation, String id, boolean commit) {
        if (!operationId.equals(operation) || !"prepared".equals(receipt.get("phase").getAsString())) return status(operation);
        if ((commit || !id.isEmpty()) && (!numericId(id) || !id.equals(receipt.get("jobId").getAsString()))) {
            return failure(operation, "unknown", "native_job_identity_mismatch");
        }
        if (!commit) {
            rollback("native_job_canceled_before_commit", null);
            return status(operation);
        }
        receipt.addProperty("phase", "commit_sent");
        transactionActive = false;
        try {
            connection.commit();
            receipt.addProperty("phase", "committed");
        } catch (Exception | LinkageError error) {
            receipt.addProperty("phase", "unknown");
            receipt.addProperty("reason", "native_job_commit_unknown");
            diagnostics(error);
        } finally { close(); }
        return status(operation);
    }

    private void rollback(String reason, Throwable cause) {
        receipt.addProperty("reason", reason);
        diagnostics(cause);
        transactionActive = false;
        try {
            connection.rollback();
            receipt.addProperty("phase", "rolled_back");
        } catch (Exception | LinkageError error) {
            disposalConfirmed = false;
            receipt.addProperty("phase", "unknown");
            receipt.addProperty("reason", "native_job_rollback_unknown");
            diagnostics(error);
        } finally { close(); }
    }

    JsonObject dispose() {
        if (transactionActive) rollback("native_job_session_closed_before_commit", null);
        else close();
        return receipt.deepCopy();
    }

    private void close() {
        if (closeAttempted) return;
        closeAttempted = true;
        connection = null;
        try { agent.closeNativeJobConnection(); }
        catch (Exception | LinkageError error) {
            disposalConfirmed = false;
            diagnostics(error);
        }
        receipt.addProperty("disposalConfirmed", disposalConfirmed);
    }

    private void diagnostics(Throwable error) {
        if (error == null) return;
        JsonObject data = AgentRpcError.toJson(error, AgentProtocol.METHOD_PREPARE_LEGACY_JOB, null).getAsJsonObject("data");
        for (String field : new String[]{"vendorCode", "sqlState"}) {
            if (data.has(field)) receipt.add(field, data.get(field));
        }
    }

    private static boolean numericId(String id) { return id != null && id.matches("[1-9][0-9]*"); }
    private static String text(JsonObject params, String key, String fallback) {
        JsonElement value = params.get(key);
        if (value == null || value.isJsonNull()) return fallback;
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw new IllegalArgumentException("native_job_request_invalid");
        return value.getAsString();
    }
    private static int integer(JsonObject params, String key) {
        if (!params.has(key)) return 0;
        JsonElement value = params.get(key);
        try {
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber() || !value.getAsString().matches("0|[1-9][0-9]*")) throw new NumberFormatException();
            return Integer.parseInt(value.getAsString());
        } catch (RuntimeException invalid) { throw new IllegalArgumentException("native_job_request_invalid"); }
    }
}
