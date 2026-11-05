package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugBreakpoint;
import org.junit.jupiter.api.Test;

import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

/** Author continuation/breakpoint regression cases, adapted to native scalar OUT calls. */
class PlDebugControlTest {
    @Test
    void exceptionContinuationFailuresNeverFallBackOrConfirmAPause() throws Exception {
        for (String scenario : List.of("rc28", "missing-result", "timeout", "connection")) {
            Controller jdbc = new Controller();
            PlDebugSession session = jdbc.session(List.of());
            session.setExceptionBreakpoint(true);
            if (scenario.equals("rc28")) jdbc.stops.add(new PlDebugNative.Stop(28, null, false, null, null, null, null, null, null));
            if (scenario.equals("missing-result")) jdbc.missingResult = true;
            if (scenario.equals("timeout")) jdbc.controlFailure = new java.sql.SQLTimeoutException("injected timeout");
            if (scenario.equals("connection")) jdbc.controlFailure = new SQLException("injected loss", "08006");
            var failure = assertThrows(Exception.class, session::resume, scenario);
            if (scenario.equals("rc28")) assertTrue(failure.getMessage().contains("28"));
            assertEquals(List.of(2050), jdbc.flags, scenario);
            assertEquals("unknown", session.snapshot().get("state"));
            assertThrows(IllegalStateException.class, () -> session.setExceptionBreakpoint(false));
            assertThrows(IllegalStateException.class, session::resume);
            assertEquals(List.of(2050), jdbc.flags, scenario);
        }
    }

    @Test
    void automaticRulesDoNotContinueAfterStopIntentOrInventoryLoss() throws Exception {
        for (String scenario : List.of("stop", "changed", "lost", "timeout", "recoverable", "connection-null-state")) {
            Controller jdbc = new Controller();
            PlDebugSession session = jdbc.session(List.of(breakpoint(5)));
            jdbc.stops.add(stop(9, 0, false));
            session.stepIn();
            PlDebugBreakpoint owned = session.listBreakpoints().getFirst();
            long revision = ((Number) session.snapshot().get("stopRevision")).longValue();
            session.mutateBreakpoint("set_breakpoints", new com.dbx.agent.PlDebugBreakpointMutation("guard", null, null,
                revision, null, null, 5, owned.getRegistrationId(), null, java.util.Map.of("ignoreCount", 1000)), () -> {});
            jdbc.stops.add(stop(3, 5, false));
            if (scenario.equals("stop")) jdbc.afterControl = () -> assertDoesNotThrow(session::abortByStatement);
            if (scenario.equals("changed")) jdbc.afterControl = () -> jdbc.nativeBreakpoints.records.clear();
            if (scenario.equals("lost")) jdbc.nativeBreakpoints.failReadAt = jdbc.nativeBreakpoints.reads + 1;
            if (List.of("timeout", "recoverable", "connection-null-state").contains(scenario)) {
                jdbc.nativeBreakpoints.failReadAt = jdbc.nativeBreakpoints.reads + 1;
                jdbc.nativeBreakpoints.readFailure = switch (scenario) {
                    case "timeout" -> new java.sql.SQLTimeoutException("injected inventory timeout");
                    case "recoverable" -> new java.sql.SQLRecoverableException("injected inventory loss");
                    default -> new java.sql.SQLNonTransientConnectionException("injected inventory loss");
                };
            }
            assertThrows(Exception.class, session::resume, scenario);
            assertEquals(List.of(PlDebugNative.STEP_IN, PlDebugNative.CONTINUE), jdbc.flags, scenario);
            assertNotEquals("ended", session.snapshot().get("state"));
            if (!scenario.equals("stop")) assertEquals("unknown", session.snapshot().get("state"));
            assertThrows(Exception.class, session::resume, scenario);
            assertEquals(List.of(PlDebugNative.STEP_IN, PlDebugNative.CONTINUE), jdbc.flags, scenario);
        }
    }

