package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

/**
 * Author debugger regressions retained for source, native result and bounded stepping.
 * Generated named-call locations and exact identities are covered by PlDebugTargetTest.
 * Native calls and zero-helper behavior are covered by PlDebugNativeTest,
 * PlDebugControlTest, PlDebugOutputTest and PlDebugLifecycleTest.
 */
class PlDebugSessionTest {
    @Test
    void removingTheClientSlashDoesNotTrimUserSourceOrShiftItsLines() {
        String source = "\n\n  BEGIN\n    NULL;\n  END;\n";
        Assertions.assertEquals(source, PlDebugSession.stripTrailingSlash(source + "/\n"));
        Assertions.assertEquals(source, PlDebugSession.stripTrailingSlash(source));
        Assertions.assertEquals("BEGIN NULL; END;", PlDebugSession.stripTrailingSlash("BEGIN NULL; END;/"));
    }


    /**
     * The caller sends {name, frame, index, value}; the agent turns it into the
     * PL/SQL assignment DBMS_DEBUG.SET_VALUE executes. The value is forwarded
     * verbatim (the desktop client quotes string literals itself), and an index
     * addresses a collection element unless the name already carries one.
     */
    @Test
    void rendersTheAssignmentStatementSetValueExecutes() {
        Assertions.assertEquals("x := 5", PlDebugSession.assignmentStatement("x", 0, "5"));
        Assertions.assertEquals("x := 5", PlDebugSession.assignmentStatement("  x  ", 0, "5"));
        Assertions.assertEquals("s := 'abc'", PlDebugSession.assignmentStatement("s", 0, "'abc'"));
        Assertions.assertEquals("s := ''abc''", PlDebugSession.assignmentStatement("s", 0, "''abc''"));
        Assertions.assertEquals("arr(1) := 5", PlDebugSession.assignmentStatement("arr", 1, "5"));
        Assertions.assertEquals("arr(1) := 5", PlDebugSession.assignmentStatement("arr(1)", 1, "5"));
        Assertions.assertEquals("arr(2) := 5", PlDebugSession.assignmentStatement("arr(2)", 0, "5"));
        Assertions.assertEquals(
            "d := to_date('2024-01-01','YYYY-MM-DD')",
            PlDebugSession.assignmentStatement("d", 0, "to_date('2024-01-01','YYYY-MM-DD')")
        );
    }

    /**
     * The -1 sentinel covers "the routine is not declared" and "the assignment
     * failed" at once; the wrapper's SQLERRM is what keeps them apart, so a malformed
     * assignment is not reported as "this server cannot change variable values".
     */
    @Test
    void separatesAMissingPrimitiveFromARejectedAssignment() {
        Assertions.assertTrue(PlDebugSession.capabilityMissing(
            "ORA-06550: line 1, column 18:\nPLS-00201: identifier 'DBMS_DEBUG.SET_VALUE' must be declared"
        ));
        Assertions.assertTrue(PlDebugSession.capabilityMissing("PLS-00302: component 'SET_VALUE' must be declared"));
        Assertions.assertTrue(PlDebugSession.capabilityMissing("ORA-00904: \"DBMS_DEBUG\".\"SET_VALUE\": invalid identifier"));
        Assertions.assertFalse(PlDebugSession.capabilityMissing(""));
        Assertions.assertFalse(PlDebugSession.capabilityMissing(null));
        Assertions.assertFalse(PlDebugSession.capabilityMissing(
            "ORA-06550: line 1, column 22:\nPLS-00103: Encountered the symbol \"end-of-file\""
        ));
        Assertions.assertFalse(PlDebugSession.capabilityMissing("ORA-00900: invalid SQL statement"));
        Assertions.assertFalse(PlDebugSession.capabilityMissing("ORA-06502: PL/SQL: numeric or value error"));
    }

    /**
     * error_no_such_breakpt (13) is a real answer from a server that does implement
     * the primitive, so it must not be reported as "unsupported" (-1).
     */
    @Test
    void breakpointToggleMessagesKeepUnavailableApartFromUnknownBreakpoint() {
        String enabled = PlDebugSession.breakpointEnabledMessage(7, true, 0);
        Assertions.assertTrue(enabled.contains("7"));
        Assertions.assertTrue(enabled.contains("启用"));
        String disabled = PlDebugSession.breakpointEnabledMessage(7, false, 0);
        Assertions.assertTrue(disabled.contains("禁用"));
        String unavailable = PlDebugSession.breakpointEnabledMessage(7, true, -1);
        Assertions.assertTrue(unavailable.contains("不支持"));
        Assertions.assertTrue(unavailable.contains("兜底"));
        String unknown = PlDebugSession.breakpointEnabledMessage(7, true, 13);
        Assertions.assertTrue(unknown.contains("error_no_such_breakpt"));
        Assertions.assertFalse(unknown.contains("不支持"));
        Assertions.assertTrue(PlDebugSession.breakpointEnabledMessage(7, true, 26).contains("result=26"));
    }

