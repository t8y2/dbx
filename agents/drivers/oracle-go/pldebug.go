package main

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

// PL/SQL debugging over Oracle's DBMS_DEBUG package, implemented for pure
// Oracle connections the same way the oceanbase-oracle Java agent does it for
// OceanBase Oracle tenants: two dedicated sessions (debuggee + debugger), a
// per-schema helper package (DBX_PL_DEBUG_PACKAGE) that wraps the DBMS_DEBUG
// primitives with OUT registers, and the same request flow:
//
//	debuggee: SET_TIMEOUT_BEHAVIOUR -> INITIALIZE -> DEBUG_ON -> run target
//	debugger: ATTACH_SESSION(id) -> breakpoints -> continue/step -> values
//
// The helper package DDL matches the Java agent's definition (same package
// name, same routine signatures) so both agents can coexist on the same
// schema and reuse whichever copy was installed first.

const (
	plDebugPackageName   = "DBX_PL_DEBUG_PACKAGE"
	plDebugTimeoutMillis = int64(10 * 60 * 1000)
	plDebugOpenTimeout   = 20 * time.Second
	// plDebugCallTimeout bounds every post-attach DBMS_DEBUG call: the helper
	// package wrappers and the raw ATTACH/DETACH/DELETE_BREAKPOINT statements.
	//
	// A real Oracle 19c EE run proved that once the debuggee has finished, the
	// next PROBE call on the attached debugger session never returns at all: no
	// ORA error, no server-side timeout, and go-ora's context cancellation does
	// not interrupt it. The bound is well below the 120s a client waits for one
	// RPC, and still leaves a legitimate resume room to stop on a breakpoint.
	plDebugCallTimeout = 30 * time.Second
	// plDebugReleaseTimeout bounds the teardown calls (abort, DEBUG_OFF,
	// DETACH_SESSION). They run when the session is already known to be broken,
	// so they must not add another full call timeout to the RPC that closes it.
	plDebugReleaseTimeout = 5 * time.Second
	// plDebugCloseWaitTimeout bounds the wait for the two pools to close during
	// teardown: database/sql's DB.Close waits for in-flight statements, and the
	// in-flight statement here is exactly the one that had to be abandoned.
	plDebugCloseWaitTimeout = 5 * time.Second
	// plDebugServerTimeoutSeconds is the debuggee-side idle timeout handed to
	// DBMS_DEBUG.SET_TIMEOUT, the value ODC's DebuggeeSession passes
	// (DebuggeeSession :68 -> "select dbms_debug.set_timeout(120) from dual").
	// This agent never called it, so a real 19c EE target had no server-side bound
	// at all and a debugger that disappeared left it parked on Probe until the
	// package default (3600s) -- while parked, the debuggee's execution pin on the
	// helper package makes CREATE OR REPLACE PACKAGE BODY wait indefinitely
	// (measured: 40s, then the client gave up; see plDebugEnsureHelperPackage).
	plDebugServerTimeoutSeconds = 120
	// plDebugHelperInstallTimeout bounds the whole helper-package install (inspect,
	// head DDL, body DDL). It is longer than one call because it performs several
	// statements, and it exists because that install is the one step of the start
	// sequence that can wait on another session's execution of the package: a parked
	// debuggee pins DBX_PL_DEBUG_PACKAGE, and CREATE OR REPLACE PACKAGE BODY then waits
	// without any server-side error (measured on 19c EE: 40s and still waiting).
	plDebugHelperInstallTimeout = 60 * time.Second
	// plDebugLogChars is one DBX_FETCH_OUTPUT chunk and the size of the OUT buffer the
	// go-ora driver reads it back into. It is one character below PL/SQL's 32767-byte
	// VARCHAR2 limit so the trailing chr(10) join can never overflow the server side.
	plDebugLogChars = 32000
	// plDebugLogParkTimeout bounds one DBX_OUTPUT drain call in a session that is
	// still in debug mode. Such a call parks for the debuggee's own
	// DBMS_DEBUG.SET_TIMEOUT, which the agent keeps at plDebugServerTimeoutSeconds
	// (120s, ODC 1:1), so the bound has to sit above it: a shorter bound is what made
	// the old drain give up and drop the debuggee pool, losing the buffered output and
	// the session with it. DBX_FETCH_OUTPUT lowers the session's own remaining park to
	// one second on its first call, so this bound is only ever reached by a session
	// whose capture never ran (an anonymous-block target, an aborted or
	// exception-terminated program).
	plDebugLogParkTimeout = plDebugServerTimeoutSeconds*time.Second + 30*time.Second
)

const (
	procSetBreakpoint          = "DBX_SET_BREAKPOINT"
	procSetBreakpointAnonymous = "DBX_SET_BREAKPOINT_ANONYMOUS"
	procShowBreakpoints        = "DBX_SHOW_BREAKPOINTS"
	procPrintBacktrace         = "DBX_PRINT_BACKTRACE"
	procCntNextLine            = "DBX_CNT_NEXT_LINE"
	procCntNextBreakpoint      = "DBX_CNT_NEXT_BREAKPOINT"
	procCntStepIn              = "DBX_CNT_STEP_IN"
	procCntAbort               = "DBX_CNT_ABORT"
	procCntStepOut             = "DBX_CNT_STEP_OUT"
	procCntExit                = "DBX_CNT_EXIT"
	procGetValues              = "DBX_GET_VALUES"
	procGetValue               = "DBX_GET_VALUE"
	procGetRuntimeInfo         = "DBX_GET_RUNTIME_INFO"
	procSynchronize            = "DBX_SYNCHRONIZE"
	procGetLine                = "DBX_GET_LINE"
	// procFetchOutput is the V6.3 one-call DBMS_OUTPUT drain, and it is a FUNCTION
	// on purpose: the debuggee's own anonymous block calls it as the trailing
	// statement of the program it runs (see plDebugAnonymousBlock), which is the one
	// moment a PL/SQL call in a debug-mode session does NOT park -- the debugger is
	// still inside CONTINUE, driving the program. It also lowers the session's own
	// post-program park for the Go-side calls that follow (see plDebugFetchOutput).
	procFetchOutput = "DBX_FETCH_OUTPUT"
	// procSetValue mutates a variable of a parked debuggee. DBMS_DEBUG.SET_VALUE
	// has exactly two overloads -- (frame# IN BINARY_INTEGER, assignment_statement
	// IN VARCHAR2) and (handle IN program_info, assignment_statement IN VARCHAR2),
	// both RETURN BINARY_INTEGER -- and its second argument is the *text* of a
	// PL/SQL assignment ("x := 5", "s := ''abc''", "x(1) := 5"), not a value
	// (Oracle 21c XE ALL_ARGUMENTS verified). A four-argument call to
	// set_value(name, frame#, index#, value) therefore matches no overload at all:
	// it raised PLS-00306 inside the dynamic block, hit WHEN OTHERS, and made the
	// agent claim "this server cannot change variable values" on servers that do
	// support SET_VALUE. The wrapper now takes the frame number plus the assignment
	// text and still resolves the function dynamically, because a static reference
	// to a routine a server does not declare would leave the whole package body
	// INVALID.
	//
	// Open question for the next real-machine run: Oracle's reference examples pass
	// the text with its terminator ('x := 3;', 'var := 6;'), while the agent builds
	// it without one ("x := 5"), because Probe may well append the terminator
	// itself. Both forms are therefore tried: plDebugAssignmentStatement still
	// renders the unterminated text, and setValue retries exactly once with a
	// trailing ";" when the wrapper answers with a syntax error (PLS-00103). A
	// missing primitive is never retried -- the wrapper's SQLERRM keeps the two
	// apart -- and the response reports which form won ("assignmentSemicolon").
	procSetValue = "DBX_SET_VALUE"
	// procEnableBreakpoint / procDisableBreakpoint toggle an existing breakpoint
	// through DBMS_DEBUG.ENABLE_BREAKPOINT / DISABLE_BREAKPOINT. Both are
	// *functions* -- (breakpoint IN BINARY_INTEGER) RETURN BINARY_INTEGER -- so the
	// wrapper calls them in an assignment (a statement call raises PLS-00221), and
	// both are resolved dynamically with the -1 capability sentinel for servers
	// that do not carry them. Their result codes are success /
	// error_no_such_breakpt / error_idle_breakpt.
	procEnableBreakpoint  = "DBX_ENABLE_BREAKPOINT"
	procDisableBreakpoint = "DBX_DISABLE_BREAKPOINT"
	// procSetBreakpointEx is procSetBreakpoint plus the overload disambiguation
	// attributes of DBMS_DEBUG.PROGRAM_INFO (signature/sequence). The plain
	// DBX_SET_BREAKPOINT keeps its original signature because the Java agent
	// shares this package.
	procSetBreakpointEx = "DBX_SET_BREAKPOINT_EX"
	// procSetBreakpointEntry is the *package-subprogram* arm: it fills
	// DBMS_DEBUG.PROGRAM_INFO.entrypointname, which is the only shape a breakpoint on a
	// subprogram INSIDE a package body accepts on Oracle 19c EE. Measured there against
	// one package subprogram, with the subprogram's own name in name (the shape the
	// desktop client sends as "PKG.SUB" and the previous code handed over verbatim):
	//
	//	name=<subprogram> namespace_pkgspec_or_toplevel (1) -> error_bad_handle (16)
	//	name=<subprogram> namespace_pkg_body (2)            -> error_bad_handle (16)
	//	name=<subprogram> / namespace NULL                  -> error_exception (28)
	//	name="PKG.SUB"    / namespace NULL                  -> error_exception (28)
	//	name=<package>, namespace_pkgspec_or_toplevel (1), entrypointname=<subprogram> -> 12
	//	name=<package>, namespace_pkg_body (2),            entrypointname=<subprogram> -> success (0)
	//
	// The server reports the *package* as the frame's program and leaves
	// entrypointname NULL in run_info, so nothing else in the helper package can address
	// the subprogram. DBX_SET_BREAKPOINT_ENTRY is a separate routine -- not a new
	// parameter on DBX_SET_BREAKPOINT / _EX -- because the Java agent shares this package
	// and keeps calling those two with their existing signatures.
	procSetBreakpointEntry = "DBX_SET_BREAKPOINT_ENTRY"
)

// plDebugProgramInfoExtraMarker is the placeholder plDebugPackageBody replaces
// with the DBMS_DEBUG.PROGRAM_INFO assignment lines this server actually
// supports. It is a block comment so the raw template still compiles (and stays
// inert) when the caller never runs the replacement.
const plDebugProgramInfoExtraMarker = "/*DBX_PROGRAM_INFO_EXTRA*/"

// plDebugProgramInfoEntryMarker is the placeholder plDebugPackageBody replaces with the
// entrypointname assignment of DBX_SET_BREAKPOINT_ENTRY. It is a separate marker from
// plDebugProgramInfoExtraMarker because it is filled from a third capability probe:
// a server whose DBMS_DEBUG.PROGRAM_INFO record has no entrypointname attribute must not
// carry the assignment (a static reference would compile the whole PACKAGE BODY to
// INVALID with PLS-00302). Oracle 19c EE declares it -- measured against
// ALL_PLSQL_TYPE_ATTRS: NAMESPACE/NAME/OWNER/DBLINK/LINE#/LIBUNITTYPE/ENTRYPOINTNAME --
// which is why the entry arm is what makes a package subprogram breakpoint work there.
const plDebugProgramInfoEntryMarker = "/*DBX_PROGRAM_INFO_ENTRYPOINT*/"

// plDebugNamespaceFallbackDDL is the PL/SQL fragment the two named-breakpoint wrappers
// execute: it sets the breakpoint on pro_info and walks the namespaces a program unit
// handle may live in.
//
// DBMS_DEBUG.PROGRAM_INFO exists to carry a namespace precisely so the server can tell a
// package spec from a package body, and Oracle's own examples fill it. On Oracle 19c EE
// a handle left with namespace NULL answers error_bad_handle (16), which the spec
// documents for set_breakpoint as "no such program unit exists" -- so the old
// name+owner-only call could never arm anything on that server. Measured against
// DBX_DEBUG.DBX_V1_PROC line 10 on 19c EE:
//
//	namespace_pkgspec_or_toplevel (1)  -> success (0), breakpoint accepted
//	namespace_pkg_body (2)             -> error_bad_handle (16)
//	namespace_cursor (0)               -> error_bad_handle (16)
//	namespace_trigger (3)              -> error_bad_handle (16)
//	(none, NULL)                       -> error_bad_handle (16)
//
// The first attempt is therefore the top-level/spec namespace that a standalone
// PROCEDURE or FUNCTION lives in, and the remaining three are a fallback chain so a
// package-body subprogram still resolves. The order is observable and cheap: a
// namespace that does not contain the unit answers 16 without creating anything, and the
// loop stops at the first success. Engines whose set_breakpoint resolves the name only
// (OceanBase Oracle mode does: its body builds "owner.name" and never reads the
// namespace) succeed on the first attempt and behave exactly as before.
const plDebugNamespaceFallbackDDL = `pro_info.namespace := dbms_debug.namespace_pkgspec_or_toplevel; result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); ` +
	`IF result <> 0 THEN pro_info.namespace := dbms_debug.namespace_pkg_body; result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF; ` +
	`IF result <> 0 THEN pro_info.namespace := dbms_debug.namespace_cursor; result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF; ` +
	`IF result <> 0 THEN pro_info.namespace := NULL; result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF;`

// plDebugEntrypointFallbackDDL is the namespace chain DBX_SET_BREAKPOINT_ENTRY executes.
// It is deliberately NOT plDebugNamespaceFallbackDDL: the entry arm is only ever used for a
// subprogram that lives inside a package body, and for that target the measured order is
// the reverse. With name = <package> and entrypointname = <subprogram> on Oracle 19c EE,
// namespace_pkg_body (2) answered success (0) while namespace_pkgspec_or_toplevel (1)
// answered 12 (error_illegal_handle, i.e. the handle it built is not usable). Starting with
// the body namespace is therefore the one-trip arm; the remaining namespaces keep the
// fallback property the standalone wrapper relies on -- a namespace that does not hold the
// unit answers non-zero without arming anything.
const plDebugEntrypointFallbackDDL = `pro_info.namespace := dbms_debug.namespace_pkg_body; result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); ` +
	`IF result <> 0 THEN pro_info.namespace := dbms_debug.namespace_pkgspec_or_toplevel; result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF; ` +
	`IF result <> 0 THEN pro_info.namespace := dbms_debug.namespace_cursor; result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF; ` +
	`IF result <> 0 THEN pro_info.namespace := NULL; result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END IF;`

// DBMS_DEBUG result codes the agent branches on, transcribed from ODC's
// PLDebugErrorCode (which in turn refers to dbms_debug.sql). Every other
// non-zero result is surfaced verbatim in the error message.
const (
	plDebugErrSuccess          = 0
	plDebugErrNoSuchBreakpoint = 13
	plDebugErrException        = 28
	// plDebugErrNameIncomplete (11) and plDebugErrBadHandle (16) belong to the
	// same DBMS_DEBUG error enumeration as plDebugErrException (28). They are
	// kept apart from the run_info reason_* codes below, which reuse 11 and 16
	// with a completely different meaning. error_bad_handle is what
	// set_breakpoint answers when the program_info handle it was handed is not
	// usable -- with an empty run_info from get_runtime_info, that is all a
	// server can answer, and it is no reason to run the debuggee anyway.
	plDebugErrNameIncomplete = 11
	plDebugErrBadHandle      = 16
	// plDebugReasonException and plDebugReasonHandler are the run_info.reason
	// values an exception breakpoint stops on (dbms_debug.reason_exception=11,
	// reason_handler=16). Every other reason -- notably reason_finish (8), which
	// merely means the current entrypoint returned -- keeps the exception-mode
	// resume loop going.
	plDebugReasonException = 11
	plDebugReasonHandler   = 16
	// plDebugReasonExit / plDebugReasonAborting / plDebugReasonKnlExit terminate
	// the debuggee. reason_knl_exit (25) is what ABORT_EXECUTION reports once the
	// interpreter has left the program: measured on Oracle 19c EE as
	// `DBX_CNT_ABORT -> result=0, run_info.reason = 25` with an empty
	// run_info.programname, i.e. no program is running any more. Leaving it out
	// kept the session "live" after an abort, so the client could no longer read
	// the DBMS_OUTPUT the aborted run had already produced.
	plDebugReasonExit     = 15
	plDebugReasonAborting = 21
	plDebugReasonKnlExit  = 25
	// plDebugReasonEnter / plDebugReasonLine / plDebugReasonBreakpoint are the
	// run_info.reason values the start sequence drives the debuggee through, all
	// measured on Oracle 19c EE against DBX_DEBUG.DBX_V1_PROC:
	// reason_enter (6) is what CONTINUE(break_any_call) reports on entering the
	// routine the anonymous block calls, reason_line (9) is a step, and
	// reason_breakpoint (3) is a caller-armed breakpoint being hit.
	plDebugReasonEnter      = 6
	plDebugReasonLine       = 9
	plDebugReasonBreakpoint = 3
	// plDebugErrGetValuesUnavailable is the sentinel DBX_GET_VALUES returns when
	// DBMS_DEBUG.GET_VALUES is absent (stock Oracle declares GET_VALUE instead).
	// It is negative because every real DBMS_DEBUG result code is >= 0, so the
	// agent can explain the degradation instead of printing a bare number.
	plDebugErrGetValuesUnavailable = plDebugErrCapabilityUnavailable
	// plDebugErrCapabilityUnavailable is the shared sentinel every dynamic wrapper
	// (DBX_GET_VALUES, DBX_SET_VALUE, DBX_ENABLE_BREAKPOINT, DBX_DISABLE_BREAKPOINT)
	// returns when the server-side primitive it delegates to is not declared at
	// all.
	plDebugErrCapabilityUnavailable = -1
	// plDebugErrValueMalformed is DBMS_DEBUG.error_value_malformed (7), "bad value".
	// Oracle 19c EE answers it for an assignment Probe would accept with its PL/SQL
	// terminator: set_value(0, 'V_COUNT := 100') -> 7, 'V_COUNT := 100;' -> 0.
	plDebugErrValueMalformed = 7
	// plDebugErrTimeout is DBMS_DEBUG.error_timeout (31). SYNCHRONIZE documents it as
	// "timed out before the program started execution"; it is named here so the start
	// sequence can say which of the two synchronize failures happened.
	plDebugErrTimeout = 31
)

// plDebugResultName spells a DBMS_DEBUG result code with its package-constant
// name. The real-machine failure was reported as a bare "28"/"16", which cannot
// be read without dbms_debug.sql next to it; every error this file raises about a
// result code now names it as well as numbering it.
func plDebugResultName(result int) string {
	switch result {
	case plDebugErrSuccess:
		return "success"
	case plDebugErrNameIncomplete:
		return "error_name_incomplete"
	case plDebugErrNoSuchBreakpoint:
		return "error_no_such_breakpt"
	case plDebugErrBadHandle:
		return "error_bad_handle"
	case plDebugErrValueMalformed:
		return "error_value_malformed"
	case plDebugErrException:
		return "error_exception"
	case plDebugErrTimeout:
		return "error_timeout"
	case plDebugErrCapabilityUnavailable:
		return "capability_unavailable"
	}
	return fmt.Sprintf("result_%d", result)
}

// plDebugExceptionResumeIterations caps the exception-mode resume loop. Without
// it a server that keeps reporting reason_finish (or an unparsable reason) would
// spin forever inside pl_debug_resume and the RPC would never return.
const plDebugExceptionResumeIterations = 200

// plDebugStartStepInLimit is MAX_TRY_STEP_INTO_TIMES from ODC's
// DebuggerSession.stepInForStartingDebug (:555-571): the start sequence steps in
// at most this many times waiting for the stack depth to grow, and reports
// DebugStartFailed when it never does.
const plDebugStartStepInLimit = 5

// plDebugPackageStepInLimit is the start sequence's step-in budget for a PACKAGE
// subprogram target.
//
// A package subprogram needs more than plDebugStartStepInLimit because the interpreter
// reports the *package body* as the frame and walks its initialization section first:
// measured on Oracle 19c EE against DBX_DEBUG.DBX_MSCHK_PKG2 (a 3-line initialization
// section), CONTINUE(break_any_call) stopped at reason_enter on the package header line
// (line 1), then on the three initialization lines (8, 9, 10), and only the *fifth*
// call reported reason_enter (line 2) inside RUN_MSCHK -- exactly at the 5-attempt
// limit, so any longer initialization section would have failed the start. The budget
// is therefore a documented bound rather than ODC's step count: it exists so a package
// whose initialization section is long still starts, and the range check below (not the
// budget) is what keeps the stop inside the requested subprogram.
const plDebugPackageStepInLimit = 40

// The debuggee block is submitted asynchronously, so the debugger's
// ATTACH_SESSION can arrive before the debuggee signalled that it is parked.
// That race is retried a bounded number of times instead of failing the start.
const (
	plDebugAttachAttempts = 20
	plDebugAttachDelay    = 50 * time.Millisecond
)

// plDebugVersionNote is the marker the deploy step searches for in ALL_SOURCE to
// decide whether the installed package body is already current. It mirrors the
// version-note mechanism ODC uses (PackageValidator.isVersionValid), so a stale
// package is rebuilt instead of being used blindly.
const plDebugVersionNote = "-- DBX PL Debug Package Version: V6 (ODC V3.3.2.1 aligned, Oracle portable)"

// plDebugBodyFixNote is the second marker plDebugPackageVersionCurrent requires, and it
// is the real-machine fix stamp for a V6 body. It is deliberately NOT a bump of
// plDebugVersionNote: the Go agent and the Java agent (agents/drivers/oceanbase-oracle)
// install the SAME package, each recognising the other's body by that exact V6 literal
// (ODC's PackageValidator.isVersionValid mechanism). Bumping the literal would make the
// two agents rebuild each other's package on every start. A second marker keeps the
// shared V6 identity intact while still forcing a rebuild of any body that predates the
// fixes the marker stands for, which real Oracle 19c EE runs proved necessary. The Java
// agent writes this exact literal onto the same header line (DbxPlDebugPackage.BODY_FIX_NOTE),
// so a body either agent installs satisfies both.
//
//  1. DBX_SET_BREAKPOINT / DBX_SET_BREAKPOINT_EX must fill
//     dbms_debug.program_info.namespace. With namespace left NULL every named
//     breakpoint answered error_bad_handle (16) -- "no such program unit exists" --
//     on Oracle 19c EE, so pl_debug_set_breakpoints and pl_debug_resume could never
//     stop anywhere. Measured on 19c EE: namespace = namespace_pkgspec_or_toplevel (1)
//     answered success, while 0/2/3/4/NULL answered 16.
//  2. Every DBX_CNT_* wrapper must pass info_requested EXPLICITLY. On 19c EE the
//     default (NULL) run_info came back with only reason/terminated filled --
//     programname, programowner, stackdepth and line all NULL -- so
//     applyRunInfoMessage had nothing to publish.
//  3. DBX_SET_BREAKPOINT_ENTRY must fill dbms_debug.program_info.entrypointname.
//     A breakpoint on a subprogram INSIDE a package body is only armable as
//     name=<package> + namespace_pkg_body + entrypointname=<subprogram> (success);
//     every shape that passes the subprogram as program_info.name answers
//     error_bad_handle (16) or error_exception (28), which is why
//     pl_debug_set_breakpoints used to answer [] there. Measured on 19c EE.
//  4. V6.3 adds DBX_FETCH_OUTPUT, the one-call DBMS_OUTPUT drain. It exists because
//     after DEBUG_ON EVERY PL/SQL call in the debuggee session parks for the whole
//     DBMS_DEBUG.SET_TIMEOUT (measured on 19c EE: with SET_TIMEOUT(5) the first
//     post-DEBUG_ON statement answered after 5070ms, with SET_TIMEOUT(1) after
//     1066ms, and a plain SQL SELECT kept answering in 25ms), so the drain has to
//     be one call, and it has to be able to lower that park itself for the calls
//     that follow it. See plDebugFetchOutput and plDebugSession.log.
//
// All changes are inert on engines whose set_breakpoint ignores namespace / entrypointname
// (OceanBase Oracle mode resolves the name only) and whose get_runtime_info ignores the
// request mask, so the shared package stays correct for both agents.
const plDebugBodyFixNote = "-- DBX PL Debug Package Fix: V6.3 DBX_FETCH_OUTPUT one-call DBMS_OUTPUT drain (V6.2 program_info.entrypointname arm for package subprograms, V6.1 namespace-aware set_breakpoint + explicit run_info mask retained)"

// plDebugRunInfoMask is the info_requested bit-field every DBX_CNT_* wrapper passes to
// DBMS_DEBUG.CONTINUE instead of relying on the default. info_getStackDepth (2) is what
// fills run_info.stackdepth and info_getLineinfo (8) is what fills
// run_info.program.name/owner + run_info.line#. Measured on Oracle 19c EE: the default
// (NULL) filled neither, info_getLineinfo alone filled the program but not the depth,
// and 10 filled both.
const plDebugRunInfoMask = "dbms_debug.info_getStackDepth + dbms_debug.info_getLineinfo"

// runInfoMessage is the diagnostic line the CNT_* wrappers build from
// DBMS_DEBUG's run_info record. The shape is byte-for-byte ODC's
// (OracleCreateDebugPLConstants), including the leading space and the
// "run_info." key prefixes: the desktop client parses it by splitting on ","
// and reading fields 1..4 positionally.
const runInfoMessage = `message := ' run_info.breakpoint = ' || run_info.breakpoint` +
	` || ', run_info.stackdepth = ' || run_info.stackdepth` +
	` || ', run_info.reason = ' || run_info.reason` +
	` || ', run_info.programname = ' || run_info.program.name` +
	` || ', run_info.programowner = ' || run_info.program.owner;`

