package com.dbx.agent.dameng;

import com.dbx.agent.AgentProtocol;
import com.dbx.agent.AgentRpcTestSupport;
import com.dbx.agent.CompletionAssistantCandidate;
import com.dbx.agent.CompletionAssistantCandidateKind;
import com.dbx.agent.CompletionAssistantResponse;
import com.dbx.agent.test.TestSupport;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

class DamengAgentCompletionAssistantTest {
    private static final Gson GSON = new Gson();

    @Test
    void scopedTableSearchMatchesLowercasePrefixAndUsesSingleBoundedQuery() {
        DamengAgent agent = new DamengAgent();
        List<QueryRecord> queries = new ArrayList<>();
        List<Map<String, Object>> catalogObjects = List.of(
            tableRow("YJ1235", "SYS_USER", "TABLE", "System users"),
            tableRow("YJ1235", "SYS_ROLE", "TABLE", "System roles"),
            tableRow("YJ1235", "SYS_ACTIVE_V", "VIEW", "Active users view"),
            tableRow("YJ1235", "MTAB$_SYS_INTERNAL", "TABLE", "Internal"),
            tableRow("OTHER", "SYS_USER", "TABLE", "Other schema")
        );
        TestSupport.setPrivateConnection(agent, catalogConnection(queries, catalogObjects, List.of(), List.of("YJ1235", "OTHER"), null));

        CompletionAssistantResponse response = invokeRpc(agent, """
            {
              "database": "",
              "schema": "YJ1235",
              "parent_schema": "YJ1235",
              "object_kinds": ["table", "view"],
              "mask": "sys_",
              "case_sensitive": false,
              "global_search": false,
              "max_results": 20,
              "match_mode": "prefix"
            }
            """);

        Assertions.assertFalse(response.getFallback_used());
        Assertions.assertFalse(response.getIncomplete());
        Assertions.assertEquals(
            List.of("SYS_ACTIVE_V", "SYS_ROLE", "SYS_USER"),
            response.getCandidates().stream().map(CompletionAssistantCandidate::getName).toList()
        );
        Assertions.assertEquals(CompletionAssistantCandidateKind.VIEW, response.getCandidates().get(0).getKind());
        Assertions.assertEquals("YJ1235", response.getCandidates().get(2).getSchema());
        Assertions.assertEquals("System users", response.getCandidates().get(2).getComment());
        Assertions.assertEquals(1, queries.size(), queries.toString());
        Assertions.assertTrue(queries.get(0).sql.contains("FROM ALL_OBJECTS o"), queries.get(0).sql);
        Assertions.assertTrue(queries.get(0).sql.contains("LIMIT ?"), queries.get(0).sql);
        Assertions.assertFalse(queries.get(0).sql.contains("SYS.SYSOBJECTS"), queries.get(0).sql);
        Assertions.assertFalse(queries.get(0).sql.contains("DBA_OBJECTS"), queries.get(0).sql);
    }

    @Test
    void scopedTableSearchResolvesUnquotedLowercaseSchemaAndMarksIncompleteWhenTruncated() {
        DamengAgent agent = new DamengAgent();
        List<QueryRecord> queries = new ArrayList<>();
        List<Map<String, Object>> catalogObjects = List.of(
            tableRow("YJ1235", "SYS_AUDIT", "TABLE", null),
            tableRow("YJ1235", "SYS_ROLE", "TABLE", null),
            tableRow("YJ1235", "SYS_USER", "TABLE", null)
        );
        TestSupport.setPrivateConnection(agent, catalogConnection(queries, catalogObjects, List.of(), List.of("YJ1235"), null));

        CompletionAssistantResponse response = invokeRpc(agent, """
            {
              "database": "",
              "schema": "yj1235",
              "parent_schema": "yj1235",
              "object_kinds": ["table", "view"],
              "mask": "sys",
              "case_sensitive": false,
              "global_search": false,
              "max_results": 2,
              "match_mode": "prefix"
            }
            """);

        Assertions.assertTrue(response.getIncomplete());
        Assertions.assertEquals(
            List.of("SYS_AUDIT", "SYS_ROLE"),
            response.getCandidates().stream().map(CompletionAssistantCandidate::getName).toList()
        );
        Assertions.assertEquals(2, queries.size(), queries.toString());
        Assertions.assertEquals("yj1235", queries.get(0).args.get(0));
        Assertions.assertEquals("YJ1235", queries.get(1).args.get(0));
    }

