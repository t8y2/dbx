package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugSourceTest {
    @Test
    void compileSourceBudgetsDoNotRestrictTheExistingReaderOrRejectInvalidObjects() throws Exception {
        Object[] invalid = {"42", "INVALID", "same", 1, "中😀\n"};
        var ordinary = PlDebugSource.load(connection(new ArrayList<>(), invalid), "S", "P", "PROCEDURE", "42");
        assertEquals("INVALID", ordinary.status());
        assertEquals("candidate", ordinary.state());
        long deadline = System.nanoTime() + 1_000_000_000L;
        assertThrows(SQLException.class, () -> PlDebugSource.load(connection(new ArrayList<>(), invalid),
            "S", "P", "PROCEDURE", "42", deadline, 7, 1));
        assertEquals(ordinary, PlDebugSource.load(connection(new ArrayList<>(), invalid),
            "S", "P", "PROCEDURE", "42", deadline, 8, 1));
        assertThrows(SQLException.class, () -> PlDebugSource.load(connection(new ArrayList<>(), row(1, "one\ntwo\n")),
            "S", "P", "PROCEDURE", "42", deadline, 100, 1));
        assertThrows(java.sql.SQLTimeoutException.class, () -> PlDebugSource.load(connection(new ArrayList<>(), invalid),
            "S", "P", "PROCEDURE", "42", System.nanoTime() - 1, 8, 1));
    }

    @Test
    void packageContainerAndSelectedNativeMemberHaveSeparateIdentities() {
        var version = new PlDebugSource.Version("SCOTT", "P_TEST", "PACKAGE BODY", "43", "VALID", "same", "candidate",
            List.of(new PlDebugSource.Line(1, "PACKAGE BODY P_TEST IS\n"), new PlDebugSource.Line(2, "BEGIN NULL; END;\n")));
        var target = new PlDebugTarget.Candidate("SCOTT", "RUN", "P_TEST", "42", 1, "VALID", List.of());
        for (String program : List.of("P_TEST.RUN", "P_TEST.__init__")) {
            var frame = new PlDebugNative.Frame(0, 2, program, "SCOTT", 2, 2, "", "native", "unavailable");
            var ref = PlDebugSource.reference(version, frame, "target", 7, target);
            assertNotNull(ref);
            assertEquals("P_TEST", ref.name());
            assertEquals("43", ref.objectId());
            assertEquals(0, ref.lineOffset());
        }
        for (var frame : List.of(
            new PlDebugNative.Frame(0, 2, "P_TEST.OTHER", "SCOTT", 2, 2, "", "native", "unavailable"),
            new PlDebugNative.Frame(0, 2, "P_TEST.RUN", "OTHER", 2, 2, "", "native", "unavailable"),
            new PlDebugNative.Frame(0, 2, "P_TEST.RUN", "SCOTT", 1, 2, "", "native", "unavailable"),
            new PlDebugNative.Frame(0, 2, "P_TEST.RUN", "SCOTT", 2, 3, "", "native", "unavailable"))) {
            assertNull(PlDebugSource.reference(version, frame, "target", 7, target));
        }
        var dottedTarget = new PlDebugTarget.Candidate("SCOTT", "RUN", "P.TEST", "42", 1, "VALID", List.of());
        var dottedVersion = new PlDebugSource.Version("SCOTT", "P.TEST", "PACKAGE BODY", "43", "VALID", "same", "candidate", version.lines());
        assertNull(PlDebugSource.reference(dottedVersion,
            new PlDebugNative.Frame(0, 2, "P.TEST.RUN", "SCOTT", 2, 2, "", "native", "unavailable"), "target", 7, dottedTarget));
    }

    @Test
    void bindsOnlyExactNativeFrameIdentitiesAndLineRanges() {
        var version = new PlDebugSource.Version("Mixed.Owner", "a.b", "PROCEDURE", "42", "VALID", "same", "candidate",
            List.of(new PlDebugSource.Line(1, "procedure \"a.b\" is\n"), new PlDebugSource.Line(2, "begin null; end;\n")));
        var frame = new PlDebugNative.Frame(0, 1, "a.b", "Mixed.Owner", 1, 2, "untrusted text", "native", "unavailable");
        var ref = PlDebugSource.reference(version, frame, "session:target", 7);
        assertNotNull(ref);
        assertEquals(7, ref.stopRevision());
        assertEquals(version.text(), ref.source());
        for (var invalid : List.of(
            new PlDebugNative.Frame(0, 1, "A.B", "Mixed.Owner", 1, 2, "", "native", "unavailable"),
            new PlDebugNative.Frame(0, 1, "a.b", "Mixed.Owner", 2, 2, "", "native", "unavailable"),
            new PlDebugNative.Frame(0, 1, "a.b", "Mixed.Owner", 1, 3, "", "native", "unavailable"),
            new PlDebugNative.Frame(0, 1, "a.b", "Mixed.Owner", 1, 2, "", "partial", "unavailable"))) {
            assertNull(PlDebugSource.reference(version, invalid, "session:target", 7));
        }
    }

    @Test
    void readsExactIdentifiersAndComparesFullTextRatherThanOnlyDdlTime() throws Exception {
        List<Object> binds = new ArrayList<>();
        var before = PlDebugSource.load(connection(binds, row(1, "procedure \"a.b\" is\n"), row(2, "begin null; end;\n")),
            "Mixed.Owner", "a.b", "PROCEDURE", "42");
        assertEquals(List.of("Mixed.Owner", "a.b", "PROCEDURE"), binds);
        assertEquals("candidate", before.state());
        assertEquals("procedure \"a.b\" is\nbegin null; end;\n", before.text());
        assertEquals(before, PlDebugSource.load(connection(new ArrayList<>(), row(1, before.text())),
            "Mixed.Owner", "a.b", "PROCEDURE", "42"));
        var after = PlDebugSource.load(connection(new ArrayList<>(), row(1, "procedure \"a.b\" is\n"), row(2, "begin NULL; end;\n")),
            "Mixed.Owner", "a.b", "PROCEDURE", "42");
        assertEquals(before.lastDdl(), after.lastDdl());
        assertNotEquals(before, after);
        assertThrows(UnsupportedOperationException.class, () -> before.lines().clear());
    }

    @Test
    void distinguishesInvisibleObjectAndUnavailableSourceFromInvalidRows() throws Exception {
        assertEquals("not_visible", PlDebugSource.load(connection(new ArrayList<>()), "S", "P", "PROCEDURE", "42").state());
        Object[] absent = {"42", "VALID", "2026-10-24 01:00:00", null, null};
        assertEquals("source_unavailable", PlDebugSource.load(connection(new ArrayList<>(), absent), "S", "P", "PROCEDURE", "42").state());
        for (Object[][] rows : new Object[][][] {
            {row(2, "gap")}, {row(1, "one"), row(1, "duplicate")}, {row(1, null)},
            {absent, row(1, "mixed")}, {{"43", "VALID", "same", 1, "changed object"}},
            {row(1, "one"), {"42", "INVALID", "2026-10-24 01:00:00", 2, "conflict"}}
        }) {
            assertThrows(SQLException.class, () -> PlDebugSource.load(connection(new ArrayList<>(), rows), "S", "P", "PROCEDURE", "42"));
        }
    }

    private static Object[] row(int line, String text) {
        return new Object[] {"42", "VALID", "2026-10-24 01:00:00", line, text};
    }

    private static Connection connection(List<Object> binds, Object[]... rows) {
        int[] index = {-1};
        boolean[] wasNull = {false};
        ResultSet result = (ResultSet) Proxy.newProxyInstance(PlDebugSourceTest.class.getClassLoader(), new Class<?>[] {ResultSet.class}, (p, m, a) -> {
            return switch (m.getName()) {
                case "next" -> ++index[0] < rows.length;
                case "getString", "getInt" -> {
                    Object value = rows[index[0]][(int) a[0] - 1];
                    wasNull[0] = value == null;
                    yield m.getName().equals("getInt") ? value == null ? 0 : ((Number) value).intValue() : value;
                }
                case "wasNull" -> wasNull[0];
                case "close" -> null;
                default -> throw new AssertionError(m.getName());
            };
        });
        PreparedStatement statement = (PreparedStatement) Proxy.newProxyInstance(PlDebugSourceTest.class.getClassLoader(), new Class<?>[] {PreparedStatement.class}, (p, m, a) -> {
            return switch (m.getName()) {
                case "setString" -> { binds.add(a[1]); yield null; }
                case "setQueryTimeout", "close" -> null;
                case "executeQuery" -> result;
                default -> throw new AssertionError(m.getName());
            };
        });
        return (Connection) Proxy.newProxyInstance(PlDebugSourceTest.class.getClassLoader(), new Class<?>[] {Connection.class}, (p, m, a) -> {
            if (m.getName().equals("prepareStatement")) return statement;
            throw new AssertionError(m.getName());
        });
    }
}
