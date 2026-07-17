package com.dbx.agent.access;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.test.JdbcConnectedAgentTest;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AccessAgentTest extends JdbcConnectedAgentTest {
    @TempDir
    Path tempDir;

    @Override
    protected DatabaseAgent createConnectedAgent(String databaseName) {
        Path file = tempDir.resolve(databaseName + ".accdb");
        AccessAgent agent = new AccessAgent();
        agent.connect(new ConnectParams("", 0, file.toString(), "", "", "", "", false));
        return agent;
    }

    @Test
    void connectsToAnAccessFileAndReturnsTableMetadata() {
        withAgent("metadata", agent -> {
            agent.executeQuery(
                "CREATE TABLE People (ID COUNTER PRIMARY KEY, Name TEXT(64), Active YESNO)",
                null,
                new ExecuteQueryOptions()
            );
            agent.executeQuery("INSERT INTO People (Name, Active) VALUES ('Ada', TRUE)", null, new ExecuteQueryOptions());

            var tables = agent.listTables("");
            var columns = agent.getColumns("", "People");
            var result = agent.executeQuery("SELECT Name, Active FROM People", null, new ExecuteQueryOptions());

            Assertions.assertTrue(tables.stream().anyMatch(table -> table.getName().equals("People")));
            Assertions.assertEquals(List.of("ID", "Name", "Active"), columns.stream().map(column -> column.getName()).toList());
            Assertions.assertTrue(columns.stream()
                .filter(column -> column.getName().equals("ID"))
                .findFirst()
                .orElseThrow()
                .getIs_primary_key());
            Assertions.assertEquals(List.of("Name", "Active"), result.getColumns());
            Assertions.assertEquals("Ada", result.getRows().get(0).get(0));
            Assertions.assertEquals(true, result.getRows().get(0).get(1));
        });
    }

    @Test
    void returnsEmptySchemaListForAccessFiles() {
        withAgent("schemas", agent -> {
            Assertions.assertEquals(List.of(), agent.listSchemas());
            Assertions.assertFalse(agent.testConnection(
                new ConnectParams("", 0, tempDir.resolve("missing.accdb").toString(), "", "", "", "", false)
            ));
        });
    }

    @Test
    void appendsUcanaccessUrlParams() {
        Path file = tempDir.resolve("params.accdb");
        ConnectParams params = new ConnectParams("", 0, file.toString(), "", "", "memory=false;ignoreCase=true", "", false);

        Assertions.assertEquals(
            "jdbc:ucanaccess://" + file + ";memory=false;ignoreCase=true;jackcessOpener=com.dbx.agent.access.EncryptedAccessOpener;newDatabaseVersion=V2010",
            AccessAgent.jdbcUrl(params, true)
        );
    }

    @Test
    void trimsUcanaccessUrlParamSeparators() {
        Path file = tempDir.resolve("params-existing.accdb");
        ConnectParams params = new ConnectParams("", 0, "jdbc:ucanaccess://" + file + ";", "", "", ";memory=false", "", false);

        Assertions.assertEquals(
            "jdbc:ucanaccess://" + file + ";memory=false;jackcessOpener=com.dbx.agent.access.EncryptedAccessOpener;newDatabaseVersion=V2010",
            AccessAgent.jdbcUrl(params, true)
        );
    }

    @Test
    void preservesCustomJackcessOpener() {
        Path file = tempDir.resolve("custom-opener.accdb");
        ConnectParams params = new ConnectParams(
            "", 0, file.toString(), "", "", "jackcessOpener=example.CustomOpener", "", false
        );

        Assertions.assertEquals(
            "jdbc:ucanaccess://" + file + ";jackcessOpener=example.CustomOpener;newDatabaseVersion=V2010",
            AccessAgent.jdbcUrl(params, true)
        );
    }

    @Test
    void connectsToEncryptedAccessFile() throws Exception {
        Path source = Path.of(getClass().getResource("/db2007-enc.accdb").toURI());
        Path file = tempDir.resolve("encrypted.accdb");
        Files.copy(source, file);
        AccessAgent agent = new AccessAgent();

        try {
            agent.connect(new ConnectParams("", 0, file.toString(), "", "Test123", "", "", false));
            Assertions.assertFalse(agent.listTables("").isEmpty());
        } finally {
            agent.disconnect();
        }
    }

    @Test
    void rejectsIncorrectEncryptedAccessPassword() throws Exception {
        Path source = Path.of(getClass().getResource("/db2007-enc.accdb").toURI());
        Path file = tempDir.resolve("encrypted-wrong-password.accdb");
        Files.copy(source, file);
        AccessAgent agent = new AccessAgent();

        RuntimeException error = Assertions.assertThrows(RuntimeException.class, () ->
            agent.connect(new ConnectParams("", 0, file.toString(), "", "wrong", "", "", false))
        );
        Assertions.assertTrue(error.getMessage().contains("Incorrect password provided"));
    }

    @Test
    void supportsLimitOffsetSqlAndCursorResultPages() {
        withAgent("pages", agent -> {
            agent.executeQuery("CREATE TABLE Items (ID COUNTER PRIMARY KEY, Value INTEGER)", null, new ExecuteQueryOptions());
            for (int i = 1; i <= 5; i++) {
                agent.executeQuery("INSERT INTO Items (Value) VALUES (" + i + ")", null, new ExecuteQueryOptions());
            }

            var limited = agent.executeQuery(
                "SELECT [Value] FROM [Items] ORDER BY [ID] LIMIT 2 OFFSET 1",
                null,
                new ExecuteQueryOptions()
            );
            var firstPage = agent.executeQueryPage(
                "SELECT Value FROM Items ORDER BY ID",
                null,
                new QueryPageOptions(2, null, 5)
            );
            String sessionId = firstPage.getSession_id();
            Assertions.assertNotNull(sessionId);
            var secondPage = agent.fetchQueryPage(sessionId, 2);

            Assertions.assertEquals(List.of(2, 3), limited.getRows().stream().map(row -> row.get(0)).toList());
            Assertions.assertEquals(List.of(1, 2), firstPage.getRows().stream().map(row -> row.get(0)).toList());
            Assertions.assertEquals(true, firstPage.getHas_more());
            Assertions.assertEquals(List.of(3, 4), secondPage.getRows().stream().map(row -> row.get(0)).toList());
        });
    }
}
