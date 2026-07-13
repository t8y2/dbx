package com.dbx.agent.kingbase;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

class KingbaseAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new KingbaseAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL sample_proc()";
    }

    @Test
    void declaresKingbasePostgresLikeProfile() {
        KingbaseAgent agent = new KingbaseAgent();

        Assertions.assertEquals("com.kingbase8.Driver", agent.getProfile().getDriverClass());
        Assertions.assertEquals("jdbc:kingbase8://{host}:{port}/{database}", agent.getProfile().getUrlTemplate());
    }

    @Test
    void schemaSwitchPlacesSysCatalogAfterSelectedSchema() {
        KingbaseAgent agent = new KingbaseAgent();

        Assertions.assertEquals("SET search_path TO \"app\", sys_catalog", agent.setSchemaSQL("app"));
        Assertions.assertEquals("SET search_path TO \"app\"\"prod\", sys_catalog", agent.setSchemaSQL("app\"prod"));
    }

    @Test
    void mysqlCompatListDatabasesUsesCurrentDatabase() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        agent.setMysqlCompatMode(true);
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"database_name"},
            new Object[][]{{"TEST"}}
        )));

        Assertions.assertEquals("TEST", agent.listDatabases().get(0).getName());
        Assertions.assertEquals("SELECT current_database() AS database_name", sql.get(0));
    }

    @Test
    void regularListDatabasesUsesKingbaseCatalog() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"database_name"},
            new Object[][]{{"app"}, {"analytics"}}
        )));

        List<DatabaseInfo> databases = agent.listDatabases();
        Assertions.assertEquals(2, databases.size());
        Assertions.assertEquals("app", databases.get(0).getName());
        Assertions.assertEquals("analytics", databases.get(1).getName());
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_database"), sql.get(0));
    }

    @Test
    void regularListDatabasesFallsBackToPostgresCatalog() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnectionWithFailure(sql, "sys_catalog.sys_database", resultSet(
            new String[]{"database_name"},
            new Object[][]{{"test"}}
        )));

        List<DatabaseInfo> databases = agent.listDatabases();

        Assertions.assertEquals(1, databases.size());
        Assertions.assertEquals("test", databases.get(0).getName());
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_database"), sql.get(0));
        Assertions.assertTrue(sql.get(1).contains("FROM pg_database"), sql.get(1));
    }

    @Test
    void regularListSchemasKeepsKingbaseSystemSchemas() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"schema_name"},
            new Object[][]{{"public"}, {"sys_catalog"}}
        )));

        Assertions.assertEquals(Arrays.asList("public", "sys_catalog"), agent.listSchemas());
        Assertions.assertTrue(sql.get(0).contains("FROM sys_namespace"), sql.get(0));
        Assertions.assertFalse(sql.get(0).contains("SYS%"), sql.get(0));
    }

    @Test
    void postgresCompatModeUsesPostgresCatalogForMetadata() throws Exception {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        Connection connection = postgresCatalogConnection(sql, resultSet(
            new String[]{"schema_name"},
            new Object[][]{{"public"}}
        ));

        Method afterConnect = KingbaseAgent.class.getDeclaredMethod("afterConnect", ConnectParams.class, Connection.class);
        afterConnect.setAccessible(true);
        afterConnect.invoke(agent, new ConnectParams(), connection);
        TestSupport.setPrivateConnection(agent, connection);

        Assertions.assertEquals(List.of("public"), agent.listSchemas());
        Assertions.assertEquals("SELECT 1 FROM sys_catalog.sys_namespace WHERE 1 = 0", sql.get(0));
        Assertions.assertEquals("SELECT 1 FROM pg_catalog.pg_namespace WHERE 1 = 0", sql.get(1));
        Assertions.assertTrue(sql.get(2).contains("FROM pg_catalog.pg_namespace"), sql.get(2));
        Assertions.assertEquals("SET search_path TO \"app\"", agent.setSchemaSQL("app"));
    }

    @Test
    void detectsMysqlCompatModeFromServerSqlMode() throws Exception {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        Connection connection = mysqlCompatConnection(sql);

        Method afterConnect = KingbaseAgent.class.getDeclaredMethod("afterConnect", ConnectParams.class, Connection.class);
        afterConnect.setAccessible(true);
        afterConnect.invoke(agent, new ConnectParams(), connection);

        Assertions.assertTrue(agent.isMysqlCompatMode());
        Assertions.assertEquals("`", agent.getIdentifierQuote());
        Assertions.assertEquals("SELECT 1 FROM sys_catalog.sys_namespace WHERE 1 = 0", sql.get(0));
        Assertions.assertEquals("SELECT 1 FROM sys_settings WHERE LOWER(name) = 'sql_mode'", sql.get(1));
    }

    @Test
    void mysqlCompatListTablesUsesInformationSchema() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        agent.setMysqlCompatMode(true);
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"table_name", "table_type"},
            new Object[][]{{"test_timestamps", "BASE TABLE"}}
        )));

        Assertions.assertEquals("test_timestamps", agent.listTables("PUBLIC").get(0).getName());
        Assertions.assertTrue(sql.get(0).contains("FROM information_schema.tables"));
        Assertions.assertFalse(sql.get(0).contains("SHOW"));
    }

    @Test
    void regularListTablesUsesKingbaseCatalogAndIncludesViews() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"table_name", "table_type", "table_comment"},
            new Object[][]{{"app_table", "TABLE", "table comment"}, {"app_view", "VIEW", "view comment"}}
        )));

        List<TableInfo> tables = agent.listTables("public");

        Assertions.assertEquals(2, tables.size());
        Assertions.assertEquals("app_table", tables.get(0).getName());
        Assertions.assertEquals("TABLE", tables.get(0).getTable_type());
        Assertions.assertEquals("app_view", tables.get(1).getName());
        Assertions.assertEquals("VIEW", tables.get(1).getTable_type());
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_class"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_rewrite"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_index"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_views"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_matviews"), sql.get(0));
        Assertions.assertFalse(sql.get(0).contains("relkind"), sql.get(0));
    }

    @Test
    void regularListObjectsIncludesKingbaseViewsProceduresAndFunctions() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql,
            resultSet(
                new String[]{"table_name", "table_type", "table_comment"},
                new Object[][]{{"app_table", "TABLE", null}, {"app_view", "VIEW", "view comment"}}
            ),
            resultSet(
                new String[]{"routine_name", "routine_type", "routine_comment"},
                new Object[][]{{"refresh_stats", "PROCEDURE", "proc comment"}, {"format_name", "FUNCTION", "fn comment"}}
            )
        ));

        List<ObjectInfo> objects = agent.listObjects("public");

        Assertions.assertEquals(4, objects.size());
        Assertions.assertEquals("app_table", objects.get(0).getName());
        Assertions.assertEquals("TABLE", objects.get(0).getObject_type());
        Assertions.assertEquals("app_view", objects.get(1).getName());
        Assertions.assertEquals("VIEW", objects.get(1).getObject_type());
        Assertions.assertEquals("refresh_stats", objects.get(2).getName());
        Assertions.assertEquals("PROCEDURE", objects.get(2).getObject_type());
        Assertions.assertEquals("format_name", objects.get(3).getName());
        Assertions.assertEquals("FUNCTION", objects.get(3).getObject_type());
        Assertions.assertTrue(sql.get(1).contains("FROM sys_catalog.sys_proc"), sql.get(1));
        Assertions.assertTrue(sql.get(1).contains("p.prorettype = 2278"), sql.get(1));
        Assertions.assertFalse(sql.get(1).contains("prokind"), sql.get(1));
    }

    @Test
    void constrainedRegularTableMetadataPushesFilterTypesAndPaging() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"table_name", "table_type", "table_comment"},
            new Object[][]{}
        )));

        agent.listTables("public", new MetadataListConstraints("ord", 30, 60, List.of("TABLE", "VIEW")));

        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_class"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_views"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UNION ALL"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UPPER(CAST(c.relname AS varchar(256))) LIKE ? ESCAPE '\\\\'"), sql.get(0));
        Assertions.assertFalse(sql.get(0).contains("relkind"), sql.get(0));
        Assertions.assertTrue(sql.get(0).endsWith("LIMIT 30 OFFSET 60"), sql.get(0));
    }

    @Test
    void constrainedRegularMaterializedViewMetadataUsesMatviewCatalog() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"table_name", "table_type", "table_comment"},
            new Object[][]{{"mv_sales", "MATERIALIZED_VIEW", "cached sales"}}
        )));

        List<TableInfo> tables = agent.listTables("public", new MetadataListConstraints("sales", 10, null, List.of("MATERIALIZED_VIEW")));

        Assertions.assertEquals(1, tables.size());
        Assertions.assertEquals("mv_sales", tables.get(0).getName());
        Assertions.assertEquals("MATERIALIZED_VIEW", tables.get(0).getTable_type());
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_matviews"), sql.get(0));
        Assertions.assertFalse(sql.get(0).contains("FROM sys_catalog.sys_views"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UPPER(CAST(mv.matviewname AS varchar(256))) LIKE ? ESCAPE '\\\\'"), sql.get(0));
        Assertions.assertFalse(sql.get(0).contains("relkind"), sql.get(0));
    }

    @Test
    void constrainedRegularObjectMetadataPushesRoutineTypesAndPaging() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"object_name", "object_type", "object_comment"},
            new Object[][]{}
        )));

        agent.listObjects("public", new MetadataListConstraints("sync", 10, null, List.of("PROCEDURE", "FUNCTION")));

        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_proc"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("p.prorettype = 2278"), sql.get(0));
        Assertions.assertFalse(sql.get(0).contains("prokind"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("ORDER BY CASE object_type"), sql.get(0));
        Assertions.assertTrue(sql.get(0).endsWith("LIMIT 10"), sql.get(0));
    }

    @Test
    void constrainedMysqlCompatTableMetadataPushesInformationSchemaPaging() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        agent.setMysqlCompatMode(true);
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"table_name", "table_type"},
            new Object[][]{}
        )));

        agent.listTables("PUBLIC", new MetadataListConstraints("ord", 20, 40, List.of("VIEW")));

        Assertions.assertTrue(sql.get(0).contains("FROM information_schema.tables"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("table_type IN (?)"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UPPER(table_name) LIKE ? ESCAPE '\\\\'"), sql.get(0));
        Assertions.assertTrue(sql.get(0).endsWith("LIMIT 20 OFFSET 40"), sql.get(0));
    }

    @Test
    void regularRoutineSourceUsesKingbaseFunctionDefinition() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"source"},
            new Object[][]{{"CREATE FUNCTION public.format_name() RETURNS text AS $$ SELECT 'x'; $$"}}
        )));

        ObjectSource source = agent.getObjectSource("public", "format_name", "FUNCTION");

        Assertions.assertTrue(source.getSource().startsWith("CREATE FUNCTION public.format_name()"), source.getSource());
        Assertions.assertTrue(sql.get(0).contains("SELECT sys_get_functiondef(p.oid) AS source"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("FROM sys_catalog.sys_proc"), sql.get(0));
        Assertions.assertFalse(sql.get(0).contains("prokind"), sql.get(0));
    }

    @Test
    void regularGetColumnsUsesFormattedCatalogTypes() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql,
            resultSet(
                new String[]{"column_name"},
                new Object[][]{{"id"}}
            ),
            resultSet(
                new String[]{
                    "column_name",
                    "data_type",
                    "is_nullable",
                    "column_default",
                    "column_comment",
                    "numeric_precision",
                    "numeric_scale",
                    "character_maximum_length"
                },
                new Object[][]{
                    {"id", "integer", false, "nextval('orders_id_seq'::regclass)", "identifier", 32, 0, null},
                    {"create_time", "timestamp with time zone", true, null, null, null, null, null},
                    {"name", "character varying(64)", true, null, "display name", null, null, 64}
                }
            )
        ));

        List<ColumnInfo> columns = agent.getColumns("public", "orders");

        Assertions.assertEquals(3, columns.size());
        Assertions.assertEquals("integer", columns.get(0).getData_type());
        Assertions.assertTrue(columns.get(0).getIs_primary_key());
        Assertions.assertFalse(columns.get(0).getIs_nullable());
        Assertions.assertEquals("timestamp with time zone", columns.get(1).getData_type());
        Assertions.assertNotEquals("USER-DEFINED", columns.get(1).getData_type());
        Assertions.assertEquals(Integer.valueOf(64), columns.get(2).getCharacter_maximum_length());
        Assertions.assertTrue(sql.get(1).contains("format_type(a.atttypid, a.atttypmod) AS data_type"), sql.get(1));
        Assertions.assertTrue(sql.get(1).contains("FROM sys_catalog.sys_attribute"), sql.get(1));
        Assertions.assertFalse(sql.get(1).contains("information_schema.columns"), sql.get(1));
    }

    @Test
    void mysqlCompatGetColumnsKeepsInformationSchemaPath() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        agent.setMysqlCompatMode(true);
        TestSupport.setPrivateConnection(agent, preparedConnection(sql,
            resultSet(
                new String[]{"column_name"},
                new Object[][]{{"id"}}
            ),
            resultSet(
                new String[]{
                    "column_name",
                    "data_type",
                    "is_nullable",
                    "column_default",
                    "numeric_precision",
                    "numeric_scale",
                    "character_maximum_length"
                },
                new Object[][]{{"id", "int", "NO", null, 32, 0, null}}
            )
        ));

        List<ColumnInfo> columns = agent.getColumns("PUBLIC", "orders");

        Assertions.assertEquals("int", columns.get(0).getData_type());
        Assertions.assertTrue(sql.get(1).contains("FROM information_schema.columns"), sql.get(1));
    }

    @Test
    void regularListIndexesIncludesPrimaryUniqueAndSecondaryIndexes() {
        List<String> sql = new ArrayList<>();
        KingbaseAgent agent = new KingbaseAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"index_name", "index_type", "is_unique", "is_primary", "column_name", "ordinal_position"},
            new Object[][]{
                {"orders_pkey", "btree", true, true, "id", 1},
                {"idx_orders_created", "btree", false, false, "created", 1},
                {"idx_orders_name_created", "btree", false, false, "name", 1},
                {"idx_orders_name_created", "btree", false, false, "created", 2}
            }
        )));

        List<IndexInfo> indexes = agent.listIndexes("public", "orders");

        Assertions.assertEquals(3, indexes.size());
        Assertions.assertEquals("orders_pkey", indexes.get(0).getName());
        Assertions.assertEquals(Arrays.asList("id"), indexes.get(0).getColumns());
        Assertions.assertTrue(indexes.get(0).getIs_unique());
        Assertions.assertTrue(indexes.get(0).getIs_primary());
        Assertions.assertEquals("idx_orders_created", indexes.get(1).getName());
        Assertions.assertEquals(Arrays.asList("created"), indexes.get(1).getColumns());
        Assertions.assertFalse(indexes.get(1).getIs_unique());
        Assertions.assertFalse(indexes.get(1).getIs_primary());
        Assertions.assertEquals(Arrays.asList("name", "created"), indexes.get(2).getColumns());
        Assertions.assertTrue(sql.get(0).contains("FROM SYS_CATALOG.SYS_INDEX"), sql.get(0));
        Assertions.assertFalse(sql.get(0).contains("information_schema.table_constraints"), sql.get(0));
    }

    @Test
    void mysqlCompatTimestampTypeNameIsReadAsTimestampText() throws Exception {
        Timestamp timestamp = Timestamp.valueOf("2026-06-22 11:29:00");
        KingbaseAgent agent = new KingbaseAgent();
        agent.setMysqlCompatMode(true);

        Object value = readResultValue(agent, timestampResultSet(timestamp), Types.BINARY, "timestamp");

        Assertions.assertEquals("2026-06-22 11:29:00.0", value);
    }

    private static Connection preparedConnection(List<String> sql, ResultSet rs) {
        return preparedConnection(sql, new ResultSet[]{rs});
    }

    private static Connection preparedConnection(List<String> sql, ResultSet... resultSets) {
        int[] resultSetIndex = {0};
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                int current = Math.min(resultSetIndex[0], resultSets.length - 1);
                resultSetIndex[0] += 1;
                return resultSets[current];
            }
            if ("setString".equals(method.getName())) {
                return null;
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        Statement plainStatement = proxy(Statement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                int current = Math.min(resultSetIndex[0], resultSets.length - 1);
                resultSetIndex[0] += 1;
                return resultSets[current];
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return statement;
            }
            if ("createStatement".equals(method.getName())) {
                return plainStatement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection preparedConnectionWithFailure(List<String> sql, String failingSqlFragment, ResultSet fallback) {
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                String preparedSql = String.valueOf(args[0]);
                sql.add(preparedSql);
                return proxy(PreparedStatement.class, (statementMethod, statementArgs) -> {
                    if ("executeQuery".equals(statementMethod.getName())) {
                        if (preparedSql.contains(failingSqlFragment)) {
                            throw new SQLException("relation does not exist: " + failingSqlFragment);
                        }
                        return fallback;
                    }
                    if ("close".equals(statementMethod.getName())) {
                        return null;
                    }
                    return defaultValue(statementMethod.getReturnType());
                });
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection postgresCatalogConnection(List<String> sql, ResultSet metadataResult) {
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return proxy(Statement.class, (statementMethod, statementArgs) -> {
                    if ("executeQuery".equals(statementMethod.getName())) {
                        String query = String.valueOf(statementArgs[0]);
                        sql.add(query);
                        if (query.contains("sys_catalog.sys_namespace")) {
                            throw new SQLException("relation does not exist: sys_catalog.sys_namespace");
                        }
                        return resultSet(new String[]{"probe"}, new Object[][]{});
                    }
                    return defaultValue(statementMethod.getReturnType());
                });
            }
            if ("prepareStatement".equals(method.getName())) {
                String query = String.valueOf(args[0]);
                sql.add(query);
                return proxy(PreparedStatement.class, (statementMethod, statementArgs) -> {
                    if ("executeQuery".equals(statementMethod.getName())) return metadataResult;
                    return defaultValue(statementMethod.getReturnType());
                });
            }
            if ("isClosed".equals(method.getName())) return false;
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection mysqlCompatConnection(List<String> sql) {
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return proxy(Statement.class, (statementMethod, statementArgs) -> {
                    if ("executeQuery".equals(statementMethod.getName())) {
                        String query = String.valueOf(statementArgs[0]);
                        sql.add(query);
                        if (query.contains("sys_settings")) {
                            return resultSet(new String[]{"probe"}, new Object[][]{{1}});
                        }
                        return resultSet(new String[]{"probe"}, new Object[][]{});
                    }
                    return defaultValue(statementMethod.getReturnType());
                });
            }
            if ("isClosed".equals(method.getName())) return false;
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet resultSet(String[] columns, Object[][] rows) {
        int[] index = {-1};
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next":
                    index[0] += 1;
                    return index[0] < rows.length;
                case "getString":
                    Object key = args[0];
                    if (key instanceof Number) {
                        return rows[index[0]][((Number) key).intValue() - 1];
                    }
                    for (int i = 0; i < columns.length; i++) {
                        if (columns[i].equalsIgnoreCase(String.valueOf(key))) {
                            return rows[index[0]][i];
                        }
                    }
                    return null;
                case "getBoolean":
                    Object booleanValue = columnValue(columns, rows[index[0]], args[0]);
                    if (booleanValue instanceof Boolean) return booleanValue;
                    if (booleanValue instanceof Number) return ((Number) booleanValue).intValue() != 0;
                    return Boolean.parseBoolean(String.valueOf(booleanValue));
                case "getObject":
                    return columnValue(columns, rows[index[0]], args[0]);
                case "wasNull":
                    return false;
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

    private static ResultSet timestampResultSet(Timestamp timestamp) {
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "getTimestamp":
                    return timestamp;
                case "getBytes":
                    throw new AssertionError("timestamp should not be read as bytes");
                case "wasNull":
                    return false;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = (Object unused, Method method, Object[] args) -> handler.handle(method, args);
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) return false;
        if (Byte.TYPE.equals(type)) return (byte) 0;
        if (Short.TYPE.equals(type)) return (short) 0;
        if (Integer.TYPE.equals(type)) return 0;
        if (Long.TYPE.equals(type)) return 0L;
        if (Float.TYPE.equals(type)) return 0f;
        if (Double.TYPE.equals(type)) return 0.0d;
        if (Character.TYPE.equals(type)) return '\0';
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }

    private static Object readResultValue(KingbaseAgent agent, ResultSet rs, int sqlType, String columnTypeName) throws Exception {
        Method method = KingbaseAgent.class.getDeclaredMethod("resultValue", ResultSet.class, int.class, int.class, String.class);
        method.setAccessible(true);
        return method.invoke(agent, rs, 1, sqlType, columnTypeName);
    }
}
