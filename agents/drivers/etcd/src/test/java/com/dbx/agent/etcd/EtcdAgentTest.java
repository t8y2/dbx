package com.dbx.agent.etcd;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

final class EtcdAgentTest {
    @Test
    void handshakeAdvertisesKvCapability() {
        String response = EtcdAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"handshake\",\"params\":{}}"
        );

        JsonObject result = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("result");

        Assertions.assertEquals(1, result.get("protocolVersion").getAsInt());
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"kv\"")));
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"connect\"")));
    }

    @Test
    void endpointsUseConfiguredListAndScheme() {
        JsonObject connection = JsonParser.parseString(
            "{\"endpoints\":\"etcd-1:2379,https://etcd-2:2379\",\"ssl\":true}"
        ).getAsJsonObject();

        Assertions.assertEquals(
            List.of("https://etcd-1:2379", "https://etcd-2:2379"),
            EtcdAgent.endpoints(connection)
        );
    }

    @Test
    void endpointsFallbackToHostPort() {
        JsonObject connection = JsonParser.parseString(
            "{\"host\":\"127.0.0.1\",\"port\":2379}"
        ).getAsJsonObject();

        Assertions.assertEquals(List.of("http://127.0.0.1:2379"), EtcdAgent.endpoints(connection));
    }

    @Test
    void kvMethodDispatchReturnsJsonRpcErrorWhenDisconnected() {
        String response = EtcdAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"kv_get\",\"params\":{\"key\":\"/app/name\"}}"
        );

        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");

        Assertions.assertEquals(-1, error.get("code").getAsInt());
        Assertions.assertEquals("Not connected", error.get("message").getAsString());
    }
}
