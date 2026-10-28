package com.dbx.agent.oceanbaseoracle;

import com.google.gson.Gson;
import org.junit.jupiter.api.Test;

import javax.sql.rowset.serial.SerialClob;
import java.io.IOException;
import java.io.Reader;
import java.sql.CallableStatement;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

/** Exercises production session stack/value reads; only the JDBC boundary is scripted. */
class PlDebugStackTest {
    @Test
    void keepsPositiveFrameAccessAfterTheKnownCollectionFailureWithoutRetryingIt() throws Exception {
        Fixture jdbc = new Fixture();
        jdbc.collectionError = new SQLException("native stack allocation failed", "HY001", 600);
        PlDebugSession session = jdbc.session(); session.stepIn();
        Object revision = session.snapshot().get("stopRevision");
        Map<String, Object> stack = session.stack();
        assertEquals("verified", stack.get("frameMappingState"));
        assertEquals(false, stack.get("complete"));
        assertNotNull(stack.get("structuredBacktraceError"));
        List<Map<String, Object>> frames = frames(stack);
        assertEquals(3, frames.size());
        assertEquals("LEAF", frames.getFirst().get("program"));
        assertEquals("native", frames.getFirst().get("identityState"));
        assertNull(frames.get(1).get("program"), "text alone must not become an object identity");
        assertEquals("unresolved", frames.get(1).get("identityState"));
        session.variables(2); session.variable("SENTINEL", 0);
        assertEquals(List.of(1, 3), jdbc.valueFrames);
        assertEquals(revision, session.snapshot().get("stopRevision"));
        session.stepOver(); session.stack(); session.variables(1);
        assertEquals(List.of(1, 3, 2), jdbc.valueFrames);
        assertEquals(1, jdbc.collectionReads, "the same physical controller must not retry its failed collection");
        assertEquals(2, jdbc.textReads);
        assertEquals("SCOTT", session.snapshot().get("programOwner"));
        assertEquals(1, session.snapshot().get("namespace"));
    }

    @Test
    void preservesNativeNamesIncludingWhitespaceNewlinesAndFakeFrameMarkers() throws Exception {
        Fixture jdbc = new Fixture();
        jdbc.name = " Mi.x\n[Line 999] Name ";
        PlDebugSession session = jdbc.session(); session.stepIn();
        Map<String, Object> stack = session.stack();
        assertEquals("verified", stack.get("frameMappingState"));
        assertEquals(true, stack.get("complete"));
        assertEquals(3, frames(stack).size());
        assertEquals(jdbc.name, frames(stack).getFirst().get("program"));
        assertEquals(8, frames(stack).getFirst().get("nativeLine"));
        assertEquals(jdbc.name, session.snapshot().get("program"));
        assertEquals("8", session.snapshot().get("nativeLine"));
        assertEquals("SCOTT", session.snapshot().get("programOwner"));
        session.variables(1);
        assertEquals(List.of(2), jdbc.valueFrames);
    }

    @Test
    void aContradictoryOrTruncatedListingCannotOverwriteTheNativeStop() throws Exception {
        Fixture jdbc = new Fixture();
        jdbc.listing = "[Line 999] EVIL\n[Line 13] MIDDLE\n[Line 16] __anonymous_block__";
        PlDebugSession session = jdbc.session(); session.stepIn();
        Map<String, Object> stack = session.stack();
        assertEquals(false, stack.get("complete"));
        assertEquals("LEAF", session.snapshot().get("program"));
        assertEquals("8", session.snapshot().get("nativeLine"));
        assertEquals(8, frames(stack).getFirst().get("nativeLine"));
        assertNull(frames(stack).get(1).get("nativeLine"), "mismatched listings must not be zipped with identities");
        session.variables(2);
        assertEquals(List.of(1), jdbc.valueFrames);
    }

    @Test
    void collectionDepthMismatchRetainsOnlyTheConfirmedCurrentIdentity() throws Exception {
        Fixture jdbc = new Fixture(); jdbc.structured = "[{\"name\":\"WRONG\",\"owner\":\"OTHER\",\"namespace\":2}]";
        PlDebugSession session = jdbc.session(); session.stepIn();
        Map<String, Object> stack = session.stack();
        assertEquals(false, stack.get("complete"));
        assertEquals(3, frames(stack).size());
        assertEquals("LEAF", frames(stack).getFirst().get("program"));
        assertNull(frames(stack).get(1).get("program"));
        session.variable("SENTINEL", 1);
        assertEquals(List.of(2), jdbc.valueFrames);
    }

    @Test
    void retainsRuntimeAndBothErrorsWhenTheKnownNonfatalTextReadAlsoFails() throws Exception {
        Fixture jdbc = new Fixture();
        jdbc.collectionError = new SQLException("allocation failure", "HY001", 600);
        jdbc.textError = new SQLException("text allocation failure", "HY001", 600);
        PlDebugSession session = jdbc.session(); session.stepIn();
        Map<String, Object> stack = session.stack();
        assertEquals(false, stack.get("complete"));
        assertNotNull(stack.get("structuredBacktraceError")); assertNotNull(stack.get("textBacktraceError"));
        assertEquals(3, frames(stack).size());
        assertEquals("LEAF", frames(stack).getFirst().get("program"));
        session.variables(2);
        assertEquals(List.of(1), jdbc.valueFrames);
    }

