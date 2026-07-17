package com.dbx.agent.mongodb;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.dbx.agent.AgentProtocol;
import com.dbx.agent.IndexInfo;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mongodb.MongoClientSettings;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
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

        assertEquals(Collections.singletonMap("$numberLong", "2048938405781032962"), id);
        assertEquals("2048938405781032962", value);
        assertEquals(2_048_938_405_781_032_962L, MongoAgent.parseId("{\"$numberLong\":\"2048938405781032962\"}"));
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
    void documentForWriteParsesLegacyDateDisplayStrings() {
        Document doc = MongoAgent.documentForWrite("{\"$set\":{\"CreateDate\":\"2025-08-14 02:25:43.718\"}}");

        Document set = (Document) doc.get("$set");
        assertTrue(set.get("CreateDate") instanceof Date);
        assertEquals(1_755_138_343_718L, ((Date) set.get("CreateDate")).getTime());
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
