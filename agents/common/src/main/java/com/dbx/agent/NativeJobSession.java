package com.dbx.agent;

import com.google.gson.JsonObject;
import java.sql.Connection;
import java.util.UUID;

/** Owns only the connection; Core owns native configuration phases, SQL and dispatch deduplication. */
final class NativeJobSession {
    private final AbstractJdbcAgent agent;
    private final String operationId;
    private final String token = UUID.randomUUID().toString();
    private final JsonObject receipt = new JsonObject();
    private Connection owned;
    private boolean closeAttempted;

    NativeJobSession(AbstractJdbcAgent agent, String operationId) {
        this.agent = agent;
        this.operationId = operationId;
        receipt.addProperty("operationId", operationId);
        receipt.addProperty("sessionToken", token);
        receipt.addProperty("phase", "not_started");
    }

    static String operationId(JsonObject params) {
        String id = text(params, "operationId");
        if (id.isEmpty() || id.length() > 128 || id.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("native_job_request_invalid");
        }
        return id;
    }

    static boolean isControl(String method) {
        return AgentProtocol.METHOD_OPEN_NATIVE_JOB_SESSION.equals(method)
            || AgentProtocol.METHOD_CLOSE_NATIVE_JOB_SESSION.equals(method);
    }

    void open() throws Exception {
        try {
            owned = agent.openNativeJobConnection();
            receipt.addProperty("phase", "opened");
        } catch (Exception | LinkageError error) {
            if (JdbcConnectionPoolRegistry.requiresRuntimeReplacement(error)) {
                closeAttempted = true;
                receipt.addProperty("phase", "unknown");
                receipt.addProperty("reason", "native_job_session_open_unknown");
            }
            throw error;
        }
    }

    JsonObject openedFor(String id) throws Exception {
        requireOperation(id);
        if ("opened".equals(receipt.get("phase").getAsString())) requireOwnedConnection();
        return receipt.deepCopy();
    }

    void authorize(String method, JsonObject params) throws Exception {
        if (!AgentProtocol.METHOD_EXECUTE_QUERY.equals(method) && !AgentProtocol.METHOD_CONNECTION_INFO.equals(method)) {
            throw new IllegalStateException("native_job_session_reserved");
        }
        requireOperation(text(params, "nativeJobOperationId"));
        if (!token.equals(text(params, "nativeJobSessionToken"))) {
            throw new IllegalStateException("native_job_session_token_invalid");
        }
        requireOwnedConnection();
    }

    private void requireOperation(String id) {
        if (!operationId.equals(id)) throw new IllegalStateException("native_job_operation_mismatch");
    }

    private void requireOwnedConnection() throws Exception {
        if (!"opened".equals(receipt.get("phase").getAsString())
            || owned == null || agent.getConnection() != owned || owned.isClosed()) {
            throw new IllegalStateException("native_job_session_unavailable");
        }
    }

    JsonObject close(JsonObject params) {
        requireOperation(operationId(params));
        String requestedToken = text(params, "sessionToken");
        // The known operation may dispose its own connection after losing the open receipt.
        if (!requestedToken.isEmpty() && !token.equals(requestedToken)) {
            throw new IllegalStateException("native_job_session_token_invalid");
        }
        return dispose();
    }

    JsonObject dispose() {
        if (closeAttempted) return receipt.deepCopy();
        closeAttempted = true;
        try {
            agent.closeNativeJobConnection();
            receipt.addProperty("phase", "closed");
        } catch (Exception | LinkageError error) {
            receipt.addProperty("phase", "unknown");
            receipt.addProperty("reason", "native_job_session_dispose_unknown");
            JsonObject diagnostics = AgentRpcError.toJson(error, AgentProtocol.METHOD_CLOSE_NATIVE_JOB_SESSION, null)
                .getAsJsonObject("data");
            if (diagnostics.has("vendorCode")) receipt.add("vendorCode", diagnostics.get("vendorCode"));
        }
        return receipt.deepCopy();
    }

    boolean openOutcomeUnknown() {
        return "unknown".equals(receipt.get("phase").getAsString());
    }

    private static String text(JsonObject params, String key) {
        if (!params.has(key) || params.get(key).isJsonNull()) return "";
        if (!params.get(key).isJsonPrimitive() || !params.getAsJsonPrimitive(key).isString()) {
            throw new IllegalArgumentException("native_job_request_invalid");
        }
        return params.get(key).getAsString();
    }
}
