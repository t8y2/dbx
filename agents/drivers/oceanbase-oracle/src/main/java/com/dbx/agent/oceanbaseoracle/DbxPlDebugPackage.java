package com.dbx.agent.oceanbaseoracle;

import java.util.ArrayList;
import java.util.List;

/**
 * DDL for the per-schema helper package the debugger creates before the first
 * session, plus the routine names it calls afterwards.
 *
 * <p>The package is a thin wrapper over the server-side {@code DBMS_DEBUG}
 * primitives: the client driver cannot call procedures with OUT parameters
 * through plain statements, so every primitive that returns values is wrapped
 * here. The definitions are adapted from OceanBase Developer Center
 * (https://github.com/oceanbase/odc, Apache-2.0) with an independent package
 * name ({@code DBX_PL_DEBUG_PACKAGE}) so DBX and ODC can coexist on the same
 * schema without overwriting each other's helper objects.
 *
 * <p>Routine naming follows the same {@code DBX_} prefix for the same reason.
 */
final class DbxPlDebugPackage {
    static final String PACKAGE_NAME = "DBX_PL_DEBUG_PACKAGE";
    /**
     * Marker written on the package body's first line. The deploy step reads only
     * the first {@code ALL_SOURCE} line of the body, so the note must share the
     * line with the {@code CREATE OR REPLACE PACKAGE BODY ... AS} header.
     */
    static final String VERSION_NOTE =
        "-- DBX PL Debug Package Version: V6 (ODC V3.3.2.1 aligned, Oracle portable)";

    /**
     * Second marker {@code packageVersionCurrent} requires, on the same header line as
     * {@link #VERSION_NOTE}. It is deliberately NOT a bump of the shared V6 identity
     * literal: the Go agent installs the same package and both sides recognise the
     * other's body by that exact V6 literal (ODC's
     * {@code PackageValidator.isVersionValid} mechanism), so bumping it would make the
     * two agents rebuild each other's package on every start. A second marker keeps the
     * shared V6 identity intact while still forcing a rebuild of any body that predates
     * the fixes below, which real Oracle 19c EE runs proved necessary. The Go agent
     * writes this exact literal ({@code plDebugBodyFixNote}) onto the same header line,
     * so a body either agent installs satisfies both.
     *
     * <p>1. {@code DBX_SET_BREAKPOINT} / {@code DBX_SET_BREAKPOINT_EX} must fill
     * {@code dbms_debug.program_info.namespace}. With the namespace left NULL every named
     * breakpoint answered {@code error_bad_handle} (16) on Oracle 19c EE, so
     * {@code pl_debug_set_breakpoints} and {@code pl_debug_resume} could never stop
     * anywhere.
     *
     * <p>2. Every {@code DBX_CNT_*} wrapper must pass {@code info_requested} explicitly.
     * On 19c EE the default (NULL) {@code run_info} came back with only
     * {@code reason}/{@code terminated} filled.
     *
     * <p>3. {@code DBX_SET_BREAKPOINT_ENTRY} must fill
     * {@code dbms_debug.program_info.entrypointname}. A breakpoint on a subprogram
     * INSIDE a package body is only armable as {@code name=<package>} +
     * {@code namespace_pkg_body} + {@code entrypointname=<subprogram>} (success); every
     * shape that passes the subprogram as {@code program_info.name} answers
     * {@code error_bad_handle} (16) or {@code error_exception} (28), which is why
     * {@code pl_debug_set_breakpoints} used to answer {@code []} there.
     *
     * <p>All changes are inert on engines whose {@code set_breakpoint} ignores
     * {@code namespace} / {@code entrypointname} (OceanBase Oracle mode resolves the name
     * only) and whose {@code get_runtime_info} ignores the request mask.
     */
    static final String BODY_FIX_NOTE =
        "-- DBX PL Debug Package Fix: V6.3 DBX_FETCH_OUTPUT one-call DBMS_OUTPUT drain"
            + " (V6.2 program_info.entrypointname arm for package subprograms, V6.1"
            + " namespace-aware set_breakpoint + explicit run_info mask retained)";

