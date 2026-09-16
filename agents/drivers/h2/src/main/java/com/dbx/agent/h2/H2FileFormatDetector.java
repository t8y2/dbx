package com.dbx.agent.h2;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.OptionalInt;

final class H2FileFormatDetector {
    private static final int BLOCK_SIZE = 4096;

    private H2FileFormatDetector() {
    }

    static OptionalInt detect(String jdbcUrl) throws IOException {
        Path base = localDatabaseBasePath(jdbcUrl);
        if (base == null) {
            return OptionalInt.empty();
        }
        Path pageStore = withSuffix(base, ".h2.db");
        Path mvStore = withSuffix(base, ".mv.db");
        boolean pageStoreExists = Files.isRegularFile(pageStore);
        boolean mvStoreExists = Files.isRegularFile(mvStore);
        if (pageStoreExists && mvStoreExists) {
            throw new IOException("Both H2 PageStore and MVStore files exist for " + base + "; choose an explicit H2 driver profile");
        }
        if (pageStoreExists) {
            return OptionalInt.of(1);
        }
        if (!mvStoreExists) {
            return OptionalInt.empty();
        }
        return OptionalInt.of(readMvStoreFormat(mvStore));
    }

    private static int readMvStoreFormat(Path file) throws IOException {
        byte[] bytes;
        try (InputStream input = Files.newInputStream(file)) {
            bytes = input.readNBytes(BLOCK_SIZE * 2);
        }
        if (bytes.length < BLOCK_SIZE * 2) {
            throw new IOException("H2 MVStore file is too small to contain valid headers: " + file);
        }
        List<StoreHeader> headers = new ArrayList<>();
        for (int block = 0; block < 2; block++) {
            StoreHeader header = parseHeader(bytes, block * BLOCK_SIZE);
            if (header != null) {
                headers.add(header);
            }
        }
        return headers.stream()
            .max(Comparator.comparingLong(StoreHeader::version))
            .orElseThrow(() -> new IOException("Cannot determine the H2 MVStore format for " + file + "; choose an explicit H2 driver profile"))
            .format();
    }

    private static StoreHeader parseHeader(byte[] fileBytes, int offset) {
        byte[] block = java.util.Arrays.copyOfRange(fileBytes, offset, offset + BLOCK_SIZE);
        int start = 0;
        int end = block.length;
        while (start < end && block[start] <= ' ') {
            start++;
        }
        while (start < end && block[end - 1] <= ' ') {
            end--;
        }
        if (start >= end) {
            return null;
        }
        String text = new String(block, start, end - start, StandardCharsets.ISO_8859_1);
        int fletcherIndex = text.indexOf("fletcher:");
        if (fletcherIndex <= 0 || text.charAt(fletcherIndex - 1) != ',') {
            return null;
        }
        int checksumEnd = text.indexOf(',', fletcherIndex);
        if (checksumEnd < 0) {
            checksumEnd = text.length();
        }
        try {
            long expected = Long.parseUnsignedLong(text.substring(fletcherIndex + "fletcher:".length(), checksumEnd), 16);
            int actual = fletcher32(block, start, fletcherIndex - 1);
            if (Integer.toUnsignedLong(actual) != expected) {
                return null;
            }
            long version = readHexValue(text, "version", 0);
            int format = Math.toIntExact(readHexValue(text, "format", 1));
            return new StoreHeader(version, format);
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static long readHexValue(String text, String key, long defaultValue) {
        String marker = key + ':';
        int index = text.indexOf(marker);
        if (index < 0 || (index > 0 && text.charAt(index - 1) != ',')) {
            return defaultValue;
        }
        int start = index + marker.length();
        int end = text.indexOf(',', start);
        if (end < 0) {
            end = text.length();
        }
        return Long.parseUnsignedLong(text.substring(start, end), 16);
    }

    private static int fletcher32(byte[] bytes, int offset, int length) {
        int s1 = 0xffff;
        int s2 = 0xffff;
        int index = offset;
        int evenEnd = offset + (length & ~1);
        while (index < evenEnd) {
            int batchEnd = Math.min(index + 720, evenEnd);
            while (index < batchEnd) {
                int value = ((bytes[index++] & 0xff) << 8) | (bytes[index++] & 0xff);
                s2 += s1 += value;
            }
            s1 = (s1 & 0xffff) + (s1 >>> 16);
            s2 = (s2 & 0xffff) + (s2 >>> 16);
        }
        if ((length & 1) != 0) {
            int value = (bytes[index] & 0xff) << 8;
            s2 += s1 += value;
        }
        s1 = (s1 & 0xffff) + (s1 >>> 16);
        s2 = (s2 & 0xffff) + (s2 >>> 16);
        return (s2 << 16) | s1;
    }

    private static Path localDatabaseBasePath(String jdbcUrl) {
        String prefix = "jdbc:h2:";
        if (jdbcUrl == null || !jdbcUrl.regionMatches(true, 0, prefix, 0, prefix.length())) {
            return null;
        }
        String target = jdbcUrl.substring(prefix.length());
        String lower = target.toLowerCase(java.util.Locale.ROOT);
        if (lower.startsWith("tcp:") || lower.startsWith("ssl:") || lower.startsWith("mem:")
            || lower.startsWith("zip:") || lower.startsWith("split:")) {
            return null;
        }
        if (lower.startsWith("file:")) {
            target = target.substring("file:".length());
        }
        target = beforeOptions(target);
        if (target.startsWith("~" + java.io.File.separator) || target.startsWith("~/") || target.startsWith("~\\")) {
            target = System.getProperty("user.home") + target.substring(1);
        }
        if (target.isBlank()) {
            return null;
        }
        Path path = Path.of(target).toAbsolutePath().normalize();
        String value = path.toString().toLowerCase(java.util.Locale.ROOT);
        if (value.endsWith(".mv.db")) {
            return Path.of(path.toString().substring(0, path.toString().length() - ".mv.db".length()));
        }
        if (value.endsWith(".h2.db")) {
            return Path.of(path.toString().substring(0, path.toString().length() - ".h2.db".length()));
        }
        return path;
    }

    private static String beforeOptions(String value) {
        boolean escaped = false;
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (current == ';' && !escaped) {
                return value.substring(0, index);
            }
            escaped = current == '\\' && !escaped;
            if (current != '\\') {
                escaped = false;
            }
        }
        return value;
    }

    private static Path withSuffix(Path base, String suffix) {
        return Path.of(base.toString() + suffix);
    }

    private record StoreHeader(long version, int format) {
    }
}
