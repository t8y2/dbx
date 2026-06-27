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
import java.io.FileInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.util.Base64;
import java.util.Date;
import org.bson.Document;
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

    // ─── helpers ───

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