    /** Version history, written after the header line so it never hides the marker. */
    private static final String VERSION_NOTE_DETAIL =
        "\n-- V6.3 (real Oracle 19c EE verified): DBX_FETCH_OUTPUT added, the one-call"
            + "\n-- DBMS_OUTPUT drain the Go agent calls from the target's own anonymous block."
            + "\n-- DBX_PL_DEBUG_PACKAGE_PENDING_LINE holds the line a chunk boundary could not"
            + "\n-- return yet. See BODY_FIX_NOTE."
            + "\n-- V6.2 (real Oracle 19c EE verified): DBX_SET_BREAKPOINT_ENTRY added. It fills"
            + "\n-- dbms_debug.program_info.entrypointname (and tries namespace_pkg_body first),"
            + "\n-- which is the only arm a breakpoint on a subprogram INSIDE a package body"
            + "\n-- accepts: measured on 19c EE, name=<package> + namespace_pkg_body +"
            + "\n-- entrypointname=<subprogram> answers success (0), while every shape that"
            + "\n-- passes the subprogram as program_info.name answers error_bad_handle (16) or"
            + "\n-- error_exception (28) -- so pl_debug_set_breakpoints answered [] and the"
            + "\n-- session ran to completion. See BODY_FIX_NOTE."
            + "\n-- V6.1 (real Oracle 19c EE verified): DBX_SET_BREAKPOINT and"
            + "\n-- DBX_SET_BREAKPOINT_EX now fill dbms_debug.program_info.namespace, and every"
            + "\n-- DBX_CNT_* wrapper passes info_requested explicitly. Measured on 19c EE:"
            + "\n-- namespace = namespace_pkgspec_or_toplevel (1) answered success for a top-level"
            + "\n-- procedure while 0/2/3/4/NULL answered 16, and the default (NULL) run_info came"
            + "\n-- back with only reason/terminated filled. See BODY_FIX_NOTE."
            + "\n-- V6: DBX_SET_VALUE now matches the real DBMS_DEBUG.SET_VALUE overloads, which"
            + "\n-- take (frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2) and RETURN"
            + "\n-- BINARY_INTEGER (Oracle 21c XE verified through ALL_PROCEDURES/ALL_ARGUMENTS)."
            + "\n-- The old wrapper called set_value(name, frame#, index#, value), which matched no"
            + "\n-- overload, always raised inside the dynamic block and reported the -1 sentinel,"
            + "\n-- i.e. \"this server cannot change variable values\" on servers that support it."
            + "\n-- The wrapper now takes the frame number plus the PL/SQL assignment text the"
            + "\n-- caller builds (\"x := 5\", \"s := ''abc''\", \"x(1) := 5\"), forwards the text"
            + "\n-- verbatim, and reports WHY a dynamic call failed so \"routine not declared\" stays"
            + "\n-- distinguishable from a malformed assignment. DBX_ENABLE_BREAKPOINT and"
            + "\n-- DBX_DISABLE_BREAKPOINT were added for breakpoint enable/disable:"
            + "\n-- DBMS_DEBUG.ENABLE_BREAKPOINT / DISABLE_BREAKPOINT are functions taking"
            + "\n-- (breakpoint IN BINARY_INTEGER) and returning success / error_no_such_breakpt /"
            + "\n-- error_idle_breakpt. DBX_SET_VALUE changed signature (not just its body), so the"
            + "\n-- head has to be rebuilt as well: the head check pins declaration text, not only"
            + "\n-- the routine name."
            + "\n-- V5: DBX_SET_VALUE added (dynamic dbms_debug.set_value, -1 sentinel when the"
            + "\n-- routine is absent) and DBX_SET_BREAKPOINT_EX added, which fills the optional"
            + "\n-- dbms_debug.program_info signature/sequence attributes when the server's record"
            + "\n-- type declares them. DBX_SET_VALUE is declared in the package head so the body"
            + "\n-- compiles; the head is rebuilt whenever an older install lacks it."
            + "\n-- V4: DBX_GET_VALUES resolves dbms_debug.get_values dynamically. Stock Oracle"
            + "\n-- (21c XE verified) declares GET_VALUE but NOT GET_VALUES, so the previous"
            + "\n-- static reference compiled this entire PACKAGE BODY to INVALID"
            + "\n-- (PLS-00302 / ORA-00904) and took breakpoints, stepping and backtraces"
            + "\n-- down with it. A missing primitive now yields the -1 sentinel instead."
            + "\n-- V3: package bodies realigned verbatim with ODC (OracleCreateDebugPLConstants,"
            + "\n-- ODC V3.3.2.1): resume restored to break_any_return, run_info message keys"
            + "\n-- renamed to run_info.* without the line#, CNT_EXIT added and declared."
            + "\n-- V2: resume (DBX_CNT_NEXT_BREAKPOINT) passed breakflags 0.";

    /**
     * Sentinel {@code result} a wrapper returns when the server-side primitive it
     * delegates to is not declared at all (as opposed to failing at runtime), so
     * the caller can report "capability unavailable" instead of a broken session.
     */
    static final int RESULT_CAPABILITY_UNAVAILABLE = -1;