const plDebugPackageHeadDDL = `CREATE OR REPLACE PACKAGE "%[1]s".` + plDebugPackageName + ` AS
 PROCEDURE ` + procSetBreakpoint + `(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procSetBreakpointEx + `(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, signature IN VARCHAR2, sequence# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procSetBreakpointEntry + `(owner IN VARCHAR2, name IN VARCHAR2, entrypointname IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procSetValue + `(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2, result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procEnableBreakpoint + `(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procDisableBreakpoint + `(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procSetBreakpointAnonymous + `(line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procShowBreakpoints + `(listing in out varchar2);` +
	` PROCEDURE ` + procPrintBacktrace + `(listing IN OUT VARCHAR, status OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procCntNextLine + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procCntNextBreakpoint + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procCntStepIn + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procCntAbort + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procCntStepOut + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procCntExit + `(message OUT VARCHAR2);` +
	` PROCEDURE ` + procGetValues + `(scalar_values OUT VARCHAR2, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procGetValue + `(variable_name VARCHAR2, frame# BINARY_INTEGER, value OUT VARCHAR2, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procGetRuntimeInfo + `(status OUT BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procSynchronize + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procGetLine + `(line OUT VARCHAR2, status OUT INTEGER);` +
	` FUNCTION ` + procFetchOutput + `(max_chars IN BINARY_INTEGER) RETURN VARCHAR2;` +
	`END ` + plDebugPackageName + `;`

// The CNT_* wrappers map onto DBMS_DEBUG.CONTINUE breakflags exactly as ODC's
// package does:
//
//	break_next_line  -> step over: stop at the next source line
//	break_any_call   -> step into: stop on entry into a called entrypoint
//	break_any_return -> resume AND step out: stop once the current entrypoint returns
//	abort_execution  -> abort
//
// ODC uses break_any_return for both resume and step-out, so the two operations
// are equivalent there. We keep that behaviour deliberately: breakpoints pause
// the interpreter regardless of breakflags, so resume still stops at the next
// breakpoint, and "identical to ODC" was the explicit requirement.
//
// abort_execution is the only abort mechanism there is: DBMS_DEBUG.ABORT is
// documented as "NOT YET SUPPORTED" in the package spec, so DBX_CNT_ABORT calls
// continue(abort_execution = 8192) instead of dbms_debug.abort().
//
// Two mechanisms are deliberately NOT implemented here, recorded so the next
// iteration does not have to rediscover them:
//
//   - DBX_PRINT_BACKTRACE wraps the textual overload (listing IN OUT VARCHAR2).
//     PRINT_BACKTRACE also has (backtrace OUT backtrace_table), a structured
//     TABLE OF program_info, which would replace the "[Line N] NAME" parsing in
//     plDebugParseBacktraceFrames.
//   - Exception breakpoints have a native mechanism: SET_OER_BREAKPOINT /
//     DELETE_OER_BREAKPOINT together with continue's break_exception (2) /
//     break_handler (2048) flags and runtime_info.oer. The current exception mode
//     resumes in a loop and inspects run_info.reason instead.
const plDebugPackageBodyDDL = `CREATE OR REPLACE PACKAGE BODY "%[1]s".` + plDebugPackageName + ` AS ` + plDebugVersionNote + ` ` + plDebugBodyFixNote + `
-- V6.2 (real Oracle 19c EE verified): DBX_SET_BREAKPOINT_ENTRY added. It fills
-- dbms_debug.program_info.entrypointname (and tries namespace_pkg_body first), which is
-- the only arm a breakpoint on a subprogram INSIDE a package body accepts: measured on
-- 19c EE, name=<package> + namespace_pkg_body + entrypointname=<subprogram> answers
-- success (0), while every shape that passes the subprogram as program_info.name answers
-- error_bad_handle (16) or error_exception (28) -- so pl_debug_set_breakpoints answered []
-- and the session ran to completion. See plDebugBodyFixNote.
-- V6.1 (real Oracle 19c EE verified): DBX_SET_BREAKPOINT and DBX_SET_BREAKPOINT_EX now
-- fill dbms_debug.program_info.namespace, and every DBX_CNT_* wrapper passes
-- info_requested explicitly. See plDebugBodyFixNote for the measurements. Everything
-- below is still the V6 body ODC V3.3.2.1 shares with the Java agent.
-- V6: DBX_SET_VALUE now matches the real DBMS_DEBUG.SET_VALUE overloads. They take
-- (frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2) and RETURN
-- BINARY_INTEGER (Oracle 21c XE verified through ALL_PROCEDURES/ALL_ARGUMENTS); the
-- old wrapper called set_value(name, frame#, index#, value), which matched no
-- overload, always raised inside the dynamic block and reported the -1 sentinel --
-- i.e. "this server cannot change variable values" on servers that support it. The
-- wrapper now takes the frame number plus the PL/SQL assignment text the caller
-- builds ("x := 5", "s := ''abc''", "x(1) := 5") and forwards the text verbatim,
-- and it reports WHY a dynamic call failed so "routine not declared" stays
-- distinguishable from a malformed assignment. DBX_ENABLE_BREAKPOINT and
-- DBX_DISABLE_BREAKPOINT were added for breakpoint enable/disable:
-- DBMS_DEBUG.ENABLE_BREAKPOINT / DISABLE_BREAKPOINT are functions taking
-- (breakpoint IN BINARY_INTEGER) and returning success / error_no_such_breakpt /
-- error_idle_breakpt. Because DBX_SET_VALUE changed signature (not just its body),
-- the head has to be rebuilt too: plDebugHeadRequirements checks the declaration
-- text, not only the routine name.
-- V5: DBX_SET_VALUE added (dynamic dbms_debug.set_value, -1 sentinel when the
-- routine is absent) and DBX_SET_BREAKPOINT_EX added, which fills the optional
-- dbms_debug.program_info signature/sequence attributes when the server's record
-- type declares them. DBX_SET_VALUE is declared in the package head so the body
-- compiles; the head is rebuilt whenever an older install lacks it.
-- V4: DBX_GET_VALUES resolves dbms_debug.get_values dynamically. That routine is
-- an OceanBase Oracle-mode extension; stock Oracle (21c XE verified) declares
-- GET_VALUE but NOT GET_VALUES, so the previous static reference made this entire
-- PACKAGE BODY INVALID (PLS-00302: component 'GET_VALUES' must be declared) and
-- broke set_breakpoint/continue/print_backtrace as well.
-- V3: package bodies realigned verbatim with ODC (OracleCreateDebugPLConstants,
-- ODC V3.3.2.1): resume restored to break_any_return, run_info message keys
-- renamed to run_info.* without the line#, CNT_EXIT added.
-- V2: resume (DBX_CNT_NEXT_BREAKPOINT) passed breakflags 0.
-- V6.3: DBX_PENDING_LINE is the one line a DBX_FETCH_OUTPUT chunk boundary had to
-- cut off. It has to be a package-level variable, and it has to be declared here --
-- a package body's declarations precede its subprogram bodies -- because
-- DBMS_OUTPUT.GET_LINE pops the line it hands out, so a chunk that stops at the
-- requested size would otherwise lose that line on the next call.

` + plDebugPackageName + `_PENDING_LINE VARCHAR2(32767) := NULL;

PROCEDURE ` + procSetBreakpoint + `(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS pro_info dbms_debug.program_info; BEGIN pro_info.name := name; pro_info.owner := owner; ` + plDebugNamespaceFallbackDDL + ` END;

PROCEDURE ` + procSetBreakpointAnonymous + `(line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info); IF run_info.program.name IS NULL THEN RETURN; END IF; result := dbms_debug.set_breakpoint(run_info.program, line#, breakpoint#); END;

PROCEDURE ` + procSetBreakpointEx + `(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, signature IN VARCHAR2, sequence# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS pro_info dbms_debug.program_info; BEGIN pro_info.name := name; pro_info.owner := owner; ` + plDebugProgramInfoExtraMarker + ` ` + plDebugNamespaceFallbackDDL + ` END;

PROCEDURE ` + procSetBreakpointEntry + `(owner IN VARCHAR2, name IN VARCHAR2, entrypointname IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS pro_info dbms_debug.program_info; BEGIN pro_info.name := name; pro_info.owner := owner; ` + plDebugProgramInfoEntryMarker + ` ` + plDebugEntrypointFallbackDDL + ` END;

PROCEDURE ` + procSetValue + `(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2, result OUT BINARY_INTEGER, message OUT VARCHAR2) IS BEGIN result := 0; message := ''; BEGIN EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.set_value(:2, :3); END;' USING OUT result, IN frame#, IN assignment_statement; EXCEPTION WHEN OTHERS THEN result := -1; message := SQLERRM; END; END;

PROCEDURE ` + procEnableBreakpoint + `(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER) IS BEGIN result := 0; BEGIN EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.enable_breakpoint(:2); END;' USING OUT result, IN breakpoint#; EXCEPTION WHEN OTHERS THEN result := -1; END; END;

PROCEDURE ` + procDisableBreakpoint + `(breakpoint# IN BINARY_INTEGER, result OUT BINARY_INTEGER) IS BEGIN result := 0; BEGIN EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.disable_breakpoint(:2); END;' USING OUT result, IN breakpoint#; EXCEPTION WHEN OTHERS THEN result := -1; END; END;

PROCEDURE ` + procShowBreakpoints + `(listing in out varchar2) IS BEGIN dbms_debug.show_breakpoints(listing); END;

PROCEDURE ` + procPrintBacktrace + `(listing IN OUT VARCHAR, status OUT BINARY_INTEGER) IS run_info dbms_debug.runtime_info; result BINARY_INTEGER; BEGIN result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info); status := run_info.terminated; dbms_debug.print_backtrace(listing); END;

PROCEDURE ` + procCntNextLine + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.break_next_line, ` + plDebugRunInfoMask + `); ` + runInfoMessage + ` END;

PROCEDURE ` + procCntNextBreakpoint + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.break_any_return, ` + plDebugRunInfoMask + `); ` + runInfoMessage + ` END;

PROCEDURE ` + procCntStepIn + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.break_any_call, ` + plDebugRunInfoMask + `); ` + runInfoMessage + ` END;

PROCEDURE ` + procCntAbort + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.abort_execution, ` + plDebugRunInfoMask + `); ` + runInfoMessage + ` END;

PROCEDURE ` + procCntStepOut + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.break_any_return, ` + plDebugRunInfoMask + `); ` + runInfoMessage + ` END;

