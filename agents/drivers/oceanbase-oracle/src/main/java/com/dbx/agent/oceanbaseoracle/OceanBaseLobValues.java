package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.JdbcExecutor;
import com.oceanbase.jdbc.OceanBaseStatement;
import com.oceanbase.jdbc.DbxLobResourceBytes;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.sql.CallableStatement;
import java.sql.Clob;
import java.sql.Blob;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** Captured locators belong to this agent's pinned connection, never to a new SELECT. */
final class OceanBaseLobValues {
    static final String MARKER_PREFIX = "__DBX_LARGE_VALUE_BYTES_";
    static final int PREVIEW_CHARACTERS = 256;
    static final int MAX_CHUNK_CHARACTERS = 4096;
    private static final int MAX_REFS = 4096;
    private static final long MAX_RETAINED_BYTES = 64L * 1024 * 1024;
    private static final long IDLE_MILLIS = 5 * 60_000L;
    private static final long MAX_AGE_MILLIS = 30 * 60_000L;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final BlockReader reader;
    private final java.util.function.ToLongFunction<Object> retainedBytes;
    private long retainedByteCount;

    @FunctionalInterface
    interface BlockReader {
        Chunk read(Connection connection, Object locator, long offset, int limit) throws SQLException;
    }

    OceanBaseLobValues() { this(OceanBaseLobValues::read, DbxLobResourceBytes::retainedBytes); }
    OceanBaseLobValues(BlockReader reader) { this(reader, ignored -> 0); }
    OceanBaseLobValues(BlockReader reader, java.util.function.ToLongFunction<Object> retainedBytes) { this.reader = reader; this.retainedBytes = retainedBytes; }

    record Preview(String text, String ref, String kind) {
        Preview(String text, String ref) { this(text, ref, "clob"); }
    }
    record Chunk(String status, String data, long next_offset, boolean eof, String value_kind) {}
    record MarkedRows(List<String> columns, List<String> types, List<List<Object>> rows) {}
    private static final class Entry {
        final Connection connection;
        final Object locator;
        final long retainedBytes;
        final long created = System.currentTimeMillis();
        long accessed = created;
        Entry(Connection connection, Object locator, long retainedBytes) {
            this.connection = connection;
            this.locator = locator;
            this.retainedBytes = retainedBytes;
        }
    }

    synchronized Object preview(ResultSet rs, int index, int sqlType, String typeName) throws SQLException {
        boolean binary = sqlType == Types.BLOB || "BLOB".equalsIgnoreCase(typeName);
        if ((!binary && !isCharacterLob(sqlType, typeName)) || hasMarkerCollision(rs)) return null;
        // NCLOB's charset form must be verified separately; retain the complete existing read.
        if (sqlType == Types.NCLOB || "NCLOB".equalsIgnoreCase(typeName)) return null;
        Object locator = binary ? rs.getBlob(index) : rs.getClob(index);
        String kind = binary ? "blob" : "clob";
        if (locator == null || rs.wasNull()) return new Preview(null, null, kind);
        Connection connection = rs.getStatement().getConnection();
        prune();
        long bytes = retainedBytes.applyAsLong(locator);
        if (bytes < 0 || bytes > MAX_RETAINED_BYTES - retainedByteCount || entries.size() >= MAX_REFS) {
            freeLocator(locator);
            throw new SQLException("LOB result resource limit reached; close older results and execute again", "HY001");
        }
        boolean retained = false;
        try {
            Chunk chunk = reader.read(connection, locator, 0, PREVIEW_CHARACTERS + 1);
            if (chunk.eof()) return new Preview(binary ? "0x" + chunk.data() : chunk.data(), null, kind);
            String text = chunk.data();
            int count = binary ? text.length() / 2 : text.codePointCount(0, text.length());
            if (count <= PREVIEW_CHARACTERS) return new Preview(binary ? "0x" + text : text, null, kind);
            String ref = UUID.randomUUID().toString();
            entries.put(ref, new Entry(connection, locator, bytes));
            retainedByteCount += bytes;
            retained = true;
            String preview = binary ? "0x" + text.substring(0, PREVIEW_CHARACTERS * 2)
                : text.substring(0, text.offsetByCodePoints(0, PREVIEW_CHARACTERS));
            return new Preview(preview, ref, kind);
        } finally {
            if (!retained) freeLocator(locator);
        }
    }

    synchronized Chunk fetch(Connection connection, String ref, long offset, int limit) throws SQLException {
        if (offset < 0 || offset == Long.MAX_VALUE || limit < 1 || limit > MAX_CHUNK_CHARACTERS) {
            throw new IllegalArgumentException("Invalid LOB chunk offset or limit");
        }
        prune();
        Entry entry = entries.get(ref);
        if (entry == null || entry.connection != connection || connection.isClosed()) {
            release(ref);
            return new Chunk("expired", "", offset, false, "text");
        }
        entry.accessed = System.currentTimeMillis();
        try {
            return reader.read(connection, entry.locator, offset, limit);
        } catch (SQLException error) {
            release(ref);
            throw error;
        }
    }

    synchronized boolean release(String ref) {
        Entry entry = entries.remove(ref);
        if (entry == null) return false;
        retainedByteCount -= entry.retainedBytes;
        free(entry);
        return true;
    }

    synchronized boolean hasValues() {
        prune();
        return !entries.isEmpty();
    }

    synchronized void clear() {
        entries.values().forEach(OceanBaseLobValues::free);
        entries.clear();
        retainedByteCount = 0;
    }

