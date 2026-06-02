package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.lang.reflect.Method;
import java.util.Properties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

final class DbxJdbcPluginTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String CONNECTION = """
        {
          "connection_string": "jdbc:h2:mem:dbx_ctx;DB_CLOSE_DELAY=-1",
          "username": "sa",
          "connect_timeout_secs": 30
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
    void executeQueryPreservesChineseTextValues() throws Exception {
        JsonNode response = request("executeQuery", """
            {
              "connection": %s,
              "sql": "SELECT '中文测试' AS label"
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals("中文测试", response.path("result").path("rows").path(0).path(0).asText());
    }

    @Test
    void executeQueryHonorsMaxRowsAndAcceptsExecutionOptions() throws Exception {
        JsonNode response = request("executeQuery", """
            {
              "connection": %s,
              "sql": "SELECT * FROM (VALUES (1), (2)) AS t(n)",
              "maxRows": 1,
              "fetchSize": 1,
              "timeoutSecs": 60
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals(1, response.path("result").path("rows").size());
        assertEquals(true, response.path("result").path("truncated").asBoolean());
    }

    @Test
    void connectTimeoutIsMappedToDriverProperties() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("applyConnectTimeout", JsonNode.class, Properties.class);
        method.setAccessible(true);
        Properties properties = new Properties();
        JsonNode connection = MAPPER.readTree("""
            { "connect_timeout_secs": 45 }
            """);

        method.invoke(null, connection, properties);

        assertEquals("45", properties.getProperty("loginTimeout"));
        assertEquals("45", properties.getProperty("connectTimeout"));
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
    void sqliteCipherUrlUsesPasswordAsKeyWhenKeyIsMissing() {
        String url = DbxJdbcPlugin.jdbcUrlWithPasswordKey(
            "jdbc:sqlite:/tmp/library.db?cipher=chacha20",
            "my password"
        );

        assertEquals("jdbc:sqlite:/tmp/library.db?cipher=chacha20&key=my+password", url);
    }

    @Test
    void sqliteCipherUrlKeepsExplicitKey() {
        String url = DbxJdbcPlugin.jdbcUrlWithPasswordKey(
            "jdbc:sqlite:/tmp/library.db?cipher=chacha20&key=from-url",
            "from-password"
        );

        assertEquals("jdbc:sqlite:/tmp/library.db?cipher=chacha20&key=from-url", url);
    }

    @Test
    void nonSqliteUrlDoesNotUsePasswordAsKey() {
        String url = DbxJdbcPlugin.jdbcUrlWithPasswordKey(
            "jdbc:h2:mem:dbx_cipher?cipher=sqlcipher",
            "secret"
        );

        assertEquals("jdbc:h2:mem:dbx_cipher?cipher=sqlcipher", url);
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

    @Test
    void oracleMetadataObjectTypeAcceptsPackageBodyAliases() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("oracleMetadataObjectType", String.class);
        method.setAccessible(true);

        assertEquals("PACKAGE_BODY", method.invoke(null, "PACKAGE BODY"));
        assertEquals("PACKAGE_BODY", method.invoke(null, "PACKAGE_BODY"));
        assertEquals("PACKAGE", method.invoke(null, "PACKAGE"));
    }

    @Test
    void oracleEffectiveSchemaUsesExactOwnerBeforeUppercaseFallback() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("oracleEffectiveSchema", Connection.class, String.class);
        method.setAccessible(true);

        try (Connection conn = DriverManager.getConnection("jdbc:h2:mem:dbx_oracle_owner;DB_CLOSE_DELAY=-1", "sa", "")) {
            conn.createStatement().execute("CREATE TABLE all_users (username VARCHAR(64))");
            conn.createStatement().execute("INSERT INTO all_users(username) VALUES ('mixed_owner'), ('SYSDBA')");

            assertEquals("mixed_owner", method.invoke(null, conn, "mixed_owner"));
            assertEquals("SYSDBA", method.invoke(null, conn, "sysdba"));
        }
    }

    @Test
    void oracleResolveTableUsesExactNameBeforeUppercaseFallback() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("oracleResolveTable", Connection.class, String.class, String.class);
        method.setAccessible(true);

        try (Connection conn = DriverManager.getConnection("jdbc:h2:mem:dbx_oracle_table;DB_CLOSE_DELAY=-1", "sa", "")) {
            conn.createStatement().execute("CREATE TABLE all_tab_comments (owner VARCHAR(64), table_name VARCHAR(64))");
            conn.createStatement().execute(
                "INSERT INTO all_tab_comments(owner, table_name) VALUES ('SYSDBA', 'mixed_table'), ('SYSDBA', 'ORDERS')"
            );

            assertEquals("mixed_table", method.invoke(null, conn, "SYSDBA", "mixed_table"));
            assertEquals("ORDERS", method.invoke(null, conn, "SYSDBA", "orders"));
        }
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