PROCEDURE ` + procCntExit + `(message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; result binary_integer; BEGIN <<label>> loop result := dbms_debug.continue(run_info, dbms_debug.break_next_line, ` + plDebugRunInfoMask + `); if run_info.reason = dbms_debug.reason_exit OR result != dbms_debug.success THEN exit label; end if; end loop label; message := ' reason = ' || run_info.reason; END;

PROCEDURE ` + procGetValues + `(scalar_values OUT VARCHAR2, result OUT BINARY_INTEGER) IS BEGIN scalar_values := ''; result := 0; BEGIN EXECUTE IMMEDIATE 'BEGIN :1 := dbms_debug.get_values(:2); END;' USING OUT result, OUT scalar_values; EXCEPTION WHEN OTHERS THEN scalar_values := ''; result := -1; END; END;

PROCEDURE ` + procGetValue + `(variable_name VARCHAR2, frame# BINARY_INTEGER, value OUT VARCHAR2, result OUT BINARY_INTEGER) IS BEGIN result := dbms_debug.get_value(variable_name, frame#, value); END;

PROCEDURE ` + procGetRuntimeInfo + `(status OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info); status := run_info.terminated; END;

PROCEDURE ` + procSynchronize + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.synchronize(run_info, dbms_debug.info_getLineinfo); ` + runInfoMessage + ` END;

PROCEDURE ` + procGetLine + `(line OUT VARCHAR2, status OUT INTEGER) IS log VARCHAR2(32767) := ''; fetched VARCHAR2(32767); BEGIN <<label>> loop dbms_output.get_line(fetched, status); if status = 1 then exit label; else log := log || chr(10) || fetched; end if; end loop label; line := log; END;

-- V6.3 (real Oracle 19c EE verified): DBX_FETCH_OUTPUT added. After DEBUG_ON every
-- PL/SQL call in the debuggee session parks for the whole DBMS_DEBUG.SET_TIMEOUT
-- (measured: SET_TIMEOUT(5) -> the first post-DEBUG_ON statement answered after
-- 5070ms; SET_TIMEOUT(1) -> 1066ms; a plain SQL SELECT stayed at 25ms), so a
-- DBMS_OUTPUT drain split over several calls can never finish inside one RPC.
-- DBX_GET_LINE is kept unchanged for the Java agent; DBX_FETCH_OUTPUT is the
-- chunked, single-call drain the Go agent uses, and it is a FUNCTION so the
-- debuggee's own anonymous block can call it as its trailing statement -- while the
-- debugger still drives the program, which is the only moment such a call does not
-- park.
FUNCTION ` + procFetchOutput + `(max_chars IN BINARY_INTEGER) RETURN VARCHAR2 IS
  buffer VARCHAR2(32767) := NULL;
  fetched VARCHAR2(32767);
  status INTEGER;
  limit_chars PLS_INTEGER;
  ignored BINARY_INTEGER;
BEGIN
  limit_chars := max_chars;
  IF limit_chars IS NULL OR limit_chars <= 0 OR limit_chars > 32767 THEN limit_chars := 32767; END IF;
  -- Best effort, and deliberately an assignment: DBMS_DEBUG.SET_TIMEOUT is a
  -- FUNCTION on 19c EE ("CALL DBMS_DEBUG.SET_TIMEOUT(120)" answers PLS-00221), and
  -- this call is what turns the debuggee's own post-program park from the whole
  -- SET_TIMEOUT into one second for every later drain call. A server without the
  -- primitive keeps the long park and the Go-side bound, which is why the failure
  -- is swallowed.
  BEGIN ignored := dbms_debug.set_timeout(1); EXCEPTION WHEN OTHERS THEN NULL; END;
  <<dbx_drain>> LOOP
    IF ` + plDebugPackageName + `_PENDING_LINE IS NOT NULL THEN
      fetched := ` + plDebugPackageName + `_PENDING_LINE;
      ` + plDebugPackageName + `_PENDING_LINE := NULL;
    ELSE
      dbms_output.get_line(fetched, status);
      IF status <> 0 THEN EXIT dbx_drain; END IF;
    END IF;
    IF buffer IS NOT NULL AND LENGTH(buffer) + 1 + LENGTH(fetched) > limit_chars THEN
      ` + plDebugPackageName + `_PENDING_LINE := fetched;
      EXIT dbx_drain;
    END IF;
    IF buffer IS NULL THEN buffer := fetched; ELSE buffer := buffer || chr(10) || fetched; END IF;
  END LOOP dbx_drain;
  RETURN buffer;
END;

END ` + plDebugPackageName + `;`

// plDebugBreakpoint is one requested or created source breakpoint. Signature and
// Sequence are pointers on purpose: the session must be able to tell "the caller
// left the attribute out" (which triggers the overload warning) from "the caller
// sent an empty value" for an overloaded routine.
type plDebugBreakpoint struct {
	Owner         string  `json:"owner"`
	Name          string  `json:"name"`
	Line          int     `json:"line"`
	BreakpointNbr int     `json:"breakpointNumber"`
	Kind          string  `json:"kind"`
	Signature     *string `json:"signature,omitempty"`
	Sequence      *int    `json:"sequence,omitempty"`
	// Warning carries a non-fatal diagnostic (an overloaded target armed without
	// signature/sequence, or overload attributes the server cannot store). The
	// breakpoint is still created: a warning must never turn into a failure.
	Warning string `json:"warning,omitempty"`
}

// plDebugFrame is one entry of the call stack derived from DBMS_DEBUG's
// PRINT_BACKTRACE listing. The first frame is the current one, i.e. the deepest.
type plDebugFrame struct {
	StackDepth   int    `json:"stackDepth"`
	Line         int    `json:"line"`
	Program      string `json:"program"`
	ProgramOwner string `json:"programOwner"`
	// Source carries the text PRINT_BACKTRACE printed after "[Line N]" when that
	// text is the SOURCE line of the frame rather than a program name. Oracle 19c
	// EE prints the source line in that position ("[Line 2]   V_COUNT NUMBER := 0;"),
	// so publishing it as `program` would show source text where the stack panel
	// prints a routine name. Keeping it in its own field loses no information while
	// `program` stays reserved for an actual identifier (see plDebugIsProgramName).
	Source string `json:"source,omitempty"`
}

// plDebugProgramInfoFields records which optional DBMS_DEBUG.PROGRAM_INFO
// attributes this server actually declares. The helper package only emits the
// matching assignments, because a static reference to a field the record type
// does not have would leave the whole PACKAGE BODY INVALID.
//
// Both flags are expected to be false at run time: the runtime PROGRAM_INFO record
// has no field that distinguishes overloads. Oracle 21c XE declares exactly
// NAMESPACE/NAME/OWNER/DBLINK/LINE#/LIBUNITTYPE/ENTRYPOINTNAME (measured against
// ALL_PLSQL_TYPE_ATTRS), i.e. no signature and no sequence, so the
// signature/sequence passthrough can never take effect on such a server. The
// plumbing stays because other engines may extend the record, and because the
// downgrade warning below is the only thing that still tells the user why an
// overloaded target cannot be disambiguated.
//
// Entrypoint is a different case: ENTRYPOINTNAME *is* part of the standard record type
// (Oracle 19c EE and 21c XE declare it), and it is what makes a breakpoint on a
// subprogram inside a package body armable at all -- see procSetBreakpointEntry. The
// flag is still probed rather than assumed, so an engine whose record lacks the
// attribute keeps a body that compiles instead of one that fails with PLS-00302.
type plDebugProgramInfoFields struct {
	Signature  bool
	Sequence   bool
	Entrypoint bool
}

// plDebugParam is one bound routine parameter as sent by the desktop client.
// OUT parameters are bound as SQL OUT arguments by plDebugTargetRoutine and
// rewritten for the driver in use by plDebugDriverArgs before the debuggee
// executes the target block.
type plDebugParam struct {
	Name  string
	Mode  string
	Type  string
	Value string
}

type plDebugSession struct {
	mu                 sync.Mutex
	debugID            string
	owner              string
	debuggee           *sql.DB
	debugger           *sql.DB
	breakpoints        []plDebugBreakpoint
	terminated         bool
	closed             bool
	targetErr          string
	lastMessage        string
	lastBreakpoint     int
	lastStackDepth     int
	lastReason         int
	lastLine           int
	lastProgram        string
	lastProgramOwner   string
	lastActivityMillis int64
	// exceptionBreakpoint switches pl_debug_resume into exception mode; it is
	// deliberately ignored by the step operations.
	exceptionBreakpoint bool
	stoppedOnException  bool
	// programInfoFields is what the installed helper package can fill from the
	// caller's signature/sequence; anything unsupported is ignored and logged.
	programInfoFields plDebugProgramInfoFields
	// debugInfo notes a target whose PL/SQL debug information had to be restored
	// before it could be instrumented (see plDebugEnsureDebugInfo). It is empty for a
	// target that was already compiled with it, which is the normal case.
	debugInfo string
	// targetLines is the source-line range of a package-subprogram target inside its
	// package body, zero when the target is not a package subprogram or its source
	// could not be read (see plDebugFrameMatchesProgram).
	targetLines plDebugLineRange
	// nestedLines are the ranges of the subprograms declared inside the target's own
	// declaration section. Their bodies lie inside targetLines, so without them a frame
	// parked in a nested routine would be labelled with the enclosing routine's name
	// (see plDebugNestedRange).
	nestedLines []plDebugNestedRange
	// targetProgram / targetPackage remember the composed "PACKAGE.SUBPROGRAM"
	// label that pl_debug_start published. For a package subprogram the engine
	// reports only the PACKAGE name in run_info -- the subprogram lives in
	// program_info.entrypointname, which run_info does not carry -- so every later
	// line/breakpoint event has to be relabelled with this, or the stack panel
	// shows the package where the user expects the routine they are debugging.
	targetProgram string
	targetPackage string
	// oci selects the OUT bind type every helper-package call uses. The OCI
	// (godror) driver binds database/sql's sql.Out directly and sizes it, while
	// the built-in go-ora driver needs its own Out type carrying an explicit
	// buffer size and only recognises OUT binds on its Exec path.
	oci bool
	// callMu guards the timeout overrides and the abandoned-connection state
	// below. It is deliberately separate from mu: every guarded call site
	// (stepIntoRoutine, variables, fetchBacktrace, ...) already holds mu and
	// must not deadlock against the guard.
	callMu sync.Mutex
	// callTimeout / releaseTimeout override the package defaults while non-zero.
	// They exist so the timeout tests can drive the guard with a few milliseconds
	// instead of the real 30s bound.
	callTimeout    time.Duration
	releaseTimeout time.Duration
	// logWaitTimeout overrides plDebugLogParkTimeout for the bounded wait log() does
	// before it reads the debuggee's DBMS_OUTPUT; it exists for the same reason as the
	// two bounds above.
	logWaitTimeout time.Duration
	// debuggerBroken is set once a debugger-side DBMS_DEBUG call had to be
	// abandoned: the server never answered and the pool was closed to release
	// it, so no further PROBE call may be issued on this session.
	debuggerBroken   bool
	debuggerBrokenBy string
	// targetDone is closed when the runTarget goroutine has returned, i.e. when the
	// debuggee's single pooled connection is free again.
	//
	// Close has to wait for it before it closes the pools. database/sql's DB.Close
	// only closes *free* connections (lookup: DB.Close iterates db.freeConn) and a
	// connection an in-flight statement is still using is only closed when that
	// statement returns. A target left parked at close time therefore keeps its
	// server session alive -- measured on Oracle 19c EE: three rounds of
	// start/set-breakpoint/resume/abort/close left the agent process holding one more
	// TCP connection to the database after every round (1 -> 2 -> 3 -> 4), and the
	// matching server session stayed parked in "pipe get".
	targetDone chan struct{}
	// targetOnce makes the targetDone close idempotent, so a runTarget that returns
	// through several paths cannot close the channel twice.
	targetOnce sync.Once
	// logText is the debuggee's DBMS_OUTPUT as pl_debug_get_log returns it.
	// It starts as the text the target block captured for itself (see
	// plDebugAnonymousBlock) and is completed by drainDebuggeeOutput on the first
	// log request that still has lines to read.
	logText string
	// logComplete records that the debuggee's DBMS_OUTPUT buffer was drained to the
	// end, so a later pl_debug_get_log answers from logText without touching the
	// debuggee connection again: every PL/SQL call in that session would otherwise
	// park for the debuggee's SET_TIMEOUT (measured, see DBX_FETCH_OUTPUT).
	logComplete bool
}

// plDebugOpenConfigured opens a dedicated single-connection pool so
// DBMS_DEBUG state stays pinned to one physical session.
func plDebugOpenConfigured(s *server) (*sql.DB, error) {
	db, err := openConfiguredSessionDB(s.params, plDebugOpenTimeout)
	if err != nil {
		return nil, err
	}
	// One physical session per pool: DBMS_DEBUG binds breakpoints and the
	// interpreter state to the session, so pooling would corrupt debugging.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

// plDebugPrivilegeHint turns the opaque ORA-01031 that real Oracle raises from
// DBMS_DEBUG.INITIALIZE / DEBUG_ON / DEBUG_OFF into an actionable message. The
// error is raised inside SYS.PBSDE and names no privilege at all, so a caller
// cannot tell what to ask the DBA for:
//
//	ORA-01031: insufficient privileges
//	ORA-06512: at "SYS.PBSDE", line 82
//	ORA-06512: at "SYS.DBMS_DEBUG", line 279
//
// Oracle documents the requirement as "calls to DBMS_DEBUG succeed only if the
// caller carries the DEBUG CONNECT SESSION privilege".
func plDebugPrivilegeHint(err error) string {
	if err == nil || !strings.Contains(err.Error(), "ORA-01031") {
		return ""
	}
	return " (this session lacks DBMS_DEBUG privileges: as SYSDBA run" +
		" GRANT DEBUG CONNECT SESSION TO <user>; and, to debug objects the user" +
		" does not own, GRANT DEBUG ANY PROCEDURE TO <user>;)"
}

// plDebugProbe mirrors ODC's capability probe: both packages must be callable,
// and an "unknown routine" failure means the engine has no DBMS_DEBUG support.
func plDebugProbe(db *sql.DB) error {
	for _, probe := range []struct{ sql, feature string }{
		{"CALL DBMS_DEBUG.PING()", "DBMS_DEBUG"},
		{"CALL DBMS_OUTPUT.NEW_LINE()", "DBMS_OUTPUT"},
	} {
		if _, err := db.Exec(probe.sql); err != nil {
			if strings.Contains(err.Error(), "Unknown") {
				return fmt.Errorf("%s is not supported by this server: %w", probe.feature, err)
			}
			// Any other failure (for example a permission error) is reported by
			// the real call that follows, so the probe stays non-fatal.
		}
	}
	return nil
}

// plDebugObjectValid reports whether owner.name of the given type is present in
// ALL_SOURCE and reported VALID in ALL_OBJECTS -- the two checks ODC's
// PackageValidator performs before deciding to reinstall a package.
func plDebugObjectValid(db *sql.DB, owner, objectName, objectType string) (bool, error) {
	var sourceCount int
	if err := db.QueryRow(
		"SELECT COUNT(1) FROM ALL_SOURCE WHERE OWNER = :1 AND NAME = :2 AND TYPE = :3",
		owner, objectName, objectType,
	).Scan(&sourceCount); err != nil {
		return false, err
	}
	if sourceCount < 1 {
		return false, nil
	}
	var status string
	if err := db.QueryRow(
		"SELECT STATUS FROM ALL_OBJECTS WHERE OWNER = :1 AND OBJECT_NAME = :2 AND OBJECT_TYPE = :3",
		owner, objectName, objectType,
	).Scan(&status); err != nil {
		return false, err
	}
	return strings.EqualFold(strings.TrimSpace(status), "VALID"), nil
}

// plDebugPackageVersionCurrent reports whether the installed package body
// already carries plDebugVersionNote. The note is written on the same line as
// the package header (exactly as ODC writes it), so reading the first ALL_SOURCE
// line of the body is enough; the join mirrors ODC's query, with an explicit
// ORDER BY because ODC relies on the server's implicit ordering there.
// plDebugPackageVersionQuery reads the header line of the installed package BODY. The
// TYPE filter is not decoration: the RIGHT JOIN of ALL_OBJECTS against ALL_SOURCE with no
// filter keeps the ALL_SOURCE rows whose OBJECT_TYPE is not 'PACKAGE BODY' as NULL-side
// rows, so the *head's* line 1 ("PACKAGE DBX_PL_DEBUG_PACKAGE AS", which carries neither
// note) joins the result set -- and since ORDER BY S.LINE ties at line 1, the first row
// the query hands back is the head's. Measured on the real 19c EE target: the query
// answered the head's line 1 first out of 77 rows, so plDebugPackageVersionCurrent said
// "stale" for a body that carried both notes and *every* pl_debug_start re-issued CREATE
// OR REPLACE PACKAGE BODY. That rebuild is harmless while nothing else is using the
// package, but it is exactly the statement a still-parked debuggee pins: the start then
// spent its whole 30s DDL bound waiting on the library lock and failed with
// "create DBX_PL_DEBUG_PACKAGE body did not return within 30s", blaming the install for
// what was really a concurrent session. Reading only the body's rows removes the false
// rebuild and with it that failure mode.
const plDebugPackageVersionQuery = `SELECT S.TEXT
		   FROM (SELECT * FROM ALL_OBJECTS WHERE OBJECT_TYPE = 'PACKAGE BODY') O
		   RIGHT JOIN ALL_SOURCE S
		     ON S.NAME = O.OBJECT_NAME AND S.OWNER = O.OWNER AND S.TYPE = O.OBJECT_TYPE
		  WHERE S.OWNER = :1 AND S.NAME = :2 AND S.TYPE = 'PACKAGE BODY'
		  ORDER BY S.LINE`

func plDebugPackageVersionCurrent(db *sql.DB, owner string) (bool, error) {
	var text sql.NullString
	err := db.QueryRow(plDebugPackageVersionQuery, owner, plDebugPackageName).Scan(&text)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// Both markers live on the header line, so reading that one line is still enough:
	// plDebugVersionNote keeps the shared V6 identity with the Java agent, and
	// plDebugBodyFixNote is what forces a body installed before the namespace /
	// run_info-mask fixes to be replaced.
	return text.Valid &&
		strings.Contains(text.String, plDebugVersionNote) &&
		strings.Contains(text.String, plDebugBodyFixNote), nil
}

// plDebugHeadRequiredRoutines are the helper-package routines an installed head
// must declare for the body -- and the start sequence -- to be usable. A head
// missing any of them is replaced, which in turn invalidates the body so it is
// rebuilt as well.
var plDebugHeadRequiredRoutines = []string{
	procSetValue,
	procSetBreakpointEx,
	// The package-subprogram arm: a head installed before it declares no
	// DBX_SET_BREAKPOINT_ENTRY, and the body that calls it would fail with
	// PLS-00302 (component must be declared), so the head is replaced with it.
	procSetBreakpointEntry,
	// The start sequence (DebuggerSession.debugBefore equivalent) needs the
	// anonymous-block breakpoint variant and the debuggee synchronize call.
	procSetBreakpointAnonymous,
	procSynchronize,
	// Breakpoint enable/disable, served by the two dynamic wrappers.
	procEnableBreakpoint,
	procDisableBreakpoint,
	// The V6.3 one-call DBMS_OUTPUT drain. A head installed before it declares no
	// DBX_FETCH_OUTPUT, and the target block the debuggee executes calls it, so the
	// head is replaced with it (and with it the body).
	procFetchOutput,
}

// plDebugHeadRequiredDeclarations pin down the *signature* of the routines whose
// parameter list changed, because a routine-name-only check would happily keep an
// installed V5 head that declares
// DBX_SET_VALUE(name, frame#, index#, value) and then compile the new body -- which
// declares DBX_SET_VALUE(frame#, assignment_statement, result, message) -- against
// it. PL/SQL rejects that mismatch with PLS-00306 and leaves the PACKAGE BODY
// INVALID, which is exactly the failure class the routine check exists to prevent.
// Every entry is a substring of the head DDL rendered by plDebugPackageHeadDDL and
// is matched case-insensitively against ALL_SOURCE.
var plDebugHeadRequiredDeclarations = []string{
	procSetValue + "(frame# IN BINARY_INTEGER, assignment_statement IN VARCHAR2",
	procEnableBreakpoint + "(breakpoint# IN BINARY_INTEGER",
	procDisableBreakpoint + "(breakpoint# IN BINARY_INTEGER",
	// The V6.3 drain is a FUNCTION; a head that declared it as a procedure (or not
	// at all) would leave the target block uncompilable and every debuggee call
	// would fail with PLS-00221/PLS-00302.
	"FUNCTION " + procFetchOutput + "(max_chars IN BINARY_INTEGER) RETURN VARCHAR2",
}

// plDebugHeadRequirements is everything an installed head has to declare: the
// routine names the body calls plus the exact signatures that must not drift.
// It is a copy, so appending to one of the lists above cannot mutate this one.
var plDebugHeadRequirements = append(
	append([]string{}, plDebugHeadRequiredRoutines...),
	plDebugHeadRequiredDeclarations...,
)

// plDebugHeadDeclares reports whether the installed PACKAGE head already declares
// every required entry of plDebugHeadRequirements. Entries are matched as
// case-insensitive substrings of ALL_SOURCE, so an entry can be either a routine
// name or the beginning of a declaration (which also pins its parameter list: see
// plDebugHeadRequiredDeclarations). A head left behind by an older agent version
// (or installed by the Java agent, whose DDL predates DBX_SET_VALUE) lacks the new
// declarations, and replacing only the body would compile it to INVALID
// (PLS-00302: component must be declared, or PLS-00306 for a changed signature),
// taking every debug operation down.
func plDebugHeadDeclares(db *sql.DB, owner string, routines []string) (bool, error) {
	rows, err := db.Query(
		"SELECT TEXT FROM ALL_SOURCE WHERE OWNER = :1 AND NAME = :2 AND TYPE = 'PACKAGE' ORDER BY LINE",
		owner, plDebugPackageName,
	)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	var source strings.Builder
	for rows.Next() {
		var text sql.NullString
		if err := rows.Scan(&text); err != nil {
			return false, err
		}
		source.WriteString(text.String)
		source.WriteString("\n")
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	declared := strings.ToUpper(source.String())
	for _, routine := range routines {
		if !strings.Contains(declared, strings.ToUpper(routine)) {
			return false, nil
		}
	}
	return true, nil
}

// plDebugProbeProgramInfoField reports whether DBMS_DEBUG.PROGRAM_INFO declares
// the given attribute. The probe is a dynamically executed block that assigns the
// field and catches everything: a missing field raises PLS-00302 at run time,
// which WHEN OTHERS absorbs, so nothing here can ever leave the helper package
// INVALID (a static reference in the DDL would).
//
// On a real server the probe is EXPECTED to answer "no". Oracle 21c XE's
// PROGRAM_INFO record has exactly NAMESPACE/NAME/OWNER/DBLINK/LINE#/LIBUNITTYPE/
// ENTRYPOINTNAME (verified against ALL_PLSQL_TYPE_ATTRS), i.e. no signature and no
// sequence field at all -- the record ProgramInfoField probe fails structurally,
// not because the probe is wrong. It is kept because some engines (OceanBase
// Oracle mode among them) may extend the record, and because the overload warning
// below still has to fire when the attributes are unavailable.
func plDebugProbeProgramInfoField(db *sql.DB, oci bool, field, literal string) bool {
	switch field {
	case "signature", "sequence", "entrypointname":
	default:
		return false
	}
	probe := fmt.Sprintf(
		`BEGIN EXECUTE IMMEDIATE 'DECLARE p dbms_debug.program_info; BEGIN p.%s := %s; END;'; :1 := 1; EXCEPTION WHEN OTHERS THEN :1 := 0; END;`,
		field, literal,
	)
	var supported int
	if _, err := db.Exec(probe, plDebugOutArgs(oci, &supported)...); err != nil {
		// Also an expected result on a server that declares neither attribute; the
		// caller only downgrades the overload warning, it never fails a start.
		plDebugLogf("probing dbms_debug.program_info.%s failed: %v", field, err)
		return false
	}
	return supported == 1
}

// plDebugProbeProgramInfoFields discovers the optional overload attributes of the
// server's DBMS_DEBUG.PROGRAM_INFO record. Both flags are expected to be false on
// stock Oracle (21c XE verified: the record type carries no signature/sequence
// attribute), which is why plDebugOverloadWarningForTarget keeps warning about
// overloads the server cannot disambiguate.
func plDebugProbeProgramInfoFields(db *sql.DB, oci bool) plDebugProgramInfoFields {
	return plDebugProgramInfoFields{
		Signature:  plDebugProbeProgramInfoField(db, oci, "signature", "''DBX''"),
		Sequence:   plDebugProbeProgramInfoField(db, oci, "sequence", "1"),
		Entrypoint: plDebugProbeProgramInfoField(db, oci, "entrypointname", "''DBX''"),
	}
}

// plDebugPackageBody renders the helper package body, filling the overload
// attribute assignments only for the fields the server actually supports, and
// only when the caller supplied a value (NULL signature / negative sequence means
// "leave the attribute alone"). The markers are always consumed, so an executed DDL
// statement never carries one.
func plDebugPackageBody(owner string, fields plDebugProgramInfoFields) string {
	extra := ""
	if fields.Signature {
		extra += " if signature is not null then pro_info.signature := signature; end if;"
	}
	if fields.Sequence {
		extra += " if sequence# >= 0 then pro_info.sequence := sequence#; end if;"
	}
	entry := ""
	if fields.Entrypoint {
		entry = "if entrypointname is not null then pro_info.entrypointname := entrypointname; end if;"
	}
	body := strings.Replace(fmt.Sprintf(plDebugPackageBodyDDL, owner), plDebugProgramInfoExtraMarker, extra, 1)
	return strings.Replace(body, plDebugProgramInfoEntryMarker, entry, 1)
}

// plDebugEnsureHelperPackage installs the helper package only when it is missing,
// invalid, or older than plDebugVersionNote. Rebuilding unconditionally (as this
// agent used to) would replace a package another tool may be sharing and would
// recompile the DDL on every single debug start.
//
// It returns the overload attributes the installed package can store.
func plDebugEnsureHelperPackage(db *sql.DB, owner string, oci bool) (plDebugProgramInfoFields, error) {
	// Both DDL templates already wrap the schema placeholder in double quotes
	// ("%[1]s"), so the BARE owner has to be substituted here. Re-quoting it
	// renders ""OWNER"" and real Oracle rejects the statement with
	// ORA-01741 (illegal zero-length identifier) before anything is created.
	schemaIdent := owner
	fields := plDebugProbeProgramInfoFields(db, oci)

	headValid, err := plDebugObjectValid(db, owner, plDebugPackageName, "PACKAGE")
	if err != nil {
		return fields, fmt.Errorf("inspect %s header failed: %w", plDebugPackageName, err)
	}
	if headValid {
		// A head that predates DBX_SET_VALUE / DBX_SET_BREAKPOINT_EX, one that
		// never declared the routines the start sequence now needs
		// (DBX_SYNCHRONIZE, DBX_SET_BREAKPOINT_ANONYMOUS) or the breakpoint
		// enable/disable wrappers, or one whose DBX_SET_VALUE still has the old
		// four-argument parameter list, has to be replaced before the new body is
		// installed: a stale head either fails the body with PLS-00302 (missing
		// routine) or with PLS-00306 (changed signature).
		headCurrent, declareErr := plDebugHeadDeclares(db, owner, plDebugHeadRequirements)
		if declareErr != nil {
			return fields, fmt.Errorf("inspect %s header declarations failed: %w", plDebugPackageName, declareErr)
		}
		headValid = headCurrent
	}
	if !headValid {
		if err := plDebugBoundedRun(db, "create "+plDebugPackageName+" head", plDebugCallTimeout, func() error {
			_, err := db.Exec(fmt.Sprintf(plDebugPackageHeadDDL, schemaIdent))
			return err
		}); err != nil {
			return fields, fmt.Errorf("create %s head failed: %w", plDebugPackageName, err)
		}
	}

	bodyValid, err := plDebugObjectValid(db, owner, plDebugPackageName, "PACKAGE BODY")
	if err != nil {
		return fields, fmt.Errorf("inspect %s body failed: %w", plDebugPackageName, err)
	}
	versionCurrent := false
	if bodyValid {
		versionCurrent, err = plDebugPackageVersionCurrent(db, owner)
		if err != nil {
			return fields, fmt.Errorf("inspect %s body version failed: %w", plDebugPackageName, err)
		}
	}
	if !bodyValid || !versionCurrent {
		// The head and the body must come from the same build, so the head is replaced
		// in the same step as the body. Installing the body alone is exactly what lets a
		// mismatched pair appear: the head check asks whether the installed head declares
		// the routines this build needs, and an older agent's list is a subset of a newer
		// head, so that check passes and the older body lands against the newer head with
		// its extra declaration unimplemented -- PLS-00323, an INVALID body, and every
		// debug start on the schema fails. Replacing the head first also makes this the
		// self-healing path for a pair some older agent already broke.
		if err := plDebugBoundedRun(db, "create "+plDebugPackageName+" head+body", plDebugCallTimeout, func() error {
			if _, err := db.Exec(fmt.Sprintf(plDebugPackageHeadDDL, schemaIdent)); err != nil {
				return err
			}
			_, err := db.Exec(plDebugPackageBody(schemaIdent, fields))
			return err
		}); err != nil {
			return fields, fmt.Errorf("create %s head+body failed: %w", plDebugPackageName, err)
		}
	}
	return fields, nil
}

// plDebugPlsqlDebugEnabled reads the PLSQL_DEBUG compile setting of one dictionary
// object. found is false when the server has no row for it (a package subprogram, an
// object the view does not cover, a server without the view at all -- the caller treats
// that as "cannot tell" and leaves the target alone).
func plDebugPlsqlDebugEnabled(db *sql.DB, owner, name, objectType string) (enabled bool, found bool, err error) {
	var setting string
	err = db.QueryRow(
		`SELECT PLSQL_DEBUG FROM ALL_PLSQL_OBJECT_SETTINGS
		  WHERE OWNER = :1 AND NAME = :2 AND TYPE = :3`,
		owner, name, objectType,
	).Scan(&setting)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	return strings.EqualFold(strings.TrimSpace(setting), "TRUE"), true, nil
}

// plDebugDebugObject maps a start request onto the dictionary object whose PLSQL_DEBUG
// setting decides whether DBMS_DEBUG can instrument the target at all: the procedure or
// function itself, or the *package* a package subprogram lives in (subprograms have no
// row of their own in ALL_PLSQL_OBJECT_SETTINGS). An ANONYMOUS target is compiled inside
// the debuggee session and has nothing to look up, so ok is false for it.
func plDebugDebugObject(request map[string]interface{}) (name, objectType string, ok bool) {
	objectType = strings.ToUpper(strings.TrimSpace(stringField(request, "objectType")))
	packageName := strings.ToUpper(strings.TrimSpace(stringField(request, "packageName")))
	objectName := strings.ToUpper(strings.TrimSpace(stringField(request, "objectName")))
	switch objectType {
	case "PROCEDURE", "FUNCTION":
	default:
		return "", "", false
	}
	name = objectName
	if packageName != "" {
		name, objectType = packageName, "PACKAGE"
	} else if dot := strings.IndexByte(objectName, '.'); dot > 0 {
		// Some callers qualify the subprogram inside objectName instead of using
		// packageName ("PKG.PROC"); the breakpoint side splits it the same way.
		name, objectType = objectName[:dot], "PACKAGE"
	}
	if !plDebugPlainIdentifier(name) {
		return "", "", false
	}
	return name, objectType, true
}

// plDebugPlainIdentifier reports whether every byte of an identifier is one Oracle
// accepts unquoted. The ALTER below interpolates the name (a DDL cannot bind it), so the
// check keeps anything that is not a plain identifier out of the statement text.
func plDebugPlainIdentifier(name string) bool {
	if name == "" {
		return false
	}
	for index := 0; index < len(name); index++ {
		if !plDebugIdentifierByte(name[index]) {
			return false
		}
	}
	return true
}

// plDebugEnsureDebugInfo makes sure the program unit that is about to be debugged carries
// the PL/SQL debug information DBMS_DEBUG needs, and returns a note when it had to
// restore it.
//
// Measured on the real 19c EE target (DBX_DEBUG, 2026-10-09), with everything else held
// constant -- same object, same body, same start sequence, the only difference being the
// unit's compile setting:
//
//	PLSQL_DEBUG=FALSE, instant procedure   CONTINUE(break_any_call) -> reason = 25
//	                                       (reason_knl_exit), no program name, the target
//	                                       ran to completion: the debuggee never stopped
//	                                       anywhere and pl_debug_start reported "the
//	                                       debuggee finished before <X> was reached"
//	PLSQL_DEBUG=TRUE,  same body           CONTINUE(break_any_call) -> reason = 6
//	                                       (reason_enter), stackdepth 2, program = the
//	                                       target -- the debugger is parked on the
//	                                       routine's first line before it runs
//
// The setting is what separates DBX_V1_PROC (compiled with debug information, always
// steppable) from every DBX_T_* target, and it is independent of how long the target
// runs: a *looping* procedure compiled with PLSQL_DEBUG=FALSE fails exactly like an
// instantaneous one, and an instantaneous one compiled with it succeeds. That refutes the
// earlier "fast procedures necessarily finish before the debugger is ready" reading of
// the failure: the subset of instant targets used to reproduce it had all been created in
// a session with PLSQL_DEBUG=FALSE, which is the Oracle default, while the loop target it
// was compared against had debug information.
//
// A unit compiled without debug information cannot be instrumented at all: Probe answers
// `error_no_debug_info (2) -- entrypoint has no debug information` for the line map
// (dbms_debug.sql), and even an explicitly armed breakpoint is accepted with result 0 and
// then never hit. Restoring the information is therefore the only way to debug such a
// unit, and `ALTER <type> <owner>.<name> COMPILE DEBUG` is Oracle's supported way to ask
// for it (`COMPILE DEBUG` is the documented equivalent of the PLSQL_DEBUG=TRUE the
// compiling session did not have). The statement is bounded like every other DDL of the
// start sequence, and its outcome is verified instead of trusted.
//
// When the setting cannot be read at all the target is left untouched: the probe is a
// repair, not a precondition, and a server whose dictionary hides it must keep working.
func plDebugEnsureDebugInfo(db *sql.DB, owner string, request map[string]interface{}) (string, error) {
	name, objectType, ok := plDebugDebugObject(request)
	if !ok {
		return "", nil
	}
	enabled, found, err := plDebugPlsqlDebugEnabled(db, owner, name, objectType)
	if err != nil {
		plDebugLogf("PLSQL_DEBUG probe for %s.%s failed (target left alone): %v", owner, name, err)
		return "", nil
	}
	if !found || enabled {
		return "", nil
	}
	qualified := fmt.Sprintf(`"%s"."%s"`, owner, name)
	statement := fmt.Sprintf("ALTER %s %s COMPILE DEBUG", objectType, qualified)
	if err := plDebugBoundedRun(db, statement, plDebugCallTimeout, func() error {
		_, execErr := db.Exec(statement)
		return execErr
	}); err != nil {
		return "", fmt.Errorf("the target %s was compiled without PL/SQL debug information "+
			"(PLSQL_DEBUG is FALSE), so DBMS_DEBUG could never stop inside it, and restoring it "+
			"with %q failed: %w", qualified, statement, err)
	}
	enabled, found, verifyErr := plDebugPlsqlDebugEnabled(db, owner, name, objectType)
	if verifyErr != nil || (found && !enabled) {
		return "", fmt.Errorf("the target %s still reports no PL/SQL debug information after %q; "+
			"DBMS_DEBUG cannot stop inside a unit compiled with PLSQL_DEBUG=FALSE", qualified, statement)
	}
	note := fmt.Sprintf("restored the target's PL/SQL debug information with %q "+
		"(it had been compiled with PLSQL_DEBUG=FALSE, which makes a unit impossible to "+
		"instrument: DBMS_DEBUG.CONTINUE reports reason_knl_exit instead of entering it)", statement)
	plDebugLogf("%s", note)
	return note, nil
}

// plDebugDebugInfoHint is appended to the "the debuggee finished before <X> was reached"
// failure. That message used to be the whole story of a unit DBMS_DEBUG cannot instrument,
// which reads like a timing problem and sent a real investigation after a race that does
// not exist; naming the compile setting makes the actual cause visible when the repair
// above could not run.
const plDebugDebugInfoHint = "; the target may have been compiled without PL/SQL debug information " +
	"(PLSQL_DEBUG), which makes DBMS_DEBUG unable to stop inside it"

// plDebugStart runs the full start sequence on the given connections and
// returns the session handle. The caller owns both connections afterwards
// (the session closes them on Close).
//
// The order mirrors ODC's DebuggerSession.start and is what leaves the session
// with a current line instead of the zero state:
//
//	install the helper package (bounded as a whole)
//	restore the target's PL/SQL debug information when it has none
//	debuggee: INITIALIZE -> SET_TIMEOUT_BEHAVIOUR -> SET_TIMEOUT -> DBMS_OUTPUT.ENABLE
//	          -> DEBUG_ON -> run target
//	debugger: ATTACH_SESSION -> SYNCHRONIZE (fatal) -> CONTINUE(break_any_call) until
//	          the target routine is the current frame
//
// The target has to be submitted *before* the attach: only a debuggee that has been
// parked by DEBUG_ON can accept an attachment at all.
//
// The step-in route replaced ODC's anonymous-block breakpoint at the start because that
// breakpoint cannot be armed on real Oracle 19c EE; see debugBefore for the measurements.
func plDebugStart(s *server, debuggee, debugger *sql.DB, request map[string]interface{}) (*plDebugSession, error) {
	owner := strings.ToUpper(strings.TrimSpace(stringField(request, "schema")))
	if owner == "" {
		if err := debuggee.QueryRow("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL").Scan(&owner); err != nil {
			return nil, err
		}
		owner = strings.ToUpper(strings.TrimSpace(owner))
	}
	// The install is bounded as a whole, not only per statement. Replacing the helper
	// package is the one step of the start sequence that talks to objects another
	// session may be *executing*: while a parked debuggee holds DBX_PL_DEBUG_PACKAGE's
	// execution pin, CREATE OR REPLACE PACKAGE BODY does not return and does not fail --
	// measured on Oracle 19c EE against a shared test schema, 40s and still waiting, with
	// no server-side error and nothing on stderr. Without this bound pl_debug_start hung
	// the whole RPC there, before the debuggee was even initialised.
	var programInfoFields plDebugProgramInfoFields
	if err := plDebugBoundedRun(debuggee, "install "+plDebugPackageName, plDebugHelperInstallTimeout, func() error {
		fields, installErr := plDebugEnsureHelperPackage(debuggee, owner, usesOCIProfile(s.params))
		programInfoFields = fields
		return installErr
	}); err != nil {
		return nil, err
	}

	session := &plDebugSession{
		owner:              owner,
		debuggee:           debuggee,
		debugger:           debugger,
		programInfoFields:  programInfoFields,
		oci:                usesOCIProfile(s.params),
		lastActivityMillis: nowMillis(),
		targetDone:         make(chan struct{}),
	}

	// A target compiled without PL/SQL debug information can never be entered, whatever
	// the start sequence does: restore it before anything is parked (see
	// plDebugEnsureDebugInfo for the measurement that pinned this down).
	debugInfo, err := plDebugEnsureDebugInfo(debuggee, owner, request)
	if err != nil {
		return nil, fmt.Errorf("debug start failed: %w", err)
	}
	session.debugInfo = debugInfo

	// A package subprogram is reported as its PACKAGE, so the start sequence needs the
	// subprogram's own line range to know which subprogram of that body it is looking
	// at (see plDebugFrameMatchesProgram). Read here, before debug mode is on: after
	// DEBUG_ON every PL/SQL call in the debuggee session parks, and even a SQL call to a
	// PL/SQL function counts as PL/SQL (measured -- "SELECT DBMS_DEBUG.SET_TIMEOUT(120)
	// FROM DUAL" never returned once DEBUG_ON had run). This particular statement is a
	// plain dictionary SELECT either way.
	targetLines, nestedLines, targetLinesNote := plDebugResolveTargetLines(debuggee, owner, request)
	session.targetLines = targetLines
	session.nestedLines = nestedLines
	// A range the scan could not read or close is a degradation the caller has to see:
	// it is what decides whether the current routine label may name the subprogram at
	// all (see currentProgramLabel), so it is published next to any debug-information
	// note already collected.
	if targetLinesNote != "" {
		session.noteDebugInfo(targetLinesNote)
	}

	var debugID string
	// The debuggee-side start calls are bounded too: they run before anything is
	// parked, but a handler must return in finite time whatever the server does.
	if err := plDebugBoundedRun(debuggee, "DBMS_DEBUG.INITIALIZE", plDebugCallTimeout, func() error {
		return debuggee.QueryRow("SELECT DBMS_DEBUG.INITIALIZE() FROM DUAL").Scan(&debugID)
	}); err != nil {
		return nil, fmt.Errorf("DBMS_DEBUG.INITIALIZE failed: %w%s", err, plDebugPrivilegeHint(err))
	}
	session.debugID = strings.TrimSpace(debugID)

	if err := plDebugBoundedRun(debuggee, "DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR", plDebugCallTimeout, func() error {
		_, err := debuggee.Exec("CALL DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR(2)")
		return err
	}); err != nil {
		return nil, fmt.Errorf("DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR failed: %w", err)
	}
	// DBMS_DEBUG.SET_TIMEOUT bounds how long the parked debuggee waits for the
	// debugger before SET_TIMEOUT_BEHAVIOUR(2) turns debugging off. ODC sets it
	// (DebuggeeSession :68) and this agent did not, which is why a debug session the
	// agent walked away from stayed parked for the package default instead of two
	// minutes. It has to be selected, not called: on 19c EE
	// "CALL DBMS_DEBUG.SET_TIMEOUT(120)" raises PLS-00221 ("not a procedure").
	//
	// Best-effort like ODC's: a server that does not implement the primitive is
	// logged and stepped over, because losing the server-side timeout is a
	// degradation, not a reason to refuse the whole debug session.
	if err := plDebugBoundedRun(debuggee, "DBMS_DEBUG.SET_TIMEOUT", plDebugCallTimeout, func() error {
		var serverTimeout int
		return debuggee.QueryRow(fmt.Sprintf("SELECT DBMS_DEBUG.SET_TIMEOUT(%d) FROM DUAL",
			plDebugServerTimeoutSeconds)).Scan(&serverTimeout)
	}); err != nil {
		plDebugLogf("DBMS_DEBUG.SET_TIMEOUT(%d) failed (ignored): %v", plDebugServerTimeoutSeconds, err)
	}
	if err := plDebugBoundedRun(debuggee, "DBMS_OUTPUT.ENABLE", plDebugCallTimeout, func() error {
		_, err := debuggee.Exec("BEGIN DBMS_OUTPUT.ENABLE(NULL); END;")
		return err
	}); err != nil {
		return nil, fmt.Errorf("DBMS_OUTPUT.ENABLE failed: %w", err)
	}
	if err := plDebugBoundedRun(debuggee, "DBMS_DEBUG.DEBUG_ON", plDebugCallTimeout, func() error {
		_, err := debuggee.Exec("CALL DBMS_DEBUG.DEBUG_ON()")
		return err
	}); err != nil {
		return nil, fmt.Errorf("DBMS_DEBUG.DEBUG_ON failed: %w%s", err, plDebugPrivilegeHint(err))
	}

	// Submit the target first: DBMS_DEBUG parks the debuggee on the first line of
	// the anonymous block, which is what makes the block visible to the debugger
	// below. It blocks until the debugger drives the program to completion, so it
	// runs on its own goroutine.
	go session.runTarget(request)

	if err := session.attachDebugger(); err != nil {
		_ = session.Close()
		return nil, err
	}
	// Synchronize with the debuggee. This is the handshake every later CONTINUE
	// depends on -- without it CONTINUE answers no result at all and nothing can be
	// stopped -- so a failure is fatal rather than logged (see synchronizeDebuggee).
	if err := session.synchronizeDebuggee(); err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("debug start failed: %w", err)
	}
	// debugBefore: stop inside the target routine so start returns a filled
	// snapshot. Anonymous-block targets carry their own breakpoints and are left
	// to the caller.
	if err := session.debugBefore(request); err != nil {
		_ = session.Close()
		return nil, err
	}
	return session, nil
}

// attachDebugger attaches the debugger session to the parked debuggee, retrying
// the startup race (the target goroutine may not have reached its first line yet)
// a bounded number of times. Every attempt is guarded: a PROBE call on a session
// that has already lost its debuggee blocks forever, and the guard keeps the
// retry loop from multiplying one timeout by plDebugAttachAttempts.
func (p *plDebugSession) attachDebugger() error {
	var lastErr error
	for attempt := 0; attempt < plDebugAttachAttempts; attempt++ {
		err := p.plDebugDebuggerExec("DBMS_DEBUG.ATTACH_SESSION",
			fmt.Sprintf("CALL DBMS_DEBUG.ATTACH_SESSION('%s')", p.debugID),
			p.debugCallTimeout())
		if err != nil {
			lastErr = err
			if p.debuggerFailure() != nil {
				return fmt.Errorf("DBMS_DEBUG.ATTACH_SESSION failed: %w", err)
			}
			time.Sleep(plDebugAttachDelay)
			continue
		}
		p.mu.Lock()
		p.touch()
		p.mu.Unlock()
		return nil
	}
	return fmt.Errorf("DBMS_DEBUG.ATTACH_SESSION failed: %w", lastErr)
}

// synchronizeDebuggee calls DBX_SYNCHRONIZE, the package procedure ODC wraps
// dbms_debug.synchronize in (DebuggerSession.synchronize, :227-247). It is the
// handshake that consumes the debuggee's start event, and on real Oracle it is
// mandatory rather than the optional capability this used to treat it as: the old note
// claiming "stock Oracle has no dbms_debug.synchronize" is simply wrong --
// DBMS_DEBUG.SYNCHRONIZE is in the documented 19c spec and the server answers it.
//
// Measured on Oracle 19c EE with the debuggee parked on reason_interpreter_starting,
// against DBX_DEBUG.DBX_V1_PROC:
//
//	SYNCHRONIZE(run_info, NULL)      -> 0, reason = 2 (reason_interpreter_starting)
//	then CONTINUE(run_info, 12, 8)   -> 0, reason = 6 (reason_enter), program = DBX_V1_PROC
//
// and with the handshake skipped:
//
//	CONTINUE(run_info, 12, 8)        -> NULL result, run_info left empty, nothing parked
//	GET_VALUE('V_COUNT', 0)          -> error_exception (28)
//
// A failed synchronize therefore means no later CONTINUE can stop anything, and going on
// anyway only manufactures "Probe is broken" symptoms. It is reported as fatal, exactly
// like a failed arming was.
//
// It is called exactly once and deliberately never retried: a second SYNCHRONIZE on a
// debugger whose start event has already been consumed does not return at all (measured:
// no answer within 25s, after which the guard drops the connection). The call itself is
// already bounded by plDebugCall's guard, so a server that never answers is released
// instead of wedging the RPC.
func (p *plDebugSession) synchronizeDebuggee() error {
	var result int
	var message string
	if err := p.plDebugCall(procSynchronize, nil, &result, &message); err != nil {
		return fmt.Errorf("DBX_SYNCHRONIZE failed: %w", err)
	}
	if result != plDebugErrSuccess {
		// error_timeout (31) is SYNCHRONIZE's documented "timed out before the
		// program started execution", i.e. the debuggee never reached its start
		// event at all -- a different fault from a server that refused the call,
		// and worth naming.
		hint := ""
		if result == plDebugErrTimeout {
			hint = "; the debuggee never started the submitted target"
		}
		return fmt.Errorf("DBX_SYNCHRONIZE returned %s (%d)%s: the debuggee never signalled the start event that "+
			"every later DBMS_DEBUG.CONTINUE depends on, so no breakpoint could be reached",
			plDebugResultName(result), result, hint)
	}
	p.mu.Lock()
	p.touch()
	p.mu.Unlock()
	return nil
}

// stepIntoRoutine steps the parked debuggee into target, one
// DBMS_DEBUG.CONTINUE(break_any_call) at a time, and stops as soon as the current frame
// names it.
//
// This replaces the anonymous-block breakpoint plus resume plus depth-based step-in that
// debugBefore used to run. On Oracle 19c EE the debuggee is parked on
// reason_interpreter_starting when this starts -- the debugger is synchronised but no
// program has been entered yet -- and there the run_info register of DBX_CNT_STEP_IN
// (filled once the wrapper asks for the run_info mask explicitly) is the only reliable
// "where am I" signal. A depth comparison cannot distinguish the routine from the
// anonymous block that calls it, so the frame's program name is used instead.
//
// The bound mirrors ODC's stepInForStartingDebug, which also gives up after
// plDebugStartStepInLimit tries rather than stepping forever, except for a package
// subprogram: the interpreter reports that frame as the package and walks the package's
// initialization section first, so it needs a larger budget (plDebugPackageStepInLimit).
// A server that reports no program name at all falls back to ODC's own stack-depth
// criterion through stepInUntilDeeper, which is the behaviour this routine replaced.
func (p *plDebugSession) stepIntoRoutine(target plDebugTarget) error {
	program := target.Program
	limit := plDebugStartStepInLimit
	if target.Package != "" {
		limit = plDebugPackageStepInLimit
	}
	startDepth := 0
	sawProgramName := false
	lastFrame := ""
	for attempt := 0; attempt <= limit; attempt++ {
		p.mu.Lock()
		terminated := p.terminated
		targetErr := p.targetErr
		lastFrame = p.lastProgram
		lines := p.targetLines
		line := p.lastLine
		if attempt == 0 {
			startDepth = p.lastStackDepth
		}
		p.mu.Unlock()

		if terminated {
			if targetErr != "" {
				return errors.New(targetErr)
			}
			return fmt.Errorf("the debuggee finished before %s was reached%s", program, plDebugDebugInfoHint)
		}
		if plDebugProgramKey(lastFrame) != "" {
			sawProgramName = true
			if plDebugFrameMatchesProgram(lastFrame, line, target, lines) {
				return nil
			}
		}
		if attempt == limit {
			break
		}
		if _, err := p.stepIn(); err != nil {
			return err
		}
	}
	if !sawProgramName && p.stepInUntilDeeper(startDepth) == nil {
		return nil
	}
	// Last resort for a package subprogram: the frame either names the subprogram itself
	// (an engine that reports it directly, in which case there is nothing left to
	// confirm) or the package the target lives in -- so the debugger is demonstrably
	// inside that package body and only the subprogram's own source range could not be
	// confirmed (an unreadable ALL_SOURCE, a range the scan could not close, or an
	// initialization section longer than the step-in budget). Entering the package's
	// initialization section is a degradation the user is told about in the response;
	// refusing to start at all is not recoverable, and breakpoints still work from there.
	if plDebugFrameMatchesTarget(lastFrame, program) ||
		(target.Package != "" && plDebugProgramKey(lastFrame) == plDebugProgramKey(target.Package)) {
		note := fmt.Sprintf("the session started on the frame %q after %d step-in attempts without confirming "+
			"the source range of %s: the reported line may belong to the package's initialization section "+
			"rather than to the subprogram", lastFrame, limit, program)
		plDebugLogf("%s", note)
		p.noteDebugInfo(note)
		return nil
	}
	return fmt.Errorf("the interpreter never entered %s after %d step-in attempts (last frame: %q)",
		program, limit, lastFrame)
}

// plDebugProgramKey normalizes a frame's program name for comparison with the start
// target: upper case, trimmed, and reduced to its last dotted component. The reduction is
// what lets "DBX_DEBUG.DBX_V1_PROC" (what DBMS_DEBUG reports in run_info.program.name,
// owner included) match the "DBX_V1_PROC" the target renders, and it covers the package
// case the same way ("PKG.F_ADD" against "F_ADD").
func plDebugProgramKey(program string) string {
	key := strings.ToUpper(strings.TrimSpace(program))
	if dot := strings.LastIndexByte(key, '.'); dot >= 0 {
		key = strings.TrimSpace(key[dot+1:])
	}
	return key
}

// plDebugFrameMatchesTarget reports whether the frame's program name is the start target.
// An empty target never matches anything, so a session whose routine could not be
// resolved does not silently accept the first frame it is offered.
func plDebugFrameMatchesTarget(frame, target string) bool {
	key := plDebugProgramKey(target)
	return key != "" && plDebugProgramKey(frame) == key
}

// noteDebugInfo appends one explanation to the note pl_debug_start returns as its
// debugInfo field. It is how a degradation reaches the caller instead of only the log.
func (p *plDebugSession) noteDebugInfo(note string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.debugInfo == "" {
		p.debugInfo = note
		return
	}
	p.debugInfo = p.debugInfo + "; " + note
}

// plDebugFrameMatchesProgram reports whether the current frame -- the program name
// DBMS_DEBUG reported plus the source line of the backtrace -- is the start target.
//
// A standalone routine matches on its name alone. A package subprogram cannot: the
// server reports the *package* as the frame's program and leaves entrypointname NULL
// (measured on 19c EE: program.name = DBX_MSCHK_PKG, entrypointname NULL, namespace = 2,
// line = 2 at the subprogram's first line while the backtrace printed
// "PROCEDURE RUN_MSCHK IS"), and the frame keeps that name while the debugger steps
// through the package's initialization section. The package name is therefore only a
// precondition, and the line has to fall inside the target subprogram's own source range;
// that is what keeps the match from firing on the first subprogram the package happens to
// run.
//
// The subprogram's own name is still accepted first, because the frame name is an engine
// property and not a documented one: a server that reports the *subprogram* in
// run_info.program.name (which is what the name-only match always relied on) must keep
// working unchanged. The package-plus-line rule is only the additional way in that
// Oracle 19c EE requires.
//
// When that range is unknown (lines is zero) the package frame is accepted, which is the
// documented degradation: a session that starts one initialization line too early still
// debugs, while a session that refuses to enter the subprogram does not.
func plDebugFrameMatchesProgram(frame string, line int, target plDebugTarget, lines plDebugLineRange) bool {
	if plDebugFrameMatchesTarget(frame, target.Program) {
		return true
	}
	if target.Package == "" {
		return false
	}
	if plDebugProgramKey(frame) != plDebugProgramKey(target.Package) {
		return false
	}
	if lines.First <= 0 || lines.Last < lines.First {
		return true
	}
	return line >= lines.First && line <= lines.Last
}

// debugBefore reproduces ODC's DebuggerSession.debugBefore (:197-225) for a
// PROCEDURE/FUNCTION target: it makes pl_debug_start return a session parked inside the
// target routine (a program, a line, stackDepth 1) instead of the zero state.
//
// ODC gets there by arming an anonymous-block breakpoint on the call line of the block
// the debuggee runs, resuming onto it, then stepping in until the routine is the current
// frame. That route cannot work on Oracle 19c EE. The arming helper resolves the
// anonymous block through DBMS_DEBUG.GET_RUNTIME_INFO, and while the debuggee is parked
// on reason_interpreter_starting that primitive has no run_info to hand out -- measured:
// error_exception (28), or error_no_debug_info (2) on the retry, with program, line and
// stackdepth all NULL, and it stayed that way across a 10 x 200ms retry loop -- so the
// handle given to SET_BREAKPOINT is empty and arming answers error_bad_handle (16). This
// is a property of the start state, not of the privileges or of the compile options: the
// same get_runtime_info answers success as soon as one CONTINUE has produced an event.
//
// The debugger does not need that handle. A single DBMS_DEBUG.CONTINUE with
// break_any_call, issued right after SYNCHRONIZE, steps into the routine the anonymous
// block calls: measured on 19c EE, run_info came back as program = DBX_V1_PROC,
// namespace = 1, line = 1, reason = reason_enter (6), and PRINT_BACKTRACE then printed
// that routine's own source line. stepIntoRoutine performs exactly that, bounded by
// plDebugStartStepInLimit attempts, so a block whose next statement is not the target
// call still walks in.
func (p *plDebugSession) debugBefore(request map[string]interface{}) error {
	objectType := strings.ToUpper(strings.TrimSpace(stringField(request, "objectType")))
	if objectType != "PROCEDURE" && objectType != "FUNCTION" {
		// An anonymous-block target is submitted verbatim: there is no call line
		// to stop on, so it keeps its caller-supplied breakpoints.
		return nil
	}
	target, err := plDebugResolveTarget(p.owner, request)
	if err != nil {
		return err
	}
	// The attach/synchronize handshake is already guarded; if it abandoned the
	// debugger connection, report that outright instead of wrapping it in the
	// message of whichever call happens to be next.
	if err := p.debuggerFailure(); err != nil {
		return fmt.Errorf("debug start failed: %w", err)
	}
	if err := p.stepIntoRoutine(target); err != nil {
		return fmt.Errorf("debug start failed: %w", err)
	}

	// ODC publishes the target routine itself as the current frame, at the
	// routine's own depth (1) rather than the anonymous block's nesting; the
	// backtrace then supplies the current line and the program it is parked in.
	p.mu.Lock()
	p.lastProgramOwner = p.owner
	p.lastProgram = target.Program
	p.targetProgram = target.Program
	p.targetPackage = target.Package
	p.mu.Unlock()
	p.refreshBacktrace()
	p.mu.Lock()
	p.lastStackDepth = 1
	p.touch()
	p.mu.Unlock()
	return nil
}

// plDebugStepInUntilDeeper steps in at most limit times until the stack depth
// grows beyond its initial value, mirroring ODC's stepInForStartingDebug. The
// stepIn callback returns the depth observed after one step-in. The depth comes
// back with an error when the depth never grew.
func plDebugStepInUntilDeeper(depth, limit int, stepIn func() (int, error)) (int, error) {
	current := depth
	for attempt := 0; attempt < limit; attempt++ {
		observed, err := stepIn()
		if err != nil {
			return current, err
		}
		current = observed
		if current > depth {
			return current, nil
		}
	}
	return current, fmt.Errorf("stack depth stayed at %d after %d step-in attempts", depth, limit)
}

// stepInUntilDeeper is plDebugStepInUntilDeeper wired to the live session: each
// attempt runs one DBX_CNT_STEP_IN and reads the run_info stack depth.
func (p *plDebugSession) stepInUntilDeeper(depth int) error {
	_, err := plDebugStepInUntilDeeper(depth, plDebugStartStepInLimit, func() (int, error) {
		if _, err := p.stepIn(); err != nil {
			return 0, err
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.terminated {
			return p.lastStackDepth, fmt.Errorf("the debuggee finished while stepping in")
		}
		return p.lastStackDepth, nil
	})
	return err
}

// armAnonymousBreakpoint calls DBX_SET_BREAKPOINT_ANONYMOUS, the package variant that
// resolves the anonymous block through dbms_debug.get_runtime_info and sets the
// breakpoint on it, returning the server-assigned number and the DBMS_DEBUG result code.
//
// It is only reachable through a caller-supplied ANONYMOUS breakpoint now: the start
// sequence used to depend on it and could not, because at reason_interpreter_starting
// get_runtime_info hands out no program handle (the wrapper returns that primitive's own
// code instead of the set_breakpoint code that would only say error_bad_handle). See
// debugBefore.
func (p *plDebugSession) armAnonymousBreakpoint(line int) (int, int, error) {
	var breakpointNumber, result int
	err := p.plDebugCall(procSetBreakpointAnonymous, []any{line}, &breakpointNumber, &result)
	return breakpointNumber, result, err
}

// startSnapshot is the snapshot pl_debug_start returns. debugBefore has already
// parked the debuggee inside the target routine, so line/program/stackDepth are
// filled instead of the zero state the caller used to receive.
func (p *plDebugSession) startSnapshot() map[string]interface{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.snapshot("")
}

func (s *server) plDebugSession(debugID string) (*plDebugSession, error) {
	s.plDebugMu.Lock()
	session, ok := s.plDebugSessions[debugID]
	s.plDebugMu.Unlock()
	if !ok {
		return nil, fmt.Errorf("PL debug session not found: %s", debugID)
	}
	if session.expired() {
		s.closePlDebugSession(debugID)
		return nil, fmt.Errorf("PL debug session timed out: %s", debugID)
	}
	return session, nil
}

func (s *server) closePlDebugSession(debugID string) {
	s.plDebugMu.Lock()
	session, ok := s.plDebugSessions[debugID]
	if ok {
		delete(s.plDebugSessions, debugID)
	}
	s.plDebugMu.Unlock()
	if ok {
		_ = session.Close()
	}
}

// -- session operations ------------------------------------------------------

// setBreakpoints creates the requested source breakpoints and returns them
// with the server-assigned breakpoint numbers.
func (p *plDebugSession) setBreakpoints(requested []plDebugBreakpoint) ([]plDebugBreakpoint, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated {
		return nil, fmt.Errorf("debuggee has finished")
	}
	created := make([]plDebugBreakpoint, 0, len(requested))
	for _, requestedBreakpoint := range requested {
		if requestedBreakpoint.Line <= 0 {
			continue
		}
		kind := strings.ToUpper(strings.TrimSpace(requestedBreakpoint.Kind))
		var breakpointNumber, result int
		var err error
		signature := ""
		if requestedBreakpoint.Signature != nil {
			signature = strings.TrimSpace(*requestedBreakpoint.Signature)
		}
		sequence := -1
		if requestedBreakpoint.Sequence != nil {
			sequence = *requestedBreakpoint.Sequence
		}
		hasSignature := signature != ""
		hasSequence := sequence >= 0
		warnings := []string{}
		if kind == "ANONYMOUS" {
			breakpointNumber, result, err = p.armAnonymousBreakpoint(requestedBreakpoint.Line)
		} else {
			breakpointOwner := strings.ToUpper(strings.TrimSpace(requestedBreakpoint.Owner))
			if breakpointOwner == "" {
				breakpointOwner = p.owner
			}
			breakpointName := strings.ToUpper(strings.TrimSpace(requestedBreakpoint.Name))
			// An overloaded target armed without signature/sequence binds to
			// whichever implementation the server picks, so the caller is warned
			// instead of silently debugging the wrong body.
			if !hasSignature && !hasSequence {
				overloads, overloadErr := plDebugOverloadCount(p.debugger, breakpointOwner, breakpointName)
				if overloadErr != nil {
					plDebugLogf("overload probe for %s.%s failed: %v", breakpointOwner, breakpointName, overloadErr)
				} else if overloadWarning := plDebugOverloadWarningForTarget(breakpointOwner, breakpointName, overloads, hasSignature, hasSequence); overloadWarning != "" {
					warnings = append(warnings, overloadWarning)
					plDebugLogf("%s", overloadWarning)
				}
			}
			// Only ask DBX_SET_BREAKPOINT_EX for attributes this server's
			// program_info actually declares; the rest are ignored and logged.
			// On stock Oracle both are ignored, because the runtime record type
			// has no signature/sequence attribute at all (21c XE verified) -- the
			// warning is the honest answer here, not a bug.
			ignored := []string{}
			if hasSignature && !p.programInfoFields.Signature {
				ignored = append(ignored, "signature")
			}
			if hasSequence && !p.programInfoFields.Sequence {
				ignored = append(ignored, "sequence")
			}
			if len(ignored) > 0 {
				ignoredWarning := fmt.Sprintf("该服务器 DBMS_DEBUG.PROGRAM_INFO 不支持 %s 属性，已忽略", strings.Join(ignored, "/"))
				warnings = append(warnings, ignoredWarning)
				plDebugLogf("dbms_debug.program_info has no %s attribute; ignoring it for %s.%s",
					strings.Join(ignored, "/"), breakpointOwner, breakpointName)
			}
			useOverloadAttributes := (hasSignature && p.programInfoFields.Signature) || (hasSequence && p.programInfoFields.Sequence)
			// A package member is addressed as "PKG.SUB" (PlDebugSessionTarget
			// .programName in the desktop client). The server wants the two halves: it
			// answers error_bad_handle (16) or error_exception (28) for every shape that
			// passes the subprogram as program_info.name, and success (0) only for
			// name=<package> + namespace_pkg_body + entrypointname=<subprogram> --
			// measured on Oracle 19c EE (see procSetBreakpointEntry). The split arm is
			// used only when the server's PROGRAM_INFO record declares entrypointname;
			// the dotted name then keeps the previous path, so an engine that resolves
			// "PKG.SUB" by itself (OceanBase Oracle mode) is untouched.
			entryPackage, entrySubprogram, hasEntrypoint := plDebugSplitPackageSubprogram(breakpointName)
			useEntrypoint := hasEntrypoint && p.programInfoFields.Entrypoint
			if useEntrypoint && useOverloadAttributes {
				// DBX_SET_BREAKPOINT_ENTRY carries no signature/sequence attribute: the
				// entrypointname is what locates the subprogram. Saying so beats arming
				// the wrong overload silently.
				overloadIgnored := "包内子程序断点改用 entrypointname 定位，已忽略 signature/sequence"
				warnings = append(warnings, overloadIgnored)
				plDebugLogf("%s: %s.%s", overloadIgnored, breakpointOwner, breakpointName)
			}
			switch {
			case useEntrypoint:
				err = p.plDebugCall(procSetBreakpointEntry,
					[]any{breakpointOwner, entryPackage, entrySubprogram, requestedBreakpoint.Line},
					&breakpointNumber, &result)
			case useOverloadAttributes:
				err = p.plDebugCall(procSetBreakpointEx,
					[]any{breakpointOwner, breakpointName, requestedBreakpoint.Line, signature, sequence},
					&breakpointNumber, &result)
			default:
				err = p.plDebugCall(procSetBreakpoint,
					[]any{breakpointOwner, breakpointName, requestedBreakpoint.Line},
					&breakpointNumber, &result)
			}
		}
		if err != nil {
			return nil, fmt.Errorf("set breakpoint at line %d failed: %w", requestedBreakpoint.Line, err)
		}
		if result == plDebugErrException {
			// error_exception: the interpreter reported an exception while
			// arming the breakpoint. ODC swallows this code (the start sequence
			// arms the same line twice) and keeps the session usable.
			//
			// A package subprogram is where this code used to hide the real
			// failure: with program_info.name = <subprogram> every arm answered
			// 28 (or 16), the requested breakpoint was never created, the call
			// answered [], and pl_debug_resume then ran the debuggee to
			// completion (reason 25). The fix is not to turn 28 into an error --
			// the start sequence relies on the tolerance -- but to arm such a
			// breakpoint through DBX_SET_BREAKPOINT_ENTRY, which answers 0 (see
			// procSetBreakpointEntry and plDebugSplitPackageSubprogram).
			continue
		}
		if result != 0 {
			return nil, fmt.Errorf("set breakpoint at line %d failed: %s (%d)",
				requestedBreakpoint.Line, plDebugResultName(result), result)
		}
		kindValue := kind
		if kindValue == "" {
			kindValue = "PROCEDURE"
		}
		createdBreakpoint := plDebugBreakpoint{
			Owner:         requestedBreakpoint.Owner,
			Name:          requestedBreakpoint.Name,
			Line:          requestedBreakpoint.Line,
			BreakpointNbr: breakpointNumber,
			Kind:          kindValue,
			Signature:     requestedBreakpoint.Signature,
			Sequence:      requestedBreakpoint.Sequence,
			Warning:       strings.Join(warnings, "; "),
		}
		p.breakpoints = append(p.breakpoints, createdBreakpoint)
		created = append(created, createdBreakpoint)
	}
	p.touch()
	return created, nil
}

// plDebugSplitPackageSubprogram splits the "PKG.SUB" program name the desktop client
// sends for a package member (PlDebugSessionTarget.programName) into the package and the
// subprogram, because DBMS_DEBUG needs them in separate PROGRAM_INFO fields: name and
// entrypointname (see procSetBreakpointEntry). ok is false for everything else -- a
// standalone routine, an empty half, "PKG.SUB.EXTRA" -- so the caller keeps the previous
// arm path for those. Both halves must be plain identifiers: they are interpolated into
// the helper call's IN values only, but a name the server cannot accept is not worth a
// round trip, and the check keeps a quoted identifier ("My Pkg"."My Proc") from reaching
// a routine that would resolve it as a different object.
func plDebugSplitPackageSubprogram(name string) (packageName, subprogram string, ok bool) {
	dot := strings.IndexByte(name, '.')
	if dot <= 0 || dot == len(name)-1 {
		return "", "", false
	}
	packageName, subprogram = name[:dot], name[dot+1:]
	if !plDebugPlainIdentifier(packageName) || !plDebugPlainIdentifier(subprogram) {
		return "", "", false
	}
	return packageName, subprogram, true
}

// plDebugOverloadCount returns how many distinct subprograms share the target
// name, using SUBPROGRAM_ID (which is unique per overload) rather than a plain
// name count. A name of the form "PKG.PROC" is split so package subprograms are
// counted inside their package.
func plDebugOverloadCount(db *sql.DB, owner, name string) (int, error) {
	objectName := name
	procedureName := ""
	if dot := strings.IndexByte(name, '.'); dot >= 0 {
		objectName = name[:dot]
		procedureName = name[dot+1:]
	}
	var count int
	var err error
	if procedureName != "" {
		err = db.QueryRow(
			`SELECT COUNT(DISTINCT SUBPROGRAM_ID) FROM ALL_PROCEDURES
			  WHERE OWNER = :1 AND OBJECT_NAME = :2 AND PROCEDURE_NAME = :3
			    AND SUBPROGRAM_ID IS NOT NULL`,
			owner, objectName, procedureName,
		).Scan(&count)
	} else {
		err = db.QueryRow(
			`SELECT COUNT(DISTINCT SUBPROGRAM_ID) FROM ALL_PROCEDURES
			  WHERE OWNER = :1 AND (OBJECT_NAME = :2 OR PROCEDURE_NAME = :2)
			    AND SUBPROGRAM_ID IS NOT NULL`,
			owner, name,
		).Scan(&count)
	}
	if err != nil {
		return 0, err
	}
	return count, nil
}

// plDebugOverloadWarning is the message returned when an overloaded target is
// armed without the attributes that would disambiguate it. The attributes are
// informational only: the runtime DBMS_DEBUG.PROGRAM_INFO record carries no
// signature/sequence field on Oracle (21c XE verified), so the server cannot
// distinguish the overloads either way -- the warning tells the user that arming
// this line may hit a different implementation instead of letting it fail
// silently.
func plDebugOverloadWarning(owner, name string, overloads int) string {
	return fmt.Sprintf("%s.%s 存在 %d 个同名重载，未提供 signature/sequence 时可能断到错误的实现（overloaded target: %d candidates）",
		owner, name, overloads, overloads)
}

// plDebugOverloadWarningForTarget decides whether the overload warning applies:
// only an ambiguous target (more than one subprogram sharing the name) that the
// caller did not disambiguate with signature/sequence gets one. A standalone
// routine, or a target the caller disambiguated, stays silent.
func plDebugOverloadWarningForTarget(owner, name string, overloads int, hasSignature, hasSequence bool) string {
	if hasSignature || hasSequence || overloads <= 1 {
		return ""
	}
	return plDebugOverloadWarning(owner, name, overloads)
}

func (p *plDebugSession) deleteBreakpoints(requested []plDebugBreakpoint) ([]plDebugBreakpoint, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	removed := make([]plDebugBreakpoint, 0, len(requested))
	for _, requestedBreakpoint := range requested {
		if requestedBreakpoint.BreakpointNbr <= 0 {
			continue
		}
		var deleted int
		// DBMS_DEBUG.DELETE_BREAKPOINT is a function, not a procedure, so it has
		// to be invoked through a SELECT -- the same shape ODC uses. It goes
		// through the guard because it is one more PROBE call on the debugger
		// session, and those block forever once the debuggee is gone.
		if err := p.plDebugGuarded("DBMS_DEBUG.DELETE_BREAKPOINT", p.debugCallTimeout(), func() error {
			return p.debugger.QueryRow(
				"SELECT DBMS_DEBUG.DELETE_BREAKPOINT(:1) FROM DUAL",
				requestedBreakpoint.BreakpointNbr,
			).Scan(&deleted)
		}); err != nil {
			return nil, fmt.Errorf("delete breakpoint %d failed: %w", requestedBreakpoint.BreakpointNbr, err)
		}
		// error_no_such_breakpt: the server already dropped it. ODC tolerates
		// exactly this code and fails on every other non-zero result.
		if deleted != 0 && deleted != plDebugErrNoSuchBreakpoint {
			return nil, fmt.Errorf("delete breakpoint %d failed: %s (%d)",
				requestedBreakpoint.BreakpointNbr, plDebugResultName(deleted), deleted)
		}
		kept := p.breakpoints[:0]
		for _, stored := range p.breakpoints {
			if stored.BreakpointNbr != requestedBreakpoint.BreakpointNbr {
				kept = append(kept, stored)
			}
		}
		p.breakpoints = kept
		removed = append(removed, requestedBreakpoint)
	}
	p.touch()
	return removed, nil
}

func (p *plDebugSession) listBreakpoints() []plDebugBreakpoint {
	p.mu.Lock()
	defer p.mu.Unlock()
	list := make([]plDebugBreakpoint, len(p.breakpoints))
	copy(list, p.breakpoints)
	return list
}

// continueWith runs one of the CNT_* helpers. It blocks until the debuggee
// stops again (breakpoint / new line / return) or finishes.
func (p *plDebugSession) continueWith(procedure string) (map[string]interface{}, error) {
	p.mu.Lock()
	if p.terminated {
		p.mu.Unlock()
		return p.snapshot("debuggee has finished"), nil
	}
	p.mu.Unlock()

	var result int
	var message string
	if err := p.plDebugCall(procedure, nil, &result, &message); err != nil {
		return nil, fmt.Errorf("%s failed: %w", procedure, err)
	}

	p.mu.Lock()
	p.applyRunInfoMessage(message)
	// reason 15 = interpreter exiting, 21 = aborting, 25 = the interpreter left
	// the program: the debuggee is done. reason 8 ("procedure is finished") only
	// means the current entrypoint returned, so treating it as terminal would end
	// the session the first time a nested procedure returns. ODC treats only
	// reason_exit as an exit and keeps stepping past reason_finish.
	if p.lastReason == plDebugReasonExit || p.lastReason == plDebugReasonAborting ||
		p.lastReason == plDebugReasonKnlExit {
		p.terminated = true
	}
	if result != 0 {
		p.targetErr = fmt.Sprintf("%s failed: %s (%d)", procedure, plDebugResultName(result), result)
	}
	// The run_info register carries no line number -- only reason, stack depth and
	// program -- so without this the snapshot's line would stay at the routine
	// entry and `pl_debug_resume` could not tell the client WHERE a breakpoint
	// stopped. PRINT_BACKTRACE is the only source of the stopped line on 19c EE
	// ("[Line 9]     V_COUNT := V_COUNT + 1;"), and it is a live-stop call only:
	// a terminated or failed continue has nothing left to ask.
	if !p.terminated && result == plDebugErrSuccess {
		p.refreshBacktraceLocked()
	}
	p.touch()
	response := p.snapshot(message)
	p.mu.Unlock()
	return response, nil
}

// resume runs to the next breakpoint (or to the end of the program). Without an
// exception breakpoint this is a single DBX_CNT_NEXT_BREAKPOINT call; with one it
// keeps continuing until the interpreter reports an exception/handler, a real
// breakpoint hit, or termination.
func (p *plDebugSession) resume() (map[string]interface{}, error) {
	p.mu.Lock()
	exceptionMode := p.exceptionBreakpoint
	p.mu.Unlock()
	if !exceptionMode {
		return p.continueWith(procCntNextBreakpoint)
	}
	return p.resumeUntilException()
}

// resumeUntilException drives the exception-mode resume: reason_finish (8) and
// every other non-exceptional stop keep the loop going, because the debuggee only
// stops at entrypoint returns while breakpoints are suspended. The loop is capped
// so a server that never reports a stop condition cannot hang the RPC.
func (p *plDebugSession) resumeUntilException() (map[string]interface{}, error) {
	var response map[string]interface{}
	truncated := false
	for iteration := 0; iteration < plDebugExceptionResumeIterations; iteration++ {
		current, err := p.continueWith(procCntNextBreakpoint)
		if err != nil {
			return nil, err
		}
		if current == nil {
			break
		}
		response = current
		terminated, _ := current["terminated"].(bool)
		reason, _ := current["reason"].(int)
		breakpoint, _ := current["breakpoint"].(int)
		if terminated || reason == plDebugReasonException || reason == plDebugReasonHandler || breakpoint > 0 {
			break
		}
		if iteration == plDebugExceptionResumeIterations-1 {
			truncated = true
		}
	}
	p.mu.Lock()
	if response == nil {
		response = p.snapshot("")
	}
	reason, _ := response["reason"].(int)
	p.stoppedOnException = reason == plDebugReasonException || reason == plDebugReasonHandler
	p.touch()
	response["stoppedOnException"] = p.stoppedOnException
	if truncated {
		response["exceptionResumeTruncated"] = true
		response["message"] = fmt.Sprintf("exception breakpoint resume stopped after %d continuations without an exception",
			plDebugExceptionResumeIterations)
	}
	p.mu.Unlock()
	return response, nil
}

// setExceptionBreakpoint switches the resume-only exception mode on or off. The
// step operations keep their DBMS_DEBUG semantics: only resume loops.
func (p *plDebugSession) setExceptionBreakpoint(enabled bool) map[string]interface{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.exceptionBreakpoint = enabled
	if !enabled {
		p.stoppedOnException = false
	}
	p.touch()
	message := "exception breakpoint disabled"
	if enabled {
		message = "exception breakpoint enabled"
	}
	return p.snapshot(message)
}

// resumeIgnoreBreakpoints runs the debuggee to completion, ignoring every
// remaining breakpoint -- ODC's resumeIgnoreBreakpoints (its "CNT_EXIT"). The
// helper package loops DBMS_DEBUG.CONTINUE(break_next_line) internally, so this
// single call only returns once the interpreter reported reason_exit, or when a
// continuation failed; the session is finished either way. Unlike the other
// continuation helpers, DBX_CNT_EXIT has no `result OUT` parameter: its message
// carries nothing but the final reason.
func (p *plDebugSession) resumeIgnoreBreakpoints() (map[string]interface{}, error) {
	p.mu.Lock()
	if p.terminated {
		p.mu.Unlock()
		return p.snapshot("debuggee has finished"), nil
	}
	p.mu.Unlock()

	var message string
	if err := p.plDebugCall(procCntExit, nil, &message); err != nil {
		return nil, fmt.Errorf("%s failed: %w", procCntExit, err)
	}

	p.mu.Lock()
	// The message is only ' reason = <n>' (no run_info fields), so it cannot be
	// fed to applyRunInfoMessage; read the reason from it directly. reason_exit
	// is the normal outcome; any other reason means the internal continuation
	// stopped failing, which also leaves the debuggee without a live stop point.
	p.lastReason = atoiOrZero(runInfoValue(message))
	p.terminated = true
	p.touch()
	response := p.snapshot(message)
	p.mu.Unlock()
	return response, nil
}

func (p *plDebugSession) stepOver() (map[string]interface{}, error) {
	return p.continueWith(procCntNextLine)
}

func (p *plDebugSession) stepIn() (map[string]interface{}, error) {
	return p.continueWith(procCntStepIn)
}

func (p *plDebugSession) stepOut() (map[string]interface{}, error) {
	return p.continueWith(procCntStepOut)
}

func (p *plDebugSession) abort() (map[string]interface{}, error) {
	return p.continueWith(procCntAbort)
}

// variables returns the raw scalar_values payload; format parsing (JSON for
// OceanBase, `*name*type*value` delimited text for Oracle) happens on the Rust
// side so both agents share one presentation path.
//
// frame selects the stack frame (0, the default, is the current one). The
// DBX_GET_VALUES wrapper has no frame argument, so a non-zero frame re-reads every
// variable it listed through DBX_GET_VALUE(name, frame) and rebuilds the same
// `*name*type*value` text; when the listing is not in that Oracle format (for
// example OceanBase's JSON) the current-frame listing is returned unchanged and
// frameScoped=false tells the caller.
func (p *plDebugSession) variables(frame int) (map[string]interface{}, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if frame < 0 {
		frame = 0
	}
	response := p.snapshot("")
	response["frame"] = frame
	if p.terminated {
		response["scalarValues"] = ""
		return response, nil
	}
	var scalarValues string
	var result int
	if err := p.plDebugCall(procGetValues, nil, &scalarValues, &result); err != nil {
		return nil, fmt.Errorf("get_values failed: %w", err)
	}
	if result != 0 {
		if result == plDebugErrGetValuesUnavailable {
			return nil, fmt.Errorf("PL/SQL variables are unavailable on this server: " +
				"DBMS_DEBUG.GET_VALUES is not declared, so only breakpoints, stepping and the backtrace are supported")
		}
		return nil, fmt.Errorf("get_values failed: result=%d", result)
	}
	p.touch()
	if frame > 0 {
		if scoped, ok := p.frameScalarValues(scalarValues, frame); ok {
			response["scalarValues"] = scoped
			response["frameScoped"] = true
			return response, nil
		}
		plDebugLogf("frame %d: no frame-scoped variable listing available; returning the current frame values", frame)
		response["frameScoped"] = false
	}
	response["scalarValues"] = scalarValues
	return response, nil
}

// frameScalarValues re-reads the variable listing of another stack frame. It
// requires the Oracle `*name*type*value` shape (one variable per line) and returns
// false when the listing cannot be interpreted that way; the caller then falls
// back to the single listing DBMS_DEBUG.GET_VALUES returns. The caller holds p.mu.
func (p *plDebugSession) frameScalarValues(listing string, frame int) (string, bool) {
	type plDebugScopedVariable struct{ name, typeName string }
	variables := make([]plDebugScopedVariable, 0)
	for _, line := range strings.Split(listing, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "*") {
			continue
		}
		fields := strings.SplitN(strings.TrimPrefix(trimmed, "*"), "*", 3)
		if len(fields) < 2 {
			continue
		}
		name := strings.TrimSpace(fields[0])
		if name == "" {
			continue
		}
		typeName := "unknown"
		if len(fields) == 3 && strings.TrimSpace(fields[1]) != "" {
			typeName = strings.TrimSpace(fields[1])
		}
		variables = append(variables, plDebugScopedVariable{name: name, typeName: typeName})
	}
	if len(variables) == 0 {
		return "", false
	}
	var builder strings.Builder
	for _, variable := range variables {
		var value string
		var result int
		if err := p.plDebugCall(procGetValue, []any{variable.name, frame}, &value, &result); err != nil || result != 0 {
			// A single unreadable variable (optimized out, wrong scope) must not
			// drop the whole frame; it is logged and skipped.
			plDebugLogf("get_value(%s, frame=%d) failed (err=%v, result=%d)", variable.name, frame, err, result)
			continue
		}
		builder.WriteString("*" + variable.name + "*" + variable.typeName + "*" + value + "\n")
	}
	if builder.Len() == 0 {
		return "", false
	}
	return builder.String(), true
}

// plDebugAssignmentStatement renders the PL/SQL assignment DBMS_DEBUG.SET_VALUE
// executes inside the debuggee. Its second argument is statement *text*, not a
// value: the caller is responsible for the literal, so a string arrives already
// quoted ("'abc'") and is forwarded verbatim -- adding quotes here would double
// them. An index > 0 addresses a collection element ("x(1) := 5"), unless the name
// already carries its own index.
func plDebugAssignmentStatement(name string, index int, value string) string {
	target := strings.TrimSpace(name)
	if index > 0 && !strings.Contains(target, "(") {
		target = fmt.Sprintf("%s(%d)", target, index)
	}
	return target + " := " + value
}

// plDebugCapabilityMissing reports whether a dynamically executed DBMS_DEBUG call
// failed because the server does not declare the routine at all, as opposed to
// failing while running it. Both end in the -1 sentinel, and only the server
// message tells them apart: "identifier ... must be declared" (PLS-00201),
// "component ... must be declared" (PLS-00302) or ORA-00904 mean the primitive is
// absent, while anything else -- a malformed assignment, for example -- is a real
// failure that must not be reported as "this server does not support it".
func plDebugCapabilityMissing(message string) bool {
	if strings.TrimSpace(message) == "" {
		// A helper package installed before V6 reports the sentinel without a
		// message; keep the conservative "unavailable" answer for it.
		return true
	}
	upper := strings.ToUpper(message)
	for _, marker := range []string{"PLS-00201", "PLS-00302", "ORA-00904", "MUST BE DECLARED", "NOT DECLARED"} {
		if strings.Contains(upper, marker) {
			return true
		}
	}
	return false
}

// plDebugAssignmentSyntaxError reports whether a failed DBX_SET_VALUE call failed at
// *compile* time on the assignment text -- the case where the form Probe passed may
// simply need its PL/SQL terminator. Oracle's reference examples pass 'x := 3;' and
// 'var := 6;', while plDebugAssignmentStatement deliberately omits the terminator
// because the primitive may append it itself; which of the two a real server wants
// is not verified yet, so this predicate only decides whether one bounded retry with
// the terminator is worth it.
//
// ORA-06550 is the "PL/SQL: compilation unit analysis terminated" prefix PLS-00103
// arrives with -- and it also prefixes PLS-00201/PLS-00302. A missing primitive is
// therefore excluded first: that is a capability answer, not a form answer, and
// must never be retried (it would only turn "unsupported" into a pointless extra
// round trip). Mirrors the Java agent's assignmentSyntaxError.
func plDebugAssignmentSyntaxError(message string) bool {
	if plDebugCapabilityMissing(message) {
		return false
	}
	upper := strings.ToUpper(message)
	for _, marker := range []string{"PLS-00103", "ORA-06550", "ENCOUNTERED THE SYMBOL", "SYNTAX"} {
		if strings.Contains(upper, marker) {
			return true
		}
	}
	return false
}

// plDebugRetryAssignmentStatement builds the single retry form of an assignment:
// the same text plus its PL/SQL terminator. An assignment that already ends in ";"
// is returned unchanged, which the caller reports as "no retry form available" --
// appending a second terminator would be a different, still-invalid form. Mirrors
// the Java agent's retryAssignmentStatement.
func plDebugRetryAssignmentStatement(assignment string) string {
	if strings.HasSuffix(strings.TrimRight(assignment, " \t\r\n"), ";") {
		return assignment
	}
	return assignment + ";"
}

// plDebugSetValueRetry decides whether a DBX_SET_VALUE result warrants exactly one
// retry with the assignment's terminator appended. It returns the text to retry
// with and whether a retry is warranted, and it is the whole retry policy so it can
// be tested without a database:
//
//   - success (or any other result): no retry, the first form worked;
//   - missing primitive (PLS-00201/PLS-00302/ORA-00904): no retry, report unsupported;
//   - syntax-level rejection of the dynamic block (PLS-00103 / ORA-06550 /
//     "encountered the symbol"): retry once with the terminator;
//   - error_value_malformed (7, "bad value"): retry once with the terminator, because
//     that is exactly what stock Oracle answers for the unterminated form -- measured
//     on 19c EE, set_value(0, 'V_COUNT := 100') -> 7 with an EMPTY message, while
//     set_value(0, 'V_COUNT := 100;') -> 0 and V_COUNT then read 100. The old policy
//     keyed on the capability sentinel alone, so on a real server it reported
//     "result=7" for an assignment the server accepts as soon as it is terminated;
//   - any other rejection: no retry, report the server's message verbatim.
//
// Mirrors the Java agent's setValueRetry.
func plDebugSetValueRetry(result int, message, assignment string) (string, bool) {
	switch result {
	case plDebugErrCapabilityUnavailable:
		if !plDebugAssignmentSyntaxError(message) {
			return assignment, false
		}
	case plDebugErrValueMalformed:
	default:
		return assignment, false
	}
	retry := plDebugRetryAssignmentStatement(assignment)
	if retry == assignment {
		return assignment, false
	}
	return retry, true
}

// callSetValue performs exactly one DBX_SET_VALUE call and returns the wrapper's
// result code plus its SQLERRM message. The message register is scanned into a
// NullString, not a string: the wrapper assigns an empty string on success and Oracle
// stores that as NULL, so a plain string destination would fail the scan before the
// result code is ever looked at. Mirrors the Java agent's callSetValue.
func (p *plDebugSession) callSetValue(frame int, assignment string) (int, string, error) {
	var result int
	var serverMessage sql.NullString
	if err := p.plDebugCall(procSetValue, []any{frame, assignment}, &result, &serverMessage); err != nil {
		return 0, "", err
	}
	if serverMessage.Valid {
		return result, serverMessage.String, nil
	}
	return result, "", nil
}

// setValue changes a variable of the parked debuggee through DBX_SET_VALUE, which
// resolves dbms_debug.set_value(frame#, assignment_statement) dynamically. The
// assignment text is built from the caller's name/index/value and sent exactly as
// plDebugAssignmentStatement renders it (no terminator). A result of -1 means the
// dynamic call failed, and the wrapper's message decides what to do:
//
//   - missing primitive (PLS-00201/PLS-00302/ORA-00904): "unsupported", never retried;
//   - syntax-level rejection of the text: retried ONCE with a trailing ";", because
//     Oracle's own examples pass the terminator while the agent omits it and neither
//     form is verified against a real server yet;
//   - anything else: reported verbatim.
//
// The response says whether the retried form was the one that succeeded
// ("assignmentSemicolon"), so a real-machine run can tell the two forms apart
// without guessing. The request contract ({debugId,name,frame,index,value}) is
// unchanged; only this extra response field is added. Mirrors the Java agent's
// setValue.
func (p *plDebugSession) setValue(name string, frame, index int, value string) (map[string]interface{}, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated {
		return nil, fmt.Errorf("debuggee has finished")
	}
	variableName := strings.TrimSpace(name)
	assignment := plDebugAssignmentStatement(variableName, index, value)
	result, serverError, err := p.callSetValue(frame, assignment)
	if err != nil {
		return nil, fmt.Errorf("set_value failed: %w", err)
	}
	// The sentinel covers "the routine is not declared" and "the assignment was
	// rejected" at once, so the message decides: a missing primitive is answered
	// before any retry, because retrying a capability answer is pointless.
	if result == plDebugErrCapabilityUnavailable && plDebugCapabilityMissing(serverError) {
		return nil, errors.New("该服务器不支持改变量值（DBMS_DEBUG.SET_VALUE 不可用）")
	}
	usedTerminator := false
	if retryAssignment, retry := plDebugSetValueRetry(result, serverError, assignment); retry {
		usedTerminator = true
		result, serverError, err = p.callSetValue(frame, retryAssignment)
		if err != nil {
			return nil, fmt.Errorf("set_value failed: %w", err)
		}
		if result == plDebugErrCapabilityUnavailable && plDebugCapabilityMissing(serverError) {
			return nil, errors.New("该服务器不支持改变量值（DBMS_DEBUG.SET_VALUE 不可用）")
		}
	}
	if result == plDebugErrCapabilityUnavailable {
		return nil, fmt.Errorf("set_value failed: %s", strings.TrimSpace(serverError))
	}
	message := fmt.Sprintf("set %s (frame=%d, index=%d)", variableName, frame, index)
	if result != plDebugErrSuccess {
		message = fmt.Sprintf("DBMS_DEBUG.SET_VALUE returned result=%d for %s (frame=%d, index=%d)",
			result, variableName, frame, index)
	} else if usedTerminator {
		message += " (assignment retried with a trailing \";\")"
	}
	p.touch()
	return map[string]interface{}{
		"ok":                  result == plDebugErrSuccess,
		"result":              result,
		"message":             message,
		"assignmentSemicolon": usedTerminator,
		"snapshot":            p.snapshot(""),
	}, nil
}

// plDebugBreakpointEnabledMessage turns a DBMS_DEBUG ENABLE_BREAKPOINT /
// DISABLE_BREAKPOINT result into the message the client shows. The -1 capability
// sentinel must stay distinct from error_no_such_breakpt (13): the latter means the
// server does implement the primitive but does not know that breakpoint number.
func plDebugBreakpointEnabledMessage(breakpoint int, enabled bool, result int) string {
	action := "禁用"
	if enabled {
		action = "启用"
	}
	switch result {
	case plDebugErrSuccess:
		return fmt.Sprintf("断点 %d 已%s", breakpoint, action)
	case plDebugErrCapabilityUnavailable:
		return fmt.Sprintf("该服务器不支持%s断点（DBMS_DEBUG.ENABLE_BREAKPOINT / DISABLE_BREAKPOINT 不可用），"+
			"请保留客户端兜底路径", action)
	case plDebugErrNoSuchBreakpoint:
		return fmt.Sprintf("断点 %d 不存在（error_no_such_breakpt），无法%s",
			breakpoint, action)
	default:
		return fmt.Sprintf("断点 %d %s失败：DBMS_DEBUG 返回 result=%d", breakpoint, action, result)
	}
}

// setBreakpointEnabled toggles an existing breakpoint through
// DBX_ENABLE_BREAKPOINT / DBX_DISABLE_BREAKPOINT, which wrap the
// DBMS_DEBUG.ENABLE_BREAKPOINT / DISABLE_BREAKPOINT functions dynamically (both
// take the breakpoint number and return success / error_no_such_breakpt /
// error_idle_breakpt).
//
// A result of -1 is the capability sentinel and is reported through
// serverSupported=false instead of an error, so the front end keeps its
// client-side fallback (delete the breakpoint and re-set it to re-enable) on the
// servers that have no such primitive.
func (p *plDebugSession) setBreakpointEnabled(breakpoint int, enabled bool) (map[string]interface{}, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated {
		return nil, fmt.Errorf("debuggee has finished")
	}
	if breakpoint <= 0 {
		return nil, errors.New("breakpointNumber must be a positive breakpoint number")
	}
	procedure := procDisableBreakpoint
	if enabled {
		procedure = procEnableBreakpoint
	}
	var result int
	if err := p.plDebugCall(procedure, []any{breakpoint}, &result); err != nil {
		return nil, fmt.Errorf("set breakpoint %d enabled=%t failed: %w", breakpoint, enabled, err)
	}
	p.touch()
	return map[string]interface{}{
		"ok":               result == plDebugErrSuccess,
		"result":           result,
		"breakpointNumber": breakpoint,
		"enabled":          enabled,
		"serverSupported":  result != plDebugErrCapabilityUnavailable,
		"message":          plDebugBreakpointEnabledMessage(breakpoint, enabled, result),
		"snapshot":         p.snapshot(""),
	}, nil
}

// fetchBacktrace queries DBX_PRINT_BACKTRACE and folds the listing into the
// session's current line/program. The caller holds p.mu. The run_info message no
// longer carries the line (ODC's does not either): the current line and the
// object the interpreter is parked in come from this listing.
func (p *plDebugSession) fetchBacktrace() (string, int, error) {
	var listing string
	var status int
	if err := p.plDebugCall(procPrintBacktrace, nil, &listing, &status); err != nil {
		return "", 0, fmt.Errorf("print_backtrace failed: %w", err)
	}
	p.touch()
	if line, program, parseErr := plDebugParseBacktrace(listing); parseErr == nil {
		p.lastLine = line
		if plDebugIsProgramName(program) {
			p.lastProgram = program
		}
		// run_info reports only the PACKAGE for a package subprogram (the subprogram lives
		// in program_info.entrypointname, which run_info does not carry), so the label is
		// rebuilt from the frames of this very listing: the current frame's source line
		// names the subprogram whenever the interpreter sits on its declaration, and the
		// session's own target names it otherwise.
		p.lastProgram = p.currentProgramLabel(plDebugParseBacktraceFrames(listing))
	}
	return listing, status, nil
}

// plDebugIsProgramName reports whether the text PRINT_BACKTRACE printed after "[Line N]"
// is a program identifier rather than the source text of that line.
//
// Oracle 19c EE prints the listing as
//
//	 [Line 2]   V_COUNT NUMBER := 0;
//	<source not available>
//
// so the position right after the bracket holds the SOURCE line, not the name ODC's
// samples show ("[Line 0] F_ADD"). Publishing it verbatim would put
// "V_COUNT NUMBER := 0;" into the snapshot's program field, so only a token that looks
// like an Oracle identifier (optionally schema- or package-qualified) is accepted; the
// DBMS_DEBUG run_info register remains the authoritative program name.
func plDebugIsProgramName(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	for index := 0; index < len(trimmed); index++ {
		if !plDebugIdentifierByte(trimmed[index]) && trimmed[index] != '.' {
			return false
		}
	}
	// Identifier-shaped is not enough: Oracle prints structural keywords as whole source
	// lines ("BEGIN", "END", "ELSE", ...), and each of those would otherwise be published
	// as if it were the routine the frame is in.
	return !plDebugReservedWord(trimmed)
}

// plDebugReservedWord reports whether an identifier-shaped token is one of the PL/SQL
// keywords that can make up a whole source line. A routine cannot be named after one of
// these (they are reserved), so rejecting them can never hide a real name.
func plDebugReservedWord(text string) bool {
	switch strings.ToUpper(text) {
	case "BEGIN", "END", "ELSE", "ELSIF", "IF", "THEN", "LOOP", "WHILE", "FOR", "CASE",
		"WHEN", "EXCEPTION", "DECLARE", "IS", "AS", "RETURN", "NULL", "COMMIT", "ROLLBACK":
		return true
	}
	return false
}

// refreshBacktrace pulls the current backtrace into the session fields. A failure
// is logged only: a backtrace miss must never take a live session down.
func (p *plDebugSession) refreshBacktrace() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated {
		return
	}
	p.refreshBacktraceLocked()
}

// refreshBacktraceLocked is refreshBacktrace for a caller that already holds p.mu
// (continueWith, so that every stop reports the line it stopped on).
func (p *plDebugSession) refreshBacktraceLocked() {
	if p.terminated {
		return
	}
	if _, _, err := p.fetchBacktrace(); err != nil {
		plDebugLogf("backtrace refresh failed (ignored): %v", err)
	}
}

func (p *plDebugSession) stack() (map[string]interface{}, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	response := p.snapshot("")
	// frames is always present (as an array) so the client can render the stack
	// pane without a nil check.
	response["frames"] = []plDebugFrame{}
	if p.terminated {
		response["backtrace"] = ""
		return response, nil
	}
	listing, status, err := p.fetchBacktrace()
	if err != nil {
		return nil, err
	}
	response["backtrace"] = listing
	response["dbmsStatus"] = status
	response["line"] = p.lastLine
	// Every frame of the listing, first frame = current frame. The run_info stack
	// depth is the depth of the current frame, so it renumbers the frames when it
	// is known; the parser's own ordering is the fallback.
	frames := plDebugParseBacktraceFrames(listing)
	if p.lastStackDepth > 0 {
		for index := range frames {
			depth := p.lastStackDepth - index
			if depth < 0 {
				depth = 0
			}
			frames[index].StackDepth = depth
		}
	}
	// The label is derived after the frames exist: it needs the current frame's source
	// line, and it must use the line this listing just refreshed rather than the one the
	// previous event left behind.
	program := p.currentProgramLabel(frames)
	response["program"] = program
	if len(frames) > 0 {
		frames[0].ProgramOwner = p.lastProgramOwner
		// Oracle prints the SOURCE line at the current frame, so the parser cannot
		// name that frame from the listing; the derived label names it instead.
		if frames[0].Program == "" && program != "" {
			frames[0].Program = program
		}
	}
	response["frames"] = frames
	return response, nil
}

// -- OUT bindings of the helper package --------------------------------------

// plDebugLineChars is the client-side buffer the helper package's text registers
// are read back into, in characters. The PL/SQL debug path was verified against
// Oracle 21c XE with this size, so it stays: dbms_output.go owns its own
// (larger, batched) register for the plain-SQL capture and the two do not have to
// agree. go-ora multiplies the size by the charset's maximum bytes per character,
// so 4000 characters stay inside the server's 32767-byte VARCHAR2 limit for
// every client charset; the *number of characters* is what the server checks, so
// a longer register would hand back longer DBX_GET_LINE output at the cost of a
// bind whose declared byte length exceeds the server's VARCHAR2 limit.
const plDebugLineChars = 4000

// plDebugOutArg returns one OUT binding for the driver in use. The choice mirrors
// dbms_output.go: the OCI (godror) driver binds database/sql's sql.Out directly
// and sizes it itself, while the built-in go-ora driver needs its own Out type,
// which also carries the client-side buffer size it reads a text register back
// into. A NUMBER register is sized by go-ora from its type, so only the text
// destinations are given a size: a *string, and the *sql.NullString the
// DBX_SET_VALUE message register is read into (go-ora treats sql.NullString as
// NCHAR too, parameter_encode.go:34).
func plDebugOutArg(oci bool, dest any) any {
	if oci {
		return sql.Out{Dest: dest}
	}
	bind := go_ora.Out{Dest: dest}
	switch dest.(type) {
	case *string, *sql.NullString:
		bind.Size = plDebugLineChars
	}
	return bind
}

// plDebugOutArgs maps one call's OUT destinations to the bindings its driver
// needs, in order.
func plDebugOutArgs(oci bool, dests ...any) []any {
	args := make([]any, 0, len(dests))
	for _, dest := range dests {
		args = append(args, plDebugOutArg(oci, dest))
	}
	return args
}

// plDebugLogOutArg is the OUT binding of one DBX_FETCH_OUTPUT chunk: a text register
// of plDebugLogChars characters instead of plDebugLineChars. go-ora reads a text
// register back into the client-side buffer the Out carries, so the default 4000
// characters would silently truncate the debuggee's DBMS_OUTPUT.
func plDebugLogOutArg(oci bool, dest *string) any {
	if oci {
		return sql.Out{Dest: dest}
	}
	return go_ora.Out{Dest: dest, Size: plDebugLogChars}
}

// plDebugHelperSQL renders the anonymous block of one helper-package call with
// one bind placeholder per argument: BEGIN <owner>."<ROUTINE>"(:1, :2); END;
func plDebugHelperSQL(owner, routine string, argumentCount int) string {
	var placeholders strings.Builder
	for index := 1; index <= argumentCount; index++ {
		if index > 1 {
			placeholders.WriteString(", ")
		}
		fmt.Fprintf(&placeholders, ":%d", index)
	}
	return fmt.Sprintf(`BEGIN %s."%s"(%s); END;`, plDebugQualifiedPrefix(owner), routine, placeholders.String())
}

// plDebugHelperCall runs one helper-package call on db and leaves its OUT
// registers in the destinations the caller passed: in holds the input arguments
// (which go first, exactly as the package declares them) and out the registers
// read back.
//
// It deliberately uses Exec and not QueryRow: go-ora only recognises OUT binds in
// its Exec path (Stmt._exec, command.go:1551-1598, where a sql.Out / Out argument
// becomes a parameter with Direction Output and, for its own Out, the Out's
// Size), while its query path (Stmt.Query_, command.go:1930-1945 ->
// NewParam(..., 0, Input)) binds every argument as an input. A sql.Out reaching
// that path is encoded as an input struct and fails in setDataType
// (parameter_encode.go:108-121) with "call register type before use user defined
// type (UDT)", so every QueryRow-based call used to fail on the thin driver
// without filling a single register. QueryRow could not have read the registers
// back either: such a block returns no row, so Scan would report sql.ErrNoRows
// even where the driver did write the destinations. Exec is the shape both
// drivers accept.
func plDebugHelperCall(db *sql.DB, oci bool, owner, routine string, in []any, out ...any) error {
	args := make([]any, 0, len(in)+len(out))
	args = append(args, in...)
	args = append(args, plDebugOutArgs(oci, out...)...)
	_, err := db.Exec(plDebugHelperSQL(owner, routine, len(args)), args...)
	return err
}

// plDebugHelperFunctionSQL renders the anonymous block that calls one helper-package
// *function* and leaves its return value in bind :1: BEGIN :1 := <owner>."<ROUTINE>"(:2, :3); END;
// It exists for the V6.3 DBX_FETCH_OUTPUT, which is a function precisely so the
// debuggee's own target block can call it as an expression (see plDebugAnonymousBlock).
func plDebugHelperFunctionSQL(owner, routine string, argumentCount int) string {
	var placeholders strings.Builder
	for index := 1; index <= argumentCount; index++ {
		if index > 1 {
			placeholders.WriteString(", ")
		}
		fmt.Fprintf(&placeholders, ":%d", index+1)
	}
	return fmt.Sprintf(`BEGIN :1 := %s."%s"(%s); END;`, plDebugQualifiedPrefix(owner), routine, placeholders.String())
}

// plDebugFetchOutput reads one chunk of the calling session's DBMS_OUTPUT buffer.
// maxChars <= 0 asks for as much as a PL/SQL VARCHAR2 holds.
func plDebugFetchOutput(db *sql.DB, oci bool, owner string, maxChars int, out *string) error {
	args := []any{plDebugLogOutArg(oci, out), maxChars}
	_, err := db.Exec(plDebugHelperFunctionSQL(owner, procFetchOutput, 1), args...)
	return err
}

// plDebugCall runs one DBX_PL_DEBUG_PACKAGE routine on the debugger connection,
// under whatever locking the caller already held. Every call goes through the
// timeout/state guard: see plDebugGuarded. That is the single place the "a
// pl_debug_* handler always returns" contract is enforced, so every present and
// future helper-package call site inherits it.
func (p *plDebugSession) plDebugCall(routine string, in []any, out ...any) error {
	return p.plDebugGuarded(routine, p.debugCallTimeout(), func() error {
		return plDebugHelperCall(p.debugger, p.oci, p.owner, routine, in, out...)
	})
}

// plDebugCallTimeoutError reports a server call the agent never got an answer to and
// which had to be released by dropping its connection. The distinct type lets the
// session recognise the case without matching on message text (errors.As).
//
// It is raised for helper-package calls, for the raw PROBE statements and for the two
// helper-package DDL statements, so the message names the operation and the bound
// rather than guessing which of them it was: a replacement body can wait on another
// session's execution of the package instead of on a debuggee.
type plDebugCallTimeoutError struct {
	Label   string
	Timeout time.Duration
}

func (e *plDebugCallTimeoutError) Error() string {
	return fmt.Sprintf("%s did not return within %s; the statement was abandoned and its connection dropped "+
		"to release it", e.Label, e.Timeout)
}

// plDebugBoundedRunKeepPool is plDebugBoundedRun without the connection drop: a call
// that overruns its bound is reported as a timeout and the caller returns, but the
// pool is left exactly as it was.
//
// It exists for reading the debuggee's DBMS_OUTPUT. Dropping that pool is not a
// benign "release a wedged call" there: the pool holds the *only* session whose
// DBMS_OUTPUT buffer has the program's output, so closing it destroys the log the
// read was for, and it leaves the server session to be cleaned up by nothing but
// the debuggee's own SET_TIMEOUT. The drain is therefore bounded but non-destructive:
// a read that does not return inside its bound leaves the session and its buffer
// intact for the next attempt instead of turning a diagnostic read into a second
// session-leak path. Every other guarded call keeps the releasing drop, which is
// what makes the "a pl_debug_* handler always returns" contract hold.
func plDebugBoundedRunKeepPool(db *sql.DB, label string, timeout time.Duration, fn func() error) error {
	if timeout <= 0 {
		timeout = plDebugCallTimeout
	}
	done := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- fmt.Errorf("%s panicked: %v", label, recovered)
			}
		}()
		done <- fn()
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		plDebugLogf("%s did not return within %s; the debuggee connection is left open "+
			"(its DBMS_OUTPUT buffer is only readable from that session)", label, timeout)
		return &plDebugCallTimeoutError{Label: label, Timeout: timeout}
	}
}

