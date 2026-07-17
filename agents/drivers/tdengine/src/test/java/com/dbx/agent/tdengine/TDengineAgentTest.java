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
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
    void usesTdengineMetadataStatements() {
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listDatabases();
        agent.listTables("power");
        agent.getColumns("power", "meters");

        Assertions.assertEquals("SHOW DATABASES", JdbcMetadataSqlFake.statements.get(0));
        Assertions.assertTrue(JdbcMetadataSqlFake.statements.get(1).contains("FROM information_schema.ins_stables"));
        Assertions.assertTrue(JdbcMetadataSqlFake.statements.get(1).contains("FROM information_schema.ins_tables"));
        Assertions.assertEquals("param:1=power", JdbcMetadataSqlFake.statements.get(2));
        Assertions.assertEquals("param:2=power", JdbcMetadataSqlFake.statements.get(3));
        Assertions.assertEquals("DESCRIBE `power`.`meters`", JdbcMetadataSqlFake.statements.get(4));
    }

    @Test
    void constrainedMetadataUsesRequestedDatabaseAndPushesFilterAndPaging() {
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables(
            "dbx_alpha",
            new MetadataListConstraints("ord", 25, 50, List.of("TABLE"))
        );

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertFalse(sql.contains("DATABASE()"), sql);
        Assertions.assertTrue(sql.contains("FROM information_schema.ins_stables"), sql);
        Assertions.assertTrue(sql.contains("FROM information_schema.ins_tables"), sql);
        Assertions.assertTrue(sql.contains("WHERE db_name = ?"), sql);
        Assertions.assertTrue(sql.contains("table_name LIKE ? OR table_comment LIKE ?"), sql);
        Assertions.assertTrue(sql.contains("ORDER BY hierarchy_name, hierarchy_rank, table_name"), sql);
        Assertions.assertTrue(sql.endsWith("LIMIT 25 OFFSET 50"), sql);
        Assertions.assertEquals(
            List.of(
                "param:1=dbx_alpha",
                "param:2=dbx_alpha",
                "param:3=%o%r%d%",
                "param:4=%o%r%d%"
            ),
            JdbcMetadataSqlFake.statements.subList(1, 5)
        );
    }

    @Test
    void constrainedMetadataPagesDoNotRepeatOrSkipTables() {
        List<TableInfo> metadata = List.of(
            new TableInfo("meters", "STABLE", null),
            new TableInfo("device_a", "TABLE", null, null, "meters"),
            new TableInfo("device_b", "TABLE", null, null, "meters"),
            new TableInfo("standalone", "TABLE", null),
            new TableInfo("weather", "STABLE", null)
        );
        List<String> statements = new ArrayList<>();
        TDengineAgent agent = new TDengineAgent();
        TestSupport.setPrivateConnection(agent, pagedMetadataConnection(metadata, statements));

        List<TableInfo> combined = new ArrayList<>();
        combined.addAll(agent.listTables("dbx_alpha", new MetadataListConstraints(null, 2, null, List.of("TABLE"))));
        combined.addAll(agent.listTables("dbx_alpha", new MetadataListConstraints(null, 2, 2, List.of("TABLE"))));
        combined.addAll(agent.listTables("dbx_alpha", new MetadataListConstraints(null, 2, 4, List.of("TABLE"))));

        Assertions.assertEquals(metadata.stream().map(TableInfo::getName).toList(), combined.stream().map(TableInfo::getName).toList());
        Set<String> distinctNames = new HashSet<>(combined.stream().map(TableInfo::getName).toList());
        Assertions.assertEquals(metadata.size(), distinctNames.size());
        Assertions.assertTrue(statements.get(0).endsWith("LIMIT 2"), statements.get(0));
        Assertions.assertTrue(statements.get(1).endsWith("LIMIT 2 OFFSET 2"), statements.get(1));
        Assertions.assertTrue(statements.get(2).endsWith("LIMIT 2 OFFSET 4"), statements.get(2));
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

    private static Connection pagedMetadataConnection(List<TableInfo> metadata, List<String> statements) {
        return proxy(Connection.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("prepareStatement".equals(name)) {
                String sql = (String) args[0];
                statements.add(sql);
                return pagedMetadataStatement(sql, metadata);
            }
            if ("isClosed".equals(name)) return false;
            if ("close".equals(name)) return null;
            return defaultValue(method.getReturnType());
        });
    }

    private static PreparedStatement pagedMetadataStatement(String sql, List<TableInfo> metadata) {
        return proxy(PreparedStatement.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("executeQuery".equals(name)) {
                int limit = sqlClauseValue(sql, "LIMIT", metadata.size());
                int offset = sqlClauseValue(sql, "OFFSET", 0);
                int from = Math.min(offset, metadata.size());
                int to = Math.min(from + limit, metadata.size());
                return tableInfoResultSet(metadata.subList(from, to));
            }
            if ("setString".equals(name) || "setInt".equals(name) || "setObject".equals(name) || "close".equals(name)) return null;
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet tableInfoResultSet(List<TableInfo> tables) {
        int[] index = {-1};
        return proxy(ResultSet.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("next".equals(name)) {
                index[0] += 1;
                return index[0] < tables.size();
            }
            if ("getString".equals(name)) {
                TableInfo table = tables.get(index[0]);
                int column = (Integer) args[0];
                if (column == 1) return table.getName();
                if (column == 2) return table.getTable_type();
                if (column == 3) return table.getComment();
                if (column == 4) return table.getParent_name();
            }
            if ("close".equals(name)) return null;
            return defaultValue(method.getReturnType());
        });
    }

    private static int sqlClauseValue(String sql, String clause, int fallback) {
        Matcher matcher = Pattern.compile("\\b" + clause + "\\s+(\\d+)").matcher(sql);
        return matcher.find() ? Integer.parseInt(matcher.group(1)) : fallback;
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
}
