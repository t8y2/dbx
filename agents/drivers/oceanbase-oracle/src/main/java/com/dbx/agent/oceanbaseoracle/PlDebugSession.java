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
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
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

    private static final Pattern RUN_INFO_MESSAGE = Pattern.compile(
        "breakpoint = (\\d+), stackdepth = (\\d+), reason = (\\d+), line = (\\d+), programname = ([^,]*), programowner = (.*)"
    );

    private static final int RESULT_SUCCESS = 0;

    private final String debugId;
    private final String owner;
    private final Connection debuggeeConnection;
    private final Connection debuggerConnection;
    private final ExecutorService debuggeeExecutor;
    private final List<PlDebugBreakpoint> breakpoints = new CopyOnWriteArrayList<>();
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicBoolean debugOffSent = new AtomicBoolean(false);
    private final long timeoutMillis;

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

    private PlDebugSession(
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
        this.debuggeeExecutor = debuggeeExecutor;
        this.timeoutMillis = timeoutMillis;
    }

    /**
     * Full start sequence: create the helper package, park the debuggee on its
     * first line with {@code DBMS_DEBUG}, attach the debugger connection, then
     * run the target program asynchronously on the debuggee connection.
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

        for (String statement : DbxPlDebugPackage.createStatements(owner)) {
            executeStatement(debuggeeConnection, statement);
        }
        try (CallableStatement call = debuggeeConnection.prepareCall("CALL DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR(?)")) {
            call.setInt(1, DEBUGGEE_TIMEOUT_BEHAVIOUR);
            call.execute();
        }

        String debugId = queryString(debuggeeConnection, "SELECT DBMS_DEBUG.INITIALIZE() FROM DUAL");
        if (debugId == null || debugId.trim().isEmpty()) {
            throw new IllegalStateException("DBMS_DEBUG.INITIALIZE() returned no debug id");
        }
        debugId = debugId.trim();

        executeStatement(debuggeeConnection, "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;");
        executeStatement(debuggeeConnection, "CALL DBMS_DEBUG.DEBUG_ON()");
        try (CallableStatement call = debuggerConnection.prepareCall("CALL DBMS_DEBUG.ATTACH_SESSION(?)")) {
            call.setString(1, debugId);
            call.execute();
        }

        PlDebugSession session =
            new PlDebugSession(debugId, owner, debuggeeConnection, debuggerConnection, debuggeeExecutor, timeoutMillis);
        session.debuggeeFuture = debuggeeExecutor.submit(() -> session.runDebuggeeTarget(request));
        return session;
    }

    String debugId() {
        return debugId;
    }

    synchronized Map<String, Object> setBreakpoints(List<PlDebugBreakpoint> requested) throws Exception {
        requireOpen();
        ensureNotTerminated("set breakpoints");
        List<PlDebugBreakpoint> created = new ArrayList<>();
        for (PlDebugBreakpoint breakpoint : requested) {
            if (breakpoint == null || breakpoint.getLine() == null) {
                continue;
            }
            int line = breakpoint.getLine();
            String kind = breakpoint.getKind() == null ? "" : breakpoint.getKind().trim().toUpperCase();
            int breakpointNumber;
            int result;
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
            breakpoints.add(stored);
            created.add(stored);
        }
        touch();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", true);
        response.put("breakpoints", created);
        return response;
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

    synchronized Map<String, Object> resume() throws Exception {
        return continueWith(DbxPlDebugPackage.PROCEDURE_CNT_NEXT_BREAKPOINT);
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

    synchronized Map<String, Object> abort() throws Exception {
        return continueWith(DbxPlDebugPackage.PROCEDURE_CNT_ABORT);
    }

    /**
     * Reads the scalar values of the paused frame. OceanBase serializes them
     * as a JSON payload; the raw text is returned unchanged and parsed on the
     * Rust side, which owns JSON handling for the whole protocol.
     */
    synchronized Map<String, Object> variables() throws Exception {
        requireOpen();
        Map<String, Object> response = snapshot();
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
            throw new IllegalStateException("DBMS_DEBUG.GET_VALUES failed (result=" + result + ")");
        }
        touch();
        response.put("scalarValues", scalarValues == null ? "" : scalarValues);
        return response;
    }

    synchronized Map<String, Object> stack() throws Exception {
        requireOpen();
        if (terminated) {
            Map<String, Object> response = snapshot();
            response.put("backtrace", "");
            return response;
        }
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
        Map<String, Object> response = snapshot();
        response.put("backtrace", listing == null ? "" : listing);
        response.put("dbmsStatus", status);
        return response;
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
        closeQuietly(debuggerConnection);
        closeQuietly(debuggeeConnection);
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
        Integer line = parseInteger(matcher.group(4));
        currentLine = line != null && line > 0 ? line.toString() : null;
        String program = matcher.group(5) == null ? "" : matcher.group(5).trim();
        String programOwner = matcher.group(6) == null ? "" : matcher.group(6).trim();
        currentProgram = program.isEmpty() ? null : program;
        currentProgramOwner = programOwner.isEmpty() ? null : programOwner;
    }

    private void deleteBreakpointNumber(int breakpointNumber) throws Exception {
        try (CallableStatement call = debuggerConnection.prepareCall("CALL DBMS_DEBUG.DELETE_BREAKPOINT(?)")) {
            call.setInt(1, breakpointNumber);
            call.execute();
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
            StringBuilder block = new StringBuilder("BEGIN ");
            boolean hasReturn = "FUNCTION".equals(objectType);
            if (hasReturn) {
                block.append("? := ");
            }
            block.append(routine).append('(');
            for (int index = 0; index < params.size(); index++) {
                if (index > 0) {
                    block.append(", ");
                }
                block.append('?');
            }
            block.append("); END;");
            try (CallableStatement call = debuggeeConnection.prepareCall(block.toString())) {
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