// plDebugBoundedRun runs fn -- one statement against db -- on its own goroutine
// and gives up after timeout.
//
// go-ora cannot be relied on to interrupt an in-flight server call: the real
// 19c EE failure left DBMS_DEBUG parked inside the server with the client
// blocked in a socket read, deaf to context cancellation and to a client-side
// cancel request. The only reliable release is to drop the connection, so the
// pool is closed in the background (the blocked read then fails and the goroutine
// unwinds) while the caller returns at once with a readable error instead of
// waiting for the server forever.
//
// fn's error is returned untouched, never wrapped, so callers keep matching on
// the driver's own text (plDebugPrivilegeHint, plDebugCapabilityMissing).
func plDebugBoundedRun(db *sql.DB, label string, timeout time.Duration, fn func() error) error {
	if timeout <= 0 {
		timeout = plDebugCallTimeout
	}
	done := make(chan error, 1)
	go func() {
		// A panic inside the worker -- a nil pool, a driver that gives up in a
		// way this file does not expect -- must not take the whole agent process
		// down from a goroutine, which nothing could recover. It is reported as
		// this call's error instead.
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- fmt.Errorf("%s panicked: %v", label, recovered)
			}
		}()
		done <- fn()
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		plDebugLogf("%s did not return within %s; abandoning the connection to release it", label, timeout)
		if db != nil {
			// DB.Close waits for in-flight statements -- the very statement that
			// is stuck -- so it must not run on the caller's goroutine.
			go func() { _ = db.Close() }()
		}
		return &plDebugCallTimeoutError{Label: label, Timeout: timeout}
	}
}

