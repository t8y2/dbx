package com.dbx.agent.oceanbaseoracle;

import java.io.IOException;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.dbx.agent.PlDebugBreakpoint;
import com.dbx.agent.PlDebugStartRequest;

/**
 * One PL/SQL debugging session against an OceanBase Oracle tenant.
 *
 * <p>The session owns two dedicated JDBC connections (never pooled, never the
 * shared request connection): the <em>debuggee</em> connection executes the
 * target program and blocks on its first line, and the <em>debugger</em>
 * connection attaches to it and drives anonymous system-package calls through
 * {@link PlDebugNative}. The wire protocol follows Oracle's
 * {@code DBMS_DEBUG} contract as used by OceanBase: the debuggee obtains a
 * debug id from {@code dbms_debug.initialize()}, the debugger attaches with
 * {@code dbms_debug.attach_session(id)}, and execution advances only when the
 * debugger sends {@code continue(...)} variants.
 *
 * <p>Adapted from Ziyu Yang's DBX debugger and its ODC-derived algorithms; see NOTICE.
 * Execution operations are serialized; cancellation uses the registered target
 * statement without waiting for the continuation monitor.
 */
final class PlDebugSession implements AutoCloseable {
    /** OceanBase keeps the debuggee parked waiting for the debugger; expire loudly instead. */
    static final long DEFAULT_TIMEOUT_MILLIS = 10 * 60 * 1000L;
    private static final int DEBUGGEE_TIMEOUT_BEHAVIOUR = 0;

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

    private static final int RESULT_SUCCESS = 0;
    private static final int RESULT_CAPABILITY_UNAVAILABLE = -1;

    /**
     * {@code dbms_debug.error_no_such_breakpt}, the code ENABLE_BREAKPOINT /
     * DISABLE_BREAKPOINT / DELETE_BREAKPOINT return for an unknown breakpoint
     * number. It is a real answer from a server that does implement the primitive,
     * so it must never be reported as "unsupported".
     */
    private static final int ERROR_NO_SUCH_BREAKPOINT = 13;

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
     * {@code run_info.reason} value for a breakpoint being hit (measured on Oracle 19c
     * EE: {@code reason_breakpoint = 3}). The run-to-the-end loop stops on it instead of
     * continuing, because a breakpoint this call could not disable would be hit again on
     * the next continuation. It is the Java twin of the Go driver's
     * {@code plDebugReasonBreakpoint}.
     */
    private static final int REASON_BREAKPOINT = 3;

    /**
     * Caps the exception-mode resume loop. Without it a server that keeps
     * reporting {@code reason_finish} (or an unparsable reason) would spin forever
     * inside {@code pl_debug_resume} and the RPC would never return.
     */
    private static final int EXCEPTION_RESUME_ITERATIONS = 200;

    /**
     * Caps the continue loop of {@link #runToTermination()}. It mirrors the
     * exception-mode cap: a handful of ordinary continuations ends a normal program, and
     * a run that keeps stopping for another reason must answer with a message instead of
     * spinning. The Java twin of the Go driver's
     * {@code plDebugIgnoreResumeIterations}.
     */
    private static final int IGNORE_RESUME_ITERATIONS = 200;

    /**
     * One {@code DBX_FETCH_OUTPUT} chunk, mirroring the Go driver's
     * {@code plDebugLogChars}. It is one character below PL/SQL's 32767-byte VARCHAR2
     * limit, so the helper's trailing {@code chr(10)} join can never overflow the
     * server-side register. A chunk shorter than this is the end of the buffer: the
     * helper only stops early when it ran out of lines.
     */
    static final int LOG_CHARS = 32000;

    private final String debugId;
    private final String owner;
    private final Connection debuggeeConnection;
    private final Connection debuggerConnection;
    private final ExecutorService debuggeeExecutor;
    private final PlDebugBreakpointRegistry breakpointRegistry;
    private final Map<String, PlDebugBreakpoint> breakpointDescriptions = new LinkedHashMap<>();
    private volatile List<Map<String, Object>> confirmedBreakpoints = List.of();
    private final Map<String, PlDebugRules> breakpointRules = new LinkedHashMap<>();
    private final Map<String, Long> breakpointHits = new LinkedHashMap<>();
    private volatile List<Map<String, Object>> breakpointRuleEvents = List.of();
    private long breakpointRuleSequence;
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicBoolean controlRunning = new AtomicBoolean(false);
    private final Object controlStateLock = new Object();
    private volatile CompletableFuture<Void> controlCompletion = CompletableFuture.completedFuture(null);
    private final AtomicBoolean abortRequested = new AtomicBoolean(false);
    private final AtomicBoolean closing = new AtomicBoolean(false);
    private final long timeoutMillis;
    private volatile Statement targetStatement;
    private final Object targetJdbcLock = new Object();
    private boolean targetExecuting;
    private volatile Exception targetConnectionConfigurationError;
    private volatile boolean targetDispatched;
    private volatile boolean targetReturned;
    private volatile String executionOutcome = "not_started";
    private volatile String resultError;
    private volatile String releaseState = "open";
    private volatile String transactionOutcome = "pending";
    private volatile PlDebugOutput.Capture captured;
    private volatile boolean outputRecoveryAttempted;
    private volatile String outputRecoveryError;
    private volatile int sourceLineOffset;
    private volatile PlDebugOutput.Block targetBlock;
    private volatile boolean initialReady;
    private volatile PlDebugNative.Stack currentStack;
    private volatile PlDebugNative.Stop currentStop;
    private PlDebugNative.ReadError structuredBacktraceError;
    private volatile long stopRevision;
    private volatile boolean executionUnknown;
    private volatile boolean breakpointMutationUnknown;
    private volatile Future<PlDebugOutput.Capture> pendingOutputCleanup;
    private volatile Statement pendingOutputStatement;
    private volatile List<Map<String, Object>> outParams = List.of();
    private volatile String outParamsState = "pending";
    private volatile Map<String, Object> returnValue;
    private volatile String inputSessionTimeZone;
    private final PlDebugResultCache resultCache = new PlDebugResultCache();
    private volatile String resultCollectionState = "pending";
    private PlDebugTarget.Plan targetPlan;
    private PlDebugSource.Version targetSource;
    private PlDebugSource.Version targetSpec;
    private volatile long sourceCheckedRevision = -1;
    private volatile boolean targetExecuteReturned;
    private Statement wrapperRootStatement;
    private PlDebugNative.Stop wrapperRootStop;
    private volatile long wrapperRootRevision = -1;
    private final long startupDeadlineMillis;
    private volatile String targetSourceState = "unavailable";
    private volatile String executionStage = "not_started";
    private volatile boolean rollbackConfirmed;
    private volatile boolean debuggerAttached;
    private volatile boolean debuggerDetached;
    private volatile boolean debuggerClosed;
    private volatile boolean debuggeeClosed;
    private volatile Runnable completionListener = () -> {};

    private volatile Future<?> debuggeeFuture;
    private volatile String debuggeeError;
    private volatile String currentLine;
    private volatile String currentProgram;
    private volatile String currentProgramOwner;
    private volatile Integer currentProgramNamespace;
    private volatile Integer currentBreakpoint;
    private volatile Integer currentReason;
    private volatile Integer currentStackDepth;
    private volatile boolean terminated;
    private volatile long lastActivityMillis = System.currentTimeMillis();
    /** Exception mode; deliberately ignored by the step operations, only resume loops. */
    private volatile boolean exceptionBreakpoint;
    private Map<String, Object> exceptionCapability = Map.of("status", "unknown", "canAttempt", false,
        "message", "Exception breakpoint flags have not been verified for this OceanBase version");
    /** True only when the last exception-mode resume stopped on reason 11/16. */
    private volatile boolean stoppedOnException;

    PlDebugSession(
        String debugId,
        String owner,
        Connection debuggeeConnection,
        Connection debuggerConnection,
        ExecutorService debuggeeExecutor,
        long timeoutMillis
    ) {
        this.debugId = debugId;
        this.owner = owner;
        this.debuggeeConnection = debuggeeConnection;
        this.debuggerConnection = debuggerConnection;
        this.breakpointRegistry = new PlDebugBreakpointRegistry(debuggerConnection);
        this.debuggeeExecutor = debuggeeExecutor;
        this.timeoutMillis = timeoutMillis;
        this.startupDeadlineMillis = System.currentTimeMillis() + timeoutMillis;
        this.debuggeeClosed = debuggeeConnection == null;
        this.debuggerClosed = debuggerConnection == null;
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
        return start(debuggeeConnection, debuggerConnection, request, debuggeeExecutor, timeoutMillis, session -> {});
    }