    static final String PROCEDURE_SET_BREAKPOINT = "DBX_SET_BREAKPOINT";
    /**
     * {@link #PROCEDURE_SET_BREAKPOINT} plus the overload disambiguation attributes
     * of {@code DBMS_DEBUG.PROGRAM_INFO} ({@code signature}/{@code sequence}). The
     * plain wrapper keeps its original signature because the Go agent shares this
     * package.
     */
    static final String PROCEDURE_SET_BREAKPOINT_EX = "DBX_SET_BREAKPOINT_EX";
    /**
     * The <em>package-subprogram</em> arm: it fills
     * {@code DBMS_DEBUG.PROGRAM_INFO.entrypointname}, which is the only shape a
     * breakpoint on a subprogram INSIDE a package body accepts on Oracle 19c EE.
     * Measured there against one package subprogram, with the subprogram's own name
     * in {@code name} (the shape the desktop client sends as {@code "PKG.SUB"}):
     * {@code name=<subprogram>} with {@code namespace_pkgspec_or_toplevel} (1) or
     * {@code namespace_pkg_body} (2) answered {@code error_bad_handle} (16),
     * {@code name=<subprogram>} or {@code "PKG.SUB"} with a NULL namespace answered
     * {@code error_exception} (28), {@code name=<package>} +
     * {@code namespace_pkgspec_or_toplevel} + {@code entrypointname=<subprogram>}
     * answered 12, and {@code name=<package>} + {@code namespace_pkg_body} +
     * {@code entrypointname=<subprogram>} answered success (0).
     *
     * <p>It is a separate routine -- not a new parameter on
     * {@link #PROCEDURE_SET_BREAKPOINT} / {@link #PROCEDURE_SET_BREAKPOINT_EX} --
     * because the Go agent shares this package and keeps calling those two with their
     * existing signatures.
     */
    static final String PROCEDURE_SET_BREAKPOINT_ENTRY = "DBX_SET_BREAKPOINT_ENTRY";
    /**
     * Mutates a variable of a parked debuggee. {@code DBMS_DEBUG.SET_VALUE} only
     * exists on some servers (it is an OceanBase Oracle-mode extension; stock
     * Oracle declares {@code SET_VALUE} for other packages only), so the wrapper
     * resolves it dynamically and reports the -1 sentinel. Its second argument is
     * the *text* of a PL/SQL assignment, not a value: see {@link #SET_VALUE}.
     */
    static final String PROCEDURE_SET_VALUE = "DBX_SET_VALUE";
    /**
     * Enables ({@link #PROCEDURE_DISABLE_BREAKPOINT} being the reverse) an existing
     * breakpoint through the {@code DBMS_DEBUG.ENABLE_BREAKPOINT} /
     * {@code DISABLE_BREAKPOINT} functions. Both are resolved dynamically: a server
     * without them answers with the -1 sentinel and the client keeps its own
     * delete-and-re-set fallback.
     */
    static final String PROCEDURE_ENABLE_BREAKPOINT = "DBX_ENABLE_BREAKPOINT";
    static final String PROCEDURE_DISABLE_BREAKPOINT = "DBX_DISABLE_BREAKPOINT";
    /**
     * Placeholder {@link #packageBody(String, ProgramInfoFields)} replaces with the
     * {@code DBMS_DEBUG.PROGRAM_INFO} assignment lines this server actually
     * supports. It is a block comment so the raw template still compiles (and stays
     * inert) when the caller never runs the replacement.
     */
    static final String PROGRAM_INFO_EXTRA_MARKER = "/*DBX_PROGRAM_INFO_EXTRA*/";
    /**
     * Placeholder {@link #packageBody(String, ProgramInfoFields)} replaces with the
     * {@code entrypointname} assignment of {@link #PROCEDURE_SET_BREAKPOINT_ENTRY}. It
     * is a separate marker from {@link #PROGRAM_INFO_EXTRA_MARKER} because it is filled
     * from a third capability probe: a server whose {@code DBMS_DEBUG.PROGRAM_INFO}
     * record has no {@code entrypointname} attribute must not carry the assignment (a
     * static reference would compile the whole PACKAGE BODY to INVALID with
     * PLS-00302). Oracle 19c EE declares it -- measured against
     * {@code ALL_PLSQL_TYPE_ATTRS}: NAMESPACE/NAME/OWNER/DBLINK/LINE#/LIBUNITTYPE/
     * ENTRYPOINTNAME -- which is why the entry arm is what makes a package subprogram
     * breakpoint work there.
     */
    static final String PROGRAM_INFO_ENTRY_MARKER = "/*DBX_PROGRAM_INFO_ENTRYPOINT*/";
    static final String PROCEDURE_SET_BREAKPOINT_ANONYMOUS = "DBX_SET_BREAKPOINT_ANONYMOUS";
    static final String PROCEDURE_SHOW_BREAKPOINTS = "DBX_SHOW_BREAKPOINTS";
    static final String PROCEDURE_PRINT_BACKTRACE = "DBX_PRINT_BACKTRACE";
    static final String PROCEDURE_CNT_NEXT_LINE = "DBX_CNT_NEXT_LINE";
    static final String PROCEDURE_CNT_NEXT_BREAKPOINT = "DBX_CNT_NEXT_BREAKPOINT";
    static final String PROCEDURE_CNT_STEP_IN = "DBX_CNT_STEP_IN";
    static final String PROCEDURE_CNT_ABORT = "DBX_CNT_ABORT";
    static final String PROCEDURE_CNT_STEP_OUT = "DBX_CNT_STEP_OUT";
    /**
     * Exit-the-program wrapper. ODC ships the same routine in its body but omits
     * the head declaration (an ODC defect); DBX declares it so the body compiles.
     */
    static final String PROCEDURE_CNT_EXIT = "DBX_CNT_EXIT";
    static final String PROCEDURE_GET_VALUES = "DBX_GET_VALUES";
    static final String PROCEDURE_GET_VALUE = "DBX_GET_VALUE";
    static final String PROCEDURE_GET_RUNTIME_INFO = "DBX_GET_RUNTIME_INFO";
    static final String PROCEDURE_SYNCHRONIZE = "DBX_SYNCHRONIZE";
    static final String PROCEDURE_GET_LINE = "DBX_GET_LINE";

    /**
     * V6.3: the one-call DBMS_OUTPUT drain. It is a {@code FUNCTION} on purpose, so the
     * debuggee's own anonymous block can invoke it as its trailing statement -- the only
     * moment after {@code DEBUG_ON} when such a call does not park for the whole
     * {@code DBMS_DEBUG.SET_TIMEOUT}. This agent never calls it; it renders the body so
     * both agents install the same package.
     */
    static final String FUNCTION_FETCH_OUTPUT = "DBX_FETCH_OUTPUT";

    /**
     * Package-level variable holding the one line a {@link #FUNCTION_FETCH_OUTPUT} chunk
     * boundary could not return yet. The identifier is shared with the Go agent's copy of
     * the routine, so both sides must render the same name.
     */
    static final String PENDING_LINE_VARIABLE = PACKAGE_NAME + "_PENDING_LINE";

    /**
     * Body declaration of {@link #PENDING_LINE_VARIABLE}, substituted for
     * {@link #PENDING_LINE_DECLARATION_MARKER}. Rendered from the Go agent's own text
     * ({@code agents/drivers/oracle-go/pldebug.go:508}).
     */
    static final String PENDING_LINE_DECLARATION = PENDING_LINE_VARIABLE + " VARCHAR2(32767) := NULL;\n";

