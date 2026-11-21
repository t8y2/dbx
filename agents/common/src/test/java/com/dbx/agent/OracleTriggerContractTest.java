package com.dbx.agent;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class OracleTriggerContractTest {
    private final Gson gson = new Gson();
    private static final String TRIGGER = """
        {"name":" Trigger ","event":"INSERT","timing":"BEFORE EACH ROW","enabled":true,"valid":false,
         "oracle_metadata":{"contractVersion":1,"identityMode":"exact","engine":"oceanbase-oracle",
          "engineVersion":"4.2.5.7_107","owner":" Owner ","name":" Trigger ","scope":"VIEW",
          "parent":{"owner":" Other Owner ","name":" View ","objectType":"VIEW","objectId":"42"},
          "objectId":"9007199254740993","reads":{"identity":{"state":"available"}}}}
        """;

    @Test
    void retainsExactMetadataAndIndependentValidity() {
        JsonObject value = gson.toJsonTree(gson.fromJson(TRIGGER, TriggerInfo.class)).getAsJsonObject();
        assertTrue(value.get("enabled").getAsBoolean());
        assertFalse(value.get("valid").getAsBoolean());
        JsonObject metadata = value.getAsJsonObject("oracle_metadata");
        assertEquals(" Owner ", metadata.get("owner").getAsString());
        assertEquals(" Other Owner ", metadata.getAsJsonObject("parent").get("owner").getAsString());
        assertEquals("9007199254740993", metadata.get("objectId").getAsString());
    }

    @Test
    void summaryAndSourceKeepTheSameTriggerWithoutInventingAParent() {
        JsonObject trigger = JsonParser.parseString(TRIGGER).getAsJsonObject();
        JsonObject metadata = trigger.getAsJsonObject("oracle_metadata");
        metadata.addProperty("scope", "SCHEMA");
        metadata.remove("parent");
        JsonObject input = JsonParser.parseString("{\"name\":\" Trigger \",\"object_type\":\"TRIGGER\",\"schema\":\" Owner \",\"source\":\"TRIGGER declaration\"}").getAsJsonObject();
        input.add("trigger", trigger);
        JsonObject source = gson.toJsonTree(gson.fromJson(input, ObjectSource.class)).getAsJsonObject();
        JsonObject summary = gson.toJsonTree(gson.fromJson(input, ObjectInfo.class)).getAsJsonObject();
        assertEquals(trigger, source.get("trigger"));
        assertEquals(trigger, summary.get("trigger"));
        assertFalse(source.getAsJsonObject("trigger").getAsJsonObject("oracle_metadata").has("parent"));
    }

    @Test
    void legacyThreeColumnPayloadDoesNotClaimExactSupportOrDefaultState() {
        TriggerInfo trigger = gson.fromJson("{\"name\":\"T\",\"event\":\"INSERT\",\"timing\":\"BEFORE\"}", TriggerInfo.class);
        JsonObject value = gson.toJsonTree(trigger).getAsJsonObject();
        assertFalse(value.has("enabled"));
        assertFalse(value.has("valid"));
        assertFalse(value.has("oracle_metadata"));
    }

    @Test
    void rpcSelectsExactOverloadsWithoutChangingLegacyArityOrRawArguments() throws Exception {
        List<Object[]> calls = new ArrayList<>();
        DatabaseAgent agent = (DatabaseAgent) Proxy.newProxyInstance(DatabaseAgent.class.getClassLoader(),
            new Class<?>[]{DatabaseAgent.class}, (object, method, args) -> {
                if (method.getName().equals("supportsQueryTiming") || method.getName().equals("permitsAutomaticReconnect")) return false;
                if (List.of("listObjects", "getObjectSource", "listTriggers").contains(method.getName())) {
                    calls.add(args);
                    return method.getName().equals("getObjectSource") ? new ObjectSource() : List.of();
                }
                return null;
            });
        JsonRpcServer server = new JsonRpcServer(agent);
        for (String method : List.of(AgentProtocol.METHOD_LIST_OBJECTS, AgentProtocol.METHOD_GET_OBJECT_SOURCE, AgentProtocol.METHOD_LIST_TRIGGERS)) {
            JsonObject params = JsonParser.parseString("{\"schema\":\" Owner \",\"table\":\" Parent \",\"name\":\" Trigger \",\"object_type\":\"TRIGGER\"}").getAsJsonObject();
            server.dispatchForRuntime(method, params);
            params.addProperty("identity_mode", "exact");
            server.dispatchForRuntime(method, params);
            Object[] legacy = calls.get(calls.size() - 2);
            Object[] exact = calls.get(calls.size() - 1);
            assertEquals(legacy.length + 1, exact.length, method);
            assertEquals(" Owner ", exact[0]);
            if (method.equals(AgentProtocol.METHOD_LIST_TRIGGERS)) assertEquals(" Parent ", exact[1]);
            if (method.equals(AgentProtocol.METHOD_GET_OBJECT_SOURCE)) assertEquals(" Trigger ", exact[1]);
        }
    }
}