    @Test
    void doesNotAttemptFallbackOnTimeoutOrAnUnconfirmedConnection() throws Exception {
        for (SQLException error : List.of(new SQLTimeoutException("deadline", "HY001"),
            new SQLException("transport lost", "08006"), new SQLException("unclassified", "HY000"))) {
            Fixture jdbc = new Fixture(); jdbc.collectionError = error;
            PlDebugSession session = jdbc.session(); session.stepIn();
            assertSame(error, assertThrows(SQLException.class, session::stack));
            assertEquals(0, jdbc.textReads);
            if (error instanceof SQLTimeoutException || "08006".equals(error.getSQLState())) {
                assertEquals("unknown", session.snapshot().get("state"));
                assertThrows(IllegalStateException.class, () -> session.variables(0));
                assertTrue(jdbc.valueFrames.isEmpty());
            }
        }
    }

    @Test
    void aFailedClobTransferCannotLeaveTheOldPausedSnapshotUsable() throws Exception {
        Fixture jdbc = new Fixture(); jdbc.clobReadError = true;
        PlDebugSession session = jdbc.session(); session.stepIn();
        assertThrows(IOException.class, session::stack);
        assertEquals("unknown", session.snapshot().get("state"));
        assertEquals("original-native-id", session.snapshot().get("debugId"));
        assertThrows(IllegalStateException.class, () -> session.variable("SENTINEL", 0));
        assertEquals(0, jdbc.textReads);
        assertTrue(jdbc.clobFreed);
        assertTrue(jdbc.valueFrames.isEmpty());
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> frames(Map<String, Object> stack) {
        return (List<Map<String, Object>>) stack.get("frames");
    }

    private static final class Fixture {
        String name = "LEAF";
        String listing;
        String structured;
        SQLException collectionError;
        SQLException textError;
        boolean clobReadError;
        boolean clobFreed;
        int collectionReads;
        int textReads;
        final List<Integer> valueFrames = new ArrayList<>();

        PlDebugSession session() {
            Connection connection = proxy(Connection.class, (method, args) -> {
                if (!method.getName().equals("prepareCall")) return empty(method.getReturnType());
                return call((String) args[0]);
            });
            return PlDebugSession.withConnections("original-native-id", "SCOTT", null, connection, false);
        }

        CallableStatement call(String sql) {
            boolean control = sql.contains("DBMS_DEBUG.continue");
            boolean collection = sql.contains("backtrace_table");
            boolean text = !collection && sql.toLowerCase().contains("print_backtrace");
            boolean values = sql.contains("get_values");
            boolean value = sql.contains("get_value(");
            Map<Integer, Object> in = new LinkedHashMap<>();
            return proxy(CallableStatement.class, (method, args) -> {
                switch (method.getName()) {
                    case "setInt", "setString": in.put((int) args[0], args[1]); return null;
                    case "execute":
                        if (collection) { collectionReads++; if (collectionError != null) throw collectionError; }
                        if (text) { textReads++; if (textError != null) throw textError; }
                        if (values) valueFrames.add((int) in.get(1));
                        if (value) valueFrames.add((int) in.get(2));
                        return false;
                    case "getInt":
                        if (!control) return 0;
                        return switch ((int) args[0]) {
                            case 3 -> 8; case 5 -> 9; case 6 -> 3; case 10 -> 1; default -> 0;
                        };
                    case "getString":
                        if (control) return (int) args[0] == 8 ? name : "SCOTT";
                        if (values) return "{\"SENTINEL\":\"101\"}";
                        if (value) return "\"300\"";
                        return listing == null ? "\n[Line 8] " + name + "\n[Line 13] MIDDLE\n[Line 16] __anonymous_block__\n" : listing;
                    case "getClob":
                        if (clobReadError) return proxy(Clob.class, (member, arguments) -> switch (member.getName()) {
                            case "getCharacterStream" -> new Reader() {
                                public int read(char[] buffer, int offset, int length) throws IOException { throw new IOException("injected CLOB transfer loss"); }
                                public void close() {}
                            };
                            case "free" -> { clobFreed = true; yield null; }
                            default -> empty(member.getReturnType());
                        });
                        String payload = structured == null ? new Gson().toJson(List.of(
                            Map.of("name", name, "owner", "SCOTT", "namespace", 1),
                            Map.of("name", "MIDDLE", "owner", "SCOTT", "namespace", 1),
                            Map.of("name", "__anonymous_block__", "owner", "SCOTT", "namespace", 1))) : structured;
                        return new SerialClob(payload.toCharArray());
                    default: return empty(method.getReturnType());
                }
            });
        }
    }
}
