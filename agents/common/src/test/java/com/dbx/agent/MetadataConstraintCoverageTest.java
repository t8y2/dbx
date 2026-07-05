package com.dbx.agent;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MetadataConstraintCoverageTest {
    private static final Pattern JAVA_METADATA_OVERRIDE = Pattern.compile(
        "public\\s+List\\s*<\\s*(?:TableInfo|ObjectInfo)\\s*>\\s+list(?:Tables|Objects)\\s*\\(\\s*String\\s+schema"
    );
    private static final Set<String> VALID_STRATEGIES = new HashSet<>(Arrays.asList(
        "native-pushdown",
        "shared-fallback",
        "intentional-fallback"
    ));

    @Test
    void everyCustomMetadataDriverIsListedInCoverageMatrix() throws Exception {
        Path agentsRoot = agentsRoot();
        Map<String, String> coverage = readCoverageMatrix(agentsRoot.resolve("metadata-constraint-coverage.tsv"));
        Set<String> discovered = discoverCustomMetadataDrivers(agentsRoot.resolve("drivers"));

        assertEquals(discovered, coverage.keySet());
    }

    @Test
    void coverageMatrixUsesKnownStrategiesAndReasons() throws Exception {
        Path agentsRoot = agentsRoot();
        Path matrix = agentsRoot.resolve("metadata-constraint-coverage.tsv");
        for (String line : Files.readAllLines(matrix, StandardCharsets.UTF_8)) {
            if (line.startsWith("driver\t") || line.trim().isEmpty()) {
                continue;
            }
            String[] parts = line.split("\t", -1);
            assertEquals(4, parts.length, line);
            assertTrue(VALID_STRATEGIES.contains(parts[1]), line);
            assertFalse(parts[3].trim().isEmpty(), line);
        }
    }

    private static Set<String> discoverCustomMetadataDrivers(Path driversRoot) throws IOException {
        Set<String> result = new HashSet<>();
        try (Stream<Path> files = Files.walk(driversRoot)) {
            files.filter(Files::isRegularFile).forEach(file -> {
                String fileName = file.getFileName().toString();
                if (fileName.endsWith(".java") && hasJavaMetadataOverride(file)) {
                    result.add(driversRoot.relativize(file).getName(0).toString());
                } else if ("main.go".equals(fileName) && hasGoMetadataDispatcher(file)) {
                    result.add(driversRoot.relativize(file).getName(0).toString());
                }
            });
        }
        return result;
    }

    private static boolean hasJavaMetadataOverride(Path file) {
        try {
            return JAVA_METADATA_OVERRIDE.matcher(readUtf8(file)).find();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    private static boolean hasGoMetadataDispatcher(Path file) {
        try {
            String source = readUtf8(file);
            return source.contains("\"list_tables\"") || source.contains("\"list_objects\"");
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    private static Map<String, String> readCoverageMatrix(Path matrix) throws IOException {
        Map<String, String> result = new HashMap<>();
        for (String line : Files.readAllLines(matrix, StandardCharsets.UTF_8)) {
            if (line.startsWith("driver\t") || line.trim().isEmpty()) {
                continue;
            }
            String[] parts = line.split("\t", -1);
            result.put(parts[0], parts[1]);
        }
        return result;
    }

    private static String readUtf8(Path file) throws IOException {
        return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
    }

    private static Path agentsRoot() {
        Path current = Paths.get("").toAbsolutePath();
        while (current != null) {
            if (Files.isDirectory(current.resolve("drivers")) && Files.isDirectory(current.resolve("common"))) {
                return current;
            }
            current = current.getParent();
        }
        throw new IllegalStateException("Unable to locate agents root");
    }
}