    @Test
    void scopedTableSearchSupportsContainsMatchMode() {
        DamengAgent agent = new DamengAgent();
        List<QueryRecord> queries = new ArrayList<>();
        List<Map<String, Object>> catalogObjects = List.of(
            tableRow("YJ1235", "BIZ_USER_INFO", "TABLE", null),
            tableRow("YJ1235", "SYS_ROLE", "TABLE", null)
        );
        TestSupport.setPrivateConnection(agent, catalogConnection(queries, catalogObjects, List.of(), List.of("YJ1235"), null));

        CompletionAssistantResponse response = invokeRpc(agent, """
            {
              "database": "",
              "schema": "YJ1235",
              "parent_schema": "YJ1235",
              "object_kinds": ["table"],
              "mask": "user",
              "case_sensitive": false,
              "global_search": false,
              "max_results": 20,
              "match_mode": "contains"
            }
            """);

        Assertions.assertEquals(
            List.of("BIZ_USER_INFO"),
            response.getCandidates().stream().map(CompletionAssistantCandidate::getName).toList()
        );
    }

    @Test
    void columnSearchReturnsLowercaseColumnsFromSingleFastQueryWithoutDdlOrPkQueries() {
        DamengAgent agent = new DamengAgent();
        List<QueryRecord> queries = new ArrayList<>();
        List<Map<String, Object>> catalogColumns = List.of(
            columnRow("YJ1235", "SYS_USER", 1, "id", "VARCHAR", null, 7, 144, 36, "C", "Primary key"),
            columnRow("YJ1235", "SYS_USER", 2, "account", "VARCHAR", null, 7, 120, 30, "C", "Login account"),
            columnRow("YJ1235", "SYS_USER", 3, "name", "VARCHAR", null, 7, 200, 50, "C", null)
        );
        TestSupport.setPrivateConnection(agent, catalogConnection(queries, List.of(), catalogColumns, List.of("YJ1235"), null));

        CompletionAssistantResponse response = invokeRpc(agent, """
            {
              "database": "",
              "schema": "YJ1235",
              "parent_schema": "YJ1235",
              "parent_name": "SYS_USER",
              "object_kinds": ["column"],
              "mask": "",
              "case_sensitive": false,
              "max_results": 500,
              "match_mode": "prefix"
            }
            """);

        Assertions.assertFalse(response.getFallback_used());
        Assertions.assertFalse(response.getIncomplete());
        Assertions.assertEquals(
            List.of("id", "account", "name"),
            response.getCandidates().stream().map(CompletionAssistantCandidate::getName).toList()
        );
        CompletionAssistantCandidate id = response.getCandidates().get(0);
        Assertions.assertEquals("YJ1235", id.getParent_schema());
        Assertions.assertEquals("SYS_USER", id.getParent_name());
        Assertions.assertEquals("VARCHAR(36 CHAR)", id.getData_type());
        Assertions.assertEquals("Primary key", id.getComment());
        Assertions.assertEquals(1, queries.size(), queries.toString());
        Assertions.assertTrue(queries.get(0).sql.contains("FROM ALL_TAB_COLUMNS c"), queries.get(0).sql);
        Assertions.assertFalse(queries.get(0).sql.contains("ALL_CONS_COLUMNS"), queries.get(0).sql);
        Assertions.assertFalse(queries.get(0).sql.contains("DBMS_METADATA"), queries.get(0).sql);
        Assertions.assertFalse(queries.get(0).sql.contains("SYS.SYSCOLUMNS"), queries.get(0).sql);
    }

