package com.dbx.agent;

import com.google.gson.JsonObject;

import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.sql.SQLRecoverableException;
import java.sql.SQLTransientConnectionException;
import java.util.Locale;
import java.util.concurrent.CancellationException;

final class AgentRpcError extends RuntimeException {
    private final String category;
    private final boolean retryable;
    private final String disposition;
    private final String stage;
    private final String operationOutcome;
    private final String sqlState;
    private final Integer vendorCode;
    private final String exceptionClass;

    private AgentRpcError(
        String message,
        String category,
        boolean retryable,
        String disposition,
        String stage,
        String operationOutcome,
        String sqlState,
        Integer vendorCode,
        String exceptionClass,
        Throwable cause
    ) {
        super(message, cause);
        this.category = category;
        this.retryable = retryable;
        this.disposition = disposition;
        this.stage = stage;
        this.operationOutcome = operationOutcome;
        this.sqlState = sqlState;
        this.vendorCode = vendorCode;
        this.exceptionClass = exceptionClass;
    }

    static AgentRpcError resource(String stage, Throwable cause) {
        return new AgentRpcError(
            "Agent runtime resource limit reached",
            "resource",
            false,
            "replace_runtime",
            stage,
            operationOutcome(stage),
            null,
            null,
            cause == null ? null : cause.getClass().getName(),
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
            operationOutcome(stage),
            null,
            null,
            cause == null ? null : cause.getClass().getName(),
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
        data.addProperty("contractVersion", 1);
        data.addProperty("operationOutcome", classified.operationOutcome);
        addDiagnostic(data, "sqlState", classified.sqlState);
        if (classified.vendorCode != null) {
            data.addProperty("vendorCode", classified.vendorCode);
        }
        addDiagnostic(data, "exceptionClass", classified.exceptionClass);
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
        String stage = stage(method);
        if (find(error, CancellationException.class) != null || find(error, InterruptedException.class) != null) {
            return new AgentRpcError(
                message(error),
                "canceled",
                false,
                "quarantine",
                stage,
                operationOutcome(stage),
                null,
                null,
                safeClassName(error),
                error
            );
        }
        SQLException sqlError = find(error, SQLException.class);
        if (sqlError != null) {
            String sqlState = sqlError.getSQLState();
            String category = sqlError instanceof SQLTimeoutException ? "timeout" : null;
            boolean connectionError = "connect".equals(stage)
                || "validate".equals(stage)
                || sqlError instanceof SQLRecoverableException
                || sqlError instanceof SQLTransientConnectionException
                || (sqlState != null && sqlState.toUpperCase(Locale.ROOT).startsWith("08"));
            boolean operationRetryable = connectionError && ("connect".equals(stage) || "validate".equals(stage));
            String disposition = category != null || (connectionError && !"connect".equals(stage)) ? "quarantine" : "keep";
            return new AgentRpcError(
                message(error),
                category == null ? (connectionError ? "connection" : "sql") : category,
                operationRetryable,
                disposition,
                stage,
                operationOutcome(stage),
                safeSqlState(sqlState),
                sqlError.getErrorCode(),
                safeClassName(sqlError),
                error
            );
        }
        return new AgentRpcError(
            message(error),
            "protocol",
            false,
            "keep",
            stage,
            operationOutcome(stage),
            null,
            null,
            safeClassName(error),
            error
        );
    }

    private static String stage(String method) {
        if (method == null) {
            return "request";
        }
        if (AgentProtocol.METHOD_HANDSHAKE.equals(method)) {
            return "request";
        }
        if (AgentProtocol.METHOD_CONNECT.equals(method)
            || AgentProtocol.METHOD_OPEN_SESSION.equals(method)
            || AgentProtocol.METHOD_TEST_CONNECTION.equals(method)) {
            return "connect";
        }
        if (AgentProtocol.METHOD_VALIDATE_CONNECTION.equals(method) || AgentProtocol.METHOD_VALIDATE_SESSION.equals(method)) {
            return "validate";
        }
        if (AgentProtocol.METHOD_CANCEL_SESSION.equals(method)) {
            return "cancel";
        }
        if (AgentProtocol.METHOD_CLOSE_SESSION.equals(method)
            || AgentProtocol.METHOD_DISCONNECT.equals(method)
            || AgentProtocol.METHOD_CLOSE_QUERY_SESSION.equals(method)
            || AgentProtocol.METHOD_CLOSE_TABLE_READ_SESSION.equals(method)
            || AgentProtocol.METHOD_SHUTDOWN.equals(method)) {
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

    private static String operationOutcome(String stage) {
        return switch (stage) {
            case "request", "checkout", "connect", "validate" -> "not_started";
            default -> "unknown";
        };
    }

    private static String safeSqlState(String sqlState) {
        return safeDiagnostic(sqlState, 16);
    }

    private static String safeClassName(Throwable error) {
        return error == null ? null : safeDiagnostic(error.getClass().getName(), 160);
    }

    private static String safeDiagnostic(String value, int maxLength) {
        if (value == null) {
            return null;
        }
        StringBuilder safe = new StringBuilder(Math.min(value.length(), maxLength));
        for (int index = 0; index < value.length() && safe.length() < maxLength; index++) {
            char character = value.charAt(index);
            if (character >= 0x21 && character <= 0x7e) {
                safe.append(character);
            }
        }
        return safe.isEmpty() ? null : safe.toString();
    }

    private static void addDiagnostic(JsonObject data, String name, String value) {
        if (value != null && !value.isBlank()) {
            data.addProperty(name, value);
        }
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