    static PlDebugSession start(
        Connection debuggeeConnection,
        Connection debuggerConnection,
        PlDebugStartRequest request,
        ExecutorService debuggeeExecutor,
        long timeoutMillis,
        Consumer<PlDebugSession> initialized
    ) throws Exception {
        String objectType = normalizedObjectType(request.getObjectType());
        if (!Set.of("ANONYMOUS", "PROCEDURE", "FUNCTION").contains(objectType)) {
            throw new IllegalArgumentException("A procedure, function or anonymous block is required for debugging");
        }
        if ("ANONYMOUS".equals(objectType) && (request.getSource() == null || request.getSource().isBlank())) {
            throw new IllegalArgumentException("Anonymous debug source is required");
        }
        String owner = PlDebugTarget.owner(debuggeeConnection, request.getSchema());

        debuggeeConnection.setAutoCommit(false);
        debuggerConnection.setAutoCommit(false);
        PlDebugTarget.Plan plan = debugBeforeApplies(request.getObjectType())
            ? PlDebugTarget.resolve(debuggeeConnection, owner, request) : null;
        PlDebugSource.Version source = plan == null ? null : PlDebugSource.load(debuggeeConnection, plan.target());
        PlDebugSource.Version spec = plan == null || plan.target().packageName() == null ? null
            : PlDebugSource.load(debuggeeConnection, plan.target().owner(), plan.target().packageName(), "PACKAGE", plan.target().objectId());
        Map<String, Object> exceptionCapability = PlDebugCapabilities.exceptions(debuggerConnection);

        // OceanBase kills the parked debuggee statement at ob_query_timeout
        // (default 10s), which is shorter than a human debugging session.
        executeStatement(debuggeeConnection, DEBUGGEE_QUERY_TIMEOUT);
        executeStatement(debuggerConnection, "SET SESSION ob_query_timeout = 30000000");
        String debugId = PlDebugNative.initialize(debuggeeConnection);
        if (debugId == null || debugId.trim().isEmpty()) {
            throw new IllegalStateException("SYS.DBMS_DEBUG.INITIALIZE() returned no debug id");
        }
        debugId = debugId.trim();
        PlDebugSession session = new PlDebugSession(
            debugId, owner, debuggeeConnection, debuggerConnection, debuggeeExecutor, timeoutMillis
        );
        session.targetPlan = plan;
        session.targetSource = source;
        session.targetSpec = spec;
        session.exceptionCapability = exceptionCapability;
        session.targetSourceState = source == null ? "unavailable" : source.state();
        session.returnValue = plan == null ? null : plan.pendingReturn();
        // Publish the native identity before DEBUG_ON or dispatching the business
        // target. A lost start response must not leave an unregistered execution.
        try {
            initialized.accept(session);
            session.checkStartCancellation();
            try (CallableStatement call = debuggeeConnection.prepareCall("BEGIN SYS.DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR(?); END;")) {
                call.setInt(1, DEBUGGEE_TIMEOUT_BEHAVIOUR);
                call.execute();
            }
            try (CallableStatement call = debuggeeConnection.prepareCall("BEGIN ? := SYS.DBMS_DEBUG.GET_TIMEOUT_BEHAVIOUR(); END;")) {
                call.setQueryTimeout(PlDebugNative.CALL_TIMEOUT_SECONDS);
                call.registerOutParameter(1, java.sql.Types.INTEGER);
                call.execute();
                int behaviour = call.getInt(1);
                if (call.wasNull() || behaviour != DEBUGGEE_TIMEOUT_BEHAVIOUR) {
                    throw new SQLException("The native debugger retry timeout behaviour could not be confirmed");
                }
            }
            if (PlDebugNative.setTimeout(debuggeeConnection, DEBUG_TIMEOUT_SECONDS) != DEBUG_TIMEOUT_SECONDS) {
                throw new SQLException("The native debugger timeout could not be confirmed");
            }

            session.checkStartCancellation();
            executeStatement(debuggeeConnection, "BEGIN SYS.DBMS_OUTPUT.ENABLE(" + DBMS_OUTPUT_BUFFER_SIZE + "); END;");
            executeStatement(debuggeeConnection, "BEGIN SYS.DBMS_DEBUG.DEBUG_ON; END;");
            session.checkStartCancellation();

            // Submit the target first: DBMS_DEBUG parks it before its first user
            // statement, then the dedicated controller attaches and navigates it.
            FutureTask<Void> target = session.completionTask(() -> { session.runDebuggeeTarget(request); return null; });
            session.debuggeeFuture = target;
            debuggeeExecutor.execute(target);

            // The registered session retains both connections on cleanup failure.
            session.attachDebugger();
            session.probeTargetProgramRunning();
            session.synchronizeDebuggee();
            session.debugBefore(request);
        } catch (Exception error) {
            if (session.debuggeeFuture == null && session.abortRequested.get()) {
                session.executionOutcome = "cancelled";
                session.terminated = true;
            }
            try { session.close(); }
            catch (Exception cleanupError) { error.addSuppressed(cleanupError); }
            throw error;
        }
        session.initialReady = true;
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
            try (CallableStatement call = debuggerConnection.prepareCall("BEGIN SYS.DBMS_DEBUG.ATTACH_SESSION(?); END;")) {
                call.setString(1, debugId);
                call.execute();
                debuggerAttached = true;
                touch();
                return;
            } catch (Exception error) {
                lastError = error;
            }
            try {
                Thread.sleep(ATTACH_DELAY_MILLIS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("SYS.DBMS_DEBUG.ATTACH_SESSION interrupted", interrupted);
            }
        }
        throw new IllegalStateException(
            "SYS.DBMS_DEBUG.ATTACH_SESSION failed: " + (lastError == null ? "" : lastError.getMessage()),
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
                "BEGIN DECLARE running BOOLEAN; BEGIN running := SYS.DBMS_DEBUG.TARGET_PROGRAM_RUNNING(); END; END;"
            );
        } catch (Exception error) {
            LOG.log(Level.FINE, "SYS.DBMS_DEBUG.TARGET_PROGRAM_RUNNING probe failed", error);
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
    private void synchronizeDebuggee() throws Exception {
        PlDebugNative.Stop stop = PlDebugNative.synchronize(debuggerConnection);
        if (stop.result() != RESULT_SUCCESS) {
            throw new IllegalStateException("SYS.DBMS_DEBUG.SYNCHRONIZE failed (result=" + stop.result() + ")");
        }
        applyStop(stop);
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
            DEFAULT_TIMEOUT_MILLIS
        );
    }

    /**
     * Test-only session over scripted connections. It is the seam the drain and the
     * continuation loops are unit-tested through: {@code terminated} is set directly
     * (the production path learns it from the debuggee future), so a test can decide
     * whether {@code log()} reaches for the buffer and whether a continuation still has
     * a debuggee to drive.
     */
    static PlDebugSession withConnections(
        String debugId,
        String owner,
        Connection debuggeeConnection,
        Connection debuggerConnection,
        boolean terminated
    ) {
        return withConnections(debugId, owner, debuggeeConnection, debuggerConnection, terminated, null, null);
    }

