package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.lang.reflect.Proxy;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

class OceanBaseLobValuesTest {
    @Test
    void idleAndAbsoluteExpiryFreeLocatorsAndRestorePayloadCapacity() throws Exception {
        OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> chunk("x".repeat(1000), offset, limit), ignored -> 40L * 1024 * 1024);
        for (String fieldName : List.of("accessed", "created")) {
            Fixture fixture = new Fixture();
            var preview = (OceanBaseLobValues.Preview) values.preview(fixture.resultSet, 1, Types.CLOB, "CLOB");
            var entriesField = OceanBaseLobValues.class.getDeclaredField("entries");
            entriesField.setAccessible(true);
            Object entry = ((java.util.Map<?, ?>) entriesField.get(values)).get(preview.ref());
            var ageField = entry.getClass().getDeclaredField(fieldName);
            ageField.setAccessible(true);
            ageField.setLong(entry, System.currentTimeMillis() - (fieldName.equals("accessed") ? 5 : 30) * 60_000L - 1);
            assertEquals("expired", values.fetch(fixture.connection, preview.ref(), 0, 1).status());
            assertTrue(fixture.freed.get());
            assertFalse(values.hasValues());
        }
    }

    @Test
    void nclobRetainsTheExistingCompleteReaderWithoutCapturingAPreview() throws Exception {
        Fixture fixture = new Fixture();
        OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> { fail("NCLOB must use its existing complete reader"); return null; });
        assertNull(values.preview(fixture.resultSet, 1, Types.NCLOB, "NCLOB"));
        assertFalse(values.hasValues());
        assertFalse(fixture.freed.get());
    }
    @Test
    void refusesNewLocatorsWhenRetainedPayloadBudgetIsFullAndRestoresCapacityOnRelease() throws Exception {
        OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> chunk("x".repeat(1000), offset, limit), ignored -> 40L * 1024 * 1024);
        Fixture first = new Fixture();
        var preview = (OceanBaseLobValues.Preview) values.preview(first.resultSet, 1, Types.CLOB, "CLOB");
        Fixture second = new Fixture();
        assertThrows(java.sql.SQLException.class, () -> values.preview(second.resultSet, 1, Types.CLOB, "CLOB"));
        assertTrue(second.freed.get());
        assertTrue(values.release(preview.ref()));
        Fixture third = new Fixture();
        assertNotNull(((OceanBaseLobValues.Preview) values.preview(third.resultSet, 1, Types.CLOB, "CLOB")).ref());
        values.clear();
        Fixture fourth = new Fixture();
        assertNotNull(((OceanBaseLobValues.Preview) values.preview(fourth.resultSet, 1, Types.CLOB, "CLOB")).ref());
        values.clear();
    }
    @Test
    void boundsPreviewAndReadsTheSameCapturedLocatorWithoutMaterializingItsStreams() throws Exception {
        String original = "中文😀".repeat(1000);
        List<Integer> amounts = new ArrayList<>();
        Fixture fixture = new Fixture();
        OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> {
            assertSame(fixture.connection, connection);
            assertSame(fixture.clob, locator);
            amounts.add(limit);
            return chunk(original, offset, limit);
        });
        var preview = (OceanBaseLobValues.Preview) values.preview(fixture.resultSet, 1, Types.CLOB, "CLOB");
        assertEquals(256, preview.text().codePointCount(0, preview.text().length()));
        assertFalse(Character.isHighSurrogate(preview.text().charAt(preview.text().length() - 1)));
        assertNotNull(preview.ref());
        assertEquals(List.of(257), amounts);
        StringBuilder complete = new StringBuilder();
        long offset = 0;
        while (true) {
            var next = values.fetch(fixture.connection, preview.ref(), offset, 31);
            complete.append(next.data());
            if (next.eof()) break;
            assertTrue(next.next_offset() > offset);
            offset = next.next_offset();
        }
        assertEquals(original, complete.toString());
        assertFalse(fixture.freed.get());
        assertTrue(values.release(preview.ref()));
        assertTrue(fixture.freed.get());
        assertEquals("expired", values.fetch(fixture.connection, preview.ref(), 0, 31).status());
    }

    @Test
    void distinguishesNullEmptyShortAndDeferredValues() throws Exception {
        for (String text : List.of("", "短😀值", "x".repeat(257))) {
            Fixture fixture = new Fixture();
            OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> chunk(text, offset, limit));
            var preview = (OceanBaseLobValues.Preview) values.preview(fixture.resultSet, 1, Types.CLOB, "CLOB");
            // A value exactly filling the look-ahead chunk remains deferred until EOF is known.
            if (text.length() < 257) {
                assertEquals(text, preview.text());
                assertNull(preview.ref());
                assertTrue(fixture.freed.get());
            } else assertNotNull(preview.ref());
            values.clear();
        }
        Fixture fixture = new Fixture();
        fixture.nullValue = true;
        OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> { fail("NULL must not be read"); return null; });
        var preview = (OceanBaseLobValues.Preview) values.preview(fixture.resultSet, 1, Types.CLOB, "CLOB");
        assertNull(preview.text());
        assertNull(preview.ref());
    }

    @Test
    void rejectsWrongConnectionAndInvalidChunkBoundsAndInvalidatesOnClear() throws Exception {
        Fixture fixture = new Fixture();
        OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> chunk("原值".repeat(1000), offset, limit));
        var preview = (OceanBaseLobValues.Preview) values.preview(fixture.resultSet, 1, Types.CLOB, "CLOB");
        assertThrows(IllegalArgumentException.class, () -> values.fetch(fixture.connection, preview.ref(), -1, 1));
        assertThrows(IllegalArgumentException.class, () -> values.fetch(fixture.connection, preview.ref(), 0, 4097));
        assertEquals("expired", values.fetch(new Fixture().connection, preview.ref(), 0, 1).status());
        Fixture nextFixture = new Fixture();
        var nextPreview = (OceanBaseLobValues.Preview) values.preview(nextFixture.resultSet, 1, Types.CLOB, "CLOB");
        values.clear();
        assertEquals("expired", values.fetch(nextFixture.connection, nextPreview.ref(), 0, 1).status());
        assertTrue(fixture.freed.get());
        assertTrue(nextFixture.freed.get());
    }

    @Test
    void markerCollisionFallsBackBeforeReadingOrTruncatingAndRefsStayOutOfValues() throws Exception {
        Fixture fixture = new Fixture();
        fixture.label = "__dbx_large_value_bytes_c_0";
        OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> { fail("Collision must keep complete ordinary read"); return null; });
        assertNull(values.preview(fixture.resultSet, 1, Types.CLOB, "CLOB"));
        var marked = OceanBaseLobValues.mark(List.of("ID", "Payload"), List.of("NUMBER", "CLOB"),
            List.of(List.of(1, new OceanBaseLobValues.Preview("原始😀", "opaque-ref")),
                java.util.Arrays.asList(2, new OceanBaseLobValues.Preview(null, null))));
        assertEquals(List.of("ID", "Payload", "__DBX_LARGE_VALUE_BYTES_C_1"), marked.columns());
        assertEquals("原始😀", marked.rows().get(0).get(1));
        assertEquals("D:1:unknown:opaque-ref", marked.rows().get(0).get(2));
        assertNull(marked.rows().get(1).get(1));
        assertNull(marked.rows().get(1).get(2));
    }

    private static OceanBaseLobValues.Chunk chunk(String text, long offset, int limit) {
        int count = text.codePointCount(0, text.length());
        int start = Math.min(count, (int) offset);
        int end = Math.min(count, start + limit);
        String data = text.substring(text.offsetByCodePoints(0, start), text.offsetByCodePoints(0, end));
        return new OceanBaseLobValues.Chunk("ok", data, offset + end - start, end - start < limit, "text");
    }

    private static final class Fixture {
        final AtomicBoolean freed = new AtomicBoolean();
        boolean nullValue;
        String label = "PAYLOAD";
        final Connection connection = proxy(Connection.class, (method, args) -> method.equals("isClosed") ? false : null);
        final Clob clob = proxy(Clob.class, (method, args) -> {
            if (method.equals("free")) { freed.set(true); return null; }
            throw new AssertionError("Unexpected full LOB API: " + method);
        });
        final Statement statement = proxy(Statement.class, (method, args) -> method.equals("getConnection") ? connection : null);
        final ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (method, args) -> {
            if (method.equals("getColumnCount")) return 1;
            if (method.equals("getColumnLabel")) return label;
            return null;
        });
        final ResultSet resultSet = proxy(ResultSet.class, (method, args) -> {
            if (method.equals("getMetaData")) return metadata;
            if (method.equals("getStatement")) return statement;
            if (method.equals("getClob")) return nullValue ? null : clob;
            if (method.equals("wasNull")) return nullValue;
            throw new AssertionError("Unexpected result read: " + method);
        });
    }

    @FunctionalInterface interface Handler { Object call(String method, Object[] args) throws Throwable; }
    private static <T> T proxy(Class<T> type, Handler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
            (object, method, args) -> handler.call(method.getName(), args)));
    }
}
