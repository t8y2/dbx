package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.QueryPageOptions;
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
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

class OceanBaseOracleAgentTest {
    @Test
    void buildsOceanBaseJdbcUrl() {
        ConnectParams params = new ConnectParams();
        params.setHost("oceanbase.example.com");
        params.setPort(0);
        params.setDatabase("sys");

        Assertions.assertEquals(
            "jdbc:oceanbase://oceanbase.example.com:2883/sys?compatibleOjdbcVersion=8",
            OceanBaseOracleAgent.buildUrl(params)
        );
    }

    @Test
    void appendsQueryParametersToJdbcUrl() {
        ConnectParams params = new ConnectParams();
        params.setHost("oceanbase.example.com");
        params.setPort(2881);
        params.setDatabase("sys");
        params.setUrl_params("useSSL=false");

        Assertions.assertEquals(
            "jdbc:oceanbase://oceanbase.example.com:2881/sys?useSSL=false&compatibleOjdbcVersion=8",
            OceanBaseOracleAgent.buildUrl(params)
        );
    }

    @Test
    void keepsExplicitCompatibleOjdbcVersion() {
        ConnectParams params = new ConnectParams();
        params.setHost("oceanbase.example.com");
        params.setPort(2881);
        params.setDatabase("sys");
        params.setUrl_params("compatibleOjdbcVersion=6&useSSL=false");

        Assertions.assertEquals(
            "jdbc:oceanbase://oceanbase.example.com:2881/sys?compatibleOjdbcVersion=6&useSSL=false",
            OceanBaseOracleAgent.buildUrl(params)
        );
    }

    @Test
    void appendsCompatibleOjdbcVersionToCustomJdbcUrl() {
        ConnectParams params = new ConnectParams();
        params.setConnection_string("jdbc:oceanbase://custom-host:2881/sys?useSSL=false");

        Assertions.assertEquals(
            "jdbc:oceanbase://custom-host:2881/sys?useSSL=false&compatibleOjdbcVersion=8",
            OceanBaseOracleAgent.buildUrl(params)
        );
    }

    @Test
    void convertsQueryTimeoutToOceanBaseSessionMicroseconds() {
        Assertions.assertEquals(
            "ALTER SESSION SET ob_query_timeout = 300000000",
            OceanBaseOracleAgent.queryTimeoutSql(300)
        );
        Assertions.assertEquals(
            "ALTER SESSION SET ob_query_timeout = 0",
            OceanBaseOracleAgent.queryTimeoutSql(0)
        );
        Assertions.assertEquals(
            "ALTER SESSION SET ob_query_timeout = 2147483647000000",
            OceanBaseOracleAgent.queryTimeoutSql(Integer.MAX_VALUE)
        );
    }

    @Test
    void rejectsNegativeQueryTimeout() {
        Assertions.assertThrows(IllegalArgumentException.class, () -> OceanBaseOracleAgent.queryTimeoutSql(-1));
    }

