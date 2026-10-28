package com.dbx.agent.oceanbaseoracle;

import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Read-only discovery, never INITIALIZE, PING, helper DDL, grants or compilation. */
final class PlDebugCapabilities {
    private static final List<String> REQUIRED = List.of("INITIALIZE", "ATTACH_SESSION", "DETACH_SESSION",
        "DEBUG_ON", "DEBUG_OFF", "SET_TIMEOUT_BEHAVIOUR", "SYNCHRONIZE", "CONTINUE", "SET_BREAKPOINT");

    static Map<String, Object> probe(Connection connection) {
        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Object> capabilities = new LinkedHashMap<>();
        Set<String> methods = new LinkedHashSet<>();
        String catalogState = "unknown";
        String catalogError = null;
        try {
            methods = methods(connection, "DBMS_DEBUG");
            // A catalog hidden from this identity is not proof of missing methods.
            if (methods.contains("INITIALIZE")) catalogState = "supported";
        } catch (SQLException error) {
            catalogState = errorState(error);
            catalogError = error.getMessage();
        }
        boolean visible = "supported".equals(catalogState);
        List<String> missing = new ArrayList<>();
        if (visible) for (String method : REQUIRED) if (!methods.contains(method)) missing.add(method);

        Map<String, Object> shape = new LinkedHashMap<>();
        try (CallableStatement call = connection.prepareCall("""
            DECLARE
              p SYS.DBMS_DEBUG.program_info;
              r SYS.DBMS_DEBUG.runtime_info;
              frames SYS.DBMS_DEBUG.backtrace_table;
              major_version BINARY_INTEGER;
              minor_version BINARY_INTEGER;
            BEGIN
              IF FALSE THEN
                p.namespace := 1; p.name := NULL; p.owner := NULL;
                r.terminated := 0; frames(1) := p;
              END IF;
              SYS.DBMS_DEBUG.PROBE_VERSION(major_version, minor_version);
              ? := major_version; ? := minor_version;
            END;
            """)) {
            call.setQueryTimeout(PlDebugNative.CALL_TIMEOUT_SECONDS);
            call.registerOutParameter(1, Types.INTEGER);
            call.registerOutParameter(2, Types.INTEGER);
            call.execute();
            int major = call.getInt(1);
            if (call.wasNull()) throw new SQLException("PROBE_VERSION returned no major version");
            int minor = call.getInt(2);
            if (call.wasNull()) throw new SQLException("PROBE_VERSION returned no minor version");
            shape.put("status", "supported");
            shape.put("major", major);
            shape.put("minor", minor);
        } catch (SQLException error) {
            shape.put("status", errorState(error));
            shape.put("message", error.getMessage());
            shape.put("vendorCode", error.getErrorCode());
        }
        boolean shapeVerified = "supported".equals(shape.get("status"));
        boolean canAttempt = shapeVerified && missing.isEmpty();
        result.put("supported", canAttempt);
        result.put("canAttemptStart", canAttempt);
        result.put("startVerified", false);
        result.put("status", !missing.isEmpty() ? "unsupported" : !shapeVerified ? shape.get("status") : "unknown");
        result.put("reason", !missing.isEmpty() ? "DBMS_DEBUG is missing required methods: " + String.join(", ", missing)
            : !shapeVerified ? "The OceanBase native call shape could not be verified"
            : "System call shape verified; target privileges and execution are checked when starting");
        result.put("dbmsDebug", visible || shapeVerified);
        result.put("procedures", List.copyOf(methods));
        result.put("missingProcedures", missing);
        result.put("catalogStatus", catalogState);
        result.put("catalogError", catalogError);
        result.put("nativeShape", shape);
        result.put("engine", "oceanbase-oracle");
        try {
            var metadata = connection.getMetaData();
            result.put("engineVersion", metadata.getDatabaseProductVersion());
            result.put("driverVersion", metadata.getDriverVersion());
        } catch (SQLException error) {
            result.put("versionError", error.getMessage());
        }

        capabilities.put("control", capability(visible, methods.containsAll(REQUIRED), "DBMS_DEBUG control methods"));
        capabilities.put("breakpoints", capability(visible, methods.containsAll(List.of("SET_BREAKPOINT", "DELETE_BREAKPOINT",
            "ENABLE_BREAKPOINT", "DISABLE_BREAKPOINT")), "DBMS_DEBUG breakpoint methods"));
        try {
            capabilities.put("exceptions", exceptions(connection));
        } catch (SQLException error) {
            capabilities.put("exceptions", Map.of("status", "unknown", "canAttempt", false,
                "message", "The connection could not safely read exception breakpoint support"));
            result.put("supported", false);
            result.put("canAttemptStart", false);
            result.put("status", errorState(error));
            result.put("reason", "The connection could not safely read the OceanBase version");
        }
        capabilities.put("variables", capability(visible, methods.contains("GET_VALUES"), "DBMS_DEBUG.GET_VALUES JSON"));
        capabilities.put("getValue", capability(visible, methods.contains("GET_VALUE"), "DBMS_DEBUG.GET_VALUE with positive native frame mapping"));
        capabilities.put("stack", capability(visible, methods.contains("PRINT_BACKTRACE"), "Structured and text DBMS_DEBUG.PRINT_BACKTRACE"));
        capabilities.put("setValue", capability(visible, methods.contains("SET_VALUE"), "DBMS_DEBUG.SET_VALUE"));
        Map<String, Object> execute = capability(visible, methods.contains("EXECUTE"), "DBMS_DEBUG.EXECUTE");
        // A new engine declaration alone cannot verify a binding this adapter has
        // not implemented. Never route the statement to an ordinary query pool.
        execute.put("canAttempt", false);
        capabilities.put("execute", execute);
        try {
            Set<String> outputMethods = methods(connection, "DBMS_OUTPUT");
            boolean outputVisible = outputMethods.contains("ENABLE");
            Map<String, Object> output = capability(outputVisible, outputMethods.contains("GET_LINE"), "DBMS_OUTPUT.GET_LINE and OUT CLOB capture");
            capabilities.put("output", output);
            result.put("dbmsOutput", outputVisible ? outputMethods.contains("GET_LINE") : null);
            if ("unsupported".equals(output.get("status"))) {
                result.put("supported", false);
                result.put("canAttemptStart", false);
                result.put("status", "unsupported");
                result.put("reason", "The visible DBMS_OUTPUT package does not declare GET_LINE");
            }
        } catch (SQLException error) {
            capabilities.put("output", Map.of("status", errorState(error), "canAttempt", false, "verified", false));
            result.put("dbmsOutput", null);
        }
        result.put("variablesSupported", visible && methods.contains("GET_VALUES"));
        result.put("capabilities", capabilities);
        result.put("warnings", List.of("A lost OceanBase controller connection may let the target continue; an idle timeout does not guarantee termination"));
        return result;
    }

