package com.dbx.agent;

import com.dbx.agent.oceanbaseoracle.OceanBaseOracleAgent;
import com.dbx.agent.test.TestSupport;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.sql.SQLRecoverableException;
import java.sql.Statement;

import static org.junit.jupiter.api.Assertions.*;

class OceanBasePermissionErrorTest {
    private static final String MESSAGE = "(conn=3221636949) ORA-01031: insufficient privileges";

    @Test
    void actualDriverPermissionCauseChainKeepsDiagnosticsForBothExecutionEntries() {
        for (boolean paged : new boolean[]{false, true}) {
            SQLException base = new SQLException("ORA-01031: insufficient privileges", "HY000", 1031);
            SQLException wrapped = com.oceanbase.jdbc.internal.util.exceptions.OceanBaseSqlException.of(base, "ALTER PROCEDURE P COMPILE");
            SQLException top = new SQLTransientConnectionException(MESSAGE, "HY000", 1031, wrapped);
            JsonObject data = executeFailure(top, paged);
            assertEquals("sql", data.get("category").getAsString());
            assertEquals("HY000", data.get("sqlState").getAsString());
            assertEquals(1031, data.get("vendorCode").getAsInt());
            assertEquals(SQLTransientConnectionException.class.getName(), data.get("exceptionClass").getAsString());
            assertEquals("quarantine", data.get("sessionDisposition").getAsString());
            assertEquals("unknown", data.get("operationOutcome").getAsString());
            assertFalse(data.get("retryable").getAsBoolean());
        }
    }

    @Test
    void innerDriverCauseMustStillBeTheSamePermissionError() {
        for (SQLException base : new SQLException[]{
            new SQLException("connection lost", "08006", 1031),
            new SQLException("ORA-20001: application error", "HY000", 20001),
            new SQLException("different error", "HY000", 1031),
            new SQLRecoverableException("ORA-01031: insufficient privileges", "HY000", 1031)
        }) {
            SQLException wrapped = new com.oceanbase.jdbc.internal.util.exceptions.OceanBaseSqlException(
                "ORA-01031: insufficient privileges", "ALTER PROCEDURE P COMPILE", "HY000", 1031, base);
            SQLException top = new SQLTransientConnectionException(MESSAGE, "HY000", 1031, wrapped);
            for (boolean paged : new boolean[]{false, true}) {
                assertEquals("connection", executeFailure(top, paged).get("category").getAsString());
            }
        }
    }

    @Test
    void capturedPermissionFailureKeepsDiagnosticsAndUnsafeConnectionDisposition() {
        for (boolean paged : new boolean[]{false, true}) {
            SQLException cause = new SQLTransientConnectionException(MESSAGE, "HY000", 1031);
            JsonObject data = executeFailure(cause, paged);
            assertEquals("sql", data.get("category").getAsString());
            assertEquals("HY000", data.get("sqlState").getAsString());
            assertEquals(1031, data.get("vendorCode").getAsInt());
            assertEquals(SQLTransientConnectionException.class.getName(), data.get("exceptionClass").getAsString());
            assertEquals("quarantine", data.get("sessionDisposition").getAsString());
            assertEquals("unknown", data.get("operationOutcome").getAsString());
            assertFalse(data.get("retryable").getAsBoolean());
        }
    }

    @Test
    void unrelatedTransientAndNetworkErrorsKeepConnectionClassification() {
        for (SQLException cause : new SQLException[]{
            new SQLTransientConnectionException(MESSAGE, "08006", 1031),
            new SQLTransientConnectionException("connection interrupted", "HY000", 1031),
            new SQLTransientConnectionException("ORA-20001: application error", "HY000", 20001)
        }) {
            assertEquals("connection", executeFailure(cause, false).get("category").getAsString());
        }
    }

    @Test
    void sameDriverErrorWithoutOceanBaseExecuteContextIsNotReclassified() {
        SQLException cause = new SQLTransientConnectionException(MESSAGE, "HY000", 1031);
        for (String method : new String[]{AgentProtocol.METHOD_CONNECT, AgentProtocol.METHOD_VALIDATE_CONNECTION,
            AgentProtocol.METHOD_EXECUTE_QUERY}) {
            JsonObject data = AgentRpcError.toJson(cause, method, "session-1").getAsJsonObject("data");
            assertEquals("connection", data.get("category").getAsString());
        }
    }

    @Test
    void mixedPermissionAndConnectionFailuresKeepTheirOriginalClassification() {
        SQLException suppressed = new SQLTransientConnectionException(MESSAGE, "HY000", 1031);
        suppressed.addSuppressed(new SQLException("reset failed", "08006"));
        SQLException chained = new SQLTransientConnectionException(MESSAGE, "HY000", 1031);
        chained.setNextException(new SQLException("connection lost", "08006"));
        SQLException caused = new SQLTransientConnectionException(MESSAGE, "HY000", 1031);
        caused.initCause(new SQLRecoverableException("connection lost", "08006"));
        for (SQLException cause : new SQLException[]{suppressed, chained, caused}) {
            JsonObject data = executeFailure(cause, false);
            assertEquals("connection", data.get("category").getAsString());
            assertEquals("quarantine", data.get("sessionDisposition").getAsString());
            assertEquals("unknown", data.get("operationOutcome").getAsString());
            assertFalse(data.get("retryable").getAsBoolean());
        }
    }

    private static JsonObject executeFailure(SQLException cause, boolean paged) {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        Statement statement = (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(),
            new Class<?>[]{Statement.class}, (proxy, method, args) -> {
                if (method.getName().equals("execute")) throw cause;
                return null;
            });
        Connection connection = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(),
            new Class<?>[]{Connection.class}, (proxy, method, args) -> switch (method.getName()) {
                case "isClosed" -> false;
                case "createStatement" -> statement;
                default -> null;
            });
        TestSupport.setPrivateConnection(agent, connection);
        RuntimeException error = assertThrows(RuntimeException.class, () -> {
            if (paged) agent.executeQueryPage("ALTER PROCEDURE P COMPILE", null, new QueryPageOptions());
            else agent.executeQuery("ALTER PROCEDURE P COMPILE", null, new ExecuteQueryOptions());
        });
        return AgentRpcError.toJson(error,
            paged ? AgentProtocol.METHOD_EXECUTE_QUERY_PAGE : AgentProtocol.METHOD_EXECUTE_QUERY,
            "session-1").getAsJsonObject("data");
    }
}