    @Test
    void synchronizesSessionTimeoutForEveryQueryEntryPoint() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, executionConnection(sql));

        agent.executeQuery("SELECT 1 FROM DUAL", null, new ExecuteQueryOptions(10, null, 12));
        agent.executeQueryPage("SELECT 2 FROM DUAL", null, new QueryPageOptions(10, null, 10, 13));
        agent.startTableRead("SELECT 3 FROM DUAL", null, new QueryPageOptions(10, null, 10, 14));

        Assertions.assertEquals(List.of(
            "ALTER SESSION SET ob_query_timeout = 12000000",
            "SELECT 1 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 13000000",
            "SELECT 2 FROM DUAL",
            "ALTER SESSION SET ob_query_timeout = 14000000",
            "SELECT 3 FROM DUAL"
        ), sql);
    }

    @Test
    void constrainedListTablesUsesOceanBaseOracleMetadataSql() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"OBJECT_NAME", "TABLE_TYPE", "COMMENTS"},
            new Object[][]{
                {"USER_SETTINGS", "TABLE", null}
            }
        )));

        List<TableInfo> tables = agent.listTables(
            "APP",
            new MetadataListConstraints("user", 1, 1, List.of("TABLE"))
        );

        Assertions.assertEquals(1, tables.size());
        Assertions.assertEquals("USER_SETTINGS", tables.get(0).getName());
        Assertions.assertTrue(sql.get(0).contains("ALL_OBJECTS"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("UPPER(o.OBJECT_NAME) LIKE ?"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("ROWNUM <= ?"), sql.get(0));
    }

    @Test
    void constrainedListObjectsUsesOceanBaseOracleMetadataSql() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, resultSet(
            new String[]{"OBJECT_NAME", "OBJECT_TYPE"},
            new Object[][]{
                {"FORMAT_USER", "FUNCTION"}
            }
        )));

        List<ObjectInfo> objects = agent.listObjects(
            "APP",
            new MetadataListConstraints("user", 1, 1, List.of("FUNCTION"))
        );

        Assertions.assertEquals(1, objects.size());
        Assertions.assertEquals("FORMAT_USER", objects.get(0).getName());
        Assertions.assertEquals("FUNCTION", objects.get(0).getObject_type());
        Assertions.assertTrue(sql.get(0).contains("OBJECT_TYPE IN (?)"), sql.get(0));
        Assertions.assertTrue(sql.get(0).contains("ROWNUM <= ?"), sql.get(0));
    }

    @Test
    void readsViewDdlWithDbmsMetadataForSchemaCompare() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, objectSourceConnection(
            sql,
            params,
            resultSet(
                new String[]{"DDL"},
                new Object[][]{{"CREATE OR REPLACE VIEW \"APP\".\"ACTIVE_USERS\" AS SELECT ID FROM USERS"}}
            )
        ));

        ObjectSource source = agent.getObjectSource("app", "ACTIVE_USERS", "VIEW");

        Assertions.assertEquals("VIEW", source.getObject_type());
        Assertions.assertEquals("app", source.getSchema());
        Assertions.assertTrue(source.getSource().startsWith("CREATE OR REPLACE VIEW"), source.getSource());
        Assertions.assertEquals(List.of("VIEW", "ACTIVE_USERS", "app"), params);
        Assertions.assertTrue(sql.get(0).contains("DBMS_METADATA.GET_DDL"), sql.get(0));
    }

    @Test
    void fallsBackToAllViewsWhenDbmsMetadataIsUnavailable() {
        List<String> sql = new ArrayList<>();
        List<String> params = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, objectSourceFallbackConnection(
            sql,
            params,
            resultSet(new String[]{"TEXT"}, new Object[][]{{"SELECT ID FROM USERS"}})
        ));

        ObjectSource source = agent.getObjectSource("APP", "ACTIVE_USERS", "VIEW");

        Assertions.assertEquals("SELECT ID FROM USERS", source.getSource());
        Assertions.assertEquals(List.of("VIEW", "ACTIVE_USERS", "APP", "APP", "ACTIVE_USERS"), params);
        Assertions.assertTrue(sql.get(1).contains("ALL_VIEWS"), sql.get(1));
    }

    @Test
    void fallsBackToAllSourceForOracleRoutineAndPackageTypes() {
        for (String[] object : new String[][]{
            {"PROCEDURE", "PROCEDURE"},
            {"FUNCTION", "FUNCTION"},
            {"PACKAGE", "PACKAGE"},
            {"PACKAGE_BODY", "PACKAGE BODY"}
        }) {
            List<String> sql = new ArrayList<>();
            List<String> params = new ArrayList<>();
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            TestSupport.setPrivateConnection(agent, objectSourceFallbackConnection(
                sql,
                params,
                resultSet(
                    new String[]{"TEXT"},
                    new Object[][]{{object[1] + " ACCOUNT_API AS\n"}, {"END ACCOUNT_API;\n"}}
                )
            ));

            ObjectSource source = agent.getObjectSource("APP", "ACCOUNT_API", object[0]);

            Assertions.assertEquals(object[0], source.getObject_type());
            Assertions.assertTrue(source.getSource().startsWith("CREATE OR REPLACE " + object[1]), source.getSource());
            Assertions.assertEquals(object[1], params.get(params.size() - 1));
            Assertions.assertTrue(sql.get(1).contains("ALL_SOURCE"), sql.get(1));
            Assertions.assertTrue(sql.get(1).contains("ORDER BY LINE"), sql.get(1));
        }
    }

    @Test
    void rejectsUnsupportedObjectSourceTypesBeforeQuerying() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();

        IllegalArgumentException error = Assertions.assertThrows(
            IllegalArgumentException.class,
            () -> agent.getObjectSource("APP", "USERS", "TABLE")
        );

        Assertions.assertTrue(error.getMessage().contains("Unsupported object type: TABLE"), error.getMessage());
    }

    @Test
    void getColumnsIncludesDefaultAndCommentMetadata() {
        List<String> sql = new ArrayList<>();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(sql, columnResultSet(
            new Object[][]{
                {"DISPLAY_NAME", "VARCHAR2", "Y", null, null, 64, 64, "'anonymous'", "User's display name", 0}
            }
        )));

        List<ColumnInfo> columns = agent.getColumns("APP", "USERS");

        Assertions.assertEquals(1, columns.size());
        ColumnInfo column = columns.get(0);
        Assertions.assertEquals("DISPLAY_NAME", column.getName());
        Assertions.assertEquals("VARCHAR2(64)", column.getData_type());
        Assertions.assertTrue(column.getIs_nullable());
        Assertions.assertEquals("'anonymous'", column.getColumn_default());
        Assertions.assertFalse(column.getIs_primary_key());
        Assertions.assertEquals("User's display name", column.getComment());
        Assertions.assertEquals(64, column.getCharacter_maximum_length());
        Assertions.assertTrue(sql.get(0).contains("c.DATA_DEFAULT"), sql.get(0));
    }

    @Test
    void tableDdlIncludesDefaultsAndOnlyNonBlankColumnComments() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        TestSupport.setPrivateConnection(agent, preparedConnection(new ArrayList<>(),
            resultSet(
                new String[]{"INDEX_NAME", "COLUMN_NAME", "COLUMN_POSITION", "UNIQUENESS", "CONSTRAINT_TYPE", "INDEX_TYPE"},
                new Object[][]{}
            ),
            resultSet(
                new String[]{"CONSTRAINT_NAME", "COLUMN_NAME", "TABLE_NAME", "REF_COLUMN_NAME"},
                new Object[][]{}
            ),
            resultSet(
                new String[]{"COMMENTS"},
                new Object[][]{{null}}
            ),
            columnResultSet(new Object[][]{
                {"CREATED_AT", "TIMESTAMP", "N", null, null, null, null, "SYSDATE", "Created timestamp", 0},
                {"INTERNAL_NOTE", "VARCHAR2", "Y", null, null, 100, 100, null, "   ", 0}
            })
        ));

        String ddl = agent.getTableDdl("APP", "AUDIT_LOG");

        Assertions.assertTrue(ddl.contains("\"CREATED_AT\" TIMESTAMP NOT NULL DEFAULT SYSDATE"), ddl);
        Assertions.assertTrue(
            ddl.contains("COMMENT ON COLUMN \"APP\".\"AUDIT_LOG\".\"CREATED_AT\" IS 'Created timestamp';"),
            ddl
        );
        Assertions.assertTrue(ddl.contains("\"INTERNAL_NOTE\" VARCHAR2(100)"), ddl);
        Assertions.assertFalse(ddl.contains("\"INTERNAL_NOTE\" IS"), ddl);
    }

    private static ResultSet columnResultSet(Object[][] rows) {
        return resultSet(
            new String[]{
                "COLUMN_NAME",
                "DATA_TYPE",
                "NULLABLE",
                "DATA_PRECISION",
                "DATA_SCALE",
                "DATA_LENGTH",
                "CHAR_LENGTH",
                "DATA_DEFAULT",
                "COMMENTS",
                "IS_PK"
            },
            rows
        );
    }

    private static Connection preparedConnection(List<String> sql, ResultSet... resultSets) {
        int[] resultSetIndex = {0};
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                int current = Math.min(resultSetIndex[0], resultSets.length - 1);
                resultSetIndex[0] += 1;
                return resultSets[current];
            }
            if ("setString".equals(method.getName()) || "setInt".equals(method.getName()) || "close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
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

    private static Connection objectSourceConnection(List<String> sql, List<String> params, ResultSet resultSet) {
        PreparedStatement statement = objectSourceStatement(params, resultSet, false);
        return proxy(Connection.class, (method, args) -> {
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

    private static Connection objectSourceFallbackConnection(List<String> sql, List<String> params, ResultSet fallbackResultSet) {
        int[] statementIndex = {0};
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                boolean fail = statementIndex[0]++ == 0;
                return objectSourceStatement(params, fallbackResultSet, fail);
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static PreparedStatement objectSourceStatement(List<String> params, ResultSet resultSet, boolean fail) {
        return proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                if (fail) {
                    throw new SQLException("DBMS_METADATA is unavailable");
                }
                return resultSet;
            }
            if ("setString".equals(method.getName())) {
                params.add(String.valueOf(args[1]));
                return null;
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection executionConnection(List<String> sql) {
        Statement statement = proxy(Statement.class, (method, args) -> {
            if ("execute".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return false;
            }
            if ("getUpdateCount".equals(method.getName())) {
                return 0;
            }
            if ("close".equals(method.getName()) || "setMaxRows".equals(method.getName())
                || "setFetchSize".equals(method.getName()) || "setQueryTimeout".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
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
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next":
                    index[0] += 1;
                    return index[0] < rows.length;
                case "getString":
                    Object value = columnValue(columns, rows[index[0]], args[0]);
                    return value == null ? null : String.valueOf(value);
                case "getObject":
                    return columnValue(columns, rows[index[0]], args[0]);
                case "getInt":
                    Object intValue = columnValue(columns, rows[index[0]], args[0]);
                    if (intValue instanceof Number) {
                        return ((Number) intValue).intValue();
                    }
                    if (intValue == null) {
                        return 0;
                    }
                    return Integer.parseInt(String.valueOf(intValue));
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
