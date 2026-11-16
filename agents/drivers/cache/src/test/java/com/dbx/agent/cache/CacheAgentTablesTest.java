package com.dbx.agent.cache;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.TableInfo;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CacheAgentTablesTest {
    @Test
    void bindsSpecialSchemaNamesLiterallyWithoutJdbcMetadata() throws Exception {
        for (String schema : List.of("_system", "%Atelier", "SQLUser", "a'b")) {
            Fixture fixture = new Fixture(List.of(table("Example", "BASE TABLE", "description")));
            List<TableInfo> tables = fixture.agent.listTables(schema);

            assertEquals("Example", tables.get(0).getName());
            assertEquals("TABLE", tables.get(0).getTable_type());
            assertEquals("description", tables.get(0).getComment());
            assertTrue(fixture.sql.contains("FROM INFORMATION_SCHEMA.TABLES"));
            assertTrue(fixture.sql.contains("TABLE_SCHEMA = ?"));
            assertEquals(schema, fixture.bindings.get(0));
            assertFalse(fixture.sql.contains(schema));
            assertTrue(fixture.statementClosed);
            assertTrue(fixture.resultClosed);
        }
    }

    @Test
    void stopsReadingMetadataAtTheRequestedPage() throws Exception {
        List<Map<String, String>> rows = new ArrayList<>();
        for (int index = 0; index < 5000; index++) {
            rows.add(table(String.format("Table%05d", index), "TABLE", ""));
        }
        Fixture fixture = new Fixture(rows);

        List<TableInfo> tables = fixture.agent.listTables("_system", constraints(null, 2, 3, "TABLE"));

        assertEquals(2, tables.size());
        assertEquals("Table00003", tables.get(0).getName());
        assertEquals("Table00004", tables.get(1).getName());
        assertEquals(5, fixture.rowsRead);
        assertTrue(fixture.sql.startsWith("SELECT TOP 5 "));
        assertTrue(fixture.sql.endsWith("ORDER BY TABLE_NAME, TABLE_SCHEMA"));
        assertEquals(List.of("_system", "TABLE", "BASE TABLE", "SYSTEM TABLE"), fixture.bindings);
    }

    @Test
    void filtersViewsBeforeApplyingThePageLimit() throws Exception {
        Fixture fixture = new Fixture(List.of(table("Report", "VIEW", "")));

        assertEquals("VIEW", fixture.agent.listTables("SQLUser", constraints(null, 1, 0, "VIEW")).get(0).getTable_type());
        assertEquals(List.of("SQLUser", "VIEW", "SYSTEM VIEW"), fixture.bindings);
    }

    @Test
    void routesObjectTypeOverloadThroughTheNativeQuery() throws Exception {
        Fixture fixture = new Fixture(List.of(table("Report", "SYSTEM VIEW", "")));

        assertEquals("SYSTEM VIEW", fixture.agent.listTables("SQLUser", List.of("VIEW")).get(0).getTable_type());
        assertEquals(List.of("SQLUser", "VIEW", "SYSTEM VIEW"), fixture.bindings);
    }

    @Test
    void handlesOffsetBeyondTheLastTable() throws Exception {
        Fixture fixture = new Fixture(List.of(table("Example", "TABLE", "")));

        assertTrue(fixture.agent.listTables("SQLUser", constraints(null, 2, 5, "TABLE")).isEmpty());
        assertEquals(1, fixture.rowsRead);
    }

    @Test
    void avoidsOverflowInTheServerFetchLimit() throws Exception {
        Fixture fixture = new Fixture(List.of());

        assertTrue(fixture.agent.listTables("SQLUser", constraints(null, 2, Integer.MAX_VALUE, "TABLE")).isEmpty());
        assertFalse(fixture.sql.contains("TOP"));
    }

    @Test
    void preservesFuzzyNameAndCommentSearchBeforeOffset() throws Exception {
        Fixture fixture = new Fixture(List.of(
            table("Alpha", "TABLE", ""),
            table("Budget", "TABLE", "monthly report"),
            table("Other", "TABLE", ""),
            table("MonthlyReport", "TABLE", ""),
            table("Unused", "TABLE", "")
        ));

        List<TableInfo> tables = fixture.agent.listTables("SQLUser", constraints("mrt", 1, 1, "TABLE"));

        assertEquals("MonthlyReport", tables.get(0).getName());
        assertEquals(4, fixture.rowsRead);
        assertFalse(fixture.sql.contains("TOP"));
    }

    @Test
    void supportsUnscopedAndUnpagedLists() throws Exception {
        Fixture fixture = new Fixture(List.of(table("Alpha", "TABLE", ""), table("Beta", "SYSTEM VIEW", "")));

        assertEquals(2, fixture.agent.listTables(null).size());
        assertFalse(fixture.sql.contains("TABLE_SCHEMA = ?"));
        assertFalse(fixture.sql.contains("TOP"));
    }

    @Test
    void unsupportedObjectTypesDoNotContactTheDatabase() throws Exception {
        Fixture fixture = new Fixture(List.of());

        assertTrue(fixture.agent.listTables("SQLUser", constraints(null, 1, 0, "PROCEDURE")).isEmpty());
        assertEquals("", fixture.sql);
    }

    @Test
    void doesNotFallbackForAnEmptySchema() throws Exception {
        Fixture fixture = new Fixture(List.of());

        assertTrue(fixture.agent.listTables("Empty").isEmpty());
        assertTrue(fixture.statementClosed);
        assertTrue(fixture.resultClosed);
    }

    @Test
    void fallsBackToJdbcForServersWithoutInformationSchema() throws Exception {
        Fixture fixture = new Fixture(List.of(table("Legacy", "TABLE", "")));
        fixture.queryFailure = new SQLException("Table INFORMATION_SCHEMA.TABLES not found", "42S02", -30);
        fixture.allowJdbc = true;

        assertEquals("Legacy", fixture.agent.listTables("SQLUser", constraints(null, 1, 0, "TABLE")).get(0).getName());
        assertTrue(fixture.jdbcUsed);
        assertTrue(fixture.statementClosed);
    }

    @Test
    void preservesConfiguredNamespaceForInheritedMetadata() throws Exception {
        Fixture fixture = new Fixture(List.of());
        fixture.allowJdbc = true;

        assertEquals("USER", fixture.agent.listDatabases().get(0).getName());
    }

    @Test
    void closesResourcesWhenReadingFails() throws Exception {
        Fixture fixture = new Fixture(List.of());
        fixture.readFailure = new SQLException("connection lost", "08006");

        assertThrows(RuntimeException.class, () -> fixture.agent.listTables("SQLUser"));
        assertTrue(fixture.statementClosed);
        assertTrue(fixture.resultClosed);
        assertFalse(fixture.jdbcUsed);
    }

    @Test
    void doesNotRetryPermissionOrConnectionErrorsThroughLegacyMetadata() throws Exception {
        for (String state : List.of("42000", "08006")) {
            Fixture fixture = new Fixture(List.of());
            fixture.queryFailure = new SQLException("metadata query failed", state);

            assertThrows(RuntimeException.class, () -> fixture.agent.listTables("SQLUser"));
            assertTrue(fixture.statementClosed);
            assertFalse(fixture.jdbcUsed);
        }
    }

    private static MetadataListConstraints constraints(String filter, int limit, int offset, String type) {
        return new MetadataListConstraints(filter, limit, offset, List.of(type));
    }

    private static Map<String, String> table(String name, String type, String comment) {
        return Map.of("TABLE_NAME", name, "TABLE_TYPE", type, "DESCRIPTION", comment, "REMARKS", comment);
    }

    private static <Value> Value proxy(Class<Value> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }

    private static final class Fixture {
        private final CacheAgent agent = new CacheAgent();
        private final List<String> bindings = new ArrayList<>();
        private String sql = "";
        private int rowsRead;
        private boolean statementClosed;
        private boolean resultClosed;
        private boolean allowJdbc;
        private boolean jdbcUsed;
        private SQLException queryFailure;
        private SQLException readFailure;

        private Fixture(List<Map<String, String>> values) throws Exception {
            Connection connection = proxy(Connection.class, (instance, method, arguments) -> {
                switch (method.getName()) {
                    case "prepareStatement":
                        sql = (String) arguments[0];
                        return proxy(PreparedStatement.class, (statement, operation, parameters) -> {
                            switch (operation.getName()) {
                                case "setString": bindings.add((String) parameters[1]); return null;
                                case "executeQuery":
                                    if (queryFailure != null) throw queryFailure;
                                    return rows(values);
                                case "close": statementClosed = true; return null;
                                default: throw new AssertionError(operation.getName());
                            }
                        });
                    case "getMetaData":
                        if (!allowJdbc) throw new AssertionError("unexpected legacy JDBC metadata query");
                        jdbcUsed = true;
                        return proxy(DatabaseMetaData.class, (metadata, operation, parameters) -> {
                            switch (operation.getName()) {
                                case "getTables": return rows(values);
                                case "getTableTypes": return rows(List.of(Map.of("TABLE_TYPE", "TABLE")));
                                case "getCatalogs": return rows(List.of());
                                case "getSearchStringEscape": return "\\";
                                default: throw new AssertionError(operation.getName());
                            }
                        });
                    case "getCatalog": return null;
                    default: throw new AssertionError(method.getName());
                }
            });
            Field connectionField = AbstractJdbcAgent.class.getDeclaredField("connection");
            connectionField.setAccessible(true);
            connectionField.set(agent, connection);
            agent.afterConnect(new ConnectParams("db.local", 1972, "USER", "", "", "", "", false), connection);
        }

        private ResultSet rows(List<Map<String, String>> values) {
            int[] position = {-1};
            return proxy(ResultSet.class, (instance, method, arguments) -> {
                switch (method.getName()) {
                    case "next":
                        if (readFailure != null) throw readFailure;
                        boolean hasNext = ++position[0] < values.size();
                        if (hasNext) rowsRead++;
                        return hasNext;
                    case "getString": return values.get(position[0]).get((String) arguments[0]);
                    case "close": resultClosed = true; return null;
                    default: throw new AssertionError(method.getName());
                }
            });
        }
    }
}
