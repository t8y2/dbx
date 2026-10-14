package com.dbx.agent.goldendb;

import com.dbx.agent.JsonRpcServer;
import com.dbx.agent.test.TestSupport;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GoldendbAgentDdlTest {
    private static final String NATIVE_DDL = """
        CREATE TABLE `orders` (
          `id` bigint NOT NULL AUTO_INCREMENT COMMENT '编号',
          `name` varchar(64) COLLATE utf8mb4_bin COMMENT '客户的\\'姓名\\'\n第二行',
          `note` text COMMENT '',
          PRIMARY KEY (`id`),
          UNIQUE KEY `name_idx` (`name`)
        ) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COMMENT='订单表\\'备注\\'\n下一行'
        DISTRIBUTED BY DUPLICATE(`id`)
        """;

    @Test
    void preservesNativeDdlVerbatim() {
        NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);

        assertEquals(NATIVE_DDL, jdbc.agent().getTableDdl("app", "orders"));

        assertEquals(List.of("SHOW CREATE TABLE `app`.`orders`"), jdbc.queries);
        jdbc.assertClosedResources(1, 1);
    }

    @Test
    void distinguishesIdenticalTableNamesAcrossSchemas() {
        NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);
        GoldendbAgent agent = jdbc.agent();
        assertEquals(NATIVE_DDL, agent.getTableDdl("tenant_one", "orders"));
        jdbc.ddl = "CREATE TABLE `orders` (`other_id` int) COMMENT='另一个库'";

        assertEquals(jdbc.ddl, agent.getTableDdl("tenant_two", "orders"));

        assertEquals(List.of(
            "SHOW CREATE TABLE `tenant_one`.`orders`",
            "SHOW CREATE TABLE `tenant_two`.`orders`"
        ), jdbc.queries);
        assertEquals("connected_db", jdbc.catalog);
        jdbc.assertClosedResources(2, 2);
    }

    @Test
    void escapesSchemaAndTableIdentifiersIndependently() {
        NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);

        assertEquals(NATIVE_DDL, jdbc.agent().getTableDdl("tenant`db", "order`items.with.dot"));

        assertEquals(List.of("SHOW CREATE TABLE `tenant``db`.`order``items.with.dot`"), jdbc.queries);
        jdbc.assertClosedResources(1, 1);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" ", "\t"})
    void usesCurrentCatalogWhenSchemaIsMissing(String schema) {
        NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);

        assertEquals(NATIVE_DDL, jdbc.agent().getTableDdl(schema, "orders"));

        assertEquals(List.of("SHOW CREATE TABLE `orders`"), jdbc.queries);
        assertEquals("connected_db", jdbc.catalog);
        jdbc.assertClosedResources(1, 1);
    }

    @Test
    void preservesExplicitSchemaWhitespaceAndDefaultName() {
        NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);
        GoldendbAgent agent = jdbc.agent();

        agent.getTableDdl(" app ", "orders");
        agent.getTableDdl("default", "orders");

        assertEquals(List.of("SHOW CREATE TABLE ` app `.`orders`", "SHOW CREATE TABLE `default`.`orders`"), jdbc.queries);
        jdbc.assertClosedResources(2, 2);
    }

    @ParameterizedTest
    @ValueSource(strings = {"Create Table", "CREATE TABLE", "Create View", "DDL"})
    void readsSecondResultColumnRegardlessOfLabel(String label) {
        NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);
        jdbc.labels = List.of("Table", label);

        assertEquals(NATIVE_DDL, jdbc.agent().getTableDdl("app", "orders"));

        jdbc.assertClosedResources(1, 1);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" ", "\n\t"})
    void rejectsMissingDdlWithoutFabricatingMetadataDdl(String ddl) {
        NativeJdbc jdbc = new NativeJdbc(ddl);

        IllegalStateException error = assertThrows(IllegalStateException.class, () -> jdbc.agent().getTableDdl("app", "orders"));

        assertEquals("DDL not found for `app`.`orders`", error.getMessage());
        assertEquals(List.of("SHOW CREATE TABLE `app`.`orders`"), jdbc.queries);
        jdbc.assertClosedResources(1, 1);
    }

    @Test
    void rejectsNoResultWithoutFabricatingMetadataDdl() {
        NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);
        jdbc.hasRow = false;

        IllegalStateException error = assertThrows(IllegalStateException.class, () -> jdbc.agent().getTableDdl("app", "orders"));

        assertEquals("DDL not found for `app`.`orders`", error.getMessage());
        jdbc.assertClosedResources(1, 1);
    }

    @Test
    void propagatesSqlErrorsAndCancellationWithoutFallback() {
        for (SQLException failure : List.of(
            new SQLException("SHOW command denied", "42000", 1142),
            new SQLException("Table does not exist", "42S02", 1146),
            new SQLException("Query execution was interrupted", "70100", 1317),
            new SQLTimeoutException("Query timed out", "HYT00")
        )) {
            NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);
            jdbc.queryFailure = failure;

            RuntimeException error = assertThrows(RuntimeException.class, () -> jdbc.agent().getTableDdl("app", "orders"));

            assertSame(failure, error.getCause());
            assertEquals(List.of("SHOW CREATE TABLE `app`.`orders`"), jdbc.queries);
            jdbc.assertClosedResources(1, 0);
        }
    }

    @Test
    void closesResultsAfterReadFailureAndPreservesTheCause() {
        NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);
        jdbc.readFailure = new SQLException("Cannot read DDL", "HY000");

        RuntimeException error = assertThrows(RuntimeException.class, () -> jdbc.agent().getTableDdl("app", "orders"));

        assertSame(jdbc.readFailure, error.getCause());
        jdbc.assertClosedResources(1, 1);
    }

    @Test
    void requiresAnActiveConnection() {
        IllegalStateException error = assertThrows(IllegalStateException.class, () -> new GoldendbAgent().getTableDdl("app", "orders"));

        assertEquals("Not connected", error.getMessage());
    }

    @Test
    void tableDdlRpcUsesSelectedCatalogAndReturnsNativeSource() throws ReflectiveOperationException {
        NativeJdbc jdbc = new NativeJdbc("CREATE TABLE `orders` (`id` int) COMMENT='订单'");
        JsonRpcServer server = new JsonRpcServer(jdbc.agent());

        String response = request(server, """
            {"jsonrpc":"2.0","id":1,"method":"get_table_ddl","params":{"database":"selected_db","schema":"","table":"orders"}}
            """);

        assertTrue(response.contains("\"result\":\"CREATE TABLE `orders`"), response);
        assertFalse(response.contains("\"error\""), response);
        assertEquals("selected_db", jdbc.catalog);
        assertEquals(List.of("SHOW CREATE TABLE `orders`"), jdbc.queries);
        jdbc.assertClosedResources(1, 1);
    }

    @Test
    void tableDdlRpcReportsNativeSqlFailure() throws ReflectiveOperationException {
        NativeJdbc jdbc = new NativeJdbc(NATIVE_DDL);
        jdbc.queryFailure = new SQLException("SHOW command denied", "42000", 1142);

        String response = request(new JsonRpcServer(jdbc.agent()), """
            {"jsonrpc":"2.0","id":1,"method":"get_table_ddl","params":{"database":"app","schema":"app","table":"orders"}}
            """);

        assertTrue(response.contains("\"error\""), response);
        assertTrue(response.contains("SHOW command denied"), response);
        assertFalse(response.contains("\"result\""), response);
        jdbc.assertClosedResources(1, 0);
    }

    @ParameterizedTest
    @ValueSource(strings = {"VIEW", "PROCEDURE", "FUNCTION"})
    void preservesExistingObjectSourceRoutes(String objectType) throws ReflectiveOperationException {
        NativeJdbc jdbc = new NativeJdbc("CREATE " + objectType + " native_source");
        if (!"VIEW".equals(objectType)) {
            jdbc.labels = List.of(objectType, "sql_mode", "Create " + objectType);
        }

        String response = request(new JsonRpcServer(jdbc.agent()), """
            {"jsonrpc":"2.0","id":1,"method":"get_object_source","params":{"database":"app","schema":"app","name":"order`source","object_type":"%s"}}
            """.formatted(objectType));

        assertTrue(response.contains("\"source\":\"" + jdbc.ddl + "\""), response);
        assertFalse(response.contains("\"error\""), response);
        assertEquals(List.of("SHOW CREATE " + objectType + " `order``source`"), jdbc.queries);
        jdbc.assertClosedResources(1, 1);
    }

    private static String request(JsonRpcServer server, String request) throws ReflectiveOperationException {
        Method handler = JsonRpcServer.class.getDeclaredMethod("handleRequest", String.class);
        handler.setAccessible(true);
        return (String) handler.invoke(server, request);
    }

    private static final class NativeJdbc {
        private final List<String> queries = new ArrayList<>();
        private List<String> labels = List.of("Table", "Create Table");
        private String ddl;
        private String catalog = "connected_db";
        private boolean hasRow = true;
        private SQLException queryFailure;
        private SQLException readFailure;
        private int closedStatements;
        private int closedResults;
        private boolean closedConnection;

        private NativeJdbc(String ddl) {
            this.ddl = ddl;
        }

        private GoldendbAgent agent() {
            GoldendbAgent agent = new GoldendbAgent();
            Connection connection = proxy(Connection.class, (proxy, method, args) -> switch (method.getName()) {
                case "createStatement" -> statement();
                case "getCatalog" -> catalog;
                case "setCatalog" -> {
                    catalog = (String) args[0];
                    yield null;
                }
                case "close" -> {
                    closedConnection = true;
                    yield null;
                }
                default -> throw new AssertionError("Unexpected connection call: " + method.getName());
            });
            TestSupport.setPrivateConnection(agent, connection);
            return agent;
        }

        private Statement statement() {
            return proxy(Statement.class, (proxy, method, args) -> switch (method.getName()) {
                case "executeQuery" -> {
                    queries.add((String) args[0]);
                    if (queryFailure != null) {
                        throw queryFailure;
                    }
                    yield resultSet();
                }
                case "close" -> {
                    closedStatements++;
                    yield null;
                }
                default -> throw new AssertionError("Unexpected statement call: " + method.getName());
            });
        }

        private ResultSet resultSet() {
            boolean[] visited = {false};
            List<String> values = labels.size() == 3 ? Arrays.asList("object_name", "", ddl) : Arrays.asList("orders", ddl);
            ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (proxy, method, args) -> switch (method.getName()) {
                case "getColumnCount" -> labels.size();
                case "getColumnLabel", "getColumnName" -> labels.get((Integer) args[0] - 1);
                default -> throw new AssertionError("Unexpected result metadata call: " + method.getName());
            });
            return proxy(ResultSet.class, (proxy, method, args) -> switch (method.getName()) {
                case "next" -> {
                    boolean available = hasRow && !visited[0];
                    visited[0] = true;
                    yield available;
                }
                case "getString" -> {
                    if (readFailure != null) {
                        throw readFailure;
                    }
                    int index = args[0] instanceof Integer ? (Integer) args[0] - 1 : labels.indexOf(args[0]);
                    if (index < 0 || index >= values.size()) {
                        throw new SQLException("Unknown result column: " + args[0]);
                    }
                    yield values.get(index);
                }
                case "getMetaData" -> metadata;
                case "close" -> {
                    closedResults++;
                    yield null;
                }
                default -> throw new AssertionError("Unexpected result call: " + method.getName());
            });
        }

        private void assertClosedResources(int statements, int results) {
            assertEquals(statements, closedStatements);
            assertEquals(results, closedResults);
            assertFalse(closedConnection);
        }

        private static <Value> Value proxy(Class<Value> type, InvocationHandler handler) {
            return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
        }
    }
}
