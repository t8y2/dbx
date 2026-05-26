package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

final class DbxJdbcPluginTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String CONNECTION = """
        {
          "connection_string": "jdbc:h2:mem:dbx_ctx;DB_CLOSE_DELAY=-1",
          "username": "sa"
        }
        """;

    @AfterEach
    void closeConnection() throws Exception {
        request("close", """
            { "connection": %s }
            """.formatted(CONNECTION));
    }

    @Test
    void executeQueryAppliesSchemaContext() throws Exception {
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE SCHEMA IF NOT EXISTS app"
            }
            """.formatted(CONNECTION));

        JsonNode response = request("executeQuery", """
            {
              "connection": %s,
              "schema": "APP",
              "sql": "SELECT SCHEMA() AS schema_name"
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals("APP", response.path("result").path("rows").path(0).path(0).asText());
    }

    @Test
    void executeQueryTrimsSingleTrailingSemicolon() throws Exception {
        JsonNode response = request("executeQuery", """
            {
              "connection": %s,
              "sql": "SELECT 1 AS n;"
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals(1, response.path("result").path("rows").path(0).path(0).asInt());
    }

    @Test
    void executeQueryFormatsBinaryColumnsAsHex() throws Exception {
        JsonNode response = request("executeQuery", """
            {
              "connection": %s,
              "sql": "SELECT X'0001ABFF' AS payload"
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals("0x0001abff", response.path("result").path("rows").path(0).path(0).asText());
    }

    @Test
    void driverQuirksDetectYashanJdbcUrl() throws Exception {
        JsonNode yashan = MAPPER.readTree("""
            {
              "connection_string": "jdbc:yasdb://172.26.128.159:20027/yasdb"
            }
            """);
        JsonNode h2 = MAPPER.readTree("""
            {
              "connection_string": "jdbc:h2:mem:dbx_quirks"
            }
            """);

        assertEquals(true, DbxJdbcPlugin.driverQuirks(yashan).skipExecutionContext());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(yashan).useOracleMetadata());
        assertEquals(false, DbxJdbcPlugin.driverQuirks(h2).skipExecutionContext());
        assertEquals(false, DbxJdbcPlugin.driverQuirks(h2).useOracleMetadata());
    }

    @Test
    void listTablesFallsBackWhenCatalogFiltersEverything() throws Exception {
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE SCHEMA IF NOT EXISTS app"
            }
            """.formatted(CONNECTION));
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE TABLE IF NOT EXISTS app.people (id INT PRIMARY KEY, name VARCHAR(30))"
            }
            """.formatted(CONNECTION));

        JsonNode response = request("listTables", """
            {
              "connection": %s,
              "database": "UNRELATED_CATALOG",
              "schema": "APP"
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals("PEOPLE", response.path("result").path(0).path("name").asText());
    }

    @Test
    void listDatabasesIncludesConfiguredDatabaseWhenDriverDoesNotReturnIt() throws Exception {
        String connection = """
            {
              "connection_string": "jdbc:h2:mem:dbx_catalog;DB_CLOSE_DELAY=-1",
              "username": "sa",
              "database": "DBX_DEMO"
            }
            """;

        JsonNode response = request("listDatabases", """
            { "connection": %s }
            """.formatted(connection));

        assertFalse(response.has("error"), response.toString());
        boolean found = false;
        for (JsonNode database : response.path("result")) {
            if ("DBX_DEMO".equals(database.path("name").asText())) {
                found = true;
                break;
            }
        }
        assertEquals(true, found);
    }

    @Test
    void listObjectsAcceptsCamelCaseMethodAndFallsBackWhenCatalogFiltersEverything() throws Exception {
        createPeopleTable();

        JsonNode response = request("listObjects", """
            {
              "connection": %s,
              "database": "UNRELATED_CATALOG",
              "schema": "APP"
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals("PEOPLE", response.path("result").path(0).path("name").asText());
    }

    @Test
    void getColumnsFallsBackWhenCatalogFiltersEverything() throws Exception {
        createPeopleTable();

        JsonNode response = request("getColumns", """
            {
              "connection": %s,
              "database": "UNRELATED_CATALOG",
              "schema": "APP",
              "table": "PEOPLE"
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals("ID", response.path("result").path(0).path("name").asText());
        assertEquals(true, response.path("result").path(0).path("is_primary_key").asBoolean());
    }

    private static void createPeopleTable() throws Exception {
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE SCHEMA IF NOT EXISTS app"
            }
            """.formatted(CONNECTION));
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE TABLE IF NOT EXISTS app.people (id INT PRIMARY KEY, name VARCHAR(30))"
            }
            """.formatted(CONNECTION));
    }

    private static JsonNode request(String method, String params) throws Exception {
        Method handleLine = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handleLine.setAccessible(true);
        String line = """
            { "id": 1, "method": "%s", "params": %s }
            """.formatted(method, params);
        return MAPPER.valueToTree(handleLine.invoke(null, line));
    }
}