    /**
     * The V6.3 routine, byte-for-byte the Go agent's rendering
     * ({@code agents/drivers/oracle-go/pldebug.go:550-591}).
     */
    static final String FETCH_OUTPUT_ROUTINE =
        "\n-- V6.3 (real Oracle 19c EE verified): DBX_FETCH_OUTPUT added. After DEBUG_ON every"
            + "\n-- PL/SQL call in the debuggee session parks for the whole DBMS_DEBUG.SET_TIMEOUT"
            + "\n-- (measured: SET_TIMEOUT(5) -> the first post-DEBUG_ON statement answered after"
            + "\n-- 5070ms; SET_TIMEOUT(1) -> 1066ms; a plain SQL SELECT stayed at 25ms), so a"
            + "\n-- DBMS_OUTPUT drain split over several calls can never finish inside one RPC."
            + "\n-- DBX_GET_LINE is kept unchanged for the Java agent; DBX_FETCH_OUTPUT is the"
            + "\n-- chunked, single-call drain the Go agent uses, and it is a FUNCTION so the"
            + "\n-- debuggee's own anonymous block can call it as its trailing statement -- while the"
            + "\n-- debugger still drives the program, which is the only moment such a call does not"
            + "\n-- park."
            + "\nFUNCTION " + FUNCTION_FETCH_OUTPUT + "(max_chars IN BINARY_INTEGER) RETURN VARCHAR2 IS"
            + "\n  buffer VARCHAR2(32767) := NULL;"
            + "\n  fetched VARCHAR2(32767);"
            + "\n  status INTEGER;"
            + "\n  limit_chars PLS_INTEGER;"
            + "\n  ignored BINARY_INTEGER;"
            + "\nBEGIN"
            + "\n  limit_chars := max_chars;"
            + "\n  IF limit_chars IS NULL OR limit_chars <= 0 OR limit_chars > 32767 THEN limit_chars := 32767; END IF;"
            + "\n  -- Best effort, and deliberately an assignment: DBMS_DEBUG.SET_TIMEOUT is a"
            + "\n  -- FUNCTION on 19c EE (\"CALL DBMS_DEBUG.SET_TIMEOUT(120)\" answers PLS-00221), and"
            + "\n  -- this call is what turns the debuggee's own post-program park from the whole"
            + "\n  -- SET_TIMEOUT into one second for every later drain call. A server without the"
            + "\n  -- primitive keeps the long park and the Go-side bound, which is why the failure"
            + "\n  -- is swallowed."
            + "\n  BEGIN ignored := dbms_debug.set_timeout(1); EXCEPTION WHEN OTHERS THEN NULL; END;"
            + "\n  <<dbx_drain>> LOOP"
            + "\n    IF " + PENDING_LINE_VARIABLE + " IS NOT NULL THEN"
            + "\n      fetched := " + PENDING_LINE_VARIABLE + ";"
            + "\n      " + PENDING_LINE_VARIABLE + " := NULL;"
            + "\n    ELSE"
            + "\n      dbms_output.get_line(fetched, status);"
            + "\n      IF status <> 0 THEN EXIT dbx_drain; END IF;"
            + "\n    END IF;"
            + "\n    IF buffer IS NOT NULL AND LENGTH(buffer) + 1 + LENGTH(fetched) > limit_chars THEN"
            + "\n      " + PENDING_LINE_VARIABLE + " := fetched;"
            + "\n      EXIT dbx_drain;"
            + "\n    END IF;"
            + "\n    IF buffer IS NULL THEN buffer := fetched; ELSE buffer := buffer || chr(10) || fetched; END IF;"
            + "\n  END LOOP dbx_drain;"
            + "\n  RETURN buffer;"
            + "\nEND;";

    /** Marker the body template replaces with {@link #PENDING_LINE_DECLARATION}. */
    private static final String PENDING_LINE_DECLARATION_MARKER = "--{{DBX_PENDING_LINE}}";

    /** Marker the body template replaces with {@link #FETCH_OUTPUT_ROUTINE}. */
    private static final String FETCH_OUTPUT_MARKER = "--{{DBX_FETCH_OUTPUT}}";

    /**
     * The diagnostic line the {@code DBX_CNT_*} wrappers build from
     * {@code DBMS_DEBUG}'s run_info record. The shape is byte-for-byte ODC's
     * (OracleCreateDebugPLConstants): the leading space and the
     * {@code run_info.} key prefixes are significant, and there is deliberately no
     * line field -- the current line comes from the backtrace listing instead.
     */
    private static final String RUN_INFO_MESSAGE =
        "message := ' run_info.breakpoint = ' || run_info.breakpoint"
            + " || ', run_info.stackdepth = ' || run_info.stackdepth"
            + " || ', run_info.reason = ' || run_info.reason"
            + " || ', run_info.programname = ' || run_info.program.name"
            + " || ', run_info.programowner = ' || run_info.program.owner;";

    /**
     * The {@code info_requested} bit-field every {@code DBX_CNT_*} wrapper passes to
     * {@code DBMS_DEBUG.CONTINUE} instead of relying on the default.
     * {@code info_getStackDepth} (2) is what fills {@code run_info.stackdepth} and
     * {@code info_getLineinfo} (8) is what fills {@code run_info.program.name/owner}
     * plus {@code run_info.line#}. Measured on Oracle 19c EE: the default (NULL) filled
     * neither, {@code info_getLineinfo} alone filled the program but not the depth, and
     * 10 filled both.
     */
    private static final String RUN_INFO_MASK = "dbms_debug.info_getStackDepth + dbms_debug.info_getLineinfo";

    /**
     * The namespace chain the two named-breakpoint wrappers execute: it sets the
     * breakpoint on {@code pro_info} and walks the namespaces a program unit handle may
     * live in. {@code DBMS_DEBUG.PROGRAM_INFO} exists to carry a namespace precisely so
     * the server can tell a package spec from a package body, and on Oracle 19c EE a
     * handle left with the namespace NULL answers {@code error_bad_handle} (16).
     * Measured against a top-level procedure on 19c EE:
     * {@code namespace_pkgspec_or_toplevel} (1) -> success (0), while
     * {@code namespace_pkg_body} (2) / {@code namespace_cursor} (0) /
     * {@code namespace_trigger} (3) / NULL -> 16. The first attempt is therefore the
     * top-level/spec namespace; the remaining three are a fallback chain so a
     * package-body subprogram still resolves. The order is observable and cheap: a
     * namespace that does not contain the unit answers 16 without creating anything, and
     * the loop stops at the first success. Engines whose {@code set_breakpoint} resolves
     * the name only (OceanBase Oracle mode) succeed on the first attempt and behave
     * exactly as before.
     */
    private static final String NAMESPACE_FALLBACK =
        " pro_info.namespace := dbms_debug.namespace_pkgspec_or_toplevel;"
            + " result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#);"
            + " IF result <> 0 THEN pro_info.namespace := dbms_debug.namespace_pkg_body;"
            + " result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF;"
            + " IF result <> 0 THEN pro_info.namespace := dbms_debug.namespace_cursor;"
            + " result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF;"
            + " IF result <> 0 THEN pro_info.namespace := NULL;"
            + " result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF;";

