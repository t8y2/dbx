package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.lang.reflect.Proxy;
import java.sql.Blob;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.sql.Types;
import java.util.HexFormat;
import java.util.List;
import java.util.Random;
import java.util.concurrent.atomic.AtomicBoolean;

class OceanBaseBlobValuesTest {
    @Test
    void preservesAllByteValuesAndLargeRandomContentAcrossBoundedChunks() throws Exception {
        byte[] original = new byte[128 * 1024 + 7];
        new Random(11438).nextBytes(original);
        for (int index = 0; index < 256; index++) original[index] = (byte) index;
        Fixture fixture = new Fixture();
        OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> {
            assertSame(fixture.blob, locator);
            assertTrue(limit <= 4096);
            int start = (int) Math.min(original.length, offset);
            int end = Math.min(original.length, start + limit);
            return new OceanBaseLobValues.Chunk("ok", HexFormat.of().formatHex(original, start, end),
                offset + end - start, end - start < limit, "binary");
        });
        var preview = (OceanBaseLobValues.Preview) values.preview(fixture.resultSet, 1, Types.BLOB, "BLOB");
        assertEquals("0x" + HexFormat.of().formatHex(original, 0, 256), preview.text());
        assertEquals("blob", preview.kind());
        StringBuilder complete = new StringBuilder();
        long offset = 0;
        while (true) {
            var chunk = values.fetch(fixture.connection, preview.ref(), offset, 4096);
            assertEquals("binary", chunk.value_kind());
            complete.append(chunk.data());
            if (chunk.eof()) break;
            offset = chunk.next_offset();
        }
        byte[] fetched = HexFormat.of().parseHex(complete.toString());
        assertArrayEquals(original, fetched);
        assertArrayEquals(java.security.MessageDigest.getInstance("SHA-256").digest(original),
            java.security.MessageDigest.getInstance("SHA-256").digest(fetched));
        var marked = OceanBaseLobValues.mark(List.of("PAYLOAD"), List.of("BLOB"), List.of(List.of(preview)));
        assertEquals("__DBX_LARGE_VALUE_BYTES_L_0", marked.columns().get(1));
        assertEquals(preview.text(), marked.rows().get(0).get(0));
        values.clear();
        assertTrue(fixture.freed.get());
        assertEquals("expired", values.fetch(fixture.connection, preview.ref(), 0, 4096).status());
    }

    @Test
    void distinguishesEmptyBinaryZeroByteAndNullWithoutDeferredRefs() throws Exception {
        for (byte[] bytes : List.of(new byte[0], new byte[]{0}, new byte[]{0, (byte) 255})) {
            Fixture fixture = new Fixture();
            OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) ->
                new OceanBaseLobValues.Chunk("ok", HexFormat.of().formatHex(bytes), bytes.length, true, "binary"));
            var preview = (OceanBaseLobValues.Preview) values.preview(fixture.resultSet, 1, Types.BLOB, "BLOB");
            assertEquals("0x" + HexFormat.of().formatHex(bytes), preview.text());
            assertNull(preview.ref());
            assertTrue(fixture.freed.get());
        }
        Fixture fixture = new Fixture();
        fixture.nullValue = true;
        OceanBaseLobValues values = new OceanBaseLobValues((connection, locator, offset, limit) -> { fail("NULL must not be read"); return null; });
        var preview = (OceanBaseLobValues.Preview) values.preview(fixture.resultSet, 1, Types.BLOB, "BLOB");
        assertNull(preview.text());
        assertNull(preview.ref());
    }

    private static final class Fixture {
        final AtomicBoolean freed = new AtomicBoolean();
        boolean nullValue;
        final Connection connection = proxy(Connection.class, (method, args) -> method.equals("isClosed") ? false : null);
        final Blob blob = proxy(Blob.class, (method, args) -> {
            if (method.equals("free")) { freed.set(true); return null; }
            throw new AssertionError("Unexpected full BLOB API: " + method);
        });
        final Statement statement = proxy(Statement.class, (method, args) -> method.equals("getConnection") ? connection : null);
        final ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (method, args) -> {
            if (method.equals("getColumnCount")) return 1;
            if (method.equals("getColumnLabel")) return "PAYLOAD";
            return null;
        });
        final ResultSet resultSet = proxy(ResultSet.class, (method, args) -> {
            if (method.equals("getMetaData")) return metadata;
            if (method.equals("getStatement")) return statement;
            if (method.equals("getBlob")) return nullValue ? null : blob;
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