    @Test
    void columnSearchResolvesUnquotedIdentifiersCaseInsensitivelyAndRespectsQuotedExactMode() {
        DamengAgent agent = new DamengAgent();
        List<QueryRecord> queries = new ArrayList<>();
        List<Map<String, Object>> catalogColumns = List.of(
            columnRow("YJ1235", "sys_user", 1, "id", "VARCHAR", null, 7, 144, 36, "C", null),
            columnRow("YJ1235", "SYS_DEPT", 1, "dept_id", "BIGINT", null, null, 8, null, null, null)
        );
        TestSupport.setPrivateConnection(agent, catalogConnection(queries, List.of(), catalogColumns, List.of("YJ1235"), null));

        // Unquoted SYS_USER resolves to lowercase sys_user on CASE_SENSITIVE=0 instances.
        CompletionAssistantResponse lowerTable = invokeDirect(agent, """
            {
              "database": "",
              "schema": "YJ1235",
              "parent_schema": "YJ1235",
              "parent_name": "SYS_USER",
              "object_kinds": ["column"],
              "mask": "",
              "case_sensitive": false,
              "max_results": 500,
              "match_mode": "prefix"
            }
            """);
        Assertions.assertEquals(List.of("id"), lowerTable.getCandidates().stream().map(CompletionAssistantCandidate::getName).toList());
        Assertions.assertEquals("sys_user", lowerTable.getCandidates().get(0).getParent_name());

        // Unquoted lowercase sys_dept resolves to uppercase SYS_DEPT via the indexed upper retry.
        CompletionAssistantResponse upperTable = invokeDirect(agent, """
            {
              "database": "",
              "schema": "yj1235",
              "parent_schema": "yj1235",
              "parent_name": "sys_dept",
              "object_kinds": ["column"],
              "mask": "",
              "case_sensitive": false,
              "max_results": 500,
              "match_mode": "prefix"
            }
            """);
        Assertions.assertEquals(List.of("dept_id"), upperTable.getCandidates().stream().map(CompletionAssistantCandidate::getName).toList());
        Assertions.assertEquals("SYS_DEPT", upperTable.getCandidates().get(0).getParent_name());

        // Quoted identifier stays strictly case-sensitive and must not match lowercase sys_user.
        CompletionAssistantResponse quotedMiss = invokeDirect(agent, """
            {
              "database": "",
              "schema": "YJ1235",
              "parent_schema": "YJ1235",
              "parent_name": "SYS_USER",
              "object_kinds": ["column"],
              "mask": "",
              "case_sensitive": true,
              "max_results": 500,
              "match_mode": "prefix"
            }
            """);
        Assertions.assertTrue(quotedMiss.getCandidates().isEmpty());
    }

    @Test
    void columnSearchRefusesAmbiguousCaseInsensitiveTableMatch() {
        DamengAgent agent = new DamengAgent();
        List<Map<String, Object>> catalogColumns = List.of(
            columnRow("YJ1235", "sys_user", 1, "lower_id", "BIGINT", null, null, 8, null, null, null),
            columnRow("YJ1235", "Sys_User", 1, "mixed_id", "BIGINT", null, null, 8, null, null, null)
        );
        TestSupport.setPrivateConnection(agent, catalogConnection(new ArrayList<>(), List.of(), catalogColumns, List.of("YJ1235"), null));

        CompletionAssistantResponse response = invokeRpc(agent, """
            {
              "database": "",
              "schema": "YJ1235",
              "parent_schema": "YJ1235",
              "parent_name": "SYS_USER",
              "object_kinds": ["column"],
              "mask": "",
              "case_sensitive": false,
              "max_results": 500,
              "match_mode": "prefix"
            }
            """);

        Assertions.assertTrue(response.getCandidates().isEmpty());
    }

    @Test
    void schemaSearchFiltersByMaskAndReportsIncomplete() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(
            agent,
            catalogConnection(new ArrayList<>(), List.of(), List.of(), List.of("APP", "YJ1235", "YJ9999"), null)
        );

        CompletionAssistantResponse response = invokeRpc(agent, """
            {
              "database": "",
              "object_kinds": ["schema"],
              "mask": "yj",
              "case_sensitive": false,
              "max_results": 1,
              "match_mode": "prefix"
            }
            """);

