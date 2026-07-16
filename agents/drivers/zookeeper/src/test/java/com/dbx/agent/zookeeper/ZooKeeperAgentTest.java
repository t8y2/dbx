package com.dbx.agent.zookeeper;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.apache.curator.framework.CuratorFramework;
import org.apache.curator.framework.CuratorFrameworkFactory;
import org.apache.curator.retry.ExponentialBackoffRetry;
import org.apache.curator.test.TestingServer;
import org.apache.zookeeper.CreateMode;
import org.apache.zookeeper.ZooDefs;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

final class ZooKeeperAgentTest {
    @AfterEach
    void disconnect() {
        ZooKeeperAgent.handleRequest("{\"jsonrpc\":\"2.0\",\"id\":999,\"method\":\"disconnect\",\"params\":{}}");
    }

    @Test
    void handshakeAdvertisesKvCapability() {
        String response = ZooKeeperAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"handshake\",\"params\":{}}"
        );

        JsonObject result = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("result");

        Assertions.assertEquals(1, result.get("protocolVersion").getAsInt());
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"kv\"")));
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"connect\"")));
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"test_connection\"")));
    }

    @Test
    void kvMethodDispatchReturnsJsonRpcErrorWhenDisconnected() {
        String response = ZooKeeperAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"kv_get\",\"params\":{\"key\":\"/app/name\"}}"
        );

        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");

        Assertions.assertEquals(-1, error.get("code").getAsInt());
        Assertions.assertEquals("Not connected", error.get("message").getAsString());
    }

    @Test
    void unknownMethodReturnsJsonRpcError() {
        String response = ZooKeeperAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"missing_method\",\"params\":{}}"
        );

        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");

        Assertions.assertEquals(-1, error.get("code").getAsInt());
        Assertions.assertEquals("Unknown method: missing_method", error.get("message").getAsString());
    }

    @Test
    void connectStringUsesConfiguredValuesAndHostPortFallback() {
        Assertions.assertEquals(
            "zk-1:2181,zk-2:2181",
            ZooKeeperAgent.connectString(
                JsonParser.parseString("{\"connect_string\":\"zk-1:2181,zk-2:2181\"}").getAsJsonObject()
            )
        );
        Assertions.assertEquals(
            "zk-main:2181",
            ZooKeeperAgent.connectString(
                JsonParser.parseString("{\"zookeeper_connect_string\":\"zk-main:2181\"}").getAsJsonObject()
            )
        );
        Assertions.assertEquals(
            "127.0.0.1:2181",
            ZooKeeperAgent.connectString(JsonParser.parseString("{}").getAsJsonObject())
        );
        Assertions.assertEquals(
            "zk.local:2281",
            ZooKeeperAgent.connectString(JsonParser.parseString("{\"host\":\"zk.local\",\"port\":2281}").getAsJsonObject())
        );
    }

    @Test
    void buildClientRejectsTlsOptionsUntilTlsIsSupported() {
        JsonObject connection = JsonParser.parseString(
            "{\"ssl\":true,\"ca_cert_path\":\"ca.pem\",\"client_cert_path\":\"client.pem\",\"client_key_path\":\"client.key\"}"
        ).getAsJsonObject();

        IllegalArgumentException error = Assertions.assertThrows(
            IllegalArgumentException.class,
            () -> ZooKeeperAgent.buildClient(connection)
        );

        Assertions.assertEquals("ZooKeeper TLS is not supported", error.getMessage());
    }

    @Test
    void normalizePathStandardizesPublicPaths() {
        Assertions.assertEquals("/", ZooKeeperAgent.normalizePath(""));
        Assertions.assertEquals("/", ZooKeeperAgent.normalizePath("/"));
        Assertions.assertEquals("/app", ZooKeeperAgent.normalizePath("app"));
        Assertions.assertEquals("/app", ZooKeeperAgent.normalizePath("/app/"));
        Assertions.assertEquals("/app/name", ZooKeeperAgent.normalizePath("/app/name"));
    }

    @Test
    void statLookupConcurrencyUsesConservativeDefaultsAndOverrides() {
        Assertions.assertEquals(16, ZooKeeperAgent.configuredStatLookupConcurrency(null, null));
        Assertions.assertEquals(20, ZooKeeperAgent.configuredStatLookupConcurrency("20", "12"));
        Assertions.assertEquals(12, ZooKeeperAgent.configuredStatLookupConcurrency(null, "12"));
        Assertions.assertEquals(1, ZooKeeperAgent.configuredStatLookupConcurrency("0", null));
        Assertions.assertEquals(64, ZooKeeperAgent.configuredStatLookupConcurrency("128", null));
        Assertions.assertEquals(16, ZooKeeperAgent.configuredStatLookupConcurrency("not-a-number", null));
    }

    @Test
    void connectAndTestConnectionWorkAgainstTestingServer() throws Exception {
        try (TestingServer server = new TestingServer()) {
            JsonObject connect = result(request(
                1,
                "connect",
                "{\"connection\":{\"connect_string\":\"" + server.getConnectString() + "\"}}"
            ));
            Assertions.assertTrue(connect.get("ok").getAsBoolean());

            JsonObject test = result(request(
                2,
                "test_connection",
                "{\"connection\":{\"connect_string\":\"" + server.getConnectString() + "\"}}"
            ));
            Assertions.assertTrue(test.get("ok").getAsBoolean());
        }
    }

    @Test
    void connectFailsFastWhenAllServersAreUnreachable() {
        long startedAt = System.nanoTime();
        JsonObject error = error(request(
            1,
            "connect",
            "{\"connection\":{\"connect_string\":\"127.0.0.1:1\",\"connection_timeout_ms\":15000}}"
        ));
        long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000;

        Assertions.assertTrue(
            error.get("message").getAsString().contains("No reachable ZooKeeper server"),
            "expected fast unreachable error, got: " + error.get("message").getAsString()
        );
        Assertions.assertTrue(elapsedMs < 4000, "expected fast failure, took " + elapsedMs + "ms");
    }

    @Test
    void connectUsesReachableServerWithoutDroppingEnsembleMembers() throws Exception {
        try (TestingServer server = new TestingServer()) {
            JsonObject connect = result(request(
                1,
                "connect",
                "{\"connection\":{\"connect_string\":\"127.0.0.1:1," + server.getConnectString() + "\"}}"
            ));
            Assertions.assertTrue(connect.get("ok").getAsBoolean());

            JsonObject get = result(request(2, "kv_get", "{\"key\":\"/\"}"));
            Assertions.assertTrue(get.get("found").getAsBoolean());
        }
    }

    @Test
    void reachableConnectStringPreservesFullEnsembleAndChroot() throws Exception {
        try (TestingServer server = new TestingServer()) {
            String alive = server.getConnectString();
            String ensemble = "127.0.0.1:1," + alive + "/app";

            Assertions.assertEquals(
                ensemble,
                ZooKeeperAgent.reachableConnectString(ensemble, 1000)
            );
            Assertions.assertEquals(alive, ZooKeeperAgent.reachableConnectString(alive, 1000));

            IllegalStateException error = Assertions.assertThrows(
                IllegalStateException.class,
                () -> ZooKeeperAgent.reachableConnectString("127.0.0.1:1/app", 1000)
            );
            Assertions.assertTrue(error.getMessage().contains("No reachable ZooKeeper server"));
        }
    }

    @Test
    void testConnectionDoesNotReplaceActiveClient() throws Exception {
        try (TestingServer active = new TestingServer(); TestingServer probe = new TestingServer()) {
            result(request(1, "connect", "{\"connection\":{\"connect_string\":\"" + active.getConnectString() + "\"}}"));
            result(request(
                2,
                "kv_put",
                "{\"key\":\"/active\",\"value\":{\"encoding\":\"utf8\",\"data\":\"still-here\"}}"
            ));

            result(request(3, "test_connection", "{\"connection\":{\"connect_string\":\"" + probe.getConnectString() + "\"}}"));

            JsonObject get = result(request(4, "kv_get", "{\"key\":\"/active\"}"));
            Assertions.assertTrue(get.get("found").getAsBoolean());
            Assertions.assertEquals("still-here", get.getAsJsonObject("value").get("data").getAsString());
        }
    }

    @Test
    void kvPutCreatesMissingParentsAndGetReadsUtf8Value() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject put = result(request(
                2,
                "kv_put",
                "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"
            ));
            Assertions.assertTrue(put.has("version"));

            JsonObject get = result(request(3, "kv_get", "{\"key\":\"/app/name\"}"));

            Assertions.assertTrue(get.get("found").getAsBoolean());
            Assertions.assertEquals("utf8", get.getAsJsonObject("value").get("encoding").getAsString());
            Assertions.assertEquals("dbx", get.getAsJsonObject("value").get("data").getAsString());
            JsonObject metadata = get.getAsJsonObject("metadata");
            Assertions.assertEquals(0, metadata.get("numChildren").getAsInt());
            Assertions.assertEquals(metadata.get("czxid").getAsLong(), metadata.get("createRevision").getAsLong());
            Assertions.assertEquals(metadata.get("mzxid").getAsLong(), metadata.get("modRevision").getAsLong());
            Assertions.assertEquals(metadata.get("dataLength").getAsInt(), metadata.get("valueSize").getAsInt());
        }
    }

    @Test
    void kvGetReadsZnodeCreatedWithoutDataAsEmptyUtf8() throws Exception {
        try (TestingServer server = new TestingServer();
             CuratorFramework curator = CuratorFrameworkFactory.newClient(
                 server.getConnectString(),
                 new ExponentialBackoffRetry(100, 3)
            )) {
            curator.start();
            curator.getZookeeperClient().getZooKeeper().create(
                "/empty",
                null,
                ZooDefs.Ids.OPEN_ACL_UNSAFE,
                CreateMode.PERSISTENT
            );
            connect(server);

            JsonObject get = result(request(3, "kv_get", "{\"key\":\"/empty\"}"));

            Assertions.assertTrue(get.get("found").getAsBoolean());
            Assertions.assertEquals("utf8", get.getAsJsonObject("value").get("encoding").getAsString());
            Assertions.assertEquals("", get.getAsJsonObject("value").get("data").getAsString());
            Assertions.assertEquals(0, get.getAsJsonObject("metadata").get("valueSize").getAsInt());
        }
    }

    @Test
    void kvPutUpdatesExistingZnode() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            result(request(2, "kv_put", "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"));
            result(request(
                3,
                "kv_put",
                "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx-updated\"}}"
            ));

            JsonObject value = result(request(4, "kv_get", "{\"key\":\"/app/name\"}")).getAsJsonObject("value");
            Assertions.assertEquals("dbx-updated", value.get("data").getAsString());
        }
    }

    @Test
    void kvPutCreatePersistentCreatesOnlyMissingZnode() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject created = result(request(
                2,
                "kv_put",
                "{\"key\":\"/app/created\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"},"
                    + "\"writeMode\":\"create\",\"createMode\":\"persistent\"}"
            ));
            JsonObject get = result(request(3, "kv_get", "{\"key\":\"/app/created\"}"));
            JsonObject duplicate = error(request(
                4,
                "kv_put",
                "{\"key\":\"/app/created\",\"value\":{\"encoding\":\"utf8\",\"data\":\"again\"},"
                    + "\"writeMode\":\"create\",\"createMode\":\"persistent\"}"
            ));

            Assertions.assertEquals("/app/created", requiredString(created, "key"));
            Assertions.assertEquals("/app/created", requiredString(created, "createdKey"));
            Assertions.assertEquals("dbx", get.getAsJsonObject("value").get("data").getAsString());
            Assertions.assertTrue(duplicate.get("message").getAsString().contains("NodeExists"));
        }
    }

    @Test
    void kvPutCreateEphemeralCreatesEphemeralZnode() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject created = result(request(
                2,
                "kv_put",
                "{\"key\":\"/session/node\",\"value\":{\"encoding\":\"utf8\",\"data\":\"temporary\"},"
                    + "\"writeMode\":\"create\",\"createMode\":\"ephemeral\"}"
            ));
            JsonObject get = result(request(3, "kv_get", "{\"key\":\"/session/node\"}"));

            Assertions.assertEquals("/session/node", requiredString(created, "createdKey"));
            Assertions.assertEquals("temporary", get.getAsJsonObject("value").get("data").getAsString());
            Assertions.assertTrue(get.getAsJsonObject("metadata").get("ephemeralOwner").getAsLong() > 0);
        }
    }

    @Test
    void kvPutCreatePersistentSequentialReturnsGeneratedPath() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject created = result(request(
                2,
                "kv_put",
                "{\"key\":\"/jobs/job-\",\"value\":{\"encoding\":\"utf8\",\"data\":\"one\"},"
                    + "\"writeMode\":\"create\",\"createMode\":\"persistent_sequential\"}"
            ));
            String createdKey = requiredString(created, "createdKey");
            JsonObject get = result(request(3, "kv_get", "{\"key\":\"" + createdKey + "\"}"));

            Assertions.assertEquals(createdKey, requiredString(created, "key"));
            Assertions.assertTrue(createdKey.startsWith("/jobs/job-"));
            Assertions.assertTrue(createdKey.length() > "/jobs/job-".length());
            Assertions.assertEquals("one", get.getAsJsonObject("value").get("data").getAsString());
            Assertions.assertEquals(0, get.getAsJsonObject("metadata").get("ephemeralOwner").getAsLong());
        }
    }

    @Test
    void kvPutCreateEphemeralSequentialReturnsGeneratedEphemeralPath() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject created = result(request(
                2,
                "kv_put",
                "{\"key\":\"/sessions/member-\",\"value\":{\"encoding\":\"utf8\",\"data\":\"online\"},"
                    + "\"writeMode\":\"create\",\"createMode\":\"ephemeral_sequential\"}"
            ));
            String createdKey = requiredString(created, "createdKey");
            JsonObject get = result(request(3, "kv_get", "{\"key\":\"" + createdKey + "\"}"));

            Assertions.assertEquals(createdKey, requiredString(created, "key"));
            Assertions.assertTrue(createdKey.startsWith("/sessions/member-"));
            Assertions.assertEquals("online", get.getAsJsonObject("value").get("data").getAsString());
            Assertions.assertTrue(get.getAsJsonObject("metadata").get("ephemeralOwner").getAsLong() > 0);
        }
    }

    @Test
    void kvPutUpdateOnlyUpdatesExistingZnode() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject missing = error(request(
                2,
                "kv_put",
                "{\"key\":\"/app/missing\",\"value\":{\"encoding\":\"utf8\",\"data\":\"x\"},\"writeMode\":\"update\"}"
            ));
            result(request(
                3,
                "kv_put",
                "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"before\"},\"writeMode\":\"create\"}"
            ));
            JsonObject updated = result(request(
                4,
                "kv_put",
                "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"after\"},\"writeMode\":\"update\"}"
            ));
            JsonObject value = result(request(5, "kv_get", "{\"key\":\"/app/name\"}")).getAsJsonObject("value");

            Assertions.assertTrue(missing.get("message").getAsString().contains("NoNode"));
            Assertions.assertTrue(updated.get("version").getAsInt() > 0);
            Assertions.assertEquals("after", value.get("data").getAsString());
        }
    }

    @Test
    void kvGetReturnsBase64ForBinaryData() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            result(request(2, "kv_put", "{\"key\":\"/bin\",\"value\":{\"encoding\":\"base64\",\"data\":\"/wAB\"}}"));

            JsonObject value = result(request(3, "kv_get", "{\"key\":\"/bin\"}")).getAsJsonObject("value");
            Assertions.assertEquals("base64", value.get("encoding").getAsString());
            Assertions.assertEquals("/wAB", value.get("data").getAsString());
        }
    }

    @Test
    void kvPutRejectsRootZnode() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject error = error(request(
                2,
                "kv_put",
                "{\"key\":\"/\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"
            ));

            Assertions.assertEquals("Root znode cannot be modified", error.get("message").getAsString());
        }
    }

    @Test
    void kvDeleteReturnsZeroForMissingZnode() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject delete = result(request(4, "kv_delete", "{\"key\":\"/missing\"}"));

            Assertions.assertEquals(0, delete.get("deleted").getAsInt());
        }
    }

    @Test
    void kvDeleteRemovesLeafZnode() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/leaf\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"));

            JsonObject delete = result(request(3, "kv_delete", "{\"key\":\"/leaf\"}"));
            JsonObject get = result(request(4, "kv_get", "{\"key\":\"/leaf\"}"));

            Assertions.assertEquals(1, delete.get("deleted").getAsInt());
            Assertions.assertFalse(get.get("found").getAsBoolean());
        }
    }

    @Test
    void kvDeleteRejectsNonRecursiveDeleteOfNonEmptyZnode() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"));

            JsonObject error = error(request(3, "kv_delete", "{\"key\":\"/app\"}"));

            Assertions.assertTrue(error.get("message").getAsString().contains("not empty"));
        }
    }

    @Test
    void kvDeleteRecursiveDeletesFullSubtreeAndCountsZnodes() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"));
            result(request(3, "kv_put", "{\"key\":\"/app/config\",\"value\":{\"encoding\":\"utf8\",\"data\":\"cfg\"}}"));

            JsonObject delete = result(request(4, "kv_delete", "{\"key\":\"/app\",\"recursive\":true}"));
            JsonObject get = result(request(5, "kv_get", "{\"key\":\"/app/name\"}"));

            Assertions.assertEquals(3, delete.get("deleted").getAsInt());
            Assertions.assertFalse(get.get("found").getAsBoolean());
        }
    }

    @Test
    void kvDeleteRejectsRootZnode() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject error = error(request(2, "kv_delete", "{\"key\":\"/\",\"recursive\":true}"));

            Assertions.assertEquals("Root znode cannot be deleted", error.get("message").getAsString());
        }
    }

    @Test
    void listPrefixListsDirectChildrenOfRootWhenRecursiveIsFalse() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"));
            result(request(3, "kv_put", "{\"key\":\"/config\",\"value\":{\"encoding\":\"utf8\",\"data\":\"cfg\"}}"));

            JsonObject list = result(request(5, "kv_list_prefix", "{\"prefix\":\"/\",\"recursive\":false}"));

            Assertions.assertEquals(List.of("/app", "/config", "/zookeeper"), listedKeys(list));
            Assertions.assertTrue(list.get("continuation").isJsonNull());
        }
    }

    @Test
    void listPrefixKeepsDirectChildMetadataForLazyExpansion() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"));
            result(request(3, "kv_put", "{\"key\":\"/config\",\"value\":{\"encoding\":\"utf8\",\"data\":\"cfg\"}}"));

            JsonObject list = result(request(5, "kv_list_prefix", "{\"prefix\":\"/\",\"recursive\":false}"));
            JsonObject app = listedRow(list, "/app");
            JsonObject config = listedRow(list, "/config");

            Assertions.assertEquals(1, app.get("numChildren").getAsInt());
            Assertions.assertEquals(0, config.get("numChildren").getAsInt());
            Assertions.assertEquals(3, config.get("dataLength").getAsInt());
        }
    }

    @Test
    void listPrefixDefaultsToRecursiveForDbxKvBrowser() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"));
            result(request(3, "kv_put", "{\"key\":\"/config\",\"value\":{\"encoding\":\"utf8\",\"data\":\"cfg\"}}"));

            JsonObject list = result(request(5, "kv_list_prefix", "{\"prefix\":\"/\"}"));

            Assertions.assertEquals(
                List.of("/app", "/app/name", "/config", "/zookeeper", "/zookeeper/config", "/zookeeper/quota"),
                listedKeys(list)
            );
            Assertions.assertTrue(list.get("continuation").isJsonNull());
        }
    }

    @Test
    void listPrefixListsRecursiveDescendantsOfRoot() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/app/name\",\"value\":{\"encoding\":\"utf8\",\"data\":\"dbx\"}}"));
            result(request(3, "kv_put", "{\"key\":\"/config\",\"value\":{\"encoding\":\"utf8\",\"data\":\"cfg\"}}"));

            JsonObject list = result(request(6, "kv_list_prefix", "{\"prefix\":\"/\",\"recursive\":true}"));

            Assertions.assertEquals(
                List.of("/app", "/app/name", "/config", "/zookeeper", "/zookeeper/config", "/zookeeper/quota"),
                listedKeys(list)
            );
        }
    }

    @Test
    void listPrefixReturnsEmptyResultForMissingPrefix() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);

            JsonObject list = result(request(7, "kv_list_prefix", "{\"prefix\":\"/missing\"}"));

            Assertions.assertEquals(List.of(), listedKeys(list));
            Assertions.assertTrue(list.get("continuation").isJsonNull());
        }
    }

    @Test
    void listPrefixPaginatesBySortedPath() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/c\",\"value\":{\"encoding\":\"utf8\",\"data\":\"c\"}}"));
            result(request(3, "kv_put", "{\"key\":\"/a\",\"value\":{\"encoding\":\"utf8\",\"data\":\"a\"}}"));
            result(request(4, "kv_put", "{\"key\":\"/b\",\"value\":{\"encoding\":\"utf8\",\"data\":\"b\"}}"));

            JsonObject first = result(request(5, "kv_list_prefix", "{\"prefix\":\"/\",\"limit\":2}"));
            String continuation = first.get("continuation").getAsString();
            JsonObject second = result(request(
                6,
                "kv_list_prefix",
                "{\"prefix\":\"/\",\"limit\":2,\"continuation\":\"" + continuation + "\"}"
            ));
            String secondContinuation = second.get("continuation").getAsString();
            JsonObject third = result(request(
                7,
                "kv_list_prefix",
                "{\"prefix\":\"/\",\"limit\":2,\"continuation\":\"" + secondContinuation + "\"}"
            ));

            Assertions.assertEquals(List.of("/a", "/b"), listedKeys(first));
            Assertions.assertFalse(continuation.isBlank());
            Assertions.assertEquals(List.of("/c", "/zookeeper"), listedKeys(second));
            Assertions.assertFalse(secondContinuation.isBlank());
            Assertions.assertEquals(List.of("/zookeeper/config", "/zookeeper/quota"), listedKeys(third));
            Assertions.assertTrue(third.get("continuation").isJsonNull());
        }
    }

    @Test
    void listPrefixPaginatesDirectChildrenWhenRecursiveIsFalse() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/app/c/deep\",\"value\":{\"encoding\":\"utf8\",\"data\":\"c\"}}"));
            result(request(3, "kv_put", "{\"key\":\"/app/a/deep\",\"value\":{\"encoding\":\"utf8\",\"data\":\"a\"}}"));
            result(request(4, "kv_put", "{\"key\":\"/app/b/deep\",\"value\":{\"encoding\":\"utf8\",\"data\":\"b\"}}"));

            JsonObject first = result(request(5, "kv_list_prefix", "{\"prefix\":\"/app\",\"recursive\":false,\"limit\":2}"));
            String continuation = first.get("continuation").getAsString();
            JsonObject second = result(request(
                6,
                "kv_list_prefix",
                "{\"prefix\":\"/app\",\"recursive\":false,\"limit\":2,\"continuation\":\"" + continuation + "\"}"
            ));

            Assertions.assertEquals(List.of("/app/a", "/app/b"), listedKeys(first));
            Assertions.assertFalse(continuation.isBlank());
            Assertions.assertEquals(List.of("/app/c"), listedKeys(second));
            Assertions.assertTrue(second.get("continuation").isJsonNull());
        }
    }

    @Test
    void listPrefixRejectsContinuationForDifferentRequest() throws Exception {
        try (TestingServer server = new TestingServer()) {
            connect(server);
            result(request(2, "kv_put", "{\"key\":\"/app/a\",\"value\":{\"encoding\":\"utf8\",\"data\":\"a\"}}"));
            result(request(3, "kv_put", "{\"key\":\"/app/b\",\"value\":{\"encoding\":\"utf8\",\"data\":\"b\"}}"));

            JsonObject first = result(request(4, "kv_list_prefix", "{\"prefix\":\"/app\",\"limit\":1}"));
            String continuation = first.get("continuation").getAsString();
            JsonObject error = error(request(
                5,
                "kv_list_prefix",
                "{\"prefix\":\"/\",\"limit\":1,\"continuation\":\"" + continuation + "\"}"
            ));

            Assertions.assertEquals("Continuation does not match request", error.get("message").getAsString());
        }
    }

    private static JsonObject connect(TestingServer server) {
        return result(request(1, "connect", "{\"connection\":{\"connect_string\":\"" + server.getConnectString() + "\"}}"));
    }

    private static String request(int id, String method, String params) {
        return ZooKeeperAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"method\":\"" + method + "\",\"params\":" + params + "}"
        );
    }

    private static JsonObject result(String response) {
        return JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("result");
    }

    private static JsonObject error(String response) {
        JsonObject object = JsonParser.parseString(response).getAsJsonObject();
        Assertions.assertTrue(object.has("error"), "expected JSON-RPC error but got " + response);
        return object.getAsJsonObject("error");
    }

    private static String requiredString(JsonObject object, String key) {
        Assertions.assertTrue(object.has(key), "expected result to contain " + key);
        return object.get(key).getAsString();
    }

    private static List<String> listedKeys(JsonObject listResult) {
        List<String> keys = new ArrayList<>();
        JsonArray rows = listResult.getAsJsonArray("keys");
        for (JsonElement row : rows) {
            keys.add(row.getAsJsonObject().get("key").getAsString());
        }
        return keys;
    }

    private static JsonObject listedRow(JsonObject listResult, String key) {
        JsonArray rows = listResult.getAsJsonArray("keys");
        for (JsonElement row : rows) {
            JsonObject object = row.getAsJsonObject();
            if (key.equals(object.get("key").getAsString())) {
                return object;
            }
        }
        Assertions.fail("expected listed row for " + key);
        return new JsonObject();
    }
}