    /**
     * The namespace chain {@link #PROCEDURE_SET_BREAKPOINT_ENTRY} executes. It is
     * deliberately NOT {@link #NAMESPACE_FALLBACK}: the entry arm is only ever used for
     * a subprogram that lives inside a package body, and for that target the measured
     * order is the reverse. With {@code name = <package>} and
     * {@code entrypointname = <subprogram>} on Oracle 19c EE,
     * {@code namespace_pkg_body} (2) answered success (0) while
     * {@code namespace_pkgspec_or_toplevel} (1) answered 12
     * ({@code error_illegal_handle}). Starting with the body namespace is therefore the
     * one-trip arm; the remaining namespaces keep the fallback property the standalone
     * wrapper relies on.
     */
    private static final String ENTRY_FALLBACK =
        " pro_info.namespace := dbms_debug.namespace_pkg_body;"
            + " result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#);"
            + " IF result <> 0 THEN pro_info.namespace := dbms_debug.namespace_pkgspec_or_toplevel;"
            + " result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF;"
            + " IF result <> 0 THEN pro_info.namespace := dbms_debug.namespace_cursor;"
            + " result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF;"
            + " IF result <> 0 THEN pro_info.namespace := NULL;"
            + " result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF;";

    private static final String SET_BREAKPOINT =
        "PROCEDURE " + PROCEDURE_SET_BREAKPOINT
            + "(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " pro_info dbms_debug.program_info;"
            + " BEGIN"
            + " pro_info.name := name;"
            + " pro_info.owner := owner;"
            + NAMESPACE_FALLBACK
            + " END;";

    private static final String SET_BREAKPOINT_ANONYMOUS =
        "PROCEDURE " + PROCEDURE_SET_BREAKPOINT_ANONYMOUS
            + "(line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " run_info dbms_debug.runtime_info;"
            + " BEGIN"
            + " result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info);"
            + " result := dbms_debug.set_breakpoint(run_info.program, line#, breakpoint#);"
            + "END;";

    /**
     * Breakpoint on an overloaded target, disambiguated with the optional
     * {@code DBMS_DEBUG.PROGRAM_INFO} attributes. The attribute assignments come
     * from {@link #PROGRAM_INFO_EXTRA_MARKER}, which {@code packageBody} fills with
     * only the fields the server declares.
     */
    private static final String SET_BREAKPOINT_EX =
        "PROCEDURE " + PROCEDURE_SET_BREAKPOINT_EX
            + "(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, signature IN VARCHAR2,"
            + " sequence# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " pro_info dbms_debug.program_info;"
            + " BEGIN"
            + " pro_info.name := name;"
            + " pro_info.owner := owner;"
            + " " + PROGRAM_INFO_EXTRA_MARKER
            + NAMESPACE_FALLBACK
            + " END;";

    /**
     * Package-subprogram breakpoint, located by {@code entrypointname} instead of by
     * {@code name}. The routine is separate from {@link #PROCEDURE_SET_BREAKPOINT} /
     * {@link #PROCEDURE_SET_BREAKPOINT_EX} so their signatures stay shared with the Go
     * agent. The {@code entrypointname} assignment comes from
     * {@link #PROGRAM_INFO_ENTRY_MARKER}, which {@code packageBody} fills only on a
     * server whose {@code DBMS_DEBUG.PROGRAM_INFO} record declares the attribute: a
     * static reference on a server without it would leave the whole PACKAGE BODY
     * INVALID (PLS-00302).
     */
    private static final String SET_BREAKPOINT_ENTRY =
        "PROCEDURE " + PROCEDURE_SET_BREAKPOINT_ENTRY
            + "(owner IN VARCHAR2, name IN VARCHAR2, entrypointname IN VARCHAR2,"
            + " line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " pro_info dbms_debug.program_info;"
            + " BEGIN"
            + " pro_info.name := name;"
            + " pro_info.owner := owner;"
            + " " + PROGRAM_INFO_ENTRY_MARKER
            + ENTRY_FALLBACK
            + " END;";

    /**
     * Variable mutation. The {@code dbms_debug.set_value} call is deliberately
     * dynamic for the same reason as {@code get_values}: a static reference to a
     * routine the server does not declare would leave the whole package body
     * INVALID, while {@code EXECUTE IMMEDIATE} only fails when it is called.
     *
     * <p>The forwarded arguments are the real ones: {@code SET_VALUE} has exactly
     * two overloads -- {@code (frame# IN BINARY_INTEGER, assignment_statement IN
     * VARCHAR2)} and {@code (handle IN program_info, assignment_statement IN
     * VARCHAR2)}, both {@code RETURN BINARY_INTEGER} (Oracle 21c XE verified through
     * {@code ALL_PROCEDURES}/{@code ALL_ARGUMENTS}) -- and the second argument is
     * the text of a PL/SQL assignment ({@code x := 5}, {@code s := ''abc''},
     * {@code x(1) := 5}), not a value. The previous four-argument call matched no
     * overload at all, so it always raised inside the dynamic block, hit
     * {@code WHEN OTHERS} and reported "this server cannot change variable values"
     * on servers that do support {@code SET_VALUE}.
     *
     * <p>The {@code message} register carries {@code SQLERRM} on failure, which is
     * what lets the caller keep "routine not declared" (PLS-00201 / PLS-00302 /
     * ORA-00904) apart from a rejected assignment.
     *
     * <p>Open question for the next real-machine run: Oracle's reference examples
     * pass the text with its terminator ({@code 'x := 3;'}, {@code 'var := 6;'}),
     * while the session builds it without one ({@code "x := 5"}), because Probe may
     * append the terminator itself. Neither form is verified against a real server
     * yet, so the session tries both: the unterminated text first, then -- only when
     * this wrapper's {@code message} register answers with a syntax error
     * (PLS-00103 / ORA-06550) -- exactly one retry of the same text plus a trailing
     * ";". A missing primitive (PLS-00201 / PLS-00302 / ORA-00904) is never retried,
     * and the {@code assignmentSemicolon} response field reports which form won.
     */
    private static final String SET_VALUE =
        "PROCEDURE " + PROCEDURE_SET_VALUE
            + "(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2,"
            + " result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + " BEGIN"
            + "  result := 0;"
            + "  message := '';"
            + "  BEGIN"
            + "   EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.set_value(:2, :3); END;'"
            + " USING OUT result, IN frame#, IN assignment_statement;"
            + "  EXCEPTION"
            + "   WHEN OTHERS THEN"
            + "    result := " + RESULT_CAPABILITY_UNAVAILABLE + ";"
            + "    message := SQLERRM;"
            + "  END;"
            + "END;";