        Assertions.assertTrue(response.getIncomplete());
        Assertions.assertEquals(1, response.getCandidates().size());
        Assertions.assertEquals("YJ1235", response.getCandidates().get(0).getName());
        Assertions.assertEquals(CompletionAssistantCandidateKind.SCHEMA, response.getCandidates().get(0).getKind());
    }

    @Test
    void dictionaryUnavailableAndLegacyModeDegradeToJdbcMetadata() throws Exception {
        DamengAgent permissionDeniedAgent = new DamengAgent();
        SQLException denied = new SQLException("没有表或视图[ALL_OBJECTS]的查询权限", "42501", -5669);
        TestSupport.setPrivateConnection(
            permissionDeniedAgent,
            catalogConnection(
                new ArrayList<>(),
                List.of(tableRow("YJ1235", "SYS_USER", "TABLE", "Fallback table")),
                List.of(),
                List.of("YJ1235"),
                denied
            )
        );

        CompletionAssistantResponse degraded = invokeRpc(permissionDeniedAgent, """
            {
              "database": "",
              "schema": "YJ1235",
              "parent_schema": "YJ1235",
              "object_kinds": ["table"],
              "mask": "sys",
              "case_sensitive": false,
              "max_results": 20,
              "match_mode": "prefix"
            }
            """);
        Assertions.assertEquals(List.of("SYS_USER"), degraded.getCandidates().stream().map(CompletionAssistantCandidate::getName).toList());

        DamengAgent legacyAgent = new DamengAgent();
        List<QueryRecord> legacyQueries = new ArrayList<>();
        TestSupport.setPrivateConnection(
            legacyAgent,
            catalogConnection(
                legacyQueries,
                List.of(tableRow("YJ1235", "SYS_USER", "TABLE", "Legacy table")),
                List.of(),
                List.of("YJ1235"),
                null
            )
        );
        Field field = DamengAgent.class.getDeclaredField("legacyJdbcMetadata");
        field.setAccessible(true);
        field.setBoolean(legacyAgent, true);

        CompletionAssistantResponse legacy = invokeRpc(legacyAgent, """
            {
              "database": "",
              "schema": "YJ1235",
              "parent_schema": "YJ1235",
              "object_kinds": ["table"],
              "mask": "sys",
              "case_sensitive": false,
              "max_results": 20,
              "match_mode": "prefix"
            }
            """);
        Assertions.assertEquals(List.of("SYS_USER"), legacy.getCandidates().stream().map(CompletionAssistantCandidate::getName).toList());
        Assertions.assertTrue(legacyQueries.isEmpty(), legacyQueries.toString());
    }

    private static CompletionAssistantResponse invokeRpc(DamengAgent agent, String paramsJson) {
        JsonObject request = new JsonObject();
        request.addProperty("id", 1);
        request.addProperty("method", AgentProtocol.METHOD_COMPLETION_ASSISTANT_SEARCH_V1);
        request.add("params", JsonParser.parseString(paramsJson));
        JsonObject response = JsonParser.parseString(AgentRpcTestSupport.handleRequest(agent, request.toString())).getAsJsonObject();
        Assertions.assertFalse(response.has("error"), response.toString());
        return GSON.fromJson(response.get("result"), CompletionAssistantResponse.class);
    }

    private static CompletionAssistantResponse invokeDirect(DamengAgent agent, String paramsJson) {
        com.dbx.agent.CompletionAssistantRequest request = GSON.fromJson(paramsJson, com.dbx.agent.CompletionAssistantRequest.class);
        return agent.completionAssistantSearch(request);
    }

    private static Map<String, Object> tableRow(String owner, String name, String type, String comments) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("OWNER", owner);
        row.put("TABLE_NAME", name);
        row.put("TABLE_TYPE", type);
        row.put("COMMENTS", comments);
        return row;
    }

    private static Map<String, Object> columnRow(
        String owner,
        String table,
        int columnId,
        String name,
        String dataType,
        Integer precision,
        Integer scale,
        Integer dataLength,
        Integer charLength,
        String charUsed,
        String comments
    ) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("OWNER", owner);
        row.put("TABLE_NAME", table);
        row.put("COLUMN_ID", columnId);
        row.put("COLUMN_NAME", name);
        row.put("DATA_TYPE", dataType);
        row.put("DATA_PRECISION", precision);
        row.put("DATA_SCALE", scale);
        row.put("DATA_LENGTH", dataLength);
        row.put("CHAR_LENGTH", charLength);
        row.put("CHAR_USED", charUsed);
        row.put("COMMENTS", comments);
        return row;
    }

    private static Connection catalogConnection(
        List<QueryRecord> queries,
        List<Map<String, Object>> tables,
        List<Map<String, Object>> columns,
        List<String> schemas,
        SQLException dictionaryError
    ) {
        DatabaseMetaData meta = proxy(DatabaseMetaData.class, (method, args) -> switch (method.getName()) {
            case "getSearchStringEscape" -> "\\";
            case "getSchemas" -> resultSet(schemas.stream().map(s -> Map.<String, Object>of("TABLE_SCHEM", s)).toList());
            case "getTables" -> {
                String schemaPattern = (String) args[1];
                String tablePattern = (String) args[2];
                List<Map<String, Object>> matched = new ArrayList<>();
                for (Map<String, Object> row : tables) {
                    String owner = (String) row.get("OWNER");
                    String name = (String) row.get("TABLE_NAME");
                    if (schemaPattern != null && !schemaPattern.equals(owner)) continue;
                    if (tablePattern != null && !matchesSqlLike(name, tablePattern, '\\', false)) continue;
                    Map<String, Object> jdbcRow = new LinkedHashMap<>();
                    jdbcRow.put("TABLE_CAT", null);
                    jdbcRow.put("TABLE_SCHEM", owner);
                    jdbcRow.put("TABLE_NAME", name);
                    jdbcRow.put("TABLE_TYPE", row.get("TABLE_TYPE"));
                    jdbcRow.put("REMARKS", row.get("COMMENTS"));
                    matched.add(jdbcRow);
                }
                yield resultSet(matched);
            }
            case "getColumns" -> {
                String schemaPattern = (String) args[1];
                String tablePattern = (String) args[2];
                List<Map<String, Object>> matched = new ArrayList<>();
                for (Map<String, Object> row : columns) {
                    if (schemaPattern != null && !schemaPattern.equals(row.get("OWNER"))) continue;
                    if (tablePattern != null && !tablePattern.equals(row.get("TABLE_NAME"))) continue;
                    Map<String, Object> jdbcRow = new LinkedHashMap<>();
                    jdbcRow.put("TABLE_CAT", null);
                    jdbcRow.put("TABLE_SCHEM", row.get("OWNER"));
                    jdbcRow.put("TABLE_NAME", row.get("TABLE_NAME"));
                    jdbcRow.put("COLUMN_NAME", row.get("COLUMN_NAME"));
                    jdbcRow.put("TYPE_NAME", row.get("DATA_TYPE"));
                    jdbcRow.put("REMARKS", row.get("COMMENTS"));
                    matched.add(jdbcRow);
                }
                yield resultSet(matched);
            }
            default -> defaultValue(method.getReturnType());
        });

        return proxy(Connection.class, (method, args) -> switch (method.getName()) {
            case "isClosed" -> false;
            case "getMetaData" -> meta;
            case "createStatement" -> proxy(Statement.class, (stmtMethod, stmtArgs) -> {
                if ("executeQuery".equals(stmtMethod.getName())) {
                    String sql = (String) stmtArgs[0];
                    if (sql.contains("SYS.SYSOBJECTS") && sql.contains("TYPE$ = 'SCH'")) {
                        return resultSet(schemas.stream().map(s -> Map.<String, Object>of("NAME", s)).toList());
                    }
                    if (sql.contains("CURRENT_SCHEMA")) {
                        return resultSet(List.of(Map.of("CURRENT_SCHEMA", schemas.isEmpty() ? "" : schemas.get(0))));
                    }
                    return resultSet(List.of());
                }
                return defaultValue(stmtMethod.getReturnType());
            });
            case "prepareStatement" -> {
                String sql = (String) args[0];
                List<Object> bound = new ArrayList<>();
                yield proxy(PreparedStatement.class, (stmtMethod, stmtArgs) -> switch (stmtMethod.getName()) {
                    case "setString", "setInt", "setObject" -> {
                        int index = (Integer) stmtArgs[0];
                        while (bound.size() < index) bound.add(null);
                        bound.set(index - 1, stmtArgs[1]);
                        yield null;
                    }
                    case "executeQuery" -> {
                        queries.add(new QueryRecord(sql, List.copyOf(bound)));
                        if (dictionaryError != null && (sql.contains("ALL_OBJECTS") || sql.contains("ALL_TAB_COLUMNS"))) {
                            throw dictionaryError;
                        }
                        if (sql.contains("SYS.SYSOBJECTS") && sql.contains("TYPE$ = 'SCH'")) {
                            yield resultSet(schemas.stream().map(s -> Map.<String, Object>of("NAME", s)).toList());
                        }
                        if (sql.contains("FROM ALL_OBJECTS")) {
                            yield resultSet(filterTables(sql, bound, tables));
                        }
                        if (sql.contains("DISTINCT c.OWNER, c.TABLE_NAME")) {
                            yield resultSet(filterDistinctColumnTargets(bound, columns));
                        }
                        if (sql.contains("FROM ALL_TAB_COLUMNS")) {
                            yield resultSet(filterColumns(sql, bound, columns));
                        }
                        yield resultSet(List.of());
                    }
                    default -> defaultValue(stmtMethod.getReturnType());
                });
            }
            default -> defaultValue(method.getReturnType());
        });
    }

    private static List<Map<String, Object>> filterTables(String sql, List<Object> bound, List<Map<String, Object>> tables) {
        int argIndex = 0;
        boolean caseInsensitiveOwner = sql.contains("UPPER(o.OWNER) = UPPER(?)");
        boolean exactOwner = !caseInsensitiveOwner && sql.contains("o.OWNER = ?");
        String ownerArg = (caseInsensitiveOwner || exactOwner) ? String.valueOf(bound.get(argIndex++)) : null;

        List<String> allowedTypes = new ArrayList<>();
        int inStart = sql.indexOf("o.OBJECT_TYPE IN (");
        if (inStart >= 0) {
            int inEnd = sql.indexOf(')', inStart);
            String placeholders = sql.substring(inStart, inEnd);
            long count = placeholders.chars().filter(ch -> ch == '?').count();
            for (int i = 0; i < count; i++) {
                allowedTypes.add(String.valueOf(bound.get(argIndex++)));
            }
        }

        boolean hasMask = sql.contains("LIKE ? ESCAPE '~'");
        boolean caseSensitiveMask = hasMask && !sql.contains("UPPER(o.OBJECT_NAME) LIKE ? ESCAPE '~'");
        String maskPattern = hasMask ? String.valueOf(bound.get(argIndex++)) : null;

        int limit = ((Number) bound.get(bound.size() - 1)).intValue();
        List<Map<String, Object>> matched = new ArrayList<>();
        for (Map<String, Object> row : tables) {
            String owner = (String) row.get("OWNER");
            String name = (String) row.get("TABLE_NAME");
            String type = (String) row.get("TABLE_TYPE");
            if (ownerArg != null) {
                boolean ownerOk = caseInsensitiveOwner ? owner.equalsIgnoreCase(ownerArg) : owner.equals(ownerArg);
                if (!ownerOk) continue;
            }
            if (!allowedTypes.isEmpty() && !allowedTypes.contains(type)) continue;
            if ("TABLE".equals(type) && name.startsWith("MTAB$_")) continue;
            if (maskPattern != null && !matchesSqlLike(name, maskPattern, '~', caseSensitiveMask)) continue;
            matched.add(row);
        }
        matched.sort((a, b) -> {
            int cmp = String.valueOf(a.get("TABLE_NAME")).compareTo(String.valueOf(b.get("TABLE_NAME")));
            return cmp != 0 ? cmp : String.valueOf(a.get("OWNER")).compareTo(String.valueOf(b.get("OWNER")));
        });
        return matched.size() > limit ? matched.subList(0, limit) : matched;
    }

    private static List<Map<String, Object>> filterColumns(String sql, List<Object> bound, List<Map<String, Object>> columns) {
        String ownerArg = String.valueOf(bound.get(0));
        String tableArg = String.valueOf(bound.get(1));
        boolean hasMask = sql.contains("LIKE ? ESCAPE '~'");
        boolean caseSensitiveMask = hasMask && !sql.contains("UPPER(c.COLUMN_NAME) LIKE ? ESCAPE '~'");
        String maskPattern = hasMask ? String.valueOf(bound.get(2)) : null;
        int limit = ((Number) bound.get(bound.size() - 1)).intValue();
        List<Map<String, Object>> matched = new ArrayList<>();
        for (Map<String, Object> row : columns) {
            if (!ownerArg.equals(row.get("OWNER")) || !tableArg.equals(row.get("TABLE_NAME"))) continue;
            String colName = (String) row.get("COLUMN_NAME");
            if (maskPattern != null && !matchesSqlLike(colName, maskPattern, '~', caseSensitiveMask)) continue;
            matched.add(row);
        }
        matched.sort((a, b) -> Integer.compare((Integer) a.get("COLUMN_ID"), (Integer) b.get("COLUMN_ID")));
        return matched.size() > limit ? matched.subList(0, limit) : matched;
    }

    private static List<Map<String, Object>> filterDistinctColumnTargets(List<Object> bound, List<Map<String, Object>> columns) {
        String ownerArg = String.valueOf(bound.get(0));
        String tableArg = String.valueOf(bound.get(1));
        Map<String, Map<String, Object>> unique = new LinkedHashMap<>();
        for (Map<String, Object> row : columns) {
            String owner = (String) row.get("OWNER");
            String table = (String) row.get("TABLE_NAME");
            if (owner.equalsIgnoreCase(ownerArg) && table.equalsIgnoreCase(tableArg)) {
                unique.putIfAbsent(owner + "\0" + table, Map.of("OWNER", owner, "TABLE_NAME", table));
            }
        }
        List<Map<String, Object>> result = new ArrayList<>(unique.values());
        return result.size() > 2 ? result.subList(0, 2) : result;
    }

    private static boolean matchesSqlLike(String value, String pattern, char escape, boolean caseSensitive) {
        String text = caseSensitive ? value : value.toUpperCase(Locale.ROOT);
        String pat = caseSensitive ? pattern : pattern.toUpperCase(Locale.ROOT);
        StringBuilder regex = new StringBuilder("^");
        for (int i = 0; i < pat.length(); i++) {
            char ch = pat.charAt(i);
            if (ch == escape && i + 1 < pat.length()) {
                regex.append(java.util.regex.Pattern.quote(String.valueOf(pat.charAt(++i))));
            } else if (ch == '%') {
                regex.append(".*");
            } else if (ch == '_') {
                regex.append(".");
            } else {
                regex.append(java.util.regex.Pattern.quote(String.valueOf(ch)));
            }
        }
        regex.append("$");
        return text.matches(regex.toString());
    }

    private static ResultSet resultSet(List<Map<String, Object>> rows) {
        int[] index = { -1 };
        return proxy(ResultSet.class, (method, args) -> {
            String name = method.getName();
            if ("next".equals(name)) {
                index[0] += 1;
                return index[0] < rows.size();
            }
            if ("getString".equals(name)) {
                Object value = columnValue(rows.get(index[0]), args[0]);
                return value == null ? null : value.toString();
            }
            if ("getObject".equals(name)) {
                return columnValue(rows.get(index[0]), args[0]);
            }
            if ("getInt".equals(name)) {
                Object value = columnValue(rows.get(index[0]), args[0]);
                return value instanceof Number number ? number.intValue() : 0;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Object columnValue(Map<String, Object> row, Object columnRef) {
        if (columnRef instanceof Integer columnIndex) {
            List<Object> values = new ArrayList<>(row.values());
            return values.get(columnIndex - 1);
        }
        return row.get(String.valueOf(columnRef));
    }

    private record QueryRecord(String sql, List<Object> args) {}

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = (proxy, method, args) -> handler.handle(method, args);
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type }, invocationHandler);
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) return false;
        if (Integer.TYPE.equals(type)) return 0;
        if (Long.TYPE.equals(type)) return 0L;
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
