package com.dbx.agent;

import com.google.gson.JsonObject;

import java.sql.SQLException;
import java.sql.SQLRecoverableException;
import java.sql.SQLTransientConnectionException;
import java.util.Locale;

final class AgentRpcError extends RuntimeException {
    private final String category;
    private final boolean retryable;
    private final String disposition;
    private final String stage;

    private AgentRpcError(
        String message,
        String category,
        boolean retryable,
        String disposition,
        String stage,
        Throwable cause
    ) {
        super(message, cause);
        this.category = category;
        this.retryable = retryable;
        this.disposition = disposition;
        this.stage = stage;
    }

    static AgentRpcError resource(String stage, Throwable cause) {
        return new AgentRpcError(
            "Agent runtime resource limit reached",
            "resource",
            false,
            "replace_runtime",
            stage,
            cause
        );
    }

    static AgentRpcError backpressure(String stage, Throwable cause) {
        return new AgentRpcError(
            "Agent request capacity is temporarily exhausted",
            "resource",
            true,
            "keep",
            stage,
            cause
        );
    }

    static JsonObject toJson(Throwable error, String method, String agentSessionId) {
        AgentRpcError classified = classify(error, method);
        JsonObject rpcError = new JsonObject();
        rpcError.addProperty("code", -1);
        rpcError.addProperty("message", message(error));
        JsonObject data = new JsonObject();
        data.addProperty("category", classified.category);
        data.addProperty("retryable", classified.retryable);
        data.addProperty("sessionDisposition", classified.disposition);
        data.addProperty("stage", classified.stage);
        if (agentSessionId != null && !agentSessionId.trim().isEmpty()) {
            data.addProperty("agentSessionId", agentSessionId);
        }
        rpcError.add("data", data);
        return rpcError;
    }

    private static AgentRpcError classify(Throwable error, String method) {
        AgentRpcError explicit = find(error, AgentRpcError.class);
        if (explicit != null) {
            return explicit;
        }
        SQLException sqlError = find(error, SQLException.class);
        if (sqlError != null) {
            String sqlState = sqlError.getSQLState();
            String stage = stage(method);
            boolean connectionError = "connect".equals(stage)
                || "validate".equals(stage)
                || sqlError instanceof SQLRecoverableException
                || sqlError instanceof SQLTransientConnectionException
                || (sqlState != null && sqlState.toUpperCase(Locale.ROOT).startsWith("08"));
            boolean operationRetryable = connectionError && ("connect".equals(stage) || "validate".equals(stage));
            String disposition = connectionError && !"connect".equals(stage) ? "quarantine" : "keep";
            return new AgentRpcError(
                message(error),
                connectionError ? "connection" : "sql",
                operationRetryable,
                disposition,
                stage,
                error
            );
        }
        return new AgentRpcError(message(error), "protocol", false, "keep", stage(method), error);
    }

    private static String stage(String method) {
        if (method == null) {
            return "request";
        }
        if (AgentProtocol.METHOD_CONNECT.equals(method) || AgentProtocol.METHOD_OPEN_SESSION.equals(method)) {
            return "connect";
        }
        if (AgentProtocol.METHOD_VALIDATE_CONNECTION.equals(method) || AgentProtocol.METHOD_VALIDATE_SESSION.equals(method)) {
            return "validate";
        }
        if (AgentProtocol.METHOD_CANCEL_SESSION.equals(method)) {
            return "cancel";
        }
        if (AgentProtocol.METHOD_CLOSE_SESSION.equals(method) || AgentProtocol.METHOD_DISCONNECT.equals(method)) {
            return "close";
        }
        if (AgentProtocol.METHOD_FETCH_QUERY_PAGE.equals(method)
            || AgentProtocol.METHOD_FETCH_TABLE_READ_PAGE.equals(method)) {
            return "fetch";
        }
        return "execute";
    }

    private static String message(Throwable error) {
        return error.getMessage() == null ? error.toString() : error.getMessage();
    }

    private static <T extends Throwable> T find(Throwable error, Class<T> type) {
        Throwable current = error;
        while (current != null) {
            if (type.isInstance(current)) {
                return type.cast(current);
            }
            current = current.getCause();
        }
        return null;
    }
}