    /**
     * The whole split rule of the Go driver's {@code plDebugSplitPackageSubprogram}:
     * the first dot separates the package from the subprogram, and both halves have to
     * be plain identifiers.
     */
    @Test
    void splitsAPackageSubprogramNameOnlyForTwoPlainIdentifiers() {
        Assertions.assertArrayEquals(
            new String[] {"DBX_MSBP_PKG", "RUN_MSBP"},
            PlDebugSession.splitPackageSubprogram("DBX_MSBP_PKG.RUN_MSBP")
        );
        Assertions.assertNull(PlDebugSession.splitPackageSubprogram("DBX_MSBP_TOP"));
        Assertions.assertNull(PlDebugSession.splitPackageSubprogram("DBX_MSBP_PKG."));
        Assertions.assertNull(PlDebugSession.splitPackageSubprogram(".RUN_MSBP"));
        Assertions.assertNull(PlDebugSession.splitPackageSubprogram("DBX_DEBUG.DBX_MSBP_PKG.RUN_MSBP"));
        Assertions.assertNull(PlDebugSession.splitPackageSubprogram("\"My Pkg\".\"My Proc\""));
        Assertions.assertNull(PlDebugSession.splitPackageSubprogram(""));
        Assertions.assertNull(PlDebugSession.splitPackageSubprogram(null));
    }

    @Test
    void parsesEveryBacktraceFrameInnermostFirst() {
        PlDebugNative.Stop runtime = new PlDebugNative.Stop(0, 12, false, 9, 4, 0, "PKG_INNER.PROC", "SCOTT", 1);
        PlDebugNative.Stack stack = PlDebugNative.parseStack("""
            [{"name":"PKG_INNER.PROC","owner":"SCOTT","namespace":1},
             {"name":"PKG_MIDDLE.CALLER","owner":"SCOTT","namespace":1},
             {"name":"TOP_LEVEL","owner":"SCOTT","namespace":1},
             {"name":"ANONYMOUS BLOCK","namespace":0}]
            """, "[Line 12] PKG_INNER.PROC\n\n[Line 30] PKG_MIDDLE.CALLER\n[Line 44] SCOTT.TOP_LEVEL\n[Line 0] ANONYMOUS BLOCK\n", runtime);
        List<PlDebugNative.Frame> frames = stack.frames();
        Assertions.assertTrue(stack.complete());
        Assertions.assertEquals(4, frames.size());
        Assertions.assertEquals(12, frames.get(0).line());
        Assertions.assertEquals("PKG_INNER.PROC", frames.get(0).program());
        Assertions.assertEquals(List.of(4, 3, 2, 1), frames.stream().map(PlDebugNative.Frame::nativeFrameId).toList());
        Assertions.assertEquals(30, frames.get(1).line());
        Assertions.assertEquals(44, frames.get(2).line());
        Assertions.assertEquals("TOP_LEVEL", frames.get(2).program());
        Assertions.assertEquals("SCOTT", frames.get(2).owner());
        Assertions.assertEquals(0, frames.get(3).line());
    }

    @Test
    void unrecognizedTextIsNotReportedAsAnEmptyOrCompleteNativeStack() {
        PlDebugNative.Stop runtime = new PlDebugNative.Stop(0, 7, false, 9, 1, 0, "PROC", "SCOTT", 1);
        for (String listing : java.util.Arrays.asList(null, "", "no frame here\nLine without digits\n", "[Line] \n[Line 7] PROC")) {
            PlDebugNative.Stack stack = PlDebugNative.parseStack("[{\"name\":\"PROC\",\"owner\":\"SCOTT\",\"namespace\":1}]", listing, runtime);
            Assertions.assertFalse(stack.complete());
            Assertions.assertEquals(1, stack.frames().size());
            Assertions.assertEquals(7, stack.frames().getFirst().line());
            Assertions.assertEquals("PROC", stack.frames().getFirst().program());
            Assertions.assertEquals("verified", stack.frameMappingState());
        }
    }

