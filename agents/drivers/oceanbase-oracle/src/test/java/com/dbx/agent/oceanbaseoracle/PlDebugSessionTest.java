package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

/**
 * Units for the PL/SQL debugger additions ported from the Go driver: the helper
 * package DDL that carries {@code DBX_SET_VALUE} /
 * {@code DBX_SET_BREAKPOINT_EX} / {@code DBX_ENABLE_BREAKPOINT} /
 * {@code DBX_DISABLE_BREAKPOINT}, the multi-frame backtrace parser, the overload
 * warning and the two value helpers. No server is contacted.
 */
class PlDebugSessionTest {
    /**
     * The {@code info_requested} mask every {@code DBX_CNT_*} wrapper passes. It is the
     * literal the Go driver writes ({@code plDebugRunInfoMask}); both agents install the
     * same helper package, so a difference here would make them rebuild the other's
     * body.
     */
    private static final String RUN_INFO_MASK = "dbms_debug.info_getStackDepth + dbms_debug.info_getLineinfo";

    /**
     * The standalone chain (spec/top-level namespace first, then the body) belongs to
     * {@code DBX_SET_BREAKPOINT} and {@code DBX_SET_BREAKPOINT_EX}: it is what makes a
     * top-level procedure armable on Oracle 19c EE, where a NULL namespace answers
     * error_bad_handle (16).
     */
    private static final String STANDALONE_NAMESPACE_CHAIN =
        "pro_info.namespace := dbms_debug.namespace_pkgspec_or_toplevel; result := dbms_debug.set_breakpoint"
            + "(pro_info, line#, breakpoint#); IF result <> 0 THEN pro_info.namespace := dbms_debug.namespace_pkg_body";

    /**
     * The entrypoint chain (body namespace first), which is the measured one-trip arm
     * for a subprogram inside a package body.
     */
    private static final String ENTRY_NAMESPACE_CHAIN =
        "pro_info.namespace := dbms_debug.namespace_pkg_body; result := dbms_debug.set_breakpoint"
            + "(pro_info, line#, breakpoint#); IF result <> 0 THEN"
            + " pro_info.namespace := dbms_debug.namespace_pkgspec_or_toplevel";

    @Test
    void packageHeadDeclaresSetValueAndSetBreakpointEx() {
        String head = DbxPlDebugPackage.packageHead("SCOTT");
        Assertions.assertTrue(
            head.contains("PROCEDURE " + DbxPlDebugPackage.PROCEDURE_SET_VALUE),
            "the package head must declare DBX_SET_VALUE, else the body compiles to INVALID"
        );
        // The real DBMS_DEBUG.SET_VALUE overloads are (frame#, assignment_statement)
        // and (handle, assignment_statement), both RETURN BINARY_INTEGER (Oracle 21c
        // XE verified); a four-argument wrapper can never match either of them.
        Assertions.assertTrue(
            head.contains(
                "PROCEDURE " + DbxPlDebugPackage.PROCEDURE_SET_VALUE
                    + "(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2,"
                    + " result OUT BINARY_INTEGER, message OUT VARCHAR2);"
            ),
            "the head must declare the two-argument DBX_SET_VALUE shape"
        );
        Assertions.assertFalse(head.contains("index# IN BINARY_INTEGER"));
        Assertions.assertFalse(head.contains("value IN VARCHAR2"));
        Assertions.assertTrue(
            head.contains(DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_EX),
            "the package head must declare DBX_SET_BREAKPOINT_EX"
        );
        Assertions.assertTrue(head.contains("\"SCOTT\"." + DbxPlDebugPackage.PACKAGE_NAME));
    }