    /**
     * The same test-only seam with the two facts a scripted connection cannot produce for
     * the run-to-the-end loop: the breakpoints the caller already armed, and the debuggee's
     * own signal ({@link #debuggeeFuture}, which is what {@link #terminateState()} reads
     * once the target statement returned -- the completion of a
     * {@code CompletableFuture} stands in for it).
     */
    static PlDebugSession withConnections(
        String debugId,
        String owner,
        Connection debuggeeConnection,
        Connection debuggerConnection,
        boolean terminated,
        List<PlDebugBreakpoint> armedBreakpoints,
        Future<?> debuggeeFuture
    ) {
        PlDebugSession session = new PlDebugSession(
            debugId,
            owner,
            debuggeeConnection,
            debuggerConnection,
            null,
            DEFAULT_TIMEOUT_MILLIS
        );
        session.terminated = terminated;
        if (armedBreakpoints != null) {
            try { session.setBreakpoints(armedBreakpoints); }
            catch (Exception error) { throw new IllegalStateException("The scripted breakpoints could not be registered", error); }
        }
        session.debuggeeFuture = debuggeeFuture;
        return session;
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
        if (!establishWrapperRoot()) return;
        if ("ANONYMOUS".equals(normalizedObjectType(request.getObjectType()))) {
            for (int attempt = 0; attempt <= sourceLineOffset; attempt++) {
                checkWrapperStartup();
                if (!verifyWrapperRoot()) return;
                if (currentStop.line() > sourceLineOffset) return;
                continueWith(PlDebugNative.STEP_IN);
            }
            throw new IllegalStateException("Could not reach the anonymous target's user source");
        }
        if (!debugBeforeApplies(request.getObjectType())) {
            // An anonymous-block target is submitted verbatim: there is no call line
            // to stop on, so it keeps its caller-supplied breakpoints.
            return;
        }
        String program = targetPlan.target().program();
        if (targetBlock == null) throw new IllegalStateException("The original target block is not available");
        int callLine = targetBlock.callLine();
        if (callLine <= 0) throw new IllegalStateException("The generated target call line is not available");
        try {
            armStartBreakpoint(callLine, program);
        } catch (Exception error) {
            throw new IllegalStateException("debug start failed: " + error.getMessage(), error);
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

        if (publishInitializationStop()) return;
        if(!verifyWrapperRoot()||!Integer.valueOf(callLine).equals(currentStop.line())) {
            boolean target=Objects.equals(owner,currentProgramOwner)&&Objects.equals(program,currentProgram)
                &&Objects.equals(targetPlan.target().packageName()==null?1:2,currentProgramNamespace);
            executionStage=target?"calling":"entry_identity_unresolved";
            if(targetPlan.target().packageName()!=null&&Objects.equals(owner,currentProgramOwner)
                &&Objects.equals(targetPlan.target().packageName()+".__init__",currentProgram)&&Integer.valueOf(2).equals(currentProgramNamespace))executionStage="initializing_package";
            if(target&&targetPlan.target().packageName()!=null&&"__init__".equals(targetPlan.target().name()))executionStage="entry_identity_unresolved";
            publishStartFrame();
            return;
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
        if (targetPlan.target().packageName() != null && "__init__".equals(targetPlan.target().name())
            && Objects.equals(owner, currentProgramOwner) && Objects.equals(program, currentProgram)
            && Integer.valueOf(2).equals(currentProgramNamespace)) {
            executionStage = "entry_identity_unresolved";
            publishStartFrame();
            return;
        }
        if (!Objects.equals(owner, currentProgramOwner) || !Objects.equals(program, currentProgram)
            || !Objects.equals(targetPlan.target().packageName() == null ? 1 : 2, currentProgramNamespace)) {
            if (targetPlan.target().packageName() != null && Objects.equals(owner, currentProgramOwner)
                && Objects.equals(targetPlan.target().packageName() + ".__init__", currentProgram)
                && Integer.valueOf(2).equals(currentProgramNamespace)) {
                executionStage = "initializing_package";
                publishStartFrame();
                return;
            }
            throw new IllegalStateException("The native entry stop does not identify the selected debug target; inspect the retained session");
        }
        executionStage = "calling";
        publishStartFrame();
    }

    private boolean publishInitializationStop() throws Exception {
        if(!"-1".equals(wrapperExecutionPhase()))return false;
        executionStage="argument_initialization";
        publishStartFrame();
        return true;
    }

    private String wrapperExecutionPhase() throws Exception {
        if(targetPlan==null||targetBlock==null||targetBlock.executionPhaseName()==null||wrapperRootStatement!=targetStatement||!wrapperExecutionLive())return null;
        PlDebugNative.Stack stack=ensureStack();
        int rootIndex=-1;
        for(int index=0;index<stack.frames().size();index++)if(stack.frames().get(index).nativeFrameId()==1){rootIndex=index;break;}
        if(rootIndex<0||!wrapperMarker("value",stack,rootIndex))return null;
        long revision=stopRevision;
        var phase=PlDebugNative.value(debuggerConnection,stack,rootIndex,targetBlock.executionPhaseName());
        return wrapperExecutionLive()&&stopRevision==revision&&"value".equals(phase.state())?phase.value():null;
    }

    private boolean establishWrapperRoot() throws Exception {
        if (!wrapperBootstrapStop(2, 2) || !wrapperMarker("null")) return false;
        String initialOwner = currentStop.owner();
        for (int line : new int[] {1, 2, 3}) {
            checkWrapperStartup();
            continueWith(PlDebugNative.STEP_IN);
            if (!wrapperBootstrapStop(9, line) || !initialOwner.equals(currentStop.owner())
                || !wrapperMarker(line == 3 ? "value" : "null")) return false;
        }
        wrapperRootStatement = targetStatement;
        wrapperRootStop = currentStop;
        wrapperRootRevision = stopRevision;
        return true;
    }

    private void checkWrapperStartup() throws Exception {
        checkStartCancellation();
        if (System.currentTimeMillis() >= startupDeadlineMillis) throw new java.util.concurrent.TimeoutException("Anonymous startup navigation timed out");
    }

    private boolean wrapperExecutionLive() {
        return targetBlock != null && targetBlock.rootTokenName() != null
            && targetStatement != null && targetDispatched && !targetExecuteReturned && !targetReturned
            && !terminated && !executionUnknown && !abortRequested.get() && !closed.get() && "open".equals(releaseState);
    }

    private boolean wrapperBootstrapStop(int reason, int line) {
        return wrapperExecutionLive() && currentStop != null && currentStop.result() == 0 && !currentStop.terminated()
            && Integer.valueOf(reason).equals(currentStop.reason()) && Integer.valueOf(line).equals(currentStop.line())
            && Integer.valueOf(1).equals(currentStop.depth()) && Integer.valueOf(1).equals(currentStop.namespace())
            && "__anonymous_block__".equals(currentStop.program()) && currentStop.owner() != null;
    }

    private boolean wrapperMarker(String expectedState) throws Exception {
        if (!wrapperExecutionLive()) return false;
        PlDebugNative.Stack stack = ensureStack();
        return wrapperMarker(expectedState,stack,0);
    }

    private boolean wrapperMarker(String expectedState,PlDebugNative.Stack stack,int frameIndex) throws Exception {
        if(!wrapperExecutionLive()||frameIndex<0||frameIndex>=stack.frames().size()||stack.frames().get(frameIndex).nativeFrameId()!=1)return false;
        long revision=stopRevision;
        Statement statement=targetStatement;
        PlDebugNative.Value marker = PlDebugNative.value(debuggerConnection, stack, frameIndex, targetBlock.rootTokenName());
        return wrapperExecutionLive() && targetStatement == statement && stopRevision == revision
            && expectedState.equals(marker.state()) && (!"value".equals(expectedState) || targetBlock.rootToken().equals(marker.value()));
    }

    private boolean verifyWrapperRoot() throws Exception {
        if (wrapperRootRevision == stopRevision && wrapperExecutionLive() && targetStatement == wrapperRootStatement) return true;
        wrapperRootRevision = -1;
        if (!wrapperExecutionLive() || wrapperRootStop == null || targetStatement != wrapperRootStatement || currentStop == null
            || !Integer.valueOf(1).equals(currentStop.depth()) || !Objects.equals(currentStop.program(), wrapperRootStop.program())
            || !Objects.equals(currentStop.owner(), wrapperRootStop.owner()) || !Objects.equals(currentStop.namespace(), wrapperRootStop.namespace())
            || currentStop.line() == null || currentStop.line() <= 0 || currentStop.line() > targetBlock.sql().split("\n", -1).length) return false;
        if (!wrapperMarker("value")) return false;
        wrapperRootRevision = stopRevision;
        return true;
    }

    private boolean currentWrapperRoot() {
        return wrapperRootRevision == stopRevision && wrapperExecutionLive() && targetStatement == wrapperRootStatement;
    }

    private PlDebugSource.Reference anonymousSourceReference() {
        if (targetPlan != null || !currentWrapperRoot() || currentStop.line() <= sourceLineOffset
            || currentStop.line() > sourceLineOffset + targetBlock.sourceLineCount()) return null;
        return new PlDebugSource.Reference(debugId + ":root", 1, stopRevision, 1, "submitted_wrapper", "native", "controlled_root",
            "ANONYMOUS", targetBlock.source(), sourceLineOffset, currentStop.owner(), currentStop.program(), null, currentStop.namespace());
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
     * Refreshes the actual entry stop without replacing native identity with the
     * requested target's display label.
     */
    synchronized void publishStartFrame() {
        refreshBacktrace();
        touch();
    }

    /**
     * Arms the private startup breakpoint without publishing it as a user breakpoint.
     */
    private synchronized void armStartBreakpoint(int line, String program) throws Exception {
        PlDebugBreakpointRegistry.Mutation created;
        try {
            created = breakpointRegistry.setInternal(PlDebugNative.currentBreakpointProgram(debuggerConnection, line), () -> {});
        } catch (Exception error) {
            throw new IllegalStateException(
                "set the anonymous-block breakpoint at line " + line + " failed: " + error.getMessage(),
                error
            );
        }
        if (created.result() != RESULT_SUCCESS) throw new IllegalStateException("The startup breakpoint was rejected (result=" + created.result() + ")");
        publishBreakpoints();
        touch();
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

    synchronized Map<String, Object> mutateBreakpoint(String action, com.dbx.agent.PlDebugBreakpointMutation request,
                                                       Runnable beforeDispatch) throws Exception {
        return mutateBreakpoint(action, request, beforeDispatch, () -> {});
    }

    synchronized Map<String, Object> mutateBreakpoint(String action, com.dbx.agent.PlDebugBreakpointMutation request,
                                                       Runnable beforeDispatch, Runnable confirmedChange) throws Exception {
        requireBreakpointStop(request.stopRevision());
        PlDebugRules rules = PlDebugRules.parse(request.rules());
        PlDebugBreakpointRegistry.Mutation mutation;
        boolean creating = "set_breakpoints".equals(action) && request.breakpointNumber() == null;
        try {
            if (creating) {
                if (request.line() == null || request.line() <= 0 || request.nativeFrameId() == null
                    || request.sourceRevision() == null || request.sourceRevision() != 1 || request.sourceRefId() == null) {
                    throw new IllegalArgumentException("The current source reference, frame and line are required");
                }
                PlDebugSource.Reference source = null;
                PlDebugNative.Frame matchedFrame = null;
                if (targetPlan == null) {
                    if (verifyWrapperRoot()) source = anonymousSourceReference();
                } else for (PlDebugNative.Frame frame : ensureStack().frames()) {
                    PlDebugSource.Reference candidate = namedSourceReference(frame);
                    if (candidate != null && candidate.id().equals(request.sourceRefId()) && candidate.nativeFrameId() == request.nativeFrameId()) {
                        source = candidate;
                        matchedFrame = frame;
                    }
                }
                if (source == null || !source.id().equals(request.sourceRefId()) || source.nativeFrameId() != request.nativeFrameId()
                    || request.line() > (targetPlan == null ? targetBlock.sourceLineCount() : targetSource.lines().size())) {
                    throw new IllegalArgumentException("The original paused source reference is unavailable");
                }
                if (targetPlan != null) {
                    if (!"candidate".equals(targetSourceState) || sourceCheckedRevision != stopRevision) throw new IllegalArgumentException("The original source version is unavailable");
                    requireNamedSource();
                }
                Runnable dispatch = () -> {
                    requireBreakpointStop(request.stopRevision());
                    if (targetPlan == null && !currentWrapperRoot()) throw new IllegalStateException("The original anonymous root is unavailable");
                    beforeDispatch.run();
                };
                mutation = breakpointRegistry.set(new PlDebugBreakpointInventory.Program(source.owner(),
                    matchedFrame == null ? source.name() : matchedFrame.program(), source.namespace(), request.line() + source.lineOffset()),
                    new PlDebugBreakpointRegistry.SourceBinding(source.id(), source.sourceRevision(), request.line()), dispatch);
                if (mutation.changed()) confirmedChange.run();
                if (mutation.result() == RESULT_SUCCESS) {
                    PlDebugBreakpoint description = new PlDebugBreakpoint();
                    description.setOwner(source.owner());
                    description.setName(source.name());
                    description.setKind(source.objectType());
                    description.setLine(request.line());
                    description.setBreakpointNumber(mutation.registration().number());
                    breakpointDescriptions.putIfAbsent(mutation.registration().id(), description);
                    publishBreakpoints();
                    if (Boolean.FALSE.equals(request.enabled())) {
                        mutation = breakpointRegistry.enabled(mutation.registration().id(), false, dispatch);
                        if (mutation.result() == ERROR_NO_SUCH_BREAKPOINT) {
                            forgetBreakpoint(mutation.registration().id());
                        }
                    }
                }
            } else {
                PlDebugBreakpointRegistry.Registration registration = breakpointRegistry.registrations().stream()
                    .filter(item -> item.userHold() && item.id().equals(request.registrationId()) && Objects.equals(item.number(), request.breakpointNumber()))
                    .findFirst().orElseThrow(() -> new IllegalArgumentException("The original breakpoint registration is unavailable"));
                if ("set_breakpoints".equals(action) && request.rules() != null) {
                    breakpointRegistry.verify();
                    mutation = new PlDebugBreakpointRegistry.Mutation(registration, RESULT_SUCCESS, false);
                } else if ("delete_breakpoints".equals(action)) {
                    mutation = breakpointRegistry.delete(registration.id(), beforeDispatch);
                } else {
                    if (request.enabled() == null) throw new IllegalArgumentException("An enabled value is required");
                    if (request.enabled() && registration.source() != null && targetSource != null) requireNamedSource();
                    mutation = breakpointRegistry.enabled(registration.id(), request.enabled(), beforeDispatch);
                }
                if (mutation.result() == ERROR_NO_SUCH_BREAKPOINT || "delete_breakpoints".equals(action) && mutation.result() == RESULT_SUCCESS) {
                    forgetBreakpoint(registration.id());
                }
            }
        } catch (PlDebugBreakpointRegistry.Failure error) {
            throw breakpointFailure(error);
        }
        if (mutation.changed()) confirmedChange.run();
        if (mutation.result() == RESULT_SUCCESS && request.rules() != null && !"delete_breakpoints".equals(action)) {
            String registrationId = mutation.registration().id();
            PlDebugRules previous = breakpointRules.getOrDefault(registrationId, PlDebugRules.EMPTY);
            if (previous.ignoreCount() != rules.ignoreCount()) breakpointHits.remove(registrationId);
            breakpointRules.put(registrationId, rules);
            if (!previous.equals(rules)) confirmedChange.run();
        }
        if (mutation.result() == ERROR_NO_SUCH_BREAKPOINT || "delete_breakpoints".equals(action) && mutation.result() == RESULT_SUCCESS) {
            breakpointRules.remove(request.registrationId());
            breakpointHits.remove(request.registrationId());
        }
        publishBreakpoints();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", mutation.result() == RESULT_SUCCESS);
        result.put("result", mutation.result());
        result.put("registrationId", mutation.registration() == null ? request.registrationId() : mutation.registration().id());
        result.put("breakpointNumber", mutation.registration() == null ? request.breakpointNumber() : Integer.valueOf(mutation.registration().number()));
        if (creating && mutation.result() == 12) result.put("message", "This line cannot have a breakpoint in the current native program");
        result.put("breakpoints", confirmedBreakpoints);
        result.put("snapshot", snapshot());
        return result;
    }

    synchronized Map<String, Object> setBreakpoints(List<PlDebugBreakpoint> requested) throws Exception {
        return setBreakpoints(requested, () -> {});
    }

    synchronized Map<String, Object> setBreakpoints(List<PlDebugBreakpoint> requested, Runnable beforeDispatch) throws Exception {
        requireOpen();
        ensureNotTerminated("set breakpoints");
        List<PlDebugBreakpoint> created = new ArrayList<>();
        boolean changed = false;
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
            boolean anonymous = "ANONYMOUS".equals(kind);
            if (anonymous && (targetPlan != null || !verifyWrapperRoot())) throw new IllegalStateException("The original anonymous source is unavailable");
            int nativeLine = line;
            if (anonymous && sourceLineOffset > 0 && targetBlock != null) {
                if (line > targetBlock.sourceLineCount()) throw new IllegalArgumentException("Breakpoint is outside the anonymous source");
                nativeLine += sourceLineOffset;
            }
            String breakpointOwner = breakpoint.getOwner() == null || breakpoint.getOwner().isBlank()
                ? owner : breakpoint.getOwner().trim();
            String name = breakpoint.getName() == null ? "" : breakpoint.getName().trim();
            if (hasSignature || hasSequence) {
                throw new UnsupportedOperationException("OceanBase SYS.DBMS_DEBUG.PROGRAM_INFO has no signature/sequence fields; select a source line of the intended overload");
            }
            boolean selectedPackage = !anonymous && targetPlan != null && targetPlan.target().packageName() != null
                && (Objects.equals(breakpoint.getName(), targetPlan.target().program())
                    || Objects.equals(breakpoint.getName(), targetPlan.target().name())
                    || Objects.equals(breakpoint.getName(), targetPlan.target().packageName() + ".__init__"));
            if (!anonymous && !selectedPackage) {
                String warning = overloadWarningForTarget(breakpointOwner, name, overloadCount(debuggerConnection, breakpointOwner, name), hasSignature, hasSequence);
                if (!warning.isEmpty()) warnings.add(warning);
            }
            PlDebugBreakpointInventory.Program nativeProgram = anonymous
                ? PlDebugNative.currentBreakpointProgram(debuggerConnection, nativeLine)
                : new PlDebugBreakpointInventory.Program(breakpointOwner, name, 1, nativeLine);
            PlDebugBreakpointRegistry.SourceBinding binding = null;
            if (selectedPackage) {
                requireNamedSource();
                String expectedProgram = Objects.equals(breakpoint.getName(), targetPlan.target().name())
                    ? targetPlan.target().program() : breakpoint.getName();
                PlDebugSource.Reference source = null;
                for (PlDebugNative.Frame frame : ensureStack().frames()) {
                    PlDebugSource.Reference candidate = namedSourceReference(frame);
                    if (candidate != null && Objects.equals(frame.program(), expectedProgram)
                        && Objects.equals(frame.owner(), breakpoint.getOwner() == null ? owner : breakpoint.getOwner())) {
                        source = candidate;
                        nativeProgram = new PlDebugBreakpointInventory.Program(frame.owner(), frame.program(), frame.namespace(), line);
                        break;
                    }
                }
                if (source == null || line > targetSource.lines().size()) throw new IllegalArgumentException("The selected package member has no confirmed current source frame");
                binding = new PlDebugBreakpointRegistry.SourceBinding(source.id(), source.sourceRevision(), line);
            } else if (anonymous) {
                PlDebugSource.Reference source = anonymousSourceReference();
                if (source == null) throw new IllegalArgumentException("The original anonymous source is unavailable");
                binding = new PlDebugBreakpointRegistry.SourceBinding(source.id(), source.sourceRevision(), line);
            }
            PlDebugBreakpointRegistry.Mutation mutation = registerBreakpoint(nativeProgram, binding, beforeDispatch);
            changed |= mutation.changed();
            breakpointNumber = mutation.registration() == null ? 0 : mutation.registration().number();
            result = mutation.result();
            if (result != RESULT_SUCCESS) {
                throw new IllegalStateException(
                    "SYS.DBMS_DEBUG.SET_BREAKPOINT failed for line " + line + " (result=" + result + ")"
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
            breakpointDescriptions.putIfAbsent(mutation.registration().id(), stored);
            publishBreakpoints();
            created.add(breakpointDescriptions.get(mutation.registration().id()));
        }
        touch();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", true);
        response.put("result", 0);
        response.put("changed", changed);
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
        return deleteBreakpoints(requested, () -> {});
    }

    synchronized Map<String, Object> deleteBreakpoints(List<PlDebugBreakpoint> requested, Runnable beforeDispatch) throws Exception {
        requireOpen();
        boolean changed = false;
        List<PlDebugBreakpoint> removed = new ArrayList<>();
        for (PlDebugBreakpoint breakpoint : requested) {
            if (breakpoint == null || breakpoint.getBreakpointNumber() == null) {
                continue;
            }
            int number = breakpoint.getBreakpointNumber();
            boolean active = breakpointRegistry.registrations().stream().anyMatch(item -> item.number() == number);
            if (!active && breakpointRegistry.retired(number)) {
                breakpointRegistry.verify();
                removed.add(breakpoint);
                continue;
            }
            PlDebugBreakpointRegistry.Registration registration = breakpointRegistry.legacyRegistration(number);
            PlDebugBreakpointRegistry.Mutation mutation;
            try { mutation = breakpointRegistry.delete(registration.id(), beforeDispatch); }
            catch (PlDebugBreakpointRegistry.Failure error) { throw breakpointFailure(error); }
            changed |= mutation.changed();
            if (mutation.result() != 0 && mutation.result() != ERROR_NO_SUCH_BREAKPOINT) throw new IllegalStateException("The native breakpoint could not be deleted (result=" + mutation.result() + ")");
            forgetBreakpoint(registration.id());
            publishBreakpoints();
            removed.add(breakpoint);
        }
        touch();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", true);
        response.put("result", RESULT_SUCCESS);
        response.put("changed", changed);
        response.put("breakpoints", removed);
        return response;
    }

    synchronized List<PlDebugBreakpoint> listBreakpoints() throws Exception {
        breakpointRegistry.requireUsable();
        if (!targetExecuteReturned && !terminated) breakpointRegistry.verify();
        List<PlDebugBreakpoint> result = new ArrayList<>();
        for (PlDebugBreakpointRegistry.Registration registration : breakpointRegistry.registrations()) {
            if (!registration.userHold()) continue;
            PlDebugBreakpoint original = breakpointDescriptions.get(registration.id());
            if (original == null) continue;
            PlDebugBreakpoint item = new PlDebugBreakpoint();
            item.setOwner(original.getOwner());
            item.setName(original.getName());
            item.setLine(original.getLine());
            item.setKind(original.getKind());
            item.setSignature(original.getSignature());
            item.setSequence(original.getSequence());
            item.setWarning(original.getWarning());
            item.setBreakpointNumber(registration.number());
            item.setRegistrationId(registration.id());
            item.setOwned(true);
            item.setEnabled(breakpointRegistry.enabled(registration));
            item.setLocalActive(breakpointRegistry.enabled(registration));
            PlDebugRules rules = breakpointRules.getOrDefault(registration.id(), PlDebugRules.EMPTY);
            item.setIgnoreCount(rules.ignoreCount());
            item.setCondition(rules.condition());
            item.setMessage(rules.message());
            item.setHits(breakpointHits.getOrDefault(registration.id(), 0L));
            item.setNativeLine(registration.program().line());
            if (registration.source() != null) {
                item.setSourceRefId(registration.source().id());
                item.setSourceRevision(registration.source().revision());
            }
            result.add(item);
        }
        return List.copyOf(result);
    }

    private void forgetBreakpoint(String registrationId) {
        breakpointDescriptions.remove(registrationId);
        breakpointRules.remove(registrationId);
        breakpointHits.remove(registrationId);
    }

    private void publishBreakpoints() {
        List<Map<String, Object>> current = new ArrayList<>();
        for (PlDebugBreakpointRegistry.Registration registration : breakpointRegistry.registrations()) {
            if (!registration.userHold()) continue;
            PlDebugBreakpoint description = breakpointDescriptions.get(registration.id());
            if (description == null) continue;
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("registrationId", registration.id());
            item.put("owned", true);
            item.put("nativeLine", registration.program().line());
            if (registration.source() != null) {
                item.put("sourceRefId", registration.source().id());
                item.put("sourceRevision", registration.source().revision());
            }
            item.put("breakpointNumber", registration.number());
            item.put("owner", description.getOwner());
            item.put("name", description.getName());
            item.put("line", description.getLine());
            item.put("kind", description.getKind());
            item.put("signature", description.getSignature());
            item.put("sequence", description.getSequence());
            item.put("warning", description.getWarning());
            item.put("enabled", breakpointRegistry.enabled(registration));
            item.put("localActive", breakpointRegistry.enabled(registration));
            PlDebugRules rules = breakpointRules.getOrDefault(registration.id(), PlDebugRules.EMPTY);
            item.put("ignoreCount", rules.ignoreCount());
            item.put("condition", rules.condition());
            item.put("message", rules.message());
            item.put("hits", breakpointHits.getOrDefault(registration.id(), 0L));
            current.add(java.util.Collections.unmodifiableMap(item));
        }
        confirmedBreakpoints = List.copyOf(current);
    }

    private PlDebugBreakpointRegistry.Mutation registerBreakpoint(PlDebugBreakpointInventory.Program program) throws Exception {
        return registerBreakpoint(program, () -> {});
    }

    private PlDebugBreakpointRegistry.Mutation registerBreakpoint(PlDebugBreakpointInventory.Program program, Runnable beforeDispatch) throws Exception {
        return registerBreakpoint(program, null, beforeDispatch);
    }

    private PlDebugBreakpointRegistry.Mutation registerBreakpoint(PlDebugBreakpointInventory.Program program,
                                                                  PlDebugBreakpointRegistry.SourceBinding source, Runnable beforeDispatch) throws Exception {
        try { return breakpointRegistry.set(program, source, beforeDispatch); }
        catch (PlDebugBreakpointRegistry.Failure error) { throw breakpointFailure(error); }
    }

    private Exception breakpointFailure(PlDebugBreakpointRegistry.Failure error) {
        if (error.dispatched) breakpointMutationUnknown = true;
        if (error.getCause() instanceof SQLException sql && PlDebugNative.connectionUnsafe(sql)) {
            executionUnknown = true;
            currentStack = null;
        }
        return error.getCause() instanceof Exception cause ? cause : error;
    }

    /**
     * Runs to the next breakpoint (or to the end of the program). Without an
     * exception breakpoint this is a single {@code DBX_CNT_NEXT_BREAKPOINT} call;
     * with one it keeps continuing until the interpreter reports an
     * exception/handler, a real breakpoint hit, or termination.
     */
    synchronized Map<String, Object> resume() throws Exception {
        return applyBreakpointRules(exceptionBreakpoint ? resumeUntilException() : continueWith(PlDebugNative.CONTINUE), true);
    }

    private void ruleEvent(int number, String message, String warning) {
        if (message.isEmpty() && warning.isEmpty()) return;
        List<Map<String, Object>> events = new ArrayList<>(breakpointRuleEvents);
        events.add(Map.of("sequence", ++breakpointRuleSequence, "stopRevision", stopRevision,
            "breakpointNumber", number, "message", message, "warning", warning));
        breakpointRuleEvents = List.copyOf(events.subList(Math.max(0, events.size() - 500), events.size()));
    }

    private Map<String, Object> applyBreakpointRules(Map<String, Object> response, boolean automatic) throws Exception {
        try { return evaluateBreakpointRules(response, automatic); }
        catch (PlDebugBreakpointRegistry.Failure error) { throw breakpointFailure(error); }
        catch (SQLException error) {
            if (PlDebugNative.connectionUnsafe(error)) executionUnknown = true;
            throw error;
        }
    }

    private Map<String, Object> evaluateBreakpointRules(Map<String, Object> response, boolean automatic) throws Exception {
        for (int continued = 0; !terminated && Integer.valueOf(3).equals(currentReason) && currentBreakpoint != null; continued++) {
            PlDebugBreakpointRegistry.Registration registration = breakpointRegistry.registrations().stream()
                .filter(item -> item.number() == currentBreakpoint).findFirst().orElse(null);
            if (registration == null || !breakpointRules.containsKey(registration.id())) return response;
            requireBreakpointStop(stopRevision);
            breakpointRegistry.verify();
            PlDebugBreakpointInventory.Program program = registration.program();
            PlDebugBreakpoint description = breakpointDescriptions.get(registration.id());
            if (targetPlan == null && description != null && "ANONYMOUS".equals(description.getKind()) && !verifyWrapperRoot()) {
                ruleEvent(registration.number(), "", "The stopped frame is not the original anonymous root; stopped without applying rules");
                return snapshot();
            }
            if (!breakpointRegistry.enabled(registration) || !Objects.equals(currentProgramOwner, program.owner())
                || !Objects.equals(currentProgram, program.name()) || !Objects.equals(currentProgramNamespace, program.namespace())
                || !Objects.equals(currentLine, Integer.toString(program.line()))) {
                ruleEvent(registration.number(), "", "The stopped breakpoint does not match its original registration; stopped without applying rules");
                return snapshot();
            }
            if (registration.source() != null && targetSource != null && !refreshNamedSource()) {
                ruleEvent(registration.number(), "", "The source version changed; stopped without applying rules");
                return snapshot();
            }
            PlDebugRules rules = breakpointRules.get(registration.id());
            long hits = breakpointHits.getOrDefault(registration.id(), 0L) + 1;
            breakpointHits.put(registration.id(), hits);
            boolean skip = automatic && rules.ignoreCount() > 0 && hits < rules.ignoreCount();
            String warning = "";
            if (automatic && !skip && !rules.condition().isEmpty()) {
                PlDebugCondition.Verdict verdict = PlDebugCondition.evaluate(rules.condition(), name -> {
                    requireBreakpointStop(stopRevision);
                    return PlDebugNative.value(debuggerConnection, ensureStack(), 0, name);
                });
                skip = "false".equals(verdict.state());
                if ("unparseable".equals(verdict.state())) warning = "Condition could not be evaluated: " + verdict.reason() + "; stopped";
            }
            publishBreakpoints();
            if (!skip || continued >= 200) {
                if (skip) warning = "Automatic continue limit (200) reached; stopped";
                ruleEvent(registration.number(), rules.message(), warning);
                return snapshot();
            }
            requireBreakpointStop(stopRevision);
            response = exceptionBreakpoint ? resumeUntilException() : continueWith(PlDebugNative.CONTINUE);
        }
        return response;
    }

    private Map<String, Object> resumeUntilException() throws Exception {
        requireExceptionCapability();
        Map<String, Object> response = null;
        boolean truncated = false;
        for (int iteration = 0; iteration < EXCEPTION_RESUME_ITERATIONS; iteration++) {
            Map<String, Object> current = continueWith(PlDebugNative.EXCEPTION);
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
        stoppedOnException = !Boolean.TRUE.equals(response.get("terminated")) && reason != null && (reason == REASON_EXCEPTION || reason == REASON_HANDLER);
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
        requireBreakpointStop(stopRevision);
        if (breakpointMutationUnknown) throw new IllegalStateException("The original breakpoint operation is unresolved");
        if (enabled) requireExceptionCapability();
        exceptionBreakpoint = enabled;
        touch();
        Map<String, Object> response = snapshot();
        response.put("message", enabled ? "exception breakpoint enabled" : "exception breakpoint disabled");
        return response;
    }

    private void requireExceptionCapability() {
        if (!Boolean.TRUE.equals(exceptionCapability.get("canAttempt"))) {
            throw com.dbx.agent.AgentRpcError.requestRejected(String.valueOf(exceptionCapability.get("message")));
        }
    }

    synchronized Map<String, Object> stepOver() throws Exception {
        return applyBreakpointRules(continueWith(PlDebugNative.STEP_OVER), false);
    }

    synchronized Map<String, Object> stepIn() throws Exception {
        return applyBreakpointRules(continueWith(PlDebugNative.STEP_IN), false);
    }

    synchronized Map<String, Object> stepOut() throws Exception {
        Integer originalDepth = currentStackDepth;
        Map<String, Object> response = applyBreakpointRules(continueWith(PlDebugNative.STEP_OUT), false);
        Integer depth = asInteger(response.get("stackDepth"));
        boolean complete = Boolean.TRUE.equals(response.get("terminated"))
            || (originalDepth != null && originalDepth > 0 && depth != null && depth >= 0 && depth < originalDepth);
        response.put("stepOutComplete", complete);
        if (!complete) {
            response.put("message", originalDepth == null || originalDepth <= 0 || depth == null || depth < 0
                ? "The native stack depth is unavailable; step-out completion could not be confirmed"
                : "Step out paused before leaving the original frame");
        }
        return response;
    }

    /**
     * Runs the debuggee to completion without stopping at the session's breakpoints --
     * ODC's resumeIgnoreBreakpoints.
     *
     * <p>The helper package ships {@code DBX_CNT_EXIT} for this, but its loop cannot end
     * on this architecture, so it is deliberately not called any more (the routine stays
     * in the shared body untouched: removing it would force a package version bump in
     * both agents for no behaviour). {@code DBX_CNT_EXIT} steps with
     * {@code CONTINUE(break_next_line)} and leaves the loop only when
     * {@code run_info.reason} is {@code reason_exit} (15), while the debuggee's driver
     * block always ends with {@code reason_knl_exit} (25). Measured on Oracle 19c EE,
     * 2026-10-10: a step with that flag reports reasons 9, 9, ... and finally 25 with
     * {@code terminated=1} -- never 15 -- so the loop kept continuing an already finished
     * program until the agent's 30s guard abandoned the debugger connection (the "run to
     * the end" button was dead), and a single {@code break_next_line} round trip costs
     * about 120ms, which no real procedure's line count could afford anyway.
     *
     * <p>Breakpoints pause the interpreter regardless of the {@code CONTINUE} flags, so
     * "ignore the breakpoints" can only mean "take them out of the way": every armed
     * breakpoint is disabled for the run, the ordinary {@code break_any_return} continue
     * drives the program to its end, and the breakpoints this call disabled are put back
     * unless the program finished -- a finished session has nothing left to stop and
     * refusing to re-enable would only log. The exception breakpoint is ignored as well:
     * this is a plain run, not an exception-mode resume. Mirrors the Go driver's
     * {@code resumeIgnoreBreakpoints}.
     */
    synchronized Map<String, Object> resumeIgnoreBreakpoints() throws Exception {
        requireOpen();
        if (terminateState()) {
            Map<String, Object> response = snapshot();
            response.put("message", "debuggee has finished");
            return response;
        }
        breakpointRegistry.verify();
        List<PlDebugBreakpointRegistry.Registration> armed = breakpointRegistry.registrations().stream()
            .filter(breakpointRegistry::enabled).toList();

        List<PlDebugBreakpointRegistry.Registration> disabled = new ArrayList<>();
        for (PlDebugBreakpointRegistry.Registration registration : armed) {
            Map<String, Object> toggle = setRegisteredBreakpointEnabled(registration, false);
            if (!Boolean.TRUE.equals(toggle.get("ok"))) {
                LOG.warning("the server refused to disable breakpoint " + registration.number() + "; the run may stop there");
                continue;
            }
            disabled.add(registration);
        }

        Map<String, Object> response = runToTermination();
        if (response != null && Boolean.TRUE.equals(response.get("terminated"))) {
            return response;
        }
        // The program is still alive (it stopped at a breakpoint this call could not
        // disable, or the loop hit its cap): put back exactly what was taken away.
        restoreDisabledBreakpoints(disabled);
        return response;
    }

    /**
     * Restores only confirmed disables after a confirmed paused continuation.
     * An unsuccessful restoration stops the sequence and preserves its partial state.
     */
    private void restoreDisabledBreakpoints(List<PlDebugBreakpointRegistry.Registration> disabled) throws Exception {
        for (PlDebugBreakpointRegistry.Registration registration : disabled) {
            Map<String, Object> restored = setRegisteredBreakpointEnabled(registration, true);
            if (!Boolean.TRUE.equals(restored.get("ok"))) {
                throw new IllegalStateException("The original breakpoint could not be restored: " + restored.get("message"));
            }
        }
    }

    /**
     * Drives the program to its end with the ordinary resume continue, one call per stop,
     * for {@link #resumeIgnoreBreakpoints()}. Each {@code DBX_CNT_NEXT_BREAKPOINT}
     * ({@code break_any_return}) answer carries the session's real termination state --
     * {@code terminated} comes from {@link #terminateState()}, i.e. from the debuggee's
     * own statement having returned, which is the one signal this agent has (the run_info
     * message carries no {@code terminated} field) -- so a finished program ends the loop
     * without this method ever marking it. A stop at a breakpoint ends the loop instead
     * of continuing: its breakpoint could not be disabled, so continuing would hit the
     * same stop again, and the caller is the one that restores what it disabled. Mirrors
     * the Go driver's {@code runToTermination}.
     */
    private Map<String, Object> runToTermination() throws Exception {
        Map<String, Object> response = null;
        for (int iteration = 0; iteration < IGNORE_RESUME_ITERATIONS; iteration++) {
            Map<String, Object> current = continueWith(PlDebugNative.CONTINUE);
            if (current == null) {
                break;
            }
            response = current;
            if (Boolean.TRUE.equals(current.get("terminated"))) {
                return current;
            }
            Integer breakpoint = asInteger(current.get("breakpoint"));
            Integer reason = asInteger(current.get("reason"));
            if ((breakpoint != null && breakpoint > 0) || (reason != null && reason == REASON_BREAKPOINT)) {
                current.put(
                    "message",
                    "运行到结束在断点处停下（该断点未能被禁用）: breakpoint="
                        + (breakpoint == null ? 0 : breakpoint)
                        + " reason="
                        + (reason == null ? 0 : reason)
                );
                return current;
            }
        }
        if (response == null) {
            return null;
        }
        response.put("message", "运行到结束在 " + IGNORE_RESUME_ITERATIONS + " 次续跑后仍未终止");
        return response;
    }

    Map<String, Object> abort() throws Exception {
        return abort(false);
    }

    Map<String, Object> abortByStatement() throws Exception {
        return abort(true);
    }

    private Map<String, Object> abort(boolean byStatement) throws Exception {
        requestAbort();
        requireTargetConnectionConfigured();
        if (terminateState()) return snapshot();
        // Do not take this session's monitor: a CONTINUE can still be pending.
        // A Future cancellation only ends a Java wait, not the database statement.
        if (byStatement || controlRunning.get() || executionUnknown || breakpointMutationUnknown || breakpointInventoryUnconfirmed() || !initialReady || !debuggerAttached || debuggerConnection.isClosed()) {
            Statement original = targetStatement;
            if (original == null && !targetReturned) {
                // Startup still owns the connections and will observe the latch
                // before dispatch. This is an intent, not a cancellation receipt.
                if (!targetDispatched) return snapshot();
                throw new IllegalStateException("The original target is not available for cancellation; execution is unknown");
            }
            synchronized (targetJdbcLock) {
                requireTargetConnectionConfigured();
                if (original != null && targetExecuting) original.cancel();
            }
            awaitTargetReturn();
            return snapshot();
        }
        continueWith(PlDebugNative.ABORT);
        return snapshot();
    }

    void requestAbort() {
        abortRequested.set(true);
    }

    private void checkStartCancellation() {
        if (abortRequested.get()) throw new CancellationException("PL debug start was cancelled before dispatch");
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
        ensureNotTerminated("read variables");
        PlDebugNative.Stack stack = ensureStack();
        Map<String, Object> response = snapshot();
        response.put("frame", frame);
        response.put("stopRevision", stopRevision);
        List<PlDebugNative.Value> values = PlDebugNative.variables(debuggerConnection, stack, frame);
        response.put("variables", targetBlock == null ? values : targetBlock.userValues(values));
        response.put("frameScoped", true);
        touch();
        return response;
    }

    synchronized Map<String, Object> variable(String name, int frame) throws Exception {
        requireOpen();
        ensureNotTerminated("read variable");
        Map<String, Object> response = snapshot();
        response.put("frame", frame);
        response.put("stopRevision", stopRevision);
        response.put("variable", PlDebugNative.value(debuggerConnection, ensureStack(), frame, name));
        touch();
        return response;
    }

    /**
     * Renders the PL/SQL assignment {@code SYS.DBMS_DEBUG.SET_VALUE} executes inside the
     * debuggee. Its second argument is statement <em>text</em>, not a value: the
     * caller is responsible for the literal, so a string arrives already quoted
     * ("'abc'") and is forwarded verbatim -- adding quotes here would double them. An
     * index &gt; 0 addresses a collection element ("x(1) := 5"), unless the name
     * already carries its own index. Mirrors the Go driver's
     * {@code plDebugAssignmentStatement}.
     *
     * <p>The native caller adds the statement terminator before its single dispatch.
     */
    static String assignmentStatement(String name, int index, String value) {
        String target = name == null ? "" : name.trim();
        boolean quoted = false;
        boolean indexed = false;
        for (int i = 0; i < target.length(); i++) {
            if (target.charAt(i) == '"') {
                if (quoted && i + 1 < target.length() && target.charAt(i + 1) == '"') { i++; continue; }
                quoted = !quoted;
            } else if (!quoted && target.charAt(i) == '(') { indexed = true; break; }
        }
        if (index > 0 && !indexed) {
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
            return false;
        }
        String upper = message.toUpperCase(Locale.ROOT);
        for (String marker : new String[] {"PLS-00201", "PLS-00302", "ORA-00904", "MUST BE DECLARED", "NOT DECLARED"}) {
            if (upper.contains(marker)) {
                return true;
            }
        }
        return false;
    }

    long breakpointStopRevision() { return stopRevision; }

    void requireBreakpointStop(long expectedRevision) {
        requireOpen();
        ensureNotTerminated("change breakpoints");
        if (expectedRevision != stopRevision || executionUnknown || controlRunning.get() || abortRequested.get()) {
            throw new IllegalStateException("The breakpoint operation belongs to an old or unavailable debug stop");
        }
    }

    synchronized Map<String, Object> setValue(String name, int frame, int index, String value) throws Exception {
        return setValue(name, frame, index, value, stopRevision, () -> { });
    }

    synchronized Map<String, Object> setValue(String name, int frame, int index, String value,
                                              long expectedRevision, Runnable beforeDispatch) throws Exception {
        requireOpen();
        ensureNotTerminated("set value");
        if (expectedRevision != stopRevision || executionUnknown || controlRunning.get()) {
            throw new IllegalStateException("The assignment belongs to an old or unavailable debug stop");
        }
        String variableName = name == null ? "" : name.trim();
        String assignment = assignmentStatement(variableName, index, value);
        if (!assignment.stripTrailing().endsWith(";")) assignment += ";";
        boolean[] dispatched = {false};
        int result;
        try {
            result = PlDebugNative.setValue(debuggerConnection, ensureStack(), frame, assignment, () -> {
                dispatched[0] = true;
                beforeDispatch.run();
            });
        } catch (Exception error) {
            if (dispatched[0]) executionUnknown = true;
            throw error;
        }
        touch();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", result == RESULT_SUCCESS);
        response.put("result", result);
        String message = result == RESULT_SUCCESS
            ? "set " + variableName + " (frame=" + frame + ", index=" + index + ")"
            : "SYS.DBMS_DEBUG.SET_VALUE returned result=" + result + " for " + variableName
                + " (frame=" + frame + ", index=" + index + ")";
        response.put("message", message);
        response.put("assignmentSemicolon", true);
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
        if (result == RESULT_CAPABILITY_UNAVAILABLE) {
            return "该服务器不支持" + action + "断点（SYS.DBMS_DEBUG.ENABLE_BREAKPOINT / DISABLE_BREAKPOINT 不可用），"
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
     * {@code SYS.DBMS_DEBUG.ENABLE_BREAKPOINT} / {@code DISABLE_BREAKPOINT} functions
     * dynamically (both take the breakpoint number and return success /
     * error_no_such_breakpt / error_idle_breakpt).
     *
     * <p>A result of -1 is the capability sentinel and is reported through
     * {@code serverSupported=false} instead of an error, so the front end keeps its
     * client-side fallback (delete the breakpoint and re-set it to re-enable) on the
     * servers that have no such primitive.
     */
    synchronized Map<String, Object> setBreakpointEnabled(int breakpoint, boolean enabled) throws Exception {
        return setBreakpointEnabled(breakpoint, enabled, () -> {});
    }

    synchronized Map<String, Object> setBreakpointEnabled(int breakpoint, boolean enabled, Runnable beforeDispatch) throws Exception {
        requireOpen();
        ensureNotTerminated("set breakpoint enabled");
        if (breakpoint <= 0) {
            throw new IllegalArgumentException("breakpointNumber must be a positive breakpoint number");
        }
        return setRegisteredBreakpointEnabled(breakpointRegistry.legacyRegistration(breakpoint), enabled, beforeDispatch);
    }

    private Map<String, Object> setRegisteredBreakpointEnabled(PlDebugBreakpointRegistry.Registration registration, boolean enabled) throws Exception {
        return setRegisteredBreakpointEnabled(registration, enabled, () -> {});
    }

    private Map<String, Object> setRegisteredBreakpointEnabled(PlDebugBreakpointRegistry.Registration registration, boolean enabled, Runnable beforeDispatch) throws Exception {
        requireOpen();
        ensureNotTerminated("set breakpoint enabled");
        int breakpoint = registration.number();
        PlDebugBreakpointRegistry.Mutation mutation;
        try {
            if (enabled && registration.source() != null && targetSource != null) requireNamedSource();
            mutation = breakpointRegistry.enabled(registration.id(), enabled, beforeDispatch);
        } catch (PlDebugBreakpointRegistry.Failure error) {
            throw breakpointFailure(error);
        }
        int result = mutation.result();
        if (result == ERROR_NO_SUCH_BREAKPOINT) forgetBreakpoint(registration.id());
        publishBreakpoints();
        touch();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", result == RESULT_SUCCESS);
        response.put("result", result);
        response.put("breakpointNumber", breakpoint);
        response.put("enabled", enabled);
        response.put("serverSupported", result != RESULT_CAPABILITY_UNAVAILABLE);
        response.put("message", breakpointEnabledMessage(breakpoint, enabled, result));
        response.put("snapshot", snapshot());
        return response;
    }


    private PlDebugSource.Reference namedSourceReference(PlDebugNative.Frame frame) {
        return targetPlan == null ? null : PlDebugSource.reference(targetSource, frame, debugId + ":target", stopRevision, targetPlan.target());
    }

    private boolean refreshNamedSource() throws SQLException {
        sourceCheckedRevision = -1;
        targetSourceState = "read_error";
        try {
            PlDebugTarget.Candidate target = targetPlan.target();
            boolean unchanged = targetSource.equals(PlDebugSource.load(debuggerConnection, target));
            if (targetSpec != null) unchanged &= "candidate".equals(targetSpec.state()) && targetSpec.equals(
                PlDebugSource.load(debuggerConnection, target.owner(), target.packageName(), "PACKAGE", target.objectId()));
            unchanged &= PlDebugTarget.unchanged(debuggerConnection, target);
            targetSourceState = unchanged ? targetSource.state() : "changed";
            sourceCheckedRevision = stopRevision;
            return unchanged && "candidate".equals(targetSourceState);
        } catch (SQLException error) {
            if (PlDebugNative.connectionUnsafe(error)) {
                executionUnknown = true;
                currentStack = null;
            }
            throw error;
        }
    }

    private void requireNamedSource() throws SQLException {
        if (!refreshNamedSource()) throw new IllegalStateException("The complete source or signature version changed; refresh the debug target");
    }

    /** Supplement the native stop without replacing its exact current program identity. */
    private PlDebugNative.Stack fetchBacktrace() throws Exception {
        try {
            PlDebugNative.Stack stack = PlDebugNative.stack(debuggerConnection, currentStop, structuredBacktraceError);
            if (targetSource != null) {
                refreshNamedSource();
            }
            if (stack.structuredBacktraceError() != null) structuredBacktraceError = stack.structuredBacktraceError();
            currentStack = stack;
            touch();
            return stack;
        } catch (SQLException error) {
            if (PlDebugNative.connectionUnsafe(error)) {
                executionUnknown = true;
                currentStack = null;
            }
            throw error;
        } catch (IOException error) {
            // A failed CLOB transfer does not confirm that the controller remains
            // attached. OB may resume the target if that connection was lost.
            executionUnknown = true;
            currentStack = null;
            throw error;
        }
    }

    private PlDebugNative.Stack ensureStack() throws Exception {
        return currentStack == null ? fetchBacktrace() : currentStack;
    }

    /**
     * Best-effort identity supplement for a confirmed stop. Unsafe controller loss
     * is recorded by fetchBacktrace; missing identity does not replace the native
     * stop with a program name guessed from the textual listing.
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
        boolean cachedStack = currentStack != null;
        PlDebugNative.Stack backtrace = ensureStack();
        if (cachedStack && targetSource != null) refreshNamedSource();
        response.put("targetSourceState", targetSourceState);
        response.put("line", displayLine());
        response.put("nativeLine", currentLine);
        response.put("program", currentProgram);
        response.put("programOwner", currentProgramOwner);
        response.put("backtrace", backtrace.listing());
        response.put("complete", backtrace.complete());
        response.put("runtimeDepth", backtrace.runtimeDepth());
        response.put("frameMappingState", backtrace.frameMappingState());
        response.put("structuredBacktraceError", backtrace.structuredBacktraceError());
        response.put("textBacktraceError", backtrace.textBacktraceError());
        response.put("message", backtrace.message());
        response.put("stopRevision", stopRevision);
        // Frame positions come from this stop's runtime depth. Native identities
        // may be partial; text is not a fallback object identity. The first UI
        // frame is always the current (innermost) frame.
        List<Map<String, Object>> frames = new ArrayList<>();
        for (PlDebugNative.Frame frame : backtrace.frames()) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("frameIndex", frame.index());
            item.put("nativeFrameId", frame.nativeFrameId());
            item.put("stackDepth", backtrace.frames().size() - frame.index());
            item.put("program", frame.program());
            item.put("programOwner", frame.owner());
            item.put("namespace", frame.namespace());
            item.put("rawDisplayName", frame.rawDisplayName());
            item.put("identityState", frame.identityState());
            item.put("sourceState", frame.sourceState());
            if (targetPlan == null && frame.index() == 0 && frame.nativeFrameId() == 1 && verifyWrapperRoot()) {
                PlDebugSource.Reference sourceRef = anonymousSourceReference();
                if (sourceRef != null) {
                    item.put("sourceRef", sourceRef);
                    item.put("sourceState", "resolved");
                    item.put("sourceLine", frame.line() - sourceLineOffset);
                }
            }
            if (sourceCheckedRevision == stopRevision && "candidate".equals(targetSourceState)) {
                PlDebugSource.Reference sourceRef = namedSourceReference(frame);
                if (sourceRef != null) {
                    item.put("sourceRef", sourceRef);
                    item.put("sourceState", "resolved");
                    item.put("sourceLine", frame.line());
                }
            }
            item.put("line", displayFrameLine(frame.program(), frame.line()));
            item.put("nativeLine", frame.line());
            frames.add(item);
        }
        response.put("frames", frames);
        return response;
    }

    Map<String, Object> log() {
        Map<String, Object> response = snapshot();
        PlDebugOutput.Text output = outputText();
        response.put("output", output.text());
        response.put("outputComplete", output.complete());
        response.put("outputTruncated", output.truncated());
        response.put("outputError", output.error());
        response.put("outputPending", !targetReturned);
        return response;
    }

    Map<String, Object> log(int offset, int limit) {
        Map<String, Object> response = snapshot();
        response.put("outputPage", PlDebugOutput.page(outputText(), offset, limit));
        response.put("outputPending", !targetReturned);
        return response;
    }

    private PlDebugOutput.Text outputText() {
        PlDebugOutput.Capture result = captured;
        return result == null ? new PlDebugOutput.Text("", false, false, outputRecoveryError) : result.output();
    }

    private void recoverOutput() {
        requireTargetConnectionConfigured();
        if (captured != null || outputRecoveryAttempted || !targetReturned) return;
        outputRecoveryAttempted = true;
        if (!debuggerAttached) {
            outputRecoveryError = "The debugger did not attach; DBMS_OUTPUT could not be recovered";
            return;
        }
        try {
            if (debuggerConnection.isClosed()) {
                outputRecoveryError = "The debugger connection is closed; DBMS_OUTPUT recovery is incomplete";
                return;
            }
        } catch (SQLException error) {
            outputRecoveryError = "The debugger connection state could not be confirmed; DBMS_OUTPUT recovery is incomplete";
            return;
        }
        if (debuggeeExecutor == null) {
            outputRecoveryError = "No debuggee output worker is available";
            return;
        }
        FutureTask<PlDebugOutput.Capture> cleanup = completionTask(() -> {
            CallableStatement call = debuggeeConnection.prepareCall(PlDebugOutput.cleanupSql());
            pendingOutputStatement = call;
            Exception cleanupFailure = null;
            try {
                call.setQueryTimeout(PlDebugNative.CALL_TIMEOUT_SECONDS);
                PlDebugOutput.register(call, 1);
                int originalTimeout;
                synchronized (targetJdbcLock) {
                    requireTargetConnectionConfigured();
                    originalTimeout = suspendTargetTimeout();
                }
                Exception executeFailure = null;
                try { call.execute(); }
                catch (Exception error) { executeFailure = error; throw error; }
                finally {
                    synchronized (targetJdbcLock) {
                        try { restoreTargetTimeout(originalTimeout); }
                        catch (Exception restoreError) {
                            if (executeFailure != null) executeFailure.addSuppressed(restoreError);
                            else throw restoreError;
                        }
                    }
                }
                return PlDebugOutput.read(call, 1);
            } catch (Exception error) {
                cleanupFailure = error;
                throw error;
            } finally {
                if (targetConnectionConfigurationError == null) {
                    try { call.close(); pendingOutputStatement = null; }
                    catch (Exception closeError) {
                        if (cleanupFailure != null) cleanupFailure.addSuppressed(closeError);
                        else throw closeError;
                    }
                }
            }
        });
        pendingOutputCleanup = cleanup;
        debuggeeExecutor.execute(cleanup);
        try {
            // This is a private DEBUG_OFF/drain block, not another business run.
            // Its native events must not replace the original target's terminal stop.
            PlDebugNative.Stop sync = PlDebugNative.synchronize(debuggerConnection);
            if (sync.result() != RESULT_SUCCESS) throw new IllegalStateException("Output cleanup synchronization failed");
            if (!sync.terminated()) {
                PlDebugNative.Stop stop = PlDebugNative.continueWith(debuggerConnection, PlDebugNative.CONTINUE);
                if (stop.result() != RESULT_SUCCESS) throw new IllegalStateException("Output cleanup continuation failed");
            }
            captured = cleanup.get(PlDebugNative.CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            pendingOutputCleanup = null;
        } catch (Exception error) {
            outputRecoveryError = "DBMS_OUTPUT cleanup could not be confirmed";
            // The cleanup can still own the debuggee connection. Do not send rollback
            // or another drain on that connection while this future is outstanding.
            pendingOutputCleanup = cleanup;
        }
    }

    void setCompletionListener(Runnable listener) {
        completionListener = listener;
    }

    private <T> FutureTask<T> completionTask(java.util.concurrent.Callable<T> action) {
        return new FutureTask<>(action) {
            @Override protected void done() { completionListener.run(); }
        };
    }

    Map<String, Object> results() {
        String collectionState = resultCollectionState;
        return Map.of("results", resultCache.manifests(), "collectionState", collectionState);
    }

    Map<String, Object> resultPage(String generation, String resultId, int offset, int limit) {
        return resultCache.page(generation, resultId, offset, limit);
    }

    Map<String, Object> snapshot() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("debugId", debugId);
        response.put("owner", owner);
        response.put("terminated", terminateState());
        response.put("line", displayLine());
        response.put("nativeLine", currentLine);
        response.put("program", currentProgram);
        response.put("programOwner", currentProgramOwner);
        response.put("namespace", currentProgramNamespace);
        response.put("breakpoint", currentBreakpoint);
        response.put("reason", currentReason);
        response.put("stackDepth", currentStackDepth);
        response.put("error", debuggeeError);
        response.put("expired", isExpired());
        response.put("targetReturned", targetReturned);
        response.put("targetDispatched", targetDispatched);
        response.put("executionStopped", terminateState());
        response.put("executionOutcome", executionOutcome);
        response.put("executionStage", executionStage);
        response.put("cancelRequested", abortRequested.get());
        response.put("cancelConfirmed", "cancelled".equals(executionOutcome));
        response.put("resultError", resultError);
        response.put("inputSessionTimeZone", inputSessionTimeZone);
        response.put("state", terminateState() ? "ended" : executionUnknown || breakpointMutationUnknown || breakpointInventoryUnconfirmed() || "unknown".equals(executionOutcome) ? "unknown" : controlRunning.get() ? "running" : "paused");
        response.put("breakpointMutationOutcome", breakpointMutationUnknown ? "unknown" : null);
        response.put("breakpointRulesOwner", "agent");
        response.put("breakpointInventoryState", breakpointRegistry.state());
        response.put("breakpointInventoryListing", breakpointRegistry.observed());
        response.put("targetSource", targetSource);
        response.put("targetSourceState", targetSourceState);
        response.put("breakpoints", confirmedBreakpoints);
        response.put("breakpointRuleEvents", breakpointRuleEvents);
        response.put("stopRevision", stopRevision);
        response.put("sourceLineOffset", sourceLineOffset);
        response.put("releaseState", releaseState);
        response.put("debuggerDetached", debuggerDetached);
        response.put("debuggerAttached", debuggerAttached);
        response.put("debuggerClosed", debuggerClosed);
        response.put("debuggeeClosed", debuggeeClosed);
        response.put("transactionOutcome", transactionOutcome);
        PlDebugOutput.Capture result = captured;
        response.put("savepointRollback", result == null ? null : result.savepointRollback());
        response.put("outParams", outParams);
        response.put("outParamsState", !targetReturned ? "pending" : outParamsState);
        response.put("returnValue", returnValue);
        // stoppedOnException is true only when the last exception-mode resume
        // stopped on reason_exception / reason_handler.
        response.put("stoppedOnException", stoppedOnException);
        response.put("exceptionBreakpoint", exceptionBreakpoint);
        response.put("capabilities", Map.of("exceptions", exceptionCapability));
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
        return false;
    }

    private String displayLine() {
        Integer line = displayFrameLine(currentProgram, parseInteger(currentLine));
        return line == null ? null : line.toString();
    }

    private Integer displayFrameLine(String program, Integer nativeLine) {
        if (nativeLine == null) return null;
        if (sourceLineOffset > 0 && "__anonymous_block__".equals(program)) {
            if (!currentWrapperRoot()) return null;
            int line = nativeLine - sourceLineOffset;
            return line > 0 && targetBlock != null && line <= targetBlock.sourceLineCount() ? line : null;
        }
        return nativeLine;
    }

    private boolean isPrivateCaptureStop() {
        if (targetBlock == null || !"__anonymous_block__".equals(currentProgram)) return false;
        if (!currentWrapperRoot() || !(Integer.valueOf(9).equals(currentReason) || Integer.valueOf(8).equals(currentReason))
            || currentBreakpoint != null && currentBreakpoint > 0 || breakpointMutationUnknown || breakpointInventoryUnconfirmed()) return false;
        Integer line = parseInteger(currentLine);
        return targetPlan != null || (line != null && line > sourceLineOffset + targetBlock.sourceLineCount());
    }

    @Override
    public void close() {
        if (closed.get()) return;
        if (!closing.compareAndSet(false, true)) throw new IllegalStateException("PL debug cleanup is already running");
        releaseState = "releasing";
        try {
            requireTargetConnectionConfigured();
            if (!terminateState() && debuggeeFuture != null) abort();
            awaitTargetReturn();
            requireTargetConnectionConfigured();
            controlCompletion.get(PlDebugNative.CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            recoverOutput();
            Future<PlDebugOutput.Capture> cleanup = pendingOutputCleanup;
            if (cleanup != null) {
                captured = cleanup.get(PlDebugNative.CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                pendingOutputCleanup = null;
            }
            if (!rollbackConfirmed) {
                try {
                    if (debuggeeConnection != null) debuggeeConnection.rollback();
                    rollbackConfirmed = true;
                    transactionOutcome = "controlled_work_rolled_back";
                } catch (Exception rollbackError) {
                    transactionOutcome = "unknown";
                    throw new IllegalStateException("Debuggee rollback could not be confirmed", rollbackError);
                }
            }
            if (debuggerAttached && !debuggerClosed && !debuggerConnection.isClosed()) {
                executeStatement(debuggerConnection, "BEGIN SYS.DBMS_DEBUG.DETACH_SESSION; END;");
                debuggerDetached = true;
                debuggerAttached = false;
            }
            if (!debuggerClosed) {
                debuggerConnection.close();
                debuggerClosed = true;
            }
            if (!debuggeeClosed) {
                debuggeeConnection.close();
                debuggeeClosed = true;
            }
            closed.set(true);
            releaseState = "released";
        } catch (Exception error) {
            releaseState = "unknown";
            throw new IllegalStateException("PL debug cleanup is incomplete; keep this session for recovery", error);
        } finally {
            closing.set(false);
        }
    }

    private void awaitTargetReturn() throws Exception {
        Future<?> target = debuggeeFuture;
        if (!targetReturned && target != null) {
            try {
                target.get(PlDebugNative.CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                if (!target.isCancelled()) targetReturned = true;
            }
            catch (java.util.concurrent.ExecutionException error) {
                if (!targetReturned) throw error;
            }
        }
        if (target != null && (!targetReturned || !terminateState())) {
            throw new IllegalStateException("The original target has not confirmed database termination");
        }
    }

    private Map<String, Object> continueWith(int flags) throws Exception {
        if (flags == PlDebugNative.ABORT) {
            if (closed.get()) throw new IllegalStateException("PL debug session is closed");
        } else {
            requireOpen();
            if (abortRequested.get()) throw new IllegalStateException("This target has a pending abort request");
        }
        if (terminateState()) {
            Map<String, Object> response = snapshot();
            response.put("message", "debuggee has finished");
            return response;
        }
        synchronized (controlStateLock) {
            if (controlRunning.get()) throw new IllegalStateException("A debug control call is already running");
            controlCompletion = new CompletableFuture<>();
            controlRunning.set(true);
        }
        currentStack = null;
        boolean dispatched = false;
        try {
            if (flags != PlDebugNative.ABORT && abortRequested.get()) {
                throw new IllegalStateException("This target has a pending abort request");
            }
            dispatched = true;
            PlDebugNative.Stop stop = PlDebugNative.continueWith(debuggerConnection, flags);
            if (stop.result() != RESULT_SUCCESS) {
                throw new IllegalStateException("SYS.DBMS_DEBUG.CONTINUE failed (result=" + stop.result() + ")");
            }
            applyStop(stop);
            if (wrapperRootStop != null && !stop.terminated()) verifyWrapperRoot();
            long captureDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(PlDebugNative.CALL_TIMEOUT_SECONDS);
            while (initialReady && !stop.terminated() && isPrivateCaptureStop()) {
                checkStartCancellation();
                if (!verifyWrapperRoot()) break;
                long remaining = captureDeadline - System.nanoTime();
                if (remaining <= 0) throw new java.sql.SQLTimeoutException("The private output capture exceeded its time budget");
                int timeoutSeconds = (int) Math.max(1, TimeUnit.NANOSECONDS.toSeconds(remaining));
                stop = PlDebugNative.continueWith(debuggerConnection, PlDebugNative.CONTINUE, timeoutSeconds);
                if (stop.result() != RESULT_SUCCESS) throw new IllegalStateException("Private output capture continuation failed (result=" + stop.result() + ")");
                applyStop(stop);
                if (!stop.terminated()) verifyWrapperRoot();
            }
            if (stop.terminated()) {
                awaitTargetReturn();
                recoverOutput();
            } else if("argument_initialization".equals(executionStage)) {
                String phase=wrapperExecutionPhase();
                if("1".equals(phase))executionStage="calling";
                else if(!"-1".equals(phase))executionStage="entry_identity_unresolved";
            }
            touch();
            Map<String, Object> response = snapshot();
            response.put("state", terminateState() ? "ended" : "paused");
            return response;
        } catch (Exception error) {
            if (dispatched && !targetReturned) executionUnknown = true;
            throw error;
        } finally {
            synchronized (controlStateLock) {
                controlRunning.set(false);
                controlCompletion.complete(null);
            }
            completionListener.run();
        }
    }

    private void applyStop(PlDebugNative.Stop stop) {
        wrapperRootRevision = -1;
        stoppedOnException = !stop.terminated() && stop.reason() != null && (stop.reason() == REASON_EXCEPTION || stop.reason() == REASON_HANDLER);
        currentStop = stop;
        currentBreakpoint = stop.breakpoint();
        currentStackDepth = stop.depth();
        currentReason = stop.reason();
        currentLine = stop.line() == null ? null : stop.line().toString();
        currentProgram = stop.program();
        currentProgramOwner = stop.owner();
        currentProgramNamespace = stop.namespace();
        terminated = terminated || stop.terminated();
        executionUnknown = false;
        currentStack = null;
        stopRevision++;
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
     * Runs the debugging target on the debuggee connection. The statement
     * blocks there until the debugger issues continue/abort or the program
     * finishes; the outcome is captured for {@link #snapshot()}.
     */
    private void runDebuggeeTarget(PlDebugStartRequest request) {
        try {
            boolean anonymous = targetPlan == null;
            PlDebugOutput.Block block = anonymous ? PlDebugOutput.wrap(stripTrailingSlash(request.getSource())) : targetPlan.block();
            targetBlock = block;
            sourceLineOffset = anonymous ? block.sourceLineOffset() : 0;
            CallableStatement call = debuggeeConnection.prepareCall(block.sql());
            Exception targetFailure = null;
            try {
                int parameterIndex = anonymous ? 1 : targetPlan.bind(call);
                PlDebugOutput.register(call, parameterIndex);
                targetStatement = call;
                if (abortRequested.get()) {
                    executionOutcome = "cancelled";
                    terminated = true;
                    return;
                }
                executeTargetWait(call, anonymous);
                outputRecoveryAttempted = true;
                if (anonymous) {
                    captured = PlDebugOutput.read(call, parameterIndex);
                    executionOutcome = captured.errorCode() == 0 ? "succeeded" : "failed";
                    executionStage = captured.errorCode() == 0 ? "returned" : "calling";
                    debuggeeError = captured.errorCode() == 0 ? null : captured.error();
                    outParamsState = captured.errorCode() == 0 ? "available" : "unavailable";
                } else {
                    int phase = targetPlan.phase(call);
                    executionStage = phase >= 2 ? "returned" : phase == 1 ? "calling" : phase == -1 ? "argument_initialization" : "input_preparation";
                    // Phase 2 is written immediately after the business call. An
                    // export or driver read failure cannot undo that receipt.
                    if (phase >= 2) executionOutcome = "succeeded";
                    try {
                        captured = PlDebugOutput.read(call, parameterIndex);
                        if (phase < 2) {
                            if (captured.errorCode() == 0) throw new SQLException("The target did not return a consistent execution receipt");
                            executionOutcome = phase == 0 ? "not_started" : "failed";
                            debuggeeError = captured.error();
                        } else if (captured.errorCode() != 0) resultError = "The target returned, but result export failed";
                    } catch (SQLException error) {
                        outputRecoveryError = "The completed call's output transfer could not be confirmed";
                        if (phase < 2) throw error;
                        resultError = outputRecoveryError;
                    }
                    PlDebugTarget.Results results = targetPlan.read(call, phase, resultCache);
                    resultCollectionState = results.state();
                    outParams = results.outParams();
                    outParamsState = results.state();
                    returnValue = results.returnValue();
                    inputSessionTimeZone = results.inputSessionTimeZone();
                    if (results.error() != null) resultError = resultError == null ? results.error() : resultError + "; " + results.error();
                }
            } catch (Exception error) {
                targetFailure = error;
                throw error;
            } finally {
                if (targetConnectionConfigurationError == null) {
                    try { call.close(); }
                    catch (Exception closeError) {
                        if (targetFailure != null) targetFailure.addSuppressed(closeError);
                        else throw closeError;
                    }
                }
                if (targetConnectionConfigurationError == null) targetStatement = null;
                if ("pending".equals(resultCollectionState)) resultCollectionState = "unavailable";
            }
        } catch (Exception error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            if ("succeeded".equals(executionOutcome) || "failed".equals(executionOutcome)) {
                resultError = message;
            } else if (!targetDispatched) {
                executionOutcome = abortRequested.get() ? "cancelled" : "not_started";
                terminated = true;
                debuggeeError = message;
            } else if (error instanceof SQLException sqlError
                && (sqlError.getErrorCode() == -5065 || "70100".equals(sqlError.getSQLState()))) {
                // Connector/J's Oracle-compatible packet exposes interrupted
                // execution as ORA-00600/vendor 600 + SQLState 70100, not -5065.
                // Vendor 600 alone also covers unrelated internal failures.
                executionOutcome = abortRequested.get() ? "cancelled" : "failed";
                terminated = true;
                debuggeeError = message;
            } else {
                executionOutcome = "unknown";
                executionUnknown = true;
                debuggeeError = message;
            }
        } finally {
            if ("pending".equals(outParamsState)) {
                outParamsState = "succeeded".equals(executionOutcome) ? "error" : "unknown".equals(executionOutcome) ? "unknown" : "unavailable";
                if (targetPlan != null) {
                    PlDebugTarget.Results unread = targetPlan.unread(outParamsState);
                    outParams = unread.outParams();
                    returnValue = unread.returnValue();
                }
            }
            targetReturned = true;
        }
    }

    private void requireTargetConnectionConfigured() {
        Exception error = targetConnectionConfigurationError;
        if (error != null) throw new IllegalStateException("The debuggee connection timeout configuration is unconfirmed; retain the original session", error);
    }

    private void executeTargetWait(CallableStatement call, boolean anonymous) throws Exception {
        int originalTimeout;
        synchronized (targetJdbcLock) {
            if (abortRequested.get()) throw new CancellationException("PL debug target cancelled before dispatch");
            originalTimeout = suspendTargetTimeout();
            if (abortRequested.get()) {
                restoreTargetTimeout(originalTimeout);
                throw new CancellationException("PL debug target cancelled before dispatch");
            }
            targetExecuting = true;
            targetDispatched = true;
            executionOutcome = "running";
            executionStage = anonymous ? "calling" : "input_preparation";
        }
        Exception executeError = null;
        try {
            call.execute();
            terminated = true;
            executionOutcome = "unknown";
        } catch (Exception error) {
            executeError = error;
            throw error;
        } finally {
            targetExecuteReturned = true;
            wrapperRootRevision = -1;
            synchronized (targetJdbcLock) {
                targetExecuting = false;
                try { restoreTargetTimeout(originalTimeout); }
                catch (Exception restoreError) {
                    if (executeError != null) executeError.addSuppressed(restoreError);
                    else throw restoreError;
                }
            }
        }
    }

    private int suspendTargetTimeout() throws Exception {
        int originalTimeout = debuggeeConnection.getNetworkTimeout();
        if (originalTimeout != 0) {
            try { debuggeeConnection.setNetworkTimeout(Runnable::run, 0); }
            catch (Exception error) { targetConnectionConfigurationError = error; throw error; }
        }
        return originalTimeout;
    }

    private void restoreTargetTimeout(int originalTimeout) throws Exception {
        if (originalTimeout == 0) return;
        try { debuggeeConnection.setNetworkTimeout(Runnable::run, originalTimeout); }
        catch (Exception error) { targetConnectionConfigurationError = error; throw error; }
    }

    /** JDBC chokes on a client-style trailing slash after an anonymous block. */
    static String stripTrailingSlash(String sql) {
        String source = sql == null ? "" : sql;
        while (true) {
            int end = source.length();
            while (end > 0 && Character.isWhitespace(source.charAt(end - 1))) end--;
            if (end == 0 || source.charAt(end - 1) != '/') return source;
            source = source.substring(0, end - 1);
        }
    }

    private boolean breakpointInventoryUnconfirmed() {
        return "unknown".equals(breakpointRegistry.state()) || "changed".equals(breakpointRegistry.state());
    }

    private void requireOpen() {
        requireTargetConnectionConfigured();
        if (closed.get()) {
            throw new IllegalStateException("PL debug session is closed");
        }
        if (isExpired()) {
            throw new IllegalStateException("PL debug session timed out");
        }
        if (executionUnknown) throw new IllegalStateException("The previous execution outcome is unknown; inspect or stop this session first");
        if (breakpointMutationUnknown) throw new IllegalStateException("The original breakpoint mutation outcome is unknown; inspect or close this session first");
        breakpointRegistry.requireUsable();
        if (!"open".equals(releaseState)) throw new IllegalStateException("PL debug cleanup must finish before another operation");
    }

    private void ensureNotTerminated(String operation) {
        if (terminateState()) {
            throw new IllegalStateException("Cannot " + operation + ": debuggee has finished");
        }
    }

    private void touch() {
        lastActivityMillis = System.currentTimeMillis();
    }

    Map<String, Object> heartbeat() {
        touch();
        return snapshot();
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
