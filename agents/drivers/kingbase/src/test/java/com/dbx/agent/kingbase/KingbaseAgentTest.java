package com.dbx.agent.kingbase;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.DatabaseInfo;
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
        Assertions.assertTrue(sql.get(0).contains("FROM sys_database"), sql.get(0));
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
    void mysqlCompatTimestampTypeNameIsReadAsTimestampText() throws Exception {
        Timestamp timestamp = Timestamp.valueOf("2026-06-22 11:29:00");
        KingbaseAgent agent = new KingbaseAgent();
        agent.setMysqlCompatMode(true);

        Object value = readResultValue(agent, timestampResultSet(timestamp), Types.BINARY, "timestamp");

        Assertions.assertEquals("2026-06-22 11:29:00.0", value);
    }

    private static Connection preparedConnection(List<String> sql, ResultSet rs) {
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                return rs;
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        Statement plainStatement = proxy(Statement.class, (method, args) -> {
            if ("executeQuery".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return rs;
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
                case "wasNull":
                    return false;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
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
