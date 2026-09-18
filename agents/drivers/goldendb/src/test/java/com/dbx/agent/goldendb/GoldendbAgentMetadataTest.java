package com.dbx.agent.goldendb;

import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.test.TestSupport;
import com.dbx.agent.test.JdbcAgentFake;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class GoldendbAgentMetadataTest {
    @Test
    void returnsCharacterSetAndCollationForEditableColumns() {
        GoldendbAgent agent = new GoldendbAgent();
        TestSupport.setPrivateConnection(agent, columnsConnection());

        var columns = agent.getColumns("app", "orders");

        Assertions.assertEquals(1, columns.size());
        Assertions.assertEquals("utf8mb4", columns.get(0).getCharacter_set());
        Assertions.assertEquals("utf8mb4_bin", columns.get(0).getCollation());
    }

    @Test
    void quotesSchemaAndTableIdentifiersInIndexMetadataSql() {
        GoldendbAgent agent = new GoldendbAgent();
        Connection fake = JdbcMetadataSqlFake.connection();
        TestSupport.setPrivateConnection(agent, fake);

        agent.listIndexes("bad`schema", "bad`table");

        Assertions.assertEquals(
            List.of("SHOW INDEX FROM `bad``table` FROM `bad``schema`"),
            JdbcMetadataSqlFake.statements
        );
    }

    @Test
    void constrainedTableMetadataPushesFilterTypesAndPaging() {
        GoldendbAgent agent = new GoldendbAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("app", new MetadataListConstraints("ord", 25, 50, List.of("TABLE", "VIEW")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.contains("FROM information_schema.TABLES"), sql);
        Assertions.assertTrue(sql.contains("TABLE_TYPE IN (?, ?)"), sql);
        Assertions.assertTrue(sql.contains("UPPER(TABLE_NAME) LIKE ? ESCAPE '\\\\'"), sql);
        Assertions.assertTrue(sql.endsWith("LIMIT 25 OFFSET 50"), sql);
    }

    @Test
    void constrainedObjectMetadataPushesRoutineTypesAndPaging() {
        GoldendbAgent agent = new GoldendbAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listObjects("app", new MetadataListConstraints("sync", 10, null, List.of("PROCEDURE", "FUNCTION")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.contains("FROM information_schema.ROUTINES"), sql);
        Assertions.assertTrue(sql.contains("ROUTINE_TYPE IN (?, ?)"), sql);
        Assertions.assertTrue(sql.contains("ORDER BY CASE OBJECT_TYPE"), sql);
        Assertions.assertTrue(sql.endsWith("LIMIT 10"), sql);
    }

    private static Connection columnsConnection() {
        InvocationHandler connectionHandler = (proxy, method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                String sql = (String) args[0];
                boolean columnsQuery = sql.contains("CHARACTER_SET_NAME");
                return preparedStatement(columnsQuery ? columnResultSet() : emptyResultSet());
            }
            if ("getAutoCommit".equals(method.getName())) return true;
            if ("close".equals(method.getName())) return null;
            return defaultValue(method.getReturnType());
        };
        return proxy(Connection.class, connectionHandler);
    }

    private static PreparedStatement preparedStatement(ResultSet resultSet) {
        InvocationHandler handler = (proxy, method, args) -> {
            if ("executeQuery".equals(method.getName())) return resultSet;
            if ("setString".equals(method.getName()) || "close".equals(method.getName())) return null;
            return defaultValue(method.getReturnType());
        };
        return proxy(PreparedStatement.class, handler);
    }

    private static ResultSet emptyResultSet() {
        return resultSet(List.of());
    }

    private static ResultSet columnResultSet() {
        Map<String, Object> row = new HashMap<>();
        row.put("COLUMN_NAME", "name");
        row.put("COLUMN_TYPE", "varchar(64)");
        row.put("IS_NULLABLE", "YES");
        row.put("COLUMN_DEFAULT", "'guest'");
        row.put("EXTRA", "");
        row.put("COLUMN_COMMENT", "");
        row.put("NUMERIC_PRECISION", null);
        row.put("NUMERIC_SCALE", null);
        row.put("CHARACTER_MAXIMUM_LENGTH", 64);
        row.put("CHARACTER_SET_NAME", "utf8mb4");
        row.put("COLLATION_NAME", "utf8mb4_bin");
        return resultSet(List.of(row));
    }

    private static ResultSet resultSet(List<Map<String, Object>> rows) {
        int[] index = {-1};
        InvocationHandler handler = (proxy, method, args) -> {
            if ("next".equals(method.getName())) return ++index[0] < rows.size();
            if (("getString".equals(method.getName()) || "getObject".equals(method.getName())) && args != null && args.length == 1) {
                return rows.get(index[0]).get(args[0]);
            }
            if ("close".equals(method.getName())) return null;
            return defaultValue(method.getReturnType());
        };
        return proxy(ResultSet.class, handler);
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) return false;
        if (Integer.TYPE.equals(type)) return 0;
        if (Long.TYPE.equals(type)) return 0L;
        return null;
    }
}
