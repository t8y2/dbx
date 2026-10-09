package com.dbx.agent;

import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.lang.reflect.Proxy;
import java.lang.reflect.InvocationHandler;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

class JsonRpcLargeValueTest {
    @Test
    void dispatchesOpaqueLocatorAndCharacterOffsetAndReleasesItWithoutSql() throws Exception {
        List<String> calls = new ArrayList<>();
        DatabaseAgent agent = (DatabaseAgent) Proxy.newProxyInstance(DatabaseAgent.class.getClassLoader(),
            new Class<?>[]{DatabaseAgent.class}, (object, method, args) -> {
                if (method.getName().equals("supportsQueryTiming")) return false;
                if (method.getName().equals("readLargeValueChunk")) {
                    calls.add("read");
                    assertArrayEquals(new Object[]{"opaque-original", 700L, 4096}, args);
                    return Map.of("status", "ok", "data", "中文😀", "next_offset", 703L, "eof", false, "value_kind", "text");
                }
                if (method.getName().equals("releaseLargeValue")) { calls.add("release"); assertEquals("opaque-original", args[0]); return true; }
                return method.isDefault() ? InvocationHandler.invokeDefault(object, method, args) : null;
            });
        JsonRpcServer server = new JsonRpcServer(agent);
        Object result = server.dispatchForRuntime(AgentProtocol.METHOD_READ_LARGE_VALUE_CHUNK,
            JsonParser.parseString("{\"valueRef\":\"opaque-original\",\"offset\":700,\"limit\":4096}").getAsJsonObject());
        assertEquals("中文😀", ((Map<?, ?>) result).get("data"));
        assertEquals(true, server.dispatchForRuntime(AgentProtocol.METHOD_RELEASE_LARGE_VALUE,
            JsonParser.parseString("{\"valueRef\":\"opaque-original\"}").getAsJsonObject()));
        assertEquals(List.of("read", "release"), calls);
    }

    @Test
    void invalidatesLocatorsBeforeTransactionBoundary() throws Exception {
        List<String> calls = new ArrayList<>();
        DatabaseAgent agent = (DatabaseAgent) Proxy.newProxyInstance(DatabaseAgent.class.getClassLoader(),
            new Class<?>[]{DatabaseAgent.class}, (object, method, args) -> {
                if (method.getName().equals("supportsQueryTiming")) return false;
                if (method.getName().equals("invalidateLargeValues")) { calls.add("invalidate"); return null; }
                if (method.getName().equals("commitManualTransaction")) { calls.add("commit"); return Map.of("ok", true); }
                return method.isDefault() ? InvocationHandler.invokeDefault(object, method, args) : null;
            });
        new JsonRpcServer(agent).dispatchForRuntime(AgentProtocol.METHOD_COMMIT_MANUAL_TRANSACTION,
            JsonParser.parseString("{}").getAsJsonObject());
        assertEquals(List.of("invalidate", "commit"), calls);
    }

    @Test
    void invalidatesBeforeFailedWriteAndRollbackAndOnCancellation() throws Exception {
        List<String> calls = new ArrayList<>();
        DatabaseAgent agent = (DatabaseAgent) Proxy.newProxyInstance(DatabaseAgent.class.getClassLoader(),
            new Class<?>[]{DatabaseAgent.class}, (object, method, args) -> {
                if (method.getName().equals("supportsQueryTiming")) return false;
                if (method.getName().equals("invalidateLargeValues")) { calls.add("invalidate"); return null; }
                if (method.getName().equals("executeBatch")) { calls.add("write"); throw new java.sql.SQLException("concurrent row removed"); }
                if (method.getName().equals("rollbackManualTransaction")) { calls.add("rollback"); return Map.of("ok", true); }
                return method.isDefault() ? InvocationHandler.invokeDefault(object, method, args) : null;
            });
        JsonRpcServer server = new JsonRpcServer(agent);
        assertThrows(Exception.class, () -> server.dispatchForRuntime(AgentProtocol.METHOD_EXECUTE_BATCH,
            JsonParser.parseString("{\"statements\":[\"UPDATE T SET C='full original value'\"]}").getAsJsonObject()));
        assertEquals(List.of("invalidate", "write"), calls);
        calls.clear();
        server.dispatchForRuntime(AgentProtocol.METHOD_ROLLBACK_MANUAL_TRANSACTION, JsonParser.parseString("{}").getAsJsonObject());
        assertEquals(List.of("invalidate", "rollback"), calls);
        calls.clear();
        server.cancelActiveStatements();
        assertEquals(List.of("invalidate"), calls);
    }
}