    @Test
    void packageHeadDeclaresTheBreakpointToggleWrappers() {
        String head = DbxPlDebugPackage.packageHead("SCOTT");
        String body = DbxPlDebugPackage.packageBody("SCOTT");
        for (String procedure : new String[] {
            DbxPlDebugPackage.PROCEDURE_ENABLE_BREAKPOINT,
            DbxPlDebugPackage.PROCEDURE_DISABLE_BREAKPOINT,
        }) {
            Assertions.assertTrue(
                head.contains("PROCEDURE " + procedure + "(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER);"),
                "the head must declare " + procedure
            );
            Assertions.assertTrue(
                body.contains("PROCEDURE " + procedure + "(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER) IS"),
                "the body must define " + procedure
            );
        }
        // ENABLE_BREAKPOINT / DISABLE_BREAKPOINT are functions
        // ((breakpoint IN BINARY_INTEGER) RETURN BINARY_INTEGER), so they have to be
        // called in an assignment; a statement call raises PLS-00221.
        Assertions.assertTrue(body.contains(
            "EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.enable_breakpoint(:2); END;' USING OUT result, IN breakpoint#;"
        ));
        Assertions.assertTrue(body.contains(
            "EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.disable_breakpoint(:2); END;' USING OUT result, IN breakpoint#;"
        ));
        Assertions.assertFalse(body.contains("BEGIN dbms_debug.enable_breakpoint(:2); END;"));
        Assertions.assertFalse(body.contains("BEGIN dbms_debug.disable_breakpoint(:2); END;"));
    }

    @Test
    void packageBodyCarriesSetValueWithDynamicWrapperAndCapabilitySentinel() {
        String body = DbxPlDebugPackage.packageBody("SCOTT");
        Assertions.assertTrue(body.contains("PROCEDURE " + DbxPlDebugPackage.PROCEDURE_SET_VALUE));
        // The dbms_debug.set_value call must stay dynamic: a static reference to a
        // routine the server does not declare would invalidate the whole body. It
        // must also pass exactly the two real arguments.
        Assertions.assertTrue(body.contains("EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.set_value(:2, :3); END;'"));
        Assertions.assertFalse(body.contains("set_value(:2,:3,:4,:5)"));
        Assertions.assertTrue(body.contains("USING OUT result, IN frame#, IN assignment_statement;"));
        Assertions.assertTrue(body.contains("WHEN OTHERS THEN"));
        Assertions.assertTrue(body.contains("result := " + DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE + ";"));
        Assertions.assertTrue(body.contains("message := SQLERRM;"));
        Assertions.assertFalse(body.contains("dbms_debug.set_value(name"));
    }

    @Test
    void versionNoteIsV6AndSharesThePackageBodyHeaderLine() {
        String body = DbxPlDebugPackage.packageBody("SCOTT");
        // The Go driver emits this exact string (its test asserts the same literal):
        // both agents publish one helper package, and the note is the only thing that
        // forces an already-installed body to be rebuilt.
        Assertions.assertEquals(
            "-- DBX PL Debug Package Version: V6 (ODC V3.3.2.1 aligned, Oracle portable)",
            DbxPlDebugPackage.VERSION_NOTE
        );
        String headerLine = body.substring(0, body.indexOf('\n'));
        Assertions.assertTrue(
            headerLine.contains("CREATE OR REPLACE PACKAGE BODY")
                && headerLine.contains(DbxPlDebugPackage.PACKAGE_NAME + " AS"),
            "the version note must share the header line: deploy reads only the first ALL_SOURCE line"
        );
        Assertions.assertTrue(headerLine.contains(DbxPlDebugPackage.VERSION_NOTE));
        // The second marker is what forces a body installed before the V6.1/V6.2 fixes
        // to be replaced, without bumping the shared V6 identity the Go agent also
        // asserts. The Go driver writes this exact literal (plDebugBodyFixNote).
        Assertions.assertEquals(
            "-- DBX PL Debug Package Fix: V6.2 program_info.entrypointname arm for package subprograms"
                + " (V6.1 namespace-aware set_breakpoint + explicit run_info mask retained)",
            DbxPlDebugPackage.BODY_FIX_NOTE
        );
        Assertions.assertTrue(
            headerLine.contains(DbxPlDebugPackage.BODY_FIX_NOTE),
            "the fix note must share the header line: deploy reads only the first ALL_SOURCE line"
        );
        Assertions.assertFalse(
            DbxPlDebugPackage.VERSION_NOTE.contains("V6.1"),
            "the fix note must not be folded into the shared V6 literal"
        );
        Assertions.assertTrue(body.contains("-- V6.2 (real Oracle 19c EE verified): DBX_SET_BREAKPOINT_ENTRY added"));
        Assertions.assertTrue(body.contains("-- V6: DBX_SET_VALUE now matches the real DBMS_DEBUG.SET_VALUE overloads"));
        Assertions.assertTrue(body.contains("-- V5: DBX_SET_VALUE added"));
    }