    /**
     * Breakpoint enable/disable. {@code DBMS_DEBUG.ENABLE_BREAKPOINT} and
     * {@code DISABLE_BREAKPOINT} are <em>functions</em> --
     * {@code (breakpoint IN BINARY_INTEGER) RETURN BINARY_INTEGER} -- so they must be
     * called in an assignment; a statement call raises PLS-00221. They are resolved
     * dynamically with the same -1 sentinel as the other optional primitives, so a
     * server without them degrades instead of breaking the package body.
     */
    private static final String ENABLE_BREAKPOINT =
        "PROCEDURE " + PROCEDURE_ENABLE_BREAKPOINT
            + "(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " BEGIN"
            + "  result := 0;"
            + "  BEGIN"
            + "   EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.enable_breakpoint(:2); END;'"
            + " USING OUT result, IN breakpoint#;"
            + "  EXCEPTION"
            + "   WHEN OTHERS THEN"
            + "    result := " + RESULT_CAPABILITY_UNAVAILABLE + ";"
            + "  END;"
            + "END;";

    private static final String DISABLE_BREAKPOINT =
        "PROCEDURE " + PROCEDURE_DISABLE_BREAKPOINT
            + "(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " BEGIN"
            + "  result := 0;"
            + "  BEGIN"
            + "   EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.disable_breakpoint(:2); END;'"
            + " USING OUT result, IN breakpoint#;"
            + "  EXCEPTION"
            + "   WHEN OTHERS THEN"
            + "    result := " + RESULT_CAPABILITY_UNAVAILABLE + ";"
            + "  END;"
            + "END;";

    private static final String SHOW_BREAKPOINTS =
        "PROCEDURE " + PROCEDURE_SHOW_BREAKPOINTS + "(listing in out varchar2) IS "
            + "BEGIN"
            + " dbms_debug.show_breakpoints(listing);"
            + "END;";

    /**
     * Stack backtrace. {@code DBMS_DEBUG.PRINT_BACKTRACE} also has a structured
     * overload -- {@code (backtrace OUT backtrace_table)}, where
     * {@code backtrace_table} is {@code TABLE OF program_info INDEX BY
     * BINARY_INTEGER} -- which the client currently parses as text. Not changed here;
     * it is the natural replacement for the "[Line N] NAME" parsing whenever the
     * frames need more than a line number and a program name.
     */
    private static final String PRINT_BACKTRACE =
        "PROCEDURE " + PROCEDURE_PRINT_BACKTRACE
            + "(listing IN OUT VARCHAR, status OUT BINARY_INTEGER) IS "
            + " run_info dbms_debug.runtime_info;"
            + " result BINARY_INTEGER;"
            + "BEGIN "
            + " result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info);"
            + " status := run_info.terminated;"
            + " dbms_debug.print_backtrace(listing);"
            + "END;";

    private static final String CNT_NEXT_LINE =
        "PROCEDURE " + PROCEDURE_CNT_NEXT_LINE + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.continue(run_info, dbms_debug.break_next_line, " + RUN_INFO_MASK + ");"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    /**
     * Resume. ODC uses {@code break_any_return} here exactly as step-out does, so
     * resume and step-out are equivalent by design: breakpoints pause the
     * interpreter regardless of breakflags, so resume still stops at the next
     * breakpoint.
     */
    private static final String CNT_NEXT_BREAKPOINT =
        "PROCEDURE " + PROCEDURE_CNT_NEXT_BREAKPOINT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.continue(run_info, dbms_debug.break_any_return, " + RUN_INFO_MASK + ");"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String CNT_STEP_IN =
        "PROCEDURE " + PROCEDURE_CNT_STEP_IN + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.continue(run_info, dbms_debug.break_any_call, " + RUN_INFO_MASK + ");"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String CNT_ABORT =
        "PROCEDURE " + PROCEDURE_CNT_ABORT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            // DBMS_DEBUG.ABORT is documented as "NOT YET SUPPORTED" in the package
            // spec, so aborting has to go through continue(abort_execution = 8192).
            // Calling dbms_debug.abort() would raise instead of stopping the
            // debuggee. (Aborting on an exception could use the OER breakpoint pair
            // SET_OER_BREAKPOINT / DELETE_OER_BREAKPOINT together with the
            // break_exception = 2 / break_handler = 2048 flags and runtime_info.oer;
            // not implemented here.)
            + "  result := dbms_debug.continue(run_info, dbms_debug.abort_execution, " + RUN_INFO_MASK + ");"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String CNT_STEP_OUT =
        "PROCEDURE " + PROCEDURE_CNT_STEP_OUT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.continue(run_info, dbms_debug.break_any_return, " + RUN_INFO_MASK + ");"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    /** Runs the program to its end by stepping lines until {@code reason_exit}. */
    private static final String CNT_EXIT =
        "PROCEDURE " + PROCEDURE_CNT_EXIT + "(message OUT VARCHAR2) IS"
            + " run_info dbms_debug.runtime_info;"
            + " result binary_integer;"
            + "BEGIN"
            + " <<label>> loop"
            + " result := dbms_debug.continue(run_info, dbms_debug.break_next_line, " + RUN_INFO_MASK + ");"
            + " if run_info.reason = dbms_debug.reason_exit OR result != dbms_debug.success THEN"
            + " exit label;"
            + " end if;"
            + " end loop label;"
            + " message := ' reason = ' || run_info.reason;"
            + "END;";

