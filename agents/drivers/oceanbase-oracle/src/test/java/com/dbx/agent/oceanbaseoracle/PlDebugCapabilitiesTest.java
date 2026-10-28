package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;

import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugCapabilitiesTest {
    @Test
    void knownMissingOptionalMethodsDoNotDisableTheDebuggerOrClaimVerifiedExecution() {
        Fixture jdbc = new Fixture();
        Map<String, Object> result = PlDebugCapabilities.probe(jdbc.connection());
        assertEquals(true, result.get("supported"));
        assertEquals(false, result.get("startVerified"));
        assertEquals("unknown", result.get("status"));
        Map<?, ?> capabilities = (Map<?, ?>) result.get("capabilities");
        assertEquals("unsupported", ((Map<?, ?>) capabilities.get("setValue")).get("status"));
        assertEquals("unsupported", ((Map<?, ?>) capabilities.get("execute")).get("status"));
        assertEquals("unknown", ((Map<?, ?>) capabilities.get("variables")).get("status"));
        assertEquals("2.4.19", result.get("driverVersion"));
        assertEquals(1, jdbc.shapes.get());
        assertEquals("unsupported", ((Map<?, ?>) capabilities.get("exceptions")).get("status"));
        assertEquals(false, ((Map<?, ?>) capabilities.get("exceptions")).get("canAttempt"));
        PlDebugNativeTest.assertNoHelperDdl(jdbc.sql);
    }

    @Test
    void anInvisibleDeclarationIsUnknownRatherThanUnsupported() {
        Fixture jdbc = new Fixture();
        jdbc.methods = List.of();
        Map<String, Object> result = PlDebugCapabilities.probe(jdbc.connection());
        assertEquals("unknown", result.get("catalogStatus"));
        assertEquals(true, result.get("canAttemptStart"));
        Map<?, ?> capabilities = (Map<?, ?>) result.get("capabilities");
        assertEquals("unknown", ((Map<?, ?>) capabilities.get("setValue")).get("status"));
        assertNull(((Map<?, ?>) capabilities.get("setValue")).get("declared"));
    }

    @Test
    void permissionDenialAndCallShapeFailureRemainErrorsNotMissingCapabilities() {
        Fixture jdbc = new Fixture();
        jdbc.shapeError = new SQLException("injected insufficient privileges", "42501", 1031);
        Map<String, Object> result = PlDebugCapabilities.probe(jdbc.connection());
        assertEquals(false, result.get("supported"));
        assertEquals("permission_denied", result.get("status"));
        assertEquals("permission_denied", ((Map<?, ?>) result.get("nativeShape")).get("status"));
        assertEquals(List.of(), result.get("missingProcedures"));
        jdbc.shapeError = new SQLException("injected type or read failure");
        assertEquals("error", PlDebugCapabilities.probe(jdbc.connection()).get("status"));
    }

    @Test
    void aVisibleMissingRequiredMethodPreventsStart() {
        Fixture jdbc = new Fixture();
        jdbc.methods = List.of("INITIALIZE", "GET_VALUE");
        Map<String, Object> result = PlDebugCapabilities.probe(jdbc.connection());
        assertEquals(false, result.get("supported"));
        assertEquals("unsupported", result.get("status"));
        assertTrue(((List<?>) result.get("missingProcedures")).contains("CONTINUE"));
    }

    @Test
    void exceptionEvidenceIsVersionSpecificAndDiscoveryDoesNotHideConnectionLoss() throws Exception {
        Fixture jdbc = new Fixture();
        for (String version : List.of("4.2.5.8", "4.3.5.0", "5.0.0.0")) {
            jdbc.version = version;
            assertEquals("unknown", PlDebugCapabilities.exceptions(jdbc.connection()).get("status"));
            assertEquals(false, PlDebugCapabilities.exceptions(jdbc.connection()).get("canAttempt"));
        }
        jdbc.version = "4.2.5.7";
        jdbc.metadataVersion = "other";
        assertEquals("unknown", PlDebugCapabilities.exceptions(jdbc.connection()).get("status"));
        jdbc.metadataVersion = "4.2.5.7";
        jdbc.versionError = new SQLException("injected permission failure", "42501", 1031);
        assertEquals("unknown", PlDebugCapabilities.exceptions(jdbc.connection()).get("status"));
        assertEquals(true, PlDebugCapabilities.probe(jdbc.connection()).get("canAttemptStart"));
        for (SQLException failure : List.of(new SQLException("injected loss", "08006"), new java.sql.SQLTimeoutException("injected timeout"),
            new java.sql.SQLRecoverableException("injected recovery loss"), new java.sql.SQLTransientConnectionException("injected transient loss"),
            new java.sql.SQLNonTransientConnectionException("injected nontransient loss"))) {
            jdbc.versionError = failure;
            assertSame(failure, assertThrows(SQLException.class, () -> PlDebugCapabilities.exceptions(jdbc.connection())));
            assertEquals(false, PlDebugCapabilities.probe(jdbc.connection()).get("canAttemptStart"));
        }
    }

    private static final class Fixture {
        List<String> methods = List.of("INITIALIZE", "ATTACH_SESSION", "DETACH_SESSION", "DEBUG_ON", "DEBUG_OFF",
            "SET_TIMEOUT_BEHAVIOUR", "SYNCHRONIZE", "CONTINUE", "SET_BREAKPOINT", "DELETE_BREAKPOINT",
            "ENABLE_BREAKPOINT", "DISABLE_BREAKPOINT", "GET_VALUES", "GET_VALUE", "PRINT_BACKTRACE");
        final List<String> sql = new ArrayList<>();
        final AtomicInteger shapes = new AtomicInteger();
        SQLException shapeError;
        String version = "4.2.5.7";
        String metadataVersion = "4.2.5.7";
        SQLException versionError;

        Connection connection() {
            return proxy(Connection.class, (method, args) -> {
                if (method.getName().equals("getMetaData")) return proxy(DatabaseMetaData.class, (member, values) -> {
                    if (member.getName().equals("getDatabaseProductVersion")) return metadataVersion;
                    if (member.getName().equals("getDriverVersion")) return "2.4.19";
                    return empty(member.getReturnType());
                });
                if (method.getName().equals("prepareStatement")) {
                    sql.add((String) args[0]);
                    boolean versionQuery = ((String) args[0]).contains("OB_VERSION()");
                    String[] packageName = new String[1];
                    return proxy(PreparedStatement.class, (member, values) -> {
                        if (member.getName().equals("setString")) packageName[0] = (String) values[1];
                        if (member.getName().equals("executeQuery")) {
                            if (versionQuery && versionError != null) throw versionError;
                            List<String> rows = versionQuery ? List.of(version) : "DBMS_OUTPUT".equals(packageName[0]) ? List.of("ENABLE", "GET_LINE") : methods;
                            AtomicInteger cursor = new AtomicInteger(-1);
                            return proxy(ResultSet.class, (field, indices) -> switch (field.getName()) {
                                case "next" -> cursor.incrementAndGet() < rows.size();
                                case "getString" -> rows.get(cursor.get());
                                default -> empty(field.getReturnType());
                            });
                        }
                        return empty(member.getReturnType());
                    });
                }
                if (method.getName().equals("prepareCall")) {
                    sql.add((String) args[0]);
                    return proxy(CallableStatement.class, (member, values) -> {
                        if (member.getName().equals("execute")) {
                            shapes.incrementAndGet();
                            if (shapeError != null) throw shapeError;
                        }
                        if (member.getName().equals("getInt")) return (int) values[0] == 1 ? 2 : 4;
                        return empty(member.getReturnType());
                    });
                }
                return empty(method.getReturnType());
            });
        }
    }
}
