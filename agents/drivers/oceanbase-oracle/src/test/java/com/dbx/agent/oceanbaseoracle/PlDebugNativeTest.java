package com.dbx.agent.oceanbaseoracle;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugNativeTest {
    @Test
    void nativeControlConformsToSharedAgentVectors() throws Exception {
        Gson json = new Gson();
        JsonObject fixture;
        try (var stream = PlDebugNativeTest.class.getResourceAsStream("/pl-debug-native-control.json")) {
            assertNotNull(stream, "Shared native agent vectors are required");
            fixture = json.fromJson(new InputStreamReader(stream, StandardCharsets.UTF_8), JsonObject.class);
        }
        var controls = fixture.getAsJsonArray("controls");
        assertEquals(3, controls.size());
        var expected = json.fromJson(fixture.get("stop"), PlDebugNative.Stop.class);
        var flags = Map.of("resume", PlDebugNative.CONTINUE, "step_over", PlDebugNative.STEP_OVER, "step_in", PlDebugNative.STEP_IN);
        for (var item : controls) {
            var control = item.getAsJsonObject();
            Call call = new Call();
            call.out.putAll(Map.of(2, expected.result(), 3, expected.line(), 4, expected.terminated() ? 1 : 0,
                5, expected.reason(), 6, expected.depth(), 7, expected.breakpoint(), 8, expected.program(), 9, expected.owner(), 10, expected.namespace()));
            var actual = PlDebugNative.continueWith(call.connection(), flags.get(control.get("action").getAsString()));
            assertEquals(expected, actual);
            assertEquals(control.get("oceanbaseFlag").getAsInt(), call.in.get(1));
            assertEquals(1, call.executions);
            assertNoHelperDdl(call.sql);
        }
    }

    private static final String FRAMES = """
        [{"name":"LEAF","owner":"SCOTT","namespace":1},
         {"name":"MIDDLE","owner":"SCOTT","namespace":1},
         {"name":"__anonymous_block__","owner":null,"namespace":0}]
        """;
    private static final String LISTING = "[Line 5] LEAF\n[Line 13] MIDDLE\n[Line 16] __anonymous_block__";
    private static final PlDebugNative.Stop RUNTIME = new PlDebugNative.Stop(0, 5, false, 9, 3, 0, "LEAF", "SCOTT", 1);

    @Test
    void initializesAndSetsThePrivateTimeoutThroughAnonymousTypedOutCalls() throws Exception {
        Call initialize = new Call(); initialize.out.put(1, "native-id");
        assertEquals("native-id", PlDebugNative.initialize(initialize.connection()));
        assertEquals(Types.VARCHAR, initialize.types.get(1));
        Call timeout = new Call(); timeout.out.put(1, 60);
        assertEquals(60, PlDebugNative.setTimeout(timeout.connection(), 120));
        assertEquals(120, timeout.in.get(2));
        assertEquals(Types.INTEGER, timeout.types.get(1));
        assertNoHelperDdl(initialize.sql); assertNoHelperDdl(timeout.sql);
    }

    @Test
    void carriesIntegerTerminationAndProgramIdentityWithoutDelimiterParsing() throws Exception {
        Call call = new Call();
        call.out.putAll(Map.of(2, 0, 3, 18, 4, 1, 5, 15, 6, 3, 7, 0,
            8, "P,quoted\"汉", 9, "Owner,汉", 10, 2));
        PlDebugNative.Stop stop = PlDebugNative.continueWith(call.connection(), PlDebugNative.CONTINUE);
        assertEquals(512, call.in.get(1));
        assertEquals(0, stop.result());
        assertTrue(stop.terminated());
        assertEquals(18, stop.line());
        assertEquals(3, stop.depth());
        assertEquals("P,quoted\"汉", stop.program());
        assertEquals("Owner,汉", stop.owner());
        assertEquals(2, stop.namespace());
        assertEquals(Types.INTEGER, call.types.get(4));
        assertEquals(1, call.executions);
        assertNoHelperDdl(call.sql);
    }

    @Test
    void mapsBothValueApisToTheSamePositiveNativeFrame() throws Exception {
        PlDebugNative.Stack stack = PlDebugNative.parseStack(FRAMES, LISTING, RUNTIME);
        assertTrue(stack.complete());
        assertEquals(List.of(3, 2, 1), stack.frames().stream().map(PlDebugNative.Frame::nativeFrameId).toList());
        assertEquals(List.of(5, 13, 16), stack.frames().stream().map(PlDebugNative.Frame::line).toList());
        for (int uiFrame = 0; uiFrame < 3; uiFrame++) {
            Call values = new Call();
            values.out.put(2, 0);
            values.out.put(3, "{\"V\":\"41\"}");
            assertEquals("41", PlDebugNative.variables(values.connection(), stack, uiFrame).getFirst().value());
            assertEquals(3 - uiFrame, values.in.get(1));
            Call value = new Call();
            value.out.put(3, 0);
            value.out.put(4, "\"'Null'\"");
            assertEquals("Null", PlDebugNative.value(value.connection(), stack, uiFrame, "V").value());
            assertEquals(3 - uiFrame, value.in.get(2));
        }
    }

    @Test
    void refusesUnconfirmedRuntimePositionsBeforeTouchingTheConnection() {
        PlDebugNative.Stack incomplete = PlDebugNative.parseStack(FRAMES, "[Line 5] OTHER", null);
        assertFalse(incomplete.complete());
        Call call = new Call();
        assertThrows(IllegalStateException.class, () -> PlDebugNative.variables(call.connection(), incomplete, 0));
        assertTrue(call.sql.isEmpty());
        PlDebugNative.Stack complete = PlDebugNative.parseStack(FRAMES, LISTING, RUNTIME);
        assertThrows(IllegalArgumentException.class, () -> PlDebugNative.variables(call.connection(), complete, 3));
    }

    @Test
    void preservesNullStringTokensAndStructuredText() {
        Map<String, String> nativeValues = new LinkedHashMap<>();
        nativeValues.put("V_NULL", "Null");
        nativeValues.put("V_TEXT", "'Null'");
        nativeValues.put("V_EMPTY", "''");
        nativeValues.put("V_LONG", "'汉|*\"\\\n\u001f'" + "'".repeat(2));
        nativeValues.put("V_NUMBER", "41");
        List<PlDebugNative.Value> values = PlDebugNative.parseVariables(new Gson().toJson(nativeValues));
        assertEquals("null", values.get(0).state());
        assertNull(values.get(0).value());
        assertEquals("value", values.get(1).state());
        assertEquals("Null", values.get(1).value());
        assertEquals("empty", values.get(2).state());
        assertEquals("", values.get(2).value());
        assertEquals(nativeValues.get("V_LONG").substring(1, nativeValues.get("V_LONG").length() - 1), values.get(3).value());
        assertEquals("41", values.get(4).value());
        assertTrue(values.stream().allMatch(value -> value.type() == null), "OB's listing does not report declared types");
    }

    @Test
    void distinguishesFailedReadsAndOutOfScopeFromAnEmptyListing() throws Exception {
        PlDebugNative.Stack stack = PlDebugNative.parseStack(FRAMES, LISTING, RUNTIME);
        Call bad = new Call();
        bad.out.put(2, 28);
        assertThrows(IllegalStateException.class, () -> PlDebugNative.variables(bad.connection(), stack, 0));
        assertThrows(RuntimeException.class, () -> PlDebugNative.parseVariables("not json"));
        assertThrows(IllegalStateException.class, () -> PlDebugNative.parseVariables(null));
        assertEquals(List.of(), PlDebugNative.parseVariables("{}"));
        Call missing = new Call();
        missing.out.put(3, 3);
        assertEquals("out_of_scope", PlDebugNative.value(missing.connection(), stack, 0, "MISSING").state());
        Call failed = new Call();
        failed.failure = new SQLException("permission denied", "42000", 1031);
        assertSame(failed.failure, assertThrows(SQLException.class,
            () -> PlDebugNative.value(failed.connection(), stack, 0, "V")));
    }

    @Test
    void bindsBreakpointIdentifiersAndReturnsNativeCodes() throws Exception {
        Call named = new Call();
        named.out.put(4, 42);
        named.out.put(5, 0);
        assertArrayEquals(new int[] {42, 0}, PlDebugNative.setBreakpoint(named.connection(), "Mixed Owner", "A\"B", 9, false));
        assertEquals("Mixed Owner", named.in.get(1));
        assertEquals("A\"B", named.in.get(2));
        assertEquals(9, named.in.get(3));
        assertFalse(named.sql.getFirst().contains("Mixed Owner"));
        assertFalse(named.sql.getFirst().contains("A\"B"));
        Call toggle = new Call();
        toggle.out.put(1, 13);
        assertEquals(13, PlDebugNative.toggleBreakpoint(toggle.connection(), 42, false));
        assertEquals(42, toggle.in.get(2));
        assertNoHelperDdl(named.sql);
        assertNoHelperDdl(toggle.sql);
    }

    @Test
    void aMissingNativeResultIsNotReportedAsSuccess() {
        Call call = new Call();
        assertThrows(SQLException.class, () -> PlDebugNative.continueWith(call.connection(), PlDebugNative.CONTINUE));
        assertEquals(1, call.executions);
    }

    @Test
    void preservesNativeRejectionWhenRuntimeOutFieldsAreNotPopulated() throws Exception {
        Call call = new Call();
        call.out.put(2, 28);
        PlDebugNative.Stop rejected = PlDebugNative.continueWith(call.connection(), PlDebugNative.EXCEPTION);
        assertEquals(28, rejected.result());
        assertNull(rejected.line());
        assertNull(rejected.reason());
        assertNull(rejected.depth());
        assertEquals(1, call.executions);
    }

    @Test
    void readsDocumentedBreakpointTextVerbatimWithoutTreatingMissingOutAsEmpty() throws Exception {
        String listing = "  1. SYS.\"name.with.dot\n  2. fake\", Line 12 [offset (\t0,  0),  0] Disabled.\n";
        Call call = new Call();
        call.out.put(1, listing);
        assertEquals(listing, PlDebugNative.breakpointListing(call.connection()));
        assertEquals(Types.VARCHAR, call.types.get(1));
        assertEquals(1, call.executions);
        assertTrue(call.closed);
        assertNoHelperDdl(call.sql);
        Call missing = new Call();
        assertThrows(SQLException.class, () -> PlDebugNative.breakpointListing(missing.connection()));
        assertTrue(missing.closed);
        Call failed = new Call();
        failed.failure = new SQLException("inventory unavailable", "HY000", 20001);
        assertSame(failed.failure, assertThrows(SQLException.class, () -> PlDebugNative.breakpointListing(failed.connection())));
        assertEquals(1, failed.executions);
    }

    @Test
    void bindsTheVerifiedProgramNamespaceAndMarksDispatchOnlyAfterBinding() throws Exception {
        Call call = new Call();
        call.out.put(5, 42); call.out.put(6, 0);
        int[] dispatches = {0};
        var program = new PlDebugBreakpointInventory.Program(" Mixed.Owner ", "Quoted.\"Name", 2, 9);
        assertArrayEquals(new int[] {42, 0}, PlDebugNative.setBreakpoint(call.connection(), program, () -> {
            assertEquals(0, call.executions);
            assertEquals(2, call.in.get(3));
            assertEquals(Types.INTEGER, call.types.get(6));
            dispatches[0]++;
        }));
        assertEquals(1, dispatches[0]);
        assertEquals(1, call.executions);
        assertEquals(program.owner(), call.in.get(1));
        assertEquals(program.name(), call.in.get(2));
        assertEquals(program.line(), call.in.get(4));
        assertFalse(call.sql.getFirst().contains(program.owner()));
        assertFalse(call.sql.getFirst().contains(program.name()));
        assertNoHelperDdl(call.sql);
        assertTrue(call.closed);
    }

    @Test
    void readsCurrentProgramFieldsBeforeRegisteringAnAnonymousBreakpoint() throws Exception {
        Call call = new Call();
        call.out.put(1, 0); call.out.put(2, " Mixed.Owner "); call.out.put(3, "Name.with.dot\n"); call.out.put(4, 2);
        assertEquals(new PlDebugBreakpointInventory.Program(" Mixed.Owner ", "Name.with.dot\n", 2, 19),
            PlDebugNative.currentBreakpointProgram(call.connection(), 19));
        assertEquals(1, call.executions);
        assertTrue(call.sql.getFirst().contains("GET_RUNTIME_INFO"));
        assertFalse(call.sql.getFirst().contains("set_breakpoint"));
        Call absent = new Call();
        absent.out.put(1, 0); absent.out.put(4, 1);
        assertThrows(SQLException.class, () -> PlDebugNative.currentBreakpointProgram(absent.connection(), 19));
        assertEquals(1, absent.executions);
    }

    @Test
    void supportsOriginalOperationDispatchOwnershipForEachBreakpointPrimitive() throws Exception {
        for (String operation : List.of("create", "enable", "disable", "delete")) {
            Call call = new Call();
            RuntimeException stopped = new IllegalStateException("The original owner stopped before dispatch");
            Runnable before = () -> { throw stopped; };
            Exception actual = assertThrows(Exception.class, () -> {
                switch (operation) {
                    case "create" -> PlDebugNative.setBreakpoint(call.connection(), null, null, 12, true, before);
                    case "enable" -> PlDebugNative.toggleBreakpoint(call.connection(), 42, true, before);
                    case "disable" -> PlDebugNative.toggleBreakpoint(call.connection(), 42, false, before);
                    case "delete" -> PlDebugNative.deleteBreakpoint(call.connection(), 42, before);
                }
            });
            assertSame(stopped, actual);
            assertEquals(0, call.executions);
            assertTrue(call.closed);
        }
        Call lost = new Call();
        int[] dispatches = {0};
        assertThrows(SQLException.class, () -> PlDebugNative.deleteBreakpoint(lost.connection(), 42, () -> dispatches[0]++));
        assertEquals(1, dispatches[0]);
        assertEquals(1, lost.executions, "Missing OUT is post-dispatch, not proof that the original write did not run");
    }

    static void assertNoHelperDdl(List<String> statements) {
        for (String sql : statements) {
            String upper = sql.toUpperCase();
            assertFalse(upper.contains("CREATE OR REPLACE PACKAGE"), sql);
            assertFalse(upper.contains("DBX_PL_DEBUG_PACKAGE"), sql);
            assertFalse(upper.contains("COMPILE DEBUG"), sql);
            assertFalse(upper.startsWith("GRANT "), sql);
        }
    }

    private static final class Call {
        final Map<Integer, Object> in = new LinkedHashMap<>();
        final Map<Integer, Object> out = new LinkedHashMap<>();
        final Map<Integer, Integer> types = new LinkedHashMap<>();
        final List<String> sql = new ArrayList<>();
        int executions;
        SQLException failure;
        boolean lastWasNull;
        boolean closed;

        Connection connection() {
            return proxy(Connection.class, (method, args) -> {
                if (!method.getName().equals("prepareCall")) return empty(method.getReturnType());
                sql.add((String) args[0]);
                return proxy(CallableStatement.class, (member, values) -> {
                    return switch (member.getName()) {
                        case "setInt", "setString" -> { in.put((int) values[0], values[1]); yield null; }
                        case "registerOutParameter" -> { types.put((int) values[0], (int) values[1]); yield null; }
                        case "execute" -> { executions++; if (failure != null) throw failure; yield false; }
                        case "getInt" -> {
                            Object value = out.get((int) values[0]);
                            lastWasNull = value == null;
                            yield value == null ? 0 : value;
                        }
                        case "wasNull" -> lastWasNull;
                        case "getString" -> out.get((int) values[0]);
                        case "close" -> { closed = true; yield null; }
                        default -> empty(member.getReturnType());
                    };
                });
            });
        }
    }
}
