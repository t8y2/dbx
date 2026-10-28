package com.dbx.agent.oceanbaseoracle;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.Reader;
import java.sql.CallableStatement;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Anonymous DBMS_DEBUG calls for OceanBase Oracle mode. No schema objects are installed.
 * Adapted from Ziyu Yang's DBX debugger and its ODC-derived call sequences; see NOTICE.
 * Oracle's BOOLEAN runtime_info and PROGRAM_INFO extensions belong to the Go adapter.
 */
final class PlDebugNative {
    static boolean connectionUnsafe(SQLException error) {
        return error instanceof java.sql.SQLTimeoutException || error instanceof java.sql.SQLRecoverableException
            || error instanceof java.sql.SQLTransientConnectionException || error instanceof java.sql.SQLNonTransientConnectionException
            || error.getSQLState() != null && error.getSQLState().startsWith("08");
    }

    static final int CALL_TIMEOUT_SECONDS = 30;
    static final int CONTINUE = 512;
    static final int STEP_OVER = 32;
    static final int STEP_IN = 12;
    static final int STEP_OUT = 512;
    static final int ABORT = 8192;
    static final int EXCEPTION = 2 + 2048;

    record Stop(int result, Integer line, boolean terminated, Integer reason,
                Integer depth, Integer breakpoint, String program, String owner, Integer namespace) {}

    record Frame(int index, int nativeFrameId, String program, String owner,
                 Integer namespace, Integer line, String rawDisplayName, String identityState, String sourceState) {}

    record ReadError(String sqlState, int vendorCode, String message) {}

    record Stack(List<Frame> frames, String listing, Integer runtimeDepth, String frameMappingState,
                 boolean complete, String message, ReadError structuredBacktraceError, ReadError textBacktraceError) {
        int nativeFrame(int frameIndex) {
            if (!"verified".equals(frameMappingState)) {
                throw new IllegalStateException("The native frame positions are unavailable; refresh the stop before reading a frame");
            }
            if (frameIndex < 0 || frameIndex >= frames.size()) throw new IllegalArgumentException("Invalid stack frame");
            return frames.get(frameIndex).nativeFrameId();
        }
    }

    record Value(String name, String type, String state, String value, String rawValue, String message) {}

    private static final String STOP_FIELDS = "? := rc; ? := r.line#; ? := r.terminated; ? := r.reason; "
        + "? := r.stackdepth; ? := r.breakpoint; ? := r.program.name; ? := r.program.owner; ? := r.program.namespace; END;";

    private static final String STACK_SQL = """
        DECLARE
          frames SYS.DBMS_DEBUG.backtrace_table;
          idx BINARY_INTEGER;
          item VARCHAR2(4000);
          payload CLOB;
          frame_name VARCHAR2(128);
          frame_owner VARCHAR2(128);
          frame_namespace INTEGER;
          first_frame BOOLEAN := TRUE;
        BEGIN
          SYS.DBMS_DEBUG.print_backtrace(frames);
          SYS.DBMS_LOB.createtemporary(payload, TRUE);
          SYS.DBMS_LOB.writeappend(payload, 1, '[');
          idx := frames.FIRST;
          WHILE idx IS NOT NULL LOOP
            frame_name := frames(idx).name;
            frame_owner := frames(idx).owner;
            frame_namespace := frames(idx).namespace;
            SELECT JSON_OBJECT('name' VALUE frame_name, 'owner' VALUE frame_owner,
                               'namespace' VALUE frame_namespace) INTO item FROM DUAL;
            IF NOT first_frame THEN SYS.DBMS_LOB.writeappend(payload, 1, ','); END IF;
            SYS.DBMS_LOB.writeappend(payload, LENGTH(item), item);
            first_frame := FALSE;
            idx := frames.NEXT(idx);
          END LOOP;
          SYS.DBMS_LOB.writeappend(payload, 1, ']');
          ? := payload;
        END;
        """;

    private static final String TEXT_STACK_SQL =
        "DECLARE listing VARCHAR2(32767) := ''; BEGIN SYS.DBMS_DEBUG.print_backtrace(listing); ? := listing; END;";

