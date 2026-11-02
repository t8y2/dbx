package com.dbx.agent.gbase8s;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Real-instance check for column defaults loaded from sysdefaults: literal defaults of
 * non-character columns are stored 6-bit encoded and must come back decoded through
 * gbasedbt.get_default_value, character literals keep their quotes, and NULL /
 * expression defaults surface through their own catalogs.
 *
 * NOTE: keyword defaults (USER / CURRENT / TODAY / DBSERVERNAME) are not created here
 * because the pinned GBase JDBC driver cannot express them in DDL through the sqli
 * gateway: DEFAULT USER / DEFAULT CURRENT ... are rejected with a syntax error, and
 * DEFAULT TODAY / DEFAULT DBSERVERNAME get rewritten by the driver into sysdefaults
 * type 'E' expression rows instead of the T / S marker rows a dbaccess-created table
 * has. Their keyword mapping is covered by
 * Gbase8sAgentTest.defaultClassKeywordMapsInformixDefaultClauseKeywords and was
 * verified against a real instance (dbaccess-created markers read back as
 * TODAY / USER / CURRENT / NULL).
 *
 * Run with DBX_TEST_GBASE8S_URL / DBX_TEST_GBASE8S_USER / DBX_TEST_GBASE8S_PASSWORD set.
 */
class Gbase8sColumnDefaultsLiveTest {
    @Test
    @EnabledIfEnvironmentVariable(named = "DBX_TEST_GBASE8S_URL", matches = ".+")
    void columnDefaultsAreDecodedAndQuotedPerColumnType() throws Exception {
        String table = "dbx_defaults_" + UUID.randomUUID().toString().replace("-", "");
        Gbase8sAgent agent = new Gbase8sAgent();
        agent.connect(new ConnectParams(
            "", 0, "", System.getenv("DBX_TEST_GBASE8S_USER"), System.getenv("DBX_TEST_GBASE8S_PASSWORD"),
            "", System.getenv("DBX_TEST_GBASE8S_URL"), false
        ));
        try (var statement = agent.getConnection().createStatement()) {
            try {
                statement.execute("CREATE TABLE " + table + " ("
                    + "int_col INTEGER DEFAULT 0, "
                    + "dec_col DECIMAL(10,2) DEFAULT 1.5, "
                    + "vc_col VARCHAR(20) DEFAULT 'abc', "
                    + "null_col INTEGER DEFAULT NULL, "
                    + "expr_col INTEGER DEFAULT (1 + 2))");
                List<ColumnInfo> columns = agent.getColumns("", table);
                Map<String, String> defaults = new LinkedHashMap<>();
                for (ColumnInfo column : columns) {
                    defaults.put(column.getName(), column.getColumn_default());
                }
                Assertions.assertEquals("0", defaults.get("int_col"), () -> String.valueOf(defaults));
                // The builtin decodes DECIMAL literals; the exact scale padding
                // (observed "1.5000000000" standalone, "1.5" inside the CASE)
                // is server-defined.
                Assertions.assertTrue(defaults.get("dec_col").startsWith("1.5"), () -> String.valueOf(defaults));
                Assertions.assertEquals("'abc'", defaults.get("vc_col"), () -> String.valueOf(defaults));
                Assertions.assertEquals("NULL", defaults.get("null_col"), () -> String.valueOf(defaults));
                Assertions.assertNotNull(defaults.get("expr_col"), () -> String.valueOf(defaults));
            } finally {
                try {
                    statement.execute("DROP TABLE " + table);
                } catch (Exception e) {
                    System.err.println("DROP failed: " + e.getMessage());
                }
            }
        } finally {
            agent.disconnect();
        }
    }
}
