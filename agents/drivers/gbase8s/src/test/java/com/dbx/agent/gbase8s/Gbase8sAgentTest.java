package com.dbx.agent.gbase8s;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;

class Gbase8sAgentTest {
    @Test
    void declaresGbase8sProfile() {
        Gbase8sAgent agent = new Gbase8sAgent();

        Assertions.assertEquals("com.gbasedbt.jdbc.Driver", agent.getProfile().getDriverClass());
        Assertions.assertEquals("jdbc:gbasedbt-sqli://{host}:{port}/{database}:GBASEDBTSERVER=gbase8s", agent.getProfile().getUrlTemplate());
        Assertions.assertEquals(9088, agent.getProfile().getDefaultPort());
        Assertions.assertTrue(agent.getProfile().getSkipExecutionContext());
    }

    @Test
    void buildsGbase8sJdbcUrlWithExplicitServerAndLocaleParameters() {
        String url = Gbase8sAgent.buildUrl(
            new ConnectParams(
                "172.26.128.159",
                20013,
                "testdb",
                "",
                "",
                "GBASEDBTSERVER=gbase01;CLIENT_LOCALE=zh_cn.utf8;DB_LOCALE=zh_cn.utf8",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:gbasedbt-sqli://172.26.128.159:20013/testdb:GBASEDBTSERVER=gbase01;CLIENT_LOCALE=zh_cn.utf8;DB_LOCALE=zh_cn.utf8",
            url
        );
    }

    @Test
    void fallsBackToHostAsGbaseServerWhenNoExplicitServerIsConfigured() {
        String url = Gbase8sAgent.buildUrl(
            new ConnectParams(
                "gbase-host",
                9088,
                "sysmaster",
                "",
                "",
                "",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:gbasedbt-sqli://gbase-host:9088/sysmaster:GBASEDBTSERVER=gbase-host",
            url
        );
    }

    @Test
    void fallsBackToGbaseServerNameWhenHostIsAnIpAddress() {
        String url = Gbase8sAgent.buildUrl(
            new ConnectParams(
                "172.26.128.159",
                0,
                "sysmaster",
                "",
                "",
                "",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:gbasedbt-sqli://172.26.128.159:9088/sysmaster:GBASEDBTSERVER=gbase8s",
            url
        );
    }

    @Test
    void usesConnectionStringWhenConfigured() {
        String url = Gbase8sAgent.buildUrl(
            new ConnectParams(
                "ignored",
                0,
                "",
                "",
                "",
                "",
                "jdbc:gbasedbt-sqli://db.example.com:20013/app:GBASEDBTSERVER=gbase01",
                false
            )
        );

        Assertions.assertEquals("jdbc:gbasedbt-sqli://db.example.com:20013/app:GBASEDBTSERVER=gbase01", url);
    }

    @Test
    void constrainedListTablesUsesGbase8sSystemTableQuery() {
        List<String> sql = new ArrayList<>();
        Gbase8sAgent agent = new Gbase8sAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"tabname", "tabtype"},
            new Object[][]{
                {"user_order", "T"}
            }
        )));

        List<TableInfo> tables = agent.listTables(
            "app",
            new MetadataListConstraints("user", 1, 1, List.of("TABLE"))
        );

