package com.dbx.agent.oceanbaseoracle;

import com.google.gson.Gson;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

final class PlDebugResultCache {
    static final int MAX_BYTES = 16 * 1024 * 1024;
    static final int MAX_PAGE_UNITS = 64 * 1024;
    private static final int METADATA_RESERVE = 4096;
    private static final Gson JSON = new Gson();
    private final String generation = UUID.randomUUID().toString();
    private final int budget;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private int used;

    private record Entry(Map<String, Object> manifest, String text, byte[] binary) {}

    PlDebugResultCache() { this(MAX_BYTES); }
    PlDebugResultCache(int budget) {
        if (budget < METADATA_RESERVE || budget > MAX_BYTES) throw new IllegalArgumentException("Invalid result cache budget");
        this.budget = budget;
    }

    Map<String, Object> text(Reader reader, String errorPath) {
        return text(reader, errorPath, true);
    }

    Map<String, Object> text(Reader reader, String errorPath, boolean sourceComplete) {
        return text(reader,errorPath,sourceComplete,null);
    }

    Map<String, Object> text(Reader reader, String errorPath, boolean sourceComplete,String sourceError) {
        reader = new java.io.BufferedReader(reader);
        int remaining = remaining();
        StringBuilder text = new StringBuilder();
        int bytes = 0;
        boolean complete = false;
        String error = sourceError;
        try {
            while (true) {
                int first = reader.read();
                if (first < 0) { complete = true; break; }
                String next;
                if (Character.isHighSurrogate((char) first)) {
                    int second = reader.read();
                    if (second < 0 || !Character.isLowSurrogate((char) second)) {
                        error = "invalid_utf16"; break;
                    }
                    next = new String(new char[]{(char) first, (char) second});
                } else {
                    if (Character.isLowSurrogate((char) first)) { error = "invalid_utf16"; break; }
                    next = Character.toString((char) first);
                }
                int cost = next.getBytes(StandardCharsets.UTF_8).length;
                if (cost > remaining - bytes) break;
                text.append(next); bytes += cost;
            }
        } catch (IOException failure) { error = "read_failed"; }
        return retain("utf16", text.toString(), null, bytes, complete && sourceComplete, error, errorPath);
    }

    Map<String, Object> binary(InputStream stream, String errorPath) {
        return binary(stream, errorPath, true);
    }

    Map<String, Object> binary(InputStream stream, String errorPath, boolean sourceComplete) {
        int remaining = remaining();
        int capacity = remaining / 4 * 3;
        var data = new java.io.ByteArrayOutputStream(Math.min(capacity, 8192));
        boolean complete = false;
        String error = null;
        try {
            byte[] chunk = new byte[8192];
            while (data.size() < capacity) {
                int count = stream.read(chunk, 0, Math.min(chunk.length, capacity - data.size()));
                if (count < 0) { complete = true; break; }
                if (count == 0) {
                    int one = stream.read();
                    if (one < 0) { complete = true; break; }
                    data.write(one);
                } else data.write(chunk, 0, count);
            }
            if (!complete && data.size() == capacity) complete = stream.read() < 0;
        } catch (IOException failure) { error = "read_failed"; }
        byte[] bytes = data.toByteArray();
        return retain("base64", null, bytes, 4 * ((bytes.length + 2) / 3), complete && sourceComplete, error, errorPath);
    }

    synchronized int remaining() {
        if (budget - used < METADATA_RESERVE) throw new IllegalStateException("The debugger result cache budget is exhausted");
        return budget - used - METADATA_RESERVE;
    }

    private synchronized Map<String, Object> retain(String encoding, String text, byte[] binary, int bytes,
                                      boolean complete, String error, String errorPath) {
        String id = UUID.randomUUID().toString();
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("generation", generation);
        manifest.put("resultId", id);
        manifest.put("encoding", encoding);
        manifest.put("length", text == null ? binary.length : text.length());
        manifest.put("lengthUnit", text == null ? "bytes" : "utf16");
        manifest.put("complete", complete);
        manifest.put("truncated", !complete && (error == null||"budget_exceeded".equals(error)));
        manifest.put("state", complete ? "available" : "partial");
        if (error != null) manifest.put("error", error);
        if (errorPath != null) manifest.put("errorPath", errorPath);
        int metadata = JSON.toJson(manifest).getBytes(StandardCharsets.UTF_8).length;
        if (metadata > METADATA_RESERVE || bytes + metadata > budget - used) {
            throw new IllegalStateException("The debugger result metadata exceeds its cache budget");
        }
        var frozen = Map.copyOf(manifest);
        entries.put(id, new Entry(frozen, text, binary));
        used += bytes + metadata;
        return frozen;
    }

    synchronized java.util.List<Map<String, Object>> manifests() {
        return entries.values().stream().map(Entry::manifest).toList();
    }

    synchronized Map<String, Object> page(String requestedGeneration, String id, int offset, int limit) {
        Entry entry = entries.get(id);
        if (!generation.equals(requestedGeneration) || entry == null) throw new IllegalArgumentException("Unknown debugger result identity");
        int length = entry.text() == null ? entry.binary().length : entry.text().length();
        if (offset < 0 || offset > length || limit < 1 || limit > MAX_PAGE_UNITS) throw new IllegalArgumentException("Invalid debugger result page bounds");
        int end = (int) Math.min(length, (long) offset + limit);
        String data;
        if (entry.text() != null) {
            if (offset > 0 && offset < length && Character.isLowSurrogate(entry.text().charAt(offset))) {
                throw new IllegalArgumentException("A result offset cannot split a surrogate pair");
            }
            if (end < length && end > offset && Character.isHighSurrogate(entry.text().charAt(end - 1))) end--;
            if (end == offset && offset < length) throw new IllegalArgumentException("The page limit cannot contain the next surrogate pair");
            data = entry.text().substring(offset, end);
        } else data = Base64.getEncoder().encodeToString(java.util.Arrays.copyOfRange(entry.binary(), offset, end));
        Map<String, Object> result = new LinkedHashMap<>(entry.manifest());
        result.put("offset", offset);
        result.put("nextOffset", end);
        result.put("eof", end == length);
        result.put("data", data);
        return Map.copyOf(result);
    }
}
