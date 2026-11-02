package app.dbx.jdbc;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import java.util.function.BooleanSupplier;

final class DeferredLobValues {
    static final int PREVIEW = 256;
    static final int MAX_CHUNK = 4096;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    @FunctionalInterface
    interface Executor { void execute(CallableStatement call) throws SQLException; }
    private final Executor executor;
    private final BooleanSupplier cancelled;
    private static final int READ_AHEAD_SLOTS = 64;
    private Window window;

    DeferredLobValues(Executor executor, BooleanSupplier cancelled) {
        this.executor = executor;
        this.cancelled = cancelled;
    }

    record Preview(String text, String ref, long originalBytes) {}
    record Chunk(String status, String data, long next_offset, boolean eof, String value_kind) {}
    private record Block(String data, int count, long nativeCount, boolean eof) {}
    private record Window(Entry owner, String data, long start, int count, long nativeLength) {}
    private static final class Entry {
        final Connection connection;
        final Object locator;
        final boolean oceanbase;
        final boolean binary;
        final long created = System.currentTimeMillis();
        long accessed = created;
        long offset;
        long nativeOffset;
        Entry(Connection connection, Object locator, boolean oceanbase) {
            this.connection = connection;
            this.locator = locator;
            this.oceanbase = oceanbase;
            this.binary = locator instanceof Blob;
        }
    }

    Preview capture(Connection connection, Object locator, boolean oceanbase) throws SQLException {
        if (locator == null) return new Preview(null, null, 0);
        prune();
        Entry entry = new Entry(connection, locator, oceanbase);
        boolean retained = false;
        try {
            if (entries.size() >= 4096) throw new SQLException("LOB reference limit reached; close older results");
            long length = entry.binary ? ((Blob) locator).length() : ((Clob) locator).length();
            if (length == 0) return new Preview(entry.binary ? "0x" : "", null, 0);
            StringBuilder preview = new StringBuilder();
            boolean eof = false;
            while (entry.offset < PREVIEW + 1 && !eof) {
                Block block = read(entry, (int) (PREVIEW + 1 - entry.offset));
                preview.append(block.data);
                advance(entry, block);
                eof = block.eof;
            }
            String text = preview.toString();
            if (eof && entry.offset <= PREVIEW) return new Preview(entry.binary ? "0x" + text : text, null, length);
            String ref = UUID.randomUUID().toString();
            entries.put(ref, entry);
            retained = true;
            String prefix = entry.binary ? "0x" + text.substring(0, PREVIEW * 2)
                : text.substring(0, text.offsetByCodePoints(0, PREVIEW));
            // With a locator, zero means unknown byte size; Clob.length() is not a UTF-8 byte count.
            return new Preview(prefix, ref, entry.binary ? length : 0);
        } finally {
            if (!retained) free(entry);
        }
    }

    Chunk fetch(Connection connection, String ref, long offset, int limit) throws SQLException {
        if (offset < 0 || offset == Long.MAX_VALUE || limit < 1 || limit > MAX_CHUNK)
            throw new IllegalArgumentException("Invalid LOB chunk offset or limit");
        prune();
        Entry entry = entries.get(ref);
        if (entry == null || entry.connection != connection || connection == null || connection.isClosed()) {
            release(ref);
            return new Chunk("expired", "", offset, false, "text");
        }
        entry.accessed = System.currentTimeMillis();
        try {
            if (offset < entry.offset) { entry.offset = 0; entry.nativeOffset = 0; }
            while (entry.offset < offset) {
                Block skipped = readWindow(entry, (int) Math.min(MAX_CHUNK, offset - entry.offset));
                advance(entry, skipped);
                if (skipped.eof && entry.offset < offset) throw new SQLException("LOB chunk offset exceeds original value");
            }
            Block block = readWindow(entry, limit);
            checkCancelled();
            advance(entry, block);
            return new Chunk("ok", block.data, entry.offset, block.eof, entry.binary ? "binary" : "text");
        } catch (SQLException error) {
            release(ref);
            throw error;
        }
    }

    boolean release(String ref) {
        Entry entry = entries.remove(ref);
        if (entry == null) return false;
        if (window != null && window.owner == entry) window = null;
        free(entry);
        return true;
    }

    Set<String> checkpoint() { return Set.copyOf(entries.keySet()); }
    void releaseSince(Set<String> checkpoint) {
        for (String ref : List.copyOf(entries.keySet())) if (!checkpoint.contains(ref)) release(ref);
    }
    void clear() { window = null; entries.values().forEach(DeferredLobValues::free); entries.clear(); }