    @Test
    void warnsOnlyForAmbiguousTargetsTheCallerDidNotDisambiguate() {
        String warning = PlDebugSession.overloadWarningForTarget("SCOTT", "PROC", 3, false, false);
        Assertions.assertTrue(warning.contains("SCOTT.PROC"));
        Assertions.assertTrue(warning.contains("3 个同名重载"));
        Assertions.assertTrue(warning.contains("signature/sequence"));

        Assertions.assertEquals("", PlDebugSession.overloadWarningForTarget("SCOTT", "PROC", 1, false, false));
        Assertions.assertEquals("", PlDebugSession.overloadWarningForTarget("SCOTT", "PROC", 3, true, false));
        Assertions.assertEquals("", PlDebugSession.overloadWarningForTarget("SCOTT", "PROC", 3, false, true));
        Assertions.assertNotEquals("", PlDebugSession.overloadWarningForTarget("SCOTT", "PROC", 2, false, false));
    }

    /**
     * MAX_TRY_STEP_INTO_TIMES (ODC's stepInForStartingDebug) is 5 in the Go driver as
     * well: the start sequence steps in at most that many times waiting for the stack
     * depth to grow, and an attempt that fails propagates instead of being retried.
     */
    @Test
    void stepsInAtMostFiveTimesAndPropagatesFailures() throws Exception {
        Assertions.assertEquals(5, PlDebugSession.START_STEP_IN_LIMIT);

        // The depth grows on the third attempt: the loop stops there.
        int[] attempts = new int[] {0};
        int reached = PlDebugSession.stepInUntilDeeper(0, PlDebugSession.START_STEP_IN_LIMIT, () -> {
            attempts[0]++;
            return attempts[0] < 3 ? 0 : 1;
        });
        Assertions.assertEquals(1, reached);
        Assertions.assertEquals(3, attempts[0]);

        // The depth never grows: exactly 5 attempts, then the ODC failure message.
        int[] exhausted = new int[] {0};
        IllegalStateException never = Assertions.assertThrows(
            IllegalStateException.class,
            () -> PlDebugSession.stepInUntilDeeper(0, PlDebugSession.START_STEP_IN_LIMIT, () -> {
                exhausted[0]++;
                return 0;
            })
        );
        Assertions.assertEquals(5, exhausted[0]);
        Assertions.assertEquals("stack depth stayed at 0 after 5 step-in attempts", never.getMessage());

        // A failing attempt is reported as-is, without burning the remaining attempts.
        int[] failed = new int[] {0};
        IllegalStateException propagated = Assertions.assertThrows(
            IllegalStateException.class,
            () -> PlDebugSession.stepInUntilDeeper(2, PlDebugSession.START_STEP_IN_LIMIT, () -> {
                failed[0]++;
                throw new IllegalStateException("the debuggee finished while stepping in");
            })
        );
        Assertions.assertEquals(1, failed[0]);
        Assertions.assertEquals("the debuggee finished while stepping in", propagated.getMessage());
    }

    /**
     * debugBefore only runs for a named routine; an ANONYMOUS target is submitted
     * verbatim and keeps its caller-supplied breakpoints.
     */
    @Test
    void skipsDebugBeforeForAnonymousTargets() {
        Assertions.assertTrue(PlDebugSession.debugBeforeApplies("PROCEDURE"));
        Assertions.assertTrue(PlDebugSession.debugBeforeApplies(" function "));
        Assertions.assertFalse(PlDebugSession.debugBeforeApplies("ANONYMOUS"));
        Assertions.assertFalse(PlDebugSession.debugBeforeApplies("PACKAGE"));
        Assertions.assertFalse(PlDebugSession.debugBeforeApplies(""));
        Assertions.assertFalse(PlDebugSession.debugBeforeApplies(null));
    }

    /**
     * A requested display label cannot fill absent native identity or stack depth.
     */
    @Test
    void startSnapshotDoesNotInventAnEntryIdentityWithoutANativeStop() {
        PlDebugSession session = PlDebugSession.withoutConnections("dbg-1", "SCOTT");
        Assertions.assertNull(session.startSnapshot().get("program"), "the zero state has no program");
        Assertions.assertNull(session.startSnapshot().get("stackDepth"), "the zero state has no stack depth");

        session.publishStartFrame();
        Map<String, Object> snapshot = session.startSnapshot();
        Assertions.assertEquals("dbg-1", snapshot.get("debugId"));
        Assertions.assertEquals("SCOTT", snapshot.get("owner"));
        Assertions.assertNull(snapshot.get("program"));
        Assertions.assertNull(snapshot.get("programOwner"));
        Assertions.assertNull(snapshot.get("stackDepth"), "do not invent depth when native backtrace is unavailable");
        Assertions.assertEquals(false, snapshot.get("terminated"));
    }
}