// debugCallTimeout is the bound for one debugger-side DBMS_DEBUG call.
func (p *plDebugSession) debugCallTimeout() time.Duration {
	p.callMu.Lock()
	defer p.callMu.Unlock()
	if p.callTimeout > 0 {
		return p.callTimeout
	}
	return plDebugCallTimeout
}

// debugReleaseTimeout is the bound for one teardown call.
func (p *plDebugSession) debugReleaseTimeout() time.Duration {
	p.callMu.Lock()
	defer p.callMu.Unlock()
	if p.releaseTimeout > 0 {
		return p.releaseTimeout
	}
	return plDebugReleaseTimeout
}

// debuggerFailure reports the error every debugger-side call must fail with once
// the debugger connection was abandoned; nil while the session is healthy. This
// is the state guard: a second PROBE call must never be attempted on a session
// whose server side is known to be gone, because it would only block again.
func (p *plDebugSession) debuggerFailure() error {
	p.callMu.Lock()
	defer p.callMu.Unlock()
	if !p.debuggerBroken {
		return nil
	}
	return fmt.Errorf("the debugger connection of this PL/SQL debug session was abandoned %s; "+
		"no further DBMS_DEBUG call can be issued (close the session and start a new one)", p.debuggerBrokenBy)
}

// abandonDebugger marks the debugger connection unusable and records why. The
// pool itself was already closed by plDebugBoundedRun (or by cancelPendingCalls),
// which is what releases the blocked call.
func (p *plDebugSession) abandonDebugger(reason string) {
	p.callMu.Lock()
	if p.debuggerBroken {
		p.callMu.Unlock()
		return
	}
	p.debuggerBroken = true
	p.debuggerBrokenBy = reason
	p.callMu.Unlock()
	plDebugLogf("the debugger connection of session %s is abandoned %s", p.debugID, reason)
}

