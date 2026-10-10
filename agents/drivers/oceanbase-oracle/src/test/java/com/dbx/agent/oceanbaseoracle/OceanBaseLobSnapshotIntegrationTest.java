package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;
import static org.junit.jupiter.api.Assertions.*;
import java.sql.DriverManager;
import java.sql.Types;
import java.util.UUID;

/** Opt-in isolated Oracle tenant only. Run during the unified acceptance phase. */
class OceanBaseLobSnapshotIntegrationTest {
    @Test
    void capturesOriginalBlobBytesAcrossCursorCloseAndConcurrentUpdateAndDelete() throws Exception {
        String url = System.getenv("OB_LOB_INTEGRATION_URL");
        Assumptions.assumeTrue(url != null && !url.isBlank(), "Isolated OB LOB integration environment not configured");
        String user = System.getenv("OB_LOB_INTEGRATION_USER");
        String password = System.getenv("OB_LOB_INTEGRATION_PASSWORD");
        String table = "DBX_O13_" + UUID.randomUUID().toString().replace("-", "").substring(0, 20).toUpperCase();
        OceanBaseLobValues values = new OceanBaseLobValues();
        try (var connection = DriverManager.getConnection(url, user, password);
             var other = DriverManager.getConnection(url, user, password)) {
            try (var statement = connection.createStatement(); var tenant = statement.executeQuery("SELECT SYS_CONTEXT('USERENV','CON_NAME') FROM DUAL")) {
                assertTrue(tenant.next());
                assertEquals("oracletest", tenant.getString(1).toLowerCase(), "Refuse writes outside the authorized isolated tenant");
            }
            boolean created = false;
            try {
                try (var statement = connection.createStatement()) {
                    statement.execute("CREATE TABLE " + table + " (ID NUMBER PRIMARY KEY, PAYLOAD BLOB)");
                    created = true;
                }
                byte[] original = new byte[1024 * 1024 + 7];
                new java.util.Random(11438).nextBytes(original);
                for (int index = 0; index < 256; index++) original[index] = (byte) index;
                try (var insert = connection.prepareStatement("INSERT INTO " + table + " VALUES (1, ?)")) {
                    insert.setBytes(1, original);
                    insert.executeUpdate();
                }
                OceanBaseLobValues.Preview preview;
                try (var statement = connection.createStatement(); var result = statement.executeQuery("SELECT PAYLOAD FROM " + table + " WHERE ID = 1")) {
                    assertTrue(result.next());
                    preview = (OceanBaseLobValues.Preview) values.preview(result, 1, Types.BLOB, "BLOB");
                }
                assertNotNull(preview.ref());
                assertEquals("0x" + java.util.HexFormat.of().formatHex(original, 0, 256), preview.text());
                try (var update = other.prepareStatement("UPDATE " + table + " SET PAYLOAD = ? WHERE ID = 1")) {
                    update.setBytes(1, new byte[]{1, 2, 3});
                    assertEquals(1, update.executeUpdate());
                }
                try (var statement = other.createStatement()) { assertEquals(1, statement.executeUpdate("DELETE FROM " + table + " WHERE ID = 1")); }
                StringBuilder complete = new StringBuilder();
                long offset = 0;
                while (true) {
                    var chunk = values.fetch(connection, preview.ref(), offset, 4096);
                    assertEquals("ok", chunk.status());
                    assertEquals("binary", chunk.value_kind());
                    complete.append(chunk.data());
                    if (chunk.eof()) break;
                    offset = chunk.next_offset();
                }
                byte[] actual = java.util.HexFormat.of().parseHex(complete.toString());
                assertEquals(original.length, actual.length);
                assertArrayEquals(original, actual);
                var digest = java.security.MessageDigest.getInstance("SHA-256");
                assertArrayEquals(digest.digest(original), digest.digest(actual));
                values.clear();
                assertEquals("expired", values.fetch(connection, preview.ref(), 0, 4096).status());
            } finally {
                values.clear();
                if (created) try (var statement = connection.createStatement()) { statement.execute("DROP TABLE " + table + " PURGE"); }
            }
        }
    }

    @Test
    void capturesOriginalClobAcrossCursorCloseAndConcurrentUpdateAndDelete() throws Exception {
        String url = System.getenv("OB_LOB_INTEGRATION_URL");
        Assumptions.assumeTrue(url != null && !url.isBlank(), "Isolated OB LOB integration environment not configured");
        String user = System.getenv("OB_LOB_INTEGRATION_USER");
        String password = System.getenv("OB_LOB_INTEGRATION_PASSWORD");
        String table = "DBX_O13_" + UUID.randomUUID().toString().replace("-", "").substring(0, 20).toUpperCase();
        OceanBaseLobValues values = new OceanBaseLobValues();
        try (var connection = DriverManager.getConnection(url, user, password);
             var other = DriverManager.getConnection(url, user, password)) {
            try (var statement = connection.createStatement(); var tenant = statement.executeQuery("SELECT SYS_CONTEXT('USERENV','CON_NAME') FROM DUAL")) {
                assertTrue(tenant.next());
                assertEquals("oracletest", tenant.getString(1).toLowerCase(), "Refuse writes outside the authorized isolated tenant");
            }
            boolean created = false;
            try {
                try (var statement = connection.createStatement()) {
                    statement.execute("CREATE TABLE " + table + " (ID NUMBER PRIMARY KEY, PAYLOAD CLOB)");
                    created = true;
                }
                String original = "中文😀完整原值".repeat(12_000);
                try (var insert = connection.prepareStatement("INSERT INTO " + table + " VALUES (1, ?)")) {
                    insert.setString(1, original);
                    insert.executeUpdate();
                }
                OceanBaseLobValues.Preview preview;
                try (var statement = connection.createStatement(); var result = statement.executeQuery("SELECT PAYLOAD FROM " + table + " WHERE ID = 1")) {
                    assertTrue(result.next());
                    preview = (OceanBaseLobValues.Preview) values.preview(result, 1, Types.CLOB, "CLOB");
                }
                assertNotNull(preview.ref());
                assertEquals(256, preview.text().codePointCount(0, preview.text().length()));
                try (var update = other.prepareStatement("UPDATE " + table + " SET PAYLOAD = ? WHERE ID = 1")) {
                    update.setString(1, "已经变更😀".repeat(12_000));
                    assertEquals(1, update.executeUpdate());
                }
                try (var statement = other.createStatement()) { assertEquals(1, statement.executeUpdate("DELETE FROM " + table + " WHERE ID = 1")); }
                StringBuilder complete = new StringBuilder();
                long offset = 0;
                while (true) {
                    var chunk = values.fetch(connection, preview.ref(), offset, 4096);
                    assertEquals("ok", chunk.status());
                    complete.append(chunk.data());
                    if (chunk.eof()) break;
                    offset = chunk.next_offset();
                }
                assertEquals(original, complete.toString());
                values.clear();
                assertEquals("expired", values.fetch(connection, preview.ref(), 0, 4096).status());
            } finally {
                values.clear();
                if (created) try (var statement = connection.createStatement()) { statement.execute("DROP TABLE " + table + " PURGE"); }
            }
        }
    }
}
