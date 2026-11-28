package com.dbx.agent.firebird;

import com.dbx.agent.ConnectParams;
import java.sql.SQLException;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import static org.junit.jupiter.api.Assertions.*;

@EnabledIfEnvironmentVariable(named = "DBX_FIREBIRD_JDBC_URL", matches = ".+")
class FirebirdViewSourceIntegrationTest {
    @Test
    void editsAnExistingViewAndPreservesItsCatalogDefinition() {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String table = "DBX_VIEW_TEST_" + suffix;
        String name = "Dbx View " + suffix;
        String view = "\"" + name + "\"";
        String uppercaseView = "\"" + name.toUpperCase(Locale.ROOT) + "\"";
        String columns = "(\"Item ID\", \"Total\"\"Score\")";
        FirebirdAgent agent = new FirebirdAgent();
        agent.connect(new ConnectParams("", 0, "", System.getenv().getOrDefault("DBX_FIREBIRD_USER", "SYSDBA"),
            System.getenv("DBX_FIREBIRD_PASSWORD"), "", System.getenv("DBX_FIREBIRD_JDBC_URL"), false));
        try {
            agent.executeQuery("CREATE TABLE " + table + " (ID INTEGER PRIMARY KEY, SCORE INTEGER)", null);
            try {
                agent.executeQuery("INSERT INTO " + table + " VALUES (1, 10)", null);
                agent.executeQuery("INSERT INTO " + table + " VALUES (2, 20)", null);
                agent.executeQuery("CREATE VIEW " + uppercaseView + " AS SELECT ID FROM " + table, null);
                try {
                    var fallback = agent.getObjectSource("", name.toLowerCase(Locale.ROOT), "VIEW");
                    assertTrue(fallback.getSource().startsWith("CREATE OR ALTER VIEW " + uppercaseView + " (\"ID\") AS\n"));
                    agent.executeQuery("CREATE VIEW " + view + " " + columns + " AS SELECT ID, SCORE FROM " + table
                        + " WHERE SCORE >= 10 WITH CHECK OPTION", null);
                    try {
                        var source = agent.getObjectSource("", name, "VIEW");
                        assertTrue(source.isEditable());
                        assertTrue(source.getSource().startsWith("CREATE OR ALTER VIEW " + view + " " + columns + " AS\n"));
                        assertTrue(source.getSource().contains("WITH CHECK OPTION"));
                        assertEquals(2, agent.executeQuery("SELECT * FROM " + view, null).getRows().size());

                        agent.executeQuery(source.getSource().replace("SCORE >= 10", "SCORE >= 20"), null);

                        var reloaded = agent.getObjectSource("", name, "VIEW");
                        assertTrue(reloaded.getSource().contains("SCORE >= 20 WITH CHECK OPTION"));
                        assertEquals(List.of(List.of(2, 20)), agent.executeQuery(
                            "SELECT \"Item ID\", \"Total\"\"Score\" FROM " + view, null).getRows());
                        var rejected = assertThrows(RuntimeException.class, () -> agent.executeQuery("INSERT INTO " + view
                            + " (\"Item ID\", \"Total\"\"Score\") VALUES (3, 10)", null));
                        assertEquals("23000", assertInstanceOf(SQLException.class, rejected.getCause()).getSQLState());
                    } finally {
                        agent.executeQuery("DROP VIEW " + view, null);
                    }
                    var missing = agent.getObjectSource("", "DBX_MISSING_" + suffix, "VIEW");
                    assertFalse(missing.isEditable());
                    assertEquals("", missing.getSource());
                } finally {
                    agent.executeQuery("DROP VIEW " + uppercaseView, null);
                }
            } finally {
                agent.executeQuery("DROP TABLE " + table, null);
            }
        } finally {
            agent.disconnect();
        }
    }
}
