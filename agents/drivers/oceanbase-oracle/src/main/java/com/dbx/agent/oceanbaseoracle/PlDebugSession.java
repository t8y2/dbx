package com.dbx.agent.oceanbaseoracle;

import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.dbx.agent.PlDebugBreakpoint;
import com.dbx.agent.PlDebugParam;
import com.dbx.agent.PlDebugStartRequest;

/**
 * One PL/SQL debugging session against an OceanBase Oracle tenant.
 *
 * <p>The session owns two dedicated JDBC connections (never pooled, never the
 * shared request connection): the <em>debuggee</em> connection executes the
 * target program and blocks on its first line, and the <em>debugger</em>
 * connection attaches to it and drives breakpoints / stepping through the
 * helper package {@link DbxPlDebugPackage}. The wire protocol follows Oracle's
 * {@code DBMS_DEBUG} contract as used by OceanBase: the debuggee obtains a
 * debug id from {@code dbms_debug.initialize()}, the debugger attaches with
 * {@code dbms_debug.attach_session(id)}, and execution advances only when the
 * debugger sends {@code continue(...)} variants.
 *
 * <p>All session methods are synchronized: RPC requests arrive from different
 * worker threads, and {@code DBMS_DEBUG} state is strictly single-threaded.
 */
final class PlDebugSession implements AutoCloseable {
    /** OceanBase keeps the debuggee parked waiting for the debugger; expire loudly instead. */
    static final long DEFAULT_TIMEOUT_MILLIS = 10 * 60 * 1000L;
    private static final int DEBUGGEE_TIMEOUT_BEHAVIOUR = 2;

    private static final Logger LOG = Logger.getLogger(PlDebugSession.class.getName());

    /** OceanBase parks the debuggee far longer than 120s; lift ob_query_timeout for the session. */
    private static final String DEBUGGEE_QUERY_TIMEOUT = "SET SESSION ob_query_timeout = 600000000";

    /** DBMS_DEBUG idle timeout in seconds, matched to ODC's debugger-side setting. */
    private static final int DEBUG_TIMEOUT_SECONDS = 120;

    private static final int DBMS_OUTPUT_BUFFER_SIZE = 1000000;

    /**
     * The run_info diagnostic line, in ODC's shape (OracleCreateDebugPLConstants):
     * {@code run_info.*} keys and no line field. The current line comes from the
     * backtrace listing instead.
     */
    private static final Pattern RUN_INFO_MESSAGE = Pattern.compile(
        "run_info\\.breakpoint = (\\d+), run_info\\.stackdepth = (\\d+), run_info\\.reason = (\\d+),"
            + " run_info\\.programname = ([^,]*), run_info\\.programowner = (.*)"
    );

    /** Mirrors the Go parser: "[Line 8] PROC" / "[Line 0] PKG.F_ADD". */
    private static final Pattern BACKTRACE_FRAME = Pattern.compile("Line\\s*(\\d+)\\s*\\]\\s*([^\\r\\n]*)");

    /** The CNT_EXIT diagnostic line, e.g. {@code " reason = 3"}: reason only, no run_info fields. */
    private static final Pattern FINAL_REASON_MESSAGE = Pattern.compile("reason\\s*=\\s*(\\d+)");

    private static final int RESULT_SUCCESS = 0;

    /**
     * {@code dbms_debug.error_no_such_breakpt}, the code ENABLE_BREAKPOINT /
     * DISABLE_BREAKPOINT / DELETE_BREAKPOINT return for an unknown breakpoint
     * number. It is a real answer from a server that does implement the primitive,
     * so it must never be reported as "unsupported".
     */
    private static final int ERROR_NO_SUCH_BREAKPOINT = 13;

    /**
     * {@code dbms_debug.error_exception}, the second code the start sequence's
     * anonymous-block breakpoint tolerates: ODC swallows it because the start
     * sequence can arm the same line twice. Together with
     * {@link #ERROR_NO_SUCH_BREAKPOINT} it is the tolerated set of
     * {@link #toleratedStartBreakpointResult}.
     */
    private static final int ERROR_EXCEPTION = 28;

    /**
     * {@code MAX_TRY_STEP_INTO_TIMES} from ODC's
     * {@code DebuggerSession.stepInForStartingDebug}: the start sequence steps in at
     * most this many times waiting for the stack depth to grow, and then reports
     * {@code debug start failed: could not stop inside <routine>}. Mirrors the Go
     * driver's {@code plDebugStartStepInLimit}.
     */
    static final int START_STEP_IN_LIMIT = 5;

    /**
     * The debuggee block is submitted asynchronously, so the debugger's
     * ATTACH_SESSION can arrive before the debuggee signalled that it is parked.
     * That race is retried a bounded number of times instead of failing the start.
     * Mirrors the Go driver's {@code plDebugAttachAttempts}/{@code plDebugAttachDelay}.
     */
    private static final int ATTACH_ATTEMPTS = 20;
    private static final long ATTACH_DELAY_MILLIS = 50;

    /**
     * {@code run_info.reason} values an exception breakpoint stops on
     * ({@code dbms_debug.reason_exception}/{@code reason_handler}). Every other
     * reason -- notably {@code reason_finish} (8), which merely means the current
     * entrypoint returned -- keeps the exception-mode resume loop going.
     */
    private static final int REASON_EXCEPTION = 11;
    private static final int REASON_HANDLER = 16;

    /**
     * Caps the exception-mode resume loop. Without it a server that keeps
     * reporting {@code reason_finish} (or an unparsable reason) would spin forever
     * inside {@code pl_debug_resume} and the RPC would never return.
     */
    private static final int EXCEPTION_RESUME_ITERATIONS = 200;

    private final String debugId;
    private final String owner;
    private final Connection debuggeeConnection;
    private final Connection debuggerConnection;
    private final ExecutorService debuggeeExecutor;
    private final List<PlDebugBreakpoint> breakpoints = new CopyOnWriteArrayList<>();
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicBoolean debugOffSent = new AtomicBoolean(false);
    private final long timeoutMillis;
    /**
     * What the installed helper package can fill from a caller's
     * signature/sequence; anything unsupported is ignored and logged.
     */
    private final DbxPlDebugPackage.ProgramInfoFields programInfoFields;

    private volatile Future<?> debuggeeFuture;
    private volatile String debuggeeError;
    private volatile String currentLine;
    private volatile String currentProgram;
    private volatile String currentProgramOwner;
    private volatile Integer currentBreakpoint;
    private volatile Integer currentReason;
    private volatile Integer currentStackDepth;
    private volatile boolean terminated;
    private volatile long lastActivityMillis = System.currentTimeMillis();
    /** Exception mode; deliberately ignored by the step operations, only resume loops. */
    private volatile boolean exceptionBreakpoint;
    /** True only when the last exception-mode resume stopped on reason 11/16. */
    private volatile boolean stoppedOnException;

    PlDebugSession(
        String debugId,
        String owner,
        Connection debuggeeConnection,
        Connection debuggerConnection,
        ExecutorService debuggeeExecutor,
        long timeoutMillis,
        DbxPlDebugPackage.ProgramInfoFields programInfoFields
    ) {
        this.debugId = debugId;
        this.owner = owner;
        this.debuggeeConnection = debuggeeConnection;
        this.debuggerConnection = debuggerConnection;
        this.debuggeeExecutor = debuggeeExecutor;
        this.timeoutMillis = timeoutMillis;
        this.programInfoFields = programInfoFields;
    }

    /**
     * Full start sequence, in ODC's {@code DebuggerSession.start} order -- the order
     * that leaves the session with a current line instead of the zero state:
     *
     * <pre>
     * debuggee: INITIALIZE -&gt; SET_TIMEOUT_BEHAVIOUR -&gt; DEBUG_ON -&gt; run target
     * debugger: ATTACH_SESSION -&gt; SYNCHRONIZE -&gt; anonymous-block breakpoint
     *           -&gt; resume -&gt; step in until the routine is the current frame
     * </pre>
     *
     * <p>The target has to be submitted <em>before</em> the attach (this agent used
     * to attach first): only a parked debuggee exposes the anonymous block, whose
     * call line the debugger then breaks on and steps into. Mirrors the Go driver's
     * {@code plDebugStart}.
     */
    static PlDebugSession start(
        Connection debuggeeConnection,
        Connection debuggerConnection,
        PlDebugStartRequest request,
        ExecutorService debuggeeExecutor,
        long timeoutMillis
    ) throws Exception {
        String owner = request.getSchema() == null || request.getSchema().trim().isEmpty()
            ? currentSchema(debuggeeConnection)
            : request.getSchema().trim().toUpperCase();

        DbxPlDebugPackage.ProgramInfoFields programInfoFields = ensureHelperPackage(debuggeeConnection, owner);

        // OceanBase kills the parked debuggee statement at ob_query_timeout
        // (default 10s), which is shorter than a human debugging session.
        executeStatement(debuggeeConnection, DEBUGGEE_QUERY_TIMEOUT);
        try (CallableStatement call = debuggeeConnection.prepareCall("CALL DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR(?)")) {
            call.setInt(1, DEBUGGEE_TIMEOUT_BEHAVIOUR);
            call.execute();
        }
        try {
            // Function, not a procedure: SET_TIMEOUT must be selected (Oracle's
            // PLS-00221 rejects a statement-form call). Best effort either way: an
            // engine without DBMS_DEBUG.SET_TIMEOUT starts anyway.
            queryString(debuggeeConnection, "SELECT DBMS_DEBUG.SET_TIMEOUT(" + DEBUG_TIMEOUT_SECONDS + ") FROM DUAL");
        } catch (Exception error) {
            LOG.log(Level.WARNING, "DBMS_DEBUG.SET_TIMEOUT failed; continuing without an idle timeout", error);
        }

        String debugId = queryString(debuggeeConnection, "SELECT DBMS_DEBUG.INITIALIZE() FROM DUAL");
        if (debugId == null || debugId.trim().isEmpty()) {
            throw new IllegalStateException("DBMS_DEBUG.INITIALIZE() returned no debug id");
        }
        debugId = debugId.trim();

        PlDebugSession session = new PlDebugSession(
            debugId,
            owner,
            debuggeeConnection,
            debuggerConnection,
            debuggeeExecutor,
            timeoutMillis,
            programInfoFields
        );

        executeStatement(debuggeeConnection, "BEGIN DBMS_OUTPUT.ENABLE(" + DBMS_OUTPUT_BUFFER_SIZE + "); END;");
        executeStatement(debuggeeConnection, "CALL DBMS_DEBUG.DEBUG_ON()");

        // Submit the target first: DBMS_DEBUG parks the debuggee on the first line of
        // the anonymous block, which is what makes the block visible to the debugger
        // below. It blocks until the debugger drives the program to completion, so it
        // runs on its own thread.
        session.debuggeeFuture = debuggeeExecutor.submit(() -> session.runDebuggeeTarget(request));

        // From here on the session owns both connections: every failure closes it.
        try {
            session.attachDebugger();
            session.probeTargetProgramRunning();
            // Synchronize with the debuggee when the server implements it. A failure
            // is logged, never fatal: stock Oracle has no dbms_debug.synchronize.
            session.synchronizeDebuggee();
            // debugBefore: stop inside the target routine so start returns a filled
            // snapshot. Anonymous-block targets carry their own breakpoints and are
            // left to the caller.
            session.debugBefore(request);
        } catch (Exception error) {
            session.close();
            throw error;
        }
        return session;
    }