    /**
     * Variable inspection. The {@code dbms_debug.get_values} call is deliberately
     * dynamic: Oracle 21c XE does not declare that routine at all (PLS-00302 /
     * ORA-00904, and it is absent from {@code ALL_PROCEDURES}), so a static
     * reference here would leave the whole package body INVALID -- breakpoints,
     * stepping and backtraces included -- while {@code EXECUTE IMMEDIATE} only
     * fails when the routine is actually called. A failure is reported through
     * the {@link #RESULT_CAPABILITY_UNAVAILABLE} sentinel, which the client reads
     * as "this server cannot inspect variables" rather than a session failure.
     */
    private static final String GET_VALUES =
        "PROCEDURE " + PROCEDURE_GET_VALUES
            + "(scalar_values OUT VARCHAR2, result OUT BINARY_INTEGER) IS"
            + " BEGIN"
            + "  scalar_values := '';"
            + "  result := 0;"
            + "  BEGIN"
            + "   EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.get_values(:2); END;' USING OUT result, OUT scalar_values;"
            + "  EXCEPTION"
            + "   WHEN OTHERS THEN"
            + "    scalar_values := '';"
            + "    result := " + RESULT_CAPABILITY_UNAVAILABLE + ";"
            + "  END;"
            + "END;";

    private static final String GET_VALUE =
        "PROCEDURE " + PROCEDURE_GET_VALUE
            + "(variable_name VARCHAR2, frame# BINARY_INTEGER, value OUT VARCHAR2, result OUT BINARY_INTEGER) IS"
            + " BEGIN"
            + "  result := dbms_debug.get_value(variable_name, frame#, value);"
            + "END;";