    private void prune() {
        long now = System.currentTimeMillis();
        Iterator<Entry> iterator = entries.values().iterator();
        while (iterator.hasNext()) {
            Entry entry = iterator.next();
            if (now - entry.accessed >= IDLE_MILLIS || now - entry.created >= MAX_AGE_MILLIS) {
                iterator.remove();
                retainedByteCount -= entry.retainedBytes;
                free(entry);
            }
        }
    }

    private static void free(Entry entry) {
        try { freeLocator(entry.locator); } catch (SQLException ignored) { }
    }

    private static void freeLocator(Object locator) throws SQLException {
        if (locator instanceof Blob) ((Blob) locator).free();
        else ((Clob) locator).free();
    }

    static Chunk read(Connection connection, Object locator, long offset, int limit) throws SQLException {
        boolean binary = locator instanceof Blob;
        try (CallableStatement call = connection.prepareCall("{call DBMS_LOB.READ(?, ?, ?, ?)}")) {
            OceanBaseStatement vendor;
            try {
                vendor = call instanceof OceanBaseStatement ? (OceanBaseStatement) call : call.unwrap(OceanBaseStatement.class);
            } catch (SQLException error) {
                throw new SQLException("Unsupported OceanBase LOB statement", error);
            }
            if (vendor == null) throw new SQLException("Unsupported OceanBase LOB statement");
            // Only the vendor flag bypasses the pool proxy; lifecycle and cancellation stay on call.
            vendor.setInternal();
            if (binary) call.setBlob(1, (Blob) locator);
            else call.setClob(1, (Clob) locator);
            call.setInt(2, limit);
            call.setLong(3, offset + 1);
            call.registerOutParameter(2, Types.INTEGER);
            call.registerOutParameter(4, Types.VARCHAR);
            call.setQueryTimeout(20);
            try {
                JdbcExecutor.current().withActiveStatement(call, () -> { call.execute(); return null; });
            } catch (SQLException error) {
                // DBMS_LOB.READ signals an empty LOB or reading beyond its end with NO_DATA_FOUND.
                if (error.getErrorCode() == 1403) return new Chunk("ok", "", offset, true, binary ? "binary" : "text");
                throw error;
            }
            int amount = call.getInt(2);
            byte[] bytes = call.getBytes(4);
            if (amount < 0 || amount > limit || bytes == null && amount != 0) {
                throw new SQLException("Invalid OceanBase LOB chunk response");
            }
            if (binary) {
                if (bytes != null && bytes.length != amount) throw new SQLException("OceanBase BLOB byte count mismatch");
                String hex = bytes == null ? "" : JdbcExecutor.bytesToHex(bytes).substring(2);
                return new Chunk("ok", hex, Math.addExact(offset, amount), amount < limit, "binary");
            }
            String text;
            try {
                text = bytes == null ? "" : StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
            } catch (java.nio.charset.CharacterCodingException error) {
                throw new SQLException("Invalid UTF-8 in OceanBase LOB chunk", error);
            }
            if (text.codePointCount(0, text.length()) != amount) throw new SQLException("OceanBase LOB character count mismatch");
            return new Chunk("ok", text, Math.addExact(offset, amount), amount < limit, "text");
        }
    }

    static boolean isCharacterLob(int sqlType, String typeName) {
        return sqlType == Types.CLOB || sqlType == Types.NCLOB
            || "CLOB".equalsIgnoreCase(typeName) || "NCLOB".equalsIgnoreCase(typeName);
    }

    private static boolean hasMarkerCollision(ResultSet rs) throws SQLException {
        var metadata = rs.getMetaData();
        for (int index = 1; index <= metadata.getColumnCount(); index++) {
            if (metadata.getColumnLabel(index).toUpperCase(Locale.ROOT).startsWith(MARKER_PREFIX)) return true;
        }
        return false;
    }

    static MarkedRows mark(List<String> columns, List<String> types, List<List<Object>> rows) {
        List<String> expandedColumns = new ArrayList<>();
        List<String> expandedTypes = new ArrayList<>();
        boolean[] marked = new boolean[columns.size()];
        String[] kinds = new String[columns.size()];
        for (List<Object> row : rows) {
            for (int index = 0; index < row.size(); index++) {
                if (row.get(index) instanceof Preview preview) { marked[index] = true; kinds[index] = preview.kind(); }
            }
        }
        boolean anyMarked = false;
        for (boolean value : marked) anyMarked |= value;
        if (!anyMarked) return null;
        for (int index = 0; index < columns.size(); index++) {
            expandedColumns.add(columns.get(index));
            expandedTypes.add(index < types.size() ? types.get(index) : "");
            if (marked[index]) {
                expandedColumns.add(MARKER_PREFIX + ("blob".equals(kinds[index]) ? "L_" : "C_") + index);
                expandedTypes.add("VARCHAR");
            }
        }
        List<List<Object>> expandedRows = new ArrayList<>();
        for (List<Object> row : rows) {
            List<Object> expanded = new ArrayList<>();
            for (int index = 0; index < columns.size(); index++) {
                Object value = row.get(index);
                Preview preview = value instanceof Preview ? (Preview) value : null;
                expanded.add(preview == null ? value : preview.text());
                if (marked[index]) expanded.add(preview == null || preview.ref() == null ? null : "D:1:unknown:" + preview.ref());
            }
            expandedRows.add(expanded);
        }
        return new MarkedRows(expandedColumns, expandedTypes, expandedRows);
    }
}