    @Test
    void serverAutomaticContinueStopsAtItsBound() throws Exception {
        Controller jdbc = new Controller();
        PlDebugSession session = jdbc.session(List.of(breakpoint(5)));
        jdbc.stops.add(stop(9, 0, false));
        session.stepIn();
        PlDebugBreakpoint owned = session.listBreakpoints().getFirst();
        long revision = ((Number) session.snapshot().get("stopRevision")).longValue();
        session.mutateBreakpoint("set_breakpoints", new com.dbx.agent.PlDebugBreakpointMutation("limit", null, null,
            revision, null, null, 5, owned.getRegistrationId(), null, java.util.Map.of("ignoreCount", 1000)), () -> {});
        jdbc.stops.add(stop(3, 5, false));
        var result = session.resume();
        assertEquals(202, jdbc.flags.size());
        assertEquals("paused", result.get("state"));
        var event = (java.util.Map<?, ?>) ((java.util.List<?>) result.get("breakpointRuleEvents")).getFirst();
        assertTrue(((String) event.get("warning")).contains("limit (200)"));
    }

    @Test
    void serverRulesSkipUnderTheOriginalOwnerAndPublishOneMessageAtTheKeptStop() throws Exception {
        Controller jdbc = new Controller();
        PlDebugSession session = jdbc.session(List.of(breakpoint(5)));
        jdbc.stops.add(stop(9, 0, false));
        session.stepIn();
        PlDebugBreakpoint owned = session.listBreakpoints().getFirst();
        long revision = ((Number) session.snapshot().get("stopRevision")).longValue();
        var rules = new com.dbx.agent.PlDebugBreakpointMutation("rules", null, null, revision, null, null,
            5, owned.getRegistrationId(), null, java.util.Map.of("ignoreCount", 2, "message", "kept stop"));
        assertEquals(true, session.mutateBreakpoint("set_breakpoints", rules, () -> fail("Rule edits must not write a native breakpoint")).get("ok"));
        jdbc.stops.add(stop(3, 5, false));
        jdbc.stops.add(stop(3, 5, false));
        var result = session.resume();
        assertEquals(List.of(PlDebugNative.STEP_IN, PlDebugNative.CONTINUE, PlDebugNative.CONTINUE), jdbc.flags);
        var events = (java.util.List<?>) result.get("breakpointRuleEvents");
        assertEquals(1, events.size());
        assertEquals("kept stop", ((java.util.Map<?, ?>) events.getFirst()).get("message"));
        var points = (java.util.List<?>) result.get("breakpoints");
        assertEquals(2L, ((java.util.Map<?, ?>) points.getFirst()).get("hits"));
        jdbc.stops.add(stop(3, 5, false));
        var stepped = session.stepIn();
        assertEquals(PlDebugNative.STEP_IN, jdbc.flags.getLast());
        assertEquals(4, jdbc.flags.size());
        assertEquals(2, ((java.util.List<?>) stepped.get("breakpointRuleEvents")).size());
        assertEquals(3L, ((java.util.Map<?, ?>) ((java.util.List<?>) stepped.get("breakpoints")).getFirst()).get("hits"));
    }

    @Test
    void invalidConditionKeepsTheBreakpointInsteadOfContinuing() throws Exception {
        Controller jdbc = new Controller();
        PlDebugSession session = jdbc.session(List.of(breakpoint(5)));
        jdbc.stops.add(stop(9, 0, false));
        session.stepIn();
        PlDebugBreakpoint owned = session.listBreakpoints().getFirst();
        long revision = ((Number) session.snapshot().get("stopRevision")).longValue();
        session.mutateBreakpoint("set_breakpoints", new com.dbx.agent.PlDebugBreakpointMutation("condition", null, null,
            revision, null, null, 5, owned.getRegistrationId(), null, java.util.Map.of("condition", "F() == 1")), () -> {});
        jdbc.stops.add(stop(3, 5, false));
        var result = session.resume();
        assertEquals(List.of(PlDebugNative.STEP_IN, PlDebugNative.CONTINUE), jdbc.flags);
        var event = (java.util.Map<?, ?>) ((java.util.List<?>) result.get("breakpointRuleEvents")).getFirst();
        assertTrue(((String) event.get("warning")).contains("could not be evaluated"));
    }

