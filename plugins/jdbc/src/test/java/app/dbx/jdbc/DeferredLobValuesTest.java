package app.dbx.jdbc;

import org.junit.jupiter.api.Test;
import java.lang.reflect.Proxy;
import java.sql.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.rowset.serial.SerialBlob;
import javax.sql.rowset.serial.SerialClob;
import static org.junit.jupiter.api.Assertions.*;

final class DeferredLobValuesTest {
    public interface InternalStatement { void setInternal(); }
    @Test
    void deferredTextByteSizeIsUnknownWithoutReadingTheWholeValue() throws Exception {
        for (String value : new String[]{"a".repeat(300), "中".repeat(300), "🙂".repeat(300)}) {
            var registry = new DeferredLobValues(CallableStatement::execute, () -> false);
            var connection = connection();
            var preview = registry.capture(connection, new SerialClob(value.toCharArray()), false);
            assertNotNull(preview.ref());
            assertEquals(0, preview.originalBytes());
            var result = new StringBuilder();
            long offset = 0;
            while (true) {
                var chunk = registry.fetch(connection, preview.ref(), offset, 113);
                result.append(chunk.data());
                offset = chunk.next_offset();
                if (chunk.eof()) break;
            }
            assertEquals(value, result.toString());
            registry.clear();
        }
    }

    @Test
    void nullAndEmptyValuesStayInline() throws Exception {
        var registry = new DeferredLobValues(CallableStatement::execute, () -> false);
        var connection = connection();
        assertNull(registry.capture(connection, null, false).text());
        assertEquals("", registry.capture(connection, new SerialClob(new char[0]), false).text());
        assertEquals("0x", registry.capture(connection, new SerialBlob(new byte[0]), false).text());
        assertTrue(registry.checkpoint().isEmpty());
    }