    private void prune() {
        long now = System.currentTimeMillis();
        for (String ref : List.copyOf(entries.keySet())) {
            Entry entry = entries.get(ref);
            if (now - entry.accessed >= 5 * 60_000L || now - entry.created >= 30 * 60_000L) release(ref);
        }
    }

    private static void advance(Entry entry, Block block) {
        entry.offset += block.count;
        entry.nativeOffset += block.nativeCount;
    }

    private void checkCancelled() throws SQLException {
        if (cancelled.getAsBoolean()) throw new SQLException("JDBC request cancelled");
    }

    private Block readWindow(Entry entry, int limit) throws SQLException {
        checkCancelled();
        if (window == null || window.owner != entry || entry.offset < window.start
            || entry.offset >= window.start + window.count && entry.nativeOffset < window.nativeLength) {
            window = null;
            window = readAhead(entry);
        }
        Window current = window;
        int start = Math.toIntExact(entry.offset - current.start);
        int count = Math.min(limit, current.count - start);
        String text = entry.binary ? current.data.substring(start * 2, (start + count) * 2)
            : current.data.substring(current.data.offsetByCodePoints(0, start), current.data.offsetByCodePoints(0, start + count));
        long nativeCount = entry.binary || entry.oceanbase ? count : text.length();
        checkCancelled();
        return new Block(text, count, nativeCount, entry.nativeOffset + nativeCount >= current.nativeLength);
    }

    private Window readAhead(Entry entry) throws SQLException {
        int nativeAmount = entry.oceanbase ? (entry.binary ? 16384 : 8191) : MAX_CHUNK;
        StringBuilder sql = new StringBuilder("DECLARE l " + (entry.binary ? "BLOB" : "CLOB")
            + " := ?; o INTEGER := ?; z INTEGER; n INTEGER; b "
            + (entry.binary ? "RAW(32767)" : "VARCHAR2(32767)") + "; BEGIN z:=DBMS_LOB.GETLENGTH(l); ");
        for (int i = 0; i < READ_AHEAD_SLOTS; i++) {
            sql.append("IF o<=z THEN n:=").append(nativeAmount).append("; DBMS_LOB.READ(l,n,o,b); o:=o+n; ELSE n:=0; b:=NULL; END IF; ?:=n; ?:=b; ");
        }
        sql.append("?:=z; END;");
        try (CallableStatement call = entry.connection.prepareCall(sql.toString())) {
            if (entry.oceanbase) {
                try { call.getClass().getMethod("setInternal").invoke(call); }
                catch (ReflectiveOperationException error) { throw new SQLException("Unsupported OceanBase LOB statement", error); }
            }
            if (entry.binary) call.setBlob(1, (Blob) entry.locator); else call.setClob(1, (Clob) entry.locator);
            call.setLong(2, entry.nativeOffset + 1);
            for (int i = 0; i < READ_AHEAD_SLOTS; i++) {
                call.registerOutParameter(3 + 2 * i, Types.INTEGER);
                call.registerOutParameter(4 + 2 * i, entry.binary ? Types.VARBINARY : Types.VARCHAR);
            }
            int lengthIndex = 3 + 2 * READ_AHEAD_SLOTS;
            call.registerOutParameter(lengthIndex, Types.BIGINT);
            call.setQueryTimeout(20);
            checkCancelled();
            executor.execute(call);
            checkCancelled();
            long length = call.getLong(lengthIndex), nativeOffset = entry.nativeOffset;
            if (length < 0 || nativeOffset > length) throw new SQLException("Invalid LOB chunk response");
            StringBuilder data = new StringBuilder();
            int count = 0;
            for (int i = 0; i < READ_AHEAD_SLOTS; i++) {
                int amount = call.getInt(3 + 2 * i);
                if (amount < 0 || amount > nativeAmount
                    || nativeOffset < length && (amount == 0 || nativeOffset + amount > length)
                    || nativeOffset >= length && amount != 0) throw new SQLException("Invalid LOB chunk response");
                if (entry.binary) {
                    byte[] bytes = call.getBytes(4 + 2 * i);
                    if (bytes == null) bytes = new byte[0];
                    if (bytes.length != amount) throw new SQLException("LOB byte count mismatch");
                    data.append(HexFormat.of().withUpperCase().formatHex(bytes));
                    count += amount;
                } else {
                    String text;
                    if (entry.oceanbase) {
                        byte[] bytes = call.getBytes(4 + 2 * i);
                        try { text = bytes == null ? "" : StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString(); }
                        catch (java.nio.charset.CharacterCodingException error) { throw new SQLException("Invalid UTF-8 in LOB chunk", error); }
                    } else {
                        text = call.getString(4 + 2 * i);
                        if (text == null) text = "";
                    }
                    for (int j = 0; j < text.length(); j++) {
                        char ch = text.charAt(j);
                        if (Character.isHighSurrogate(ch)) {
                            if (++j >= text.length() || !Character.isLowSurrogate(text.charAt(j))) throw new SQLException("Invalid LOB character boundary");
                        } else if (Character.isLowSurrogate(ch)) throw new SQLException("Invalid LOB character boundary");
                    }
                    int points = text.codePointCount(0, text.length());
                    if (amount != (entry.oceanbase ? points : text.length())) throw new SQLException("LOB character count mismatch");
                    data.append(text);
                    count += points;
                }
                nativeOffset += amount;
                checkCancelled();
            }
            checkCancelled();
            return new Window(entry, data.toString(), entry.offset, count, length);
        }
    }