    /**
     * Attaches the debugger session to the parked debuggee, retrying the startup
     * race (the target thread may not have reached its first line yet) a bounded
     * number of times. Mirrors the Go driver's {@code attachDebugger}.
     */
    private void attachDebugger() throws Exception {
        Exception lastError = null;
        for (int attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
            try (CallableStatement call = debuggerConnection.prepareCall("CALL DBMS_DEBUG.ATTACH_SESSION(?)")) {
                call.setString(1, debugId);
                call.execute();
                touch();
                return;
            } catch (Exception error) {
                lastError = error;
            }
            try {
                Thread.sleep(ATTACH_DELAY_MILLIS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("DBMS_DEBUG.ATTACH_SESSION interrupted", interrupted);
            }
        }
        throw new IllegalStateException(
            "DBMS_DEBUG.ATTACH_SESSION failed: " + (lastError == null ? "" : lastError.getMessage()),
            lastError
        );
    }

    /**
     * Probe only: confirms the interpreter is parked and visible to the debugger.
     * TARGET_PROGRAM_RUNNING() RETURNS BOOLEAN, so selecting it from DUAL is invalid
     * on real Oracle (ORA-00902: invalid datatype); the anonymous block assigns it to
     * a local BOOLEAN instead. It takes no arguments, and a failure here is logged
     * only -- never fatal -- because the first real step/resume reports any genuine
     * problem.
     */
    private void probeTargetProgramRunning() {
        try {
            executeStatement(
                debuggerConnection,
                "BEGIN DECLARE running BOOLEAN; BEGIN running := DBMS_DEBUG.TARGET_PROGRAM_RUNNING(); END; END;"
            );
        } catch (Exception error) {
            LOG.log(Level.FINE, "DBMS_DEBUG.TARGET_PROGRAM_RUNNING probe failed", error);
        }
    }

    /**
     * Calls DBX_SYNCHRONIZE, the package procedure ODC wraps
     * {@code dbms_debug.synchronize} in ({@code DebuggerSession.synchronize}). It
     * waits for the debuggee to finish initializing. Servers that do not implement
     * the primitive report an error or a non-zero result; both are logged and
     * ignored because the start sequence must not depend on an optional capability.
     * Mirrors the Go driver's {@code synchronizeDebuggee}.
     */
    private void synchronizeDebuggee() {
        int result;
        String message;
        try (CallableStatement call = debuggerConnection.prepareCall(
            "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_SYNCHRONIZE) + "(?, ?); END;"
        )) {
            call.registerOutParameter(1, Types.INTEGER);
            call.registerOutParameter(2, Types.VARCHAR);
            call.execute();
            result = call.getInt(1);
            message = call.getString(2);
        } catch (Exception error) {
            LOG.log(Level.FINE, "DBX_SYNCHRONIZE failed (ignored)", error);
            return;
        }
        if (result != RESULT_SUCCESS) {
            LOG.fine("DBX_SYNCHRONIZE returned result=" + result + " (ignored): " + message);
            return;
        }
        touch();
    }

    /**
     * The snapshot {@code pl_debug_start} returns. debugBefore has already parked the
     * debuggee inside the target routine, so line/program/stackDepth are filled
     * instead of the zero state the caller used to receive. Mirrors the Go driver's
     * {@code startSnapshot}.
     */
    synchronized Map<String, Object> startSnapshot() {
        return snapshot();
    }

    /**
     * Test-only session without connections: only the snapshot state published by
     * {@link #publishStartFrame} is exercised, and the snapshot never touches a
     * connection.
     */
    static PlDebugSession withoutConnections(String debugId, String owner) {
        return new PlDebugSession(
            debugId,
            owner,
            null,
            null,
            null,
            DEFAULT_TIMEOUT_MILLIS,
            new DbxPlDebugPackage.ProgramInfoFields(false, false)
        );
    }

    /**
     * Reproduces ODC's {@code DebuggerSession.debugBefore} for a PROCEDURE/FUNCTION
     * target: arm a breakpoint on the line of the call inside the anonymous block the
     * debuggee is running, resume to it, then step in (at most
     * {@link #START_STEP_IN_LIMIT} times) until the target routine is the current
     * frame. It is what turns the zero state (stackDepth 0, no line, no program) into
     * a session parked inside the routine. Mirrors the Go driver's
     * {@code debugBefore}.
     */
    private synchronized void debugBefore(PlDebugStartRequest request) throws Exception {
        if (!debugBeforeApplies(request.getObjectType())) {
            // An anonymous-block target is submitted verbatim: there is no call line
            // to stop on, so it keeps its caller-supplied breakpoints.
            return;
        }
        String routine = resolveRoutineName(request);
        String program = resolveProgramName(request);
        boolean isFunction = "FUNCTION".equals(normalizedObjectType(request.getObjectType()));
        String block = anonymousBlock(routine, isFunction, request.getParams().size());
        int callLine = anonymousCallLine(block, routine);
        if (callLine <= 0) {
            LOG.info(
                "no call line for " + routine + " in the submitted anonymous block; arming no start breakpoint"
            );
        } else {
            try {
                armStartBreakpoint(callLine, program);
            } catch (Exception error) {
                throw new IllegalStateException("debug start failed: " + error.getMessage(), error);
            }
        }

        // resume() runs the debuggee from the block's first line onto the breakpoint
        // (or onto entry of any called entrypoint when the breakpoint was tolerated).
        try {
            resume();
        } catch (Exception error) {
            throw new IllegalStateException("debug start failed: " + error.getMessage(), error);
        }

        if (terminateState()) {
            if (debuggeeError != null && !debuggeeError.isEmpty()) {
                throw new IllegalStateException("debug start failed: " + debuggeeError);
            }
            throw new IllegalStateException(
                "debug start failed: the debuggee finished before " + program + " was reached"
            );
        }

        int depth = currentStackDepth == null ? 0 : currentStackDepth;
        try {
            stepInUntilDeeper(depth);
        } catch (Exception error) {
            throw new IllegalStateException(
                "debug start failed: could not stop inside " + program + ": " + error.getMessage(),
                error
            );
        }
        publishStartFrame(program);
    }

    /**
     * debugBefore only applies to a named routine; an anonymous-block target is
     * submitted verbatim and keeps its caller-supplied breakpoints. This is the Go
     * driver's objectType guard, split out so it can be asserted without a database.
     */
    static boolean debugBeforeApplies(String objectType) {
        String type = normalizedObjectType(objectType);
        return "PROCEDURE".equals(type) || "FUNCTION".equals(type);
    }

    private static String normalizedObjectType(String objectType) {
        return objectType == null ? "" : objectType.trim().toUpperCase(Locale.ROOT);
    }

    /**
     * The program label the start sequence publishes for the target: the plain
     * routine name, or {@code PKG.NAME} for a package subprogram (mirrors the Go
     * driver's {@code plDebugResolveTarget} program field).
     */
    private String resolveProgramName(PlDebugStartRequest request) {
        String objectName = request.getObjectName() == null ? "" : request.getObjectName().trim().toUpperCase(Locale.ROOT);
        String packageName = request.getPackageName() == null ? "" : request.getPackageName().trim().toUpperCase(Locale.ROOT);
        return packageName.isEmpty() ? objectName : packageName + "." + objectName;
    }

    /**
     * Publishes the frame the start sequence parked the debuggee in: ODC reports the
     * target routine itself as the current frame, at the routine's own depth (1)
     * rather than the anonymous block's nesting; the backtrace then supplies the
     * current line and the program it is parked in. Mirrors the tail of the Go
     * driver's {@code debugBefore}.
     */
    synchronized void publishStartFrame(String program) {
        currentProgramOwner = owner;
        currentProgram = program;
        refreshBacktrace();
        currentStackDepth = 1;
        touch();
    }

    /**
     * Arms the anonymous-block breakpoint at the target call line and records it so
     * the caller sees it listed. Mirrors the Go driver's {@code armStartBreakpoint}.
     */
    private synchronized void armStartBreakpoint(int line, String program) throws Exception {
        int breakpointNumber;
        int result;
        try (CallableStatement call = debuggerConnection.prepareCall(
            "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ANONYMOUS) + "(?, ?, ?); END;"
        )) {
            call.setInt(1, line);
            call.registerOutParameter(2, Types.INTEGER);
            call.registerOutParameter(3, Types.INTEGER);
            call.execute();
            breakpointNumber = call.getInt(2);
            result = call.getInt(3);
        } catch (Exception error) {
            throw new IllegalStateException(
                "set the anonymous-block breakpoint at line " + line + " failed: " + error.getMessage(),
                error
            );
        }
        if (result != RESULT_SUCCESS) {
            // Tolerated codes are logged as tolerated, anything else as unexpected;
            // neither fails the start, because the step-in loop below is the real
            // arbiter of whether the debugger stopped inside the routine.
            if (toleratedStartBreakpointResult(result)) {
                LOG.fine(
                    "anonymous-block breakpoint at line " + line + " returned result=" + result + " (tolerated)"
                );
            } else {
                LOG.warning(
                    "anonymous-block breakpoint at line " + line + " returned result=" + result + " (unexpected)"
                );
            }
        }
        PlDebugBreakpoint stored = new PlDebugBreakpoint();
        stored.setOwner(owner);
        stored.setName(program);
        stored.setLine(line);
        stored.setBreakpointNumber(breakpointNumber);
        stored.setKind("ANONYMOUS");
        breakpoints.add(stored);
        touch();
    }

    /**
     * Reports whether a DBMS_DEBUG result code from the start-sequence breakpoint is
     * tolerated: {@code error_exception} (28, which ODC swallows because the start
     * sequence can arm the same line twice) and {@code error_no_such_breakpt} (13,
     * the server already dropped it). Every other non-zero code is logged as well,
     * because the step-in loop is the real arbiter.
     */
    static boolean toleratedStartBreakpointResult(int result) {
        return result == ERROR_EXCEPTION || result == ERROR_NO_SUCH_BREAKPOINT;
    }

    /** One step-in attempt for {@link #stepInUntilDeeper}: the depth observed afterwards. */
    interface StepInAttempt {
        int stepIn() throws Exception;
    }

    /**
     * Steps in at most {@code limit} times until the stack depth grows beyond its
     * initial value, mirroring ODC's {@code stepInForStartingDebug} and the Go
     * driver's {@code plDebugStepInUntilDeeper}. It throws when the depth never grew;
     * a failing attempt propagates as-is.
     */
    static int stepInUntilDeeper(int depth, int limit, StepInAttempt stepIn) throws Exception {
        int current = depth;
        for (int attempt = 0; attempt < limit; attempt++) {
            current = stepIn.stepIn();
            if (current > depth) {
                return current;
            }
        }
        throw new IllegalStateException(
            "stack depth stayed at " + depth + " after " + limit + " step-in attempts"
        );
    }

    /**
     * {@link #stepInUntilDeeper(int, int, StepInAttempt)} wired to the live session:
     * each attempt runs one {@code DBX_CNT_STEP_IN} and reads the run_info stack
     * depth.
     */
    private void stepInUntilDeeper(int depth) throws Exception {
        stepInUntilDeeper(depth, START_STEP_IN_LIMIT, () -> {
            stepIn();
            if (terminated) {
                throw new IllegalStateException("the debuggee finished while stepping in");
            }
            return currentStackDepth == null ? 0 : currentStackDepth;
        });
    }

    String debugId() {
        return debugId;
    }

    synchronized Map<String, Object> setBreakpoints(List<PlDebugBreakpoint> requested) throws Exception {
        requireOpen();
        ensureNotTerminated("set breakpoints");
        List<PlDebugBreakpoint> created = new ArrayList<>();
        for (PlDebugBreakpoint breakpoint : requested) {
            if (breakpoint == null || breakpoint.getLine() == null || breakpoint.getLine() <= 0) {
                continue;
            }
            int line = breakpoint.getLine();
            String kind = breakpoint.getKind() == null ? "" : breakpoint.getKind().trim().toUpperCase();
            int breakpointNumber;
            int result;
            // A null signature / sequence means "the caller left the attribute
            // out", which is what triggers the overload warning; an empty string or
            // a negative sequence is a supplied value that simply carries no
            // disambiguation.
            String signature = breakpoint.getSignature() == null ? "" : breakpoint.getSignature().trim();
            int sequence = breakpoint.getSequence() == null ? -1 : breakpoint.getSequence();
            boolean hasSignature = !signature.isEmpty();
            boolean hasSequence = sequence >= 0;
            List<String> warnings = new ArrayList<>();
            if ("ANONYMOUS".equals(kind)) {
                try (CallableStatement call = debuggerConnection.prepareCall(
                    "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ANONYMOUS) + "(?, ?, ?); END;"
                )) {
                    call.setInt(1, line);
                    call.registerOutParameter(2, Types.INTEGER);
                    call.registerOutParameter(3, Types.INTEGER);
                    call.execute();
                    breakpointNumber = call.getInt(2);
                    result = call.getInt(3);
                }
            } else {
                String breakpointOwner = breakpoint.getOwner() == null || breakpoint.getOwner().trim().isEmpty()
                    ? owner
                    : breakpoint.getOwner().trim().toUpperCase();
                String name = breakpoint.getName() == null ? "" : breakpoint.getName().trim().toUpperCase();
                // An overloaded target armed without signature/sequence binds to
                // whichever implementation the server picks, so the caller is warned
                // instead of silently debugging the wrong body.
                if (!hasSignature && !hasSequence) {
                    try {
                        int overloads = overloadCount(debuggerConnection, breakpointOwner, name);
                        String overloadWarning =
                            overloadWarningForTarget(breakpointOwner, name, overloads, hasSignature, hasSequence);
                        if (!overloadWarning.isEmpty()) {
                            warnings.add(overloadWarning);
                            LOG.warning(overloadWarning);
                        }
                    } catch (Exception error) {
                        // The probe is advisory: a server without ALL_PROCEDURES
                        // must not fail the breakpoint.
                        LOG.log(
                            Level.FINE,
                            "overload probe for " + breakpointOwner + "." + name + " failed",
                            error
                        );
                    }
                }
                // Only ask DBX_SET_BREAKPOINT_EX for attributes this server's
                // program_info actually declares; the rest are ignored and logged.
                List<String> ignored = new ArrayList<>();
                if (hasSignature && !programInfoFields.signature) {
                    ignored.add("signature");
                }
                if (hasSequence && !programInfoFields.sequence) {
                    ignored.add("sequence");
                }
                if (!ignored.isEmpty()) {
                    String ignoredWarning = "该服务器 DBMS_DEBUG.PROGRAM_INFO 不支持 "
                        + String.join("/", ignored)
                        + " 属性，已忽略";
                    warnings.add(ignoredWarning);
                    LOG.warning(ignoredWarning);
                }
                boolean useOverloadAttributes = (hasSignature && programInfoFields.signature)
                    || (hasSequence && programInfoFields.sequence);
                // A package member is addressed as "PKG.SUB" (PlDebugSessionTarget
                // .programName in the desktop client). The server wants the two halves: it
                // answers error_bad_handle (16) or error_exception (28) for every shape
                // that passes the subprogram as program_info.name, and success (0) only for
                // name=<package> + namespace_pkg_body + entrypointname=<subprogram> --
                // measured on Oracle 19c EE (see
                // DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ENTRY). The split arm is used
                // only when the server's PROGRAM_INFO record declares entrypointname; the
                // dotted name then keeps the previous path, so an engine that resolves
                // "PKG.SUB" by itself (OceanBase Oracle mode) is untouched.
                String[] entrySplit = splitPackageSubprogram(name);
                boolean useEntrypoint = entrySplit != null && programInfoFields.entrypoint;
                if (useEntrypoint && useOverloadAttributes) {
                    // DBX_SET_BREAKPOINT_ENTRY carries no signature/sequence attribute:
                    // the entrypointname is what locates the subprogram. Saying so beats
                    // arming the wrong overload silently.
                    String overloadIgnored = "包内子程序断点改用 entrypointname 定位，已忽略 signature/sequence";
                    warnings.add(overloadIgnored);
                    LOG.warning(overloadIgnored);
                }
                if (useEntrypoint) {
                    try (CallableStatement call = debuggerConnection.prepareCall(
                        "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_ENTRY) + "(?, ?, ?, ?, ?, ?); END;"
                    )) {
                        call.setString(1, breakpointOwner);
                        call.setString(2, entrySplit[0]);
                        call.setString(3, entrySplit[1]);
                        call.setInt(4, line);
                        call.registerOutParameter(5, Types.INTEGER);
                        call.registerOutParameter(6, Types.INTEGER);
                        call.execute();
                        breakpointNumber = call.getInt(5);
                        result = call.getInt(6);
                    }
                } else if (useOverloadAttributes) {
                    try (CallableStatement call = debuggerConnection.prepareCall(
                        "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT_EX) + "(?, ?, ?, ?, ?, ?, ?); END;"
                    )) {
                        call.setString(1, breakpointOwner);
                        call.setString(2, name);
                        call.setInt(3, line);
                        call.setString(4, signature);
                        call.setInt(5, sequence);
                        call.registerOutParameter(6, Types.INTEGER);
                        call.registerOutParameter(7, Types.INTEGER);
                        call.execute();
                        breakpointNumber = call.getInt(6);
                        result = call.getInt(7);
                    }
                } else {
                    try (CallableStatement call = debuggerConnection.prepareCall(
                        "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_SET_BREAKPOINT) + "(?, ?, ?, ?, ?); END;"
                    )) {
                        call.setString(1, breakpointOwner);
                        call.setString(2, name);
                        call.setInt(3, line);
                        call.registerOutParameter(4, Types.INTEGER);
                        call.registerOutParameter(5, Types.INTEGER);
                        call.execute();
                        breakpointNumber = call.getInt(4);
                        result = call.getInt(5);
                    }
                }
            }
            if (result != RESULT_SUCCESS) {
                throw new IllegalStateException(
                    "DBMS_DEBUG.SET_BREAKPOINT failed for line " + line + " (result=" + result + ")"
                );
            }
            PlDebugBreakpoint stored = new PlDebugBreakpoint();
            stored.setOwner(breakpoint.getOwner() == null ? owner : breakpoint.getOwner());
            stored.setName(breakpoint.getName());
            stored.setLine(line);
            stored.setBreakpointNumber(breakpointNumber);
            stored.setKind(kind.isEmpty() ? "PROCEDURE" : kind);
            stored.setSignature(breakpoint.getSignature());
            stored.setSequence(breakpoint.getSequence());
            stored.setWarning(String.join("; ", warnings));
            breakpoints.add(stored);
            created.add(stored);
        }
        touch();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", true);
        response.put("breakpoints", created);
        return response;
    }

    /**
     * Splits the {@code "PKG.SUB"} program name the desktop client sends for a package
     * member into the package and the subprogram, because {@code DBMS_DEBUG} needs them
     * in separate {@code PROGRAM_INFO} fields: {@code name} and {@code entrypointname}
     * (see {@link DbxPlDebugPackage#PROCEDURE_SET_BREAKPOINT_ENTRY}). Returns
     * {@code null} for everything else -- a standalone routine, an empty half,
     * {@code "PKG.SUB.EXTRA"} -- so the caller keeps the previous arm path for those.
     * Both halves must be plain identifiers: they are bound as IN values only, but a
     * quoted identifier ({@code "My Pkg"."My Proc"}) would make the server resolve a
     * different object. Mirrors the Go driver's
     * {@code plDebugSplitPackageSubprogram}.
     */
    static String[] splitPackageSubprogram(String name) {
        if (name == null || name.isEmpty()) {
            return null;
        }
        int dot = name.indexOf('.');
        if (dot <= 0 || dot == name.length() - 1) {
            return null;
        }
        String packageName = name.substring(0, dot);
        String subprogram = name.substring(dot + 1);
        if (!isPlainIdentifier(packageName) || !isPlainIdentifier(subprogram)) {
            return null;
        }
        return new String[] {packageName, subprogram};
    }

    /** Whether every character is one Oracle accepts in an unquoted identifier. */
    private static boolean isPlainIdentifier(String name) {
        if (name == null || name.isEmpty()) {
            return false;
        }
        for (int index = 0; index < name.length(); index++) {
            char c = name.charAt(index);
            boolean plain = c == '_' || c == '$' || c == '#'
                || (c >= '0' && c <= '9')
                || (c >= 'A' && c <= 'Z')
                || (c >= 'a' && c <= 'z');
            if (!plain) {
                return false;
            }
        }
        return true;
    }

    /**
     * How many distinct subprograms share the target name, using
     * {@code SUBPROGRAM_ID} (unique per overload) rather than a plain name count. A
     * name of the form {@code PKG.PROC} is split so package subprograms are counted
     * inside their package.
     */
    private static int overloadCount(Connection connection, String owner, String name) throws Exception {
        String objectName = name;
        String procedureName = "";
        int dot = name.indexOf('.');
        if (dot >= 0) {
            objectName = name.substring(0, dot);
            procedureName = name.substring(dot + 1);
        }
        boolean packageSubprogram = !procedureName.isEmpty();
        String sql = packageSubprogram
            ? "SELECT COUNT(DISTINCT SUBPROGRAM_ID) FROM ALL_PROCEDURES"
                + " WHERE OWNER = ? AND OBJECT_NAME = ? AND PROCEDURE_NAME = ? AND SUBPROGRAM_ID IS NOT NULL"
            : "SELECT COUNT(DISTINCT SUBPROGRAM_ID) FROM ALL_PROCEDURES"
                + " WHERE OWNER = ? AND (OBJECT_NAME = ? OR PROCEDURE_NAME = ?) AND SUBPROGRAM_ID IS NOT NULL";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, owner);
            statement.setString(2, packageSubprogram ? objectName : name);
            statement.setString(3, packageSubprogram ? procedureName : name);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? result.getInt(1) : 0;
            }
        }
    }

    /** Message returned when an overloaded target is armed without disambiguation. */
    static String overloadWarning(String owner, String name, int overloads) {
        return owner
            + "."
            + name
            + " 存在 "
            + overloads
            + " 个同名重载，未提供 signature/sequence 时可能断到错误的实现（overloaded target: "
            + overloads
            + " candidates）";
    }

    /**
     * Only an ambiguous target (more than one subprogram sharing the name) that the
     * caller did not disambiguate with signature/sequence gets a warning; a
     * standalone routine, or a disambiguated target, stays silent.
     */
    static String overloadWarningForTarget(
        String owner,
        String name,
        int overloads,
        boolean hasSignature,
        boolean hasSequence
    ) {
        if (hasSignature || hasSequence || overloads <= 1) {
            return "";
        }
        return overloadWarning(owner, name, overloads);
    }

    synchronized Map<String, Object> deleteBreakpoints(List<PlDebugBreakpoint> requested) throws Exception {
        requireOpen();
        List<PlDebugBreakpoint> removed = new ArrayList<>();
        for (PlDebugBreakpoint breakpoint : requested) {
            if (breakpoint == null || breakpoint.getBreakpointNumber() == null) {
                continue;
            }
            deleteBreakpointNumber(breakpoint.getBreakpointNumber());
            breakpoints.removeIf(existing -> breakpoint.getBreakpointNumber().equals(existing.getBreakpointNumber()));
            removed.add(breakpoint);
        }
        touch();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", true);
        response.put("breakpoints", removed);
        return response;
    }

    synchronized List<PlDebugBreakpoint> listBreakpoints() {
        return new ArrayList<>(breakpoints);
    }

    /**
     * Runs to the next breakpoint (or to the end of the program). Without an
     * exception breakpoint this is a single {@code DBX_CNT_NEXT_BREAKPOINT} call;
     * with one it keeps continuing until the interpreter reports an
     * exception/handler, a real breakpoint hit, or termination.
     */
    synchronized Map<String, Object> resume() throws Exception {
        if (!exceptionBreakpoint) {
            return continueWith(DbxPlDebugPackage.PROCEDURE_CNT_NEXT_BREAKPOINT);
        }
        return resumeUntilException();
    }

    /**
     * Drives the exception-mode resume: {@code reason_finish} (8) and every other
     * non-exceptional stop keep the loop going, because the debuggee only stops at
     * entrypoint returns while breakpoints are suspended. The loop is capped so a
     * server that never reports a stop condition cannot hang the RPC.
     */
    private Map<String, Object> resumeUntilException() throws Exception {
        Map<String, Object> response = null;
        boolean truncated = false;
        for (int iteration = 0; iteration < EXCEPTION_RESUME_ITERATIONS; iteration++) {
            Map<String, Object> current = continueWith(DbxPlDebugPackage.PROCEDURE_CNT_NEXT_BREAKPOINT);
            if (current == null) {
                break;
            }
            response = current;
            boolean stopped = Boolean.TRUE.equals(current.get("terminated"));
            Integer reason = asInteger(current.get("reason"));
            Integer breakpoint = asInteger(current.get("breakpoint"));
            if (stopped
                || (reason != null && (reason == REASON_EXCEPTION || reason == REASON_HANDLER))
                || (breakpoint != null && breakpoint > 0)) {
                break;
            }
            if (iteration == EXCEPTION_RESUME_ITERATIONS - 1) {
                truncated = true;
            }
        }
        if (response == null) {
            response = snapshot();
        }
        Integer reason = asInteger(response.get("reason"));
        stoppedOnException = reason != null && (reason == REASON_EXCEPTION || reason == REASON_HANDLER);
        touch();
        response.put("stoppedOnException", stoppedOnException);
        if (truncated) {
            response.put("exceptionResumeTruncated", true);
            response.put(
                "message",
                "exception breakpoint resume stopped after " + EXCEPTION_RESUME_ITERATIONS
                    + " continuations without an exception"
            );
        }
        return response;
    }

    /**
     * Switches the resume-only exception mode on or off. The step operations keep
     * their {@code DBMS_DEBUG} semantics: only resume loops.
     */
    synchronized Map<String, Object> setExceptionBreakpoint(boolean enabled) {
        exceptionBreakpoint = enabled;
        if (!enabled) {
            stoppedOnException = false;
        }
        touch();
        Map<String, Object> response = snapshot();
        response.put("message", enabled ? "exception breakpoint enabled" : "exception breakpoint disabled");
        return response;
    }

    synchronized Map<String, Object> stepOver() throws Exception {
        return continueWith(DbxPlDebugPackage.PROCEDURE_CNT_NEXT_LINE);
    }

    synchronized Map<String, Object> stepIn() throws Exception {
        return continueWith(DbxPlDebugPackage.PROCEDURE_CNT_STEP_IN);
    }

    synchronized Map<String, Object> stepOut() throws Exception {
        return continueWith(DbxPlDebugPackage.PROCEDURE_CNT_STEP_OUT);
    }

    /**
     * Runs the debuggee to completion, ignoring every remaining breakpoint --
     * ODC's resumeIgnoreBreakpoints (its "CNT_EXIT"). The helper package loops
     * DBMS_DEBUG.CONTINUE(break_next_line) internally, so this single call only
     * returns once the interpreter reported reason_exit, or when a continuation
     * failed; the session is finished either way. Unlike the other continuation
     * helpers, DBX_CNT_EXIT has no {@code result OUT} parameter: its message
     * carries nothing but the final reason.
     */
    synchronized Map<String, Object> resumeIgnoreBreakpoints() throws Exception {
        requireOpen();
        if (terminateState()) {
            Map<String, Object> response = snapshot();
            response.put("message", "debuggee has finished");
            return response;
        }
        String message;
        try (CallableStatement call = debuggerConnection.prepareCall(
            "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_CNT_EXIT) + "(?); END;"
        )) {
            call.registerOutParameter(1, Types.VARCHAR);
            call.execute();
            message = call.getString(1);
        }
        // The message is only ' reason = <n>' (no run_info fields), so it cannot
        // be fed to applyRunInfoMessage; read the reason from it directly. A
        // reason other than reason_exit means the internal continuation stopped
        // failing, which also leaves the debuggee without a live stop point.
        Matcher reasonMatcher = FINAL_REASON_MESSAGE.matcher(message == null ? "" : message);
        if (reasonMatcher.find()) {
            currentReason = parseInteger(reasonMatcher.group(1));
        }
        terminated = true;
        touch();
        Map<String, Object> response = snapshot();
        response.put("message", message == null ? "" : message);
        return response;
    }

    synchronized Map<String, Object> abort() throws Exception {
        return continueWith(DbxPlDebugPackage.PROCEDURE_CNT_ABORT);
    }

    /**
     * Reads the scalar values of the paused frame. OceanBase serializes them
     * as a JSON payload; the raw text is returned unchanged and parsed on the
     * Rust side, which owns JSON handling for the whole protocol.
     *
     * <p>{@code frame} selects the stack frame (0, the default, is the current
     * one). The {@code DBX_GET_VALUES} wrapper has no frame argument, so a
     * non-zero frame re-reads every variable it listed through
     * {@code DBX_GET_VALUE(name, frame)} and rebuilds the same
     * {@code *name*type*value} text; when the listing is not in that Oracle
     * format (for example OceanBase's JSON) the current-frame listing is returned
     * unchanged and {@code frameScoped=false} tells the caller.
     */
    synchronized Map<String, Object> variables(int frame) throws Exception {
        requireOpen();
        if (frame < 0) {
            frame = 0;
        }
        Map<String, Object> response = snapshot();
        response.put("frame", frame);
        if (terminated) {
            response.put("scalarValues", "");
            return response;
        }
        String scalarValues;
        int result;
        try (CallableStatement call = debuggerConnection.prepareCall(
            "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_GET_VALUES) + "(?, ?); END;"
        )) {
            call.registerOutParameter(1, Types.VARCHAR);
            call.registerOutParameter(2, Types.INTEGER);
            call.execute();
            scalarValues = call.getString(1);
            result = call.getInt(2);
        }
        if (result != RESULT_SUCCESS) {
            if (result == DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE) {
                // The helper package's dynamic call failed: this server does not
                // declare DBMS_DEBUG.GET_VALUES. Breakpoints, stepping and
                // backtraces keep working; only variable inspection is missing.
                throw new IllegalStateException(
                    "Variable inspection is unavailable: this server does not declare DBMS_DEBUG.GET_VALUES"
                );
            }
            throw new IllegalStateException("DBMS_DEBUG.GET_VALUES failed (result=" + result + ")");
        }
        touch();
        if (frame > 0) {
            String scoped = frameScalarValues(scalarValues, frame);
            if (scoped != null) {
                response.put("scalarValues", scoped);
                response.put("frameScoped", true);
                return response;
            }
            LOG.fine(
                "frame " + frame + ": no frame-scoped variable listing available; returning the current frame values"
            );
            response.put("frameScoped", false);
        }
        response.put("scalarValues", scalarValues == null ? "" : scalarValues);
        return response;
    }

    /**
     * Re-reads the variable listing of another stack frame. It requires the Oracle
     * {@code *name*type*value} shape (one variable per line) and returns
     * {@code null} when the listing cannot be interpreted that way; the caller then
     * falls back to the single listing {@code DBMS_DEBUG.GET_VALUES} returns.
     */
    private String frameScalarValues(String listing, int frame) throws Exception {
        List<String[]> variables = new ArrayList<>();
        for (String line : (listing == null ? "" : listing).split("\n")) {
            String trimmed = line.trim();
            if (!trimmed.startsWith("*")) {
                continue;
            }
            String[] fields = trimmed.substring(1).split("\\*", 3);
            if (fields.length < 2) {
                continue;
            }
            String name = fields[0].trim();
            if (name.isEmpty()) {
                continue;
            }
            String typeName = "unknown";
            if (fields.length == 3 && !fields[1].trim().isEmpty()) {
                typeName = fields[1].trim();
            }
            variables.add(new String[] {name, typeName});
        }
        if (variables.isEmpty()) {
            return null;
        }
        StringBuilder builder = new StringBuilder();
        for (String[] variable : variables) {
            String value;
            int result;
            try (CallableStatement call = debuggerConnection.prepareCall(
                "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_GET_VALUE) + "(?, ?, ?, ?); END;"
            )) {
                call.setString(1, variable[0]);
                call.setInt(2, frame);
                call.registerOutParameter(3, Types.VARCHAR);
                call.registerOutParameter(4, Types.INTEGER);
                call.execute();
                value = call.getString(3);
                result = call.getInt(4);
            }
            if (result != RESULT_SUCCESS) {
                // A single unreadable variable (optimized out, wrong scope) must not
                // drop the whole frame; it is logged and skipped.
                LOG.fine(
                    "get_value(" + variable[0] + ", frame=" + frame + ") failed (result=" + result + ")"
                );
                continue;
            }
            builder.append('*')
                .append(variable[0])
                .append('*')
                .append(variable[1])
                .append('*')
                .append(value == null ? "" : value)
                .append('\n');
        }
        return builder.length() == 0 ? null : builder.toString();
    }

    /**
     * Renders the PL/SQL assignment {@code DBMS_DEBUG.SET_VALUE} executes inside the
     * debuggee. Its second argument is statement <em>text</em>, not a value: the
     * caller is responsible for the literal, so a string arrives already quoted
     * ("'abc'") and is forwarded verbatim -- adding quotes here would double them. An
     * index &gt; 0 addresses a collection element ("x(1) := 5"), unless the name
     * already carries its own index. Mirrors the Go driver's
     * {@code plDebugAssignmentStatement}.
     *
     * <p>No terminator is appended: Oracle's reference examples show one
     * ({@code 'x := 3;'}) and the primitive may append it itself. Whichever form a
     * real server wants is not verified, so {@link #setValue} retries exactly once
     * with a trailing {@code ";"} when the wrapper answers with a syntax error
     * ({@link #assignmentSyntaxError}) -- a missing primitive is never retried.
     */
    static String assignmentStatement(String name, int index, String value) {
        String target = name == null ? "" : name.trim();
        if (index > 0 && !target.contains("(")) {
            target = target + "(" + index + ")";
        }
        return target + " := " + value;
    }

    /**
     * Reports whether a dynamically executed {@code DBMS_DEBUG} call failed because
     * the server does not declare the routine at all, as opposed to failing while
     * running it. Both end in the -1 sentinel, and only the server message tells
     * them apart: {@code PLS-00201} / {@code PLS-00302} / {@code ORA-00904} mean the
     * primitive is absent, while anything else -- a malformed assignment, for
     * example -- is a real failure that must not be reported as "this server does
     * not support it".
     */
    static boolean capabilityMissing(String message) {
        if (message == null || message.trim().isEmpty()) {
            // A helper package installed before V6 reports the sentinel without a
            // message; keep the conservative "unavailable" answer for it.
            return true;
        }
        String upper = message.toUpperCase(Locale.ROOT);
        for (String marker : new String[] {"PLS-00201", "PLS-00302", "ORA-00904", "MUST BE DECLARED", "NOT DECLARED"}) {
            if (upper.contains(marker)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Reports whether a failed {@code DBX_SET_VALUE} call failed at <em>compile</em>
     * time on the assignment text -- the case where the form the agent passed may
     * simply need its PL/SQL terminator. Oracle's reference examples pass
     * {@code 'x := 3;'} and {@code 'var := 6;'}, while
     * {@link #assignmentStatement} deliberately omits the terminator because the
     * primitive may append it itself; which of the two a real server wants is not
     * verified yet, so this predicate only decides whether one bounded retry with the
     * terminator is worth it.
     *
     * <p>{@code ORA-06550} is the "PL/SQL: compilation unit analysis terminated"
     * prefix {@code PLS-00103} arrives with -- and it also prefixes
     * {@code PLS-00201}/{@code PLS-00302}. A missing primitive is therefore excluded
     * first: that is a capability answer, not a form answer, and must never be
     * retried. Mirrors the Go driver's {@code plDebugAssignmentSyntaxError}.
     */
    static boolean assignmentSyntaxError(String message) {
        if (capabilityMissing(message)) {
            return false;
        }
        String upper = message == null ? "" : message.toUpperCase(Locale.ROOT);
        for (String marker : new String[] {"PLS-00103", "ORA-06550", "ENCOUNTERED THE SYMBOL", "SYNTAX"}) {
            if (upper.contains(marker)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Builds the single retry form of an assignment: the same text plus its PL/SQL
     * terminator. An assignment that already ends in {@code ";"} is returned
     * unchanged, which the caller reads as "no retry form available" -- appending a
     * second terminator would be a different, still-invalid form. Mirrors the Go
     * driver's {@code plDebugRetryAssignmentStatement}.
     */
    static String retryAssignmentStatement(String assignment) {
        String text = assignment == null ? "" : assignment;
        String trimmed = text.replaceAll("[ \t\r\n]+$", "");
        if (trimmed.endsWith(";")) {
            return text;
        }
        return text + ";";
    }

    /**
     * Decides whether a {@code DBX_SET_VALUE} result warrants exactly one retry with
     * the assignment's terminator appended, returning the text to retry with or
     * {@code null} for "do not retry". It is the whole retry policy, so it can be
     * tested without a database:
     *
     * <ul>
     *   <li>success (or any other non-sentinel result): no retry, the first form worked;</li>
     *   <li>missing primitive ({@code PLS-00201}/{@code PLS-00302}/{@code ORA-00904}):
     *       no retry, report unsupported;</li>
     *   <li>syntax-level rejection ({@code PLS-00103} / {@code ORA-06550} /
     *       "encountered the symbol"): retry once with the terminator;</li>
     *   <li>any other rejection: no retry, report the server's message verbatim.</li>
     * </ul>
     *
     * <p>Mirrors the Go driver's {@code plDebugSetValueRetry}.
     */
    static String setValueRetry(int result, String message, String assignment) {
        if (result != DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE) {
            return null;
        }
        if (!assignmentSyntaxError(message)) {
            return null;
        }
        String retry = retryAssignmentStatement(assignment);
        if (retry.equals(assignment == null ? "" : assignment)) {
            return null;
        }
        return retry;
    }

    /** One {@code DBX_SET_VALUE} call: the wrapper's result code plus its SQLERRM message. */
    private static final class SetValueOutcome {
        private final int result;
        private final String message;

        private SetValueOutcome(int result, String message) {
            this.result = result;
            this.message = message;
        }
    }

    /**
     * Performs exactly one {@code DBX_SET_VALUE} call and returns the wrapper's result
     * code plus its message register (which is {@code NULL} on the success path).
     * Mirrors the Go driver's {@code callSetValue}.
     */
    private SetValueOutcome callSetValue(int frame, String assignment) throws Exception {
        try (CallableStatement call = debuggerConnection.prepareCall(
            "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_SET_VALUE) + "(?, ?, ?, ?); END;"
        )) {
            call.setInt(1, frame);
            call.setString(2, assignment);
            call.registerOutParameter(3, Types.INTEGER);
            call.registerOutParameter(4, Types.VARCHAR);
            call.execute();
            return new SetValueOutcome(call.getInt(3), call.getString(4));
        }
    }

    /**
     * Changes a variable of the parked debuggee through {@code DBX_SET_VALUE}, which
     * resolves {@code dbms_debug.set_value(frame#, assignment_statement)}
     * dynamically: the name, index and value are assembled into a PL/SQL assignment
     * statement (the value is forwarded verbatim) and sent exactly as
     * {@link #assignmentStatement} renders it, without a terminator. The wrapper's
     * message then decides what to do:
     *
     * <ul>
     *   <li>a missing primitive ({@code PLS-00201}/{@code PLS-00302}/{@code ORA-00904})
     *       is reported as "unsupported" and never retried;</li>
     *   <li>a syntax-level rejection of the text is retried <em>once</em> with a
     *       trailing {@code ";"}, because Oracle's own examples pass the terminator
     *       and neither form is verified against a real server yet;</li>
     *   <li>anything else is reported verbatim.</li>
     * </ul>
     *
     * <p>The response says which form won through {@code assignmentSemicolon}, so a
     * real-machine run can tell the two forms apart without guessing. The request
     * contract ({@code debugId,name,frame,index,value}) is unchanged; only this extra
     * response field is added. Mirrors the Go driver's {@code setValue}.
     */
    synchronized Map<String, Object> setValue(String name, int frame, int index, String value) throws Exception {
        requireOpen();
        ensureNotTerminated("set value");
        String variableName = name == null ? "" : name.trim();
        String assignment = assignmentStatement(variableName, index, value);
        SetValueOutcome outcome = callSetValue(frame, assignment);
        int result = outcome.result;
        String serverMessage = outcome.message;
        // The sentinel covers "the routine is not declared" and "the assignment was
        // rejected" at once, so the message decides: a missing primitive is answered
        // before any retry, because retrying a capability answer is pointless.
        if (result == DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE && capabilityMissing(serverMessage)) {
            throw new IllegalStateException("该服务器不支持改变量值（DBMS_DEBUG.SET_VALUE 不可用）");
        }
        boolean usedTerminator = false;
        String retryAssignment = setValueRetry(result, serverMessage, assignment);
        if (retryAssignment != null) {
            usedTerminator = true;
            outcome = callSetValue(frame, retryAssignment);
            result = outcome.result;
            serverMessage = outcome.message;
            if (result == DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE && capabilityMissing(serverMessage)) {
                throw new IllegalStateException("该服务器不支持改变量值（DBMS_DEBUG.SET_VALUE 不可用）");
            }
        }
        if (result == DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE) {
            throw new IllegalStateException("set_value failed: " + (serverMessage == null ? "" : serverMessage.trim()));
        }
        touch();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", result == RESULT_SUCCESS);
        response.put("result", result);
        String message = result == RESULT_SUCCESS
            ? "set " + variableName + " (frame=" + frame + ", index=" + index + ")"
                + (usedTerminator ? " (assignment retried with a trailing \";\")" : "")
            : "DBMS_DEBUG.SET_VALUE returned result=" + result + " for " + variableName
                + " (frame=" + frame + ", index=" + index + ")";
        response.put("message", message);
        response.put("assignmentSemicolon", usedTerminator);
        response.put("snapshot", snapshot());
        return response;
    }

    /**
     * Turns a {@code DBMS_DEBUG} ENABLE_BREAKPOINT / DISABLE_BREAKPOINT result into
     * the message the client shows. The -1 capability sentinel must stay distinct
     * from {@code error_no_such_breakpt} (13): the latter means the server does
     * implement the primitive but does not know that breakpoint number. Mirrors the
     * Go driver's {@code plDebugBreakpointEnabledMessage}.
     */
    static String breakpointEnabledMessage(int breakpoint, boolean enabled, int result) {
        String action = enabled ? "启用" : "禁用";
        if (result == RESULT_SUCCESS) {
            return "断点 " + breakpoint + " 已" + action;
        }
        if (result == DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE) {
            return "该服务器不支持" + action + "断点（DBMS_DEBUG.ENABLE_BREAKPOINT / DISABLE_BREAKPOINT 不可用），"
                + "请保留客户端兜底路径";
        }
        if (result == ERROR_NO_SUCH_BREAKPOINT) {
            return "断点 " + breakpoint + " 不存在（error_no_such_breakpt），无法" + action;
        }
        return "断点 " + breakpoint + " " + action + "失败：DBMS_DEBUG 返回 result=" + result;
    }

    /**
     * Toggles an existing breakpoint through {@code DBX_ENABLE_BREAKPOINT} /
     * {@code DBX_DISABLE_BREAKPOINT}, which wrap the
     * {@code DBMS_DEBUG.ENABLE_BREAKPOINT} / {@code DISABLE_BREAKPOINT} functions
     * dynamically (both take the breakpoint number and return success /
     * error_no_such_breakpt / error_idle_breakpt).
     *
     * <p>A result of -1 is the capability sentinel and is reported through
     * {@code serverSupported=false} instead of an error, so the front end keeps its
     * client-side fallback (delete the breakpoint and re-set it to re-enable) on the
     * servers that have no such primitive.
     */
    synchronized Map<String, Object> setBreakpointEnabled(int breakpoint, boolean enabled) throws Exception {
        requireOpen();
        ensureNotTerminated("set breakpoint enabled");
        if (breakpoint <= 0) {
            throw new IllegalArgumentException("breakpointNumber must be a positive breakpoint number");
        }
        String procedure = enabled ? DbxPlDebugPackage.PROCEDURE_ENABLE_BREAKPOINT : DbxPlDebugPackage.PROCEDURE_DISABLE_BREAKPOINT;
        int result;
        try (CallableStatement call = debuggerConnection.prepareCall(
            "BEGIN " + qualifiedCall(procedure) + "(?, ?); END;"
        )) {
            call.setInt(1, breakpoint);
            call.registerOutParameter(2, Types.INTEGER);
            call.execute();
            result = call.getInt(2);
        }
        touch();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", result == RESULT_SUCCESS);
        response.put("result", result);
        response.put("breakpointNumber", breakpoint);
        response.put("enabled", enabled);
        response.put("serverSupported", result != DbxPlDebugPackage.RESULT_CAPABILITY_UNAVAILABLE);
        response.put("message", breakpointEnabledMessage(breakpoint, enabled, result));
        response.put("snapshot", snapshot());
        return response;
    }

    /** One PRINT_BACKTRACE result: the listing plus the DBMS status code. */
    private static final class Backtrace {
        private final String listing;
        private final int status;

        private Backtrace(String listing, int status) {
            this.listing = listing;
            this.status = status;
        }
    }

    /**
     * Queries DBX_PRINT_BACKTRACE and folds the listing into the session's current
     * line/program. The run_info message no longer carries the line (ODC's does not
     * either): the current line and the object the interpreter is parked in come from
     * this listing. Mirrors the Go driver's {@code fetchBacktrace}.
     */
    private Backtrace fetchBacktrace() throws Exception {
        String listing;
        int status;
        try (CallableStatement call = debuggerConnection.prepareCall(
            "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_PRINT_BACKTRACE) + "(?, ?); END;"
        )) {
            // `listing` is IN OUT: register the OUT register first, then seed
            // the IN side so the driver sends a well-formed parameter.
            call.registerOutParameter(1, Types.VARCHAR);
            call.setString(1, "");
            call.registerOutParameter(2, Types.INTEGER);
            call.execute();
            listing = call.getString(1);
            status = call.getInt(2);
        }
        touch();
        applyBacktraceListing(listing);
        return new Backtrace(listing, status);
    }

    /**
     * Pulls the current backtrace into the session fields. A failure is logged only:
     * a backtrace miss must never take a live session down. Mirrors the Go driver's
     * {@code refreshBacktrace}.
     */
    private synchronized void refreshBacktrace() {
        if (terminated) {
            return;
        }
        try {
            fetchBacktrace();
        } catch (Exception error) {
            LOG.log(Level.FINE, "backtrace refresh failed (ignored)", error);
        }
    }

    synchronized Map<String, Object> stack() throws Exception {
        requireOpen();
        Map<String, Object> response = snapshot();
        // frames is always present (as an array) so the client can render the stack
        // pane without a nil check.
        response.put("frames", new ArrayList<Map<String, Object>>());
        if (terminated) {
            response.put("backtrace", "");
            return response;
        }
        Backtrace backtrace = fetchBacktrace();
        String listing = backtrace.listing;
        int status = backtrace.status;
        response.put("line", currentLine);
        response.put("program", currentProgram);
        response.put("programOwner", currentProgramOwner);
        response.put("backtrace", listing == null ? "" : listing);
        response.put("dbmsStatus", status);
        // Every frame of the listing, first frame = current frame. The run_info
        // stack depth is the depth of the current frame, so it renumbers the frames
        // when it is known; the parser's own ordering is the fallback.
        List<Map<String, Object>> frames = parseBacktraceFrames(listing);
        Integer stackDepth = currentStackDepth;
        if (stackDepth != null && stackDepth > 0) {
            for (int index = 0; index < frames.size(); index++) {
                int depth = stackDepth - index;
                frames.get(index).put("stackDepth", Math.max(depth, 0));
            }
        }
        if (!frames.isEmpty()) {
            frames.get(0).put("programOwner", currentProgramOwner == null ? "" : currentProgramOwner);
        }
        response.put("frames", frames);
        return response;
    }

    /**
     * Turns the whole {@code PRINT_BACKTRACE} listing into a call stack.
     * {@code DBMS_DEBUG} prints one {@code "[Line N] NAME"} entry per frame,
     * innermost first, so the first parsed frame is the current one. Lines that
     * carry no {@code [Line N]} entry are skipped: the listing can contain program
     * source or blank lines, and a parsing miss there must not drop the frames that
     * did parse. Mirrors the Go driver's {@code plDebugParseBacktraceFrames}.
     */
    static List<Map<String, Object>> parseBacktraceFrames(String listing) {
        List<Map<String, Object>> frames = new ArrayList<>();
        for (String line : (listing == null ? "" : listing).split("\n")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            int marker = trimmed.indexOf("Line");
            if (marker < 0) {
                continue;
            }
            String rest = trimmed.substring(marker + "Line".length()).trim();
            int digits = 0;
            while (digits < rest.length() && rest.charAt(digits) >= '0' && rest.charAt(digits) <= '9') {
                digits++;
            }
            if (digits == 0) {
                continue;
            }
            Integer lineNumber = parseInteger(rest.substring(0, digits));
            rest = rest.substring(digits).trim();
            if (rest.startsWith("]")) {
                rest = rest.substring(1).trim();
            }
            if (rest.isEmpty() || lineNumber == null) {
                continue;
            }
            Map<String, Object> frame = new LinkedHashMap<>();
            frame.put("stackDepth", 0);
            frame.put("line", lineNumber);
            frame.put("program", rest);
            frame.put("programOwner", "");
            frames.add(frame);
        }
        for (int index = 0; index < frames.size(); index++) {
            frames.get(index).put("stackDepth", frames.size() - index);
        }
        return frames;
    }

    synchronized Map<String, Object> log() throws Exception {
        requireOpen();
        Map<String, Object> response = snapshot();
        String output = "";
        // DBMS_OUTPUT is readable only after the interpreter released the
        // debuggee connection (debug_off / program finished).
        if (terminateState()) {
            try (CallableStatement call = debuggeeConnection.prepareCall(
                "BEGIN " + qualifiedCall(DbxPlDebugPackage.PROCEDURE_GET_LINE) + "(?, ?); END;"
            )) {
                call.registerOutParameter(1, Types.VARCHAR);
                call.registerOutParameter(2, Types.INTEGER);
                call.execute();
                output = call.getString(1);
            } catch (Exception ignored) {
                // Output is best effort; a closed or busy debuggee must not fail the call.
            }
        }
        response.put("output", output == null ? "" : output);
        return response;
    }

    synchronized Map<String, Object> snapshot() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("debugId", debugId);
        response.put("owner", owner);
        response.put("terminated", terminateState());
        response.put("line", currentLine);
        response.put("program", currentProgram);
        response.put("programOwner", currentProgramOwner);
        response.put("breakpoint", currentBreakpoint);
        response.put("reason", currentReason);
        response.put("stackDepth", currentStackDepth);
        response.put("error", debuggeeError);
        response.put("expired", isExpired());
        // stoppedOnException is true only when the last exception-mode resume
        // stopped on reason_exception / reason_handler.
        response.put("stoppedOnException", stoppedOnException);
        response.put("exceptionBreakpoint", exceptionBreakpoint);
        return response;
    }

    boolean isExpired() {
        return System.currentTimeMillis() - lastActivityMillis > timeoutMillis;
    }

    /** True once the debuggee program finished (or failed) and the session can be closed. */
    private boolean terminateState() {
        if (terminated) {
            return true;
        }
        Future<?> future = debuggeeFuture;
        if (future != null && future.isDone()) {
            terminated = true;
        }
        if (terminated && debugOffSent.compareAndSet(false, true)) {
            // Release the debuggee's debug mode as soon as the program is done:
            // DBMS_OUTPUT reads block while the interpreter still holds it.
            executeStatementQuietly(debuggeeConnection, "CALL DBMS_DEBUG.DEBUG_OFF()");
        }
        return terminated;
    }

    @Override
    public synchronized void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        try {
            executeStatementQuietly(debuggeeConnection, "CALL DBMS_DEBUG.DEBUG_OFF()");
        } catch (Exception ignored) {
        }
        Future<?> future = debuggeeFuture;
        if (future != null && !future.isDone()) {
            future.cancel(true);
        }
        // Unmount the debugger session before dropping its connection; it releases
        // the interpreter's attachment on the debuggee. DEBUG_OFF stays as-is.
        executeStatementQuietly(debuggerConnection, "CALL DBMS_DEBUG.DETACH_SESSION()");
        closeQuietly(debuggerConnection);
        closeQuietly(debuggeeConnection);
    }

    /**
     * Installs the helper package only when it is missing, invalid, older than
     * {@link DbxPlDebugPackage#VERSION_NOTE}, or declared without the routines the
     * body calls (mirrors the Go driver's {@code plDebugEnsureHelperPackage}).
     * Rebuilding unconditionally would replace a package another tool may share and
     * recompile DDL on every start. Returns the overload attributes the installed
     * package can store.
     */
    private static DbxPlDebugPackage.ProgramInfoFields ensureHelperPackage(
        Connection debuggeeConnection,
        String owner
    ) throws Exception {
        DbxPlDebugPackage.ProgramInfoFields programInfoFields = probeProgramInfoFields(debuggeeConnection);
        boolean headValid = objectValid(debuggeeConnection, owner, DbxPlDebugPackage.PACKAGE_NAME, "PACKAGE");
        if (headValid) {
            // A head that predates the breakpoint enable/disable wrappers, the
            // start-sequence routines, or one whose DBX_SET_VALUE still has the old
            // four-argument parameter list, has to be replaced before the new body is
            // installed: a stale head fails the body with PLS-00302 (missing routine)
            // or PLS-00306 (changed signature) and leaves it INVALID.
            headValid = headDeclares(debuggeeConnection, owner, DbxPlDebugPackage.HEAD_REQUIREMENTS);
        }
        if (!headValid) {
            executeStatement(debuggeeConnection, DbxPlDebugPackage.packageHead(owner));
        }
        boolean bodyValid = objectValid(debuggeeConnection, owner, DbxPlDebugPackage.PACKAGE_NAME, "PACKAGE BODY");
        boolean versionCurrent = bodyValid && packageVersionCurrent(debuggeeConnection, owner);
        if (!bodyValid || !versionCurrent) {
            executeStatement(debuggeeConnection, DbxPlDebugPackage.packageBody(owner, programInfoFields));
        }
        return programInfoFields;
    }

    /**
     * Reports whether the installed PACKAGE head already declares every routine the
     * body calls; a head left behind by an older install lacks the new declarations.
     */
    private static boolean headDeclares(Connection connection, String owner, List<String> routines) throws Exception {
        StringBuilder source = new StringBuilder();
        try (PreparedStatement statement = connection.prepareStatement(
            "SELECT TEXT FROM ALL_SOURCE WHERE OWNER = ? AND NAME = ? AND TYPE = 'PACKAGE' ORDER BY LINE"
        )) {
            statement.setString(1, owner);
            statement.setString(2, DbxPlDebugPackage.PACKAGE_NAME);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    String text = result.getString(1);
                    if (text != null) {
                        source.append(text).append('\n');
                    }
                }
            }
        }
        String declared = source.toString().toUpperCase(Locale.ROOT);
        for (String routine : routines) {
            if (!declared.contains(routine.toUpperCase(Locale.ROOT))) {
                return false;
            }
        }
        return true;
    }

    /**
     * Reports whether {@code DBMS_DEBUG.PROGRAM_INFO} declares the given attribute.
     * The probe is a dynamically executed block that assigns the field and catches
     * everything: a missing field raises PLS-00302 at run time, which
     * {@code WHEN OTHERS} absorbs, so nothing here can ever leave the helper package
     * INVALID (a static reference in the DDL would).
     *
     * <p>On a real server the probe is EXPECTED to answer "no": Oracle 21c XE's
     * PROGRAM_INFO record has exactly NAMESPACE/NAME/OWNER/DBLINK/LINE#/LIBUNITTYPE/
     * ENTRYPOINTNAME (verified against {@code ALL_PLSQL_TYPE_ATTRS}), i.e. neither a
     * signature nor a sequence field. The probe is kept because other engines may
     * extend the record, and because the overload warning below still has to fire
     * when the attributes are unavailable.
     */
    private static boolean probeProgramInfoField(Connection connection, String field, String literal) {
        if (!"signature".equals(field) && !"sequence".equals(field) && !"entrypointname".equals(field)) {
            return false;
        }
        String probe = "BEGIN EXECUTE IMMEDIATE 'DECLARE p dbms_debug.program_info; BEGIN p."
            + field
            + " := "
            + literal
            + "; END;'; :1 := 1; EXCEPTION WHEN OTHERS THEN :1 := 0; END;";
        try (CallableStatement call = connection.prepareCall(probe)) {
            call.registerOutParameter(1, Types.INTEGER);
            call.execute();
            return call.getInt(1) == 1;
        } catch (Exception error) {
            // Also an expected result on a server that declares neither attribute;
            // the caller only downgrades the overload warning, it never fails a start.
            LOG.log(Level.FINE, "probing dbms_debug.program_info." + field + " failed", error);
            return false;
        }
    }

    /**
     * Discovers the optional overload attributes of the server's program_info
     * record. Both flags are expected to be false on stock Oracle (21c XE verified:
     * the record type carries no signature/sequence attribute), which is why the
     * overload warning still fires for targets the server cannot disambiguate.
     *
     * <p>{@code entrypointname} is a different case: it IS part of the standard record
     * type (Oracle 19c EE and 21c XE declare it) and it is what makes a breakpoint on a
     * subprogram inside a package body armable at all -- see
     * {@link DbxPlDebugPackage#PROCEDURE_SET_BREAKPOINT_ENTRY}. The flag is still probed
     * rather than assumed, so an engine whose record lacks the attribute keeps a body
     * that compiles instead of one that fails with PLS-00302.
     */
    private static DbxPlDebugPackage.ProgramInfoFields probeProgramInfoFields(Connection connection) {
        return new DbxPlDebugPackage.ProgramInfoFields(
            probeProgramInfoField(connection, "signature", "''DBX''"),
            probeProgramInfoField(connection, "sequence", "1"),
            probeProgramInfoField(connection, "entrypointname", "''DBX''")
        );
    }

    /** Mirrors the Go driver: present in ALL_SOURCE and VALID in ALL_OBJECTS. */
    private static boolean objectValid(Connection connection, String owner, String objectName, String objectType)
        throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(
            "SELECT COUNT(1) FROM ALL_SOURCE WHERE OWNER = ? AND NAME = ? AND TYPE = ?"
        )) {
            statement.setString(1, owner);
            statement.setString(2, objectName);
            statement.setString(3, objectType);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next() || result.getInt(1) < 1) {
                    return false;
                }
            }
        }
        try (PreparedStatement statement = connection.prepareStatement(
            "SELECT STATUS FROM ALL_OBJECTS WHERE OWNER = ? AND OBJECT_NAME = ? AND OBJECT_TYPE = ?"
        )) {
            statement.setString(1, owner);
            statement.setString(2, objectName);
            statement.setString(3, objectType);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next() || result.getString(1) == null) {
                    return false;
                }
                return "VALID".equalsIgnoreCase(result.getString(1).trim());
            }
        }
    }

    /**
     * Reads the package body's first ALL_SOURCE line, which carries the version
     * note -- and, since V6.2, the body-fix note as well -- on the same line as the
     * {@code CREATE OR REPLACE PACKAGE BODY} header. Both markers are required: the
     * shared V6 identity keeps the Go agent and this agent from rebuilding each other's
     * package, while the fix note forces a body installed before the namespace /
     * run_info-mask / entrypointname fixes to be replaced. Ignoring it would leave the
     * Go and Java agents rebuilding each other's body forever.
     */
    private static boolean packageVersionCurrent(Connection connection, String owner) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(
            "SELECT S.TEXT"
                + " FROM (SELECT * FROM ALL_OBJECTS WHERE OBJECT_TYPE = 'PACKAGE BODY') O"
                + " RIGHT JOIN ALL_SOURCE S ON S.NAME = O.OBJECT_NAME AND S.OWNER = O.OWNER AND S.TYPE = O.OBJECT_TYPE"
                + " WHERE S.OWNER = ? AND S.NAME = ? ORDER BY S.LINE"
        )) {
            statement.setString(1, owner);
            statement.setString(2, DbxPlDebugPackage.PACKAGE_NAME);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next() || result.getString(1) == null) {
                    return false;
                }
                String header = result.getString(1);
                // Both agents now render the same V6.3 body, so this agent's own note is the
                // single requirement. A body left behind by an older build carries the V6.2
                // note (or no note at all) and is replaced, which is what keeps the two
                // agents from rebuilding each other's body forever.
                return header.contains(DbxPlDebugPackage.VERSION_NOTE)
                    && header.contains(DbxPlDebugPackage.BODY_FIX_NOTE);
            }
        }
    }

    private Map<String, Object> continueWith(String procedureName) throws Exception {
        requireOpen();
        if (terminateState()) {
            Map<String, Object> response = snapshot();
            response.put("message", "debuggee has finished");
            return response;
        }
        int result;
        String message;
        try (CallableStatement call = debuggerConnection.prepareCall(
            "BEGIN " + qualifiedCall(procedureName) + "(?, ?); END;"
        )) {
            call.registerOutParameter(1, Types.INTEGER);
            call.registerOutParameter(2, Types.VARCHAR);
            call.execute();
            result = call.getInt(1);
            message = call.getString(2);
        }
        if (result != RESULT_SUCCESS) {
            // A failed continue usually means the debuggee terminated underneath us.
            debuggeeError = debuggeeError != null
                ? debuggeeError
                : "DBMS_DEBUG.CONTINUE failed (result=" + result + ")";
        }
        applyRunInfoMessage(message);
        touch();
        Map<String, Object> response = snapshot();
        response.put("message", message == null ? "" : message);
        return response;
    }

    private void applyRunInfoMessage(String message) {
        if (message == null || message.isEmpty()) {
            return;
        }
        Matcher matcher = RUN_INFO_MESSAGE.matcher(message);
        if (!matcher.find()) {
            return;
        }
        currentBreakpoint = parseInteger(matcher.group(1));
        currentStackDepth = parseInteger(matcher.group(2));
        currentReason = parseInteger(matcher.group(3));
        String program = matcher.group(4) == null ? "" : matcher.group(4).trim();
        String programOwner = matcher.group(5) == null ? "" : matcher.group(5).trim();
        currentProgram = program.isEmpty() ? null : program;
        currentProgramOwner = programOwner.isEmpty() ? null : programOwner;
    }

    /**
     * Extracts the current line and program from the PRINT_BACKTRACE listing,
     * e.g. {@code "[Line 8] PROC"} -- the run_info message no longer carries the
     * line, exactly as in ODC and the Go driver.
     */
    private void applyBacktraceListing(String listing) {
        if (listing == null || listing.isEmpty()) {
            return;
        }
        Matcher matcher = BACKTRACE_FRAME.matcher(listing);
        if (!matcher.find()) {
            return;
        }
        Integer line = parseInteger(matcher.group(1));
        currentLine = line != null && line > 0 ? line.toString() : null;
        String program = matcher.group(2) == null ? "" : matcher.group(2).trim();
        if (!program.isEmpty()) {
            currentProgram = program;
        }
    }

    private void deleteBreakpointNumber(int breakpointNumber) throws Exception {
        // DBMS_DEBUG.DELETE_BREAKPOINT is a function on real Oracle, where the
        // statement form would fail (PLS-00221); engines that expose it as a
        // procedure only accept CALL. Try the function shape first, then fall
        // back, so neither implementation blocks a breakpoint deletion.
        try (PreparedStatement statement = debuggerConnection.prepareStatement(
            "SELECT DBMS_DEBUG.DELETE_BREAKPOINT(?) FROM DUAL"
        )) {
            statement.setInt(1, breakpointNumber);
            statement.execute();
        } catch (Exception functionFormError) {
            try (CallableStatement call = debuggerConnection.prepareCall("CALL DBMS_DEBUG.DELETE_BREAKPOINT(?)")) {
                call.setInt(1, breakpointNumber);
                call.execute();
            }
        }
    }

    /**
     * Runs the debugging target on the debuggee connection. The statement
     * blocks there until the debugger issues continue/abort or the program
     * finishes; the outcome is captured for {@link #snapshot()}.
     */
    private void runDebuggeeTarget(PlDebugStartRequest request) {
        try {
            String objectType = request.getObjectType() == null ? "" : request.getObjectType().trim().toUpperCase();
            if ("ANONYMOUS".equals(objectType)) {
                try (Statement statement = debuggeeConnection.createStatement()) {
                    statement.execute(stripTrailingSlash(request.getSource()));
                }
                return;
            }
            String routine = resolveRoutineName(request);
            List<PlDebugParam> params = request.getParams();
            boolean hasReturn = "FUNCTION".equals(objectType);
            // The very same block text is what debugBefore locates the call line in,
            // so the debugger arms its breakpoint on exactly the statement the
            // debuggee is running.
            String block = anonymousBlock(routine, hasReturn, params.size());
            try (CallableStatement call = debuggeeConnection.prepareCall(block)) {
                int parameterIndex = 1;
                if (hasReturn) {
                    call.registerOutParameter(parameterIndex++, Types.VARCHAR);
                }
                for (PlDebugParam param : params) {
                    bindParameter(call, parameterIndex++, param);
                }
                call.execute();
            }
        } catch (Exception error) {
            debuggeeError = error.getMessage() == null ? error.toString() : error.getMessage();
        } finally {
            terminated = true;
        }
    }

    private String resolveRoutineName(PlDebugStartRequest request) {
        String packageName = request.getPackageName() == null ? "" : request.getPackageName().trim();
        String objectName = request.getObjectName() == null ? "" : request.getObjectName().trim();
        StringBuilder name = new StringBuilder();
        if (owner != null && !owner.isEmpty()) {
            name.append('"').append(owner.replace("\"", "\"\"")).append("\".");
        }
        if (!packageName.isEmpty()) {
            name.append('"').append(packageName.toUpperCase().replace("\"", "\"\"")).append("\".");
        }
        name.append('"').append(objectName.toUpperCase().replace("\"", "\"\"")).append('"');
        return name.toString();
    }

    /**
     * Renders the anonymous block that calls the target. The call sits on its own
     * line (line 2) so DBMS_DEBUG can be given that line number, which is what ODC
     * gets out of the anonymous block its parser produces, and so
     * {@link #anonymousCallLine} finds it. Mirrors the Go driver's
     * {@code plDebugAnonymousBlock} ({@code ?} is the JDBC bind placeholder where the
     * Go driver binds named variables).
     */
    static String anonymousBlock(String routine, boolean isFunction, int paramCount) {
        StringBuilder block = new StringBuilder("BEGIN\n  ");
        if (isFunction) {
            block.append("? := ");
        }
        block.append(routine).append('(');
        for (int index = 0; index < paramCount; index++) {
            if (index > 0) {
                block.append(", ");
            }
            block.append('?');
        }
        block.append(");\nEND;");
        return block.toString();
    }

    /**
     * Returns the 1-based line of the target routine call inside an anonymous block --
     * the equivalent of ODC's {@code AnonymousBlockProcedureCall.getCallLine}. It
     * scans the block top to bottom and returns 0 when the routine is never called.
     * Comment-only lines and anything inside block comments are ignored (an ODC block
     * opens with a banner comment and the call still has to report its physical line
     * number); a call whose argument list starts on the following line still reports
     * the line the call starts on. Mirrors the Go driver's
     * {@code plDebugAnonymousCallLine}.
     */
    static int anonymousCallLine(String block, String routine) {
        String name = routineToken(routine);
        if (name.isEmpty()) {
            return 0;
        }
        String[] lines = (block == null ? "" : block).split("\n", -1);
        String[] code = new String[lines.length];
        boolean[] inBlockComment = new boolean[] {false};
        for (int index = 0; index < lines.length; index++) {
            code[index] = stripSqlComments(lines[index], inBlockComment);
        }
        for (int index = 0; index < code.length; index++) {
            if (code[index].trim().isEmpty()) {
                continue;
            }
            if (codeCallsRoutine(code[index], routine)) {
                return index + 1;
            }
            if (!lineNamesRoutine(code[index], routine)) {
                continue;
            }
            for (int next = index + 1; next < code.length; next++) {
                String trimmed = code[next].trim();
                if (trimmed.isEmpty()) {
                    continue;
                }
                if (trimmed.startsWith("(")) {
                    return index + 1;
                }
                break;
            }
        }
        return 0;
    }

    /**
     * Reports whether one comment-free line of SQL text calls the routine: the
     * routine's trailing identifier must be followed by {@code "("} (spaces and tabs
     * allowed). A qualified call ({@code "OWNER"."PKG"."PROC"}) and a bare local call
     * are both recognised, because only the trailing identifier is matched. Mirrors
     * the Go driver's {@code plDebugCodeCallsRoutine}.
     */
    static boolean codeCallsRoutine(String code, String routine) {
        String name = routineToken(routine);
        if (name.isEmpty()) {
            return false;
        }
        String normalized = normalizeIdentifier(code);
        int offset = 0;
        while (offset + name.length() <= normalized.length()) {
            int found = normalized.indexOf(name, offset);
            if (found < 0) {
                return false;
            }
            int end = found + name.length();
            offset = end;
            // A longer identifier that merely ends in the routine name is not a call.
            if (end < normalized.length() && isIdentifierChar(normalized.charAt(end))) {
                continue;
            }
            if (startsWithParenthesis(normalized.substring(end))) {
                return true;
            }
        }
        return false;
    }

    /** The Go driver's {@code strings.TrimLeft(text, " \t")} followed by its "(" test. */
    private static boolean startsWithParenthesis(String text) {
        int index = 0;
        while (index < text.length() && (text.charAt(index) == ' ' || text.charAt(index) == '\t')) {
            index++;
        }
        return text.startsWith("(", index);
    }

    /**
     * Reports whether the comment-free line ends with the routine's trailing
     * identifier, i.e. the call's argument list opens on one of the following lines.
     * Mirrors the Go driver's {@code plDebugLineNamesRoutine}.
     */
    static boolean lineNamesRoutine(String code, String routine) {
        String name = routineToken(routine);
        if (name.isEmpty()) {
            return false;
        }
        return trimTrailingSpaceTab(normalizeIdentifier(code)).endsWith(name);
    }

    private static String trimTrailingSpaceTab(String text) {
        int end = text.length();
        while (end > 0 && (text.charAt(end - 1) == ' ' || text.charAt(end - 1) == '\t')) {
            end--;
        }
        return text.substring(0, end);
    }

    /**
     * Reduces a qualified routine reference to its trailing, quote-free, upper-case
     * identifier ({@code "OWNER"."PKG"."PROC" -> PROC}). Mirrors the Go driver's
     * {@code plDebugRoutineToken}.
     */
    static String routineToken(String routine) {
        String name = normalizeIdentifier(routine);
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            name = name.substring(dot + 1);
        }
        return name.trim();
    }

    /**
     * Upper-cases text and drops the double quotes that delimit Oracle identifiers, so
     * {@code "PROC"}, {@code PROC} and {@code "OWNER"."PROC"} compare consistently.
     * Whitespace is otherwise preserved (a tab becomes a space). Mirrors the Go
     * driver's {@code plDebugNormalizeIdentifier}.
     */
    static String normalizeIdentifier(String text) {
        return (text == null ? "" : text)
            .toUpperCase(Locale.ROOT)
            .replace("\"", "")
            .replace("\t", " ");
    }

    /** Reports whether one char can be part of an unquoted Oracle identifier. */
    private static boolean isIdentifierChar(char value) {
        return value == '_' || value == '$' || value == '#'
            || (value >= '0' && value <= '9')
            || (value >= 'A' && value <= 'Z')
            || (value >= 'a' && value <= 'z');
    }

    /**
     * Removes {@code --} line comments and block comments from one line while
     * preserving the rest of the text. The in-block state is carried across lines
     * through {@code inBlockComment}; removed characters leave nothing behind, so
     * column positions shift but line numbers do not. Mirrors the Go driver's
     * {@code plDebugStripSQLComments}.
     */
    static String stripSqlComments(String line, boolean[] inBlockComment) {
        StringBuilder builder = new StringBuilder();
        String text = line == null ? "" : line;
        int index = 0;
        while (index < text.length()) {
            if (inBlockComment[0]) {
                int end = text.indexOf("*/", index);
                if (end < 0) {
                    return builder.toString();
                }
                index = end + 2;
                inBlockComment[0] = false;
                continue;
            }
            if (text.startsWith("--", index)) {
                return builder.toString();
            }
            if (text.startsWith("/*", index)) {
                inBlockComment[0] = true;
                index += 2;
                continue;
            }
            builder.append(text.charAt(index));
            index++;
        }
        return builder.toString();
    }

    /** JDBC chokes on a client-style trailing slash after an anonymous block. */
    private static String stripTrailingSlash(String sql) {
        if (sql == null) {
            return "";
        }
        String trimmed = sql.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1).trim();
        }
        return trimmed;
    }

    private static void bindParameter(CallableStatement call, int index, PlDebugParam param) throws Exception {
        String mode = param.getMode() == null ? "IN" : param.getMode().trim().toUpperCase();
        if (mode.contains("OUT")) {
            // OUT / IN OUT parameters are bound as typed OUT registers so the
            // call shape matches the routine signature; values are reported
            // back through the debug result where supported.
            if (mode.contains("IN")) {
                call.setString(index, param.getValue());
            } else {
                call.setNull(index, Types.VARCHAR);
            }
            return;
        }
        call.setString(index, param.getValue());
    }

    private String qualifiedCall(String procedure) {
        StringBuilder call = new StringBuilder();
        if (owner != null && !owner.isEmpty()) {
            call.append('"').append(owner.replace("\"", "\"\"")).append("\".");
        }
        call.append('"').append(DbxPlDebugPackage.PACKAGE_NAME).append("\".\"").append(procedure).append('"');
        return call.toString();
    }

    private void requireOpen() {
        if (closed.get()) {
            throw new IllegalStateException("PL debug session is closed");
        }
        if (isExpired()) {
            throw new IllegalStateException("PL debug session timed out");
        }
    }

    private void ensureNotTerminated(String operation) {
        if (terminateState()) {
            throw new IllegalStateException("Cannot " + operation + ": debuggee has finished");
        }
    }

    private void touch() {
        lastActivityMillis = System.currentTimeMillis();
    }

    private static Integer parseInteger(String value) {
        try {
            return value == null ? null : Integer.valueOf(value.trim());
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    /** Reads an Integer out of a snapshot map without a cast surprise on absent keys. */
    private static Integer asInteger(Object value) {
        if (value instanceof Number number) {
            return number.intValue();
        }
        return value == null ? null : parseInteger(value.toString());
    }

    private static String currentSchema(Connection connection) throws Exception {
        String schema = queryString(connection, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL");
        return schema == null ? "" : schema.trim().toUpperCase();
    }

    private static String queryString(Connection connection, String sql) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(sql);
            ResultSet result = statement.executeQuery()) {
            return result.next() ? result.getString(1) : null;
        }
    }

    private static void executeStatement(Connection connection, String sql) throws Exception {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static void executeStatementQuietly(Connection connection, String sql) {
        try {
            executeStatement(connection, sql);
        } catch (Exception ignored) {
        }
    }

    private static void closeQuietly(Connection connection) {
        try {
            connection.close();
        } catch (Exception ignored) {
        }
    }
}