// cancelPendingCalls is the client-cancel path (cancel_session): it abandons both
// connections right away so an RPC stuck in a DBMS_DEBUG call the server is not
// answering is released by the socket close, instead of making the user wait for
// the call timeout. The close runs in the background -- DB.Close waits for the
// in-flight statement, the very one being cancelled.
func (p *plDebugSession) cancelPendingCalls() {
	p.abandonDebugger("by a client cancel")
	debugger, debuggee := p.debugger, p.debuggee
	go func() {
		if debugger != nil {
			_ = debugger.Close()
		}
		if debuggee != nil {
			_ = debuggee.Close()
		}
	}()
}

// cancelPlDebugCalls abandons every live PL/SQL debug session of this server, the
// way cancelActiveQuery cancels the tracked queries: the blocked server call is
// released by dropping its connection, and the session guard keeps the next
// pl_debug_* request from touching the dead attachment again.
func (s *server) cancelPlDebugCalls() {
	s.plDebugMu.Lock()
	sessions := make([]*plDebugSession, 0, len(s.plDebugSessions))
	for _, session := range s.plDebugSessions {
		sessions = append(sessions, session)
	}
	s.plDebugMu.Unlock()
	for _, session := range sessions {
		session.cancelPendingCalls()
	}
}

// plDebugGuarded runs one debugger-side call with a hard timeout. A call that
// does not return marks the session broken, and every later call fails at once
// with that state instead of touching the server a second time.
func (p *plDebugSession) plDebugGuarded(label string, timeout time.Duration, fn func() error) error {
	if err := p.debuggerFailure(); err != nil {
		return err
	}
	err := plDebugBoundedRun(p.debugger, label, timeout, fn)
	var timeoutErr *plDebugCallTimeoutError
	if errors.As(err, &timeoutErr) {
		p.abandonDebugger(fmt.Sprintf("after %s timed out", timeoutErr.Label))
	}
	return err
}

// plDebugDebuggerExec runs a raw debugger-side DBMS_DEBUG statement -- one with
// no helper-package wrapper, i.e. ATTACH_SESSION and DETACH_SESSION -- under the
// same timeout and state guard as the wrapper calls.
func (p *plDebugSession) plDebugDebuggerExec(label, query string, timeout time.Duration, args ...any) error {
	return p.plDebugGuarded(label, timeout, func() error {
		_, err := p.debugger.Exec(query, args...)
		return err
	})
}

// plDebugDriverArgs rewrites the OUT bindings of the debuggee call -- a function's
// return value and the target's OUT parameters, both rendered as sql.Out by
// plDebugTargetRoutine -- into the OUT type the driver in use understands. Plain
// input values pass through untouched.
func plDebugDriverArgs(oci bool, args []interface{}) []any {
	converted := make([]any, 0, len(args))
	for _, arg := range args {
		if out, ok := arg.(sql.Out); ok {
			converted = append(converted, plDebugOutArg(oci, out.Dest))
			continue
		}
		converted = append(converted, arg)
	}
	return converted
}

// plDebugGetLineArgs returns the OUT bindings one DBX_GET_LINE call needs.
func plDebugGetLineArgs(oci bool, line *string, status *int) []any {
	return plDebugOutArgs(oci, line, status)
}

// plDebugGetLine reads one buffered DBMS_OUTPUT line out of the helper package.
func plDebugGetLine(db *sql.DB, oci bool, owner string, line *string, status *int) error {
	return plDebugHelperCall(db, oci, owner, procGetLine, nil, line, status)
}

// log reads DBMS_OUTPUT from the debuggee connection.
//
// The debuggee's DBMS_OUTPUT buffer lives in that one session's PGA and DBMS_OUTPUT
// has no cross-session read, so this can only ever be read from the debuggee
// connection itself. What makes that awkward is debug mode:
//
//   - While the target is still parked the debuggee's single pooled connection is
//     inside the target statement, so a drain would wait for the pool -- i.e. for
//     the very goroutine that only proceeds when the debugger drives it. The
//     terminated gate below is what keeps that from deadlocking the session.
//   - After DEBUG_ON, every PL/SQL call in that session parks for the debuggee's own
//     DBMS_DEBUG.SET_TIMEOUT (measured on Oracle 19c EE: SET_TIMEOUT(5) -> the first
//     post-DEBUG_ON statement answered after 5070ms, SET_TIMEOUT(120) -> after
//     20057ms; a plain SQL SELECT kept answering in 25ms, and with
//     SET_TIMEOUT_BEHAVIOUR(2) the park turns debug mode off, so it is paid once).
//     A drain bounded below that value can therefore never finish, which is exactly
//     how the previous 5s bound ended up closing the debuggee pool and losing both
//     the log and the session.
//
// Two mechanisms answer that, in this order:
//
//  1. The target block captures the buffer for itself as its trailing statement
//     (plDebugAnonymousBlock): it runs while the debugger still drives the program,
//     so it does not park at all, and it also lowers the session's remaining park.
//     target.CapturedOutput carries it here through runTarget.
//  2. Anything the capture did not get -- a buffer larger than one chunk, an
//     anonymous-block target, a program that was aborted or raised before its last
//     statement -- is read with DBX_FETCH_OUTPUT under plDebugLogParkTimeout, which
//     sits above SET_TIMEOUT on purpose, and with plDebugBoundedRunKeepPool so a
//     read that still overruns cannot damage the session or drop its connection.
//
// The result is cached: once the buffer is drained to its end, a later request is
// answered from memory and never touches the debuggee connection again.
func (p *plDebugSession) log() (map[string]interface{}, error) {
	p.mu.Lock()
	if !p.terminated {
		// The target statement is still in flight and holds the debuggee's only
		// connection; the buffer cannot be read yet (see the doc comment above).
		response := p.snapshot("")
		response["output"] = ""
		p.mu.Unlock()
		return response, nil
	}
	if p.logComplete {
		response := p.snapshot("")
		response["output"] = p.logText
		p.mu.Unlock()
		return response, nil
	}
	targetDone := p.targetDone
	p.mu.Unlock()

	// terminated means "the interpreter is done", not "the target statement
	// returned": a resume reports reason_knl_exit a few milliseconds before the
	// debuggee's Exec has handed its connection back, and the block's own capture
	// statement runs inside that very statement. Draining before it returns would
	// therefore read an already-emptied buffer (measured on 19c EE: the first
	// get_log answered "" after 1060ms and only the next one carried the text). The
	// wait is bounded and holds no lock -- runTarget needs p.mu to publish the
	// captured text, so waiting under it would deadlock.
	p.waitForTargetReturn(targetDone)

	p.mu.Lock()
	defer p.mu.Unlock()
	response := p.snapshot("")
	if p.logComplete {
		response["output"] = p.logText
		return response, nil
	}
	output, complete, err := p.drainDebuggeeOutputLocked()
	p.logText = output
	p.logComplete = complete
	response["output"] = output
	if err != nil {
		// Reading the buffer is diagnostic: a failed drain is reported next to
		// whatever was read, and can never take a finished debug session down.
		response["message"] = "DBMS_OUTPUT could not be read completely: " + err.Error()
	}
	return response, nil
}

