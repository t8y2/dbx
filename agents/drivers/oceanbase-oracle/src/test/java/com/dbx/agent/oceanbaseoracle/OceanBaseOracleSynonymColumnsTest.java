package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class OceanBaseOracleSynonymColumnsTest {
    @Test
    void privateSynonymReturnsTargetColumnMetadataAcrossSchemas() {
        var catalog = new Catalog();
        catalog.synonym("APP", "ORDER_ALIAS", "SALES", "ORDERS", null);
        catalog.object("SALES", "ORDERS", "TABLE");
        catalog.columns("SALES", "ORDERS", amountColumn());

        List<ColumnInfo> columns = catalog.agent.getColumns("APP", "ORDER_ALIAS");

        assertEquals(1, columns.size());
        ColumnInfo column = columns.getFirst();
        assertEquals("AMOUNT", column.getName());
        assertEquals("NUMBER(19,4)", column.getData_type());
        assertEquals(19, column.getNumeric_precision());
        assertEquals(4, column.getNumeric_scale());
        assertFalse(column.getIs_nullable());
        assertTrue(column.getIs_primary_key());
        assertEquals("0", column.getColumn_default());
        assertEquals("Order amount", column.getComment());
    }

    private static Map<String, Object> amountColumn() {
        return Map.of("COLUMN_NAME", "AMOUNT", "DATA_TYPE", "NUMBER", "NULLABLE", "N",
            "DATA_PRECISION", 19, "DATA_SCALE", 4, "DATA_LENGTH", 22,
            "DATA_DEFAULT", "0", "COMMENTS", "Order amount", "IS_PK", 1);
    }

    @Test
    void synonymChainRetainsQuotedTargetNamesAndVerifiedViewIdentity() {
        var catalog = new Catalog();
        catalog.synonym("APP", "ORDER_ALIAS", "Bridge.Owner", "Next.Alias", null);
        catalog.synonym("Bridge.Owner", "Next.Alias", "Sales.Owner", "Order\"View", null);
        catalog.object("Sales.Owner", "Order\"View", "VIEW");
        catalog.columns("Sales.Owner", "Order\"View", amountColumn());

        ColumnInfo column = catalog.agent.getColumns("APP", "ORDER_ALIAS").getFirst();

        assertEquals("Sales.Owner", column.getResolved_schema());
        assertEquals("Order\"View", column.getResolved_table());
        assertEquals("VIEW", column.getResolved_object_type());
        assertEquals("NUMBER(19,4)", column.getData_type());
        assertFalse(column.getIs_nullable());
        assertTrue(column.getIs_primary_key());
    }

    private record Name(String owner, String name) {}

    @Test
    void publicSynonymResolvesOnlyWhenSchemaIsNotExplicit() {
        var catalog = new Catalog();
        catalog.synonym("PUBLIC", "PUBLIC_ORDERS", "SALES", "ORDERS", null);
        catalog.object("SALES", "ORDERS", "TABLE");
        catalog.columns("SALES", "ORDERS", amountColumn());
        catalog.nativeResult("APP", "PUBLIC_ORDERS", "SALES", "ORDERS", null);

        ColumnInfo column = catalog.agent.getColumns("", "PUBLIC_ORDERS").getFirst();
        assertEquals("SALES", column.getResolved_schema());
        assertEquals("ORDERS", column.getResolved_table());
        assertEquals("TABLE", column.getResolved_object_type());
        assertTrue(catalog.sql.stream().noneMatch(sql -> sql.startsWith("ALTER SESSION")));
        RuntimeException error = assertThrows(RuntimeException.class,
            () -> catalog.agent.getColumns("APP", "PUBLIC_ORDERS"));
        assertTrue(error.getMessage().contains("not found or not accessible"), error.getMessage());
    }

    @Test
    void publicSynonymSupportsTheOceanBaseDictionaryPublicOwner() {
        var catalog = new Catalog();
        catalog.synonym("__public", "PUBLIC_ORDERS", "SALES", "ORDERS", null);
        catalog.object("SALES", "ORDERS", "TABLE");
        catalog.columns("SALES", "ORDERS", amountColumn());
        catalog.nativeResult("APP", "PUBLIC_ORDERS", "SALES", "ORDERS", null);

        ColumnInfo column = catalog.agent.getColumns("", "PUBLIC_ORDERS").getFirst();

        assertEquals("SALES", column.getResolved_schema());
        assertEquals("ORDERS", column.getResolved_table());
        assertEquals("TABLE", column.getResolved_object_type());
        assertThrows(RuntimeException.class, () -> catalog.agent.getColumns("APP", "PUBLIC_ORDERS"));
    }

    @Test
    void selectedSchemaContextResolvesLocalNamesAndStillAllowsPublicFallback() {
        var catalog = new Catalog();
        catalog.columns("Reporting", "LOCAL_ORDERS", amountColumn());
        catalog.synonym("PUBLIC", "PUBLIC_ORDERS", "SALES", "ORDERS", null);
        catalog.object("SALES", "ORDERS", "TABLE");
        catalog.columns("SALES", "ORDERS", amountColumn());
        catalog.nativeResult("Reporting", "PUBLIC_ORDERS", "SALES", "ORDERS", null);

        assertEquals("AMOUNT", catalog.agent.getColumnsInContext("", "LOCAL_ORDERS", "Reporting").getFirst().getName());
        assertEquals("SALES", catalog.agent.getColumnsInContext("", "PUBLIC_ORDERS", "Reporting").getFirst().getResolved_schema());
        assertEquals("APP", catalog.currentSchema);
        assertThrows(RuntimeException.class, () -> catalog.agent.getColumnsInContext("Reporting", "PUBLIC_ORDERS", "APP"));
    }

    @Test
    void localNamespaceObjectsShadowPublicSynonymsEvenWhenTheyHaveNoColumns() {
        for (String type : List.of("TABLE", "VIEW", "SEQUENCE", "PROCEDURE", "FUNCTION", "PACKAGE", "TYPE")) {
            var catalog = new Catalog();
            catalog.object("APP", "ORDERS", type);
            catalog.synonym("PUBLIC", "ORDERS", "SALES", "ORDERS", null);
            catalog.object("SALES", "ORDERS", "TABLE");
            catalog.columns("SALES", "ORDERS", amountColumn());

            assertThrows(RuntimeException.class, () -> catalog.agent.getColumns("", "ORDERS"), type);
            assertFalse(catalog.columnReads.contains(new Name("SALES", "ORDERS")), type);
        }
    }

    @Test
    void remoteSynonymIsRejectedBeforeAnyTargetQuery() {
        var catalog = new Catalog();
        catalog.synonym("APP", "REMOTE_ORDERS", "SALES", "ORDERS", "REMOTE.EXAMPLE");
        catalog.columns("SALES", "ORDERS", amountColumn());

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> catalog.agent.getColumns("APP", "REMOTE_ORDERS"));

        assertTrue(error.getMessage().contains("DBLink"), error.getMessage());
        assertTrue(error.getMessage().contains("not supported"), error.getMessage());
        assertEquals(List.of(new Name("APP", "REMOTE_ORDERS")), catalog.columnReads);
        assertTrue(catalog.sql.stream().noneMatch(sql -> sql.contains("@")));
    }

    @Test
    void cyclicSynonymsFailWithAnExplicitCycleError() {
        var catalog = new Catalog();
        catalog.synonym("APP", "A", "OTHER", "B", null);
        catalog.synonym("OTHER", "B", "APP", "A", null);

        RuntimeException error = assertThrows(RuntimeException.class, () -> catalog.agent.getColumns("APP", "A"));

        assertTrue(error.getMessage().contains("cycle"), error.getMessage());
        assertEquals(List.of(new Name("APP", "A"), new Name("OTHER", "B")), catalog.columnReads);
    }

    @Test
    void incompleteSynonymTargetMetadataNeverFallsBackToTheSessionOwner() {
        for (String[] target : new String[][]{{null, "ORDERS"}, {"SALES", null}, {"", "ORDERS"}, {"SALES", ""}}) {
            var catalog = new Catalog();
            catalog.synonym("APP", "BROKEN", target[0], target[1], null);
            catalog.columns("APP", "ORDERS", amountColumn());

            RuntimeException error = assertThrows(RuntimeException.class, () -> catalog.agent.getColumns("APP", "BROKEN"));

            assertTrue(error.getMessage() != null && error.getMessage().contains("Incomplete synonym target metadata"), String.valueOf(error));
            assertEquals(List.of(new Name("APP", "BROKEN")), catalog.columnReads);
        }
    }

    @Test
    void materializedViewIdentityTakesPrecedenceOverItsTableEntry() {
        var catalog = new Catalog();
        catalog.synonym("APP", "MV_ALIAS", "SALES", "ORDER_TOTALS", null);
        catalog.objects.put(new Name("SALES", "ORDER_TOTALS"), List.of(
            Map.of("OBJECT_TYPE", "TABLE"), Map.of("OBJECT_TYPE", "MATERIALIZED VIEW")));
        catalog.columns("SALES", "ORDER_TOTALS", amountColumn());

        assertEquals("MATERIALIZED VIEW", catalog.agent.getColumns("APP", "MV_ALIAS").getFirst().getResolved_object_type());
    }

    @Test
    void unknownTargetTypeIsNotPromotedToTable() {
        var catalog = new Catalog();
        catalog.synonym("APP", "ORDER_ALIAS", "SALES", "ORDERS", null);
        catalog.columns("SALES", "ORDERS", amountColumn());

        ColumnInfo column = catalog.agent.getColumns("APP", "ORDER_ALIAS").getFirst();

        assertEquals("SALES", column.getResolved_schema());
        assertEquals("ORDERS", column.getResolved_table());
        assertNull(column.getResolved_object_type());
    }

    @Test
    void localTableAndPrivateSynonymTakePrecedenceOverPublicSynonym() {
        var catalog = new Catalog();
        catalog.synonym("PUBLIC", "ORDERS", "OTHER", "ORDERS", null);
        catalog.synonym("PUBLIC", "ORDER_ALIAS", "OTHER", "ORDERS", null);
        catalog.synonym("APP", "ORDER_ALIAS", "APP", "ORDERS", null);
        catalog.object("APP", "ORDERS", "TABLE");
        catalog.columns("APP", "ORDERS", amountColumn());

        assertEquals("AMOUNT", catalog.agent.getColumns("", "ORDERS").getFirst().getName());
        assertEquals("APP", catalog.agent.getColumns("", "ORDER_ALIAS").getFirst().getResolved_schema());
        assertFalse(catalog.columnReads.contains(new Name("OTHER", "ORDERS")));
    }

    @Test
    void brokenPrivateTargetDoesNotFallThroughToPublicSynonyms() {
        var catalog = new Catalog();
        catalog.synonym("APP", "ORDERS", "SALES", "MISSING", null);
        catalog.synonym("PUBLIC", "ORDERS", "OTHER", "ORDERS", null);
        catalog.synonym("PUBLIC", "MISSING", "OTHER", "ORDERS", null);
        catalog.columns("OTHER", "ORDERS", amountColumn());

        RuntimeException error = assertThrows(RuntimeException.class, () -> catalog.agent.getColumns("", "ORDERS"));

        assertTrue(error.getMessage().contains("SALES.MISSING not found or not accessible"), error.getMessage());
        assertFalse(catalog.columnReads.contains(new Name("OTHER", "ORDERS")));
    }

    @Test
    void missingAndInaccessibleTargetsAreNotSuccessfulEmptyColumns() {
        var catalog = new Catalog();
        catalog.synonym("APP", "INACCESSIBLE", "SALES", "HIDDEN", null);

        for (String name : List.of("MISSING", "INACCESSIBLE")) {
            RuntimeException error = assertThrows(RuntimeException.class, () -> catalog.agent.getColumns("APP", name));
            assertTrue(error.getMessage().contains("not found or not accessible"), error.getMessage());
        }
    }

    @Test
    void dictionaryFailuresPreserveTheOriginalSqlException() {
        for (String view : List.of("ALL_TAB_COLUMNS", "ALL_OBJECTS", "ALL_SYNONYMS")) {
            var catalog = new Catalog();
            catalog.failure = new SQLException("insufficient privileges", "42000", 1031);
            catalog.failureView = view;

            RuntimeException error = assertThrows(RuntimeException.class, () -> catalog.agent.getColumns("APP", "ORDERS"));

            assertSame(catalog.failure, error.getCause(), view);
        }
    }

    @Test
    void longAcyclicChainHasABoundedResolutionLimit() {
        var catalog = new Catalog();
        for (int index = 0; index < 40; index++) {
            catalog.synonym("APP", "S" + index, "APP", "S" + (index + 1), null);
        }
        catalog.columns("APP", "S40", amountColumn());

        RuntimeException error = assertThrows(RuntimeException.class, () -> catalog.agent.getColumns("APP", "S0"));

        assertTrue(error.getMessage().contains("exceeded 32 links"), error.getMessage());
        assertTrue(catalog.columnReads.size() <= 33);
        assertFalse(catalog.columnReads.contains(new Name("APP", "S40")));
    }

    @Test
    void invisibleForeignLocalObjectCannotBeReplacedByAPublicTarget() {
        var catalog = new Catalog();
        catalog.synonym("__public", "PUBLIC_ORDERS", "SALES", "ORDERS", null);
        catalog.object("SALES", "ORDERS", "TABLE");
        catalog.columns("SALES", "ORDERS", amountColumn());
        catalog.nativeResult("Reporting", "PUBLIC_ORDERS", "Reporting", "PUBLIC_ORDERS", null);

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> catalog.agent.getColumnsInContext("", "PUBLIC_ORDERS", "Reporting"));

        assertTrue(error.getMessage().contains("does not match"), error.getMessage());
        assertEquals("APP", catalog.currentSchema);
    }

    private record NativeTarget(String owner, String name, String databaseLink) {}

    @Test
    void nativePublicResolutionFailureRestoresTheExactOriginalSchema() {
        var catalog = publicCatalog();
        catalog.currentSchema = "Original.Owner";
        catalog.nativeFailure = new SQLException("NAME_RESOLVE not available", "42000", 6550);

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> catalog.agent.getColumnsInContext("", "PUBLIC_ORDERS", "Reporting"));

        assertSame(catalog.nativeFailure, error.getCause());
        assertEquals("Original.Owner", catalog.currentSchema);
    }

    @Test
    void nativePublicResolutionRejectsRemoteTargetsWithoutRemoteQueries() {
        var catalog = publicCatalog();
        catalog.nativeResult("Reporting", "PUBLIC_ORDERS", "SALES", "ORDERS", "REMOTE.EXAMPLE");

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> catalog.agent.getColumnsInContext("", "PUBLIC_ORDERS", "Reporting"));

        assertTrue(error.getMessage().contains("DBLink"), error.getMessage());
        assertEquals("APP", catalog.currentSchema);
        assertTrue(catalog.sql.stream().noneMatch(sql -> sql.contains("@")));
    }

    @Test
    void schemaRestoreFailureCannotReturnSuccessfulColumns() {
        var catalog = publicCatalog();
        catalog.restoreFailure = new SQLException("restore failed");

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> catalog.agent.getColumnsInContext("", "PUBLIC_ORDERS", "Reporting"));

        assertSame(catalog.restoreFailure, error.getCause());
    }

    @Test
    void schemaRestoreFailureIsSuppressedOnTheOriginalResolutionError() {
        var catalog = publicCatalog();
        catalog.nativeFailure = new SQLException("resolution failed");
        catalog.restoreFailure = new SQLException("restore failed");

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> catalog.agent.getColumnsInContext("", "PUBLIC_ORDERS", "Reporting"));

        assertSame(catalog.nativeFailure, error.getCause());
        assertArrayEquals(new Throwable[]{catalog.restoreFailure}, error.getCause().getSuppressed());
    }

    private static Catalog publicCatalog() {
        var catalog = new Catalog();
        catalog.synonym("__public", "PUBLIC_ORDERS", "SALES", "ORDERS", null);
        catalog.object("SALES", "ORDERS", "TABLE");
        catalog.columns("SALES", "ORDERS", amountColumn());
        catalog.nativeResult("Reporting", "PUBLIC_ORDERS", "SALES", "ORDERS", null);
        return catalog;
    }

    private static final class Catalog {
        final OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        final Map<Name, List<Map<String, Object>>> columns = new HashMap<>();
        final Map<Name, List<Map<String, Object>>> synonyms = new HashMap<>();
        final Map<Name, List<Map<String, Object>>> objects = new HashMap<>();
        final Map<Name, NativeTarget> nativeTargets = new HashMap<>();
        final List<String> sql = new ArrayList<>();
        final List<Name> columnReads = new ArrayList<>();
        String currentSchema = "APP";
        SQLException failure;
        SQLException nativeFailure;
        SQLException restoreFailure;
        String failureView;

        Catalog() {
            Connection connection = proxy(Connection.class, (ignored, method, args) -> {
                if (method.getName().equals("prepareStatement")) return statement((String) args[0]);
                if (method.getName().equals("prepareCall")) return nativeStatement((String) args[0]);
                if (method.getName().equals("createStatement")) {
                    return proxy(Statement.class, (stmt, call, params) -> {
                        if (call.getName().equals("executeQuery")) {
                            sql.add((String) params[0]);
                            return rows(List.of(Map.of("CURRENT_SCHEMA", currentSchema)));
                        }
                        if (call.getName().equals("execute")) {
                            String query = (String) params[0];
                            sql.add(query);
                            String prefix = "ALTER SESSION SET CURRENT_SCHEMA = ";
                            assertTrue(query.startsWith(prefix), query);
                            String identifier = query.substring(prefix.length());
                            if (restoreFailure != null && identifier.equals("\"APP\"")) throw restoreFailure;
                            currentSchema = identifier.substring(1, identifier.length() - 1).replace("\"\"", "\"");
                            return false;
                        }
                        return defaultValue(call.getReturnType());
                    });
                }
                return defaultValue(method.getReturnType());
            });
            TestSupport.setPrivateConnection(agent, connection);
        }

        void synonym(String owner, String name, String targetOwner, String targetName, String link) {
            var row = new HashMap<String, Object>();
            row.put("TABLE_OWNER", targetOwner);
            row.put("TABLE_NAME", targetName);
            row.put("DB_LINK", link);
            synonyms.put(new Name(owner, name), List.of(row));
            object(owner, name, "SYNONYM");
        }

        void object(String owner, String name, String type) {
            objects.put(new Name(owner, name), List.of(Map.of("OBJECT_TYPE", type)));
        }

        void columns(String owner, String name, Map<String, Object> column) {
            columns.put(new Name(owner, name), List.of(column));
        }

        void nativeResult(String owner, String name, String targetOwner, String targetName, String link) {
            nativeTargets.put(new Name(owner, name), new NativeTarget(targetOwner, targetName, link));
        }

        private CallableStatement nativeStatement(String query) {
            sql.add(query);
            Map<Integer, Object> parameters = new HashMap<>();
            NativeTarget[] result = {null};
            return proxy(CallableStatement.class, (ignored, method, args) -> {
                if (method.getName().equals("setString") || method.getName().equals("setInt")) {
                    parameters.put((Integer) args[0], args[1]);
                    return null;
                }
                if (method.getName().equals("execute")) {
                    assertEquals(0, parameters.get(2), "OceanBase table resolution requires context 0");
                    if (nativeFailure != null) throw nativeFailure;
                    String identifier = (String) parameters.get(1);
                    assertTrue(identifier.startsWith("\"") && identifier.endsWith("\""), identifier);
                    String name = identifier.substring(1, identifier.length() - 1).replace("\"\"", "\"");
                    result[0] = nativeTargets.get(new Name(currentSchema, name));
                    assertNotNull(result[0], "Unexpected native resolution for " + currentSchema + "." + name);
                    return false;
                }
                if (method.getName().equals("getString")) {
                    return switch ((Integer) args[0]) {
                        case 3 -> result[0].owner();
                        case 4 -> result[0].name();
                        case 6 -> result[0].databaseLink();
                        default -> null;
                    };
                }
                return defaultValue(method.getReturnType());
            });
        }

        private PreparedStatement statement(String query) {
            sql.add(query);
            Map<Integer, String> parameters = new HashMap<>();
            return proxy(PreparedStatement.class, (ignored, method, args) -> {
                if (method.getName().equals("setString")) {
                    parameters.put((Integer) args[0], (String) args[1]);
                    return null;
                }
                if (method.getName().equals("executeQuery")) {
                    if (failure != null && query.contains(failureView)) throw failure;
                    Name name = new Name(parameters.get(1), parameters.get(2));
                    if (query.contains("FROM ALL_TAB_COLUMNS")) {
                        assertEquals(name, new Name(parameters.get(3), parameters.get(4)), "PK and column owners must agree");
                        columnReads.add(name);
                        return rows(columns.getOrDefault(name, List.of()));
                    }
                    if (query.contains("FROM ALL_SYNONYMS")) return rows(synonyms.getOrDefault(name, List.of()));
                    if (query.contains("FROM ALL_OBJECTS")) return rows(objects.getOrDefault(name, List.of()));
                    throw new AssertionError("Unexpected metadata query: " + query);
                }
                return defaultValue(method.getReturnType());
            });
        }
    }

    private static ResultSet rows(List<Map<String, Object>> data) {
        int[] index = {-1};
        boolean[] wasNull = {false};
        return proxy(ResultSet.class, (ignored, method, args) -> {
            if (method.getName().equals("next")) return ++index[0] < data.size();
            if (method.getName().equals("wasNull")) return wasNull[0];
            if (method.getName().equals("getString") || method.getName().equals("getInt") || method.getName().equals("getObject")) {
                Object value = args[0] instanceof Integer
                    ? data.get(index[0]).values().iterator().next() : data.get(index[0]).get(args[0]);
                wasNull[0] = value == null;
                if (method.getName().equals("getObject")) return value;
                if (method.getName().equals("getInt")) return value == null ? 0 : ((Number) value).intValue();
                return value == null ? null : value.toString();
            }
            return defaultValue(method.getReturnType());
        });
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler);
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
}
