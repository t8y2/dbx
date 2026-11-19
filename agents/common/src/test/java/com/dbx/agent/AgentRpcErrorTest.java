package com.dbx.agent;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.sql.SQLTransientConnectionException;
import java.util.concurrent.CancellationException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class AgentRpcErrorTest {
    @Test
    void explicitExceptionCapabilityRejectionKeepsRequestNotStartedSemantics() {
        JsonObject data = errorData(AgentRpcError.requestRejected("Exception flags are unavailable in this version"),
            "pl_debug_set_exception_breakpoint", "original-session");
        assertEquals("request", data.get("stage").getAsString());
        assertEquals("not_started", data.get("operationOutcome").getAsString());
        assertEquals("keep", data.get("sessionDisposition").getAsString());
        assertFalse(data.get("retryable").getAsBoolean());
        assertEquals("original-session", data.get("agentSessionId").getAsString());
    }

    @Test
    void serializesVersionedSqlDiagnosticsAndUnknownExecuteOutcome() {
        SQLException cause = new SQLException("statement failed", "42000", 1064);

        JsonObject data = errorData(cause, AgentProtocol.METHOD_EXECUTE_QUERY, "session-1");

        assertEquals(1, data.get("contractVersion").getAsInt());
        assertEquals("sql", data.get("category").getAsString());
        assertEquals("execute", data.get("stage").getAsString());
        assertEquals("unknown", data.get("operationOutcome").getAsString());
        assertEquals("keep", data.get("sessionDisposition").getAsString());
        assertEquals("42000", data.get("sqlState").getAsString());
        assertEquals(1064, data.get("vendorCode").getAsInt());
        assertEquals(SQLException.class.getName(), data.get("exceptionClass").getAsString());
        assertEquals("session-1", data.get("agentSessionId").getAsString());
    }

    @Test
    void classifiesTimeoutAndCanceledErrorsWithoutClaimingSafeReplay() {
        JsonObject timeout = errorData(
            new SQLTimeoutException("timed out", "HYT00", 0),
            AgentProtocol.METHOD_EXECUTE_QUERY,
            "session-1"
        );
        JsonObject canceled = errorData(
            new CancellationException("canceled"),
            AgentProtocol.METHOD_CANCEL_SESSION,
            "session-1"
        );

        assertEquals("timeout", timeout.get("category").getAsString());
        assertEquals("unknown", timeout.get("operationOutcome").getAsString());
        assertFalse(timeout.get("retryable").getAsBoolean());
        assertEquals("quarantine", timeout.get("sessionDisposition").getAsString());
        assertEquals("canceled", canceled.get("category").getAsString());
        assertEquals("cancel", canceled.get("stage").getAsString());
        assertEquals("unknown", canceled.get("operationOutcome").getAsString());
    }

    @Test
    void marksConnectionSetupFailureAsNotStartedAndBoundsSqlState() {
        SQLException cause = new SQLException("connect failed", "12345678901234567890", -7);

        JsonObject data = errorData(cause, AgentProtocol.METHOD_CONNECT, null);

        assertEquals("connection", data.get("category").getAsString());
        assertEquals("connect", data.get("stage").getAsString());
        assertEquals("not_started", data.get("operationOutcome").getAsString());
        assertEquals(16, data.get("sqlState").getAsString().length());
        assertFalse(data.has("agentSessionId"));
    }

    @Test
    void removesNonGraphicCharactersFromStrictDiagnostics() {
        SQLException cause = new SQLException("connect failed", "08\n006\u00e9", -7);

        JsonObject data = errorData(cause, AgentProtocol.METHOD_CONNECT, null);

        assertEquals("08006", data.get("sqlState").getAsString());
    }

    @Test
    void mapsConnectionAndCloseMethodsToTheSameStagesAsTheRustDecoder() {
        JsonObject testConnection = errorData(
            new SQLException("connect failed", "08001", 0),
            AgentProtocol.METHOD_TEST_CONNECTION,
            null
        );
        JsonObject closeQuery = errorData(
            new SQLException("close failed", "42000", 0),
            AgentProtocol.METHOD_CLOSE_QUERY_SESSION,
            "session-1"
        );

        assertEquals("connect", testConnection.get("stage").getAsString());
        assertEquals("not_started", testConnection.get("operationOutcome").getAsString());
        assertEquals("close", closeQuery.get("stage").getAsString());
        assertEquals("unknown", closeQuery.get("operationOutcome").getAsString());
    }

    @Test
    void debuggerMemoryErrorsRetainTheControllerInsteadOfQuarantiningItAsAConnectionLoss() {
        SQLException error = new SQLTransientConnectionException("ORA-00600 arguments: -4013, tenant memory limit", "HY001", 600);
        for (String method : new String[] {AgentProtocol.METHOD_PL_DEBUG_GET_STACK, AgentProtocol.METHOD_PL_DEBUG_RESUME}) {
            JsonObject data = errorData(error, method, "debug");
            assertEquals("resource", data.get("category").getAsString());
            assertEquals("keep", data.get("sessionDisposition").getAsString());
            assertEquals("unknown", data.get("operationOutcome").getAsString());
            assertFalse(data.get("retryable").getAsBoolean());
        }
        JsonObject lost = errorData(new SQLTransientConnectionException("connection lost", "08006"),
            AgentProtocol.METHOD_PL_DEBUG_GET_STACK, "debug");
        assertEquals("quarantine", lost.get("sessionDisposition").getAsString());
        assertEquals("connection", lost.get("category").getAsString());
    }

    private static JsonObject errorData(Throwable error, String method, String agentSessionId) {
        return AgentRpcError.toJson(error, method, agentSessionId).getAsJsonObject("data");
    }
}