    @Test
    void binaryChunksKeepOriginalBytesAndReleaseIsIdempotent() throws Exception {
        var registry = new DeferredLobValues(CallableStatement::execute, () -> false);
        var connection = connection();
        byte[] bytes = new byte[1025];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) i;
        var preview = registry.capture(connection, new SerialBlob(bytes), false);
        assertEquals("0x" + HexFormat.of().withUpperCase().formatHex(Arrays.copyOf(bytes, 256)), preview.text());
        assertEquals(bytes.length, preview.originalBytes());
        StringBuilder result = new StringBuilder();
        long offset = 0;
        boolean eof;
        do {
            var chunk = registry.fetch(connection, preview.ref(), offset, 113);
            assertEquals("binary", chunk.value_kind());
            result.append(chunk.data()); offset = chunk.next_offset(); eof = chunk.eof();
        } while (!eof);
        assertEquals(HexFormat.of().withUpperCase().formatHex(bytes), result.toString());
        assertTrue(registry.release(preview.ref()));
        assertFalse(registry.release(preview.ref()));
        assertEquals("expired", registry.fetch(connection, preview.ref(), 0, 1).status());
    }

    @Test
    void unicodeSingleCodePointChunksAndRewindPreserveTheValue() throws Exception {
        var registry = new DeferredLobValues(CallableStatement::execute, () -> false);
        var connection = connection();
        String value = "中🙂a".repeat(100);
        var preview = registry.capture(connection, new SerialClob(value.toCharArray()), false);
        assertEquals(256, preview.text().codePointCount(0, preview.text().length()));
        StringBuilder result = new StringBuilder();
        long offset = 0;
        do {
            var chunk = registry.fetch(connection, preview.ref(), offset, 1);
            result.append(chunk.data()); offset = chunk.next_offset();
            if (chunk.eof()) break;
        } while (true);
        assertEquals(value, result.toString());
        assertEquals("🙂", registry.fetch(connection, preview.ref(), 1, 1).data());
        registry.clear();
        assertTrue(registry.checkpoint().isEmpty());
    }

    @Test
    void cancellationAndFailedChunksReleaseOnlyTheirReference() throws Exception {
        AtomicBoolean cancelled = new AtomicBoolean();
        var registry = new DeferredLobValues(CallableStatement::execute, cancelled::get);
        var connection = connection();
        var first = registry.capture(connection, new SerialBlob(new byte[300]), false);
        var checkpoint = registry.checkpoint();
        var second = registry.capture(connection, new SerialBlob(new byte[300]), false);
        registry.releaseSince(checkpoint);
        assertEquals("expired", registry.fetch(connection, second.ref(), 0, 10).status());
        assertThrows(IllegalArgumentException.class, () -> registry.fetch(connection, first.ref(), -1, 10));
        assertEquals(checkpoint, registry.checkpoint());
        cancelled.set(true);
        assertThrows(SQLException.class, () -> registry.fetch(connection, first.ref(), 0, 10));
        assertTrue(registry.checkpoint().isEmpty());
    }

    @Test
    void cancellationAfterCallableExecutionDiscardsOnlyTheInterruptedLocator() throws Exception {
        AtomicBoolean cancelled = new AtomicBoolean();
        AtomicBoolean cancelAfterRead = new AtomicBoolean();
        var registry = new DeferredLobValues(call -> {
            call.execute();
            if (cancelAfterRead.get()) cancelled.set(true);
        }, cancelled::get);
        var connection = connection();
        var interrupted = registry.capture(connection, new SerialBlob(new byte[300]), false);
        var survivor = registry.capture(connection, new SerialBlob(new byte[300]), false);
        cancelAfterRead.set(true);
        assertThrows(SQLException.class, () -> registry.fetch(connection, interrupted.ref(), 0, 10));
        cancelled.set(false);
        cancelAfterRead.set(false);
        assertEquals("expired", registry.fetch(connection, interrupted.ref(), 0, 10).status());
        assertEquals("ok", registry.fetch(connection, survivor.ref(), 0, 10).status());
        registry.clear();
    }

    @Test
    void readAheadIsSharedButDeliveryRewindAndCancellationKeepTheirOwnBoundaries() throws Exception {
        var calls = new AtomicInteger();
        var cancelled = new AtomicBoolean();
        var registry = new DeferredLobValues(CallableStatement::execute, cancelled::get);
        var connection = connection(calls::incrementAndGet, () -> {});
        String value = "x".repeat(4095) + "🙂中" + "y".repeat(300000);
        var first = registry.capture(connection, new SerialClob(value.toCharArray()), false);
        var second = registry.capture(connection, new SerialBlob(new byte[400000]), false);
        calls.set(0);
        assertEquals("x", registry.fetch(connection, first.ref(), 0, 1).data());
        assertEquals(1, calls.get());
        assertEquals("🙂", registry.fetch(connection, first.ref(), 4095, 1).data());
        assertEquals("中", registry.fetch(connection, first.ref(), 4096, 1).data());
        assertEquals("x", registry.fetch(connection, first.ref(), 0, 1).data());
        assertEquals(1, calls.get());
        assertEquals("00", registry.fetch(connection, second.ref(), 0, 1).data());
        assertEquals(2, calls.get());
        assertEquals("x", registry.fetch(connection, first.ref(), 1, 1).data());
        assertEquals(3, calls.get());
        cancelled.set(true);
        assertThrows(SQLException.class, () -> registry.fetch(connection, first.ref(), 2, 1));
        cancelled.set(false);
        assertEquals("expired", registry.fetch(connection, first.ref(), 2, 1).status());
        assertEquals("ok", registry.fetch(connection, second.ref(), 1, 1).status());
        registry.clear();
    }

    @Test
    void unicodeReadAheadCrossesItsWindowBoundaryAndEndsAtTheOriginalLength() throws Exception {
        var registry = new DeferredLobValues(CallableStatement::execute, () -> false);
        var connection = connection();
        String original = "a".repeat(262143) + "🙂中" + "z".repeat(4200) + "🙂";
        var preview = registry.capture(connection, new SerialClob(original.toCharArray()), false);
        var actual = new StringBuilder();
        long offset = 0;
        while (true) {
            var chunk = registry.fetch(connection, preview.ref(), offset, 4096);
            assertEquals(chunk.data().codePointCount(0, chunk.data().length()), chunk.next_offset() - offset);
            actual.append(chunk.data());
            offset = chunk.next_offset();
            if (chunk.eof()) break;
        }
        assertEquals(original, actual.toString());
        var end = registry.fetch(connection, preview.ref(), offset, 1);
        assertTrue(end.eof());
        assertEquals("", end.data());
        assertEquals("🙂", registry.fetch(connection, preview.ref(), 262143, 1).data());
        registry.clear();
    }

    @Test
    void invalidLateOutSlotDiscardsTheWholeWindowAndOnlyItsReference() throws Exception {
        var corrupt = new AtomicBoolean();
        var connection = connection(() -> {}, () -> {}, args -> {
            if (corrupt.get() && args.containsKey(131)) args.put(129, 4097);
        });
        var registry = new DeferredLobValues(CallableStatement::execute, () -> false);
        var first = registry.capture(connection, new SerialBlob(new byte[400000]), false);
        var survivor = registry.capture(connection, new SerialBlob(new byte[400000]), false);
        corrupt.set(true);
        assertThrows(SQLException.class, () -> registry.fetch(connection, first.ref(), 0, 1));
        assertEquals(Set.of(survivor.ref()), registry.checkpoint());
        corrupt.set(false);
        assertEquals("expired", registry.fetch(connection, first.ref(), 0, 1).status());
        assertEquals("00", registry.fetch(connection, survivor.ref(), 0, 1).data());
        registry.clear();
    }

    @Test
    void pruneAndClearDropTheOwnedWindowWithoutExpiringAnotherReference() throws Exception {
        var registry = new DeferredLobValues(CallableStatement::execute, () -> false);
        var connection = connection();
        var first = registry.capture(connection, new SerialBlob(new byte[400000]), false);
        var survivor = registry.capture(connection, new SerialBlob(new byte[400000]), false);
        registry.fetch(connection, first.ref(), 0, 1);
        var windowField = DeferredLobValues.class.getDeclaredField("window");
        windowField.setAccessible(true);
        assertNotNull(windowField.get(registry));
        var entriesField = DeferredLobValues.class.getDeclaredField("entries");
        entriesField.setAccessible(true);
        Object entry = ((Map<?, ?>) entriesField.get(registry)).get(first.ref());
        var accessed = entry.getClass().getDeclaredField("accessed");
        accessed.setAccessible(true);
        accessed.setLong(entry, System.currentTimeMillis() - 5 * 60_000L - 1);
        assertEquals("expired", registry.fetch(connection, first.ref(), 1, 1).status());
        assertNull(windowField.get(registry));
        assertEquals("ok", registry.fetch(connection, survivor.ref(), 0, 1).status());
        assertNotNull(windowField.get(registry));
        registry.clear();
        assertNull(windowField.get(registry));
        assertTrue(registry.checkpoint().isEmpty());
        assertEquals("expired", registry.fetch(connection, survivor.ref(), 1, 1).status());
    }

    @Test
    void oceanbaseWindowEndReturnsAShortPublicChunkBeforeTheNextWindow() throws Exception {
        var calls = new AtomicInteger();
        var connection = connection(calls::incrementAndGet, () -> {});
        var registry = new DeferredLobValues(CallableStatement::execute, () -> false);
        String original = "🙂".repeat(8192) + "中".repeat(8192) + "a".repeat(524224 - 16384 - 1) + "🙂尾";
        var preview = registry.capture(connection, new SerialClob(original.toCharArray()), true);
        calls.set(0);
        assertThrows(IllegalArgumentException.class, () -> registry.fetch(connection, preview.ref(), 0, 4097));
        assertEquals(4096, registry.fetch(connection, preview.ref(), 0, 4096).next_offset());
        var last = registry.fetch(connection, preview.ref(), 520192, 4096);
        assertEquals(4032, last.data().codePointCount(0, last.data().length()));
        assertTrue(last.data().endsWith("🙂"));
        assertEquals(524224, last.next_offset());
        assertFalse(last.eof());
        assertEquals(1, calls.get());
        var tail = registry.fetch(connection, preview.ref(), last.next_offset(), 4096);
        assertEquals("尾", tail.data());
        assertTrue(tail.eof());
        assertEquals(2, calls.get());
        assertEquals("🙂", registry.fetch(connection, preview.ref(), 524223, 1).data());
        assertEquals("🙂", registry.fetch(connection, preview.ref(), 0, 1).data());
        assertEquals("🙂", registry.fetch(connection, preview.ref(), 0, 1).data());
        assertEquals(3, calls.get());
        registry.clear();
    }

    @Test
    void oceanbaseBinaryReadAheadKeepsAllBytesAcrossItsLargerWindow() throws Exception {
        var calls = new AtomicInteger();
        var connection = connection(calls::incrementAndGet, () -> {});
        var registry = new DeferredLobValues(CallableStatement::execute, () -> false);
        byte[] original = new byte[1048581];
        for (int i = 0; i < original.length; i++) original[i] = (byte) i;
        var preview = registry.capture(connection, new SerialBlob(original), true);
        calls.set(0);
        var actual = new StringBuilder();
        long offset = 0;
        while (true) {
            var chunk = registry.fetch(connection, preview.ref(), offset, 4096);
            actual.append(chunk.data());
            offset = chunk.next_offset();
            if (chunk.eof()) break;
        }
        assertEquals(HexFormat.of().withUpperCase().formatHex(original), actual.toString());
        assertEquals(2, calls.get());
        registry.clear();
    }

    // Simulate the JDBC boundary, including Oracle UTF-16 and OceanBase codepoint units.
    private static Connection connection() { return connection(() -> {}, () -> {}); }

    static Connection connection(Runnable beforeExecute, Runnable onCancel) {
        return connection(beforeExecute, onCancel, args -> {});
    }

    private static Connection connection(Runnable beforeExecute, Runnable onCancel, java.util.function.Consumer<Map<Integer, Object>> afterExecute) {
        return (Connection) Proxy.newProxyInstance(DeferredLobValuesTest.class.getClassLoader(), new Class<?>[]{Connection.class}, (p, m, a) -> {
            if (m.getName().equals("isClosed")) return false;
            if (m.getName().equals("close")) return null;
            if (!m.getName().equals("prepareCall")) throw new UnsupportedOperationException(m.getName());
            boolean batch = ((String) a[0]).contains("IF o<=z");
            var amount = java.util.regex.Pattern.compile("THEN n:=(\\d+);").matcher((String) a[0]);
            int batchLimit = batch && amount.find() ? Integer.parseInt(amount.group(1)) : 0;
            var oceanbase = new AtomicBoolean();
            Map<Integer, Object> args = new HashMap<>();
            return Proxy.newProxyInstance(DeferredLobValuesTest.class.getClassLoader(), new Class<?>[]{CallableStatement.class, InternalStatement.class}, (q, method, values) -> {
                String name = method.getName();
                if (name.equals("setInternal")) { oceanbase.set(true); return null; }
                if (Set.of("setBlob", "setClob", "setInt", "setLong").contains(name)) { args.put((Integer) values[0], values[1]); return null; }
                if (Set.of("registerOutParameter", "setQueryTimeout", "close").contains(name)) return null;
                if (name.equals("cancel")) { onCancel.run(); return null; }
                if (name.equals("execute")) {
                    beforeExecute.run();
                    int limit = batch ? batchLimit : (Integer) args.get(2);
                    long start = (Long) args.get(batch ? 2 : 3);
                    Object lob = args.get(1); long length;
                    String clobText = oceanbase.get() && lob instanceof Clob clob ? clob.getSubString(1, (int) clob.length()) : null;
                    for (int slot = 0; slot < (batch ? 64 : 1); slot++) {
                        int amountIndex = batch ? 3 + slot * 2 : 4;
                        if (lob instanceof Blob blob) {
                            length = blob.length(); byte[] data = start > length ? new byte[0] : blob.getBytes(start, (int) Math.min(limit, length - start + 1));
                            args.put(amountIndex, data.length); args.put(amountIndex + 1, data);
                            start += data.length;
                        } else if (oceanbase.get()) {
                            length = clobText.codePointCount(0, clobText.length());
                            String text = start > length ? "" : clobText.substring(clobText.offsetByCodePoints(0, (int) start - 1), clobText.offsetByCodePoints(0, (int) Math.min(length, start - 1 + limit)));
                            int points = text.codePointCount(0, text.length());
                            args.put(amountIndex, points); args.put(amountIndex + 1, text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                            start += points;
                        } else {
                            Clob clob = (Clob) lob; length = clob.length();
                            String text = start > length ? "" : clob.getSubString(start, (int) Math.min(limit, length - start + 1));
                            if (!text.isEmpty() && Character.isHighSurrogate(text.charAt(text.length() - 1))) text = text.substring(0, text.length() - 1);
                            args.put(amountIndex, text.length()); args.put(amountIndex + 1, text);
                            start += text.length();
                        }
                        args.put(batch ? 131 : 6, length);
                    }
                    afterExecute.accept(args);
                    return false;
                }
                if (Set.of("getInt", "getLong", "getString", "getBytes").contains(name)) return args.get((Integer) values[0]);
                throw new UnsupportedOperationException(name);
            });
        });
    }
}
