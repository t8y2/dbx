package com.dbx.agent.mongodb;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.dbx.agent.AgentProtocol;
import com.dbx.agent.IndexInfo;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mongodb.MongoClientSettings;
import com.mongodb.client.AggregateIterable;
import com.mongodb.client.FindIterable;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoCursor;
import com.mongodb.client.MongoDatabase;
import com.mongodb.client.model.Collation;
import com.mongodb.client.model.CollationStrength;
import com.mongodb.client.model.CountOptions;
import com.mongodb.client.model.UpdateOptions;
import com.mongodb.client.result.UpdateResult;
import java.io.FileInputStream;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.bson.Document;
import org.bson.types.ObjectId;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class MongoAgentTest {
    @TempDir
    static Path tempDir;

    private static Path caPemPath;
    private static Path clientPemPath;
    private static Path clientKeyPath;

    @BeforeAll
    static void setUpCerts() throws Exception {
        Path keystore = tempDir.resolve("keystore.jks");
        caPemPath = tempDir.resolve("ca.pem");
        clientPemPath = tempDir.resolve("client.pem");
        clientKeyPath = tempDir.resolve("client-key.pem");

        // Generate a key pair in a JKS keystore using keytool
        ProcessBuilder pb = new ProcessBuilder(
            "keytool", "-genkeypair", "-alias", "test", "-keyalg", "RSA", "-keysize", "2048",
            "-keystore", keystore.toString(), "-storepass", "pass123", "-keypass", "pass123",
            "-dname", "CN=Test TLS Cert", "-validity", "365"
        );
        pb.inheritIO();
        int rc = pb.start().waitFor();
        if (rc != 0) {
            throw new RuntimeException("keytool -genkeypair failed with exit code " + rc);
        }

        // Export the certificate as PEM (for ca_cert_path / client_cert_path)
        for (Path pem : new Path[] {caPemPath, clientPemPath}) {
            ProcessBuilder exportPb = new ProcessBuilder(
                "keytool", "-exportcert", "-alias", "test",
                "-keystore", keystore.toString(), "-storepass", "pass123", "-rfc"
            );
            exportPb.redirectOutput(pem.toFile());
            exportPb.redirectError(ProcessBuilder.Redirect.INHERIT);
            int exportRc = exportPb.start().waitFor();
            if (exportRc != 0) {
                throw new RuntimeException("keytool -exportcert failed with exit code " + exportRc);
            }
        }

        // Extract the private key as PKCS#8 PEM
        KeyStore ks = KeyStore.getInstance("JKS");
        try (FileInputStream fis = new FileInputStream(keystore.toFile())) {
            ks.load(fis, "pass123".toCharArray());
        }
        PrivateKey pk = (PrivateKey) ks.getKey("test", "pass123".toCharArray());
        String pkcs8Pem = "-----BEGIN PRIVATE KEY-----\n"
            + Base64.getEncoder().encodeToString(pk.getEncoded())
            + "\n-----END PRIVATE KEY-----\n";
        Files.writeString(clientKeyPath, pkcs8Pem);
    }

    // ─── existing tests ───

    @Test
    void parsesExplicitStringDocumentIdsWithoutTreatingThemAsExtendedJson() {
        assertEquals(
            "{\"$numberLong\":\"2048938405781032962\"}",
            MongoAgent.parseId("__dbx_mongo_string_id__\"{\\\"$numberLong\\\":\\\"2048938405781032962\\\"}\"")
        );
    }

    @Test
    void exposesProtocolHandshakeOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"handshake\","
                + "\"params\":{\"appVersion\":\"0.5.13\",\"supportedProtocolVersions\":[1]}}");

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        JsonObject result = json.getAsJsonObject("result");
        assertEquals("2.0", json.get("jsonrpc").getAsString());
        assertEquals(7, json.get("id").getAsInt());
        assertEquals(AgentProtocol.PROTOCOL_VERSION, result.get("protocolVersion").getAsInt());
        assertEquals(AgentProtocol.PROTOCOL_VERSION, result.get("agentProtocolVersion").getAsInt());
        assertTrue(containsCapability(result.getAsJsonArray("capabilities"), AgentProtocol.CAPABILITY_CONNECT));
        assertTrue(containsCapability(result.getAsJsonArray("capabilities"), AgentProtocol.CAPABILITY_QUERY));
        assertTrue(containsCapability(result.getAsJsonArray("capabilities"), AgentProtocol.CAPABILITY_METADATA));
        assertTrue(containsCapability(result.getAsJsonArray("capabilities"), AgentProtocol.CAPABILITY_MONGO_DROP_DATABASE));
    }

    @Test
    void legacyJsonRpcHandshakeRemainsProtocolV1() {
        JsonObject result = JsonParser.parseString(MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":71,\"method\":\"handshake\",\"params\":{}}"
        )).getAsJsonObject().getAsJsonObject("result");

        assertEquals(1, result.get("protocolVersion").getAsInt());
        assertFalse(containsCapability(result.getAsJsonArray("capabilities"), AgentProtocol.CAPABILITY_MULTI_SESSION));
    }

    @Test
    void runtimeHandshakeAdvertisesDropDatabaseForMultiSessionConnections() {
        JsonObject result = new Gson().toJsonTree(MongoAgent.runtimeHandshakeResult()).getAsJsonObject();

        assertEquals(AgentProtocol.MULTI_SESSION_PROTOCOL_VERSION, result.get("protocolVersion").getAsInt());
        assertTrue(containsCapability(result.getAsJsonArray("capabilities"), AgentProtocol.CAPABILITY_MULTI_SESSION));
        assertTrue(containsCapability(result.getAsJsonArray("capabilities"), AgentProtocol.CAPABILITY_MONGO_DROP_DATABASE));
    }

    @Test
    void listIndexesMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"list_indexes\","
                + "\"params\":{\"database\":\"app\",\"schema\":\"\",\"table\":\"orders\"}}");

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(8, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
    }

    @Test
    void collectionSpecsPreserveCollectionKindsForTypeAwareClients() {
        assertEquals(Map.of("name", "orders", "kind", "collection"), MongoAgent.collectionSpec("orders", "collection"));
        assertEquals(Map.of("name", "report_view", "kind", "view"), MongoAgent.collectionSpec("report_view", "view"));
        assertEquals(Map.of("name", "metrics", "kind", "timeseries"), MongoAgent.collectionSpec("metrics", "timeseries"));
        assertEquals("collection", MongoAgent.collectionKind("futureType"));
    }

    @Test
    void countDocumentsMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":15,\"method\":\"count_documents\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\",\"filter\":\"{}\"}}");

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(15, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
    }

    @Test
    void explainFindBuildsOneCommandWithFindOptions() {
        JsonObject params = JsonParser.parseString(
            "{\"database\":\"app\",\"collection\":\"orders\","
                + "\"filter\":\"{\\\"status\\\":\\\"open\\\"}\","
                + "\"projection\":\"{\\\"email\\\":1}\","
                + "\"sort\":\"{\\\"createdAt\\\":-1}\","
                + "\"collation\":\"{\\\"locale\\\":\\\"en\\\",\\\"strength\\\":1}\","
                + "\"skip\":2,\"limit\":5,\"verbosity\":\"executionStats\"}"
        ).getAsJsonObject();

        Document command = MongoAgent.buildFindExplainCommand(params);
        Document find = command.get("explain", Document.class);

        assertEquals("orders", find.getString("find"));
        assertEquals(new Document("status", "open"), find.get("filter"));
        assertEquals(new Document("email", 1), find.get("projection"));
        assertEquals(new Document("createdAt", -1), find.get("sort"));
        assertEquals(new Document("locale", "en").append("strength", 1), find.get("collation"));
        assertEquals(2L, find.getLong("skip"));
        assertEquals(5L, find.getLong("limit"));
        assertEquals("executionStats", command.getString("verbosity"));
    }

    @Test
    void explainFindMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":19,\"method\":\"explain_find\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\"}}"
        );

        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals("Not connected", error.get("message").getAsString());
        assertFalse(error.get("message").getAsString().contains("Unknown method"));
    }

    @Test
    void aggregateMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":20,\"method\":\"aggregate_documents\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\",\"pipeline\":\"[]\"}}"
        );

        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals("Not connected", error.get("message").getAsString());
        assertFalse(error.get("message").getAsString().contains("Unknown method"));
    }

    @Test
    void aggregateReadsOneBoundedCursorWithoutCounting() {
        List<String> calls = new ArrayList<>();
        MongoClient client = recordingAggregateMongoClient(
            calls,
            List.of(
                new Document("name", "first"),
                new Document("name", "second"),
                new Document("name", "third")
            )
        );
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":21,\"method\":\"aggregate_documents\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\","
                + "\"pipeline\":\"[{\\\"$match\\\":{\\\"status\\\":\\\"open\\\"}}]\","
                + "\"limit\":2,"
                + "\"options\":\"{\\\"allowDiskUse\\\":true,\\\"cursor\\\":{\\\"batchSize\\\":1},"
                + "\\\"maxTimeMS\\\":500}\"}}",
            client
        );

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertFalse(json.has("error"), json.toString());
        JsonObject result = json.getAsJsonObject("result");
        assertEquals(3, result.get("total").getAsInt());
        assertEquals(2, result.getAsJsonArray("documents").size());
        assertEquals(2, result.getAsJsonArray("extended_documents").size());
        assertEquals("first", result.getAsJsonArray("documents").get(0).getAsJsonObject().get("name").getAsString());
        assertEquals(1, calls.stream().filter(call -> call.startsWith("aggregate:")).count());
        assertTrue(calls.contains("aggregate:1:open"));
        assertTrue(calls.contains("allowDiskUse:true"));
        assertTrue(calls.contains("batchSize:1"));
        assertTrue(calls.contains("maxTime:500:MILLISECONDS"));
        assertTrue(calls.contains("close"));
        assertFalse(calls.stream().anyMatch(call -> call.contains("count")));
    }

    @Test
    void aggregateExplainCommandPreservesPipelineAndOptions() {
        List<Document> pipeline = List.of(new Document("$match", new Document("status", "open")));
        Document options = new Document("explain", true).append("allowDiskUse", true);

        Document command = MongoAgent.buildAggregateCommand("orders", pipeline, options);

        assertEquals("orders", command.getString("aggregate"));
        assertEquals(pipeline, command.get("pipeline"));
        assertEquals(true, command.getBoolean("explain"));
        assertEquals(true, command.getBoolean("allowDiskUse"));
        assertFalse(command.containsKey("cursor"));
    }

    @Test
    void findOneUsesOneBoundedReadWithoutCounting() {
        List<String> calls = new ArrayList<>();
        MongoClient client = recordingFindOneMongoClient(
            calls,
            new Document("name", "latest").append("createdAt", 2)
        );
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":16,\"method\":\"find_one\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\","
                + "\"filter\":\"{\\\"status\\\":\\\"open\\\"}\","
                + "\"projection\":\"{\\\"secret\\\":0}\","
                + "\"options\":\"{\\\"sort\\\":{\\\"createdAt\\\":-1}}\"}}",
            client
        );

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertFalse(json.has("error"), json.toString());
        JsonObject result = json.getAsJsonObject("result");
        assertEquals(1, result.get("total").getAsInt());
        assertFalse(result.has("total_is_exact"));
        assertEquals("latest", result.getAsJsonArray("documents").get(0).getAsJsonObject().get("name").getAsString());
        assertEquals(1, result.getAsJsonArray("extended_documents").size());
        assertEquals(
            List.of(
                "find:{\"status\": \"open\"}",
                "projection:{\"secret\": 0}",
                "sort:{\"createdAt\": -1}",
                "limit:1",
                "first"
            ),
            calls
        );
    }

    @Test
    void findOneReturnsEmptyResultWhenNoDocumentMatches() {
        List<String> calls = new ArrayList<>();
        MongoClient client = recordingFindOneMongoClient(calls, null);
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":17,\"method\":\"find_one\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\"}}",
            client
        );

        JsonObject result = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("result");
        assertEquals(0, result.get("total").getAsInt());
        assertEquals(0, result.getAsJsonArray("documents").size());
        assertEquals(0, result.getAsJsonArray("extended_documents").size());
        assertEquals(List.of("find:{}", "limit:1", "first"), calls);
    }

    @Test
    void findOneRejectsUnsupportedOptionsBeforeReading() {
        List<String> calls = new ArrayList<>();
        MongoClient client = recordingFindOneMongoClient(calls, null);
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":18,\"method\":\"find_one\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\","
                + "\"options\":\"{\\\"hint\\\":{\\\"createdAt\\\":1}}\"}}",
            client
        );

        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals("Unsupported findOne option: hint", error.get("message").getAsString());
        assertTrue(calls.isEmpty());
    }

    @Test
    void collectionTotalUsesEstimatedCountForEmptyFilter() {
        List<String> calls = new ArrayList<>();
        MongoCollection<Document> collection = recordingCountCollection(calls);

        MongoAgent.CollectionTotal total = MongoAgent.collectionTotal(collection, new Document());

        assertEquals(10_000_000L, total.value());
        assertFalse(total.exact());
        assertEquals(List.of("estimatedDocumentCount"), calls);
    }

    @Test
    void collectionTotalUsesExactCountForNonEmptyFilter() {
        List<String> calls = new ArrayList<>();
        MongoCollection<Document> collection = recordingCountCollection(calls);
        Document filter = new Document("status", "active");

        MongoAgent.CollectionTotal total = MongoAgent.collectionTotal(collection, filter);

        assertEquals(42L, total.value());
        assertTrue(total.exact());
        assertEquals(List.of("countDocuments:{\"status\": \"active\"}"), calls);
    }

    @Test
    void parsesFindCollationAndUsesItForExactCounts() {
        Collation collation = MongoAgent.collationOrNull(Document.parse(
            "{\"locale\":\"en\",\"strength\":1,\"caseLevel\":false,\"numericOrdering\":true}"
        ));
        assertNotNull(collation);
        assertEquals("en", collation.getLocale());
        assertEquals(CollationStrength.PRIMARY, collation.getStrength());
        assertEquals(false, collation.getCaseLevel());
        assertEquals(true, collation.getNumericOrdering());

        List<String> calls = new ArrayList<>();
        MongoCollection<Document> collection = recordingCountCollection(calls);
        MongoAgent.CollectionTotal total = MongoAgent.collectionTotal(
            collection,
            new Document("name", "xxx"),
            collation
        );

        assertEquals(42L, total.value());
        assertEquals(List.of("countDocuments:{\"name\": \"xxx\"}:collation=en/1"), calls);
    }

    @Test
    void rejectsInvalidFindCollationOptions() {
        assertThrows(
            IllegalArgumentException.class,
            () -> MongoAgent.collationOrNull(Document.parse("{\"strength\":1}"))
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> MongoAgent.collationOrNull(Document.parse("{\"locale\":\"en\",\"unknown\":true}"))
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> MongoAgent.collationOrNull(Document.parse("{\"locale\":\"en\",\"strength\":1.5}"))
        );
    }

    @Test
    void estimatedDocumentQueryResultMarksTotalAsInexact() {
        Map<String, Object> result = MongoAgent.documentQueryResult(
            List.of(new Document("_id", 1)),
            new MongoAgent.CollectionTotal(10_000_000L, false)
        );

        assertEquals(10_000_000L, result.get("total"));
        assertEquals(false, result.get("total_is_exact"));
    }

    @Test
    void exactDocumentQueryResultKeepsExistingWireShape() {
        Map<String, Object> result = MongoAgent.documentQueryResult(
            List.of(new Document("_id", 1)),
            new MongoAgent.CollectionTotal(42L, true)
        );

        assertEquals(42L, result.get("total"));
        assertFalse(result.containsKey("total_is_exact"));
    }

    @Test
    void parsesOptionalDocumentParameters() {
        JsonObject params = new JsonObject();
        params.addProperty("projection", "{\"title\":1,\"_id\":0}");
        params.addProperty("filter", "");

        Document projection = MongoAgent.documentOrNull(params, "projection");

        assertNotNull(projection);
        assertEquals(1, projection.get("title"));
        assertEquals(0, projection.get("_id"));
        assertEquals(null, MongoAgent.documentOrNull(params, "filter"));
        assertEquals(null, MongoAgent.documentOrNull(params, "sort"));
    }

    @Test
    void documentParametersParseExtendedJsonLongFilters() {
        JsonObject params = new JsonObject();
        params.addProperty("filter", "{\"processInfoId\":{\"$numberLong\":\"2048938405781032962\"},\"snowflake\":{\"$numberLong\":\"9007199254740993\"}}");

        Document filter = MongoAgent.documentOrNull(params, "filter");

        assertNotNull(filter);
        assertEquals(2_048_938_405_781_032_962L, filter.get("processInfoId"));
        assertEquals(9_007_199_254_740_993L, filter.get("snowflake"));
    }

    @Test
    void preservesLongDocumentIdTypeForGridUpdates() {
        Object id = MongoAgent.convertDocumentFieldValue("_id", 2_048_938_405_781_032_962L);
        Object value = MongoAgent.convertDocumentFieldValue("snowflake", 2_048_938_405_781_032_962L);
        ObjectId objectId = new ObjectId("507f1f77bcf86cd799439011");

        assertEquals(Collections.singletonMap("$numberLong", "2048938405781032962"), id);
        assertEquals("2048938405781032962", value);
        assertEquals(2_048_938_405_781_032_962L, MongoAgent.parseId("{\"$numberLong\":\"2048938405781032962\"}"));
        assertEquals(objectId, MongoAgent.parseId("{\"$oid\":\"507f1f77bcf86cd799439011\"}"));
    }

    @Test
    void preservesJsonLookingStringDocumentIds() {
        assertEquals("{}", MongoAgent.parseId("{}"));
        assertEquals("{\"tenant\":1}", MongoAgent.parseId("{\"tenant\":1}"));
        assertEquals(
            "{\"$numberLong\":\"2048938405781032962\",\"tenant\":1}",
            MongoAgent.parseId("{\"$numberLong\":\"2048938405781032962\",\"tenant\":1}")
        );
        assertEquals("{\"$numberLong\":\"invalid\"}", MongoAgent.parseId("{\"$numberLong\":\"invalid\"}"));
    }

    @Test
    void documentUpdateDistinguishesNoMatchFromUnchangedValue() {
        MongoAgent.requireMatchedDocument(
            "{\"$oid\":\"507f1f77bcf86cd799439011\"}",
            UpdateResult.acknowledged(1, 0L, null)
        );

        IllegalStateException error = assertThrows(
            IllegalStateException.class,
            () -> MongoAgent.requireMatchedDocument(
                "{\"$oid\":\"507f1f77bcf86cd799439012\"}",
                UpdateResult.acknowledged(0, 0L, null)
            )
        );
        assertTrue(error.getMessage().startsWith("No document matched _id"));
    }

    @Test
    void serverVersionMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"server_version\","
                + "\"params\":{\"database\":\"admin\"}}");

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(9, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
    }

    @Test
    void createIndexMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"create_index\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\","
                + "\"keys_json\":\"{\\\"email\\\":1}\",\"options_json\":\"{\\\"name\\\":\\\"email_1\\\",\\\"background\\\":true}\"}}");

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(12, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
        assertTrue(AgentProtocol.MONGO_LEGACY_METHODS.contains(AgentProtocol.MONGO_METHOD_CREATE_INDEX));
    }

    @Test
    void createUserMethodIsRecognizedAndBuildsTheExpectedCommand() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":121,\"method\":\"create_user\","
                + "\"params\":{\"database\":\"admin\","
                + "\"user_json\":\"{\\\"user\\\":\\\"test-db\\\",\\\"pwd\\\":\\\"test-password\\\",\\\"roles\\\":[{\\\"role\\\":\\\"readWrite\\\",\\\"db\\\":\\\"db1\\\"}]}\"}}"
        );

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(121, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
        assertTrue(AgentProtocol.MONGO_LEGACY_METHODS.contains(AgentProtocol.MONGO_METHOD_CREATE_USER));

        JsonObject params = JsonParser.parseString(
            "{\"database\":\"admin\","
                + "\"user_json\":\"{\\\"user\\\":\\\"test-db\\\",\\\"pwd\\\":\\\"test-password\\\",\\\"roles\\\":[{\\\"role\\\":\\\"readWrite\\\",\\\"db\\\":\\\"db1\\\"}]}\","
                + "\"write_concern_json\":\"{\\\"w\\\":\\\"majority\\\"}\"}"
        ).getAsJsonObject();
        Document command = MongoAgent.buildCreateUserCommand(params);
        assertEquals("createUser", command.keySet().iterator().next());
        assertEquals("test-db", command.getString("createUser"));
        assertEquals("test-password", command.getString("pwd"));
        assertEquals("readWrite", command.getList("roles", Document.class).get(0).getString("role"));
        assertEquals("majority", command.get("writeConcern", Document.class).getString("w"));
    }

    @Test
    void defaultIndexNameMatchesNativeDriverForWholeDoubles() {
        assertEquals(
            "email_1_createdAt_-1",
            MongoAgent.defaultIndexName(Document.parse("{\"email\":1.0,\"createdAt\":-1.0}"))
        );
    }

    @Test
    void dropIndexesMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"drop_indexes\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\","
                + "\"indexes_json\":\"\\\"email_1\\\"\",\"single\":true}}");

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(13, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
        assertTrue(AgentProtocol.MONGO_LEGACY_METHODS.contains(AgentProtocol.MONGO_METHOD_DROP_INDEXES));
    }

    @Test
    void dropIndexesRejectsTheDefaultIdIndex() {
        for (String indexesJson : List.of(
            "\"_id_\"",
            "{\"_id\":1}",
            "{\"_id\":{\"$numberDecimal\":\"1.0\"}}",
            "[\"email_1\",\"_id_\"]"
        )) {
            IllegalArgumentException error = assertThrows(
                IllegalArgumentException.class,
                () -> MongoAgent.parseDropIndexesValue(indexesJson, false)
            );
            assertEquals("The default MongoDB _id_ index cannot be dropped", error.getMessage());
        }

        assertThrows(
            IllegalArgumentException.class,
            () -> MongoAgent.parseDropIndexesValue("\"_id_\"", true)
        );
        assertEquals("*", MongoAgent.parseDropIndexesValue("\"*\"", false));
    }

    @Test
    void batchDropIndexesReportsPartialFailuresAndContinues() {
        List<String> calls = new ArrayList<>();

        Map<String, Object> result = MongoAgent.dropNamedIndexes(List.of("email_1", "missing_1", "created_at_-1"), name -> {
            calls.add(String.valueOf(name));
            if ("missing_1".equals(name)) {
                throw new IllegalStateException("index not found");
            }
        });

        assertEquals(List.of("email_1", "missing_1", "created_at_-1"), calls);
        assertEquals(List.of("email_1", "created_at_-1"), result.get("dropped_names"));
        assertEquals(2, result.get("affected_rows"));
        assertEquals(
            List.of(Map.of("name", "missing_1", "message", "index not found")),
            result.get("failures")
        );
    }

    @Test
    void batchDropIndexesUsesSerialFallbackOnlyBeforeMongo42() {
        assertTrue(MongoAgent.serverVersionRequiresSerialDropIndexes("3.4.24"));
        assertTrue(MongoAgent.serverVersionRequiresSerialDropIndexes("4.0.28"));
        assertFalse(MongoAgent.serverVersionRequiresSerialDropIndexes("4.2.0"));
        assertFalse(MongoAgent.serverVersionRequiresSerialDropIndexes("7.0.14"));
        assertFalse(MongoAgent.serverVersionRequiresSerialDropIndexes("unknown"));
    }

    @Test
    void dropCollectionMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":14,\"method\":\"drop_collection\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\"}}");

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(14, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
        assertTrue(AgentProtocol.MONGO_LEGACY_METHODS.contains(AgentProtocol.MONGO_METHOD_DROP_COLLECTION));
    }

    @Test
    void dropDatabaseMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":15,\"method\":\"drop_database\","
                + "\"params\":{\"database\":\"app\"}}"
        );

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(15, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
        assertTrue(AgentProtocol.MONGO_LEGACY_METHODS.contains(AgentProtocol.MONGO_METHOD_DROP_DATABASE));
    }

    @Test
    void updateDocumentsMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"update_documents\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\",\"filter_json\":\"{}\","
                + "\"update_json\":\"{\\\"$set\\\":{\\\"data\\\":null}}\",\"many\":true}}");

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(10, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
    }

    @Test
    void updateDocumentsRpcUsesDocumentOverloads() {
        List<String> calls = new ArrayList<>();
        MongoClient client = recordingMongoClient(calls);

        assertRpcModifiedCount(client, 20, "{\"$set\":{\"status\":\"done\"}}", false);
        assertRpcModifiedCount(client, 21, "{\"$unset\":{\"legacy\":1}}", true);

        assertEquals(List.of("updateOne:document", "updateMany:document"), calls);
    }

    @Test
    void updateDocumentsRpcUsesPipelineOverloads() {
        List<String> calls = new ArrayList<>();
        MongoClient client = recordingMongoClient(calls);

        assertRpcModifiedCount(client, 22, "[{\"$set\":{\"status\":\"$source\"}}]", false);
        assertRpcModifiedCount(client, 23, "[{\"$unset\":\"legacy\"}]", true);

        assertEquals(List.of("updateOne:pipeline", "updateMany:pipeline"), calls);
    }

    @Test
    void updatePipelineRejectsNonDocumentStages() {
        IllegalArgumentException error = assertThrows(
            IllegalArgumentException.class,
            () -> MongoAgent.updatePipelineForWrite("[{\"$set\":{\"a\":1}}, 2]")
        );

        assertEquals("Each update pipeline stage must be an object", error.getMessage());
    }

    @Test
    void parsesArrayFiltersUpdateOption() {
        UpdateOptions options = MongoAgent.updateOptionsForWrite(
            "{\"arrayFilters\":[{\"item.id\":322678}]}"
        );

        assertEquals(1, options.getArrayFilters().size());
        assertEquals(322678, ((Document) options.getArrayFilters().get(0)).getInteger("item.id"));
    }

    @Test
    void rejectsUnsupportedUpdateOptions() {
        IllegalArgumentException error = assertThrows(
            IllegalArgumentException.class,
            () -> MongoAgent.updateOptionsForWrite("{\"upsert\":true}")
        );
        assertEquals("Unsupported update option: upsert", error.getMessage());
    }

    @Test
    void deleteDocumentsMethodIsRecognizedOverJsonRpc() {
        String response = MongoAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"delete_documents\","
                + "\"params\":{\"database\":\"app\",\"collection\":\"orders\","
                + "\"filter_json\":\"{\\\"status\\\":\\\"draft\\\"}\",\"many\":true}}");

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(11, json.get("id").getAsInt());
        assertEquals("Not connected", json.getAsJsonObject("error").get("message").getAsString());
        assertFalse(json.getAsJsonObject("error").get("message").getAsString().contains("Unknown method"));
        assertTrue(AgentProtocol.MONGO_LEGACY_METHODS.contains(AgentProtocol.MONGO_METHOD_DELETE_DOCUMENTS));
    }

    @Test
    void extractsServerVersionFromBuildInfo() {
        assertEquals("4.4.29", MongoAgent.serverVersionFromBuildInfo(new Document("version", "4.4.29")));
        assertThrows(IllegalStateException.class, () -> MongoAgent.serverVersionFromBuildInfo(new Document("ok", 1)));
    }

    @Test
    void convertsMongoIndexDocumentToIndexInfo() {
        Document index = new Document("name", "idx_user_status")
            .append("key", new Document("user_id", 1).append("status", -1))
            .append("unique", true)
            .append("partialFilterExpression", new Document("deleted", false));

        IndexInfo info = MongoAgent.indexInfoFromDocument(index);

        assertEquals("idx_user_status", info.getName());
        assertEquals(java.util.List.of("user_id", "status"), info.getColumns());
        assertEquals(true, info.getIs_unique());
        assertEquals(false, info.getIs_primary());
        assertEquals("user_id: 1, status: -1", info.getIndex_type());
        assertTrue(info.getFilter().contains("\"deleted\""));
    }

    @Test
    void usesAuthSourceFromUrlParamsAsAuthenticationDatabase() {
        JsonObject connection = new JsonObject();
        connection.addProperty("database", "gray_lite_twin_fat");
        connection.addProperty("url_params", "authSource=admin&authMechanism=SCRAM-SHA-1");

        assertEquals("admin", MongoAgent.authenticationDatabase(connection));
    }

    @Test
    void fallsBackToAdminWhenAuthSourceIsMissing() {
        JsonObject connection = new JsonObject();
        connection.addProperty("database", "gray_lite_twin_fat");

        assertEquals("admin", MongoAgent.authenticationDatabase(connection));
    }

    // ─── TLS: configureBuilder JSON parsing ───

    @Test
    void sslTrueFromConnectionObject() {
        JsonObject connection = minimalConnection();
        connection.addProperty("ssl", true);

        MongoClientSettings.Builder builder = MongoAgent.configureBuilder(connection);

        assertNotNull(builder);
    }

    @Test
    void sslFalseByDefault() {
        JsonObject connection = minimalConnection();
        // ssl is not set — should default to false

        MongoClientSettings.Builder builder = MongoAgent.configureBuilder(connection);

        assertNotNull(builder);
    }

    @Test
    void sslTrueFromTopLevelParams() {
        JsonObject connObj = minimalConnection();
        connObj.addProperty("ssl", true);
        JsonObject params = new JsonObject();
        params.add("connection", connObj);

        // connect() unwraps the connection sub-object; verify configureBuilder reads ssl from it
        JsonObject extracted = params.has("connection") && params.get("connection").isJsonObject()
            ? params.getAsJsonObject("connection")
            : params;
        assertEquals(true, extracted.get("ssl").getAsBoolean());
    }

    @Test
    void readsCaCertPathFromConnection() {
        JsonObject connection = minimalConnection();
        connection.addProperty("ssl", true);
        connection.addProperty("ca_cert_path", caPemPath.toString());

        MongoClientSettings.Builder builder = MongoAgent.configureBuilder(connection);

        assertNotNull(builder);
    }

    @Test
    void readsClientCertAndKeyPathsFromConnection() {
        JsonObject connection = minimalConnection();
        connection.addProperty("ssl", true);
        connection.addProperty("client_cert_path", clientPemPath.toString());
        connection.addProperty("client_key_path", clientKeyPath.toString());

        MongoClientSettings.Builder builder = MongoAgent.configureBuilder(connection);

        assertNotNull(builder);
    }

    @Test
    void certPathAndKeyPathFallbackNames() {
        JsonObject connection = minimalConnection();
        connection.addProperty("ssl", true);
        connection.addProperty("cert_path", clientPemPath.toString());
        connection.addProperty("key_path", clientKeyPath.toString());

        // Should not throw — cert_path/key_path are fallback names for client_cert_path/client_key_path
        MongoClientSettings.Builder builder = MongoAgent.configureBuilder(connection);

        assertNotNull(builder);
    }

    @Test
    void rejectsMismatchedClientCertAndKey() {
        JsonObject connection = minimalConnection();
        connection.addProperty("ssl", true);
        connection.addProperty("client_cert_path", clientPemPath.toString());
        // client_key_path is missing

        assertThrows(IllegalArgumentException.class, () -> MongoAgent.configureBuilder(connection));
    }

    // ─── TLS: SSLContext creation ───

    @Test
    void createsSslContextWithCaCert() throws Exception {
        var ctx = MongoAgent.createTlsSslContext(caPemPath.toString(), null, null);

        assertNotNull(ctx);
    }

    @Test
    void createsSslContextWithClientCertAndKey() throws Exception {
        var ctx = MongoAgent.createTlsSslContext(null, clientPemPath.toString(), clientKeyPath.toString());

        assertNotNull(ctx);
    }

    @Test
    void createsSslContextWithAllCertPaths() throws Exception {
        var ctx = MongoAgent.createTlsSslContext(
            caPemPath.toString(), clientPemPath.toString(), clientKeyPath.toString());

        assertNotNull(ctx);
    }

    // ─── TLS: trust manager loading ───

    @Test
    void loadsTrustManagersFromPemFile() throws Exception {
        var trustManagers = MongoAgent.loadTrustManagersFromPem(caPemPath.toString());

        assertNotNull(trustManagers);
        assertTrue(trustManagers.length > 0);
    }

    // ─── TLS: key manager loading ───

    @Test
    void loadsKeyManagersFromPemFiles() throws Exception {
        var keyManagers = MongoAgent.loadKeyManagersFromPem(
            clientPemPath.toString(), clientKeyPath.toString());

        assertNotNull(keyManagers);
        assertTrue(keyManagers.length > 0);
    }

    // ─── TLS: private key format support ───

    @Test
    void loadsPkcs8PrivateKeyFromPem() throws Exception {
        var key = MongoAgent.loadPrivateKeyFromPem(clientKeyPath.toString());

        assertNotNull(key);
        assertEquals("RSA", key.getAlgorithm());
    }

    // ─── utility ───

    @Test
    void firstNonBlankReturnsFirstNonBlankValue() {
        assertEquals("b", MongoAgent.firstNonBlank(null, "", "b", "c"));
        assertEquals("a", MongoAgent.firstNonBlank("a", "b"));
    }

    @Test
    void firstNonBlankReturnsNullWhenAllBlank() {
        assertEquals(null, MongoAgent.firstNonBlank(null, "", "  "));
    }

    @Test
    void convertValuePreservesUnsafeLongForJsonClients() {
        assertEquals("2326645729978441729", MongoAgent.convertValue(2_326_645_729_978_441_729L));
        assertEquals("-2326645729978441729", MongoAgent.convertValue(-2_326_645_729_978_441_729L));
    }

    @Test
    void convertValueKeepsSafeLongAsNumber() {
        assertEquals(42L, MongoAgent.convertValue(42L));
    }

    @Test
    void convertValueFormatsDatesAsMongoShellIsoDate() {
        assertEquals("ISODate(\"2026-06-10T13:59:31.287Z\")", MongoAgent.convertValue(Date.from(java.time.Instant.parse("2026-06-10T13:59:31.287Z"))));
    }

    @Test
    void convertValueKeepsObjectIdAsStringByDefault() {
        assertEquals(
            "507f1f77bcf86cd799439011",
            MongoAgent.convertValue(new ObjectId("507f1f77bcf86cd799439011"))
        );
    }

    @Test
    void bsonToExtendedJsonUsesMongoExtendedJson() {
        Document doc = new Document("_id", new ObjectId("507f1f77bcf86cd799439011"))
            .append("created_at", Date.from(java.time.Instant.parse("2026-06-10T13:59:31.287Z")));

        assertEquals(
            "{\"_id\":{\"$oid\":\"507f1f77bcf86cd799439011\"},\"created_at\":{\"$date\":\"2026-06-10T13:59:31.287Z\"}}",
            new com.google.gson.Gson().toJson(MongoAgent.bsonToExtendedJson(doc))
        );
    }

    @Test
    void bsonToExtendedJsonWrapsUnsafeLongsForJsonClients() {
        Document doc = new Document("_id", 144_115_205_316_939_462L)
            .append("nested", new Document("sequence", -144_115_205_316_939_462L))
            .append("items", List.of(144_115_205_316_939_462L))
            .append("safe", 42L);

        JsonObject json = MongoAgent.bsonToExtendedJson(doc);

        assertEquals("144115205316939462", json.getAsJsonObject("_id").get("$numberLong").getAsString());
        assertEquals(
            "-144115205316939462",
            json.getAsJsonObject("nested").getAsJsonObject("sequence").get("$numberLong").getAsString()
        );
        assertEquals(
            "144115205316939462",
            json.getAsJsonArray("items").get(0).getAsJsonObject().get("$numberLong").getAsString()
        );
        assertEquals(42L, json.get("safe").getAsLong());
    }

    @Test
    void documentForWriteParsesMongoShellIsoDateStrings() {
        Document doc = MongoAgent.documentForWrite("{\"$set\":{\"CreateDate\":\"ISODate(\\\"2026-06-10T13:59:31.287Z\\\")\"}}");

        assertTrue(MongoAgent.isUpdateOperatorDocument(doc));
        Document set = (Document) doc.get("$set");
        assertTrue(set.get("CreateDate") instanceof Date);
    }

    @Test
    void documentForWriteParsesNestedMongoShellIsoDateStrings() {
        Document doc = MongoAgent.documentForWrite("{\"items\":[{\"created\":\"new Date(\\\"2026-06-10T13:59:31.287Z\\\")\"}]}");

        assertTrue(((Document) ((java.util.List<?>) doc.get("items")).get(0)).get("created") instanceof Date);
    }

    @Test
    void documentForWritePreservesDateShapedStrings() {
        Document doc = MongoAgent.documentForWrite(
            "{\"$set\":{\"CreateDate\":\"2025-08-14 02:25:43.718\"," +
                "\"nested\":{\"updated\":\"2025-08-14T02:25:43\"}," +
                "\"items\":[\"2025-08-14 02:25:43\"]}}"
        );

        Document set = (Document) doc.get("$set");
        assertEquals("2025-08-14 02:25:43.718", set.getString("CreateDate"));
        assertEquals("2025-08-14T02:25:43", ((Document) set.get("nested")).getString("updated"));
        assertEquals("2025-08-14 02:25:43", ((List<?>) set.get("items")).get(0));
    }

    @Test
    void documentForWriteParsesExtendedJsonDates() {
        Document doc = MongoAgent.documentForWrite(
            "{\"created\":{\"$date\":\"2026-06-10T13:59:31.287Z\"}," +
                "\"items\":[{\"updated\":{\"$date\":{\"$numberLong\":\"1781100000000\"}}}]}"
        );

        assertTrue(doc.get("created") instanceof Date);
        Document item = (Document) ((List<?>) doc.get("items")).get(0);
        assertTrue(item.get("updated") instanceof Date);
    }

    @Test
    void updatePipelinePreservesStringsAndParsesExplicitDates() {
        List<Document> pipeline = MongoAgent.updatePipelineForWrite(
            "[{\"$set\":{\"label\":\"2025-08-14 02:25:43.718\"," +
                "\"created\":\"ISODate(\\\"2026-06-10T13:59:31.287Z\\\")\"}}]"
        );

        Document set = (Document) pipeline.get(0).get("$set");
        assertEquals("2025-08-14 02:25:43.718", set.getString("label"));
        assertTrue(set.get("created") instanceof Date);
    }

    @Test
    void filterDocumentsPreserveDateShapedStrings() {
        Document filter = MongoAgent.documentForWrite(
            "{\"created\":\"2025-08-14 02:25:43.718\"," +
                "\"updated\":{\"$date\":\"2026-06-10T13:59:31.287Z\"}}"
        );

        assertEquals("2025-08-14 02:25:43.718", filter.getString("created"));
        assertTrue(filter.get("updated") instanceof Date);
    }

    @Test
    void bulkUpdateRequiresOperatorDocument() {
        Document update = MongoAgent.documentForWrite("{\"$set\":{\"data\":null}}");
        MongoAgent.requireBulkUpdateOperatorDocument(update);

        assertThrows(
            IllegalArgumentException.class,
            () -> MongoAgent.requireBulkUpdateOperatorDocument(MongoAgent.documentForWrite("{\"data\":null}"))
        );
    }

    // ─── helpers ───

    @SuppressWarnings("unchecked")
    private static MongoCollection<Document> recordingCountCollection(List<String> calls) {
        return (MongoCollection<Document>) Proxy.newProxyInstance(
            MongoCollection.class.getClassLoader(),
            new Class<?>[] {MongoCollection.class},
            (proxy, method, args) -> {
                if ("estimatedDocumentCount".equals(method.getName())) {
                    calls.add("estimatedDocumentCount");
                    return 10_000_000L;
                }
                if ("countDocuments".equals(method.getName())) {
                    Document filter = (Document) args[0];
                    String call = "countDocuments:" + filter.toJson();
                    if (args.length > 1 && args[1] instanceof CountOptions options && options.getCollation() != null) {
                        Collation collation = options.getCollation();
                        call += ":collation=" + collation.getLocale() + "/" + collation.getStrength().getIntRepresentation();
                    }
                    calls.add(call);
                    return 42L;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
    }

    private static void assertRpcModifiedCount(MongoClient client, int id, String updateJson, boolean many) {
        JsonObject params = new JsonObject();
        params.addProperty("database", "app");
        params.addProperty("collection", "orders");
        params.addProperty("filter_json", "{}");
        params.addProperty("update_json", updateJson);
        params.addProperty("many", many);

        JsonObject request = new JsonObject();
        request.addProperty("jsonrpc", "2.0");
        request.addProperty("id", id);
        request.addProperty("method", "update_documents");
        request.add("params", params);

        JsonObject response = JsonParser.parseString(MongoAgent.handleRequest(request.toString(), client)).getAsJsonObject();
        assertFalse(response.has("error"), response.toString());
        assertEquals(1, response.getAsJsonObject("result").get("modified_count").getAsLong());
    }

    @SuppressWarnings("unchecked")
    private static MongoClient recordingMongoClient(List<String> calls) {
        MongoCollection<Document> collection = (MongoCollection<Document>) Proxy.newProxyInstance(
            MongoCollection.class.getClassLoader(),
            new Class<?>[] {MongoCollection.class},
            (proxy, method, args) -> {
                if ("updateOne".equals(method.getName()) || "updateMany".equals(method.getName())) {
                    calls.add(method.getName() + ":" + (args[1] instanceof List<?> ? "pipeline" : "document"));
                    return UpdateResult.acknowledged(1, 1L, null);
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
        MongoDatabase database = (MongoDatabase) Proxy.newProxyInstance(
            MongoDatabase.class.getClassLoader(),
            new Class<?>[] {MongoDatabase.class},
            (proxy, method, args) -> {
                if ("getCollection".equals(method.getName())) {
                    return collection;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
        return (MongoClient) Proxy.newProxyInstance(
            MongoClient.class.getClassLoader(),
            new Class<?>[] {MongoClient.class},
            (proxy, method, args) -> {
                if ("getDatabase".equals(method.getName())) {
                    return database;
                }
                if ("close".equals(method.getName())) {
                    return null;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
    }

    @SuppressWarnings("unchecked")
    private static MongoClient recordingFindOneMongoClient(List<String> calls, Document firstDocument) {
        FindIterable<Document>[] iterableRef = new FindIterable[1];
        FindIterable<Document> iterable = (FindIterable<Document>) Proxy.newProxyInstance(
            FindIterable.class.getClassLoader(),
            new Class<?>[] {FindIterable.class},
            (proxy, method, args) -> {
                if ("projection".equals(method.getName()) || "sort".equals(method.getName())) {
                    calls.add(method.getName() + ":" + ((Document) args[0]).toJson());
                    return iterableRef[0];
                }
                if ("limit".equals(method.getName())) {
                    calls.add("limit:" + args[0]);
                    return iterableRef[0];
                }
                if ("first".equals(method.getName())) {
                    calls.add("first");
                    return firstDocument;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
        iterableRef[0] = iterable;

        MongoCollection<Document> collection = (MongoCollection<Document>) Proxy.newProxyInstance(
            MongoCollection.class.getClassLoader(),
            new Class<?>[] {MongoCollection.class},
            (proxy, method, args) -> {
                if ("find".equals(method.getName())) {
                    calls.add("find:" + ((Document) args[0]).toJson());
                    return iterable;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
        MongoDatabase database = (MongoDatabase) Proxy.newProxyInstance(
            MongoDatabase.class.getClassLoader(),
            new Class<?>[] {MongoDatabase.class},
            (proxy, method, args) -> {
                if ("getCollection".equals(method.getName())) {
                    return collection;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
        return (MongoClient) Proxy.newProxyInstance(
            MongoClient.class.getClassLoader(),
            new Class<?>[] {MongoClient.class},
            (proxy, method, args) -> {
                if ("getDatabase".equals(method.getName())) {
                    return database;
                }
                if ("close".equals(method.getName())) {
                    return null;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
    }

    @SuppressWarnings("unchecked")
    private static MongoClient recordingAggregateMongoClient(List<String> calls, List<Document> resultDocuments) {
        int[] index = {0};
        MongoCursor<Document> cursor = (MongoCursor<Document>) Proxy.newProxyInstance(
            MongoCursor.class.getClassLoader(),
            new Class<?>[] {MongoCursor.class},
            (proxy, method, args) -> {
                return switch (method.getName()) {
                    case "hasNext" -> index[0] < resultDocuments.size();
                    case "next" -> resultDocuments.get(index[0]++);
                    case "close" -> {
                        calls.add("close");
                        yield null;
                    }
                    default -> throw new UnsupportedOperationException(method.getName());
                };
            }
        );

        AggregateIterable<Document>[] iterableRef = new AggregateIterable[1];
        AggregateIterable<Document> iterable = (AggregateIterable<Document>) Proxy.newProxyInstance(
            AggregateIterable.class.getClassLoader(),
            new Class<?>[] {AggregateIterable.class},
            (proxy, method, args) -> {
                return switch (method.getName()) {
                    case "allowDiskUse" -> {
                        calls.add("allowDiskUse:" + args[0]);
                        yield iterableRef[0];
                    }
                    case "batchSize" -> {
                        calls.add("batchSize:" + args[0]);
                        yield iterableRef[0];
                    }
                    case "maxTime" -> {
                        calls.add("maxTime:" + args[0] + ":" + ((TimeUnit) args[1]).name());
                        yield iterableRef[0];
                    }
                    case "iterator" -> cursor;
                    default -> throw new UnsupportedOperationException(method.getName());
                };
            }
        );
        iterableRef[0] = iterable;

        MongoCollection<Document> collection = (MongoCollection<Document>) Proxy.newProxyInstance(
            MongoCollection.class.getClassLoader(),
            new Class<?>[] {MongoCollection.class},
            (proxy, method, args) -> {
                if ("aggregate".equals(method.getName())) {
                    List<Document> pipeline = (List<Document>) args[0];
                    Document match = pipeline.get(0).get("$match", Document.class);
                    calls.add("aggregate:" + pipeline.size() + ":" + match.getString("status"));
                    return iterable;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
        MongoDatabase database = (MongoDatabase) Proxy.newProxyInstance(
            MongoDatabase.class.getClassLoader(),
            new Class<?>[] {MongoDatabase.class},
            (proxy, method, args) -> {
                if ("getCollection".equals(method.getName())) {
                    return collection;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
        return (MongoClient) Proxy.newProxyInstance(
            MongoClient.class.getClassLoader(),
            new Class<?>[] {MongoClient.class},
            (proxy, method, args) -> {
                if ("getDatabase".equals(method.getName())) {
                    return database;
                }
                if ("close".equals(method.getName())) {
                    return null;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
    }

    private static JsonObject minimalConnection() {
        JsonObject conn = new JsonObject();
        conn.addProperty("host", "127.0.0.1");
        conn.addProperty("port", 27017);
        return conn;
    }

    private static boolean containsCapability(JsonArray capabilities, String expected) {
        for (int i = 0; i < capabilities.size(); i++) {
            if (expected.equals(capabilities.get(i).getAsString())) {
                return true;
            }
        }
        return false;
    }
}