    /**
     * The version note rebuilds the body only, so a head left at V5 would keep the
     * old four-argument DBX_SET_VALUE and the new body would fail to compile
     * (PLS-00306), leaving the whole package INVALID. The head check therefore pins
     * the declaration text, not only the routine name, and its Go twin
     * ({@code plDebugHeadRequirements}) carries the same entries.
     */
    @Test
    void headRequirementsPinTheChangedSignatures() {
        String head = DbxPlDebugPackage.packageHead("SCOTT");
        for (String requirement : DbxPlDebugPackage.HEAD_REQUIREMENTS) {
            Assertions.assertTrue(
                head.contains(requirement),
                "head requirement is not part of the head DDL: " + requirement
            );
        }
        for (String declaration : new String[] {
            DbxPlDebugPackage.PROCEDURE_SET_VALUE + "(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2",
            DbxPlDebugPackage.PROCEDURE_ENABLE_BREAKPOINT + "(breakpoint# IN BINARY_INTEGER",
            DbxPlDebugPackage.PROCEDURE_DISABLE_BREAKPOINT + "(breakpoint# IN BINARY_INTEGER",
        }) {
            Assertions.assertTrue(
                DbxPlDebugPackage.HEAD_REQUIRED_DECLARATIONS.contains(declaration),
                "signature is not pinned: " + declaration
            );
            Assertions.assertTrue(
                DbxPlDebugPackage.HEAD_REQUIREMENTS.contains(declaration),
                "signature is not enforced: " + declaration
            );
        }
        for (String routine : new String[] {
            DbxPlDebugPackage.PROCEDURE_SET_VALUE,
            DbxPlDebugPackage.PROCEDURE_ENABLE_BREAKPOINT,
            DbxPlDebugPackage.PROCEDURE_DISABLE_BREAKPOINT,
            DbxPlDebugPackage.PROCEDURE_SYNCHRONIZE,
            DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ANONYMOUS,
        }) {
            Assertions.assertTrue(
                DbxPlDebugPackage.HEAD_REQUIRED_ROUTINES.contains(routine),
                routine + " is missing from HEAD_REQUIRED_ROUTINES"
            );
        }
        String v5Head = "CREATE OR REPLACE PACKAGE \"SCOTT\".DBX_PL_DEBUG_PACKAGE AS"
            + " PROCEDURE DBX_SET_VALUE(name IN VARCHAR2, frame# IN BINARY_INTEGER,"
            + " index# IN BINARY_INTEGER, value IN VARCHAR2, result OUT BINARY_INTEGER);"
            + " END DBX_PL_DEBUG_PACKAGE;";
        for (String declaration : DbxPlDebugPackage.HEAD_REQUIRED_DECLARATIONS) {
            Assertions.assertFalse(
                v5Head.toUpperCase(java.util.Locale.ROOT).contains(declaration.toUpperCase(java.util.Locale.ROOT)),
                "a V5 head satisfies " + declaration
            );
        }
    }