    static String breakpointListing(Connection debugger) throws SQLException {
        try (CallableStatement call = debugger.prepareCall(
            "DECLARE listing VARCHAR2(32767); BEGIN SYS.DBMS_DEBUG.SHOW_BREAKPOINTS(listing); ? := listing; END;"
        )) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.registerOutParameter(1, Types.VARCHAR);
            call.execute();
            String listing = call.getString(1);
            if (listing == null) throw new SQLException("SYS.DBMS_DEBUG.SHOW_BREAKPOINTS returned no text payload");
            return listing;
        }
    }

    static String initialize(Connection debuggee) throws SQLException {
        // OB resolves SYS-qualified package functions differently in SQL for an
        // ordinary schema. The anonymous PL/SQL form uses the actual SYS package.
        try (CallableStatement call = debuggee.prepareCall("BEGIN ? := SYS.DBMS_DEBUG.INITIALIZE(); END;")) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.registerOutParameter(1, Types.VARCHAR);
            call.execute();
            return call.getString(1);
        }
    }

    static int setTimeout(Connection debuggee, int seconds) throws SQLException {
        try (CallableStatement call = debuggee.prepareCall("BEGIN ? := SYS.DBMS_DEBUG.SET_TIMEOUT(?); END;")) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.registerOutParameter(1, Types.INTEGER);
            call.setInt(2, seconds);
            call.execute();
            return requiredInt(call, 1);
        }
    }

    static Stop synchronize(Connection debugger) throws SQLException {
        return stop(debugger, null);
    }

    static Stop continueWith(Connection debugger, int flags) throws SQLException {
        return stop(debugger, flags);
    }

    static Stop continueWith(Connection debugger, int flags, int timeoutSeconds) throws SQLException {
        return stop(debugger, flags, timeoutSeconds);
    }

    private static Stop stop(Connection debugger, Integer flags) throws SQLException {
        return stop(debugger, flags, CALL_TIMEOUT_SECONDS);
    }

    private static Stop stop(Connection debugger, Integer flags, int timeoutSeconds) throws SQLException {
        String operation = flags == null ? "SYS.DBMS_DEBUG.synchronize(r, 46)" : "SYS.DBMS_DEBUG.continue(r, ?, 46)";
        try (CallableStatement call = debugger.prepareCall(
            "DECLARE r SYS.DBMS_DEBUG.runtime_info; rc INTEGER; BEGIN rc := " + operation + "; " + STOP_FIELDS
        )) {
            call.setQueryTimeout(timeoutSeconds);
            int offset = flags == null ? 0 : 1;
            if (flags != null) call.setInt(1, flags);
            for (int index = 1; index <= 6; index++) call.registerOutParameter(offset + index, Types.INTEGER);
            call.registerOutParameter(offset + 7, Types.VARCHAR);
            call.registerOutParameter(offset + 8, Types.VARCHAR);
            call.registerOutParameter(offset + 9, Types.INTEGER);
            call.execute();
            int result = requiredInt(call, offset + 1);
            if (result != 0) return new Stop(result, null, false, null, null, null, null, null, null);
            return new Stop(result, nullableInt(call, offset + 2),
                requiredInt(call, offset + 3) != 0, nullableInt(call, offset + 4), nullableInt(call, offset + 5),
                nullableInt(call, offset + 6), call.getString(offset + 7), call.getString(offset + 8), nullableInt(call, offset + 9));
        }
    }

    static Stack stack(Connection debugger, Stop runtime, ReadError priorCollectionError) throws SQLException, IOException {
        if (!hasFramePositions(runtime)) return stackResult(runtime, List.of(), null, priorCollectionError, null);
        String json = null;
        String listing = null;
        ReadError structuredError = priorCollectionError;
        ReadError textError = null;
        if (structuredError == null) try (CallableStatement call = debugger.prepareCall(STACK_SQL)) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.registerOutParameter(1, Types.CLOB);
            call.execute();
            json = readClob(call.getClob(1));
        } catch (SQLException error) {
            if (!knownNonfatalStackError(error)) throw error;
            structuredError = readError(error);
        }
        try (CallableStatement call = debugger.prepareCall(TEXT_STACK_SQL)) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.registerOutParameter(1, Types.VARCHAR);
            call.execute();
            listing = call.getString(1);
        } catch (SQLException error) {
            if (!knownNonfatalStackError(error)) throw error;
            textError = readError(error);
        }
        return stackResult(runtime, json == null ? List.of() : parseIdentities(json), listing, structuredError, textError);
    }

    static Stack parseStack(String json, String listing, Stop runtime) {
        return stackResult(runtime, parseIdentities(json), listing, null, null);
    }

    private static boolean hasFramePositions(Stop runtime) {
        return runtime != null && runtime.result() == 0 && !runtime.terminated() && runtime.depth() != null && runtime.depth() > 0;
    }

    private static boolean knownNonfatalStackError(SQLException error) {
        // Connector/J wraps the observed OB collection allocator failure as a
        // connection exception, but HY001 is not a transport loss. Do not extend
        // this exception to timeouts or other, unverified SQL states.
        return !(error instanceof SQLTimeoutException) && "HY001".equals(error.getSQLState());
    }

    private static ReadError readError(SQLException error) {
        return new ReadError(error.getSQLState(), error.getErrorCode(), error.getMessage());
    }

    private static List<Frame> parseIdentities(String json) {
        if (json == null) throw new IllegalStateException("DBMS_DEBUG returned no structured backtrace");
        JsonElement payload = JsonParser.parseString(json);
        if (!payload.isJsonArray()) throw new IllegalStateException("Invalid structured backtrace");
        List<Frame> frames = new ArrayList<>();
        int depth = payload.getAsJsonArray().size();
        for (int index = 0; index < depth; index++) {
            JsonObject frame = payload.getAsJsonArray().get(index).getAsJsonObject();
            String name = text(frame.get("name"));
            String owner = text(frame.get("owner"));
            Integer namespace = frame.has("namespace") && !frame.get("namespace").isJsonNull()
                ? frame.get("namespace").getAsInt() : null;
            frames.add(new Frame(index, 0, name, owner, namespace, null, name, "native", "unknown"));
        }
        return List.copyOf(frames);
    }

    private static Stack stackResult(Stop runtime, List<Frame> identities, String listing,
                                     ReadError structuredError, ReadError textError) {
        if (!hasFramePositions(runtime)) {
            return new Stack(List.of(), listing, runtime == null ? null : runtime.depth(), "unavailable", false,
                "A confirmed paused runtime depth is required to locate stack frames", structuredError, textError);
        }
        int depth = runtime.depth();
        boolean identitiesMatch = identities.size() == depth
            && Objects.equals(identities.getFirst().program(), runtime.program())
            && Objects.equals(identities.getFirst().owner(), runtime.owner())
            && Objects.equals(identities.getFirst().namespace(), runtime.namespace());
        List<Integer> lines = identitiesMatch ? matchNativeNames(identities, listing) : List.of();
        boolean complete = identitiesMatch && lines.size() == depth
            && Objects.equals(lines.getFirst(), runtime.line()) && structuredError == null && textError == null;
        if (!complete) lines = List.of();
        List<Frame> frames = new ArrayList<>();
        for (int index = 0; index < depth; index++) {
            Frame identity = identitiesMatch ? identities.get(index) : null;
            String name = index == 0 ? runtime.program() : identity == null ? null : identity.program();
            String owner = index == 0 ? runtime.owner() : identity == null ? null : identity.owner();
            Integer namespace = index == 0 ? runtime.namespace() : identity == null ? null : identity.namespace();
            Integer line = index == 0 ? runtime.line() : lines.isEmpty() ? null : lines.get(index);
            // Positive native frames are ROOT=1 to LEAF=runtime depth, independently
            // of whether the optional program/source identity could be recovered.
            frames.add(new Frame(index, depth - index, name, owner, namespace, line, name,
                name == null || namespace == null ? "unresolved" : "native", "unknown"));
        }
        String message = complete ? null : "Stack identity or line information is incomplete; verified frame positions remain available";
        return new Stack(List.copyOf(frames), listing, depth, "verified", complete, message, structuredError, textError);
    }

    /** Match the whole listing against full native names, including embedded newlines. */
    private static List<Integer> matchNativeNames(List<Frame> identities, String listing) {
        if (listing == null) return List.of();
        StringBuilder expression = new StringBuilder("\\A(?:\\r?\\n)*");
        for (int index = 0; index < identities.size(); index++) {
            Frame frame = identities.get(index);
            if (frame.program() == null) return List.of();
            if (index > 0) expression.append("(?:\\r?\\n)+");
            expression.append("\\[Line[ \\t]*(\\d+)\\][ \\t](?:").append(Pattern.quote(frame.program()));
            if (frame.owner() != null) expression.append('|').append(Pattern.quote(frame.owner() + "." + frame.program()));
            expression.append(')');
        }
        expression.append("(?:\\r?\\n)*\\z");
        Matcher match = Pattern.compile(expression.toString()).matcher(listing);
        if (!match.matches()) return List.of();
        List<Integer> lines = new ArrayList<>();
        try {
            for (int index = 0; index < identities.size(); index++) lines.add(Integer.valueOf(match.group(index + 1)));
        } catch (NumberFormatException error) {
            return List.of();
        }
        return List.copyOf(lines);
    }

    static List<Value> variables(Connection debugger, Stack stack, int frameIndex) throws SQLException {
        int nativeFrame = stack.nativeFrame(frameIndex);
        try (CallableStatement call = debugger.prepareCall(
            "DECLARE vals VARCHAR2(32767); rc INTEGER; BEGIN rc := SYS.DBMS_DEBUG.get_values(vals, ?); ? := rc; ? := vals; END;"
        )) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.setInt(1, nativeFrame);
            call.registerOutParameter(2, Types.INTEGER);
            call.registerOutParameter(3, Types.VARCHAR);
            call.execute();
            int result = requiredInt(call, 2);
            if (result != 0) throw new IllegalStateException("SYS.DBMS_DEBUG.GET_VALUES failed (result=" + result + ")");
            return parseVariables(call.getString(3));
        }
    }

    static Value value(Connection debugger, Stack stack, int frameIndex, String name) throws SQLException {
        int nativeFrame = stack.nativeFrame(frameIndex);
        try (CallableStatement call = debugger.prepareCall(
            "DECLARE val VARCHAR2(32767); rc INTEGER; BEGIN rc := SYS.DBMS_DEBUG.get_value(?, ?, val); ? := rc; ? := val; END;"
        )) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.setString(1, name);
            call.setInt(2, nativeFrame);
            call.registerOutParameter(3, Types.INTEGER);
            call.registerOutParameter(4, Types.VARCHAR);
            call.execute();
            int result = requiredInt(call, 3);
            String raw = call.getString(4);
            if (result == 3) return new Value(name, null, "out_of_scope", null, raw, "Variable is not in this frame");
            if (result != 0) return new Value(name, null, "error", null, raw, "SYS.DBMS_DEBUG.GET_VALUE result=" + result);
            if (raw == null) return new Value(name, null, "unknown", null, null, "No native value payload");
            JsonElement parsed = JsonParser.parseString(raw);
            if (!parsed.isJsonPrimitive() || !parsed.getAsJsonPrimitive().isString()) {
                return new Value(name, null, "unknown", null, raw, "Unrecognized native value payload");
            }
            return decodeToken(name, parsed.getAsString(), raw);
        }
    }

    static List<Value> parseVariables(String json) {
        if (json == null) throw new IllegalStateException("SYS.DBMS_DEBUG.GET_VALUES returned no payload");
        JsonElement parsed = JsonParser.parseString(json);
        if (!parsed.isJsonObject()) throw new IllegalStateException("Invalid native variable listing");
        List<Value> result = new ArrayList<>();
        for (Map.Entry<String, JsonElement> entry : parsed.getAsJsonObject().entrySet()) {
            JsonElement token = entry.getValue();
            if (token.isJsonNull()) {
                result.add(new Value(entry.getKey(), null, "null", null, "null", null));
            } else if (token.isJsonPrimitive() && token.getAsJsonPrimitive().isString()) {
                result.add(decodeToken(entry.getKey(), token.getAsString(), token.toString()));
            } else {
                result.add(new Value(entry.getKey(), null, "unknown", null, token.toString(), "Unrecognized native value payload"));
            }
        }
        return List.copyOf(result);
    }

    private static Value decodeToken(String name, String token, String raw) {
        if ("Null".equals(token)) return new Value(name, null, "null", null, raw, null);
        if (token.length() >= 2 && token.startsWith("'") && token.endsWith("'")) {
            String value = token.substring(1, token.length() - 1);
            return new Value(name, null, value.isEmpty() ? "empty" : "value", value, raw, null);
        }
        // Type information is not present in OB's JSON listing. Preserve the native
        // token rather than inventing a database type from its printed appearance.
        return new Value(name, null, "value", token, raw, null);
    }

    static int[] setBreakpoint(Connection debugger, String owner, String program, int line, boolean anonymous)
        throws SQLException {
        return setBreakpoint(debugger, owner, program, line, anonymous, () -> { });
    }

    static PlDebugBreakpointInventory.Program currentBreakpointProgram(Connection debugger, int line) throws SQLException {
        try (CallableStatement call = debugger.prepareCall(
            "DECLARE r SYS.DBMS_DEBUG.runtime_info; rc INTEGER; BEGIN rc := SYS.DBMS_DEBUG.GET_RUNTIME_INFO(8, r); "
                + "? := rc; ? := r.program.owner; ? := r.program.name; ? := r.program.namespace; END;"
        )) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.registerOutParameter(1, Types.INTEGER);
            call.registerOutParameter(2, Types.VARCHAR);
            call.registerOutParameter(3, Types.VARCHAR);
            call.registerOutParameter(4, Types.INTEGER);
            call.execute();
            int result = requiredInt(call, 1);
            if (result != 0) throw new SQLException("The current native breakpoint program was not returned (result=" + result + ")");
            String owner = call.getString(2), name = call.getString(3);
            int namespace = requiredInt(call, 4);
            if (owner == null || name == null) throw new SQLException("The current native breakpoint program identity is incomplete");
            return new PlDebugBreakpointInventory.Program(owner, name, namespace, line);
        }
    }

    static int[] setBreakpoint(Connection debugger, String owner, String program, int line, boolean anonymous,
                               Runnable beforeDispatch) throws SQLException {
        String declarations = anonymous
            ? "rc := SYS.DBMS_DEBUG.get_runtime_info(8, r); p := r.program; "
            : "p.owner := ?; p.name := ?; p.namespace := SYS.DBMS_DEBUG.namespace_pkgspec_or_toplevel; ";
        String sql = "DECLARE p SYS.DBMS_DEBUG.program_info; r SYS.DBMS_DEBUG.runtime_info; bp INTEGER; rc INTEGER; BEGIN "
            + declarations + "rc := SYS.DBMS_DEBUG.set_breakpoint(p, ?, bp); ? := bp; ? := rc; END;";
        try (CallableStatement call = debugger.prepareCall(sql)) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            int offset = anonymous ? 0 : 2;
            if (!anonymous) { call.setString(1, owner); call.setString(2, program); }
            call.setInt(offset + 1, line);
            call.registerOutParameter(offset + 2, Types.INTEGER);
            call.registerOutParameter(offset + 3, Types.INTEGER);
            beforeDispatch.run();
            call.execute();
            int result = requiredInt(call, offset + 3);
            return new int[] {result == 0 ? requiredInt(call, offset + 2) : 0, result};
        }
    }

    static int[] setBreakpoint(Connection debugger, PlDebugBreakpointInventory.Program program,
                               Runnable beforeDispatch) throws SQLException {
        try (CallableStatement call = debugger.prepareCall(
            "DECLARE p SYS.DBMS_DEBUG.program_info; bp INTEGER; rc INTEGER; BEGIN "
                + "p.owner := ?; p.name := ?; p.namespace := ?; "
                + "rc := SYS.DBMS_DEBUG.set_breakpoint(p, ?, bp); ? := bp; ? := rc; END;"
        )) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.setString(1, program.owner());
            call.setString(2, program.name());
            call.setInt(3, program.namespace());
            call.setInt(4, program.line());
            call.registerOutParameter(5, Types.INTEGER);
            call.registerOutParameter(6, Types.INTEGER);
            beforeDispatch.run();
            call.execute();
            int result = requiredInt(call, 6);
            return new int[] {result == 0 ? requiredInt(call, 5) : 0, result};
        }
    }

    static int toggleBreakpoint(Connection debugger, int number, boolean enabled) throws SQLException {
        return toggleBreakpoint(debugger, number, enabled, () -> { });
    }

    static int toggleBreakpoint(Connection debugger, int number, boolean enabled, Runnable beforeDispatch) throws SQLException {
        return breakpointFunction(debugger, enabled ? "enable_breakpoint" : "disable_breakpoint", number, beforeDispatch);
    }

    static int deleteBreakpoint(Connection debugger, int number) throws SQLException {
        return deleteBreakpoint(debugger, number, () -> { });
    }

    static int deleteBreakpoint(Connection debugger, int number, Runnable beforeDispatch) throws SQLException {
        return breakpointFunction(debugger, "delete_breakpoint", number, beforeDispatch);
    }

    static boolean declares(Connection debugger, String method) throws SQLException {
        try (PreparedStatement statement = debugger.prepareStatement(
            "SELECT PROCEDURE_NAME FROM ALL_PROCEDURES WHERE OWNER = 'SYS' AND OBJECT_NAME = 'DBMS_DEBUG' AND PROCEDURE_NAME IN ('INITIALIZE', ?)"
        )) {
            statement.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            statement.setString(1, method);
            try (ResultSet result = statement.executeQuery()) {
                boolean baseVisible = false;
                boolean declared = false;
                while (result.next()) {
                    String name = result.getString(1);
                    baseVisible |= "INITIALIZE".equals(name);
                    declared |= method.equals(name);
                }
                if (!baseVisible) throw new SQLException("The DBMS_DEBUG declaration is not visible; capability is unknown");
                return declared;
            }
        }
    }

    static int setValue(Connection debugger, Stack stack, int frame, String assignment) throws SQLException {
        return setValue(debugger, stack, frame, assignment, () -> { });
    }

    static int setValue(Connection debugger, Stack stack, int frame, String assignment, Runnable beforeDispatch) throws SQLException {
        int nativeFrame = stack.nativeFrame(frame);
        if (!declares(debugger, "SET_VALUE")) {
            throw new UnsupportedOperationException("This DBMS_DEBUG package does not declare SET_VALUE");
        }
        try (CallableStatement call = debugger.prepareCall("BEGIN ? := SYS.DBMS_DEBUG.SET_VALUE(?, ?); END;")) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.registerOutParameter(1, Types.INTEGER);
            call.setInt(2, nativeFrame);
            call.setString(3, assignment);
            beforeDispatch.run();
            call.execute();
            return requiredInt(call, 1);
        }
    }

    private static int breakpointFunction(Connection debugger, String function, int number, Runnable beforeDispatch) throws SQLException {
        try (CallableStatement call = debugger.prepareCall("BEGIN ? := SYS.DBMS_DEBUG." + function + "(?); END;")) {
            call.setQueryTimeout(CALL_TIMEOUT_SECONDS);
            call.registerOutParameter(1, Types.INTEGER);
            call.setInt(2, number);
            beforeDispatch.run();
            call.execute();
            return requiredInt(call, 1);
        }
    }

    private static Integer nullableInt(CallableStatement call, int index) throws SQLException {
        int value = call.getInt(index);
        return call.wasNull() ? null : value;
    }

    private static int requiredInt(CallableStatement call, int index) throws SQLException {
        Integer value = nullableInt(call, index);
        if (value == null) throw new SQLException("A required native debugger result was not returned (OUT " + index + ")");
        return value;
    }

    private static String text(JsonElement element) {
        return element == null || element.isJsonNull() ? null : element.getAsString();
    }

    static String readClob(Clob value) throws SQLException, IOException {
        if (value == null) return null;
        try (Reader reader = value.getCharacterStream()) {
            StringBuilder text = new StringBuilder();
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) != -1) text.append(buffer, 0, count);
            return text.toString();
        } finally {
            value.free();
        }
    }

    private PlDebugNative() {}
}