    @Test
    void exceptionModeUsesNativeFlagsUntilAHandlerOrExceptionStopsIt() throws Exception {
        Controller jdbc = new Controller();
        jdbc.stops.add(stop(8, 0, false));
        jdbc.stops.add(stop(16, 0, false));
        PlDebugSession session = jdbc.session(List.of());
        session.setExceptionBreakpoint(true);
        var snapshot = session.resume();
        assertEquals(16, snapshot.get("reason"));
        assertEquals(true, snapshot.get("stoppedOnException"));
        assertEquals(List.of(2050, 2050), jdbc.flags);
        assertEquals(true, session.setExceptionBreakpoint(false).get("stoppedOnException"), "a configuration change does not replace the native stop reason");
        jdbc.stops.add(stop(9, 0, false));
        assertEquals(false, session.stepOver().get("stoppedOnException"));
    }

    @Test
    void steppingKeepsItsOwnFlagsEvenWithExceptionModeEnabled() throws Exception {
        Controller jdbc = new Controller();
        jdbc.stops.add(stop(9, 0, false, 3));
        jdbc.stops.add(stop(9, 0, false, 3));
        jdbc.stops.add(stop(8, 0, false, 2));
        PlDebugSession session = jdbc.session(List.of());
        session.setExceptionBreakpoint(true);
        session.stepIn(); session.stepOver(); session.stepOut();
        assertEquals(List.of(12, 32, 512), jdbc.flags);
    }

    @Test
    void stepOutConfirmsTheOriginalFrameExitedWithoutClaimingTheProgramEnded() throws Exception {
        Controller jdbc = new Controller();
        jdbc.stops.add(stop(9, 0, false, 3));
        PlDebugSession session = jdbc.session(List.of());
        session.stepIn();
        jdbc.stops.add(stop(8, 0, false, 2));

        var response = session.stepOut();

        assertEquals(2, response.get("stackDepth"));
        assertEquals(true, response.get("stepOutComplete"));
        assertEquals(false, response.get("terminated"));
        assertEquals(List.of(12, 512), jdbc.flags);
    }

    @Test
    void stepOutPreservesInterveningBreakpointsAndExceptionStops() throws Exception {
        for (int reason : List.of(3, 11, 16)) {
            Controller jdbc = new Controller();
            jdbc.stops.add(stop(9, 0, false, 3));
            PlDebugSession session = jdbc.session(List.of());
            session.stepIn();
            jdbc.stops.add(stop(reason, reason == 3 ? 7 : 0, false, 3));
            jdbc.stops.add(stop(8, 0, false, 2));

            var response = session.stepOut();

            assertEquals(reason, response.get("reason"));
            assertEquals(false, response.get("stepOutComplete"));
            assertEquals(false, response.get("terminated"));
            assertNotNull(response.get("message"));
            assertEquals(List.of(12, 512), jdbc.flags);
            assertEquals(1, jdbc.stops.size());
        }
    }

    @Test
    void stepOutWithoutLocalDepthKeepsTheNativeOperationButDoesNotGuessCompletion() throws Exception {
        Controller jdbc = new Controller();
        PlDebugSession session = jdbc.session(List.of());

        var response = session.stepOut();

        assertEquals(false, response.get("stepOutComplete"));
        assertTrue(response.get("message").toString().contains("stack depth"));
        assertEquals(List.of(512), jdbc.flags);
    }

    @Test
    void stepOutStopsExplicitlyWhenANewStopHasNoNativeDepth() throws Exception {
        Controller jdbc = new Controller();
        jdbc.stops.add(stop(9, 0, false, 3));
        PlDebugSession session = jdbc.session(List.of());
        session.stepIn();
        jdbc.stops.add(stop(8, 0, false, null));

        var response = session.stepOut();

        assertEquals(false, response.get("stepOutComplete"));
        assertNull(response.get("stackDepth"));
        assertTrue(response.get("message").toString().contains("stack depth"));
        assertEquals(false, response.get("terminated"));
        assertEquals(List.of(12, 512), jdbc.flags);
    }

    @Test
    void stepOutPreservesAnUnexpectedNativeStopInsteadOfContinuingAutomatically() throws Exception {
        Controller jdbc = new Controller();
        jdbc.stops.add(stop(9, 0, false, 3));
        PlDebugSession session = jdbc.session(List.of());
        session.stepIn();
        jdbc.stops.add(stop(8, 0, false, 4));
        jdbc.stops.add(stop(8, 0, false, 2));

        var response = session.stepOut();

        assertEquals(false, response.get("stepOutComplete"));
        assertEquals(false, response.get("terminated"));
        assertEquals(4, response.get("stackDepth"));
        assertNotNull(response.get("message"));
        assertEquals(List.of(12, 512), jdbc.flags);
        assertEquals(1, jdbc.stops.size());
    }