    /**
     * DBMS_DEBUG.ABORT is documented as "NOT YET SUPPORTED", so aborting has to go
     * through continue(abort_execution): calling dbms_debug.abort() would raise
     * instead of stopping the debuggee. Every DBX_CNT_* wrapper also passes
     * info_requested explicitly: on Oracle 19c EE the default (NULL) run_info came
     * back with only reason/terminated filled, which left applyRunInfoMessage nothing
     * to publish.
     */
    @Test
    void abortUsesContinueWithAbortExecution() {
        String body = DbxPlDebugPackage.packageBody("SCOTT");
        Assertions.assertTrue(body.contains(
            "dbms_debug.continue(run_info, dbms_debug.abort_execution, " + RUN_INFO_MASK + ")"
        ));
        Assertions.assertFalse(body.contains("dbms_debug.abort("));
        for (String flag : new String[] {
            "dbms_debug.break_next_line",
            "dbms_debug.break_any_call",
            "dbms_debug.break_any_return",
            "dbms_debug.abort_execution",
        }) {
            Assertions.assertTrue(
                body.contains(flag + ", " + RUN_INFO_MASK + ")"),
                "the run_info mask is missing from the continue(next-line) call using " + flag
            );
            Assertions.assertFalse(
                body.contains(flag + ");"),
                "a DBX_CNT_* wrapper still relies on the default info_requested: " + flag
            );
        }
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
        Assertions.assertTrue(PlDebugSession.capabilityMissing(""));
        Assertions.assertTrue(PlDebugSession.capabilityMissing(null));
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
        String unavailable = PlDebugSession.breakpointEnabledMessage(7, true, DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE);
        Assertions.assertTrue(unavailable.contains("不支持"));
        Assertions.assertTrue(unavailable.contains("兜底"));
        String unknown = PlDebugSession.breakpointEnabledMessage(7, true, 13);
        Assertions.assertTrue(unknown.contains("error_no_such_breakpt"));
        Assertions.assertFalse(unknown.contains("不支持"));
        Assertions.assertTrue(PlDebugSession.breakpointEnabledMessage(7, true, 26).contains("result=26"));
    }

    @Test
    void programInfoExtraMarkerIsAlwaysConsumed() {
        String unsupported = DbxPlDebugPackage.packageBody("SCOTT");
        Assertions.assertFalse(unsupported.contains(DbxPlDebugPackage.PROGRAM_INFO_EXTRA_MARKER));
        Assertions.assertFalse(unsupported.contains("pro_info.signature"));
        Assertions.assertFalse(unsupported.contains("pro_info.sequence"));
        // The entrypointname assignment is opt-in for the same reason: a static
        // reference on a server whose PROGRAM_INFO lacks the attribute would leave the
        // whole PACKAGE BODY INVALID (PLS-00302).
        Assertions.assertFalse(unsupported.contains(DbxPlDebugPackage.PROGRAM_INFO_ENTRY_MARKER));
        Assertions.assertFalse(unsupported.contains("pro_info.entrypointname"));

        String supported = DbxPlDebugPackage.packageBody(
            "SCOTT",
            new DbxPlDebugPackage.ProgramInfoFields(true, true)
        );
        Assertions.assertFalse(supported.contains(DbxPlDebugPackage.PROGRAM_INFO_EXTRA_MARKER));
        Assertions.assertTrue(supported.contains("if signature is not null then pro_info.signature := signature; end if;"));
        Assertions.assertTrue(supported.contains("if sequence# >= 0 then pro_info.sequence := sequence#; end if;"));

        String signatureOnly = DbxPlDebugPackage.packageBody(
            "SCOTT",
            new DbxPlDebugPackage.ProgramInfoFields(true, false)
        );
        Assertions.assertTrue(signatureOnly.contains("pro_info.signature := signature"));
        Assertions.assertFalse(signatureOnly.contains("pro_info.sequence :="));
    }