    static Map<String, Object> exceptions(Connection connection) throws SQLException {
        Map<String, Object> result = new LinkedHashMap<>();
        String metadataVersion = null;
        String version = null;
        try {
            metadataVersion = connection.getMetaData().getDatabaseProductVersion();
            if (metadataVersion != null) result.put("metadataVersion", metadataVersion);
        } catch (SQLException error) {
            if (PlDebugNative.connectionUnsafe(error)) throw error;
            result.put("metadataError", errorState(error));
        }
        try (PreparedStatement statement = connection.prepareStatement("SELECT OB_VERSION() FROM DUAL")) {
            statement.setQueryTimeout(PlDebugNative.CALL_TIMEOUT_SECONDS);
            try (ResultSet rows = statement.executeQuery()) {
                if (!rows.next()) throw new SQLException("The OceanBase version was not returned");
                version = rows.getString(1);
                if (version == null || version.isEmpty() || rows.next()) throw new SQLException("The OceanBase version was not unambiguous");
                result.put("engineVersion", version);
                result.put("versionSource", "OB_VERSION");
            }
        } catch (SQLException error) {
            if (PlDebugNative.connectionUnsafe(error)) throw error;
            result.put("versionError", errorState(error));
        }
        boolean known = "4.2.5.7".equals(version) && version.equals(metadataVersion) && !result.containsKey("versionError");
        result.put("status", known ? "unsupported" : "unknown");
        result.put("canAttempt", false);
        result.put("verified", false);
        result.put("message", known ? "Exception breakpoints are not supported in OceanBase 4.2.5.7"
            : "Exception breakpoint flags have not been verified for this OceanBase version");
        result.put("evidence", known
            ? "OceanBase 4.2.5.7: flags 2, 2048 and 2050 return 28 without runtime information; normal continuation is not an exception stop"
            : "CONTINUE being declared does not prove exception or handler flag support");
        return Map.copyOf(result);
    }

    private static Set<String> methods(Connection connection, String packageName) throws SQLException {
        Set<String> names = new LinkedHashSet<>();
        try (PreparedStatement statement = connection.prepareStatement("SELECT PROCEDURE_NAME FROM SYS.ALL_PROCEDURES "
            + "WHERE OWNER = 'SYS' AND OBJECT_NAME = ? AND PROCEDURE_NAME IS NOT NULL")) {
            statement.setQueryTimeout(PlDebugNative.CALL_TIMEOUT_SECONDS);
            statement.setString(1, packageName);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) names.add(rows.getString(1));
            }
        }
        return names;
    }

    private static Map<String, Object> capability(boolean visible, boolean declared, String evidence) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", visible && !declared ? "unsupported" : "unknown");
        result.put("declared", visible ? declared : null);
        result.put("canAttempt", declared);
        result.put("verified", false);
        result.put("evidence", visible && !declared ? evidence + " is absent from the visible system package" : evidence);
        return result;
    }

    private static String errorState(SQLException error) {
        return "42501".equals(error.getSQLState()) || Math.abs(error.getErrorCode()) == 1031 ? "permission_denied" : "error";
    }

    private PlDebugCapabilities() {}
}