    @Test
    void stepOutEndsOnConfirmedProgramTerminationAndDoesNotContinueAgain() throws Exception {
        Controller jdbc = new Controller();
        jdbc.stops.add(stop(9, 0, false, 1));
        PlDebugSession session = jdbc.session(List.of());
        session.stepIn();
        jdbc.stops.add(stop(25, 0, true, null));

        var response = session.stepOut();

        assertEquals(true, response.get("stepOutComplete"));
        assertEquals(true, response.get("terminated"));
        assertEquals(true, session.stepOut().get("stepOutComplete"));
        assertEquals(List.of(12, 512), jdbc.flags);
    }

    @Test
    void runToEndDisablesOnlyArmedBreakpointsAndDoesNotRestoreAfterConfirmedEnd() throws Exception {
        Controller jdbc = new Controller();
        jdbc.stops.add(stop(25, 0, true));
        PlDebugSession session = jdbc.session(List.of(breakpoint(7), breakpoint(8)));
        session.setBreakpointEnabled(7, false);
        assertEquals(true, session.resumeIgnoreBreakpoints().get("terminated"));
        assertEquals(List.of(7, 8), jdbc.disabled);
        assertEquals(List.of(), jdbc.enabled);
        assertEquals(List.of(512), jdbc.flags);
    }

    @Test
    void runToEndRestoresExactlyWhatItDisabledWhenABreakpointStopsIt() throws Exception {
        Controller jdbc = new Controller();
        jdbc.stops.add(stop(3, 7, false));
        var response = jdbc.session(List.of(breakpoint(7))).resumeIgnoreBreakpoints();
        assertEquals(false, response.get("terminated"));
        assertEquals(7, response.get("breakpoint"));
        assertTrue(response.get("message").toString().contains("断点"));
        assertEquals(List.of(7), jdbc.disabled);
        assertEquals(List.of(7), jdbc.enabled);
    }

    @Test
    void anIdleBreakpointRefusalIsNotCountedAsDisabledOrRestored() throws Exception {
        Controller jdbc = new Controller();
        jdbc.toggleResult = 14;
        jdbc.stops.add(stop(3, 7, false));
        assertEquals(false, jdbc.session(List.of(breakpoint(7))).resumeIgnoreBreakpoints().get("terminated"));
        assertEquals(List.of(7), jdbc.disabled);
        assertEquals(List.of(), jdbc.enabled);
    }

    @Test
    void aMissingNativeNumberContradictingTheCompleteInventoryStopsTheRun() {
        Controller jdbc = new Controller();
        jdbc.toggleResult = 13;
        PlDebugSession session = jdbc.session(List.of(breakpoint(7)));
        assertThrows(IllegalStateException.class, session::resumeIgnoreBreakpoints);
        assertEquals(List.of(7), jdbc.disabled);
        assertEquals(List.of(), jdbc.enabled);
        assertEquals(List.of(), jdbc.flags);
        assertEquals("unknown", session.snapshot().get("state"));
    }

    @Test
    void lossOfTheControllerBeforeAWriteIsNotReportedAsAKnownPausedTarget() {
        Controller jdbc = new Controller();
        PlDebugSession session = jdbc.session(List.of());
        jdbc.nativeBreakpoints.failReadAt = 1;
        assertThrows(SQLException.class, () -> session.setBreakpoints(List.of(breakpoint(7))));
        assertEquals(0, jdbc.nativeBreakpoints.sets);
        assertEquals("unknown", session.snapshot().get("state"));
        assertNull(session.snapshot().get("breakpointMutationOutcome"), "The write did not dispatch; the controller/session is what became unknown");
        assertThrows(IllegalStateException.class, session::resume);
        assertEquals(List.of(), jdbc.flags);
    }

