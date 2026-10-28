package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugParam;
import com.dbx.agent.PlDebugStartRequest;
import com.dbx.agent.PlDebugBreakpointMutation;
import org.junit.jupiter.api.Test;

import javax.sql.rowset.serial.SerialClob;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugNamedLifecycleTest {
    @Test
    void legacySelectedPackageBreakpointsReuseTheProvenFrameAndFlatRegistration() throws Exception {
        for (String program : List.of("P_TEST.RUN", "P_TEST.__init__")) {
            try (Fixture jdbc = new Fixture()) {
                jdbc.enteredProgram = program;
                jdbc.metadata.bodyText = "PACKAGE BODY P_TEST IS\nBEGIN\n NULL;\nEND;\n";
                PlDebugSession session = jdbc.start();
                var frame = (Map<?, ?>) ((List<?>) session.stack().get("frames")).getFirst();
                var ref = (PlDebugSource.Reference) frame.get("sourceRef");
                com.dbx.agent.PlDebugBreakpoint legacy = new com.dbx.agent.PlDebugBreakpoint();
                legacy.setOwner("SCOTT"); legacy.setName(program); legacy.setLine(3);
                legacy.setKind("PROCEDURE");
                int before = jdbc.base.nativeBreakpoints.sets;
                var created = session.setBreakpoints(List.of(legacy));
                assertEquals(0, created.get("result"));
                assertEquals(new PlDebugBreakpointInventory.Program("SCOTT", program, 2, 3), jdbc.base.nativeBreakpoints.lastSet);
                var registration = session.listBreakpoints().getFirst();
                assertEquals(ref.id(), registration.getSourceRefId());
                var flat = session.mutateBreakpoint("set_breakpoints", create(ref, 3), () -> fail("No duplicate native SET"));
                assertEquals(registration.getRegistrationId(), flat.get("registrationId"));
                assertEquals(before + 1, jdbc.base.nativeBreakpoints.sets);
                session.close();
            }
        }
    }

    @Test
    void packageSourceReferencesBindTheContainerButSetTheExactCurrentNativeProgram() throws Exception {
        for (String program : List.of("P_TEST.RUN", "P_TEST.__init__")) {
            try (Fixture jdbc = new Fixture()) {
                jdbc.enteredProgram = program;
                jdbc.metadata.bodyText = "PACKAGE BODY P_TEST IS\nBEGIN\n NULL;\nEND;\n";
                PlDebugSession session = jdbc.start();
                var frame = (Map<?, ?>) ((List<?>) session.stack().get("frames")).getFirst();
                var ref = (PlDebugSource.Reference) frame.get("sourceRef");
                assertEquals("resolved", frame.get("sourceState"));
                assertEquals(3, frame.get("sourceLine"));
                assertEquals("P_TEST", ref.name());
                var create = create(ref, 3);
                int sets = jdbc.base.nativeBreakpoints.sets;
                var result = session.mutateBreakpoint("set_breakpoints", create, () -> {});
                assertEquals(true, result.get("ok"));
                assertTrue(jdbc.base.nativeBreakpoints.listing().contains("SCOTT." + program + ", Line 3"));
                assertEquals(sets + 1, jdbc.base.nativeBreakpoints.sets);
                assertEquals(result.get("registrationId"), session.mutateBreakpoint("set_breakpoints", create, () -> {}).get("registrationId"));
                assertEquals(sets + 1, jdbc.base.nativeBreakpoints.sets);
                assertThrows(IllegalStateException.class, () -> session.mutateBreakpoint("set_breakpoints",
                    new PlDebugBreakpointMutation("stale", ref.id(), 1L, ref.stopRevision() - 1, ref.nativeFrameId(), 3,
                        null, null, true, null), () -> {}));
                assertThrows(IllegalArgumentException.class, () -> session.mutateBreakpoint("set_breakpoints",
                    new PlDebugBreakpointMutation("wrong-frame", ref.id(), 1L, ref.stopRevision(), 1, 3,
                        null, null, true, null), () -> {}));
                assertEquals(sets + 1, jdbc.base.nativeBreakpoints.sets);
                jdbc.base.nativeBreakpoints.setResult = 12;
                var rejected = session.mutateBreakpoint("set_breakpoints", create(ref, 4), () -> {});
                assertEquals(12, rejected.get("result"));
                assertEquals(sets + 2, jdbc.base.nativeBreakpoints.sets, "a refused line must not be retried under another program");
                session.close();
            }
        }
    }

    @Test
    void anyCompleteTargetVersionChangeInvalidatesSetAndEnableButNotOwnedDelete() throws Exception {
        for (String change : List.of("spec", "body", "signature")) {
            try (Fixture jdbc = new Fixture()) {
                jdbc.metadata.bodyText = "PACKAGE BODY P_TEST IS\nBEGIN\n NULL;\nEND;\n";
                PlDebugSession session = jdbc.start();
                var frame = (Map<?, ?>) ((List<?>) session.stack().get("frames")).getFirst();
                var ref = (PlDebugSource.Reference) frame.get("sourceRef");
                var created = session.mutateBreakpoint("set_breakpoints", create(ref, 3), () -> {});
                int number = ((Number) created.get("breakpointNumber")).intValue();
                String id = (String) created.get("registrationId");
                session.mutateBreakpoint("set_breakpoint_enabled", existing(ref, number, id, false), () -> {});
                if (change.equals("spec")) jdbc.metadata.specText += "-- spec changed without a new DDL timestamp\n";
                else if (change.equals("body")) jdbc.metadata.bodyText += "-- body changed without a new DDL timestamp\n";
                else jdbc.metadata.arguments.put(1, List.of(PlDebugTargetTest.arg(null, 0, "OUT", "NUMBER", "N"),
                    PlDebugTargetTest.arg("P_IN", 1, "IN", "VARCHAR2", "N"), PlDebugTargetTest.arg("P_OUT", 2, "OUT", "NUMBER", "N")));
                int writes = jdbc.base.nativeBreakpoints.writes;
                assertThrows(IllegalStateException.class, () -> session.mutateBreakpoint("set_breakpoints", create(ref, 4), () -> {}));
                assertThrows(IllegalStateException.class, () -> session.mutateBreakpoint("set_breakpoint_enabled", existing(ref, number, id, true), () -> {}));
                assertEquals(writes, jdbc.base.nativeBreakpoints.writes);
                var staleStack = session.stack();
                assertEquals("changed", staleStack.get("targetSourceState"));
                assertFalse(((Map<?, ?>) ((List<?>) staleStack.get("frames")).getFirst()).containsKey("sourceRef"));
                assertEquals(true, session.mutateBreakpoint("delete_breakpoints", existing(ref, number, id, null), () -> {}).get("ok"));
                session.close();
            }
        }
    }

    private static PlDebugBreakpointMutation create(PlDebugSource.Reference ref, int line) {
        return new PlDebugBreakpointMutation("create-" + line, ref.id(), 1L, ref.stopRevision(), ref.nativeFrameId(), line, null, null, true, null);
    }

    @Test
    void aChangedPackageVersionKeepsTheBreakpointStopWithoutAutomaticRuleContinuation() throws Exception {
        for (String change : List.of("spec", "body", "signature")) {
            try (Fixture jdbc = new Fixture()) {
                jdbc.metadata.bodyText = "PACKAGE BODY P_TEST IS\nBEGIN\n NULL;\nEND;\n";
                PlDebugSession session = jdbc.start();
                var frame = (Map<?, ?>) ((List<?>) session.stack().get("frames")).getFirst();
                var ref = (PlDebugSource.Reference) frame.get("sourceRef");
                var created = session.mutateBreakpoint("set_breakpoints", new PlDebugBreakpointMutation("rules", ref.id(),
                    1L, ref.stopRevision(), ref.nativeFrameId(), 3, null, null, true, Map.of("ignoreCount", 10)), () -> {});
                jdbc.breakpointStop = ((Number) created.get("breakpointNumber")).intValue();
                if (change.equals("spec")) jdbc.metadata.specText += "-- changed\n";
                else if (change.equals("body")) jdbc.metadata.bodyText += "-- changed\n";
                else jdbc.metadata.arguments.put(1, List.of(PlDebugTargetTest.arg(null, 0, "OUT", "NUMBER", "N"),
                    PlDebugTargetTest.arg("P_IN", 1, "IN", "VARCHAR2", "N"), PlDebugTargetTest.arg("P_OUT", 2, "OUT", "NUMBER", "N")));
                var stopped = session.resume();
                assertEquals("paused", stopped.get("state"));
                assertEquals(1, jdbc.businessContinues, "a stale source must not authorize an ignore-count continuation");
                assertFalse(((List<?>) stopped.get("breakpointRuleEvents")).isEmpty());
                session.close();
            }
        }
    }

    private static PlDebugBreakpointMutation existing(PlDebugSource.Reference ref, int number, String id, Boolean enabled) {
        return new PlDebugBreakpointMutation("existing", null, null, ref.stopRevision(), null, null, number, id, enabled, null);
    }

    @Test
    void anUnprovenNamedWrapperDoesNotArmOrResumeTheTarget() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.base.wrongRootToken = true;
            PlDebugSession session = jdbc.start();
            assertEquals("__anonymous_block__", session.startSnapshot().get("program"));
            assertEquals(0, jdbc.base.nativeBreakpoints.sets);
            assertEquals(0, jdbc.resumesBeforeEntry);
            assertFalse(jdbc.entered);
            assertEquals(3, jdbc.base.flags.size());
            session.close();
        }
    }

    @Test
    void packageInitializationIsAUserStopRatherThanAFailedTargetEntry() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.enteredProgram = "P_TEST.__init__";
            PlDebugSession session = jdbc.start();
            assertEquals("paused", session.startSnapshot().get("state"));
            assertEquals("P_TEST.__init__", session.startSnapshot().get("program"));
            assertEquals("initializing_package", session.startSnapshot().get("executionStage"));
            session.close();
        }
    }

    @Test
    void aMemberNamedLikeTheInitializerDoesNotClaimSelectedMemberEntry() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.requestedName = "__init__";
            jdbc.enteredProgram = "P_TEST.__init__";
            jdbc.metadata.bodyText = "PACKAGE BODY P_TEST IS\nBEGIN\n NULL;\nEND;\n";
            PlDebugSession session = jdbc.start();
            assertEquals("entry_identity_unresolved", session.snapshot().get("executionStage"));
            assertFalse(((Map<?, ?>) ((List<?>) session.stack().get("frames")).getFirst()).containsKey("sourceRef"));
            session.close();
        }
    }

    @Test
    void anUnconfirmedStartupBreakpointNeverResumesIntoTheBusinessTarget() throws Exception {
        for (int result : List.of(12, 28)) {
            try (Fixture jdbc = new Fixture()) {
                jdbc.base.nativeBreakpoints.setResult = result;
                assertThrows(IllegalStateException.class, jdbc::start);
                assertEquals(1, jdbc.base.nativeBreakpoints.sets);
                assertEquals(0, jdbc.resumesBeforeEntry);
                assertFalse(jdbc.entered);
                assertTrue(jdbc.base.nativeBreakpoints.records.isEmpty());
                assertTrue(jdbc.base.events.contains("debugger.close"));
                assertTrue(jdbc.base.events.contains("debuggee.close"));
            }
        }
    }

    @Test
    void replayingTheSameSignatureWithDifferentObjectKeyOrderDoesNotStartAnotherTarget() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            AtomicInteger opens = new AtomicInteger();
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent(() -> jdbc.connection(opens.getAndIncrement() % 2 == 0));
            PlDebugStartRequest request = jdbc.request();
            request.setOperationId("signature-key-order");
            Map<String, Object> signature = PlDebugTarget.resolve(jdbc.metadata.connection(), "SCOTT", request).target().signature();
            request.setTargetSignature(signature);
            Map<String, Object> started = agent.plDebugStart(request);
            PlDebugSource.Version source = (PlDebugSource.Version) started.get("targetSource");
            assertEquals("SCOTT", source.owner());
            assertEquals("P_TEST", source.name());
            assertEquals("PACKAGE BODY", source.objectType());
            assertEquals("candidate", source.state());
            assertEquals(2, source.lines().size());
            try {
                List<String> keys = new ArrayList<>(signature.keySet());
                Collections.reverse(keys);
                Map<String, Object> reordered = new LinkedHashMap<>();
                for (String key : keys) reordered.put(key, signature.get(key));
                request.setTargetSignature(reordered);
                assertEquals("paused", assertDoesNotThrow(() -> agent.plDebugStart(request)).get("state"));
                assertEquals(1, jdbc.base.targetExecutions.get());
                assertEquals(2, opens.get());
            } finally {
                agent.plDebugResume("signature-key-order");
                agent.plDebugClose("signature-key-order");
            }
        }
    }

    @Test
    void aFieldReadFailurePreservesTheBusinessReceiptAndOtherTypedResults() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.failOutRead = true;
            PlDebugSession session = jdbc.start();
            assertEquals("pending", ((Map<?, ?>) session.snapshot().get("returnValue")).get("state"));
            Map<String, Object> end = session.resume();
            assertEquals("succeeded", end.get("executionOutcome"));
            assertEquals("returned", end.get("executionStage"));
            assertEquals("partial", end.get("outParamsState"));
            assertEquals("error", ((Map<?, ?>) ((List<?>) end.get("outParams")).getFirst()).get("state"));
            assertEquals("82", ((Map<?, ?>) end.get("returnValue")).get("value"));
            assertEquals("NUMBER", ((Map<?, ?>) end.get("returnValue")).get("type"));
            assertEquals("pending", end.get("transactionOutcome"));
            session.close();
            assertEquals("released", session.snapshot().get("releaseState"));
            assertEquals(1, jdbc.base.targetExecutions.get());
        }
    }

    @Test
    void aPostReturnExportErrorDoesNotBecomeABusinessFailureOrDiscardAnEarlierOut() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.phase = 2;
            jdbc.base.capturedError = -6502;
            PlDebugSession session = jdbc.start();
            Map<String, Object> end = session.resume();
            assertEquals("succeeded", end.get("executionOutcome"));
            assertNull(end.get("error"));
            assertNotNull(end.get("resultError"));
            assertEquals("42", ((Map<?, ?>) ((List<?>) end.get("outParams")).getFirst()).get("value"));
            assertEquals("error", ((Map<?, ?>) end.get("returnValue")).get("state"));
            assertEquals("partial", end.get("outParamsState"));
            assertEquals(-1, end.get("savepointRollback"));
            session.close();
        }
    }

    @Test
    void outputTransferFailureDoesNotEraseAConfirmedReturnOrItsBoundValues() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.failOutputRead = true;
            PlDebugSession session = jdbc.start();
            Map<String, Object> end = session.resume();
            assertEquals("succeeded", end.get("executionOutcome"));
            assertNotNull(end.get("resultError"));
            assertEquals("available", end.get("outParamsState"));
            assertEquals("82", ((Map<?, ?>) end.get("returnValue")).get("value"));
            assertEquals(0, jdbc.base.cleanupExecutions.get(), "a consumed output buffer must not be drained again after transfer failure");
            session.close();
        }
    }

    static final class Fixture implements AutoCloseable {
        final PlDebugLifecycleTest.Fixture base = new PlDebugLifecycleTest.Fixture();
        final PlDebugTargetTest.Metadata metadata = new PlDebugTargetTest.Metadata();
        int phase = 3;
        boolean entered;
        String enteredProgram = "P_TEST.RUN";
        String requestedName = "RUN";
        boolean ended;
        boolean failOutRead;
        boolean failOutputRead;
        int resumesBeforeEntry;
        int breakpointStop;
        int businessContinues;

        Fixture() {
            metadata.arguments.put(1, List.of(PlDebugTargetTest.arg(null, 0, "OUT", "NUMBER", "N"),
                PlDebugTargetTest.arg("P_IN", 1, "IN", "NUMBER", "N"), PlDebugTargetTest.arg("P_OUT", 2, "OUT", "NUMBER", "N")));
        }

        PlDebugStartRequest request() {
            PlDebugStartRequest request = PlDebugTargetTest.request("NUMBER");
            request.setObjectType("FUNCTION");
            request.setObjectName(requestedName);
            request.setParams(List.of(new PlDebugParam("P_IN", "IN", "NUMBER", "41"), new PlDebugParam("P_OUT", "OUT", "NUMBER", null)));
            return request;
        }

        PlDebugSession start() throws Exception {
            return PlDebugSession.start(connection(true), connection(false), request(), base.targetWorker, 600000);
        }

        Connection connection(boolean debuggee) {
            Connection delegate = base.connection(debuggee);
            return proxy(Connection.class, (method, args) -> {
                if (method.getName().equals("prepareStatement") && ((String) args[0]).contains("SYS.ALL_")) return metadata.query((String) args[0]);
                if (method.getName().equals("prepareCall")) return call((String) args[0], debuggee);
                return invoke(delegate, method, args);
            });
        }

        CallableStatement call(String sql, boolean debuggee) {
            CallableStatement delegate = base.call(sql, debuggee);
            boolean target = debuggee && sql.contains("SAVEPOINT DBX_PD_");
            boolean control = !debuggee && (sql.contains("SYS.DBMS_DEBUG.continue(") || sql.contains("SYS.DBMS_DEBUG.synchronize("));
            boolean sync = control && sql.contains("synchronize(r");
            boolean bootstrapCall = control && !sync && base.rootSteps < 3;
            int[] flag = {0};
            return proxy(CallableStatement.class, (method, args) -> {
                int index = args.length > 0 && args[0] instanceof Integer n ? n : 0;
                if (target) {
                    if (method.getName().equals("getInt")) return switch (index) {
                        case 4 -> phase;
                        case 5 -> 1;
                        case 6 -> phase == 2 ? 0 : 1;
                        case 7 -> base.capturedError;
                        case 9 -> -1;
                        default -> 0;
                    };
                    if (method.getName().equals("getBigDecimal")) {
                        if (failOutRead && index == 2) throw new SQLException("injected OUT read failure", "HY000", 77);
                        return new BigDecimal(index == 2 ? "42" : "82");
                    }
                    if (method.getName().equals("getString")) return index == 8 && base.capturedError != 0 ? "export failure" : null;
                    if (method.getName().equals("getClob") && failOutputRead) throw new SQLException("injected output locator read failure");
                }
                if (control) {
                    if (sync || bootstrapCall) return invoke(delegate, method, args);
                    if (method.getName().equals("setInt") && index == 1) flag[0] = (int) args[1];
                    if (method.getName().equals("execute") && !sync) {
                        if (flag[0] == PlDebugNative.STEP_IN) { entered = true; return false; }
                        if (!entered && flag[0] == PlDebugNative.CONTINUE) {
                            if (!base.cancelled) resumesBeforeEntry++;
                            return false;
                        }
                        if (entered && flag[0] == PlDebugNative.CONTINUE) {
                            businessContinues++;
                            if (breakpointStop > 0) return false;
                        }
                        ended = true;
                    }
                    if (method.getName().equals("getInt")) return switch (index - (sync ? 0 : 1)) {
                        case 1 -> 0;
                        case 2 -> entered ? 3 : base.nativeBreakpoints.lastSet == null ? base.rootLine : base.nativeBreakpoints.lastSet.line();
                        case 3 -> ended ? 1 : 0;
                        case 4 -> ended ? 15 : breakpointStop > 0 ? 3 : 9;
                        case 5 -> entered ? 2 : 1;
                        case 6 -> breakpointStop;
                        case 9 -> entered ? 2 : 1;
                        default -> 0;
                    };
                    if (method.getName().equals("getString")) return index == (sync ? 7 : 8) ? entered ? enteredProgram : "__anonymous_block__" : "SCOTT";
                }
                if (!debuggee && sql.contains("backtrace_table") && method.getName().equals("getClob")) {
                    return new SerialClob("[{\"name\":\"P_TEST.RUN\",\"owner\":\"SCOTT\",\"namespace\":2},{\"name\":\"__anonymous_block__\",\"owner\":\"SCOTT\",\"namespace\":1}]".toCharArray());
                }
                return invoke(delegate, method, args);
            });
        }

        private static Object invoke(Object delegate, Method method, Object[] args) throws Throwable {
            try { return method.invoke(delegate, args); }
            catch (InvocationTargetException error) { throw error.getCause(); }
        }

        public void close() throws Exception { base.close(); }
    }
}
