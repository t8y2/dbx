package com.dbx.agent.tdengine;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.JdbcAgentFake;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import com.dbx.agent.test.TestSupport;
import com.taosdata.jdbc.TSDBDriver;
import com.taosdata.jdbc.rs.RestfulConnection;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import javax.sql.DataSource;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class TDengineAgentExecutionTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new TDengineAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SHOW DATABASES";
    }
}

class TDengineAgentMetadataTest {
    @Test
    void buildsWebsocketJdbcUrlWithDefaultPortAndDatabase() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("127.0.0.1", 0, "meters", "root", "taosdata", "", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-WS://127.0.0.1:6041/meters", url);
    }

    @Test
    void preservesCustomWebsocketPortAndUrlParams() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("td.local", 6042, "", "", "", "timezone=UTC&charset=UTF-8", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-WS://td.local:6042/?timezone=UTC&charset=UTF-8", url);
    }

    @Test
    void supportsRestTransportViaCompatibilityUrlParam() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("127.0.0.1", 0, "testdb", "", "", "dbx.transport=rest&charset=UTF-8", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-RS://127.0.0.1:6041/testdb?charset=UTF-8", url);
    }

    @Test
    void stripsTransportControlParamFromJdbcQuery() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("127.0.0.1", 6041, "", "", "", "transport=ws&timezone=UTC", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-WS://127.0.0.1:6041/?timezone=UTC", url);
    }

    @Test
    void usesTdengineShowStatementsForMetadata() {
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listDatabases();
        agent.listTables("power");
        agent.getColumns("power", "meters");

        Assertions.assertEquals("SHOW DATABASES", JdbcMetadataSqlFake.statements.get(0));
        Assertions.assertEquals("SHOW `power`.STABLES", JdbcMetadataSqlFake.statements.get(1));
        Assertions.assertEquals("SHOW `power`.TABLES", JdbcMetadataSqlFake.statements.get(2));
        Assertions.assertFalse(JdbcMetadataSqlFake.statements.stream().anyMatch(sql -> sql.contains("information_schema")));
        Assertions.assertTrue(JdbcMetadataSqlFake.statements.contains("DESCRIBE `power`.`meters`"));
    }

    @Test
    void showMetadataCachesFullResultsForLocalPaging() {
        List<String> statements = new ArrayList<>();
        List<Integer> maxRows = new ArrayList<>();
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, showMetadataConnection(statements, maxRows));

        List<TableInfo> firstPage = agent.listTables(
            "dbx_alpha",
            new MetadataListConstraints(null, 2, null, List.of("TABLE"))
        );
        List<TableInfo> secondPage = agent.listTables(
            "dbx_alpha",
            new MetadataListConstraints(null, 2, 2, List.of("TABLE"))
        );