    @Test
    void publicCrudReusesRegistrationsAndAnOldDeletedNumberCannotDeleteItsReplacement() throws Exception {
        Controller jdbc = new Controller();
        PlDebugSession session = jdbc.session(List.of(breakpoint(7), breakpoint(8)));
        assertEquals(2, jdbc.nativeBreakpoints.sets);
        assertTrue(session.listBreakpoints().getFirst().getWarning().isEmpty(), "A unique routine must not receive an overload warning");
        session.setBreakpoints(List.of(breakpoint(7)));
        assertEquals(2, jdbc.nativeBreakpoints.sets);
        assertEquals(2, session.listBreakpoints().size());
        session.deleteBreakpoints(List.of(breakpoint(8)));
        session.setBreakpoints(List.of(breakpoint(8)));
        int writes = jdbc.nativeBreakpoints.writes;
        session.deleteBreakpoints(List.of(breakpoint(8)));
        assertEquals(writes, jdbc.nativeBreakpoints.writes);
        assertEquals(2, session.listBreakpoints().size());
        assertTrue(session.listBreakpoints().stream().anyMatch(item -> item.getBreakpointNumber() == 9 && item.getLine() == 8));
    }

    @Test
    void boundedLoopsNeverClaimTheProgramFinished() throws Exception {
        Controller jdbc = new Controller();
        PlDebugSession session = jdbc.session(List.of());
        var response = session.resumeIgnoreBreakpoints();
        assertEquals(false, response.get("terminated"));
        assertTrue(response.get("message").toString().contains("200"));
        assertEquals(200, jdbc.flags.size());
    }

    @Test
    void runToEndStopsAfterAnUnknownDisableWithoutContinuingOrRestoring() throws Exception {
        Controller jdbc = new Controller();
        jdbc.toggleFailureAt = 2;
        jdbc.toggleFailure = new SQLException("The second disable ran but its reply was lost", "08006");
        PlDebugSession session = jdbc.session(List.of(breakpoint(7), breakpoint(8)));
        assertSame(jdbc.toggleFailure, assertThrows(SQLException.class, session::resumeIgnoreBreakpoints));
        assertEquals(List.of(7, 8), jdbc.disabled);
        assertEquals(List.of(), jdbc.enabled);
        assertEquals(List.of(), jdbc.flags);
        assertEquals("unknown", session.snapshot().get("state"));
        assertThrows(IllegalStateException.class, session::resume);
        assertEquals(List.of(), jdbc.flags);
    }

    @Test
    void runToEndDoesNotRestoreAfterAnUnknownContinuation() throws Exception {
        Controller jdbc = new Controller();
        jdbc.controlFailure = new SQLException("The continuation reply was lost", "08006");
        PlDebugSession session = jdbc.session(List.of(breakpoint(7), breakpoint(8)));
        assertSame(jdbc.controlFailure, assertThrows(SQLException.class, session::resumeIgnoreBreakpoints));
        assertEquals(List.of(7, 8), jdbc.disabled);
        assertEquals(List.of(), jdbc.enabled);
        assertEquals(List.of(512), jdbc.flags);
        assertEquals("unknown", session.snapshot().get("state"));
    }

    @Test
    void runToEndStopsRestorationAtTheFirstUnknownResult() throws Exception {
        Controller jdbc = new Controller();
        jdbc.stops.add(stop(3, 7, false));
        jdbc.toggleFailureAt = 3;
        jdbc.toggleFailure = new SQLException("The first restore ran but its reply was lost", "08006");
        PlDebugSession session = jdbc.session(List.of(breakpoint(7), breakpoint(8)));
        assertSame(jdbc.toggleFailure, assertThrows(SQLException.class, session::resumeIgnoreBreakpoints));
        assertEquals(List.of(7, 8), jdbc.disabled);
        assertEquals(List.of(7), jdbc.enabled, "No second restoration may follow an unknown first restoration");
        assertEquals(List.of(512), jdbc.flags);
        assertEquals("unknown", session.snapshot().get("state"));
    }

    private static PlDebugNative.Stop stop(int reason, int breakpoint, boolean terminated) {
        return stop(reason, breakpoint, terminated, 1);
    }

    private static PlDebugNative.Stop stop(int reason, int breakpoint, boolean terminated, Integer depth) {
        return new PlDebugNative.Stop(0, 5, terminated, reason, depth, breakpoint, "PROC", "SCOTT", 1);
    }

    private static PlDebugBreakpoint breakpoint(int number) {
        PlDebugBreakpoint breakpoint = new PlDebugBreakpoint();
        breakpoint.setBreakpointNumber(number);
        breakpoint.setOwner("SCOTT");
        breakpoint.setName("PROC");
        breakpoint.setKind("PROCEDURE");
        breakpoint.setLine(number);
        return breakpoint;
    }