    private Block read(Entry entry, int limit) throws SQLException {
        if (cancelled.getAsBoolean()) throw new SQLException("JDBC request cancelled");
        int nativeLimit = entry.binary || entry.oceanbase ? limit : Math.max(2, limit);
        try (CallableStatement call = entry.connection.prepareCall(
            "DECLARE l " + (entry.binary ? "BLOB" : "CLOB") + " := ?; n INTEGER := ?; o INTEGER := ?; "
            + "b " + (entry.binary ? "RAW(32767)" : "VARCHAR2(32767)") + "; z INTEGER; "
            + "BEGIN z:=DBMS_LOB.GETLENGTH(l); IF o>z THEN n:=0; ELSE DBMS_LOB.READ(l,n,o,b); END IF; "
            + "? := n; ? := b; ? := z; END;")) {
            if (entry.oceanbase) {
                try { call.getClass().getMethod("setInternal").invoke(call); }
                catch (ReflectiveOperationException error) { throw new SQLException("Unsupported OceanBase LOB statement", error); }
            }
            if (entry.binary) call.setBlob(1, (Blob) entry.locator); else call.setClob(1, (Clob) entry.locator);
            call.setInt(2, nativeLimit);
            call.setLong(3, entry.nativeOffset + 1);
            call.registerOutParameter(4, Types.INTEGER);
            call.registerOutParameter(5, entry.binary ? Types.VARBINARY : Types.VARCHAR);
            call.registerOutParameter(6, Types.BIGINT);
            call.setQueryTimeout(20);
            if (cancelled.getAsBoolean()) throw new SQLException("JDBC request cancelled");
            executor.execute(call);
            if (cancelled.getAsBoolean()) throw new SQLException("JDBC request cancelled");
            int amount = call.getInt(4);
            long length = call.getLong(6);
            if (amount < 0 || amount > nativeLimit || length < 0
                || entry.nativeOffset < length && (amount == 0 || entry.nativeOffset + amount > length)
                || entry.nativeOffset >= length && amount != 0) throw new SQLException("Invalid LOB chunk response");
            if (entry.binary) {
                byte[] bytes = call.getBytes(5);
                if (bytes == null) bytes = new byte[0];
                if (bytes.length != amount) throw new SQLException("LOB byte count mismatch");
                return new Block(HexFormat.of().withUpperCase().formatHex(bytes), amount, amount, entry.nativeOffset + amount >= length);
            }
            String text;
            if (entry.oceanbase) {
                byte[] bytes = call.getBytes(5);
                try { text = bytes == null ? "" : StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString(); }
                catch (java.nio.charset.CharacterCodingException error) { throw new SQLException("Invalid UTF-8 in LOB chunk", error); }
            } else {
                text = call.getString(5);
                if (text == null) text = "";
            }
            for (int i = 0; i < text.length(); i++) {
                char ch = text.charAt(i);
                if (Character.isHighSurrogate(ch)) {
                    if (++i >= text.length() || !Character.isLowSurrogate(text.charAt(i))) throw new SQLException("Invalid LOB character boundary");
                } else if (Character.isLowSurrogate(ch)) throw new SQLException("Invalid LOB character boundary");
            }
            int count = text.codePointCount(0, text.length());
            if (amount != (entry.oceanbase ? count : text.length())) throw new SQLException("LOB character count mismatch");
            if (count > limit) { text = text.substring(0, text.offsetByCodePoints(0, limit)); count = limit; }
            long nativeCount = entry.oceanbase ? count : text.length();
            return new Block(text, count, nativeCount, entry.nativeOffset + nativeCount >= length);
        }
    }

    private static void free(Entry entry) {
        try { if (entry.binary) ((Blob) entry.locator).free(); else ((Clob) entry.locator).free(); }
        catch (SQLException ignored) { }
    }
}