// waitForTargetReturn waits, bounded, for the debuggee's target statement to return
// so its connection -- and with it the DBMS_OUTPUT buffer the block captured -- is
// free again. Unlike waitForTargetRelease it is a diagnostic wait: it never closes
// anything, and a debuggee the server keeps parked is simply read later.
func (p *plDebugSession) waitForTargetReturn(targetDone chan struct{}) {
	if targetDone == nil {
		return
	}
	p.mu.Lock()
	timeout := p.logWaitTimeout
	p.mu.Unlock()
	if timeout <= 0 {
		timeout = plDebugLogParkTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-targetDone:
	case <-timer.C:
		plDebugLogf("the debuggee's target statement did not return within %s; reading its "+
			"DBMS_OUTPUT anyway (the connection and its buffer are left intact)",
			timeout)
	}
}

// drainDebuggeeOutputLocked finishes the DBMS_OUTPUT read the target block started.
// It appends to p.logText until the buffer is exhausted (complete) or a call fails.
// The caller holds p.mu.
func (p *plDebugSession) drainDebuggeeOutputLocked() (string, bool, error) {
	builder := &strings.Builder{}
	builder.WriteString(p.logText)
	for {
		var chunk string
		err := plDebugBoundedRunKeepPool(p.debuggee, procFetchOutput, plDebugLogParkTimeout, func() error {
			return plDebugFetchOutput(p.debuggee, p.oci, p.owner, plDebugLogChars, &chunk)
		})
		if err != nil {
			return builder.String(), false, err
		}
		if chunk == "" {
			return builder.String(), true, nil
		}
		if builder.Len() > 0 {
			builder.WriteString("\n")
		}
		builder.WriteString(chunk)
		if len(chunk) < plDebugLogChars {
			return builder.String(), true, nil
		}
		// A full chunk means the server stopped exactly at the requested size and may
		// still hold more; DBX_FETCH_OUTPUT kept the line it could not fit, so the
		// next call continues at the same line boundary. That call is cheap: the
		// first one already lowered the session's remaining park (see the helper).
	}
}

// Close aborts a still-parked debuggee (best effort), detaches the debugger and
// releases both connections.
//
// Every step is bounded and every debugger-side step is skipped once the
// connection was abandoned: a teardown that waited for a PROBE call the server
// never answers would turn pl_debug_close into exactly the permanent hang the
// start used to have.
//
// DEBUG_OFF deliberately does NOT run here any more. The measurements below are what
// removed it; it was there to make the debuggee session stop debugging, and it cannot
// do that inside any client-side bound:
//
//   - DBMS_DEBUG.DEBUG_OFF is itself PL/SQL, and the DBMS_DEBUG package spec says of
//     it: "The server does not handle this entrypoint specially. Therefore it will
//     attempt to debug this entrypoint." Once DEBUG_ON has marked the session, EVERY
//     PL/SQL call in it is instrumented and parks waiting for a debugger.
//   - Measured on Oracle 19c EE: with SET_TIMEOUT(12), DEBUG_OFF returned only after
//     12.078s; with SET_TIMEOUT(10) a plain DBMS_OUTPUT.PUT_LINE returned only after
//     10.115s; a pure SQL SELECT was unaffected (64ms). The park is released by
//     SET_TIMEOUT_BEHAVIOUR(2) (nodebug_on_timeout, "Turn debug-mode OFF and then
//     continue execution"), i.e. only after the whole server-side timeout -- 120s
//     here -- which is why the old 5s bound always reported
//     "DBMS_DEBUG.DEBUG_OFF did not return within 5s".
//   - The timeout cannot be shortened on the way out either: SET_TIMEOUT is a PL/SQL
//     function, so "SELECT DBMS_DEBUG.SET_TIMEOUT(n) FROM DUAL" parks as well
//     (measured: it never returned after DEBUG_ON, while the same query took 56ms
//     before it).
//   - Having the still-attached debugger drive the parked DEBUG_OFF does not work
//     either: DBX_CNT_EXIT (continue(break_next_line) until the interpreter exits) timed
//     out after 20s while DEBUG_OFF returned at 20.307s, i.e. exactly when its own
//     SET_TIMEOUT(20) expired.
//
// The package spec also says DEBUG_OFF "is not necessary to call this function before
// logging the session off", and that is what Close does instead: the debuggee
// connection is closed, which ends the session -- and with it debug mode -- for real.
// The abort above (and the wait for the target's statement to return) is what makes
// that close possible at all, because database/sql cannot close a connection that
// still has a statement in flight.
func (p *plDebugSession) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	terminated := p.terminated
	targetDone := p.targetDone
	p.mu.Unlock()

	if p.debuggerFailure() == nil && !terminated {
		var abortedResult int
		var abortedMessage string
		// Best effort: the error is dropped, but the bindings still have to
		// match the driver (the abort helper reports through two OUT registers).
		// This is the step that releases a debuggee parked at a breakpoint: on
		// 19c EE the debuggee's own statement then returns with
		// "ORA-06543: PL/SQL: execution error - execution aborted" (measured).
		_ = p.plDebugGuarded(procCntAbort, p.debugReleaseTimeout(), func() error {
			return plDebugHelperCall(p.debugger, p.oci, p.owner, procCntAbort, nil, &abortedResult, &abortedMessage)
		})
	}
	// Wait for the debuggee's statement to return before closing its pool: the
	// physical session is only released once that statement has handed its
	// connection back, and database/sql's DB.Close cannot close an in-use
	// connection. Bounded -- a debuggee the server keeps parked (an abandoned
	// debugger could not abort it) is left to its own SET_TIMEOUT, and the pools are
	// still closed below.
	p.waitForTargetRelease(targetDone)
	if p.debuggerFailure() == nil {
		// Unmount the debugger session before dropping its connection; ODC does
		// the same and it releases the interpreter's attachment on the debuggee.
		_ = p.plDebugDebuggerExec("DBMS_DEBUG.DETACH_SESSION", "CALL DBMS_DEBUG.DETACH_SESSION()", p.debugReleaseTimeout())
	}
	p.closePools()
	return nil
}

// waitForTargetRelease waits, bounded, for the debuggee's target statement to return.
// It reports whether the connection was released; a session whose target goroutine was
// never started (no channel) counts as released.
func (p *plDebugSession) waitForTargetRelease(targetDone chan struct{}) bool {
	if targetDone == nil {
		return true
	}
	timer := time.NewTimer(p.debugReleaseTimeout())
	defer timer.Stop()
	select {
	case <-targetDone:
		return true
	case <-timer.C:
		plDebugLogf("the debuggee's target statement did not return within %s; closing its pool anyway "+
			"(the server releases a debuggee this session could not abort only when its own SET_TIMEOUT expires)",
			p.debugReleaseTimeout())
		return false
	}
}

// finishTarget records that the debuggee's target statement returned and releases
// every waiter (Close).
func (p *plDebugSession) finishTarget() {
	p.mu.Lock()
	p.terminated = true
	p.mu.Unlock()
	p.targetOnce.Do(func() {
		if p.targetDone != nil {
			close(p.targetDone)
		}
	})
}

// closePools releases both pools, bounded, and always calls Close on both of them.
//
// It is the teardown's last step and the only thing that actually ends the two server
// sessions: database/sql's DB.Close closes the free connections (after Close the pool
// also closes every connection that is handed back later), which is why Close waits for
// the debuggee's statement first. What DB.Close cannot do is close a connection that
// still has a statement in flight, and go-ora cannot be interrupted mid-call (see
// plDebugBoundedRun) -- so the guarantee this teardown gives is "both pools are closed
// and no statement is left in flight", not "a statement the server never answers is
// killed": that one only ends when the server-side SET_TIMEOUT releases it.
//
// The wait below is capped because Close waits for in-flight statements, and the
// in-flight statement is exactly the one that had to be abandoned; the close then
// finishes in the background.
func (p *plDebugSession) closePools() {
	closed := make(chan struct{})
	go func() {
		if p.debugger != nil {
			_ = p.debugger.Close()
		}
		if p.debuggee != nil {
			_ = p.debuggee.Close()
		}
		close(closed)
	}()
	timer := time.NewTimer(plDebugCloseWaitTimeout)
	defer timer.Stop()
	select {
	case <-closed:
	case <-timer.C:
		plDebugLogf("closing the PL/SQL debug connections did not finish within %s; leaving it to the background",
			plDebugCloseWaitTimeout)
	}
}

// -- helpers -----------------------------------------------------------------

// runTarget executes the debugging target on the debuggee connection. The
// statement blocks until the debugger drives the program to completion (or
// abort), so this runs on its own goroutine.
func (p *plDebugSession) runTarget(request map[string]interface{}) {
	// The release channel exists before the first statement runs: Close uses it to wait
	// for this statement to return. plDebugStart creates it before it starts this
	// goroutine; the check keeps a session built by hand (the tests call runTarget
	// directly) from losing the release signal.
	p.mu.Lock()
	if p.targetDone == nil {
		p.targetDone = make(chan struct{})
	}
	p.mu.Unlock()
	defer func() {
		// finishTarget marks the debuggee finished and releases Close, which waits
		// for this statement to return before it closes the debuggee pool. DEBUG_OFF
		// deliberately does NOT run here: see Close for the measurements that show it
		// can only be released by the server-side timeout, which is why the teardown
		// closes the connection instead (the package spec sanctions that: DEBUG_OFF
		// "is not necessary to call this function before logging the session off").
		p.finishTarget()
	}()

	objectType := strings.ToUpper(strings.TrimSpace(stringField(request, "objectType")))
	if objectType == "ANONYMOUS" {
		source := stripTrailingSlash(stringField(request, "source"))
		// The submitted block carries the same trailing capture as a
		// PROCEDURE/FUNCTION target, and for the same reason: it is the only DBMS_OUTPUT
		// read that does not park. The user's text is kept byte for byte up to its own
		// final END; -- the capture is inserted in front of it instead of after it,
		// because a top-level anonymous block cannot have a statement after its END --
		// so every caller-supplied breakpoint line number still points at the same
		// source line. A source that does not end in a bare END; is submitted verbatim
		// and falls back to the Go-side drain.
		block, captures := plDebugAnonymousWithCapture(source, p.owner)
		var captured string
		args := []any{}
		if captures {
			args = append(args, plDebugLogOutArg(p.oci, &captured))
		}
		if _, err := p.debuggee.Exec(block, args...); err != nil {
			p.mu.Lock()
			p.targetErr = err.Error()
			p.mu.Unlock()
			return
		}
		if captured != "" {
			p.mu.Lock()
			p.logText = captured
			p.logComplete = len(captured) < plDebugLogChars
			p.mu.Unlock()
		}
		return
	}
	target, routineErr := plDebugResolveTarget(p.owner, request)
	if routineErr != nil {
		p.mu.Lock()
		p.targetErr = routineErr.Error()
		p.mu.Unlock()
		return
	}

	var resultValue string
	callArgs := make([]interface{}, 0, len(target.Params)+1)
	if target.IsFunction {
		callArgs = append(callArgs, sql.Out{Dest: &resultValue})
	}
	callArgs = append(callArgs, target.Params...)
	// The trailing capture statement of the block binds last, and it needs a buffer
	// big enough for one full DBX_FETCH_OUTPUT chunk, which is why it does not go
	// through plDebugDriverArgs' 4000-character default.
	args := plDebugDriverArgs(p.oci, callArgs)
	captured := ""
	if target.CapturedOutput != nil {
		args = append(args, plDebugLogOutArg(p.oci, &captured))
	}
	// The target block is Exec'd here, so the OUT bindings only need the type and
	// (for go-ora) the buffer size the driver in use understands.
	if _, err := p.debuggee.Exec(target.Block, args...); err != nil {
		p.mu.Lock()
		p.targetErr = err.Error()
		p.mu.Unlock()
		return
	}
	if captured != "" {
		p.mu.Lock()
		p.logText = captured
		// A chunk shorter than what the capture asked for means the buffer was read
		// to its end, so no later pl_debug_get_log has to touch the debuggee
		// connection again (see plDebugSession.log).
		p.logComplete = len(captured) < plDebugLogChars
		p.mu.Unlock()
	}
}

// plDebugTarget is one resolved debugging target: the qualified routine, the
// anonymous block that invokes it, and the bound call arguments.
type plDebugTarget struct {
	Routine    string
	Program    string
	Block      string
	Params     []interface{}
	IsFunction bool
	// Package is the package a subprogram target lives in, empty for a standalone
	// routine or an anonymous block. It is needed because DBMS_DEBUG reports a
	// package subprogram's frame as the *package* and not as the subprogram: measured
	// on Oracle 19c EE against DBX_DEBUG.DBX_MSCHK_PKG, run_info came back with
	// program.name = DBX_MSCHK_PKG, program.entrypointname NULL and namespace = 2
	// (namespace_pkg_body) at the subprogram's own first line, while the backtrace
	// said "[Line 2]   PROCEDURE RUN_MSCHK IS". The package name alone cannot say
	// *which* subprogram of that body is executing, so the source line decides; see
	// plDebugFrameMatchesProgram.
	Package string
	// CapturedOutput holds the OUT destination of the trailing DBMS_OUTPUT capture
	// statement (see plDebugAnonymousBlock) for a PROCEDURE/FUNCTION target, nil when
	// the block has no capture (nothing to bind, no statement).
	CapturedOutput *string
}

// plDebugResolveTarget resolves the qualified routine, binds its parameters and
// renders the anonymous block the debuggee executes. The very same block text is
// what debugBefore locates the call line in, so the debugger arms its breakpoint
// on exactly the statement the debuggee is running.
func plDebugResolveTarget(owner string, request map[string]interface{}) (plDebugTarget, error) {
	routine, params, isFunction, err := plDebugTargetRoutine(owner, request)
	if err != nil {
		return plDebugTarget{}, err
	}
	program := strings.ToUpper(strings.TrimSpace(stringField(request, "objectName")))
	packageName := strings.ToUpper(strings.TrimSpace(stringField(request, "packageName")))
	switch {
	case packageName != "":
		program = packageName + "." + program
	case strings.IndexByte(program, '.') > 0:
		// Some callers qualify the subprogram inside objectName ("PKG.PROC"); the
		// rendered program keeps that shape and the package is split off for the
		// frame match.
		dot := strings.IndexByte(program, '.')
		packageName = program[:dot]
	}
	return plDebugTarget{
		Routine:        routine,
		Program:        program,
		Package:        packageName,
		Block:          plDebugAnonymousBlock(owner, routine, isFunction, len(params)),
		Params:         params,
		IsFunction:     isFunction,
		CapturedOutput: new(string),
	}, nil
}

// plDebugTargetPackage returns the package a PROCEDURE/FUNCTION target lives in and
// the subprogram's own name, from either the explicit packageName attribute or the
// dotted objectName form. ok is false for anything that is not a subprogram target.
func plDebugTargetPackage(request map[string]interface{}) (packageName, subprogram string, ok bool) {
	switch strings.ToUpper(strings.TrimSpace(stringField(request, "objectType"))) {
	case "PROCEDURE", "FUNCTION":
	default:
		return "", "", false
	}
	packageName = strings.ToUpper(strings.TrimSpace(stringField(request, "packageName")))
	subprogram = strings.ToUpper(strings.TrimSpace(stringField(request, "objectName")))
	if packageName == "" {
		dot := strings.IndexByte(subprogram, '.')
		if dot <= 0 {
			return "", "", false
		}
		packageName, subprogram = subprogram[:dot], subprogram[dot+1:]
	}
	if !plDebugPlainIdentifier(packageName) || !plDebugPlainIdentifier(subprogram) {
		return "", "", false
	}
	return packageName, subprogram, true
}

// plDebugSourceLine is one ALL_SOURCE row of the object being inspected.
type plDebugSourceLine struct {
	Line int
	Text string
}

// plDebugLineRange is an inclusive source-line range inside one package body.
type plDebugLineRange struct {
	First int
	Last  int
}

// plDebugPackageBodySourceQuery reads the whole body of one package. It is a plain
// dictionary read (no DBMS_DEBUG call, no PL/SQL), which is why it needs no bound of its
// own: the neighbouring probes (plDebugPackageVersionCurrent, plDebugOverloadCount) read
// ALL_SOURCE the same way, and after DEBUG_ON a plain SELECT is the only thing in that
// session that does not park in the debugger.
const plDebugPackageBodySourceQuery = `SELECT LINE, TEXT FROM ALL_SOURCE
	  WHERE OWNER = :1 AND NAME = :2 AND TYPE = 'PACKAGE BODY' ORDER BY LINE`

// plDebugNestedRange is the source-line range of a subprogram declared *inside* the
// target's declaration section.
//
// It exists because such a subprogram's body lines are inside the target's own range:
// with only the target range to go on, a frame parked in the nested routine would be
// labelled with the enclosing routine's name (measured on 19c EE against
// DBX_DEBUG.DBX_G2_NEST, where a breakpoint inside RUN_INNER reported line 7 --
// "END RUN_INNER;" -- while the session was started for RUN_OUTER). DBMS_DEBUG reports
// only the package, so the nested range is the only signal that says otherwise.
type plDebugNestedRange struct {
	Name  string
	First int
	Last  int
}

// plDebugNestedSubprogramRanges lists the subprograms declared inside the target's own
// range. Best effort: a nested subprogram whose range cannot be closed is skipped, which
// only means its lines keep the enclosing routine's label.
func plDebugNestedSubprogramRanges(lines []plDebugSourceLine, target plDebugLineRange) []plDebugNestedRange {
	if target.First <= 0 || target.Last < target.First {
		return nil
	}
	inBlockComment := false
	seen := map[string]bool{}
	ranges := make([]plDebugNestedRange, 0, 4)
	for _, line := range lines {
		if line.Line <= target.First || line.Line > target.Last {
			continue
		}
		trimmed := strings.TrimSpace(plDebugStripSQLComments(line.Text, &inBlockComment))
		if !plDebugAnySubprogramDeclaration(trimmed) {
			continue
		}
		name := plDebugSubprogramFromDeclaration(trimmed)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		first, last, closure, found := plDebugSubprogramRange(lines, name)
		if !found || closure == plDebugRangeByBodyEnd {
			continue
		}
		if first < target.First || first > target.Last {
			continue
		}
		if last > target.Last {
			last = target.Last
		}
		ranges = append(ranges, plDebugNestedRange{Name: name, First: first, Last: last})
	}
	return ranges
}

// plDebugNestedLabel names the innermost nested subprogram whose range contains the
// line, or "" when the line belongs to the target's own body.
func plDebugNestedLabel(ranges []plDebugNestedRange, line int) string {
	name := ""
	width := 0
	for _, nested := range ranges {
		if line < nested.First || line > nested.Last {
			continue
		}
		// The innermost (narrowest) range wins when one nested routine is declared
		// inside another.
		span := nested.Last - nested.First
		if name == "" || span < width {
			name, width = nested.Name, span
		}
	}
	return name
}

// plDebugResolveTargetLines reads the source-line range of the target subprogram inside
// its package body and reports how the range was derived. It is best effort: a target
// whose range cannot be read keeps a zero range, and plDebugFrameMatchesProgram then
// accepts the package frame instead of failing the start (a wrong line is recoverable, a
// start that refuses to enter the subprogram is not).
//
// The returned note is the degradation the caller has to publish as debugInfo; it is
// empty for a range closed by the subprogram's own END <name>;. A range the scan could
// not close at all is deliberately NOT published: an over-wide range would make the
// frame match accept the package's initialization section as the target, and the label
// would then name the subprogram for a line it does not own.
func plDebugResolveTargetLines(db *sql.DB, owner string, request map[string]interface{}) (plDebugLineRange, []plDebugNestedRange, string) {
	packageName, subprogram, ok := plDebugTargetPackage(request)
	if !ok {
		return plDebugLineRange{}, nil, ""
	}
	rows, err := db.Query(plDebugPackageBodySourceQuery, owner, packageName)
	if err != nil {
		note := fmt.Sprintf("the source-line range of %s.%s could not be read (%v), so the session falls back to the "+
			"package frame: the current routine label is reported as the bare package name until a line is "+
			"proven to be inside the subprogram", packageName, subprogram, err)
		plDebugLogf("%s", note)
		return plDebugLineRange{}, nil, note
	}
	defer rows.Close()
	lines := make([]plDebugSourceLine, 0, 256)
	for rows.Next() {
		var line plDebugSourceLine
		if scanErr := rows.Scan(&line.Line, &line.Text); scanErr != nil {
			note := fmt.Sprintf("reading the %s.%s body failed at row %d (%v); the subprogram's source range is left "+
				"unknown and the current routine label falls back to the bare package name", owner, packageName,
				len(lines)+1, scanErr)
			plDebugLogf("%s", note)
			return plDebugLineRange{}, nil, note
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		note := fmt.Sprintf("reading the %s.%s body failed (%v); the subprogram's source range is left unknown and the "+
			"current routine label falls back to the bare package name", owner, packageName, err)
		plDebugLogf("%s", note)
		return plDebugLineRange{}, nil, note
	}
	first, last, closure, found := plDebugSubprogramRange(lines, subprogram)
	if !found {
		note := fmt.Sprintf("%s.%s does not declare %s in its body, so the frame match falls back to the package and the "+
			"current routine label is the bare package name", owner, packageName, subprogram)
		plDebugLogf("%s", note)
		return plDebugLineRange{}, nil, note
	}
	if closure == plDebugRangeByBodyEnd {
		// Nothing the scan recognises closed the subprogram, so the range would run to
		// the end of the package body -- over the initialization section the interpreter
		// reports as the same package frame. Publishing that range would make the label
		// claim the subprogram for a line that belongs to the package itself.
		note := fmt.Sprintf("the source range of %s.%s could not be closed (%s); it is left unknown instead of guessed, "+
			"so the session falls back to the package frame and the current routine label is the bare package name "+
			"outside the subprogram", owner, subprogram, plDebugRangeClosureName(closure))
		plDebugLogf("%s", note)
		return plDebugLineRange{}, nil, note
	}
	target := plDebugLineRange{First: first, Last: last}
	nested := plDebugNestedSubprogramRanges(lines, target)
	if closure == plDebugRangeBySibling || closure == plDebugRangeByOwnEnd {
		// Firm enough to use, but the terminator is a fallback rather than the
		// subprogram's own END <name>;, which is what the caller wants to know when the
		// reported lines look off.
		note := fmt.Sprintf("the source range of %s.%s was closed by %s rather than by the subprogram's own END <name>; "+
			"(lines %d-%d)", owner, subprogram, plDebugRangeClosureName(closure), first, last)
		plDebugLogf("%s", note)
		return target, nested, note
	}
	return target, nested, ""
}

// plDebugSubprogramDeclaration reports whether one comment-free source line starts the
// declaration of the named subprogram: optional whitespace, PROCEDURE or FUNCTION, and
// the name as a whole identifier.
func plDebugSubprogramDeclaration(text, subprogram string) bool {
	trimmed := strings.TrimSpace(text)
	upper := strings.ToUpper(trimmed)
	keyword := ""
	switch {
	case strings.HasPrefix(upper, "PROCEDURE"):
		keyword = "PROCEDURE"
	case strings.HasPrefix(upper, "FUNCTION"):
		keyword = "FUNCTION"
	default:
		return false
	}
	rest := strings.TrimSpace(trimmed[len(keyword):])
	name := strings.ToUpper(strings.TrimSpace(subprogram))
	if !strings.HasPrefix(strings.ToUpper(rest), name) {
		return false
	}
	remainder := rest[len(name):]
	return remainder == "" || !plDebugIdentifierByte(remainder[0])
}

// plDebugAnySubprogramDeclaration reports whether one line opens a subprogram
// declaration of any name. It is used to end a range at the next sibling subprogram.
func plDebugAnySubprogramDeclaration(text string) bool {
	upper := strings.ToUpper(strings.TrimSpace(text))
	return strings.HasPrefix(upper, "PROCEDURE") || strings.HasPrefix(upper, "FUNCTION")
}

// plDebugEndsSubprogram reports whether one line is the "END <name>;" that closes the
// named subprogram.
func plDebugEndsSubprogram(text, subprogram string) bool {
	upper := strings.ToUpper(strings.TrimSpace(text))
	if !strings.HasPrefix(upper, "END") {
		return false
	}
	rest := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(upper[len("END"):]), ";"))
	return rest != "" && rest == strings.ToUpper(strings.TrimSpace(subprogram))
}

// plDebugRangeClosure records how plDebugSubprogramRange decided where a subprogram
// ends. Only the first three are firm enough to publish a range: a body the scan
// could not close at all is reported and left unknown instead of being guessed,
// because an over-wide range would make plDebugFrameMatchesProgram accept a frame in
// the package's initialization section and currentProgramLabel would then name the
// target subprogram for a line the target does not own.
type plDebugRangeClosure int