    private static final class Controller {
        final Deque<PlDebugNative.Stop> stops = new ArrayDeque<>();
        final List<Integer> flags = new ArrayList<>();
        final List<Integer> enabled = new ArrayList<>();
        final List<Integer> disabled = new ArrayList<>();
        final CompletableFuture<Void> target = new CompletableFuture<>();
        PlDebugNative.Stop current = stop(8, 0, false);
        int toggleResult;
        int toggleCalls;
        int toggleFailureAt;
        SQLException toggleFailure;
        SQLException controlFailure;
        boolean missingResult;
        Runnable afterControl = () -> {};
        final PlDebugBreakpointRegistryTest.Server nativeBreakpoints = new PlDebugBreakpointRegistryTest.Server();

        PlDebugSession session(List<PlDebugBreakpoint> breakpoints) {
            breakpoints.forEach(item -> nativeBreakpoints.numbers.add(item.getBreakpointNumber()));
            Connection connection = proxy(Connection.class, (method, args) -> {
                if (method.getName().equals("prepareStatement")) {
                    return proxy(java.sql.PreparedStatement.class, (query, bindings) -> {
                        if (!query.getName().equals("executeQuery")) return empty(query.getReturnType());
                        boolean[] read = {false};
                        return proxy(java.sql.ResultSet.class, (row, values) -> switch (row.getName()) {
                            case "next" -> { boolean next = !read[0]; read[0] = true; yield next; }
                            case "getInt" -> 1;
                            default -> empty(row.getReturnType());
                        });
                    });
                }
                if (!method.getName().equals("prepareCall")) return empty(method.getReturnType());
                String sql = (String) args[0];
                boolean control = sql.contains("DBMS_DEBUG.continue");
                boolean enable = sql.contains("enable_breakpoint");
                boolean listing = sql.contains("SHOW_BREAKPOINTS");
                boolean create = sql.contains("set_breakpoint(");
                CallableStatement nativeCall = control ? null : nativeBreakpoints.connection().prepareCall(sql);
                int[] argument = {0};
                boolean[] wasNull = {false};
                return proxy(CallableStatement.class, (member, values) -> {
                    switch (member.getName()) {
                        case "setInt":
                            argument[0] = (int) values[1];
                            if (nativeCall != null) nativeCall.setInt((int) values[0], (int) values[1]);
                            return null;
                        case "setString":
                            if (nativeCall != null) nativeCall.setString((int) values[0], (String) values[1]);
                            return null;
                        case "execute":
                            if (listing || create) return nativeCall.execute();
                            if (control) {
                                flags.add(argument[0]);
                                if (controlFailure != null) throw controlFailure;
                                if (!stops.isEmpty()) current = stops.removeFirst();
                                if (current.terminated()) target.complete(null);
                                afterControl.run();
                            } else {
                                (enable ? enabled : disabled).add(argument[0]);
                                toggleCalls++;
                                if (toggleResult == 0) nativeCall.execute();
                                if (toggleCalls == toggleFailureAt && toggleFailure != null) throw toggleFailure;
                            }
                            return false;
                        case "getInt":
                            if (create) return nativeCall.getInt((int) values[0]);
                            if (!control) return toggleResult;
                            Integer value = switch ((int) values[0]) {
                                case 2 -> missingResult ? null : Integer.valueOf(current.result());
                                case 3 -> current.line();
                                case 4 -> current.terminated() ? 1 : 0;
                                case 5 -> current.reason();
                                case 6 -> current.depth();
                                case 7 -> current.breakpoint();
                                case 10 -> current.namespace();
                                default -> 0;
                            };
                            wasNull[0] = value == null;
                            return value == null ? 0 : value;
                        case "wasNull": return create ? nativeCall.wasNull() : wasNull[0];
                        case "getString": return listing ? nativeCall.getString((int) values[0]) : (int) values[0] == 8 ? current.program() : current.owner();
                        default: return empty(member.getReturnType());
                    }
                });
            });
            PlDebugSession session = PlDebugSession.withConnections("native-id", "SCOTT", null, connection, false, breakpoints, target);
            assertDoesNotThrow(() -> PlDebugLifecycleTest.allowExceptionFixture(session));
            return session;
        }
    }
}
