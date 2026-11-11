package com.dbx.agent.firebird;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.QueryPageOptions;
import java.nio.charset.Charset;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import static org.junit.jupiter.api.Assertions.*;

/** Opt-in checks against an isolated Firebird database; no user data is needed in the repository. */
class FirebirdLegacyTextIntegrationTest {
    @Test
    @EnabledIfEnvironmentVariable(named = "DBX_FIREBIRD_JDBC_URL", matches = ".+")
    void standardUnicodeConnectionsKeepTheirEncoding() {
        FirebirdAgent agent = new FirebirdAgent();
        try {
            for (String options : List.of("", "charSet=UTF8", "charSet=UTF8&dataCharset=GBK")) {
                ConnectParams params = new ConnectParams("", 0, "", user(), password(), "",
                    JdbcAgentProfile.appendUrlParams(System.getenv("DBX_FIREBIRD_JDBC_URL"), options), false);
                agent.connect(params);
                assertEquals("中文😀", agent.executeQuery(
                    "SELECT CAST('中文😀' AS VARCHAR(32) CHARACTER SET UTF8) FROM RDB$DATABASE", null).getRows().get(0).get(0));
            }
        } finally {
            agent.disconnect();
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "DBX_FIREBIRD_JDBC_URL", matches = ".+")
    void legacyTextSurvivesEverySqlExecutionPathAndReconnect() throws Exception {
        for (String charsetName : List.of("GBK", "GB18030", "Big5")) {
            Charset charset = Charset.forName(charsetName);
            assertTrue(charset.newEncoder().canEncode("中文修改中文交易中文批次中文分頁中文備註"));
            String table = "DBX_LEGACY_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            try (Connection inspector = rawConnection("DBX_FIREBIRD_JDBC_URL");
                 Statement setup = inspector.createStatement()) {
                setup.executeUpdate("CREATE TABLE " + table
                    + " (ID INTEGER NOT NULL PRIMARY KEY, VALUE_TEXT VARCHAR(64) CHARACTER SET ISO8859_1,"
                    + " NOTE_TEXT BLOB SUB_TYPE TEXT CHARACTER SET ISO8859_1)");
                FirebirdAgent agent = new FirebirdAgent();
                try {
                    try (PreparedStatement seed = inspector.prepareStatement(
                        "INSERT INTO " + table + " (ID, VALUE_TEXT) VALUES (1, ?)")) {
                        seed.setBytes(1, "中文".getBytes(charset));
                        seed.executeUpdate();
                    }
                    ConnectParams params = params("DBX_FIREBIRD_JDBC_URL", charsetName);
                    assertEquals(Boolean.TRUE, agent.testConnectionWithInfo(params).get("ok"));
                    agent.connect(params);
                    assertEquals("中文", text(agent, table));

                    agent.executeQuery("UPDATE " + table + " SET VALUE_TEXT = '中文修改' WHERE ID = 1", null);
                    assertStoredBytes(inspector, table, "中文修改", charset);
                    assertEquals("中文修改", text(agent, table));

                    assertEquals(1, agent.executeTransaction(List.of("UPDATE " + table
                        + " SET VALUE_TEXT = '中文交易' WHERE ID = 1 AND VALUE_TEXT = '中文修改'"), null).getAffected_rows());
                    assertStoredBytes(inspector, table, "中文交易", charset);
                    assertEquals("中文交易", text(agent, table));

                    agent.executeBatch(List.of("UPDATE " + table + " SET VALUE_TEXT = '中文批次' WHERE ID = 1"), null);
                    assertStoredBytes(inspector, table, "中文批次", charset);
                    assertEquals("中文批次", text(agent, table));

                    var page = agent.executeQueryPage("UPDATE " + table
                        + " SET VALUE_TEXT = '中文分頁' WHERE ID = 1 RETURNING VALUE_TEXT", null, new QueryPageOptions());
                    assertEquals("中文分頁", page.getRows().get(0).get(0));
                    if (page.getSession_id() != null) agent.closeQuerySession(page.getSession_id());
                    assertStoredBytes(inspector, table, "中文分頁", charset);

                    agent.executeQuery("UPDATE " + table + " SET NOTE_TEXT = '中文備註' WHERE ID = 1", null);
                    assertEquals("中文備註", agent.executeQuery("SELECT NOTE_TEXT FROM " + table, null).getRows().get(0).get(0));

                    agent.disconnect();
                    agent.connect(params);
                    assertEquals("中文分頁", text(agent, table));
                    agent.executeQuery("UPDATE " + table + " SET VALUE_TEXT = NULL WHERE ID = 1", null);
                    assertNull(text(agent, table));
                    agent.executeQuery("UPDATE " + table + " SET VALUE_TEXT = 'ASCII' WHERE ID = 1", null);
                    assertEquals("ASCII", text(agent, table));
                } finally {
                    agent.disconnect();
                    setup.executeUpdate("DROP TABLE " + table);
                }
            }
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "DBX_FIREBIRD_BARCODE_JDBC_URL", matches = ".+")
    void barcodeColorUpdatePreservesGbkBytes() throws Exception {
        Charset gbk = Charset.forName("GBK");
        try (Connection inspector = rawConnection("DBX_FIREBIRD_BARCODE_JDBC_URL");
             PreparedStatement read = inspector.prepareStatement("SELECT \"Name\" FROM \"SYS_Color\" WHERE \"ID\" = 1");
             PreparedStatement restore = inspector.prepareStatement("UPDATE \"SYS_Color\" SET \"Name\" = ? WHERE \"ID\" = 1")) {
            byte[] original;
            try (ResultSet result = read.executeQuery()) {
                assertTrue(result.next());
                original = result.getBytes(1);
            }
            FirebirdAgent agent = new FirebirdAgent();
            try {
                agent.connect(params("DBX_FIREBIRD_BARCODE_JDBC_URL", "GBK"));
                assertEquals(new String(original, gbk),
                    agent.executeQuery("SELECT \"Name\" FROM \"SYS_Color\" WHERE \"ID\" = 1", null).getRows().get(0).get(0));
                for (boolean transaction : List.of(false, true)) {
                    String sql = "UPDATE \"SYS_Color\" SET \"Name\" = '中文修改' WHERE \"ID\" = 1";
                    if (transaction) agent.executeTransaction(List.of(sql), null);
                    else agent.executeQuery(sql, null);
                    try (ResultSet result = read.executeQuery()) {
                        assertTrue(result.next());
                        assertArrayEquals("中文修改".getBytes(gbk), result.getBytes(1));
                    }
                    agent.disconnect();
                    agent.connect(params("DBX_FIREBIRD_BARCODE_JDBC_URL", "GBK"));
                    assertEquals("中文修改",
                        agent.executeQuery("SELECT \"Name\" FROM \"SYS_Color\" WHERE \"ID\" = 1", null).getRows().get(0).get(0));
                }
            } finally {
                agent.disconnect();
                restore.setBytes(1, original);
                restore.executeUpdate();
            }
        }
    }

    private static ConnectParams params(String urlVariable, String charset) {
        return new ConnectParams("", 0, "", user(), password(), "",
            JdbcAgentProfile.appendUrlParams(System.getenv(urlVariable), "charSet=ISO8859_1&dataCharset=" + charset), false);
    }

    private static Connection rawConnection(String urlVariable) throws Exception {
        return DriverManager.getConnection(JdbcAgentProfile.appendUrlParams(System.getenv(urlVariable), "charSet=ISO8859_1"),
            user(), password());
    }

    private static String user() {
        return System.getenv().getOrDefault("DBX_FIREBIRD_USER", "SYSDBA");
    }

    private static String password() {
        return System.getenv("DBX_FIREBIRD_PASSWORD");
    }

    private static Object text(FirebirdAgent agent, String table) {
        return agent.executeQuery("SELECT VALUE_TEXT FROM " + table + " WHERE ID = 1", null).getRows().get(0).get(0);
    }

    private static void assertStoredBytes(Connection inspector, String table, String expected, Charset charset) throws Exception {
        try (Statement statement = inspector.createStatement();
             ResultSet result = statement.executeQuery("SELECT VALUE_TEXT FROM " + table + " WHERE ID = 1")) {
            assertTrue(result.next());
            assertArrayEquals(expected.getBytes(charset), result.getBytes(1));
        }
    }
}