        Assertions.assertEquals(1, tables.size());
        Assertions.assertEquals("user_order", tables.get(0).getName());
        Assertions.assertTrue(sql.get(0).contains("FROM systables"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("SELECT SKIP 1 FIRST 1"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UPPER(t.tabname) LIKE ?"), sql.get(0));
    }

    @Test
    void listTablesLoadsGbase8sTableComments() {
        List<String> sql = new ArrayList<>();
        Gbase8sAgent agent = new Gbase8sAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"tabname", "tabtype", "comments"},
            new Object[][]{
                {"products", "T", "Product catalog"}
            }
        )));

        List<TableInfo> tables = agent.listTables("root");

        Assertions.assertEquals("Product catalog", tables.get(0).getComment());
        Assertions.assertTrue(sql.get(0).contains("LEFT JOIN syscomms"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("t.owner = ?"), sql.get(0));
    }

    @Test
    void extractsPrimaryKeyColumnNumbersFromGbase8sIndexParts() {
        Assertions.assertEquals(
            Set.of(1, 3, 5),
            Gbase8sAgent.primaryKeyColumnNumbers(Arrays.asList(1, -3, 0, 5, null))
        );
    }

    @Test
    void getColumnsUsesGbase8sSystemCatalog() {
        List<String> sql = new ArrayList<>();
        Gbase8sAgent agent = new Gbase8sAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(
            sql,
            resultSet(
                new String[]{"part1", "part2", "part3", "part4", "part5", "part6", "part7", "part8", "part9", "part10", "part11", "part12", "part13", "part14", "part15", "part16"},
                new Object[][]{
                    {1, 0, null, null, null, null, null, null, null, null, null, null, null, null, null, null}
                }
            ),
            resultSet(
                new String[]{"colname", "coltype", "colno", "collength", "comments"},
                new Object[][]{
                    {"product_id", 258, 1, 4, "Product identifier"},
                    {"sku", 13, 2, 40, null},
                    {"price", 5, 3, 3074, "Unit price"}
                }
            )
        ));

        List<ColumnInfo> columns = agent.getColumns("root", "products");

        Assertions.assertEquals(2, sql.size());
        Assertions.assertTrue(sql.get(0).contains("FROM sysconstraints"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("t.owner = ?"), sql.get(0));
        Assertions.assertTrue(sql.get(1).contains("FROM syscolumns"), sql.get(1));
        Assertions.assertTrue(sql.get(1).contains("t.owner = ?"), sql.get(1));
        Assertions.assertEquals(3, columns.size());
        Assertions.assertEquals("product_id", columns.get(0).getName());
        Assertions.assertEquals("INTEGER", columns.get(0).getData_type());
        Assertions.assertFalse(columns.get(0).getIs_nullable());
        Assertions.assertTrue(columns.get(0).getIs_primary_key());
        Assertions.assertEquals("VARCHAR", columns.get(1).getData_type());
        Assertions.assertEquals(40, columns.get(1).getCharacter_maximum_length());
        Assertions.assertEquals("DECIMAL", columns.get(2).getData_type());
        Assertions.assertEquals(12, columns.get(2).getNumeric_precision());
        Assertions.assertEquals(2, columns.get(2).getNumeric_scale());
        Assertions.assertEquals("Product identifier", columns.get(0).getComment());
        Assertions.assertEquals("Unit price", columns.get(2).getComment());
        Assertions.assertTrue(sql.get(1).contains("LEFT JOIN syscolcomms"), sql.get(1));
    }

    @Test
    void listIndexesLoadsGbase8sSystemCatalogIndexes() {
        List<String> sql = new ArrayList<>();
        Gbase8sAgent agent = new Gbase8sAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(
            sql,
            resultSet(
                new String[]{"colno", "colname"},
                new Object[][]{
                    {1, "product_id"},
                    {2, "sku"},
                    {3, "created_at"}
                }
            ),
            resultSet(
                new String[]{"idxname", "idxtype", "constrtype", "part1", "part2", "part3", "part4", "part5", "part6", "part7", "part8", "part9", "part10", "part11", "part12", "part13", "part14", "part15", "part16"},
                new Object[][]{
                    {"products_pk", "U", "P", 1, 0, null, null, null, null, null, null, null, null, null, null, null, null, null, null},
                    {"products_sku_created", "D", null, 2, -3, 0, null, null, null, null, null, null, null, null, null, null, null, null, null}
                }
            )
        ));

        List<IndexInfo> indexes = agent.listIndexes("root", "products");

        Assertions.assertEquals(2, indexes.size());
        Assertions.assertEquals(List.of("product_id"), indexes.get(0).getColumns());
        Assertions.assertTrue(indexes.get(0).getIs_unique());
        Assertions.assertTrue(indexes.get(0).getIs_primary());
        Assertions.assertEquals(List.of("sku", "created_at"), indexes.get(1).getColumns());
        Assertions.assertFalse(indexes.get(1).getIs_unique());
        Assertions.assertFalse(indexes.get(1).getIs_primary());
        Assertions.assertTrue(sql.get(0).contains("FROM syscolumns"), sql.get(0));
        Assertions.assertTrue(sql.get(1).contains("FROM sysindexes"), sql.get(1));
        Assertions.assertTrue(sql.get(1).contains("LEFT JOIN sysconstraints"), sql.get(1));
    }

    @Test
    void resolvesGbase8sIndexPartsInDeclaredOrder() {
        Assertions.assertEquals(
            List.of("sku", "created_at"),
            Gbase8sAgent.resolveIndexColumns(List.of(2, -3, 0), Map.of(2, "sku", 3, "created_at"))
        );
    }

    @Test
    void getObjectSourceUsesGbase8sViewCatalog() {
        List<String> sql = new ArrayList<>();
        Gbase8sAgent agent = new Gbase8sAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(
            sql,
            resultSet(
                new String[]{"viewtext"},
                new Object[][]{
                    {"create view \"gbasedbt\".demo_view as select "},
                    {"* from products;   "}
                }
            ),
            resultSet(
                new String[]{"tabid", "owner", "system_boundary_tabid"},
                new Object[][]{
                    {1000, "gbasedbt", 614}
                }
            )
        ));

        ObjectSource source = agent.getObjectSource("gbasedbt", "demo_view", "VIEW");

        Assertions.assertEquals("demo_view", source.getName());
        Assertions.assertEquals("VIEW", source.getObject_type());
        Assertions.assertEquals("gbasedbt", source.getSchema());
        Assertions.assertEquals("create view \"gbasedbt\".demo_view as select * from products;", source.getSource());
        Assertions.assertTrue(source.isEditable());
        Assertions.assertEquals(2, sql.size());
        Assertions.assertTrue(sql.get(0).contains("FROM sysviews"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("t.owner = ?"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("ORDER BY v.seqno"), sql.get(0));
        Assertions.assertTrue(sql.get(1).contains("system_boundary_tabid"), sql.get(1));
    }

    @Test
    void getObjectSourceMarksGbase8sSystemViewsReadOnly() {
        Gbase8sAgent agent = new Gbase8sAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(
            new ArrayList<>(),
            resultSet(
                new String[]{"viewtext"},
                new Object[][]{
                    {"create view \"gbasedbt\".dba_db_links as select * from user_db_links;"}
                }
            ),
            resultSet(
                new String[]{"tabid", "owner", "system_boundary_tabid"},
                new Object[][]{
                    {614, "gbasedbt", 614}
                }
            )
        ));

        ObjectSource source = agent.getObjectSource("gbasedbt", "dba_db_links", "VIEW");

        Assertions.assertFalse(source.isEditable());
    }

    @Test
    void getTableDdlReturnsViewSourceForGbase8sViews() {
        List<String> sql = new ArrayList<>();
        Gbase8sAgent agent = new Gbase8sAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(
            sql,
            resultSet(
                new String[]{"tabtype"},
                new Object[][]{
                    {"V"}
                }
            ),
            resultSet(
                new String[]{"viewtext"},
                new Object[][]{
                    {"create view demo_view as select 1 as id;   "}
                }
            )
        ));

        String ddl = agent.getTableDdl("gbasedbt", "demo_view");

        Assertions.assertEquals("create view demo_view as select 1 as id;", ddl);
        Assertions.assertEquals(2, sql.size());
        Assertions.assertTrue(sql.get(0).contains("SELECT tabtype FROM systables"), sql.get(0));
        Assertions.assertTrue(sql.get(1).contains("FROM sysviews"), sql.get(1));
    }

    private static Connection preparedConnection(List<String> sql, ResultSet... resultSets) {
        int[] resultIndex = {0};
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                int index = Math.min(resultIndex[0], resultSets.length - 1);
                resultIndex[0] += 1;
                return resultSets[index];
            }
            if ("setString".equals(method.getName()) || "close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("getCatalog".equals(method.getName())) {
                return "appdb";
            }
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet resultSet(String[] columns, Object[][] rows) {
        int[] index = {-1};
        Object[] lastValue = {null};
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next":
                    index[0] += 1;
                    return index[0] < rows.length;
                case "getString":
                    Object value = columnValue(columns, rows[index[0]], args[0]);
                    lastValue[0] = value;
                    return value == null ? null : String.valueOf(value);
                case "getInt":
                    Object intValue = columnValue(columns, rows[index[0]], args[0]);
                    lastValue[0] = intValue;
                    if (intValue == null) {
                        return 0;
                    }
                    if (intValue instanceof Number) {
                        return ((Number) intValue).intValue();
                    }
                    return Integer.parseInt(String.valueOf(intValue));
                case "wasNull":
                    return lastValue[0] == null;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Object columnValue(String[] columns, Object[] row, Object key) {
        if (key instanceof Number) {
            return row[((Number) key).intValue() - 1];
        }
        for (int i = 0; i < columns.length; i++) {
            if (columns[i].equalsIgnoreCase(String.valueOf(key))) {
                return row[i];
            }
        }
        return null;
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                return handler.handle(method, args == null ? new Object[0] : args);
            }
        };
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == Boolean.TYPE) return false;
        if (type == Byte.TYPE) return (byte) 0;
        if (type == Short.TYPE) return (short) 0;
        if (type == Integer.TYPE) return 0;
        if (type == Long.TYPE) return 0L;
        if (type == Float.TYPE) return 0f;
        if (type == Double.TYPE) return 0d;
        if (type == Character.TYPE) return (char) 0;
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