const (
	// plDebugRangeUnclosed is the zero value: no range at all.
	plDebugRangeUnclosed plDebugRangeClosure = iota
	// plDebugRangeByName is the subprogram's own "END <name>;".
	plDebugRangeByName
	// plDebugRangeBySibling is the next subprogram declared at the target's own
	// indentation -- the subprogram has no named END of its own.
	plDebugRangeBySibling
	// plDebugRangeByOwnEnd is a statement-level "END;" at the target's own
	// indentation, i.e. an unnamed END that closes the target's own block.
	plDebugRangeByOwnEnd
	// plDebugRangeByOuterBegin is a BEGIN at (or, for an unindented body, exactly at)
	// the target's own indentation after its block closed: the package's
	// initialization section, which must not be part of the range.
	plDebugRangeByOuterBegin
	// plDebugRangeByBodyEnd is nothing the scan could recognise: the range ran to the
	// last line of the body.
	plDebugRangeByBodyEnd
)

// plDebugRangeClosureName spells a closure for the debugInfo note.
func plDebugRangeClosureName(closure plDebugRangeClosure) string {
	switch closure {
	case plDebugRangeByName:
		return "the subprogram's own END <name>;"
	case plDebugRangeBySibling:
		return "the next sibling subprogram declaration"
	case plDebugRangeByOwnEnd:
		return "an unnamed END; at the subprogram's own indentation"
	case plDebugRangeByOuterBegin:
		return "a BEGIN at the subprogram's own indentation (the package's initialization section)"
	case plDebugRangeByBodyEnd:
		return "the end of the package body"
	}
	return "no terminator"
}

// plDebugSubprogramRange locates one subprogram inside a package body's source and
// returns its inclusive line range plus how it was closed.
//
// The body's own initialization section must NOT be part of the range, because the
// interpreter reports it as the same package frame: measured on 19c EE against
// DBX_DEBUG.DBX_MSCHK_PKG2 (which has a three-line initialization section), the start
// sequence's CONTINUE(break_any_call) stopped at reason_enter on line 1 (the package
// header), then on lines 8, 9 and 10 (the initialization section) and only then at
// reason_enter on line 2 -- inside RUN_MSCHK. The range is therefore closed by the
// subprogram's own "END <name>;", and failing that by the next sibling declaration, by
// an unnamed END at the declaration's own indentation, or by a BEGIN at (or, for a body
// that is not indented at all, exactly at) that indentation -- the package
// initialization section.
func plDebugSubprogramRange(lines []plDebugSourceLine, subprogram string) (first, last int, closure plDebugRangeClosure, found bool) {
	name := plDebugRoutineToken(subprogram)
	if name == "" {
		return 0, 0, plDebugRangeUnclosed, false
	}
	inBlockComment := false
	declarationIndex := -1
	declarationIndent := 0
	// ownBlockOpened records the target's own BEGIN, ownBlockEnded a statement-level
	// END seen at the target's own indentation. Together they are what lets the scan
	// recognise the package's initialization section in a body that carries no
	// indentation at all, where the "indent < declarationIndent" rule can never fire.
	ownBlockOpened := false
	ownBlockEnded := false
	lastIndex := len(lines) - 1
	for index, line := range lines {
		code := plDebugStripSQLComments(line.Text, &inBlockComment)
		trimmed := strings.TrimSpace(code)
		if trimmed == "" {
			continue
		}
		indent := len(code) - len(strings.TrimLeft(code, " \t"))
		if declarationIndex < 0 {
			if plDebugSubprogramDeclaration(trimmed, name) {
				declarationIndex, declarationIndent = index, indent
			}
			continue
		}
		upper := strings.ToUpper(trimmed)
		if plDebugEndsSubprogram(trimmed, name) {
			return lines[declarationIndex].Line, line.Line, plDebugRangeByName, true
		}
		if plDebugAnySubprogramDeclaration(trimmed) && indent <= declarationIndent {
			// A subprogram declared at the target's own indentation. Before the target's
			// own BEGIN that is the nested-vs-sibling ambiguity: the old heuristic ended
			// the range here and that stays, because closing early only makes the range
			// narrow (the frame match then reports its degradation) while running past a
			// sibling would widen it into code the target does not own.
			if index > declarationIndex {
				return lines[declarationIndex].Line, lines[index-1].Line, plDebugRangeBySibling, true
			}
		}
		if strings.HasPrefix(upper, "BEGIN") {
			if !ownBlockOpened {
				ownBlockOpened = true
				continue
			}
			if indent < declarationIndent || ownBlockEnded {
				// A BEGIN the target cannot own: shallower indentation, or the package's
				// initialization section in a body where every line starts in column 1.
				return lines[declarationIndex].Line, lines[index-1].Line, plDebugRangeByOuterBegin, true
			}
			continue
		}
		if ownBlockOpened && !ownBlockEnded && indent <= declarationIndent && plDebugEndsBlockStatement(trimmed) {
			ownBlockEnded = true
			lastIndex = index
			continue
		}
	}
	if ownBlockEnded {
		return lines[declarationIndex].Line, lines[lastIndex].Line, plDebugRangeByOwnEnd, true
	}
	if declarationIndex >= 0 {
		return lines[declarationIndex].Line, lines[len(lines)-1].Line, plDebugRangeByBodyEnd, true
	}
	return 0, 0, plDebugRangeUnclosed, false
}

// plDebugEndsBlockStatement reports whether one line is a PL/SQL *block* END
// statement -- "END;" or "END <name>;" -- and not the END of a nested construct,
// which must not close a subprogram range. END IF / END LOOP / END CASE all belong to
// a construct inside the block, and a body that is not indented at all cannot be told
// apart from them by indentation.
func plDebugEndsBlockStatement(trimmed string) bool {
	upper := strings.ToUpper(strings.TrimSpace(trimmed))
	if !strings.HasPrefix(upper, "END") {
		return false
	}
	rest := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(upper[len("END"):]), ";"))
	switch rest {
	case "IF", "LOOP", "CASE":
		return false
	}
	return true
}

// plDebugAnonymousBlock renders the anonymous block that calls the target. The
// call sits on its own line (line 2) so DBMS_DEBUG can be given that line number,
// which is what ODC gets out of the anonymous block its parser produces.
//
// A trailing statement captures the debuggee's DBMS_OUTPUT into an OUT binding
// (:dbxOutput). This is the whole point of the V6.3 drain: after DEBUG_ON every
// PL/SQL call in the debuggee session parks for the debuggee's own
// DBMS_DEBUG.SET_TIMEOUT (measured on Oracle 19c EE: SET_TIMEOUT(5) -> the first
// post-DEBUG_ON statement answered after 5070ms; a plain SQL SELECT kept answering
// in 25ms), so a drain issued after the program finished is either slow or, with
// the bound the agent used before, abandoned together with the debuggee pool. The
// trailing statement runs while the debugger is still inside CONTINUE, i.e. while
// the program is being driven -- the one state in which such a call does not park
// at all -- and it gets the output back through a normal OUT register.
func plDebugAnonymousBlock(owner, routine string, isFunction bool, paramCount int) string {
	var block strings.Builder
	block.WriteString("BEGIN\n  ")
	if isFunction {
		block.WriteString(":result := ")
	}
	block.WriteString(routine)
	block.WriteString("(")
	for index := 0; index < paramCount; index++ {
		if index > 0 {
			block.WriteString(", ")
		}
		block.WriteString(fmt.Sprintf(":p%d", index+1))
	}
	block.WriteString(");\n  :" + plDebugCaptureBind + " := " + plDebugQualifiedPrefix(owner) +
		"." + fmt.Sprintf("%s(%d)", procFetchOutput, plDebugLogChars) + ";\nEND;")
	return block.String()
}

// plDebugCaptureBind is the bind name of the trailing DBMS_OUTPUT capture.
const plDebugCaptureBind = "dbxOutput"

// plDebugAnonymousWithCapture inserts the DBMS_OUTPUT capture statement into a
// caller-supplied anonymous block, in front of the block's own final END;. It
// reports false (and returns the source unchanged) when the text does not end in a
// bare END;, because guessing where the block ends would corrupt the edit.
//
// An anonymous top-level block cannot carry a statement after its END, so the
// capture has to go before it; the text above the final END; is preserved
// byte-for-byte, which is what keeps a caller-supplied breakpoint line valid.
func plDebugAnonymousWithCapture(source, owner string) (string, bool) {
	trimmed := strings.TrimRight(source, " \t\r\n")
	upper := strings.ToUpper(trimmed)
	if !strings.HasSuffix(upper, "END;") {
		return source, false
	}
	head := strings.TrimRight(trimmed[:len(trimmed)-len("END;")], " \t\r\n")
	if strings.TrimSpace(upper[:len(upper)-len("END;")]) == "" {
		return source, false
	}
	if !strings.HasSuffix(head, "\n") {
		head += "\n"
	}
	return head + "  :" + plDebugCaptureBind + " := " + plDebugQualifiedPrefix(owner) +
		"." + fmt.Sprintf("%s(%d)", procFetchOutput, plDebugLogChars) + ";\nEND;", true
}

// plDebugAnonymousCallLine returns the 1-based line of the target routine call
// inside an anonymous block -- the equivalent of ODC's
// AnonymousBlockProcedureCall.getCallLine. It scans the block top to bottom and
// returns 0 when the routine is never called. Comment-only lines and anything
// inside /* */ are ignored (an ODC block opens with a banner comment and the call
// still has to report its physical line number); a call whose argument list
// starts on the following line still reports the line the call starts on.
func plDebugAnonymousCallLine(block, routine string) int {
	name := plDebugRoutineToken(routine)
	if name == "" {
		return 0
	}
	lines := strings.Split(block, "\n")
	code := make([]string, len(lines))
	inBlockComment := false
	for index, line := range lines {
		code[index] = plDebugStripSQLComments(line, &inBlockComment)
	}
	for index, line := range code {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if plDebugCodeCallsRoutine(line, routine) {
			return index + 1
		}
		if !plDebugLineNamesRoutine(line, routine) {
			continue
		}
		for next := index + 1; next < len(code); next++ {
			trimmed := strings.TrimSpace(code[next])
			if trimmed == "" {
				continue
			}
			if strings.HasPrefix(trimmed, "(") {
				return index + 1
			}
			break
		}
	}
	return 0
}

// plDebugCodeCallsRoutine reports whether one comment-free line of SQL text calls
// the routine: the routine's trailing identifier must be followed by "(" (spaces
// allowed). A qualified call ("OWNER"."PKG"."PROC") and a bare local call are
// both recognised, because only the trailing identifier is matched.
func plDebugCodeCallsRoutine(code, routine string) bool {
	name := plDebugRoutineToken(routine)
	if name == "" {
		return false
	}
	normalized := plDebugNormalizeIdentifier(code)
	for offset := 0; offset+len(name) <= len(normalized); {
		found := strings.Index(normalized[offset:], name)
		if found < 0 {
			return false
		}
		start := offset + found
		end := start + len(name)
		offset = end
		if end < len(normalized) && plDebugIdentifierByte(normalized[end]) {
			continue
		}
		if strings.HasPrefix(strings.TrimLeft(normalized[end:], " \t"), "(") {
			return true
		}
	}
	return false
}

// plDebugLineNamesRoutine reports whether the comment-free line ends with the
// routine's trailing identifier, i.e. the call's argument list opens on one of
// the following lines.
func plDebugLineNamesRoutine(code, routine string) bool {
	name := plDebugRoutineToken(routine)
	if name == "" {
		return false
	}
	return strings.HasSuffix(strings.TrimRight(plDebugNormalizeIdentifier(code), " \t"), name)
}

// plDebugRoutineToken reduces a qualified routine reference to its trailing,
// quote-free, upper-case identifier ("OWNER"."PKG"."PROC" -> PROC).
func plDebugRoutineToken(routine string) string {
	name := plDebugNormalizeIdentifier(routine)
	if dot := strings.LastIndexByte(name, '.'); dot >= 0 {
		name = name[dot+1:]
	}
	return strings.TrimSpace(name)
}

// plDebugNormalizeIdentifier upper-cases text and drops the double quotes that
// delimit Oracle identifiers, so `"PROC"`, `PROC` and `"OWNER"."PROC"` compare
// consistently. Whitespace is otherwise preserved.
func plDebugNormalizeIdentifier(text string) string {
	return strings.ToUpper(strings.NewReplacer(`"`, "", "\t", " ").Replace(text))
}

// plDebugIdentifierByte reports whether one byte can be part of an unquoted
// Oracle identifier (used to avoid matching a longer identifier's suffix).
func plDebugIdentifierByte(b byte) bool {
	return b == '_' || b == '$' || b == '#' ||
		(b >= '0' && b <= '9') || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

// plDebugStripSQLComments removes `--` line comments and `/* ... */` block
// comments from one line while preserving the rest of the text. The in-block
// state is carried across lines through inBlockComment; the removed bytes are
// replaced by nothing, so column positions shift but line numbers do not.
func plDebugStripSQLComments(line string, inBlockComment *bool) string {
	var builder strings.Builder
	for index := 0; index < len(line); {
		if *inBlockComment {
			end := strings.Index(line[index:], "*/")
			if end < 0 {
				return builder.String()
			}
			index += end + len("*/")
			*inBlockComment = false
			continue
		}
		switch {
		case strings.HasPrefix(line[index:], "--"):
			return builder.String()
		case strings.HasPrefix(line[index:], "/*"):
			*inBlockComment = true
			index += len("/*")
		default:
			builder.WriteByte(line[index])
			index++
		}
	}
	return builder.String()
}

// plDebugTargetRoutine resolves the qualified routine name and its bound
// parameters for the debuggee call.
func plDebugTargetRoutine(owner string, request map[string]interface{}) (string, []interface{}, bool, error) {
	objectType := strings.ToUpper(strings.TrimSpace(stringField(request, "objectType")))
	packageName := strings.ToUpper(strings.TrimSpace(stringField(request, "packageName")))
	objectName := strings.ToUpper(strings.TrimSpace(stringField(request, "objectName")))
	if objectName == "" {
		return "", nil, false, fmt.Errorf("object name is required")
	}
	var routine string
	if packageName != "" {
		routine = fmt.Sprintf(`"%s"."%s"."%s"`, owner, packageName, objectName)
	} else {
		routine = fmt.Sprintf(`"%s"."%s"`, owner, objectName)
	}
	var rawParams []plDebugParam
	if raw, ok := request["params"]; ok && raw != nil {
		if decoded, ok := raw.([]interface{}); ok {
			for _, item := range decoded {
				if paramMap, ok := item.(map[string]interface{}); ok {
					rawParams = append(rawParams, plDebugParam{
						Name:  stringField(paramMap, "name"),
						Mode:  stringField(paramMap, "mode"),
						Type:  stringField(paramMap, "type"),
						Value: stringField(paramMap, "value"),
					})
				}
			}
		}
	}
	args := make([]interface{}, 0, len(rawParams))
	for _, param := range rawParams {
		mode := strings.ToUpper(strings.TrimSpace(param.Mode))
		if mode == "OUT" {
			// Rendered as sql.Out here and converted to the driver's own OUT type
			// by plDebugDriverArgs when the target block is executed.
			args = append(args, sql.Out{Dest: new(string)})
			continue
		}
		args = append(args, param.Value)
	}
	return routine, args, objectType == "FUNCTION", nil
}

func (p *plDebugSession) snapshot(message string) map[string]interface{} {
	response := map[string]interface{}{
		"debugId":      p.debugID,
		"owner":        p.owner,
		"terminated":   p.terminated,
		"line":         p.lastLine,
		"program":      p.lastProgram,
		"programOwner": p.lastProgramOwner,
		"breakpoint":   p.lastBreakpoint,
		"reason":       p.lastReason,
		"stackDepth":   p.lastStackDepth,
		"error":        p.targetErr,
		"expired":      p.expired(),
		// stoppedOnException is true only when the last exception-mode resume
		// stopped on reason_exception / reason_handler.
		"stoppedOnException":  p.stoppedOnException,
		"exceptionBreakpoint": p.exceptionBreakpoint,
	}
	if message != "" {
		response["message"] = message
	}
	// debugInfo is only present when the start sequence had to restore the target's
	// PL/SQL debug information: it explains why a target that "should" never have been
	// steppable now is, and reports the DDL that was run against the user's object.
	if p.debugInfo != "" {
		response["debugInfo"] = p.debugInfo
	}
	return response
}

// currentProgramLabel names the routine the interpreter is parked in.
//
// A package subprogram is reported by its PACKAGE in run_info (the subprogram lives in
// program_info.entrypointname, which run_info does not carry), so the label is rebuilt
// from the data the session does have:
//
//   - the current frame's SOURCE line names the subprogram whenever the interpreter sits
//     on a declaration, which is exactly what a step-in produces -- this is what makes
//     stepping into a SIBLING subprogram of the same package label correctly instead of
//     keeping the routine the session was started for;
//   - otherwise a line inside the target's own source range is the target;
//   - anything else keeps the bare package name the engine reported: vague, never wrong.
func (p *plDebugSession) currentProgramLabel(frames []plDebugFrame) string {
	reported := p.lastProgram
	// The dedicated package field is not always populated -- the start path composes
	// target.Program ("PACKAGE.SUBPROGRAM") from the request -- so when it is empty the
	// package is taken from that label instead. Without this the guard below short
	// circuits and the whole label degrades to the bare package name run_info reported.
	packageName := p.targetPackage
	if packageName == "" {
		if dot := strings.LastIndex(p.targetProgram, "."); dot > 0 {
			packageName = p.targetProgram[:dot]
		}
	}
	// debugBefore publishes the composed "PACKAGE.SUBPROGRAM" label as the current
	// program before the first backtrace exists, so by the time the range rules below
	// run, the reported name can already be the target's own label. Without folding it
	// back to its package the guard right below would treat it as "the engine reported
	// some other unit" and return it unconditionally -- measured on 19c EE against a
	// package whose initialization section is longer than the step-in budget: the
	// session parked on line 44 of the initialization section and pl_debug_start still
	// named DBX_G2_LONG.RUN_LONG, a routine that line does not belong to.
	if p.targetProgram != "" && strings.EqualFold(reported, p.targetProgram) {
		reported = packageName
	}
	if reported == "" || packageName == "" || !strings.EqualFold(reported, packageName) {
		return reported
	}
	if len(frames) > 0 {
		if subprogram := plDebugSubprogramFromDeclaration(frames[0].Source); subprogram != "" {
			return packageName + "." + subprogram
		}
	}
	// A subprogram declared inside the target's declaration section owns its own body
	// lines even though they fall inside the target's range: naming the enclosing
	// routine there would be wrong (measured on 19c EE against DBX_DEBUG.DBX_G2_NEST,
	// where a breakpoint inside the nested RUN_INNER stopped on line 7 and the session
	// named the enclosing RUN_OUTER).
	if nested := plDebugNestedLabel(p.nestedLines, p.lastLine); nested != "" {
		return packageName + "." + nested
	}
	// Inside the target's own source range the session opened exactly this routine, so its
	// name is the accurate label for the current line.
	if p.targetProgram != "" && p.targetLines.First > 0 && p.targetLines.Last >= p.targetLines.First &&
		p.lastLine >= p.targetLines.First && p.lastLine <= p.targetLines.Last {
		return p.targetProgram
	}
	// Outside that range the interpreter is either in a sibling subprogram's body -- whose
	// name run_info never carries, and which only shows up on its own declaration line
	// (handled above) -- or in the package initialization section, which belongs to the
	// package itself. Naming the target routine here would be plainly wrong, so the
	// package name the engine reported stands: vague, never false.
	return reported
}

func (p *plDebugSession) applyRunInfoMessage(message string) {
	// message shape, identical to ODC's helper package:
	// " run_info.breakpoint = , run_info.stackdepth = 2, run_info.reason = 9,
	//   run_info.programname = PRO1, run_info.programowner = CHZ"
	//
	// ODC ignores field 0 (run_info.breakpoint is blank unless a breakpoint was
	// just hit) and reads 1..4 positionally, so a message with fewer than five
	// comma-separated fields carries no usable stack information.
	parts := strings.Split(message, ",")
	if len(parts) < 5 {
		return
	}
	p.lastBreakpoint = atoiOrZero(runInfoValue(parts[0]))
	p.lastStackDepth = atoiOrZero(runInfoValue(parts[1]))
	p.lastReason = atoiOrZero(runInfoValue(parts[2]))
	p.lastProgram = runInfoValue(parts[3])
	p.lastProgramOwner = runInfoValue(parts[4])
}

// plDebugSubprogramFromDeclaration recovers a routine name from the declaration line of
// a package subprogram ("PROCEDURE RUN_MSBP IS", "FUNCTION F_ADD RETURN NUMBER IS").
//
// Oracle prints that SOURCE line where a frame name would go, and for a package
// subprogram it is the only place the CURRENT routine's name appears at all: run_info
// reports just the package (the subprogram lives in program_info.entrypointname, which
// run_info does not carry). Returns "" when the text is not such a declaration.
func plDebugSubprogramFromDeclaration(source string) string {
	fields := strings.Fields(source)
	for index, field := range fields {
		upper := strings.ToUpper(field)
		if upper != "PROCEDURE" && upper != "FUNCTION" {
			continue
		}
		if index+1 >= len(fields) {
			return ""
		}
		name := strings.TrimSpace(strings.TrimRight(fields[index+1], ";,"))
		if name != "" && plDebugPlainIdentifier(name) {
			return name
		}
		return ""
	}
	return ""
}

// runInfoValue returns the text after the " = " separator, mirroring ODC's
// split(" = ") read of each run_info field.
func runInfoValue(part string) string {
	if _, value, ok := strings.Cut(part, " = "); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

// plDebugParseBacktrace extracts the current line and program name from the
// listing DBMS_DEBUG.PRINT_BACKTRACE produces, e.g. "[Line 8] PROC" or
// "[Line 0] PKG.F_ADD". ODC derives the "current line" from this listing rather
// than from the run_info message, so the split points are kept identical.
func plDebugParseBacktrace(listing string) (int, string, error) {
	split := strings.SplitN(listing, "Line", 2)
	if len(split) < 2 {
		return 0, "", fmt.Errorf("backtrace listing carries no line information: %q", listing)
	}
	frame := strings.SplitN(split[1], "]", 2)
	line := atoiOrZero(strings.TrimSpace(frame[0]))
	name := ""
	if len(frame) > 1 {
		name = strings.TrimSpace(frame[1])
		if newline := strings.IndexByte(name, '\n'); newline >= 0 {
			name = strings.TrimSpace(name[:newline])
		}
	}
	return line, name, nil
}

// plDebugParseBacktraceFrames turns the whole PRINT_BACKTRACE listing into a call
// stack. DBMS_DEBUG prints one "[Line N] NAME" entry per frame, innermost first,
// so the first parsed frame is the current one. Lines that carry no "[Line N]"
// entry are skipped: the listing can contain program source or blank lines, and a
// parsing miss there must not drop the frames that did parse.
//
// StackDepth is assigned innermost-first (frame 0 is the deepest); the caller
// overwrites it with run_info.stackdepth when the server reported one.
func plDebugParseBacktraceFrames(listing string) []plDebugFrame {
	frames := make([]plDebugFrame, 0)
	for _, line := range strings.Split(listing, "\n") {
		lineNumber, text, ok := plDebugParseBacktraceLine(line)
		if !ok {
			continue
		}
		frame := plDebugFrame{Line: lineNumber}
		// The same guard the session-level program field has always used: only a
		// token that looks like an Oracle identifier is a name. Oracle 19c EE puts
		// the SOURCE line in that position, so publishing it verbatim would label a
		// frame with a line of code.
		if plDebugIsProgramName(text) {
			frame.Program = text
		} else {
			frame.Source = text
		}
		frames = append(frames, frame)
	}
	for index := range frames {
		frames[index].StackDepth = len(frames) - index
	}
	return frames
}

// plDebugParseBacktraceLine extracts one "[Line N] NAME" entry from a single line
// of the listing. It tolerates leading text before the bracket and the absence of
// the closing bracket, and reports ok=false for anything else.
func plDebugParseBacktraceLine(line string) (int, string, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return 0, "", false
	}
	marker := strings.Index(trimmed, "Line")
	if marker < 0 {
		return 0, "", false
	}
	rest := strings.TrimSpace(trimmed[marker+len("Line"):])
	digits := 0
	for digits < len(rest) && rest[digits] >= '0' && rest[digits] <= '9' {
		digits++
	}
	if digits == 0 {
		return 0, "", false
	}
	lineNumber := atoiOrZero(rest[:digits])
	rest = strings.TrimSpace(rest[digits:])
	if strings.HasPrefix(rest, "]") {
		rest = strings.TrimSpace(rest[1:])
	}
	if rest == "" {
		return 0, "", false
	}
	return lineNumber, rest, true
}

func (p *plDebugSession) touch() {
	p.lastActivityMillis = nowMillis()
}

func (p *plDebugSession) expired() bool {
	return nowMillis()-p.lastActivityMillis > plDebugTimeoutMillis
}

// stringField reads a string field from a decoded JSON object. It tolerates a
// missing key, an explicit null, and non-string scalars, because the desktop
// client omits absent fields and may send numbers for numeric parameters.
func stringField(values map[string]interface{}, key string) string {
	value, ok := values[key]
	if !ok || value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprintf("%v", value)
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// plDebugLogf records a non-fatal degradation -- an optional server capability the
// agent had to ignore -- on stderr. Nothing logged here may fail the operation.
func plDebugLogf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[pl-debug] "+format+"\n", args...)
}

func atoiOrZero(value string) int {
	parsed := 0
	_, _ = fmt.Sscanf(value, "%d", &parsed)
	return parsed
}

func plDebugQualifiedPrefix(owner string) string {
	return fmt.Sprintf(`"%s"."%s"`, owner, plDebugPackageName)
}

/** JDBC chokes on a client-style trailing slash after an anonymous block. */
func stripTrailingSlash(sqlText string) string {
	trimmed := strings.TrimSpace(sqlText)
	for strings.HasSuffix(trimmed, "/") {
		trimmed = strings.TrimSpace(strings.TrimSuffix(trimmed, "/"))
	}
	return trimmed
}
