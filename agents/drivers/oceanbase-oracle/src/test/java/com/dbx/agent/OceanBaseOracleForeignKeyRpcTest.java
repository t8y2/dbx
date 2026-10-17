package com.dbx.agent;

import com.dbx.agent.oceanbaseoracle.OceanBaseOracleAgent;
import com.dbx.agent.test.TestSupport;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class OceanBaseOracleForeignKeyRpcTest {
    @Test
    void readsOwnKeyHiddenFromAllByColumnLevelReferenceGrant() {
        Fixture jdbc = new Fixture();
        jdbc.hiddenFromAll = true;
        assertEquals(2, jdbc.request().getAsJsonArray("result").size());
        assertTrue(jdbc.queries.stream().anyMatch(sql -> sql.contains("SYS.USER_CONSTRAINTS") && !sql.contains("c.OWNER")));
    }

    @Test
    void neverUsesUserConstraintsForAnotherOrDifferentlyCasedOwner() {
        for (String user : List.of("OTHER", "app")) {
            Fixture jdbc = new Fixture(); jdbc.currentUser = user; jdbc.hiddenFromAll = true;
            assertEquals(0, jdbc.request().getAsJsonArray("result").size());
            assertTrue(jdbc.queries.stream().anyMatch(sql -> sql.contains("SYS.ALL_CONSTRAINTS")));
            assertFalse(jdbc.queries.stream().anyMatch(sql -> sql.contains("SYS.USER_CONSTRAINTS")));
        }
    }

    @Test
    void rejectsMissingOrAmbiguousUserInsteadOfFallingBackToEmptyAll() {
        for (int count : List.of(0, 2)) {
            Fixture jdbc = new Fixture(); jdbc.userCount = count;
            assertTrue(jdbc.request().has("error"));
        }
        Fixture blank = new Fixture(); blank.currentUser = "";
        assertTrue(blank.request().has("error"));
    }
    @Test
    void returnsActualReferencedColumnPairsAndOwnerThroughProductionRpc() {
        Fixture jdbc = new Fixture();
        JsonObject response = jdbc.request();
        assertFalse(response.has("error"), response.toString());
        var keys = response.getAsJsonArray("result");
        assertEquals(2, keys.size());
        var first = keys.get(0).getAsJsonObject();
        assertEquals("B", first.get("column").getAsString());
        assertEquals("V", first.get("ref_column").getAsString());
        assertEquals("PARENT_OWNER", first.get("ref_schema").getAsString());
        assertEquals("CASCADE", first.get("on_delete").getAsString());
        assertEquals("A", keys.get(1).getAsJsonObject().get("column").getAsString());
        assertEquals("ID", keys.get(1).getAsJsonObject().get("ref_column").getAsString());
        assertTrue(jdbc.parameters.contains(List.of("FK_SOURCE", "APP")), jdbc.parameters.toString());
    }

    @Test
    void preservesQuotedCommaAndEscapedQuoteIdentifiers() {
        Fixture jdbc = new Fixture();
        jdbc.ddl = "ALTER TABLE \"APP\".\"SOURCE\" ADD CONSTRAINT \"FK_SOURCE\" FOREIGN KEY (\"Local,One\", \"Local\"\"Two\") REFERENCES \"PARENT_OWNER\".\"Parent,Table\" (\"Ref,One\", \"Ref\"\"Two\") ON DELETE SET NULL ENABLE";
        jdbc.deleteRule = "SET NULL";
        var response = jdbc.request();
        assertFalse(response.has("error"), response.toString());
        var keys = response.getAsJsonArray("result");
        assertEquals("Local,One", keys.get(0).getAsJsonObject().get("column").getAsString());
        assertEquals("Ref,One", keys.get(0).getAsJsonObject().get("ref_column").getAsString());
        assertEquals("Local\"Two", keys.get(1).getAsJsonObject().get("column").getAsString());
        assertEquals("Parent,Table", keys.get(1).getAsJsonObject().get("ref_table").getAsString());
        assertEquals("SET NULL", keys.get(1).getAsJsonObject().get("on_delete").getAsString());
    }

    @Test
    void rejectsUnreadableAndInconsistentDefinitionsInsteadOfReturningWrongPairs() {
        for (String ddl : List.of("", "ALTER TABLE \"APP\".\"SOURCE\" ADD", 
                "ALTER TABLE \"OTHER\".\"SOURCE\" ADD CONSTRAINT \"FK_SOURCE\" FOREIGN KEY (\"B\", \"A\") REFERENCES \"PARENT_OWNER\".\"PARENT\" (\"V\", \"ID\") ON DELETE CASCADE ENABLE")) {
            Fixture jdbc = new Fixture(); jdbc.ddl = ddl;
            JsonObject response = jdbc.request();
            assertTrue(response.has("error"), response.toString());
            assertFalse(response.has("result"), response.toString());
        }
        Fixture denied = new Fixture(); denied.ddlFailure = true;
        JsonObject response = denied.request();
        assertTrue(response.has("error"), response.toString());
    }

    @Test
    void distinguishesVisibleEmptyTablesFromHiddenTables() {
        Fixture empty = new Fixture(); empty.hasForeignKey = false;
        assertEquals(0, empty.request().getAsJsonArray("result").size());
        Fixture hidden = new Fixture(); hidden.hasForeignKey = false; hidden.visible = false;
        assertTrue(hidden.request().has("error"));
    }

    @Test
    void rejectsTrailingTextDuplicateColumnsAndConflictingStates() {
        Fixture valid = new Fixture();
        for (String ddl : List.of(valid.ddl + " trailing", valid.ddl + "; DROP TABLE X", valid.ddl + " DISABLE",
                valid.ddl.replace("\"B\", \"A\"", "\"B\", \"B\""),
                valid.ddl.replace("\"V\", \"ID\"", "\"V\""),
                valid.ddl.replace("PARENT_OWNER", "OTHER"),
                valid.ddl.replace("ON DELETE CASCADE", "ON DELETE SET NULL"))) {
            Fixture jdbc = new Fixture(); jdbc.ddl = ddl;
            assertTrue(jdbc.request().has("error"), ddl);
        }
    }

    @Test
    void acceptsKnownStateSuffixAndOneTerminalSemicolon() {
        Fixture jdbc = new Fixture();
        jdbc.deleteRule = "NO ACTION";
        jdbc.ddl = jdbc.ddl.replace(" ON DELETE CASCADE ENABLE", " NOT DEFERRABLE INITIALLY IMMEDIATE RELY DISABLE NOVALIDATE;\n");
        JsonObject response = jdbc.request();
        assertFalse(response.has("error"), response.toString());
        assertEquals("NO ACTION", response.getAsJsonArray("result").get(0).getAsJsonObject().get("on_delete").getAsString());
    }

    private static Map<String, String> row(String... values) {
        Map<String, String> result = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) result.put(values[i], values[i + 1]);
        return result;
    }

    private static final class Fixture {
        String ddl = "ALTER TABLE \"APP\".\"SOURCE\" ADD CONSTRAINT \"FK_SOURCE\" FOREIGN KEY (\"B\", \"A\") REFERENCES \"PARENT_OWNER\".\"PARENT\" (\"V\", \"ID\") ON DELETE CASCADE ENABLE";
        String deleteRule = "CASCADE";
        boolean visible = true;
        boolean hasForeignKey = true;
        boolean ddlFailure;
        boolean hiddenFromAll;
        String currentUser = "APP";
        int userCount = 1;
        final List<List<String>> parameters = new ArrayList<>();
        final List<String> queries = new ArrayList<>();

        List<Map<String, String>> rows(String sql) throws SQLException {
            queries.add(sql);
            if (sql.contains("DBMS_METADATA")) {
                if (ddlFailure) throw new SQLException("ORA-01031: insufficient privileges", "42000", 1031);
                return List.of(row("DDL", ddl));
            }
            if (sql.contains("JOIN ALL_CONS_COLUMNS")) {
                return !hasForeignKey ? List.of() : List.of(
                    row("CONSTRAINT_NAME", "FK_SOURCE", "COLUMN_NAME", "B", "TABLE_NAME", "PARENT", "REF_COLUMN", "ID"),
                    row("CONSTRAINT_NAME", "FK_SOURCE", "COLUMN_NAME", "A", "TABLE_NAME", "PARENT", "REF_COLUMN", "V"));
            }
            if (sql.contains("SELECT USER")) {
                List<Map<String, String>> users = new ArrayList<>();
                for (int i = 0; i < userCount; i++) users.add(row("USER", currentUser));
                return users;
            }
            if (sql.contains("USER_CONSTRAINTS")) return !hasForeignKey ? List.of() : List.of(row("CONSTRAINT_NAME", "FK_SOURCE", "R_OWNER", "PARENT_OWNER", "DELETE_RULE", deleteRule));
            if (sql.contains("ALL_CONSTRAINTS")) return !hasForeignKey || hiddenFromAll ? List.of() : List.of(row("CONSTRAINT_NAME", "FK_SOURCE", "R_OWNER", "PARENT_OWNER", "DELETE_RULE", deleteRule));
            if (sql.contains("ALL_TABLES")) return visible ? List.of(row("TABLE_NAME", "SOURCE")) : List.of();
            throw new SQLException("Unexpected query: " + sql);
        }

        JsonObject request() {
            Connection connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
                if (method.getName().equals("isClosed")) return false;
                if (!method.getName().equals("prepareStatement")) throw new UnsupportedOperationException(method.getName());
                String sql = (String) args[0];
                List<String> bound = new ArrayList<>(); parameters.add(bound);
                return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{PreparedStatement.class}, (statement, call, values) -> {
                    if (call.getName().equals("setString")) { bound.add((String) values[1]); return null; }
                    if (call.getName().equals("close")) return null;
                    if (!call.getName().equals("executeQuery")) throw new UnsupportedOperationException(call.getName());
                    List<Map<String, String>> data = rows(sql);
                    int[] index = {-1};
                    return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{ResultSet.class}, (result, read, arguments) -> switch (read.getName()) {
                        case "next" -> ++index[0] < data.size();
                        case "getString" -> arguments[0] instanceof Integer n ? new ArrayList<>(data.get(index[0]).values()).get(n - 1) : data.get(index[0]).get((String) arguments[0]);
                        case "close" -> null;
                        default -> throw new UnsupportedOperationException(read.getName());
                    });
                });
            });
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            TestSupport.setPrivateConnection(agent, connection);
            JsonRpcServer server = new JsonRpcServer(agent);
            return JsonParser.parseString(server.handleRequest("{\"id\":1,\"method\":\"list_foreign_keys\",\"params\":{\"schema\":\"APP\",\"table\":\"SOURCE\"}}")).getAsJsonObject();
        }
    }
}
