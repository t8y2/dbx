package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Date;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.sql.Time;
import java.sql.Timestamp;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

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
    void reportsDriverLinkageErrorsWithoutTerminatingThePlugin() throws Exception {
        JsonNode response = request("testConnection", """
            {
              "connection": {
                "connection_string": "jdbc:broken:test",
                "jdbc_driver_class": "app.dbx.jdbc.DbxJdbcPluginTest$ErrorOnLoad"
              }
            }
            """);

        assertEquals("linkage boom", response.path("error").path("message").asText());
    }

    @Test
    void reportsInformativeOuterMessageWhenRootCauseHasNoMessage() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("throwableMessage", Throwable.class);
        method.setAccessible(true);
        RuntimeException root = new RuntimeException();
        SQLException outer = new SQLException("MCP initialization failed: Cannot run program npx", root);

        assertEquals("MCP initialization failed: Cannot run program npx", method.invoke(null, outer));
    }

    @Test
    void reportsActionableMessageForMissingJdbcxMcpRuntime() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("throwableMessage", Throwable.class);
        method.setAccessible(true);
        SQLException outer = new SQLException(new ClassNotFoundException("io.modelcontextprotocol.spec.McpError"));

        assertEquals(
            "Missing JDBCX MCP runtime class io.modelcontextprotocol.spec.McpError. "
                + "Install io.github.jdbcx:io.modelcontextprotocol with the version required by the selected JDBCX runtime.",
            method.invoke(null, outer)
        );
    }

    @Test
    void testConnectionAndConnectionInfoExposeH2Metadata() throws Exception {
        JsonNode tested = request("testConnection", """
            { "connection": %s }
            """.formatted(CONNECTION));
        assertDatabaseInfo(tested.path("result").path("databaseInfo"));

        request("connect", """
            { "connection": %s }
            """.formatted(CONNECTION));
        JsonNode connected = request("connectionInfo", """
            { "connection": %s }
            """.formatted(CONNECTION));
        assertDatabaseInfo(connected.path("result").path("databaseInfo"));
    }

    @Test
    void databaseInfoKeepsSupportedFieldsWhenOneMetadataGetterFails() throws Exception {
        DatabaseMetaData metadata = (DatabaseMetaData) Proxy.newProxyInstance(
            DatabaseMetaData.class.getClassLoader(),
            new Class<?>[]{DatabaseMetaData.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "getDatabaseProductName" -> "ExampleDB";
                case "getDatabaseProductVersion" -> throw new SQLFeatureNotSupportedException("version unavailable");
                case "storesLowerCaseIdentifiers" -> throw new UnsupportedOperationException("case unavailable");
                case "storesUpperCaseIdentifiers" -> true;
                case "storesMixedCaseQuotedIdentifiers" -> true;
                case "getDriverName" -> "Example JDBC";
                case "getDriverVersion" -> "1.2.3";
                case "getJDBCMajorVersion" -> 4;
                case "getJDBCMinorVersion" -> 2;
                default -> defaultValue(method.getReturnType());
            }
        );
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("databaseInfo", DatabaseMetaData.class);
        method.setAccessible(true);

        JsonNode info = MAPPER.valueToTree(method.invoke(null, metadata));

        assertEquals("ExampleDB", info.path("productName").asText());
        assertFalse(info.has("productVersion"));
        assertEquals("upper", info.path("unquotedIdentifierCase").asText());
        assertEquals("mixed", info.path("quotedIdentifierCase").asText());
        assertEquals("Example JDBC", info.path("driverName").asText());
        assertEquals("1.2.3", info.path("driverVersion").asText());
        assertEquals("4.2", info.path("jdbcVersion").asText());
    }

    private static void assertDatabaseInfo(JsonNode info) {
        assertEquals("H2", info.path("productName").asText());
        assertFalse(info.path("productVersion").asText().isEmpty());
        assertEquals("upper", info.path("unquotedIdentifierCase").asText());
        assertFalse(info.has("quotedIdentifierCase"));
        assertFalse(info.path("driverName").asText().isEmpty());
        assertFalse(info.path("driverVersion").asText().isEmpty());
        assertFalse(info.path("jdbcVersion").asText().isEmpty());
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
    void executeQueryPageKeepsCursorForNextPages() throws Exception {
        JsonNode first = request("executeQueryPage", """
            {
              "connection": %s,
              "sql": "SELECT X FROM SYSTEM_RANGE(1, 5)",
              "pageSize": 2,
              "maxRows": 10
            }
            """.formatted(CONNECTION));

        assertFalse(first.has("error"), first.toString());
        assertEquals(1, first.path("result").path("rows").path(0).path(0).asInt());
        assertEquals(2, first.path("result").path("rows").path(1).path(0).asInt());
        assertEquals(true, first.path("result").path("has_more").asBoolean());
        String sessionId = first.path("result").path("session_id").asText();

        JsonNode second = request("fetchQueryPage", """
            {
              "connection": %s,
              "sessionId": "%s",
              "pageSize": 2
            }
            """.formatted(CONNECTION, sessionId));

        assertFalse(second.has("error"), second.toString());
        assertEquals(3, second.path("result").path("rows").path(0).path(0).asInt());
        assertEquals(4, second.path("result").path("rows").path(1).path(0).asInt());
        assertEquals(true, second.path("result").path("has_more").asBoolean());

        JsonNode third = request("fetch_query_page", """
            {
              "connection": %s,
              "sessionId": "%s",
              "pageSize": 2
            }
            """.formatted(CONNECTION, second.path("result").path("session_id").asText()));

        assertFalse(third.has("error"), third.toString());
        assertEquals(5, third.path("result").path("rows").path(0).path(0).asInt());
        assertEquals(false, third.path("result").path("has_more").asBoolean());
        assertEquals(true, third.path("result").path("session_id").isNull());
    }

    @Test
    void readValueFormatsDateColumnsWithoutMidnightTime() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "readValue",
            ResultSet.class,
            ResultSetMetaData.class,
            int.class,
            boolean.class
        );
        method.setAccessible(true);
        List<String> calls = new ArrayList<>();
        ResultSet rs = temporalResultSet(
            Timestamp.valueOf("2026-06-10 00:00:00"),
            Date.valueOf("2026-06-10"),
            calls
        );

        assertEquals("2026-06-10", method.invoke(null, rs, columnMeta(Types.DATE), 1, false));
        assertEquals(List.of("getObject", "getDate"), calls);
    }

    @Test
    void readValuePreservesOracleDateTimeComponent() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "readValue",
            ResultSet.class,
            ResultSetMetaData.class,
            int.class,
            boolean.class
        );
        method.setAccessible(true);
        List<String> calls = new ArrayList<>();
        Timestamp timestamp = Timestamp.valueOf("2026-06-10 12:34:56");
        ResultSet rs = temporalResultSet(timestamp, Date.valueOf("2026-06-10"), calls);

        assertEquals("2026-06-10 12:34:56.0", method.invoke(null, rs, columnMeta(Types.DATE), 1, true));
        assertEquals(List.of("getObject", "getTimestamp"), calls);
    }

    @Test
    void readValuePreservesOracleDateAtMidnight() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "readValue",
            ResultSet.class,
            ResultSetMetaData.class,
            int.class,
            boolean.class
        );
        method.setAccessible(true);
        List<String> calls = new ArrayList<>();
        Timestamp timestamp = Timestamp.valueOf("2026-06-10 00:00:00");
        ResultSet rs = temporalResultSet(timestamp, Date.valueOf("2026-06-10"), calls);

        assertEquals("2026-06-10 00:00:00.0", method.invoke(null, rs, columnMeta(Types.DATE), 1, true));
        assertEquals(List.of("getObject", "getTimestamp"), calls);
    }

    @Test
    void readValueKeepsTimestampTimeComponent() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "readValue",
            ResultSet.class,
            ResultSetMetaData.class,
            int.class,
            boolean.class
        );
        method.setAccessible(true);
        List<String> calls = new ArrayList<>();
        Timestamp timestamp = Timestamp.valueOf("2026-06-10 12:34:56");
        ResultSet rs = temporalResultSet(timestamp, Date.valueOf("2026-06-10"), calls);

        assertEquals("2026-06-10 12:34:56.0", method.invoke(null, rs, columnMeta(Types.TIMESTAMP), 1, false));
        assertEquals(List.of("getObject", "getTimestamp"), calls);
    }

    @Test
    void readValueKeepsTimeColumnsUnchanged() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "readValue",
            ResultSet.class,
            ResultSetMetaData.class,
            int.class,
            boolean.class
        );
        method.setAccessible(true);
        Time time = Time.valueOf("12:34:56");
        ResultSet rs = (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            (proxy, invokedMethod, args) -> switch (invokedMethod.getName()) {
                case "getObject", "getTime" -> time;
                default -> defaultValue(invokedMethod.getReturnType());
            }
        );

        assertEquals("12:34:56", method.invoke(null, rs, columnMeta(Types.TIME), 1, true));
    }

    @Test
    void readValueKeepsNullTemporalValues() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "readValue",
            ResultSet.class,
            ResultSetMetaData.class,
            int.class,
            boolean.class
        );
        method.setAccessible(true);
        List<String> calls = new ArrayList<>();
        ResultSet rs = temporalResultSet(null, null, calls);

        assertEquals(null, method.invoke(null, rs, columnMeta(Types.DATE), 1, true));
        assertEquals(List.of("getObject"), calls);
    }

    @Test
    void executeQueryPreservesOracleDateTimeComponent() throws Exception {
        List<String> calls = new ArrayList<>();
        Driver driver = new OracleDateDriver(
            new Timestamp[] { Timestamp.valueOf("2026-08-12 10:30:03") },
            calls
        );
        DriverManager.registerDriver(driver);
        String connection = """
            { "connection_string": "jdbc:oracle:dbx-date:single" }
            """;
        try {
            JsonNode response = request("executeQuery", """
                {
                  "connection": %s,
                  "sql": "SELECT created_at FROM events"
                }
                """.formatted(connection));

            assertFalse(response.has("error"), response.toString());
            assertEquals("2026-08-12 10:30:03.0", response.path("result").path("rows").path(0).path(0).asText());
            assertEquals(List.of("getTimestamp"), calls);
        } finally {
            closeAndDeregister(connection, driver);
        }
    }

    @Test
    void pagedQueryPreservesOracleDateTimeAcrossPages() throws Exception {
        List<String> calls = new ArrayList<>();
        Driver driver = new OracleDateDriver(
            new Timestamp[] {
                Timestamp.valueOf("2026-08-12 10:30:01"),
                Timestamp.valueOf("2026-08-12 10:30:02"),
                Timestamp.valueOf("2026-08-12 10:30:03")
            },
            calls
        );
        DriverManager.registerDriver(driver);
        String connection = """
            { "connection_string": "jdbc:oracle:dbx-date:paged" }
            """;
        try {
            JsonNode first = request("executeQueryPage", """
                {
                  "connection": %s,
                  "sql": "SELECT created_at FROM events",
                  "pageSize": 1,
                  "maxRows": 10
                }
                """.formatted(connection));

            assertFalse(first.has("error"), first.toString());
            assertEquals("2026-08-12 10:30:01.0", first.path("result").path("rows").path(0).path(0).asText());
            String sessionId = first.path("result").path("session_id").asText();

            JsonNode second = request("fetchQueryPage", """
                {
                  "connection": %s,
                  "sessionId": "%s",
                  "pageSize": 1
                }
                """.formatted(connection, sessionId));
            assertFalse(second.has("error"), second.toString());
            assertEquals("2026-08-12 10:30:02.0", second.path("result").path("rows").path(0).path(0).asText());

            JsonNode third = request("fetchQueryPage", """
                {
                  "connection": %s,
                  "sessionId": "%s",
                  "pageSize": 1
                }
                """.formatted(connection, second.path("result").path("session_id").asText()));
            assertFalse(third.has("error"), third.toString());
            assertEquals("2026-08-12 10:30:03.0", third.path("result").path("rows").path(0).path(0).asText());
            assertEquals(false, third.path("result").path("has_more").asBoolean());
            assertEquals(List.of("getTimestamp", "getTimestamp", "getTimestamp"), calls);
        } finally {
            closeAndDeregister(connection, driver);
        }
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
    void executeQueryFallsBackWhenExecutedStatementReturnsNullResultSet() throws Exception {
        Driver driver = new BrokenResultSetDriver("jdbc:dbx-null-execute-rs:", true, -1);
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("executeQuery", """
                {
                  "connection": {
                    "connection_string": "jdbc:dbx-null-execute-rs:demo",
                    "connect_timeout_secs": 30
                  },
                  "sql": "SELECT v FROM meters"
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("VALUE", response.path("result").path("columns").path(0).asText());
            assertEquals("row-value", response.path("result").path("rows").path(0).path(0).asText());
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void executeQueryFallsBackForQuerySqlWithoutUpdateCount() throws Exception {
        Driver driver = new BrokenResultSetDriver("jdbc:dbx-no-result-flag:", false, -1);
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("executeQuery", """
                {
                  "connection": {
                    "connection_string": "jdbc:dbx-no-result-flag:demo",
                    "connect_timeout_secs": 30
                  },
                  "sql": "-- generated preview\\nSHOW TABLES"
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("row-value", response.path("result").path("rows").path(0).path(0).asText());
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void taosQuerySqlUsesExecuteQueryDirectly() throws Exception {
        List<String> calls = new ArrayList<>();
        Driver driver = new BrokenResultSetDriver("jdbc:taos:", true, -1, calls);
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("executeQuery", """
                {
                  "connection": {
                    "connection_string": "jdbc:taos://dbx-fake:6030/power",
                    "connect_timeout_secs": 30
                  },
                  "sql": "SELECT v FROM meters"
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("row-value", response.path("result").path("rows").path(0).path(0).asText());
            assertEquals(List.of("executeQuery"), calls);
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void connectionUsernameWithMultipleAtSignsIsPassedToDriverProperties() throws Exception {
        RecordingConnectDriver driver = new RecordingConnectDriver("jdbc:dbx-proxysql-form:");
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("testConnection", """
                {
                  "connection": {
                    "connection_string": "jdbc:dbx-proxysql-form://127.0.0.1:6033/example",
                    "username": "xxxxx@db_readonly@127.0.0.1",
                    "password": "p@wd",
                    "connect_timeout_secs": 30
                  }
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("jdbc:dbx-proxysql-form://127.0.0.1:6033/example", driver.urls.get(0));
            assertEquals("xxxxx@db_readonly@127.0.0.1", driver.properties.get(0).getProperty("user"));
            assertEquals("p@wd", driver.properties.get(0).getProperty("password"));
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void jdbcUrlUserParamsWithMultipleAtSignsAreDecodedIntoDriverProperties() throws Exception {
        RecordingConnectDriver driver = new RecordingConnectDriver("jdbc:dbx-proxysql-url:");
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("testConnection", """
                {
                  "connection": {
                    "connection_string": "jdbc:dbx-proxysql-url://127.0.0.1:6033/example?socketTimeout=5&user=xxxxx%40db_readonly%40127.0.0.1&password=p%40wd&useSSL=false",
                    "connect_timeout_secs": 30
                  }
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("jdbc:dbx-proxysql-url://127.0.0.1:6033/example?socketTimeout=5&useSSL=false", driver.urls.get(0));
            assertEquals("xxxxx@db_readonly@127.0.0.1", driver.properties.get(0).getProperty("user"));
            assertEquals("p@wd", driver.properties.get(0).getProperty("password"));
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void jdbcUrlCredentialExtractionKeepsSemicolonInsidePasswordValue() throws Exception {
        RecordingConnectDriver driver = new RecordingConnectDriver("jdbc:dbx-proxysql-semicolon-password:");
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("testConnection", """
                {
                  "connection": {
                    "connection_string": "jdbc:dbx-proxysql-semicolon-password://127.0.0.1:6033/example?password=p;ss&useSSL=false",
                    "connect_timeout_secs": 30
                  }
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("jdbc:dbx-proxysql-semicolon-password://127.0.0.1:6033/example?useSSL=false", driver.urls.get(0));
            assertEquals("p;ss", driver.properties.get(0).getProperty("password"));
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void jdbcUrlCredentialExtractionPreservesDecodedWhitespace() throws Exception {
        RecordingConnectDriver driver = new RecordingConnectDriver("jdbc:dbx-proxysql-space-password:");
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("testConnection", """
                {
                  "connection": {
                    "connection_string": "jdbc:dbx-proxysql-space-password://127.0.0.1:6033/example?user=tenant%40host&password=%20secret%20&useSSL=false",
                    "connect_timeout_secs": 30
                  }
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("jdbc:dbx-proxysql-space-password://127.0.0.1:6033/example?useSSL=false", driver.urls.get(0));
            assertEquals("tenant@host", driver.properties.get(0).getProperty("user"));
            assertEquals(" secret ", driver.properties.get(0).getProperty("password"));
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void explicitConnectionCredentialsOverrideJdbcUrlCredentialParams() throws Exception {
        RecordingConnectDriver driver = new RecordingConnectDriver("jdbc:dbx-proxysql-override:");
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("testConnection", """
                {
                  "connection": {
                    "connection_string": "jdbc:dbx-proxysql-override://127.0.0.1:6033/example?user=url%40tenant&password=url-secret&useSSL=false",
                    "username": "form@tenant@host",
                    "password": "form-secret",
                    "connect_timeout_secs": 30
                  }
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("jdbc:dbx-proxysql-override://127.0.0.1:6033/example?useSSL=false", driver.urls.get(0));
            assertEquals("form@tenant@host", driver.properties.get(0).getProperty("user"));
            assertEquals("form-secret", driver.properties.get(0).getProperty("password"));
        } finally {
            DriverManager.deregisterDriver(driver);
        }
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
    void mysqlConnectTimeoutSecondsAreMappedToMilliseconds() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("applyConnectTimeout", JsonNode.class, Properties.class);
        method.setAccessible(true);
        Properties properties = new Properties();
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:mysql://ddb.example.test:6000/app",
              "jdbc_driver_class": "com.mysql.cj.jdbc.Driver",
              "connect_timeout_secs": 45
            }
            """);

        method.invoke(null, connection, properties);

        assertEquals("45", properties.getProperty("loginTimeout"));
        assertEquals("45000", properties.getProperty("connectTimeout"));
    }

    @Test
    void explicitJdbcUrlConnectTimeoutIsNotOverridden() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("applyConnectTimeout", JsonNode.class, Properties.class);
        method.setAccessible(true);
        Properties properties = new Properties();
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:mysql://ddb.example.test:6000/app?connectTimeout=5000",
              "connect_timeout_secs": 45
            }
            """);

        method.invoke(null, connection, properties);

        assertEquals("45", properties.getProperty("loginTimeout"));
        assertFalse(properties.containsKey("connectTimeout"));
    }

    @Test
    void phoenixConnectionsEnableAutoCommitWhenDriverDefaultsToManualTransactions() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "configurePhoenixAutoCommit",
            JsonNode.class,
            String.class,
            Connection.class
        );
        method.setAccessible(true);
        List<String> calls = new ArrayList<>();
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:phoenix:localhost"
            }
            """);

        method.invoke(null, connection, "jdbc:phoenix:localhost", pagedQueryConnection(calls, false));

        assertEquals(List.of("getAutoCommit", "setAutoCommit:true"), calls);
    }

    @Test
    void phoenixAutoCommitConfigurationSkipsNonPhoenixConnections() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "configurePhoenixAutoCommit",
            JsonNode.class,
            String.class,
            Connection.class
        );
        method.setAccessible(true);
        List<String> calls = new ArrayList<>();
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:h2:mem:dbx"
            }
            """);

        method.invoke(null, connection, "jdbc:h2:mem:dbx", pagedQueryConnection(calls, false));

        assertEquals(List.of(), calls);
    }

    @Test
    void phoenixAutoCommitConfigurationDoesNotResetExistingAutoCommit() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "configurePhoenixAutoCommit",
            JsonNode.class,
            String.class,
            Connection.class
        );
        method.setAccessible(true);
        List<String> calls = new ArrayList<>();
        JsonNode connection = MAPPER.readTree("""
            {
              "jdbc_driver_class": "org.apache.phoenix.jdbc.PhoenixDriver"
            }
            """);

        method.invoke(null, connection, "jdbc:custom:phoenix", pagedQueryConnection(calls, true));

        assertEquals(List.of("getAutoCommit"), calls);
    }

    @Test
    void mysqlPagedQueriesEnableConnectorCursorFetchingByDefault() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "applyPagedFetchProperties",
            JsonNode.class,
            String.class,
            Properties.class
        );
        method.setAccessible(true);
        Properties properties = new Properties();
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:mysql://127.0.0.1:3306/app",
              "jdbc_driver_class": "com.mysql.cj.jdbc.Driver"
            }
            """);

        method.invoke(null, connection, "jdbc:mysql://127.0.0.1:3306/app", properties);

        assertEquals("true", properties.getProperty("useCursorFetch"));
    }

    @Test
    void mysqlPagedQueriesPreserveExplicitCursorFetchSetting() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "applyPagedFetchProperties",
            JsonNode.class,
            String.class,
            Properties.class
        );
        method.setAccessible(true);
        Properties properties = new Properties();
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:mysql://127.0.0.1:3306/app?useCursorFetch=false"
            }
            """);

        method.invoke(
            null,
            connection,
            "jdbc:mysql://127.0.0.1:3306/app?useCursorFetch=false",
            properties
        );

        assertFalse(properties.containsKey("useCursorFetch"));
    }

    @Test
    void postgresPagedQueryUsesCursorTransactionAndRestoresAutoCommit() throws Exception {
        Method begin = DbxJdbcPlugin.class.getDeclaredMethod(
            "beginPagedQueryTransaction",
            JsonNode.class,
            Connection.class
        );
        Method create = DbxJdbcPlugin.class.getDeclaredMethod("createPagedQueryStatement", Connection.class);
        Method restore = DbxJdbcPlugin.class.getDeclaredMethod(
            "restorePagedQueryTransaction",
            Connection.class,
            boolean.class
        );
        begin.setAccessible(true);
        create.setAccessible(true);
        restore.setAccessible(true);
        List<String> calls = new ArrayList<>();
        Connection connection = pagedQueryConnection(calls, true);
        JsonNode config = MAPPER.readTree("""
            { "connection_string": "jdbc:postgresql://127.0.0.1:5432/app" }
            """);

        boolean restoreAutoCommit = (boolean) begin.invoke(null, config, connection);
        create.invoke(null, connection);
        restore.invoke(null, connection, restoreAutoCommit);

        assertEquals(true, restoreAutoCommit);
        assertEquals(
            List.of(
                "getAutoCommit",
                "setAutoCommit:false",
                "createStatement:" + ResultSet.TYPE_FORWARD_ONLY + ":" + ResultSet.CONCUR_READ_ONLY,
                "rollback",
                "setAutoCommit:true"
            ),
            calls
        );
    }

    @Test
    void postgresPagedQueryPreservesExistingManualTransaction() throws Exception {
        Method begin = DbxJdbcPlugin.class.getDeclaredMethod(
            "beginPagedQueryTransaction",
            JsonNode.class,
            Connection.class
        );
        Method restore = DbxJdbcPlugin.class.getDeclaredMethod(
            "restorePagedQueryTransaction",
            Connection.class,
            boolean.class
        );
        begin.setAccessible(true);
        restore.setAccessible(true);
        List<String> calls = new ArrayList<>();
        Connection connection = pagedQueryConnection(calls, false);
        JsonNode config = MAPPER.readTree("""
            { "jdbc_driver_class": "org.postgresql.Driver" }
            """);

        boolean restoreAutoCommit = (boolean) begin.invoke(null, config, connection);
        restore.invoke(null, connection, restoreAutoCommit);

        assertFalse(restoreAutoCommit);
        assertEquals(List.of("getAutoCommit"), calls);
    }

    @Test
    void jdbcxHighPrivilegeExtensionsAreDisabledByDefault() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "applyJdbcxExtensionSecurity",
            JsonNode.class,
            String.class,
            Properties.class
        );
        method.setAccessible(true);
        Properties properties = new Properties();
        method.invoke(null, MAPPER.createObjectNode(), "jdbcx:shell:mysql://127.0.0.1:3306/test", properties);

        String whitelist = properties.getProperty("jdbcx.extension.whitelist");
        assertEquals("help,var,version", whitelist);
        assertFalse(whitelist.contains("shell"));
        assertFalse(whitelist.contains("script"));
        assertFalse(whitelist.contains("web"));
        assertFalse(whitelist.contains("mcp"));
    }

    @Test
    void jdbcxHighPrivilegeExtensionsRequireExplicitConnectionOptIn() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "applyJdbcxExtensionSecurity",
            JsonNode.class,
            String.class,
            Properties.class
        );
        method.setAccessible(true);
        Properties properties = new Properties();
        ObjectNode connection = MAPPER.createObjectNode();
        connection.putArray("agent_java_options").add("-Ddbx.jdbcx.allowHighPrivilegeExtensions=true");

        method.invoke(null, connection, "jdbcx:script:mysql://127.0.0.1:3306/test", properties);

        assertFalse(properties.containsKey("jdbcx.extension.whitelist"));
    }

    @Test
    void jdbcxHighPrivilegeExtensionChangeInvalidatesOnlyJdbcxConnections() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("connectionKey", JsonNode.class);
        method.setAccessible(true);
        ObjectNode jdbcxConnection = MAPPER.createObjectNode();
        jdbcxConnection.put("connection_string", "jdbcx:mysql://127.0.0.1:3306/test");
        String jdbcxDisabledKey = (String) method.invoke(null, jdbcxConnection);
        jdbcxConnection.putArray("agent_java_options").add("-Ddbx.jdbcx.allowHighPrivilegeExtensions=true");
        String jdbcxEnabledKey = (String) method.invoke(null, jdbcxConnection);

        ObjectNode regularConnection = MAPPER.createObjectNode();
        regularConnection.put("connection_string", "jdbc:mysql://127.0.0.1:3306/test");
        String regularDefaultKey = (String) method.invoke(null, regularConnection);
        regularConnection.putArray("agent_java_options").add("-Ddbx.jdbcx.allowHighPrivilegeExtensions=true");
        String regularWithOptionKey = (String) method.invoke(null, regularConnection);

        assertNotEquals(jdbcxDisabledKey, jdbcxEnabledKey);
        assertEquals(regularDefaultKey, regularWithOptionKey);
    }

    @Test
    void prestoConnectTimeoutDoesNotSetUnsupportedDriverProperties() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("applyConnectTimeout", JsonNode.class, Properties.class);
        method.setAccessible(true);
        Properties properties = new Properties();
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:presto://presto.example.test:8080/hive",
              "jdbc_driver_class": "io.prestosql.jdbc.PrestoDriver",
              "connect_timeout_secs": 45
            }
            """);

        method.invoke(null, connection, properties);

        assertFalse(properties.containsKey("loginTimeout"));
        assertFalse(properties.containsKey("connectTimeout"));
    }

    @Test
    void jdbcUrlAppendsConnectionUrlParams() throws Exception {
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:kingbase8://db.example.com:54321/demo",
              "url_params": "useUnicode=true&characterEncoding=UTF-8"
            }
            """);

        assertEquals(
            "jdbc:kingbase8://db.example.com:54321/demo?useUnicode=true&characterEncoding=UTF-8",
            DbxJdbcPlugin.jdbcUrl(connection)
        );
    }

    @Test
    void jdbcUrlAppendsConnectionUrlParamsBeforeFragment() throws Exception {
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:example://db/demo?ssl=true#section",
              "url_params": "?characterEncoding=UTF-8"
            }
            """);

        assertEquals(
            "jdbc:example://db/demo?ssl=true&characterEncoding=UTF-8#section",
            DbxJdbcPlugin.jdbcUrl(connection)
        );
    }

    @Test
    void jdbcUrlAppendsSqlServerConnectionUrlParamsWithSemicolon() throws Exception {
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:sqlserver://localhost:1433",
              "url_params": "databaseName=master;encrypt=true"
            }
            """);

        assertEquals(
            "jdbc:sqlserver://localhost:1433;databaseName=master;encrypt=true",
            DbxJdbcPlugin.jdbcUrl(connection)
        );
    }

    @Test
    void jdbcUrlAppendsDremioConnectionUrlParamsWithSemicolon() throws Exception {
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:dremio:direct=dremio.example.com:31010",
              "url_params": "schema=Samples;ssl=true"
            }
            """);

        assertEquals(
            "jdbc:dremio:direct=dremio.example.com:31010;schema=Samples;ssl=true",
            DbxJdbcPlugin.jdbcUrl(connection)
        );
    }

    @Test
    void jdbcUrlAppendsDb2ConnectionUrlParamsWithColonProperties() throws Exception {
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:db2://localhost:50000/SAMPLE",
              "url_params": "sslConnection=true;"
            }
            """);

        assertEquals("jdbc:db2://localhost:50000/SAMPLE:sslConnection=true;", DbxJdbcPlugin.jdbcUrl(connection));
    }

    @Test
    void jdbcUrlAppendsInformixConnectionUrlParamsWithColonProperties() throws Exception {
        JsonNode connection = MAPPER.readTree("""
            {
              "connection_string": "jdbc:informix-sqli://localhost:9088/sysmaster",
              "url_params": "INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8"
            }
            """);

        assertEquals(
            "jdbc:informix-sqli://localhost:9088/sysmaster:INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8;",
            DbxJdbcPlugin.jdbcUrl(connection)
        );
    }

    @Test
    void oracleSysdbaIsMappedToInternalLogonProperty() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("applyOracleProperties", JsonNode.class, Properties.class);
        method.setAccessible(true);
        Properties properties = new Properties();
        JsonNode connection = MAPPER.readTree("""
            { "sysdba": true }
            """);

        method.invoke(null, connection, properties);

        assertEquals("sysdba", properties.getProperty("internal_logon"));
    }

    @Test
    void driverQuirksDetectYashanJdbcUrl() throws Exception {
        JsonNode yashan = MAPPER.readTree("""
            {
              "connection_string": "jdbc:yasdb://172.26.128.159:20027/yasdb"
            }
            """);
        JsonNode iris = MAPPER.readTree("""
            {
              "connection_string": "jdbc:IRIS://127.0.0.1:1972/USER"
            }
            """);
        JsonNode h2 = MAPPER.readTree("""
            {
              "connection_string": "jdbc:h2:mem:dbx_quirks"
            }
            """);
        JsonNode cache = MAPPER.readTree("""
            {
              "connection_string": "jdbc:Cache://127.0.0.1:1972/USER"
            }
            """);
        JsonNode mysql = MAPPER.readTree("""
            {
              "connection_string": "jdbc:mysql://127.0.0.1:9030/demo"
            }
            """);
        JsonNode hive = MAPPER.readTree("""
            {
              "connection_string": "jdbc:hive2://127.0.0.1:10000/default"
            }
            """);
        JsonNode kingbase = MAPPER.readTree("""
            {
              "connection_string": "jdbc:kingbase8://127.0.0.1:54321/demo"
            }
            """);
        JsonNode kyuubi = MAPPER.readTree("""
            {
              "jdbc_driver_class": "org.apache.kyuubi.jdbc.KyuubiHiveDriver"
            }
            """);
        JsonNode taos = MAPPER.readTree("""
            {
              "connection_string": "jdbc:TAOS://127.0.0.1:6030/power"
            }
            """);

        assertEquals(true, DbxJdbcPlugin.driverQuirks(yashan).skipExecutionContext());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(yashan).useOracleMetadata());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(iris).skipExecutionContext());
        assertEquals(false, DbxJdbcPlugin.driverQuirks(iris).useOracleMetadata());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(iris).caseInsensitiveSchemaMetadata());
        assertEquals(
            DbxJdbcPlugin.StatementMaxRowsMode.READ_LOOP_ONLY,
            DbxJdbcPlugin.driverQuirks(iris).statementMaxRowsMode()
        );
        assertEquals(false, DbxJdbcPlugin.driverQuirks(h2).skipExecutionContext());
        assertEquals(false, DbxJdbcPlugin.driverQuirks(h2).useOracleMetadata());
        assertEquals(false, DbxJdbcPlugin.driverQuirks(h2).caseInsensitiveSchemaMetadata());
        assertEquals(false, DbxJdbcPlugin.driverQuirks(h2).useCatalogFallbackSql());
        assertEquals(
            DbxJdbcPlugin.StatementMaxRowsMode.READ_LOOP_ONLY,
            DbxJdbcPlugin.driverQuirks(h2).statementMaxRowsMode()
        );
        assertEquals(
            DbxJdbcPlugin.StatementMaxRowsMode.READ_LOOP_ONLY,
            DbxJdbcPlugin.driverQuirks(cache).statementMaxRowsMode()
        );
        assertEquals(true, DbxJdbcPlugin.driverQuirks(mysql).useCatalogFallbackSql());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(hive).schemasAsDatabasesFallback());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(kingbase).ignoreCatalogForSchemaMetadata());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(kyuubi).useCatalogFallbackSql());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(kyuubi).schemasAsDatabasesFallback());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(taos).preferExecuteQueryForResultSetSql());
    }

    @Test
    void irisStatementOptionsSkipDriverMaxRowsRewrite() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "applyStatementOptions",
            Statement.class,
            int.class,
            int.class,
            int.class,
            DbxJdbcPlugin.JdbcDriverQuirks.class
        );
        method.setAccessible(true);
        JsonNode iris = MAPPER.readTree("""
            {
              "connection_string": "jdbc:IRIS://127.0.0.1:1972/USER"
            }
            """);
        List<String> calls = new ArrayList<>();

        method.invoke(null, recordingStatement(calls), 100, 50, 30, DbxJdbcPlugin.driverQuirks(iris));

        assertFalse(calls.contains("setMaxRows"), calls.toString());
        assertEquals(true, calls.contains("setFetchSize"));
        assertEquals(true, calls.contains("setQueryTimeout"));
    }

    @Test
    void defaultStatementOptionsSkipDriverMaxRowsRewrite() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "applyStatementOptions",
            Statement.class,
            int.class,
            int.class,
            int.class,
            DbxJdbcPlugin.JdbcDriverQuirks.class
        );
        method.setAccessible(true);
        JsonNode h2 = MAPPER.readTree("""
            {
              "connection_string": "jdbc:h2:mem:dbx_quirks"
            }
            """);
        List<String> calls = new ArrayList<>();

        method.invoke(null, recordingStatement(calls), 100, 50, 30, DbxJdbcPlugin.driverQuirks(h2));

        assertFalse(calls.contains("setMaxRows"), calls.toString());
        assertEquals(true, calls.contains("setFetchSize"));
        assertEquals(true, calls.contains("setQueryTimeout"));
    }

    @Test
    void oracleExplainUsesPlanTableOnTheSharedConnectionAndCleansUp() throws Exception {
        List<String> calls = new ArrayList<>();
        OracleExplainDriver driver = new OracleExplainDriver(calls);
        DriverManager.registerDriver(driver);
        String connection = """
            {
              "connection_string": "jdbc:oracle:dbx-explain:test",
              "username": "system",
              "query_timeout_secs": 30
            }
            """;
        try {
            JsonNode response = request("getExplainInfo", """
                {
                  "connection": %s,
                  "sql": "SELECT * FROM DUAL",
                  "timeoutSecs": 30,
                  "mode": "explain"
                }
                """.formatted(connection));

            assertFalse(response.has("error"), response.toString());
            assertEquals("Plan hash value: 123\nTABLE ACCESS FULL DUAL", response.path("result").path("plan").asText());
            assertEquals(1, calls.stream().filter(call -> call.equals("connect")).count());
            String explainCall = calls.stream()
                .filter(call -> call.startsWith("prepare:EXPLAIN PLAN SET STATEMENT_ID = 'DBX_"))
                .findFirst()
                .orElseThrow();
            String statementId = explainCall.substring(
                explainCall.indexOf("'") + 1,
                explainCall.indexOf("'", explainCall.indexOf("'") + 1)
            );
            assertEquals(1, calls.stream().filter(call -> call.startsWith("prepare:SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY")).count());
            assertEquals(1, calls.stream().filter(call -> call.equals("prepare:DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = ?")).count());
            assertEquals(2, calls.stream().filter(call -> call.equals("bind:1:" + statementId)).count());
        } finally {
            closeAndDeregister(connection, driver);
        }
    }

    @Test
    void optInStatementOptionsCanApplyDriverMaxRowsProtection() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "applyStatementOptions",
            Statement.class,
            int.class,
            int.class,
            int.class,
            DbxJdbcPlugin.JdbcDriverQuirks.class
        );
        method.setAccessible(true);
        JsonNode yashan = MAPPER.readTree("""
            {
              "connection_string": "jdbc:yasdb://127.0.0.1:1688/yasdb"
            }
            """);
        List<String> calls = new ArrayList<>();

        method.invoke(null, recordingStatement(calls), 100, 50, 30, DbxJdbcPlugin.driverQuirks(yashan));

        assertEquals(true, calls.contains("setMaxRows"));
        assertEquals(true, calls.contains("setFetchSize"));
        assertEquals(true, calls.contains("setQueryTimeout"));
    }

    @Test
    void schemaDisplayNamePrefersMixedCaseOverAllUppercaseDuplicate() {
        assertEquals(true, DbxJdbcPlugin.preferSchemaDisplayName("SQLUSER", "SQLUser"));
        assertEquals(false, DbxJdbcPlugin.preferSchemaDisplayName("SQLUser", "SQLUSER"));
    }

    @Test
    void jdbcTableTypesUsesDriverTypesWithinDefaultAllowList() throws Exception {
        String[] types = DbxJdbcPlugin.jdbcTableTypes(tableTypesMeta("TABLE", "LOCAL TEMPORARY", "BASE TABLE"));

        assertEquals(List.of("TABLE", "BASE TABLE"), List.of(types));
    }

    @Test
    void jdbcTableTypesFallsBackWhenDriverReturnsNoAllowedTypes() throws Exception {
        String[] types = DbxJdbcPlugin.jdbcTableTypes(tableTypesMeta("LOCAL TEMPORARY"));

        assertEquals(true, List.of(types).contains("BASE TABLE"));
        assertEquals(true, List.of(types).contains("TABLE"));
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
    void listTablesAppliesMetadataConstraints() throws Exception {
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE SCHEMA IF NOT EXISTS app"
            }
            """.formatted(CONNECTION));
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE TABLE IF NOT EXISTS app.people (id INT PRIMARY KEY)"
            }
            """.formatted(CONNECTION));
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE TABLE IF NOT EXISTS app.people_archive (id INT PRIMARY KEY)"
            }
            """.formatted(CONNECTION));

        JsonNode response = request("listTables", """
            {
              "connection": %s,
              "schema": "APP",
              "filter": "people",
              "limit": 1,
              "offset": 1,
              "object_types": ["TABLE"]
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals(1, response.path("result").size());
        assertEquals("PEOPLE_ARCHIVE", response.path("result").path(0).path("name").asText());
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
    void listDatabasesFallsBackToSchemasForHiveJdbc() throws Exception {
        List<String> calls = new ArrayList<>();
        Driver driver = new HiveMetadataDriver(calls);
        DriverManager.registerDriver(driver);
        String connection = """
            {
              "connection_string": "jdbc:hive2:dbx-schema-fallback"
            }
            """;
        try {
            JsonNode response = request("listDatabases", """
                { "connection": %s }
                """.formatted(connection));

            assertFalse(response.has("error"), response.toString());
            assertEquals(2, response.path("result").size());
            assertEquals("default", response.path("result").path(0).path("name").asText());
            assertEquals("warehouse", response.path("result").path(1).path("name").asText());
            assertEquals(List.of("getCatalogs", "getSchemas"), calls);
        } finally {
            request("close", """
                { "connection": %s }
                """.formatted(connection));
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void listDataTypesUsesJdbcTypeInfo() throws Exception {
        JsonNode response = request("listDataTypes", """
            { "connection": %s }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        boolean foundInteger = false;
        boolean foundVarchar = false;
        for (JsonNode type : response.path("result")) {
            String name = type.asText();
            if ("INTEGER".equalsIgnoreCase(name)) {
                foundInteger = true;
            }
            if ("VARCHAR".equalsIgnoreCase(name) || "CHARACTER VARYING".equalsIgnoreCase(name)) {
                foundVarchar = true;
            }
        }
        assertEquals(true, foundInteger);
        assertEquals(true, foundVarchar);
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
    void listObjectsAppliesMetadataConstraints() throws Exception {
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE SCHEMA IF NOT EXISTS app"
            }
            """.formatted(CONNECTION));
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE TABLE IF NOT EXISTS app.people (id INT PRIMARY KEY)"
            }
            """.formatted(CONNECTION));
        request("executeQuery", """
            {
              "connection": %s,
              "sql": "CREATE TABLE IF NOT EXISTS app.people_archive (id INT PRIMARY KEY)"
            }
            """.formatted(CONNECTION));

        JsonNode response = request("listObjects", """
            {
              "connection": %s,
              "schema": "APP",
              "filter": "people",
              "limit": 1,
              "offset": 1,
              "object_types": ["TABLE"]
            }
            """.formatted(CONNECTION));

        assertFalse(response.has("error"), response.toString());
        assertEquals(1, response.path("result").size());
        assertEquals("PEOPLE_ARCHIVE", response.path("result").path(0).path("name").asText());
    }

    @Test
    void listObjectsTreatsNullRoutineMetadataAsUnsupported() throws Exception {
        RoutineMetadataResponse metadata = requestRoutineObjects(
            "null-routines",
            RoutineMetadataBehavior.NULL,
            RoutineMetadataBehavior.NULL,
            false
        );

        assertFalse(metadata.response().has("error"), metadata.response().toString());
        assertEquals(1, metadata.response().path("result").size());
        assertEquals("meters", metadata.response().path("result").path(0).path("name").asText());
        assertEquals(List.of("getTableTypes", "getTables", "getProcedures", "getFunctions"), metadata.calls());
    }

    @Test
    void listObjectsKeepsFunctionsWhenProcedureMetadataIsNull() throws Exception {
        JsonNode response = requestRoutineObjects(
            "null-procedures",
            RoutineMetadataBehavior.NULL,
            RoutineMetadataBehavior.ROWS,
            false
        ).response();

        assertFalse(response.has("error"), response.toString());
        assertEquals(3, response.path("result").size());
        assertEquals("FUNCTION", response.path("result").path(1).path("object_type").asText());
        assertEquals("shared_routine", response.path("result").path(1).path("name").asText());
        assertEquals("unique_function", response.path("result").path(2).path("name").asText());
    }

    @Test
    void listObjectsKeepsProceduresWhenFunctionMetadataIsNull() throws Exception {
        JsonNode response = requestRoutineObjects(
            "null-functions",
            RoutineMetadataBehavior.ROWS,
            RoutineMetadataBehavior.NULL,
            false
        ).response();

        assertFalse(response.has("error"), response.toString());
        assertEquals(2, response.path("result").size());
        assertEquals("PROCEDURE", response.path("result").path(1).path("object_type").asText());
        assertEquals("shared_routine", response.path("result").path(1).path("name").asText());
    }

    @Test
    void listObjectsPreservesNonNullRoutineMetadataAndDeduplication() throws Exception {
        JsonNode response = requestRoutineObjects(
            "routine-rows",
            RoutineMetadataBehavior.ROWS,
            RoutineMetadataBehavior.ROWS,
            false
        ).response();

        assertFalse(response.has("error"), response.toString());
        assertEquals(3, response.path("result").size());
        assertEquals("PROCEDURE", response.path("result").path(1).path("object_type").asText());
        assertEquals("shared_routine", response.path("result").path(1).path("name").asText());
        assertEquals("FUNCTION", response.path("result").path(2).path("object_type").asText());
        assertEquals("unique_function", response.path("result").path(2).path("name").asText());
    }

    @Test
    void listObjectsSkipsRoutineMetadataWhenOnlyTablesAreRequested() throws Exception {
        RoutineMetadataResponse metadata = requestRoutineObjects(
            "table-only",
            RoutineMetadataBehavior.NULL,
            RoutineMetadataBehavior.NULL,
            false,
            "TABLE"
        );

        assertFalse(metadata.response().has("error"), metadata.response().toString());
        assertEquals(1, metadata.response().path("result").size());
        assertEquals(List.of("getTableTypes", "getTables"), metadata.calls());
    }

    @Test
    void listObjectsOnlyQueriesRequestedRoutineMetadata() throws Exception {
        RoutineMetadataResponse procedures = requestRoutineObjects(
            "procedure-only",
            RoutineMetadataBehavior.ROWS,
            RoutineMetadataBehavior.SQL_EXCEPTION,
            false,
            "PROCEDURE"
        );
        assertFalse(procedures.response().has("error"), procedures.response().toString());
        assertEquals(1, procedures.response().path("result").size());
        assertEquals(List.of("getTableTypes", "getProcedures"), procedures.calls());

        RoutineMetadataResponse functions = requestRoutineObjects(
            "function-only",
            RoutineMetadataBehavior.SQL_EXCEPTION,
            RoutineMetadataBehavior.ROWS,
            false,
            "FUNCTION"
        );
        assertFalse(functions.response().has("error"), functions.response().toString());
        assertEquals(2, functions.response().path("result").size());
        assertEquals(List.of("getTableTypes", "getFunctions"), functions.calls());
    }

    @Test
    void listObjectsKeepsExistingOptionalRoutineSqlExceptionFallback() throws Exception {
        RoutineMetadataResponse metadata = requestRoutineObjects(
            "routine-errors",
            RoutineMetadataBehavior.SQL_EXCEPTION,
            RoutineMetadataBehavior.SQL_EXCEPTION,
            false
        );

        assertFalse(metadata.response().has("error"), metadata.response().toString());
        assertEquals(1, metadata.response().path("result").size());
        assertEquals(List.of("getTableTypes", "getTables", "getProcedures", "getFunctions"), metadata.calls());
    }

    @Test
    void listObjectsStillPropagatesRequiredTableMetadataFailures() throws Exception {
        RoutineMetadataResponse metadata = requestRoutineObjects(
            "table-error",
            RoutineMetadataBehavior.NULL,
            RoutineMetadataBehavior.NULL,
            true
        );

        assertEquals("required table metadata failed", metadata.response().path("error").path("message").asText());
        assertEquals(List.of("getTableTypes", "getTables"), metadata.calls());
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
    void getColumnsUsesReturnedMetadataIdentityForGaussDbPrimaryKeys() throws Exception {
        List<String> calls = new ArrayList<>();
        Driver driver = new GaussDbMetadataDriver(calls);
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("getColumns", """
                {
                  "connection": {
                    "connection_string": "jdbc:gaussdb://gauss.example.test:8000/appdb",
                    "connect_timeout_secs": 30
                  },
                  "database": "appdb",
                  "schema": "app",
                  "table": "orders"
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("id", response.path("result").path(0).path("name").asText());
            assertEquals(true, response.path("result").path(0).path("is_primary_key").asBoolean());
            assertEquals(
                List.of(
                    "columns:appdb:app:orders",
                    "primaryKeys:<null>:APP:ORDERS"
                ),
                calls
            );
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void primaryKeyCaseFallbackDoesNotGuessBetweenCaseDistinctColumns() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("markPrimaryKeyColumns", ArrayNode.class, Set.class);
        method.setAccessible(true);
        ArrayNode columns = MAPPER.createArrayNode();
        columns.addObject().put("name", "ID").put("is_primary_key", false);
        columns.addObject().put("name", "id").put("is_primary_key", false);

        method.invoke(null, columns, Set.of("Id"));

        assertEquals(false, columns.path(0).path("is_primary_key").asBoolean());
        assertEquals(false, columns.path(1).path("is_primary_key").asBoolean());
    }

    @Test
    void kingbaseGetColumnsUsesFormattedCatalogTypes() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("kingbaseGetColumns", Connection.class, String.class, String.class);
        method.setAccessible(true);
        List<String> sql = new ArrayList<>();

        JsonNode result = (JsonNode) method.invoke(null, kingbaseColumnsConnection(sql), "dbx_issue_1942", "t_timestamp_type");

        assertEquals("id", result.path(0).path("name").asText());
        assertEquals("INTEGER", result.path(0).path("data_type").asText());
        assertEquals(true, result.path(0).path("is_primary_key").asBoolean());
        assertEquals("create_time", result.path(1).path("name").asText());
        assertEquals("TIMESTAMP WITH TIME ZONE", result.path(1).path("data_type").asText());
        assertEquals("create_by", result.path(2).path("name").asText());
        assertEquals("CHARACTER VARYING(64 byte)", result.path(2).path("data_type").asText());
        assertEquals(64, result.path(2).path("character_maximum_length").asInt());
        assertEquals(true, sql.get(1).contains("format_type(a.atttypid, a.atttypmod) AS data_type"));
        assertEquals(true, sql.get(1).contains("FROM sys_catalog.sys_attribute"));
    }

    @Test
    void kingbaseListTablesReusesCastSafeAgentDiscovery() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("kingbaseListTables", Connection.class, String.class, boolean.class);
        method.setAccessible(true);
        List<String> sql = new ArrayList<>();
        ResultSet tables = rowsResultSet(
            new String[] { "table_name", "table_type", "remarks" },
            new Object[][] {
                { "orders", "TABLE", "Order records" },
                { "order_summary", "VIEW", null }
            }
        );

        JsonNode result = (JsonNode) method.invoke(null, kingbaseTableConnection(sql, tables, false), "APP", false);

        assertEquals("orders", result.path(0).path("name").asText());
        assertEquals("TABLE", result.path(0).path("table_type").asText());
        assertEquals("Order records", result.path(0).path("comment").asText());
        assertEquals("VIEW", result.path(1).path("table_type").asText());
        String discoverySql = sql.get(2);
        assertEquals(true, discoverySql.contains("FROM sys_catalog.sys_class c"));
        assertEquals(true, discoverySql.contains("FROM sys_catalog.sys_tables t"));
        assertEquals(true, discoverySql.contains("FROM sys_catalog.sys_foreign_table ft"));
        assertEquals(true, discoverySql.contains("FROM sys_catalog.sys_views"));
        assertEquals(true, discoverySql.contains("FROM sys_catalog.sys_matviews"));
        assertEquals(true, discoverySql.contains("CAST(c.relname AS varchar(256))"));
        assertEquals(false, discoverySql.contains("relkind"));
        assertEquals(false, discoverySql.contains("sys_freespace"));
        assertEquals(false, discoverySql.contains("pg_relation_size_ex"));
    }

    @Test
    void kingbaseCompatibilityListTablesAvoidsRelkind() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("kingbaseListTables", Connection.class, String.class, boolean.class);
        method.setAccessible(true);
        List<String> sql = new ArrayList<>();
        ResultSet tables = rowsResultSet(
            new String[] { "table_name", "table_type", "remarks" },
            new Object[][] { { "orders", "BASE TABLE", null }, { "order_summary", "VIEW", null } }
        );

        JsonNode result = (JsonNode) method.invoke(null, kingbaseTableConnection(sql, tables, true), "APP", false);

        assertEquals("TABLE", result.path(0).path("table_type").asText());
        assertEquals("VIEW", result.path(1).path("table_type").asText());
        assertEquals(true, sql.get(1).contains("LOWER(name) = 'database_mode'"));
        String discoverySql = sql.get(2);
        assertEquals(true, discoverySql.contains("FROM information_schema.tables"));
        assertEquals(false, discoverySql.contains("relkind"));
        assertEquals(false, discoverySql.contains("sys_freespace"));
    }

    @Test
    void kingbasePostgresCatalogModePreservesMaterializedViews() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("kingbaseListTables", Connection.class, String.class, boolean.class);
        method.setAccessible(true);
        List<String> sql = new ArrayList<>();
        ResultSet tables = rowsResultSet(
            new String[] { "table_name", "table_type", "remarks" },
            new Object[][] { { "orders", "TABLE", null }, { "order_summary", "MATERIALIZED_VIEW", "Cached orders" } }
        );

        JsonNode result = (JsonNode) method.invoke(null, kingbasePostgresTableConnection(sql, tables), "APP", false);

        assertEquals("TABLE", result.path(0).path("table_type").asText());
        assertEquals("MATERIALIZED_VIEW", result.path(1).path("table_type").asText());
        assertEquals("SELECT 1 FROM sys_catalog.sys_namespace WHERE 1 = 0", sql.get(0));
        assertEquals("SELECT 1 FROM pg_catalog.pg_namespace WHERE 1 = 0", sql.get(1));
        String discoverySql = sql.get(2);
        assertEquals(true, discoverySql.contains("FROM pg_catalog.pg_class c"));
        assertEquals(true, discoverySql.contains("JOIN pg_catalog.pg_namespace n"));
        assertEquals(true, discoverySql.contains("c.relkind IN ('r', 'p', 'v', 'm', 'f')"));
    }

    @Test
    void kingbaseRegularTableDiscoveryExcludesCompositeTypesWithPositiveTableCatalog() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("kingbaseListTables", Connection.class, String.class, boolean.class);
        method.setAccessible(true);
        List<String> sql = new ArrayList<>();

        JsonNode result = (JsonNode) method.invoke(null, kingbaseCompositeCatalogConnection(sql), "APP", false);

        assertEquals(1, result.size());
        assertEquals("orders", result.path(0).path("name").asText());
        String discoverySql = sql.get(2);
        assertEquals(true, discoverySql.contains("FROM sys_catalog.sys_tables t"));
        assertEquals(true, discoverySql.contains("FROM sys_catalog.sys_foreign_table ft"));
        assertEquals(false, discoverySql.contains("information_schema.tables"));
        assertEquals(false, discoverySql.contains("sys_rewrite"));
        assertEquals(false, discoverySql.contains("sys_index"));
    }

    @Test
    void kingbaseEffectiveSchemaPreservesConnectionSchemaCase() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("kingbaseEffectiveSchema", Connection.class, String.class);
        method.setAccessible(true);
        Connection connection = (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, invokedMethod, args) -> switch (invokedMethod.getName()) {
                case "getSchema" -> "CaseSensitiveSchema";
                default -> defaultValue(invokedMethod.getReturnType());
            }
        );

        assertEquals("CaseSensitiveSchema", method.invoke(null, connection, null));
        assertEquals("ExplicitSchema", method.invoke(null, connection, "ExplicitSchema"));
    }

    @Test
    void columnIsNullablePrefersIsNullableStringWhenNullableCodeIsWrong() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("columnIsNullable", ResultSet.class);
        method.setAccessible(true);

        ResultSet rs = columnNullableResultSet("YES", DatabaseMetaData.columnNoNulls);

        assertEquals(true, method.invoke(null, rs));
    }

    @Test
    void columnIsNullableFallsBackToNullableCodeWhenStringIsMissing() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("columnIsNullable", ResultSet.class);
        method.setAccessible(true);

        ResultSet rs = columnNullableResultSet(null, DatabaseMetaData.columnNullable);

        assertEquals(true, method.invoke(null, rs));
    }

    @Test
    void showFullColumnsMetadataCompletesMysqlCompatibleTypesAndComments() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod(
            "mergeShowFullColumnMetadata",
            Connection.class,
            ArrayNode.class,
            String.class,
            String.class
        );
        method.setAccessible(true);
        ArrayNode columns = MAPPER.createArrayNode();
        ObjectNode column = columns.addObject();
        column.put("name", "name");
        column.put("data_type", "varchar");
        column.putNull("extra");
        column.putNull("comment");

        method.invoke(null, showFullColumnsConnection(), columns, "app", "people");

        assertEquals("varchar(32)", columns.path(0).path("data_type").asText());
        assertEquals("auto_increment", columns.path(0).path("extra").asText());
        assertEquals("姓名", columns.path(0).path("comment").asText());
    }

    @Test
    void prestoListTablesUsesInformationSchemaInsteadOfJdbcMetadata() throws Exception {
        List<String> calls = new ArrayList<>();
        Driver driver = new PrestoMetadataDriver(calls);
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("listTables", """
                {
                  "connection": {
                    "connection_string": "jdbc:presto://presto.example.test:8080/hive",
                    "connect_timeout_secs": 30
                  },
                  "database": "hive",
                  "schema": "sales_analytics"
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("daily_revenue", response.path("result").path(0).path("name").asText());
            assertEquals("TABLE", response.path("result").path(0).path("table_type").asText());
            assertEquals("revenue_view", response.path("result").path(1).path("name").asText());
            assertEquals("VIEW", response.path("result").path(1).path("table_type").asText());
            assertEquals(
                List.of(
                    "prepare:SELECT table_name, table_type FROM \"hive\".information_schema.tables WHERE table_schema = ? AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_type, table_name",
                    "setString:1:sales_analytics",
                    "executeQuery"
                ),
                calls
            );
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void prestoListTablesPushesFilterAndLimitToInformationSchema() throws Exception {
        List<String> calls = new ArrayList<>();
        Driver driver = new PrestoMetadataDriver(calls);
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("listTables", """
                {
                  "connection": {
                    "connection_string": "jdbc:presto://presto.example.test:8080/hive",
                    "connect_timeout_secs": 30
                  },
                  "database": "hive",
                  "schema": "sales_analytics",
                  "filter": "Daily_%",
                  "limit": 20
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals(
                List.of(
                    "prepare:SELECT table_name, table_type FROM \"hive\".information_schema.tables WHERE table_schema = ? AND table_type IN ('BASE TABLE', 'VIEW') AND lower(table_name) LIKE ? ESCAPE '\\' ORDER BY table_type, table_name LIMIT 20",
                    "setString:1:sales_analytics",
                    "setString:2:daily\\_\\%%",
                    "executeQuery"
                ),
                calls
            );
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    @Test
    void prestoGetColumnsUsesInformationSchemaInsteadOfJdbcMetadata() throws Exception {
        List<String> calls = new ArrayList<>();
        Driver driver = new PrestoMetadataDriver(calls);
        DriverManager.registerDriver(driver);
        try {
            JsonNode response = request("getColumns", """
                {
                  "connection": {
                    "connection_string": "jdbc:presto://presto.example.test:8080/hive",
                    "connect_timeout_secs": 30
                  },
                  "database": "hive",
                  "schema": "sales_analytics",
                  "table": "daily_revenue"
                }
                """);

            assertFalse(response.has("error"), response.toString());
            assertEquals("amount", response.path("result").path(0).path("name").asText());
            assertEquals("decimal(12,2)", response.path("result").path(0).path("data_type").asText());
            assertEquals(12, response.path("result").path(0).path("numeric_precision").asInt());
            assertEquals(2, response.path("result").path(0).path("numeric_scale").asInt());
            assertEquals(
                List.of(
                    "prepare:SELECT column_name, data_type, is_nullable, column_default, comment FROM \"hive\".information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
                    "setString:1:sales_analytics",
                    "setString:2:daily_revenue",
                    "executeQuery"
                ),
                calls
            );
        } finally {
            DriverManager.deregisterDriver(driver);
        }
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

    @Test
    void oracleGetColumnsMergesDuplicateMetadataRowsAndKeepsComments() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("oracleGetColumns", Connection.class, String.class, String.class);
        method.setAccessible(true);

        try (Connection conn = DriverManager.getConnection("jdbc:h2:mem:dbx_oracle_duplicate_columns;DB_CLOSE_DELAY=-1", "sa", "")) {
            conn.createStatement().execute(
                "CREATE TABLE all_tab_comments (owner VARCHAR(64), table_name VARCHAR(64), table_type VARCHAR(16))"
            );
            conn.createStatement().execute(
                "CREATE TABLE all_tab_columns (" +
                    "owner VARCHAR(64), table_name VARCHAR(64), column_name VARCHAR(64), data_type VARCHAR(32), " +
                    "nullable VARCHAR(1), data_default VARCHAR(64), data_precision INT, data_scale INT, char_length INT, column_id INT)"
            );
            conn.createStatement().execute(
                "CREATE TABLE all_col_comments (owner VARCHAR(64), table_name VARCHAR(64), column_name VARCHAR(64), comments VARCHAR(128))"
            );
            conn.createStatement().execute(
                "CREATE TABLE all_constraints (owner VARCHAR(64), table_name VARCHAR(64), constraint_name VARCHAR(64), constraint_type VARCHAR(1))"
            );
            conn.createStatement().execute(
                "CREATE TABLE all_cons_columns (owner VARCHAR(64), table_name VARCHAR(64), constraint_name VARCHAR(64), column_name VARCHAR(64))"
            );
            conn.createStatement().execute(
                "INSERT INTO all_tab_comments(owner, table_name, table_type) VALUES ('SYSDBA', 'F02_TFBH', 'TABLE')"
            );
            conn.createStatement().execute(
                "INSERT INTO all_tab_columns(owner, table_name, column_name, data_type, nullable, data_default, data_precision, data_scale, char_length, column_id) " +
                    "VALUES ('SYSDBA', 'F02_TFBH', 'ID', 'INT', 'N', NULL, 10, 0, NULL, 1), " +
                    "('SYSDBA', 'F02_TFBH', 'TFBH', 'VARCHAR', 'Y', NULL, NULL, NULL, 8, 2)"
            );
            conn.createStatement().execute(
                "INSERT INTO all_col_comments(owner, table_name, column_name, comments) VALUES " +
                    "('SYSDBA', 'F02_TFBH', 'ID', NULL), " +
                    "('SYSDBA', 'F02_TFBH', 'ID', '源主键'), " +
                    "('SYSDBA', 'F02_TFBH', 'TFBH', NULL), " +
                    "('SYSDBA', 'F02_TFBH', 'TFBH', '台账编号')"
            );
            conn.createStatement().execute(
                "INSERT INTO all_constraints(owner, table_name, constraint_name, constraint_type) VALUES ('SYSDBA', 'F02_TFBH', 'PK_F02_TFBH', 'P')"
            );
            conn.createStatement().execute(
                "INSERT INTO all_cons_columns(owner, table_name, constraint_name, column_name) VALUES ('SYSDBA', 'F02_TFBH', 'PK_F02_TFBH', 'ID')"
            );

            JsonNode columns = MAPPER.valueToTree(method.invoke(null, conn, "SYSDBA", "F02_TFBH"));

            assertEquals(2, columns.size());
            assertEquals("ID", columns.path(0).path("name").asText());
            assertEquals("源主键", columns.path(0).path("comment").asText());
            assertEquals(true, columns.path(0).path("is_primary_key").asBoolean());
            assertEquals("TFBH", columns.path(1).path("name").asText());
            assertEquals("台账编号", columns.path(1).path("comment").asText());
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

    private static Statement recordingStatement(List<String> calls) {
        return (Statement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Statement.class },
            (proxy, method, args) -> {
                calls.add(method.getName());
                Class<?> returnType = method.getReturnType();
                if (returnType == boolean.class) return false;
                if (returnType == int.class) return 0;
                if (returnType == long.class) return 0L;
                if (returnType == float.class) return 0f;
                if (returnType == double.class) return 0d;
                return null;
            }
        );
    }

    private static Connection pagedQueryConnection(List<String> calls, boolean autoCommit) {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "getAutoCommit" -> {
                    calls.add("getAutoCommit");
                    yield autoCommit;
                }
                case "setAutoCommit" -> {
                    calls.add("setAutoCommit:" + args[0]);
                    yield null;
                }
                case "rollback" -> {
                    calls.add("rollback");
                    yield null;
                }
                case "createStatement" -> {
                    if (args == null || args.length == 0) {
                        calls.add("createStatement");
                    } else {
                        calls.add("createStatement:" + args[0] + ":" + args[1]);
                    }
                    yield recordingStatement(new ArrayList<>());
                }
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static ResultSet temporalResultSet(Object objectValue, Date dateValue, List<String> calls) {
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            (proxy, method, args) -> {
                if ("getObject".equals(method.getName()) || "getTimestamp".equals(method.getName()) || "getDate".equals(method.getName())) {
                    calls.add(method.getName());
                }
                return switch (method.getName()) {
                    case "getObject", "getTimestamp" -> objectValue;
                    case "getDate" -> dateValue;
                    case "getBytes" -> null;
                    default -> null;
                };
            }
        );
    }

    private static ResultSetMetaData columnMeta(int columnType) {
        return (ResultSetMetaData) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSetMetaData.class },
            (proxy, method, args) -> {
                return switch (method.getName()) {
                    case "getColumnCount" -> 1;
                    case "getColumnLabel", "getColumnName" -> "CREATED_AT";
                    case "getColumnType" -> columnType;
                    default -> defaultValue(method.getReturnType());
                };
            }
        );
    }

    private static DatabaseMetaData tableTypesMeta(String... types) {
        return (DatabaseMetaData) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { DatabaseMetaData.class },
            (proxy, method, args) -> {
                if ("getTableTypes".equals(method.getName())) {
                    return tableTypesResultSet(types);
                }
                return null;
            }
        );
    }

    private static ResultSet tableTypesResultSet(String[] types) {
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            new java.lang.reflect.InvocationHandler() {
                private int index = -1;

                @Override
                public Object invoke(Object proxy, Method method, Object[] args) {
                    return switch (method.getName()) {
                        case "next" -> ++index < types.length;
                        case "getString" -> types[index];
                        case "close" -> null;
                        default -> null;
                    };
                }
            }
        );
    }

    private static Connection showFullColumnsConnection() {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "createStatement" -> showFullColumnsStatement();
                case "isClosed" -> false;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Connection kingbaseColumnsConnection(List<String> sql) {
        ResultSet primaryKeys = rowsResultSet(
            new String[] { "column_name" },
            new Object[][] { { "id" } }
        );
        ResultSet columns = rowsResultSet(
            new String[] {
                "column_name",
                "data_type",
                "is_nullable",
                "column_default",
                "column_comment",
                "numeric_precision",
                "numeric_scale",
                "character_maximum_length"
            },
            new Object[][] {
                { "id", "INTEGER", false, null, null, 32, 0, null },
                { "create_time", "TIMESTAMP WITH TIME ZONE", true, null, null, null, null, null },
                { "create_by", "CHARACTER VARYING(64 byte)", true, null, null, null, null, 64 }
            }
        );
        int[] index = { 0 };
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "createStatement" -> {
                    yield statement(sql, index[0]++ == 0 ? primaryKeys : columns);
                }
                case "isClosed" -> false;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Connection kingbaseTableConnection(List<String> sql, ResultSet rs, boolean compatibilityMode) {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "createStatement" -> kingbaseCatalogProbeStatement(sql, compatibilityMode);
                case "prepareStatement" -> {
                    sql.add(String.valueOf(args[0]));
                    yield preparedStatement(rs);
                }
                case "isClosed" -> false;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Connection kingbaseCompositeCatalogConnection(List<String> sql) {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "createStatement" -> kingbaseCatalogProbeStatement(sql, false);
                case "prepareStatement" -> {
                    String preparedSql = String.valueOf(args[0]);
                    sql.add(preparedSql);
                    boolean positivelySelectsTables = preparedSql.contains("FROM sys_catalog.sys_tables t")
                        && preparedSql.contains("FROM sys_catalog.sys_foreign_table ft");
                    Object[][] rows = positivelySelectsTables
                        ? new Object[][] { { "orders", "TABLE", null } }
                        : new Object[][] { { "orders", "TABLE", null }, { "address_type", "TABLE", null } };
                    yield preparedStatement(rowsResultSet(new String[] { "table_name", "table_type", "remarks" }, rows));
                }
                case "isClosed" -> false;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Connection kingbasePostgresTableConnection(List<String> sql, ResultSet rs) {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "createStatement" -> kingbasePostgresCatalogProbeStatement(sql);
                case "prepareStatement" -> {
                    sql.add(String.valueOf(args[0]));
                    yield preparedStatement(rs);
                }
                case "isClosed" -> false;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Statement kingbaseCatalogProbeStatement(List<String> sql, boolean compatibilityMode) {
        return (Statement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Statement.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "executeQuery" -> {
                    String query = String.valueOf(args[0]);
                    sql.add(query);
                    if (query.contains("sys_catalog.sys_namespace")) {
                        yield rowsResultSet(new String[] { "exists" }, new Object[0][]);
                    }
                    if (query.contains("LOWER(name) = 'database_mode'")) {
                        yield rowsResultSet(
                            new String[] { "setting" },
                            new Object[][] { { compatibilityMode ? "mysql" : "oracle" } }
                        );
                    }
                    if (query.contains("LOWER(name) = 'sql_mode'")) {
                        yield rowsResultSet(new String[] { "exists" }, new Object[0][]);
                    }
                    throw new SQLException("Unexpected Kingbase catalog probe: " + query);
                }
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Statement kingbasePostgresCatalogProbeStatement(List<String> sql) {
        return (Statement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Statement.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "executeQuery" -> {
                    String query = String.valueOf(args[0]);
                    sql.add(query);
                    if (query.contains("sys_catalog.sys_namespace")) {
                        throw new SQLException("relation does not exist: sys_catalog.sys_namespace");
                    }
                    if (query.contains("pg_catalog.pg_namespace")) {
                        yield rowsResultSet(new String[] { "exists" }, new Object[0][]);
                    }
                    throw new SQLException("Unexpected Kingbase catalog probe: " + query);
                }
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Statement statement(List<String> sql, ResultSet rs) {
        return (Statement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Statement.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "executeQuery" -> {
                    sql.add(String.valueOf(args[0]));
                    yield rs;
                }
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static PreparedStatement preparedStatement(ResultSet rs) {
        return (PreparedStatement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { PreparedStatement.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "executeQuery" -> rs;
                case "setString", "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static ResultSet rowsResultSet(String[] columns, Object[][] rows) {
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            new java.lang.reflect.InvocationHandler() {
                private int index = -1;

                @Override
                public Object invoke(Object proxy, Method method, Object[] args) {
                    return switch (method.getName()) {
                        case "next" -> ++index < rows.length;
                        case "getString" -> stringValue(columns, rows[index], args[0]);
                        case "getBoolean" -> booleanValue(columns, rows[index], args[0]);
                        case "getObject" -> columnValue(columns, rows[index], args[0]);
                        case "close" -> null;
                        default -> defaultValue(method.getReturnType());
                    };
                }
            }
        );
    }

    private static String stringValue(String[] columns, Object[] row, Object key) {
        Object value = columnValue(columns, row, key);
        return value == null ? null : String.valueOf(value);
    }

    private static boolean booleanValue(String[] columns, Object[] row, Object key) {
        Object value = columnValue(columns, row, key);
        if (value instanceof Boolean bool) return bool;
        if (value instanceof Number number) return number.intValue() != 0;
        return Boolean.parseBoolean(String.valueOf(value));
    }

    private static Object columnValue(String[] columns, Object[] row, Object key) {
        if (key instanceof Number number) {
            return row[number.intValue() - 1];
        }
        for (int i = 0; i < columns.length; i++) {
            if (columns[i].equalsIgnoreCase(String.valueOf(key))) {
                return row[i];
            }
        }
        return null;
    }

    private static ResultSet columnNullableResultSet(String isNullable, int nullableCode) {
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            (proxy, method, args) -> {
                if ("getString".equals(method.getName()) && "IS_NULLABLE".equals(args[0])) {
                    if (isNullable == null) {
                        throw new SQLException("Column not found: IS_NULLABLE");
                    }
                    return isNullable;
                }
                if ("getInt".equals(method.getName()) && "NULLABLE".equals(args[0])) {
                    return nullableCode;
                }
                return defaultValue(method.getReturnType());
            }
        );
    }

    private static Statement showFullColumnsStatement() {
        return (Statement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Statement.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "executeQuery" -> showFullColumnsResultSet();
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static ResultSet showFullColumnsResultSet() {
        String[] labels = { "Field", "Type", "Extra", "Comment" };
        String[][] rows = { { "name", "varchar(32)", "auto_increment", "姓名" } };
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            new java.lang.reflect.InvocationHandler() {
                private int index = -1;

                @Override
                public Object invoke(Object proxy, Method method, Object[] args) {
                    return switch (method.getName()) {
                        case "next" -> ++index < rows.length;
                        case "getMetaData" -> resultSetMeta(labels);
                        case "getString" -> rows[index][((Integer) args[0]) - 1];
                        case "close" -> null;
                        default -> defaultValue(method.getReturnType());
                    };
                }
            }
        );
    }

    private static ResultSetMetaData resultSetMeta(String[] labels) {
        return (ResultSetMetaData) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSetMetaData.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "getColumnCount" -> labels.length;
                case "getColumnLabel", "getColumnName" -> labels[((Integer) args[0]) - 1];
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static final class PrestoMetadataDriver implements Driver {
        private final List<String> calls;

        private PrestoMetadataDriver(List<String> calls) {
            this.calls = calls;
        }

        @Override
        public Connection connect(String url, Properties info) throws SQLException {
            if (!acceptsURL(url)) {
                return null;
            }
            return prestoMetadataConnection(calls);
        }

        @Override
        public boolean acceptsURL(String url) {
            return url != null && url.startsWith("jdbc:presto:");
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
            return new DriverPropertyInfo[0];
        }

        @Override
        public int getMajorVersion() {
            return 1;
        }

        @Override
        public int getMinorVersion() {
            return 0;
        }

        @Override
        public boolean jdbcCompliant() {
            return false;
        }

        @Override
        public java.util.logging.Logger getParentLogger() {
            return java.util.logging.Logger.getGlobal();
        }
    }

    private static Connection prestoMetadataConnection(List<String> calls) {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "prepareStatement" -> {
                    String sql = String.valueOf(args[0]);
                    calls.add("prepare:" + sql);
                    yield prestoMetadataStatement(calls, sql);
                }
                case "getMetaData" -> throw new SQLException("DatabaseMetaData should not be used for Presto metadata");
                case "isClosed" -> false;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static PreparedStatement prestoMetadataStatement(List<String> calls, String sql) {
        return (PreparedStatement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { PreparedStatement.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "setString" -> {
                    calls.add("setString:" + args[0] + ":" + args[1]);
                    yield null;
                }
                case "executeQuery" -> {
                    calls.add("executeQuery");
                    yield sql.contains("information_schema.columns") ? prestoColumnMetadataResultSet() : prestoMetadataResultSet();
                }
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static ResultSet prestoColumnMetadataResultSet() {
        String[] labels = { "column_name", "data_type", "is_nullable", "column_default", "comment" };
        Object[][] rows = { { "amount", "decimal(12,2)", "NO", null, "daily amount" } };
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            new java.lang.reflect.InvocationHandler() {
                private int index = -1;

                @Override
                public Object invoke(Object proxy, Method method, Object[] args) {
                    return switch (method.getName()) {
                        case "next" -> ++index < rows.length;
                        case "getMetaData" -> resultSetMeta(labels);
                        case "getString" -> {
                            Object value = rows[index][((Integer) args[0]) - 1];
                            yield value == null ? null : value.toString();
                        }
                        case "getObject" -> rows[index][((Integer) args[0]) - 1];
                        case "close" -> null;
                        default -> defaultValue(method.getReturnType());
                    };
                }
            }
        );
    }

    private static ResultSet prestoMetadataResultSet() {
        String[] labels = { "table_name", "table_type" };
        String[][] rows = { { "daily_revenue", "BASE TABLE" }, { "revenue_view", "VIEW" } };
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            new java.lang.reflect.InvocationHandler() {
                private int index = -1;

                @Override
                public Object invoke(Object proxy, Method method, Object[] args) {
                    return switch (method.getName()) {
                        case "next" -> ++index < rows.length;
                        case "getMetaData" -> resultSetMeta(labels);
                        case "getString" -> rows[index][((Integer) args[0]) - 1];
                        case "getObject" -> rows[index][((Integer) args[0]) - 1];
                        case "close" -> null;
                        default -> defaultValue(method.getReturnType());
                    };
                }
            }
        );
    }

    private static final class RecordingConnectDriver implements Driver {
        private final String urlPrefix;
        private final List<String> urls = new ArrayList<>();
        private final List<Properties> properties = new ArrayList<>();

        private RecordingConnectDriver(String urlPrefix) {
            this.urlPrefix = urlPrefix;
        }

        @Override
        public Connection connect(String url, Properties info) throws SQLException {
            if (!acceptsURL(url)) {
                return null;
            }
            urls.add(url);
            Properties copy = new Properties();
            copy.putAll(info);
            properties.add(copy);
            return recordingConnection();
        }

        @Override
        public boolean acceptsURL(String url) {
            return url != null && url.startsWith(urlPrefix);
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
            return new DriverPropertyInfo[0];
        }

        @Override
        public int getMajorVersion() {
            return 1;
        }

        @Override
        public int getMinorVersion() {
            return 0;
        }

        @Override
        public boolean jdbcCompliant() {
            return false;
        }

        @Override
        public java.util.logging.Logger getParentLogger() {
            return java.util.logging.Logger.getGlobal();
        }
    }

    private static final class HiveMetadataDriver implements Driver {
        private final List<String> calls;

        private HiveMetadataDriver(List<String> calls) {
            this.calls = calls;
        }

        @Override
        public Connection connect(String url, Properties info) {
            return acceptsURL(url) ? hiveMetadataConnection(calls) : null;
        }

        @Override
        public boolean acceptsURL(String url) {
            return url != null && url.startsWith("jdbc:hive2:dbx-schema-fallback");
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
            return new DriverPropertyInfo[0];
        }

        @Override
        public int getMajorVersion() {
            return 1;
        }

        @Override
        public int getMinorVersion() {
            return 0;
        }

        @Override
        public boolean jdbcCompliant() {
            return false;
        }

        @Override
        public java.util.logging.Logger getParentLogger() {
            return java.util.logging.Logger.getGlobal();
        }
    }

    private static Connection hiveMetadataConnection(List<String> calls) {
        DatabaseMetaData metadata = (DatabaseMetaData) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { DatabaseMetaData.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "getCatalogs" -> {
                    calls.add("getCatalogs");
                    yield rowsResultSet(new String[] { "TABLE_CAT" }, new Object[0][]);
                }
                case "getSchemas" -> {
                    calls.add("getSchemas");
                    yield rowsResultSet(
                        new String[] { "TABLE_SCHEM" },
                        new Object[][] { { "default" }, { "warehouse" }, { "default" } }
                    );
                }
                default -> defaultValue(method.getReturnType());
            }
        );
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "getMetaData" -> metadata;
                case "isClosed" -> false;
                case "isValid" -> true;
                case "getCatalog" -> null;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private enum RoutineMetadataBehavior {
        NULL,
        ROWS,
        SQL_EXCEPTION
    }

    private record RoutineMetadataResponse(JsonNode response, List<String> calls) {}

    private static RoutineMetadataResponse requestRoutineObjects(
        String id,
        RoutineMetadataBehavior procedures,
        RoutineMetadataBehavior functions,
        boolean failTables,
        String... objectTypes
    ) throws Exception {
        List<String> calls = new ArrayList<>();
        String url = "jdbc:dbx-" + id + ":";
        Driver driver = new RoutineMetadataDriver(url, procedures, functions, failTables, calls);
        DriverManager.registerDriver(driver);
        String connection = """
            { "connection_string": "%sdemo" }
            """.formatted(url);
        String objectTypeParams = objectTypes.length == 0
            ? ""
            : ", \"object_types\": [\"" + String.join("\", \"", objectTypes) + "\"]";
        try {
            JsonNode response = request("listObjects", """
                { "connection": %s, "schema": "PUBLIC"%s }
                """.formatted(connection, objectTypeParams));
            return new RoutineMetadataResponse(response, calls);
        } finally {
            closeAndDeregister(connection, driver);
        }
    }

    private static final class RoutineMetadataDriver implements Driver {
        private final String urlPrefix;
        private final RoutineMetadataBehavior procedures;
        private final RoutineMetadataBehavior functions;
        private final boolean failTables;
        private final List<String> calls;

        private RoutineMetadataDriver(
            String urlPrefix,
            RoutineMetadataBehavior procedures,
            RoutineMetadataBehavior functions,
            boolean failTables,
            List<String> calls
        ) {
            this.urlPrefix = urlPrefix;
            this.procedures = procedures;
            this.functions = functions;
            this.failTables = failTables;
            this.calls = calls;
        }

        @Override
        public Connection connect(String url, Properties info) {
            return acceptsURL(url) ? routineMetadataConnection(procedures, functions, failTables, calls) : null;
        }

        @Override
        public boolean acceptsURL(String url) {
            return url != null && url.startsWith(urlPrefix);
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
            return new DriverPropertyInfo[0];
        }

        @Override
        public int getMajorVersion() {
            return 1;
        }

        @Override
        public int getMinorVersion() {
            return 0;
        }

        @Override
        public boolean jdbcCompliant() {
            return false;
        }

        @Override
        public java.util.logging.Logger getParentLogger() {
            return java.util.logging.Logger.getGlobal();
        }
    }

    private static Connection routineMetadataConnection(
        RoutineMetadataBehavior procedures,
        RoutineMetadataBehavior functions,
        boolean failTables,
        List<String> calls
    ) {
        DatabaseMetaData metadata = (DatabaseMetaData) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { DatabaseMetaData.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "getTableTypes" -> {
                    calls.add("getTableTypes");
                    yield rowsResultSet(new String[] { "TABLE_TYPE" }, new Object[][] { { "TABLE" } });
                }
                case "getTables" -> {
                    calls.add("getTables");
                    if (failTables) {
                        throw new SQLException("required table metadata failed");
                    }
                    yield rowsResultSet(
                        new String[] { "TABLE_NAME", "TABLE_TYPE", "REMARKS" },
                        new Object[][] { { "meters", "TABLE", "TDengine table" } }
                    );
                }
                case "getProcedures" -> {
                    calls.add("getProcedures");
                    yield routineMetadataResult(procedures, true);
                }
                case "getFunctions" -> {
                    calls.add("getFunctions");
                    yield routineMetadataResult(functions, false);
                }
                default -> defaultValue(method.getReturnType());
            }
        );
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "getMetaData" -> metadata;
                case "isClosed" -> false;
                case "isValid" -> true;
                case "getCatalog", "getSchema", "close", "setCatalog", "setSchema" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static ResultSet routineMetadataResult(RoutineMetadataBehavior behavior, boolean procedures)
        throws SQLException {
        if (behavior == RoutineMetadataBehavior.NULL) {
            return null;
        }
        if (behavior == RoutineMetadataBehavior.SQL_EXCEPTION) {
            throw new SQLException("optional routine metadata failed");
        }
        return procedures
            ? rowsResultSet(
                new String[] { "PROCEDURE_NAME", "REMARKS" },
                new Object[][] { { "shared_routine", "procedure" } }
            )
            : rowsResultSet(
                new String[] { "FUNCTION_NAME", "REMARKS" },
                new Object[][] { { "shared_routine", "duplicate" }, { "unique_function", "function" } }
            );
    }

    private static final class GaussDbMetadataDriver implements Driver {
        private final List<String> calls;

        private GaussDbMetadataDriver(List<String> calls) {
            this.calls = calls;
        }

        @Override
        public Connection connect(String url, Properties info) {
            return acceptsURL(url) ? gaussDbMetadataConnection(calls) : null;
        }

        @Override
        public boolean acceptsURL(String url) {
            return url != null && url.startsWith("jdbc:gaussdb:");
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
            return new DriverPropertyInfo[0];
        }

        @Override
        public int getMajorVersion() {
            return 1;
        }

        @Override
        public int getMinorVersion() {
            return 0;
        }

        @Override
        public boolean jdbcCompliant() {
            return false;
        }

        @Override
        public java.util.logging.Logger getParentLogger() {
            return java.util.logging.Logger.getGlobal();
        }
    }

    private static Connection gaussDbMetadataConnection(List<String> calls) {
        DatabaseMetaData metadata = (DatabaseMetaData) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { DatabaseMetaData.class },
            (proxy, method, args) -> {
                if ("getColumns".equals(method.getName())) {
                    calls.add("columns:" + metadataArgument(args[0]) + ":" + metadataArgument(args[1]) + ":" + metadataArgument(args[2]));
                    return rowsResultSet(
                        new String[] {
                            "TABLE_CAT",
                            "TABLE_SCHEM",
                            "TABLE_NAME",
                            "COLUMN_NAME",
                            "TYPE_NAME",
                            "IS_NULLABLE",
                            "NULLABLE",
                            "COLUMN_DEF",
                            "REMARKS",
                            "COLUMN_SIZE",
                            "DECIMAL_DIGITS"
                        },
                        new Object[][] {
                            { null, "APP", "ORDERS", "id", "BIGINT", "NO", DatabaseMetaData.columnNoNulls, null, null, 19, 0 }
                        }
                    );
                }
                if ("getPrimaryKeys".equals(method.getName())) {
                    calls.add("primaryKeys:" + metadataArgument(args[0]) + ":" + metadataArgument(args[1]) + ":" + metadataArgument(args[2]));
                    boolean actualIdentity = args[0] == null && "APP".equals(args[1]) && "ORDERS".equals(args[2]);
                    return rowsResultSet(
                        new String[] { "COLUMN_NAME" },
                        actualIdentity ? new Object[][] { { "ID" } } : new Object[0][]
                    );
                }
                return defaultValue(method.getReturnType());
            }
        );
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "getMetaData" -> metadata;
                case "isClosed" -> false;
                case "isValid" -> true;
                case "close", "setCatalog", "setSchema" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static String metadataArgument(Object value) {
        return value == null ? "<null>" : String.valueOf(value);
    }

    private static void closeAndDeregister(String connection, Driver driver) throws Exception {
        try {
            request("close", """
                { "connection": %s }
                """.formatted(connection));
        } finally {
            DriverManager.deregisterDriver(driver);
        }
    }

    private static Connection recordingConnection() {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "isClosed" -> false;
                case "isValid" -> true;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static final class OracleExplainDriver implements Driver {
        private final List<String> calls;

        private OracleExplainDriver(List<String> calls) {
            this.calls = calls;
        }

        @Override
        public Connection connect(String url, Properties info) {
            if (!acceptsURL(url)) return null;
            calls.add("connect");
            return oracleExplainConnection(calls);
        }

        @Override
        public boolean acceptsURL(String url) {
            return url != null && url.startsWith("jdbc:oracle:dbx-explain:");
        }

        @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) { return new DriverPropertyInfo[0]; }
        @Override public int getMajorVersion() { return 1; }
        @Override public int getMinorVersion() { return 0; }
        @Override public boolean jdbcCompliant() { return false; }
        @Override public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getGlobal(); }
    }

    private static Connection oracleExplainConnection(List<String> calls) {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "prepareStatement" -> oracleExplainStatement(String.valueOf(args[0]), calls);
                case "isClosed" -> false;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static PreparedStatement oracleExplainStatement(String sql, List<String> calls) {
        calls.add("prepare:" + sql);
        return (PreparedStatement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { PreparedStatement.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "setString" -> {
                    calls.add("bind:" + args[0] + ":" + args[1]);
                    yield null;
                }
                case "setQueryTimeout", "close" -> null;
                case "execute" -> true;
                case "executeUpdate" -> 1;
                case "executeQuery" -> rowsResultSet(
                    new String[] { "PLAN_TABLE_OUTPUT" },
                    new Object[][] { { "Plan hash value: 123" }, { "TABLE ACCESS FULL DUAL" } }
                );
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static final class OracleDateDriver implements Driver {
        private final Timestamp[] values;
        private final List<String> calls;

        private OracleDateDriver(Timestamp[] values, List<String> calls) {
            this.values = values;
            this.calls = calls;
        }

        @Override
        public Connection connect(String url, Properties info) {
            return acceptsURL(url) ? oracleDateConnection(values, calls) : null;
        }

        @Override
        public boolean acceptsURL(String url) {
            return url != null && url.startsWith("jdbc:oracle:dbx-date:");
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
            return new DriverPropertyInfo[0];
        }

        @Override
        public int getMajorVersion() {
            return 1;
        }

        @Override
        public int getMinorVersion() {
            return 0;
        }

        @Override
        public boolean jdbcCompliant() {
            return false;
        }

        @Override
        public java.util.logging.Logger getParentLogger() {
            return java.util.logging.Logger.getGlobal();
        }
    }

    private static Connection oracleDateConnection(Timestamp[] values, List<String> calls) {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "createStatement" -> oracleDateStatement(values, calls);
                case "isClosed" -> false;
                case "close", "setCatalog", "setSchema" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Statement oracleDateStatement(Timestamp[] values, List<String> calls) {
        ResultSet resultSet = oracleDateResultSet(values, calls);
        return (Statement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Statement.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "execute" -> true;
                case "getResultSet" -> resultSet;
                case "getUpdateCount" -> -1;
                case "setMaxRows", "setFetchSize", "setQueryTimeout", "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static ResultSet oracleDateResultSet(Timestamp[] values, List<String> calls) {
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            new java.lang.reflect.InvocationHandler() {
                private int index = -1;

                @Override
                public Object invoke(Object proxy, Method method, Object[] args) {
                    return switch (method.getName()) {
                        case "next" -> ++index < values.length;
                        case "getMetaData" -> columnMeta(Types.DATE);
                        case "getObject" -> values[index];
                        case "getDate" -> {
                            calls.add("getDate");
                            yield Date.valueOf(values[index].toLocalDateTime().toLocalDate());
                        }
                        case "getTimestamp" -> {
                            calls.add("getTimestamp");
                            yield values[index];
                        }
                        case "close" -> null;
                        default -> defaultValue(method.getReturnType());
                    };
                }
            }
        );
    }

    private static final class BrokenResultSetDriver implements Driver {
        private final String urlPrefix;
        private final boolean executeReturnsResultSet;
        private final int updateCount;
        private final List<String> calls;

        private BrokenResultSetDriver(String urlPrefix, boolean executeReturnsResultSet, int updateCount) {
            this(urlPrefix, executeReturnsResultSet, updateCount, new ArrayList<>());
        }

        private BrokenResultSetDriver(String urlPrefix, boolean executeReturnsResultSet, int updateCount, List<String> calls) {
            this.urlPrefix = urlPrefix;
            this.executeReturnsResultSet = executeReturnsResultSet;
            this.updateCount = updateCount;
            this.calls = calls;
        }

        @Override
        public Connection connect(String url, Properties info) throws SQLException {
            if (!acceptsURL(url)) {
                return null;
            }
            return brokenResultSetConnection(executeReturnsResultSet, updateCount, calls);
        }

        @Override
        public boolean acceptsURL(String url) {
            return url != null && url.startsWith(urlPrefix);
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
            return new DriverPropertyInfo[0];
        }

        @Override
        public int getMajorVersion() {
            return 1;
        }

        @Override
        public int getMinorVersion() {
            return 0;
        }

        @Override
        public boolean jdbcCompliant() {
            return false;
        }

        @Override
        public java.util.logging.Logger getParentLogger() {
            return java.util.logging.Logger.getGlobal();
        }
    }

    private static Connection brokenResultSetConnection(boolean executeReturnsResultSet, int updateCount, List<String> calls) {
        return (Connection) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "createStatement" -> brokenResultSetStatement(executeReturnsResultSet, updateCount, calls);
                case "isClosed" -> false;
                case "close" -> null;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Statement brokenResultSetStatement(boolean executeReturnsResultSet, int updateCount, List<String> calls) {
        return (Statement) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { Statement.class },
            (proxy, method, args) -> {
                if ("execute".equals(method.getName()) || "executeQuery".equals(method.getName())) {
                    calls.add(method.getName());
                }
                return switch (method.getName()) {
                    case "execute" -> executeReturnsResultSet;
                    case "getResultSet" -> null;
                    case "getUpdateCount" -> updateCount;
                    case "executeQuery" -> singleRowResultSet();
                    case "setMaxRows", "setFetchSize", "setQueryTimeout", "close" -> null;
                    default -> defaultValue(method.getReturnType());
                };
            }
        );
    }

    private static ResultSet singleRowResultSet() {
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            new java.lang.reflect.InvocationHandler() {
                private int index = -1;

                @Override
                public Object invoke(Object proxy, Method method, Object[] args) {
                    return switch (method.getName()) {
                        case "next" -> ++index == 0;
                        case "getMetaData" -> singleColumnMeta();
                        case "getObject", "getString" -> "row-value";
                        case "close" -> null;
                        default -> defaultValue(method.getReturnType());
                    };
                }
            }
        );
    }

    private static ResultSetMetaData singleColumnMeta() {
        return (ResultSetMetaData) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSetMetaData.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "getColumnCount" -> 1;
                case "getColumnLabel", "getColumnName" -> "VALUE";
                case "getColumnType" -> Types.VARCHAR;
                default -> defaultValue(method.getReturnType());
            }
        );
    }

    private static Object defaultValue(Class<?> returnType) {
        if (returnType == boolean.class) return false;
        if (returnType == byte.class) return (byte) 0;
        if (returnType == short.class) return (short) 0;
        if (returnType == int.class) return 0;
        if (returnType == long.class) return 0L;
        if (returnType == float.class) return 0f;
        if (returnType == double.class) return 0d;
        if (returnType == char.class) return '\0';
        return null;
    }

    public static final class ErrorOnLoad {
        private static final Object FAILURE = fail();

        private static Object fail() {
            throw new AssertionError("linkage boom");
        }
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