        Assertions.assertEquals(List.of("meters", "device_a"), firstPage.stream().map(TableInfo::getName).toList());
        Assertions.assertEquals(List.of("device_b", "standalone"), secondPage.stream().map(TableInfo::getName).toList());
        Assertions.assertEquals("meters", secondPage.get(0).getParent_name());
        Assertions.assertTrue(maxRows.isEmpty());
        Assertions.assertEquals(
            List.of(
                "SHOW `dbx_alpha`.STABLES",
                "SHOW `dbx_alpha`.TABLES"
            ),
            statements
        );
    }

    @Test
    void showMetadataFiltersLocallyBeforeApplyingRowLimit() {
        List<String> statements = new ArrayList<>();
        List<Integer> maxRows = new ArrayList<>();
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, showMetadataConnection(statements, maxRows));

        List<TableInfo> tables = agent.listTables(
            "dbx_alpha",
            new MetadataListConstraints("stand", 1, null, List.of("TABLE"))
        );

        Assertions.assertEquals(List.of("standalone"), tables.stream().map(TableInfo::getName).toList());
        Assertions.assertTrue(maxRows.isEmpty());
        Assertions.assertEquals(
            List.of(
                "SHOW `dbx_alpha`.STABLES",
                "SHOW `dbx_alpha`.TABLES"
            ),
            statements
        );
    }

    @Test
    void showMetadataFallsBackToLocalFilteringForLongLikePatterns() {
        List<String> statements = new ArrayList<>();
        List<Integer> maxRows = new ArrayList<>();
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, showMetadataConnection(statements, maxRows));

        agent.listTables(
            "dbx_alpha",
            new MetadataListConstraints("a".repeat(50), 1, null, List.of("TABLE"))
        );

        Assertions.assertTrue(maxRows.isEmpty());
        Assertions.assertEquals(
            List.of(
                "SHOW `dbx_alpha`.STABLES",
                "SHOW `dbx_alpha`.TABLES"
            ),
            statements
        );
    }

    @Test
    void showMetadataDoesNotLoadTableComments() {
        List<String> statements = new ArrayList<>();
        List<Integer> maxRows = new ArrayList<>();
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, showMetadataConnection(statements, maxRows));

        List<TableInfo> tables = agent.listTables("dbx_alpha");

        Assertions.assertNull(tables.get(0).getComment());
        Assertions.assertEquals(
            List.of(
                "SHOW `dbx_alpha`.STABLES",
                "SHOW `dbx_alpha`.TABLES"
            ),
            statements
        );
    }

    @Test
    void showMetadataFiltersByNameWithoutInformationSchema() {
        List<String> statements = new ArrayList<>();
        List<Integer> maxRows = new ArrayList<>();
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, showMetadataConnection(statements, maxRows));

        List<TableInfo> tables = agent.listTables(
            "dbx_alpha",
            new MetadataListConstraints("device_b", 1, null, List.of("TABLE"))
        );

        Assertions.assertEquals(List.of("device_b"), tables.stream().map(TableInfo::getName).toList());
        Assertions.assertTrue(maxRows.isEmpty());
    }

    @Test
    void sortsSupertablesBeforeTheirChildTables() {
        List<TableInfo> tables = new ArrayList<>(Arrays.asList(
            new TableInfo("device_b", "TABLE", null, null, "meters"),
            new TableInfo("standalone", "TABLE", null),
            new TableInfo("meters", "STABLE", null),
            new TableInfo("device_a", "TABLE", null, null, "meters")
        ));

        TDengineAgent.sortTablesForHierarchy(tables);

        Assertions.assertEquals(
            Arrays.asList("meters", "device_a", "device_b", "standalone"),
            tables.stream().map(TableInfo::getName).toList()
        );
        Assertions.assertEquals("meters", tables.get(1).getParent_name());
    }

    @Test
    void marksTimestampAndCompositeKeyDescribeColumnsAsPrimaryKeys() throws Exception {
        ResultSet resultSet = describeResultSet(new String[][] {
            {"ts", "TIMESTAMP", "8", ""},
            {"seq", "INT", "4", "COMPOSITE KEY"},
            {"voltage", "FLOAT", "4", ""},
            {"site", "VARCHAR(32)", "32", "TAG"}
        });

        List<ColumnInfo> columns = TDengineAgent.readDescribeColumns(resultSet);

        Assertions.assertTrue(columns.get(0).getIs_primary_key());
        Assertions.assertFalse(columns.get(0).getIs_nullable());
        Assertions.assertTrue(columns.get(1).getIs_primary_key());
        Assertions.assertFalse(columns.get(1).getIs_nullable());
        Assertions.assertFalse(columns.get(2).getIs_primary_key());
        Assertions.assertFalse(columns.get(3).getIs_primary_key());
        Assertions.assertEquals("TAG", columns.get(3).getExtra());
    }

    @Test
    void doesNotExposeDatabasesAsSchemas() {
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        Assertions.assertTrue(agent.listSchemas().isEmpty());
        Assertions.assertTrue(JdbcMetadataSqlFake.statements.isEmpty());
    }

    private static Connection showMetadataConnection(List<String> statements, List<Integer> maxRows) {
        return proxy(Connection.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("createStatement".equals(name)) {
                return showMetadataStatement(statements, maxRows);
            }
            if ("isClosed".equals(name)) return false;
            if ("close".equals(name)) return null;
            return defaultValue(method.getReturnType());
        });
    }

    private static java.sql.Statement showMetadataStatement(List<String> statements, List<Integer> maxRows) {
        int[] activeMaxRows = {0};
        return proxy(java.sql.Statement.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("setMaxRows".equals(name)) {
                activeMaxRows[0] = (Integer) args[0];
                maxRows.add(activeMaxRows[0]);
                return null;
            }
            if ("executeQuery".equals(name)) {
                String sql = (String) args[0];
                statements.add(sql);
                if (sql.endsWith("STABLES")) {
                    return showTableResultSet(List.of(new String[] {"meters"}, new String[] {"weather"}), activeMaxRows[0]);
                }
                if (sql.endsWith("TABLES")) {
                    return showTableResultSet(
                        List.of(
                            new String[] {"device_a", "", "", "meters"},
                            new String[] {"device_b", "", "", "meters"},
                            new String[] {"standalone", "", "", ""}
                        ),
                        activeMaxRows[0]
                    );
                }
            }
            if ("close".equals(name)) return null;
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet showTableResultSet(List<String[]> rows, int maxRows) {
        List<String[]> limitedRows = maxRows > 0 ? rows.subList(0, Math.min(rows.size(), maxRows)) : rows;
        int[] index = {-1};
        return proxy(ResultSet.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("next".equals(name)) {
                index[0] += 1;
                return index[0] < limitedRows.size();
            }
            if ("getString".equals(name)) {
                int column = (Integer) args[0];
                String[] row = limitedRows.get(index[0]);
                return column <= row.length ? row[column - 1] : null;
            }
            if ("isClosed".equals(name)) return false;
            if ("close".equals(name)) return null;
            return defaultValue(method.getReturnType());
        });
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) return false;
        if (Integer.TYPE.equals(type)) return 0;
        if (Long.TYPE.equals(type)) return 0L;
        if (Double.TYPE.equals(type)) return 0.0d;
        if (Float.TYPE.equals(type)) return 0.0f;
        if (Short.TYPE.equals(type)) return (short) 0;
        if (Byte.TYPE.equals(type)) return (byte) 0;
        if (Character.TYPE.equals(type)) return '\0';
        return null;
    }

    @Test
    void setsDatabaseBeforeExecutionWhenSchemaIsProvided() {
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        agent.executeQuery("SELECT 1", "power", new ExecuteQueryOptions());

        // JdbcSchemaSwitcher executes the USE statement (recorded as "execute")
        // before the query runs, so the database is switched prior to execution.
        Assertions.assertEquals(
            Arrays.asList("execute", "setMaxRows:10001", "execute"),
            JdbcAgentFake.calls
        );
    }

    @Test
    void restExecutionSwitchesCatalogWithoutGeneratingUseSql() throws Exception {
        try (RestfulConnection connection = restfulConnection()) {
            String executionSchema = TDengineAgent.prepareExecutionSchema(connection, " power-data ");

            Assertions.assertNull(executionSchema);
            Assertions.assertEquals("power-data", connection.getCatalog());
            Assertions.assertEquals(
                "power-data",
                connection.getClientInfo(TSDBDriver.PROPERTY_KEY_DBNAME)
            );
        }
    }

    @Test
    void restExecutionSupportsPooledWrappersAndRestoresOriginalDatabase() throws Exception {
        Properties properties = new Properties();
        properties.setProperty(TSDBDriver.PROPERTY_KEY_DBNAME, "original");
        try (RestfulConnection physical = restfulConnection(properties)) {
            physical.setCatalog("original");
            Connection pooled = wrapperConnection(physical);

            Assertions.assertNull(TDengineAgent.prepareExecutionSchema(pooled, "power"));
            Assertions.assertEquals("power", pooled.getCatalog());
            Assertions.assertEquals("power", pooled.getClientInfo(TSDBDriver.PROPERTY_KEY_DBNAME));

            TDengineAgent.restoreRestfulConnectionState(pooled, "original", "original");
            Assertions.assertEquals("original", pooled.getCatalog());
            Assertions.assertEquals("original", pooled.getClientInfo(TSDBDriver.PROPERTY_KEY_DBNAME));
        }
    }

    @Test
    void hikariCanManageRestfulConnectionsWithoutLosingNativeAccess() throws Exception {
        RestfulConnection physical = restfulConnection();
        DataSource dataSource = proxy(DataSource.class, (proxy, method, args) -> {
            if ("getConnection".equals(method.getName())) {
                return physical;
            }
            return defaultValue(method.getReturnType());
        });
        HikariConfig config = new HikariConfig();
        config.setPoolName("tdengine-rest-test");
        config.setDataSource(dataSource);
        config.setMaximumPoolSize(1);
        config.setMinimumIdle(0);
        config.setInitializationFailTimeout(-1L);

        try (HikariDataSource pool = new HikariDataSource(config);
             Connection connection = pool.getConnection()) {
            Assertions.assertTrue(connection.isWrapperFor(RestfulConnection.class));
            Assertions.assertSame(physical, connection.unwrap(RestfulConnection.class));
            Assertions.assertNull(TDengineAgent.prepareExecutionSchema(connection, "power"));
            Assertions.assertEquals("power", connection.getCatalog());
        }
    }

    @Test
    void websocketExecutionKeepsSchemaForUseSqlSwitching() throws Exception {
        Connection connection = JdbcAgentFake.connection();

        Assertions.assertEquals(
            "power",
            TDengineAgent.prepareExecutionSchema(connection, "power")
        );
    }

    @Test
    void decodesTdengineByteArrayTextValues() {
        Assertions.assertEquals(
            "d1001",
            TDengineAgent.decodeTdengineValue("d1001".getBytes(StandardCharsets.UTF_8))
        );
    }

    @Test
    void formatsTdengineTimestampsAsSqlLiterals() {
        Assertions.assertEquals(
            "2026-05-16 09:35:58.123",
            TDengineAgent.decodeTdengineValue(Timestamp.valueOf("2026-05-16 09:35:58.123"))
        );
        Assertions.assertEquals(
            "2026-05-16 09:35:58.000",
            TDengineAgent.decodeTdengineValue(Timestamp.valueOf("2026-05-16 09:35:58"))
        );
        Assertions.assertEquals(
            "2026-05-16 09:35:58.123456",
            TDengineAgent.decodeTdengineValue(Timestamp.valueOf("2026-05-16 09:35:58.123456"))
        );
        Assertions.assertEquals(
            "2026-05-16 09:35:58.123456789",
            TDengineAgent.decodeTdengineValue(Timestamp.valueOf("2026-05-16 09:35:58.123456789"))
        );
    }

    @Test
    void unknownTransportValueDefaultsToWebsocketAndKeepsOtherParams() {
        String url = TDengineJdbcUrl.from(
            new ConnectParams("127.0.0.1", 6041, "", "", "", "transport=foo&timezone=UTC", "", false)
        );

        Assertions.assertEquals("jdbc:TAOS-WS://127.0.0.1:6041/?timezone=UTC", url);
    }

    @Test
    void sanitizeConnectionStringStripsTransportControlParams() {
        String sanitized = TDengineJdbcUrl.sanitizeConnectionString(
            "jdbc:TAOS-WS://127.0.0.1:6041/db?dbx.transport=rest&charset=UTF-8&transport=ws"
        );

        Assertions.assertEquals("jdbc:TAOS-WS://127.0.0.1:6041/db?charset=UTF-8", sanitized);
    }

    @Test
    void sanitizeConnectionStringKeepsFragmentAndNonControlParams() {
        String sanitized = TDengineJdbcUrl.sanitizeConnectionString(
            "jdbc:TAOS-RS://127.0.0.1:6041/db?timezone=UTC&dbx.transport=rest#anchor"
        );

        Assertions.assertEquals("jdbc:TAOS-RS://127.0.0.1:6041/db?timezone=UTC#anchor", sanitized);
    }

    private static ResultSet describeResultSet(String[][] rows) {
        int[] rowIndex = {-1};
        return (ResultSet) Proxy.newProxyInstance(
            ResultSet.class.getClassLoader(),
            new Class<?>[] {ResultSet.class},
            (proxy, method, args) -> {
                if ("next".equals(method.getName())) {
                    rowIndex[0] += 1;
                    return rowIndex[0] < rows.length;
                }
                if ("getString".equals(method.getName())) {
                    return rows[rowIndex[0]][((Integer) args[0]) - 1];
                }
                if ("close".equals(method.getName())) {
                    return null;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
    }

    private static RestfulConnection restfulConnection() {
        return restfulConnection(new Properties());
    }

    private static RestfulConnection restfulConnection(Properties properties) {
        return new RestfulConnection(
            "127.0.0.1",
            "6041",
            properties,
            "",
            "jdbc:TAOS-RS://127.0.0.1:6041/",
            null,
            false,
            null,
            null
        );
    }

    private static Connection wrapperConnection(Connection physical) {
        return proxy(Connection.class, (proxy, method, args) -> {
            if ("isWrapperFor".equals(method.getName())) {
                return ((Class<?>) args[0]).isInstance(physical);
            }
            if ("unwrap".equals(method.getName())) {
                return ((Class<?>) args[0]).cast(physical);
            }
            try {
                return method.invoke(physical, args);
            } catch (java.lang.reflect.InvocationTargetException error) {
                throw error.getCause();
            }
        });
    }
}
