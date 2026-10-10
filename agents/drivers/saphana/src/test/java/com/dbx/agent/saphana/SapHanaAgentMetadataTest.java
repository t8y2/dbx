package com.dbx.agent.saphana;

import com.dbx.agent.CompletionAssistantCandidateKind;
import com.dbx.agent.CompletionAssistantObjectKind;
import com.dbx.agent.CompletionAssistantRequest;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.TestSupport;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SapHanaAgentMetadataTest {
    @Test
    void listsAllHanaViewTypesAndClassifiesThemAsViews() {
        List<TableInfo> tables = metadataAgent().listTables("_SYS_BIC");

        assertEquals(6, tables.size());
        assertEquals(5, tables.stream().filter(table -> "VIEW".equals(table.getTable_type())).count());
        assertEquals(1, tables.stream().filter(table -> "TABLE".equals(table.getTable_type())).count());
    }

    @Test
    void viewOnlyObjectListingIncludesModeledViews() {
        var objects = metadataAgent().listObjects("_SYS_BIC", new MetadataListConstraints(null, null, null, List.of("VIEW")));

        assertEquals(5, objects.size());
        assertTrue(objects.stream().allMatch(object -> "VIEW".equals(object.getObject_type())));
        assertTrue(objects.stream().allMatch(object -> "_SYS_BIC".equals(object.getSchema())));
    }

    @Test
    void viewCompletionIncludesModeledViewsWithoutTables() throws ReflectiveOperationException {
        CompletionAssistantRequest request = new CompletionAssistantRequest();
        var schemaField = CompletionAssistantRequest.class.getDeclaredField("schema");
        schemaField.setAccessible(true);
        schemaField.set(request, "_SYS_BIC");
        var kindsField = CompletionAssistantRequest.class.getDeclaredField("object_kinds");
        kindsField.setAccessible(true);
        kindsField.set(request, List.of(CompletionAssistantObjectKind.VIEW));
        var result = metadataAgent().completionAssistantSearch(request);

        assertEquals(5, result.getCandidates().size());
        assertTrue(result.getCandidates().stream().allMatch(candidate -> candidate.getKind() == CompletionAssistantCandidateKind.VIEW));
    }

    private static SapHanaAgent metadataAgent() {
        DatabaseMetaData meta = proxy(DatabaseMetaData.class, (method, args) -> {
            switch (method.getName()) {
                case "getSearchStringEscape":
                    return "\\";
                case "getTableTypes":
                    return rows(List.of("TABLE", "VIEW", "CALC VIEW", "JOIN VIEW", "OLAP VIEW", "HIERARCHY VIEW", "SYNONYM")
                        .stream().map(type -> Map.of("TABLE_TYPE", type)).toList());
                case "getTables":
                    // Preserve JDBC type filtering: excluded types must never appear in this fixture's result.
                    assertTrue(List.of("_SYS_BIC", "\\_SYS\\_BIC").contains(args[1]));
                    List<String> requested = Arrays.asList((String[]) args[3]);
                    assertTrue(!requested.contains("SYNONYM"));
                    return rows(List.of("TABLE", "VIEW", "CALC VIEW", "JOIN VIEW", "OLAP VIEW", "HIERARCHY VIEW")
                        .stream().filter(requested::contains)
                        .map(type -> Map.of("TABLE_NAME", "package/" + type.replace(' ', '_'), "TABLE_TYPE", type)).toList());
                case "getProcedures":
                case "getFunctions":
                    return rows(List.of());
                default:
                    return defaultValue(method.getReturnType());
            }
        });
        Connection conn = proxy(Connection.class, (method, args) -> {
            if ("getMetaData".equals(method.getName())) return meta;
            return defaultValue(method.getReturnType());
        });
        SapHanaAgent agent = new SapHanaAgent();
        TestSupport.setPrivateConnection(agent, conn);
        return agent;
    }

    private static ResultSet rows(List<Map<String, String>> values) {
        AtomicInteger index = new AtomicInteger(-1);
        return proxy(ResultSet.class, (method, args) -> {
            if ("next".equals(method.getName())) return index.incrementAndGet() < values.size();
            if ("getString".equals(method.getName())) return values.get(index.get()).get(args[0]);
            return defaultValue(method.getReturnType());
        });
    }

    private static <T> T proxy(Class<T> type, Handler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type },
            (proxy, method, args) -> handler.handle(method, args)));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }

    private interface Handler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