    /**
     * A breakpoint on a subprogram INSIDE a package body is only armable through
     * {@code DBMS_DEBUG.PROGRAM_INFO.entrypointname}: measured on Oracle 19c EE,
     * name=&lt;subprogram&gt; answers error_bad_handle (16) in namespaces 1 and 2 and
     * error_exception (28) with a NULL namespace, while name=&lt;package&gt; +
     * namespace_pkg_body + entrypointname=&lt;subprogram&gt; answers success (0). The
     * head has to declare the wrapper (the body calls it), and the body fills the
     * attribute only on a server whose record type declares it.
     */
    @Test
    void packageHeadAndBodyCarryTheEntrypointArmForPackageSubprograms() {
        String head = DbxPlDebugPackage.packageHead("SCOTT");
        Assertions.assertTrue(
            head.contains(
                "PROCEDURE " + DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ENTRY
                    + "(owner IN VARCHAR2, name IN VARCHAR2, entrypointname IN VARCHAR2,"
                    + " line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
            ),
            "the package head must declare DBX_SET_BREAKPOINT_ENTRY"
        );
        Assertions.assertTrue(
            DbxPlDebugPackage.HEAD_REQUIRED_ROUTINES.contains(DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ENTRY),
            "DBX_SET_BREAKPOINT_ENTRY is missing from HEAD_REQUIRED_ROUTINES"
        );

        String supported = DbxPlDebugPackage.packageBody(
            "SCOTT",
            new DbxPlDebugPackage.ProgramInfoFields(false, false, true)
        );
        Assertions.assertTrue(
            supported.contains(
                "PROCEDURE " + DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ENTRY
                    + "(owner IN VARCHAR2, name IN VARCHAR2, entrypointname IN VARCHAR2,"
                    + " line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            ),
            "the entrypoint wrapper is missing from the package body"
        );
        Assertions.assertTrue(
            supported.contains("if entrypointname is not null then pro_info.entrypointname := entrypointname; end if;"),
            "the entrypointname assignment is missing for a server that declares the attribute"
        );
        Assertions.assertFalse(supported.contains(DbxPlDebugPackage.PROGRAM_INFO_ENTRY_MARKER));
        // The measured one-trip order for the entry arm: namespace_pkg_body first.
        Assertions.assertTrue(
            supported.contains("pro_info.namespace := dbms_debug.namespace_pkg_body; result := dbms_debug.set_breakpoint"),
            "the entrypoint arm must try namespace_pkg_body first"
        );
        // The entry arm must not have changed the standalone wrapper's order: the
        // standalone namespace chain (spec/top-level first, then the body) is still used
        // exactly twice (DBX_SET_BREAKPOINT and DBX_SET_BREAKPOINT_EX). The entry arm
        // starts with namespace_pkg_body, so this longer fragment is what tells them
        // apart.
        Assertions.assertEquals(2, countOf(supported, STANDALONE_NAMESPACE_CHAIN));
        Assertions.assertEquals(1, countOf(supported, ENTRY_NAMESPACE_CHAIN));
    }

    /**
     * The namespace-aware breakpoint is the difference between a by-name breakpoint
     * that works and error_bad_handle (16): SET_BREAKPOINT without a namespace always
     * answered 16 on 19c EE, while namespace_pkgspec_or_toplevel answered 0 for a
     * top-level procedure.
     */
    @Test
    void setBreakpointFallsBackToProgramNamespaces() {
        String body = DbxPlDebugPackage.packageBody("SCOTT");
        for (String namespace : new String[] {
            "pro_info.namespace := dbms_debug.namespace_pkgspec_or_toplevel",
            "pro_info.namespace := dbms_debug.namespace_pkg_body",
            "pro_info.namespace := dbms_debug.namespace_cursor",
            "pro_info.namespace := NULL",
        }) {
            Assertions.assertTrue(body.contains(namespace), "the fallback chain is missing " + namespace);
        }
        Assertions.assertEquals(
            2,
            countOf(body, STANDALONE_NAMESPACE_CHAIN),
            "the standalone namespace chain belongs to DBX_SET_BREAKPOINT and _EX"
        );
        Assertions.assertEquals(
            1,
            countOf(body, ENTRY_NAMESPACE_CHAIN),
            "the entrypoint arm owns the pkg_body-first chain"
        );
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

    private static int countOf(String text, String needle) {
        int count = 0;
        for (int index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length())) {
            count++;
        }
        return count;
    }

    @Test
    void parsesEveryBacktraceFrameInnermostFirst() {
        List<Map<String, Object>> frames = PlDebugSession.parseBacktraceFrames(
            "[Line 12] PKG_INNER.PROC\n"
                + "\n"
                + "some source text\n"
                + "[Line 30] PKG_MIDDLE.CALLER\n"
                + "  [Line 44] SCOTT.TOP_LEVEL\n"
                + "[Line 0] ANONYMOUS BLOCK\n"
        );
        Assertions.assertEquals(4, frames.size());
        Assertions.assertEquals(12, frames.get(0).get("line"));
        Assertions.assertEquals("PKG_INNER.PROC", frames.get(0).get("program"));
        Assertions.assertEquals(4, frames.get(0).get("stackDepth"));
        Assertions.assertEquals(30, frames.get(1).get("line"));
        Assertions.assertEquals(3, frames.get(1).get("stackDepth"));
        Assertions.assertEquals(44, frames.get(2).get("line"));
        Assertions.assertEquals("SCOTT.TOP_LEVEL", frames.get(2).get("program"));
        Assertions.assertEquals(2, frames.get(2).get("stackDepth"));
        Assertions.assertEquals(0, frames.get(3).get("line"));
        Assertions.assertEquals(1, frames.get(3).get("stackDepth"));
        Assertions.assertEquals("", frames.get(0).get("programOwner"));
    }

    @Test
    void ignoresBacktraceLinesWithoutAFrameEntry() {
        Assertions.assertTrue(PlDebugSession.parseBacktraceFrames(null).isEmpty());
        Assertions.assertTrue(PlDebugSession.parseBacktraceFrames("").isEmpty());
        Assertions.assertTrue(PlDebugSession.parseBacktraceFrames("no frame here\nLine without digits\n").isEmpty());
        List<Map<String, Object>> frames = PlDebugSession.parseBacktraceFrames("[Line] \n[Line 7] PROC");
        Assertions.assertEquals(1, frames.size());
        Assertions.assertEquals(7, frames.get(0).get("line"));
        Assertions.assertEquals("PROC", frames.get(0).get("program"));
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
     * The start sequence needs the call on a line of its own (line 2) so DBMS_DEBUG can
     * be handed a line number, and debugBefore locates the call line in exactly this
     * text. The Go driver renders the same shape
     * ({@code plDebugAnonymousBlock}); {@code ?} is the JDBC bind placeholder there.
     */
    @Test
    void rendersTheAnonymousBlockWithTheCallOnLineTwo() {
        String procedure = PlDebugSession.anonymousBlock("\"SCOTT\".\"PKG\".\"PROC\"", false, 2);
        Assertions.assertEquals("BEGIN\n  \"SCOTT\".\"PKG\".\"PROC\"(?, ?);\nEND;", procedure);
        Assertions.assertEquals(2, PlDebugSession.anonymousCallLine(procedure, "\"SCOTT\".\"PKG\".\"PROC\""));
        Assertions.assertEquals(2, PlDebugSession.anonymousCallLine(procedure, "PROC"));

        String function = PlDebugSession.anonymousBlock("\"SCOTT\".\"F_ADD\"", true, 1);
        Assertions.assertEquals("BEGIN\n  ? := \"SCOTT\".\"F_ADD\"(?);\nEND;", function);
        Assertions.assertEquals(2, PlDebugSession.anonymousCallLine(function, "F_ADD"));

        // No parameters: the block still puts the call on line 2.
        Assertions.assertEquals("BEGIN\n  \"SCOTT\".\"P\"();\nEND;", PlDebugSession.anonymousBlock("\"SCOTT\".\"P\"", false, 0));
        Assertions.assertEquals(2, PlDebugSession.anonymousCallLine(
            PlDebugSession.anonymousBlock("\"SCOTT\".\"P\"", false, 0),
            "P"
        ));
    }

    /**
     * The line algorithm of the Go driver's {@code plDebugAnonymousCallLine}: strip
     * {@code --} and block comments line by line (the in-block state survives across
     * lines), then accept a line whose trailing routine identifier is followed by
     * {@code (} -- or the line that ends with the routine name when the following
     * non-blank line opens the argument list.
     */
    @Test
    void findsTheAnonymousBlockCallLine() {
        // Banner comment: physical line numbers, not the comment-stripped ones.
        String banner = "/*\n * banner\n */\nBEGIN\n  SCOTT.PKG.PROC(?, ?);\nEND;";
        Assertions.assertEquals(5, PlDebugSession.anonymousCallLine(banner, "\"SCOTT\".\"PKG\".\"PROC\""));

        // A call only mentioned in a line comment is not a call.
        Assertions.assertEquals(0, PlDebugSession.anonymousCallLine(
            "BEGIN\n  -- PROC(1);\n  OTHER(1);\nEND;",
            "PROC"
        ));
        // Neither is a call inside a block comment, even when the comment spans lines.
        Assertions.assertEquals(0, PlDebugSession.anonymousCallLine(
            "BEGIN\n  /* PROC(1);\n     still commented */\n  OTHER(1);\nEND;",
            "PROC"
        ));
        // A comment closed mid-line still exposes the code after it.
        Assertions.assertEquals(2, PlDebugSession.anonymousCallLine(
            "BEGIN\n  /* PROC(1); */ PROC(2);\n  OTHER(1);\nEND;",
            "PROC"
        ));

        // Multi-line argument list: the call starts on the line that ends with the name.
        String multiLineArguments = "BEGIN\n  MY_PKG.DO_WORK\n  (?, ?);\nEND;";
        Assertions.assertEquals(2, PlDebugSession.anonymousCallLine(multiLineArguments, "MY_PKG.DO_WORK"));
        // Blank lines between the name and the argument list are skipped.
        Assertions.assertEquals(2, PlDebugSession.anonymousCallLine(
            "BEGIN\n  MY_PKG.DO_WORK\n\n  (?, ?);\nEND;",
            "DO_WORK"
        ));
        // ... but a following non-blank line that is not "(" is not the call.
        Assertions.assertEquals(0, PlDebugSession.anonymousCallLine(
            "BEGIN\n  MY_PKG.DO_WORK;\n  OTHER(1);\nEND;",
            "DO_WORK"
        ));

        // Many parameters, tabs, quoted identifiers and a nested call.
        Assertions.assertEquals(2, PlDebugSession.anonymousCallLine(
            "BEGIN\n\t\"SCOTT\".\"PKG\".\"PROC\"(?, ?, ?, ?);\nEND;",
            "PROC"
        ));
        Assertions.assertEquals(2, PlDebugSession.anonymousCallLine(
            "BEGIN\n  OUTER_PKG.OUTER(INNER_PKG.PROC(1));\nEND;",
            "PROC"
        ));
        // Suffix of a longer identifier is not a call ...
        Assertions.assertEquals(0, PlDebugSession.anonymousCallLine("BEGIN\n  PROC_X(1);\nEND;", "PROC"));
        // ... and a name that never appears is never a call.
        Assertions.assertEquals(0, PlDebugSession.anonymousCallLine("BEGIN\n  OTHER(1);\nEND;", "PROC"));
        Assertions.assertEquals(0, PlDebugSession.anonymousCallLine(null, "PROC"));
        Assertions.assertEquals(0, PlDebugSession.anonymousCallLine("BEGIN\n  PROC(1);\nEND;", "  "));
        Assertions.assertEquals(0, PlDebugSession.anonymousCallLine("BEGIN\n  PROC(1);\nEND;", null));
    }

    @Test
    void stripsLineAndBlockCommentsWithTheStateCarriedAcrossLines() {
        boolean[] state = new boolean[] {false};
        Assertions.assertEquals("  PROC(1); ", PlDebugSession.stripSqlComments("  PROC(1); -- tail", state));
        Assertions.assertFalse(state[0]);
        Assertions.assertEquals("  ", PlDebugSession.stripSqlComments("  /* opened", state));
        Assertions.assertTrue(state[0]);
        Assertions.assertEquals("", PlDebugSession.stripSqlComments("   still inside", state));
        Assertions.assertEquals("PROC(2);", PlDebugSession.stripSqlComments("   closed */PROC(2);", state));
        Assertions.assertFalse(state[0]);
        Assertions.assertEquals("", PlDebugSession.stripSqlComments(null, state));
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
     * The start breakpoint is armed through DBX_SET_BREAKPOINT_ANONYMOUS and tolerates
     * error_exception (28) and error_no_such_breakpt (13) -- the codes ODC swallows
     * because the same line can be armed twice or already dropped.
     */
    @Test
    void toleratesExceptionAndNoSuchBreakpointFromTheStartBreakpoint() {
        Assertions.assertTrue(PlDebugSession.toleratedStartBreakpointResult(28));
        Assertions.assertTrue(PlDebugSession.toleratedStartBreakpointResult(13));
        Assertions.assertFalse(PlDebugSession.toleratedStartBreakpointResult(0));
        Assertions.assertFalse(PlDebugSession.toleratedStartBreakpointResult(12));
        Assertions.assertFalse(PlDebugSession.toleratedStartBreakpointResult(27));
        Assertions.assertFalse(PlDebugSession.toleratedStartBreakpointResult(DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE));

        String head = DbxPlDebugPackage.packageHead("SCOTT");
        String body = DbxPlDebugPackage.packageBody("SCOTT");
        Assertions.assertTrue(head.contains("PROCEDURE " + DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ANONYMOUS));
        Assertions.assertTrue(body.contains("PROCEDURE " + DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ANONYMOUS));
    }

    /**
     * The head requirement list is the Java twin of the Go driver's
     * {@code plDebugHeadRequirements}: the routines the start sequence calls plus the
     * signatures that must not drift, in the same order. A head missing any of them is
     * replaced before the new body is installed.
     */
    @Test
    void headRequirementsCoverTheStartSequenceRoutines() {
        Assertions.assertEquals(
            List.of(
                DbxPlDebugPackage.PROCEDURE_SET_VALUE,
                DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_EX,
                DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ENTRY,
                DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ANONYMOUS,
                DbxPlDebugPackage.PROCEDURE_SYNCHRONIZE,
                DbxPlDebugPackage.PROCEDURE_ENABLE_BREAKPOINT,
                DbxPlDebugPackage.PROCEDURE_DISABLE_BREAKPOINT
            ),
            DbxPlDebugPackage.HEAD_REQUIRED_ROUTINES
        );
        Assertions.assertEquals(
            DbxPlDebugPackage.HEAD_REQUIRED_ROUTINES.size() + DbxPlDebugPackage.HEAD_REQUIRED_DECLARATIONS.size(),
            DbxPlDebugPackage.HEAD_REQUIREMENTS.size()
        );
        Assertions.assertTrue(DbxPlDebugPackage.HEAD_REQUIREMENTS.containsAll(DbxPlDebugPackage.HEAD_REQUIRED_ROUTINES));
        Assertions.assertTrue(DbxPlDebugPackage.HEAD_REQUIREMENTS.containsAll(DbxPlDebugPackage.HEAD_REQUIRED_DECLARATIONS));
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
     * start returns the session's filled snapshot (the state debugBefore published), not
     * the zero state: program/programOwner/stackDepth come out of the start frame. The
     * backtrace that would fill the line needs a server, so only those three are
     * asserted here.
     */
    @Test
    void startSnapshotReportsTheFrameTheStartSequenceParkedIn() {
        PlDebugSession session = PlDebugSession.withoutConnections("dbg-1", "SCOTT");
        Assertions.assertNull(session.startSnapshot().get("program"), "the zero state has no program");
        Assertions.assertNull(session.startSnapshot().get("stackDepth"), "the zero state has no stack depth");

        session.publishStartFrame("MY_PKG.DO_WORK");
        Map<String, Object> snapshot = session.startSnapshot();
        Assertions.assertEquals("dbg-1", snapshot.get("debugId"));
        Assertions.assertEquals("SCOTT", snapshot.get("owner"));
        Assertions.assertEquals("MY_PKG.DO_WORK", snapshot.get("program"));
        Assertions.assertEquals("SCOTT", snapshot.get("programOwner"));
        Assertions.assertEquals(1, snapshot.get("stackDepth"));
        Assertions.assertEquals(false, snapshot.get("terminated"));
    }
}