    private static final String GET_RUNTIME_INFO =
        "PROCEDURE " + PROCEDURE_GET_RUNTIME_INFO
            + "(status OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + " result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info);"
            + " status := run_info.terminated;"
            + "END;";

    private static final String SYNCHRONIZE =
        "PROCEDURE " + PROCEDURE_SYNCHRONIZE
            + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + " run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.synchronize(run_info, dbms_debug.info_getLineinfo);"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String GET_LINE =
        "PROCEDURE " + PROCEDURE_GET_LINE + "(line OUT VARCHAR2, status OUT INTEGER) IS "
            + "  log VARCHAR2(10000) := '';"
            + "  fetched VARCHAR2(10000);"
            + "BEGIN"
            + "  <<label>>"
            + "  loop"
            + "    dbms_output.get_line(fetched, status);"
            + "    if status = 1 then"
            + "      exit label;"
            + "    else "
            + "      log := log || '\n' || fetched;"
            + "    end if;"
            + "   end loop label;"
            + " line := log;"
            + "END;";

    /**
     * Routine names an installed head must declare for the deployed body to compile.
     * The Go driver keeps the same list ({@code plDebugHeadRequiredRoutines}); both
     * agents reinstall the head when any entry is missing.
     */
    static final List<String> HEAD_REQUIRED_ROUTINES = List.of(
        PROCEDURE_SET_VALUE,
        // V6.3: a body that calls DBX_FETCH_OUTPUT fails with PLS-00302 unless the head
        // declares it, so the head is replaced whenever that declaration is missing.
        FUNCTION_FETCH_OUTPUT,
        PROCEDURE_SET_BREAKPOINT_EX,
        // The package-subprogram arm: a head installed before it declares no
        // DBX_SET_BREAKPOINT_ENTRY, and a body that calls it would fail with
        // PLS-00302 (component must be declared), so the head is replaced with it.
        PROCEDURE_SET_BREAKPOINT_ENTRY,
        PROCEDURE_SET_BREAKPOINT_ANONYMOUS,
        PROCEDURE_SYNCHRONIZE,
        PROCEDURE_ENABLE_BREAKPOINT,
        PROCEDURE_DISABLE_BREAKPOINT
    );

    /**
     * Declaration prefixes whose parameter list must not drift. The version note
     * rebuilds the body only, so a head left at V5 would keep
     * {@code DBX_SET_VALUE(name, frame#, index#, value)} and the new body --
     * {@code DBX_SET_VALUE(frame#, assignment_statement, result, message)} -- would
     * then fail to compile with PLS-00306, leaving the whole PACKAGE BODY INVALID.
     * Entries are matched as case-insensitive substrings of ALL_SOURCE.
     */
    static final List<String> HEAD_REQUIRED_DECLARATIONS = List.of(
        // V6.3: the drain routine is a FUNCTION, so its signature is pinned the same way the
        // Go agent pins it; a head installed before V6.3 declares nothing to match.
        "FUNCTION " + FUNCTION_FETCH_OUTPUT + "(max_chars IN BINARY_INTEGER) RETURN VARCHAR2",
        PROCEDURE_SET_VALUE + "(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2",
        PROCEDURE_ENABLE_BREAKPOINT + "(breakpoint# IN BINARY_INTEGER",
        PROCEDURE_DISABLE_BREAKPOINT + "(breakpoint# IN BINARY_INTEGER"
    );

    /** Everything {@link #HEAD_REQUIRED_ROUTINES} and the pinned signatures demand. */
    static final List<String> HEAD_REQUIREMENTS = headRequirements();

    private static List<String> headRequirements() {
        List<String> requirements = new ArrayList<>(HEAD_REQUIRED_ROUTINES);
        requirements.addAll(HEAD_REQUIRED_DECLARATIONS);
        return List.copyOf(requirements);
    }

    private static final String WRAPPED_PACKAGE_HEAD = "CREATE OR REPLACE PACKAGE "
        + "%s" + PACKAGE_NAME + " AS"
        + " PROCEDURE " + PROCEDURE_SET_BREAKPOINT
        + "(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_SET_BREAKPOINT_EX
        + "(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, signature IN VARCHAR2,"
        + " sequence# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_SET_BREAKPOINT_ENTRY
        + "(owner IN VARCHAR2, name IN VARCHAR2, entrypointname IN VARCHAR2,"
        + " line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_SET_VALUE
        + "(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2, result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_ENABLE_BREAKPOINT
        + "(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_DISABLE_BREAKPOINT
        + "(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_SET_BREAKPOINT_ANONYMOUS
        + "(line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_SHOW_BREAKPOINTS + "(listing in out varchar2);"
        + " PROCEDURE " + PROCEDURE_PRINT_BACKTRACE
        + "(listing IN OUT VARCHAR, status OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_CNT_NEXT_LINE
        + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_CNT_NEXT_BREAKPOINT
        + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_CNT_STEP_IN + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_CNT_ABORT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_CNT_STEP_OUT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_CNT_EXIT + "(message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_GET_VALUES
        + "(scalar_values OUT VARCHAR2, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_GET_VALUE
        + "(variable_name VARCHAR2, frame# BINARY_INTEGER, value OUT VARCHAR2, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_GET_RUNTIME_INFO
        + "(status OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_SYNCHRONIZE + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_GET_LINE
        + "(line OUT VARCHAR2, status OUT INTEGER);"
        + " FUNCTION " + FUNCTION_FETCH_OUTPUT
        + "(max_chars IN BINARY_INTEGER) RETURN VARCHAR2;"
        + "END " + PACKAGE_NAME + ";";

    private static final String WRAPPED_PACKAGE_BODY = "CREATE OR REPLACE PACKAGE BODY "
        + "%s" + PACKAGE_NAME + " AS "
        + VERSION_NOTE
        + " " + BODY_FIX_NOTE
        + VERSION_NOTE_DETAIL + "\n"
        + PENDING_LINE_DECLARATION_MARKER
        + SET_BREAKPOINT
        + SET_BREAKPOINT_ANONYMOUS
        + SET_BREAKPOINT_EX
        + SET_BREAKPOINT_ENTRY
        + SET_VALUE
        + ENABLE_BREAKPOINT
        + DISABLE_BREAKPOINT
        + SHOW_BREAKPOINTS
        + PRINT_BACKTRACE
        + CNT_NEXT_LINE
        + CNT_NEXT_BREAKPOINT
        + CNT_STEP_IN
        + CNT_ABORT
        + CNT_STEP_OUT
        + CNT_EXIT
        + GET_VALUES
        + GET_VALUE
        + GET_RUNTIME_INFO
        + SYNCHRONIZE
        + GET_LINE
        + FETCH_OUTPUT_MARKER
        + "END " + PACKAGE_NAME + ";";

    private DbxPlDebugPackage() {
    }

    /**
     * CREATE statement for the package head, qualified with the owner when one is
     * given. Qualified DDL keeps package creation independent of the session's
     * current schema.
     */
    static String packageHead(String owner) {
        return String.format(WRAPPED_PACKAGE_HEAD, ownerPrefix(owner));
    }

    /** CREATE statement for the package body; see {@link #VERSION_NOTE}. */
    static String packageBody(String owner) {
        return packageBody(owner, new ProgramInfoFields(false, false));
    }

    /**
     * CREATE statement for the package body, filling the overload attribute
     * assignments only for the {@code DBMS_DEBUG.PROGRAM_INFO} fields this server
     * actually declares, plus the V6.3 pending-line declaration and drain routine. The
     * markers are always consumed, so an executed DDL statement never carries one.
     */
    static String packageBody(String owner, ProgramInfoFields fields) {
        StringBuilder extra = new StringBuilder();
        if (fields.signature) {
            extra.append(" if signature is not null then pro_info.signature := signature; end if;");
        }
        if (fields.sequence) {
            extra.append(" if sequence# >= 0 then pro_info.sequence := sequence#; end if;");
        }
        String entry = fields.entrypoint
            ? "if entrypointname is not null then pro_info.entrypointname := entrypointname; end if;"
            : "";
        return String.format(WRAPPED_PACKAGE_BODY, ownerPrefix(owner))
            .replace(PROGRAM_INFO_EXTRA_MARKER, extra.toString())
            .replace(PROGRAM_INFO_ENTRY_MARKER, entry)
            .replace(PENDING_LINE_DECLARATION_MARKER, PENDING_LINE_DECLARATION)
            .replace(FETCH_OUTPUT_MARKER, FETCH_OUTPUT_ROUTINE);
    }

    /** Which optional {@code DBMS_DEBUG.PROGRAM_INFO} attributes a server declares. */
    static final class ProgramInfoFields {
        final boolean signature;
        final boolean sequence;
        /**
         * Whether the record declares {@code entrypointname}. It is what makes a
         * breakpoint on a subprogram inside a package body armable at all -- see
         * {@link #PROCEDURE_SET_BREAKPOINT_ENTRY} -- and the flag is still probed rather
         * than assumed, so an engine whose record lacks the attribute keeps a body that
         * compiles instead of one that fails with PLS-00302.
         */
        final boolean entrypoint;

        ProgramInfoFields(boolean signature, boolean sequence) {
            this(signature, sequence, false);
        }

        ProgramInfoFields(boolean signature, boolean sequence, boolean entrypoint) {
            this.signature = signature;
            this.sequence = sequence;
            this.entrypoint = entrypoint;
        }
    }

    private static String ownerPrefix(String owner) {
        if (owner == null || owner.trim().isEmpty()) {
            return "";
        }
        return "\"" + owner.trim().replace("\"", "\"\"") + "\".";
    }
}
