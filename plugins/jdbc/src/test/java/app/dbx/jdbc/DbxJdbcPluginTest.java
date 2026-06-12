package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Date;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.sql.Timestamp;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
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
    void readValueFormatsDateColumnsWithoutMidnightTime() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("readValue", ResultSet.class, ResultSetMetaData.class, int.class);
        method.setAccessible(true);
        ResultSet rs = temporalResultSet(Timestamp.valueOf("2026-06-10 00:00:00"), Date.valueOf("2026-06-10"));

        assertEquals("2026-06-10", method.invoke(null, rs, columnMeta(Types.DATE), 1));
    }

    @Test
    void readValueKeepsTimestampTimeComponent() throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("readValue", ResultSet.class, ResultSetMetaData.class, int.class);
        method.setAccessible(true);
        Timestamp timestamp = Timestamp.valueOf("2026-06-10 12:34:56");
        ResultSet rs = temporalResultSet(timestamp, Date.valueOf("2026-06-10"));

        assertEquals("2026-06-10 12:34:56.0", method.invoke(null, rs, columnMeta(Types.TIMESTAMP), 1));
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
        JsonNode mysql = MAPPER.readTree("""
            {
              "connection_string": "jdbc:mysql://127.0.0.1:9030/demo"
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
            DbxJdbcPlugin.StatementMaxRowsMode.APPLY_STATEMENT_MAX_ROWS,
            DbxJdbcPlugin.driverQuirks(h2).statementMaxRowsMode()
        );
        assertEquals(true, DbxJdbcPlugin.driverQuirks(mysql).useCatalogFallbackSql());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(kingbase).ignoreCatalogForSchemaMetadata());
        assertEquals(true, DbxJdbcPlugin.driverQuirks(kyuubi).useCatalogFallbackSql());
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
    void defaultStatementOptionsApplyDriverMaxRowsProtection() throws Exception {
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

    private static ResultSet temporalResultSet(Object objectValue, Date dateValue) {
        return (ResultSet) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSet.class },
            (proxy, method, args) -> switch (method.getName()) {
                case "getObject", "getTimestamp" -> objectValue;
                case "getDate" -> dateValue;
                case "getBytes" -> null;
                default -> null;
            }
        );
    }

    private static ResultSetMetaData columnMeta(int columnType) {
        return (ResultSetMetaData) Proxy.newProxyInstance(
            DbxJdbcPluginTest.class.getClassLoader(),
            new Class<?>[] { ResultSetMetaData.class },
            (proxy, method, args) -> {
                if ("getColumnType".equals(method.getName())) {
                    return columnType;
                }
                return null;
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

    private static JsonNode request(String method, String params) throws Exception {
        Method handleLine = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handleLine.setAccessible(true);
        String line = """
            { "id": 1, "method": "%s", "params": %s }
            """.formatted(method, params);
        return MAPPER.valueToTree(handleLine.invoke(null, line));
    }
}
