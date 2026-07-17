package com.dbx.agent.mongodb;

import com.dbx.agent.AgentProtocol;
import com.dbx.agent.IndexInfo;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mongodb.ConnectionString;
import com.mongodb.MongoCredential;
import com.mongodb.MongoClientSettings;
import com.mongodb.ServerAddress;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.UpdateOptions;
import com.mongodb.client.result.UpdateResult;
import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.KeyManager;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import org.bson.Document;
import org.bson.json.JsonMode;
import org.bson.json.JsonWriterSettings;
import org.bson.types.ObjectId;

public final class MongoAgent {
    private static final Gson GSON = new Gson();
    private static final DateTimeFormatter DATE_FORMAT = DateTimeFormatter.ISO_INSTANT.withZone(ZoneOffset.UTC);
    private static final long JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final JsonWriterSettings EXTENDED_JSON_SETTINGS = JsonWriterSettings.builder()
        .outputMode(JsonMode.RELAXED)
        .build();
    private static final String LEGACY_SESSION_ID = "__legacy__";
    private static final int MAX_SESSIONS = 256;
    private static final ThreadLocal<MongoClient> CURRENT_CLIENT = new ThreadLocal<>();
    private static MongoClient legacyClient;

    private MongoAgent() {
    }

    private static String stringOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        return element == null || element instanceof JsonNull ? null : element.getAsString();
    }

    static Document documentOrNull(JsonObject object, String key) {
        String json = stringOrNull(object, key);
        return json == null || json.isBlank() ? null : Document.parse(json);
    }

    static MongoClientSettings.Builder configureBuilder(JsonObject connObj) {
        String host = connObj.has("host") ? connObj.get("host").getAsString() : "127.0.0.1";
        int port = connObj.has("port") ? connObj.get("port").getAsInt() : 27017;
        String username = coalesce(stringOrNull(connObj, "username"));
        String password = coalesce(stringOrNull(connObj, "password"));
        String authDatabase = authenticationDatabase(connObj);
        String connectionString = stringOrNull(connObj, "connection_string");
        boolean ssl = connObj.has("ssl") && !connObj.get("ssl").isJsonNull() && connObj.get("ssl").getAsBoolean();
        String caCertPath = stringOrNull(connObj, "ca_cert_path");
        String clientCertPath = firstNonBlank(
            stringOrNull(connObj, "client_cert_path"), stringOrNull(connObj, "cert_path"));
        String clientKeyPath = firstNonBlank(
            stringOrNull(connObj, "client_key_path"), stringOrNull(connObj, "key_path"));

        if ((clientCertPath == null) != (clientKeyPath == null)) {
            throw new IllegalArgumentException("Client certificate and key must be provided together");
        }

        MongoClientSettings.Builder builder = MongoClientSettings.builder();
        if (connectionString != null && !connectionString.isBlank()) {
            builder.applyConnectionString(new ConnectionString(connectionString));
        } else {
            builder.applyToClusterSettings(
                settings -> settings.hosts(Collections.singletonList(new ServerAddress(host, port))));
            if (!username.isBlank()) {
                builder.credential(MongoCredential.createCredential(username, authDatabase, password.toCharArray()));
            }
        }

        if (ssl) {
            applyTlsSettings(builder, caCertPath, clientCertPath, clientKeyPath);
        }

        return builder;
    }

    private static MongoClient openClient(JsonObject params) {
        JsonObject connObj = params.has("connection") && params.get("connection").isJsonObject()
            ? params.getAsJsonObject("connection")
            : params;
        String database = defaultString(stringOrNull(connObj, "database"), "admin");

        MongoClientSettings.Builder builder = configureBuilder(connObj);

        MongoClient client = MongoClients.create(builder.build());
        try {
            client.getDatabase(database).runCommand(new Document("ping", 1));
        } catch (RuntimeException error) {
            client.close();
            throw error;
        }
        return client;
    }

    private static Object connect(JsonObject params) {
        closeLegacyClient();
        legacyClient = openClient(params);
        return Collections.singletonMap("ok", true);
    }

    private static void applyTlsSettings(MongoClientSettings.Builder builder,
        String caCertPath, String clientCertPath, String clientKeyPath) {
        builder.applyToSslSettings(sslBuilder -> {
            sslBuilder.enabled(true);
            if (caCertPath != null && !caCertPath.isBlank()
                || clientCertPath != null && !clientCertPath.isBlank()) {
                try {
                    sslBuilder.context(createTlsSslContext(caCertPath, clientCertPath, clientKeyPath));
                } catch (Exception e) {
                    throw new RuntimeException("Failed to configure TLS: " + e.getMessage(), e);
                }
            }
        });
    }

    static SSLContext createTlsSslContext(String caCertPath, String clientCertPath, String clientKeyPath)
        throws Exception {
        TrustManager[] trustManagers = null;
        if (caCertPath != null && !caCertPath.isBlank()) {
            trustManagers = loadTrustManagersFromPem(caCertPath);
        }

        KeyManager[] keyManagers = null;
        if (clientCertPath != null && !clientCertPath.isBlank()
            && clientKeyPath != null && !clientKeyPath.isBlank()) {
            keyManagers = loadKeyManagersFromPem(clientCertPath, clientKeyPath);
        }

        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(keyManagers, trustManagers, new SecureRandom());
        return ctx;
    }

    static TrustManager[] loadTrustManagersFromPem(String caCertPath) throws Exception {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        KeyStore trustStore = KeyStore.getInstance(KeyStore.getDefaultType());
        trustStore.load(null, null);
        int i = 0;
        try (InputStream is = new FileInputStream(caCertPath)) {
            for (Certificate cert : (Collection<? extends Certificate>) cf.generateCertificates(is)) {
                trustStore.setCertificateEntry("ca-" + i, cert);
                i++;
            }
        }
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(trustStore);
        return tmf.getTrustManagers();
    }

    static KeyManager[] loadKeyManagersFromPem(String certPath, String keyPath) throws Exception {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        Certificate cert;
        try (InputStream is = new FileInputStream(certPath)) {
            cert = cf.generateCertificate(is);
        }

        PrivateKey key = loadPrivateKeyFromPem(keyPath);

        KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
        keyStore.load(null, null);
        keyStore.setCertificateEntry("client", cert);
        keyStore.setKeyEntry("client", key, new char[0], new Certificate[] {cert});

        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(keyStore, new char[0]);
        return kmf.getKeyManagers();
    }

    static PrivateKey loadPrivateKeyFromPem(String keyPath) throws Exception {
        String content = new String(Files.readAllBytes(Paths.get(keyPath)), StandardCharsets.UTF_8);
        content = content.replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replace("-----BEGIN RSA PRIVATE KEY-----", "")
            .replace("-----END RSA PRIVATE KEY-----", "")
            .replace("-----BEGIN EC PRIVATE KEY-----", "")
            .replace("-----END EC PRIVATE KEY-----", "");
        byte[] keyBytes = Base64.getDecoder().decode(content.replaceAll("\\s", ""));

        // PKCS#8 (standard format, "-----BEGIN PRIVATE KEY-----")
        try {
            return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(keyBytes));
        } catch (Exception e) {
            // ignore — try next format
        }
        try {
            return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(keyBytes));
        } catch (Exception e) {
            // ignore — try next format
        }

        // PKCS#1 RSA — add PKCS#8 AlgorithmIdentifier prefix
        // The prefix is: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }, OCTET STRING }
        try {
            byte[] pkcs8Header = {
                0x30, (byte) 0x82, 0, 0,  // SEQUENCE (length filled in below)
                0x02, 0x01, 0x00,          // INTEGER 0
                0x30, 0x0d,                // SEQUENCE (AlgorithmIdentifier)
                0x06, 0x09, 0x2a, (byte) 0x86, 0x48, (byte) 0x86, (byte) 0xf7, 0x0d, 0x01, 0x01, 0x01,  // OID 1.2.840.113549.1.1.1
                0x05, 0x00,                // NULL
                0x04                       // OCTET STRING (length filled in below)
            };
            int totalLen = pkcs8Header.length + keyBytes.length - 4;  // subtract placeholder SEQUENCE length
            pkcs8Header[2] = (byte) ((totalLen >> 8) & 0xff);
            pkcs8Header[3] = (byte) (totalLen & 0xff);
            // OCTET STRING length
            int octetLen = keyBytes.length;
            byte[] octetLenBytes;
            if (octetLen < 128) {
                octetLenBytes = new byte[] {(byte) octetLen};
            } else if (octetLen < 256) {
                octetLenBytes = new byte[] {(byte) 0x81, (byte) octetLen};
            } else {
                octetLenBytes = new byte[] {(byte) 0x82, (byte) (octetLen >> 8), (byte) (octetLen & 0xff)};
            }
            byte[] pkcs8Key = new byte[pkcs8Header.length + octetLenBytes.length - 1 + keyBytes.length];
            int pos = 0;
            System.arraycopy(pkcs8Header, 0, pkcs8Key, pos, pkcs8Header.length - 1);  // exclude placeholder OCTET STRING length
            pos += pkcs8Header.length - 1;
            System.arraycopy(octetLenBytes, 0, pkcs8Key, pos, octetLenBytes.length);
            pos += octetLenBytes.length;
            System.arraycopy(keyBytes, 0, pkcs8Key, pos, keyBytes.length);
            return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(pkcs8Key));
        } catch (Exception e) {
            throw new IllegalArgumentException(
                "Unsupported private key format in " + keyPath
                    + ". Use PKCS#8 (-----BEGIN PRIVATE KEY-----) or PKCS#1 RSA (-----BEGIN RSA PRIVATE KEY-----).",
                e);
        }
    }

    static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    static String authenticationDatabase(JsonObject connObj) {
        String authSource = urlParam(stringOrNull(connObj, "url_params"), "authSource");
        if (authSource != null && !authSource.isBlank()) {
            return authSource;
        }
        return "admin";
    }

    private static String urlParam(String urlParams, String key) {
        if (urlParams == null || urlParams.isBlank()) {
            return null;
        }
        String normalized = urlParams.startsWith("?") ? urlParams.substring(1) : urlParams;
        for (String pair : normalized.split("&")) {
            if (pair.isBlank()) continue;
            String[] parts = pair.split("=", 2);
            if (decode(parts[0]).equals(key)) {
                return parts.length > 1 ? decode(parts[1]) : "";
            }
        }
        return null;
    }

    private static String decode(String value) {
        return URLDecoder.decode(value, StandardCharsets.UTF_8);
    }

    private static Object listDatabases() {
        MongoClient c = requireClient();
        List<Map<String, String>> result = new ArrayList<>();
        for (String name : c.listDatabaseNames()) {
            result.add(Collections.singletonMap("name", name));
        }
        return result;
    }

    private static Object listCollections(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        List<String> result = new ArrayList<>();
        for (String name : c.getDatabase(database).listCollectionNames()) {
            result.add(name);
        }
        return result;
    }

    private static Object listIndexes(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("table").getAsString();
        List<IndexInfo> result = new ArrayList<>();
        for (Document index : c.getDatabase(database).getCollection(collection).listIndexes()) {
            result.add(indexInfoFromDocument(index));
        }
        return result;
    }

    static IndexInfo indexInfoFromDocument(Document index) {
        Document keys = index.get("key") instanceof Document document ? document : new Document();
        String name = index.getString("name");
        if (name == null || name.isBlank()) {
            List<String> parts = new ArrayList<>();
            for (Map.Entry<String, Object> entry : keys.entrySet()) {
                parts.add(entry.getKey() + "_" + String.valueOf(entry.getValue()));
            }
            name = String.join("_", parts);
        }

        List<String> columns = new ArrayList<>(keys.keySet());
        String indexType = null;
        if (!keys.isEmpty()) {
            List<String> parts = new ArrayList<>();
            for (Map.Entry<String, Object> entry : keys.entrySet()) {
                parts.add(entry.getKey() + ": " + String.valueOf(entry.getValue()));
            }
            indexType = String.join(", ", parts);
        }

        Object unique = index.get("unique");
        Document filter = index.get("partialFilterExpression") instanceof Document document ? document : null;
        return new IndexInfo(
            name,
            columns,
            unique instanceof Boolean && (Boolean) unique,
            "_id_".equals(name),
            filter == null ? null : filter.toJson(),
            indexType,
            null,
            null
        );
    }

    private static Object findDocuments(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        long skip = params.has("skip") ? params.get("skip").getAsLong() : 0;
        int limit = params.has("limit") ? params.get("limit").getAsInt() : 50;
        Document filterDoc = documentOrNull(params, "filter");
        Document projectionDoc = documentOrNull(params, "projection");
        Document sortDoc = documentOrNull(params, "sort");

        var col = c.getDatabase(database).getCollection(collection);
        if (filterDoc == null) {
            filterDoc = new Document();
        }
        long total = col.countDocuments(filterDoc);

        var iterable = col.find(filterDoc).skip((int) skip).limit(limit);
        if (projectionDoc != null) {
            iterable = iterable.projection(projectionDoc);
        }
        if (sortDoc != null) {
            iterable = iterable.sort(sortDoc);
        }

        List<Map<String, Object>> documents = new ArrayList<>();
        for (Document document : iterable) {
            documents.add(bsonToJson(document));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("documents", documents);
        result.put("total", total);
        return result;
    }

    /**
     * MongoDB Extended JSON read path for transfer; output follows the driver's
     * relaxed Extended JSON representation rather than the UI display format.
     */
    private static Object findDocumentsExtendedJson(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        long skip = params.has("skip") ? params.get("skip").getAsLong() : 0;
        int limit = params.has("limit") ? params.get("limit").getAsInt() : 50;
        Document filterDoc = documentOrNull(params, "filter");
        Document projectionDoc = documentOrNull(params, "projection");
        Document sortDoc = documentOrNull(params, "sort");

        var col = c.getDatabase(database).getCollection(collection);
        if (filterDoc == null) {
            filterDoc = new Document();
        }
        long total = col.countDocuments(filterDoc);

        var iterable = col.find(filterDoc).skip((int) skip).limit(limit);
        if (projectionDoc != null) {
            iterable = iterable.projection(projectionDoc);
        }
        if (sortDoc != null) {
            iterable = iterable.sort(sortDoc);
        }

        List<JsonObject> documents = new ArrayList<>();
        for (Document document : iterable) {
            documents.add(bsonToExtendedJson(document));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("documents", documents);
        result.put("total", total);
        return result;
    }

    private static Object countDocuments(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        Document filterDoc = documentOrNull(params, "filter");
        if (filterDoc == null) {
            filterDoc = new Document();
        }

        boolean accurate = !params.has("accurate") || params.get("accurate").getAsBoolean();
        if (accurate) {
            return c.getDatabase(database).getCollection(collection).countDocuments(filterDoc);
        }

        // MongoDB 3.4 count() needs the legacy command to avoid the slow countDocuments path.
        Document result = c.getDatabase(database).runCommand(new Document("count", collection).append("query", filterDoc));
        Object n = result.get("n");
        if (n instanceof Number number) {
            return number.longValue();
        }
        return 0L;
    }

    private static Object serverVersion(JsonObject params) {
        MongoClient c = requireClient();
        String database = defaultString(stringOrNull(params, "database"), "admin");
        Document buildInfo = c.getDatabase(database).runCommand(new Document("buildInfo", 1));
        return serverVersionFromBuildInfo(buildInfo);
    }

    static String serverVersionFromBuildInfo(Document buildInfo) {
        String version = buildInfo.getString("version");
        if (version == null || version.isBlank()) {
            throw new IllegalStateException("MongoDB server version not found");
        }
        return version;
    }

    private static Object createIndex(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        Document keys = requiredDocument(params, "keys_json", "Index keys");
        if (keys.isEmpty()) {
            throw new IllegalArgumentException("Index keys are required");
        }

        Document index = new Document("key", keys);
        Document options = documentOrNull(params, "options_json");
        if (options != null) {
            index.putAll(options);
        }
        String name = index.getString("name");
        if (name == null || name.isBlank()) {
            name = defaultIndexName(keys);
            index.put("name", name);
        }

        c.getDatabase(database).runCommand(
            new Document("createIndexes", collection)
                .append("indexes", Collections.singletonList(index))
        );
        return Collections.singletonMap("name", name);
    }

    private static Document requiredDocument(JsonObject params, String key, String label) {
        Document document = documentOrNull(params, key);
        if (document == null) {
            throw new IllegalArgumentException(label + " are required");
        }
        return document;
    }

    private static String defaultIndexName(Document keys) {
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, Object> entry : keys.entrySet()) {
            parts.add(entry.getKey() + "_" + String.valueOf(entry.getValue()));
        }
        return String.join("_", parts);
    }

    private static Object dropIndexes(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        String indexesJson = stringOrNull(params, "indexes_json");
        boolean single = params.has("single") && !params.get("single").isJsonNull() && params.get("single").getAsBoolean();
        Object index = parseDropIndexesValue(indexesJson, single);

        List<IndexInfo> before = listIndexInfos(c, database, collection);
        c.getDatabase(database).runCommand(new Document("dropIndexes", collection).append("index", index));
        List<IndexInfo> after = listIndexInfos(c, database, collection);
        List<String> droppedNames = diffDroppedIndexNames(before, after);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("dropped_names", droppedNames);
        result.put("affected_rows", droppedNames.size());
        return result;
    }

    private static Object dropCollection(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        c.getDatabase(database).getCollection(collection).drop();
        return Collections.singletonMap("ok", true);
    }

    private static Object parseDropIndexesValue(String indexesJson, boolean single) {
        if (indexesJson == null || indexesJson.isBlank()) {
            if (single) {
                throw new IllegalArgumentException("dropIndex requires a string index name or JSON document");
            }
            return "*";
        }

        JsonElement value = JsonParser.parseString(indexesJson);
        if (value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
            String name = value.getAsString();
            if (name.isBlank()) {
                throw new IllegalArgumentException("Index name is required");
            }
            if (single && "*".equals(name)) {
                throw new IllegalArgumentException("dropIndex does not accept \"*\"; use dropIndexes() or dropIndexes(\"*\") instead");
            }
            return name;
        }
        if (value.isJsonObject()) {
            JsonObject object = value.getAsJsonObject();
            if (object.size() == 0) {
                throw new IllegalArgumentException("Index specification is required");
            }
            return Document.parse(indexesJson);
        }
        if (value.isJsonArray()) {
            if (single) {
                throw new IllegalArgumentException("dropIndex only accepts a string index name or JSON document; arrays are not supported");
            }
            List<String> names = new ArrayList<>();
            value.getAsJsonArray().forEach(item -> {
                if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString() || item.getAsString().isBlank()) {
                    throw new IllegalArgumentException("dropIndexes only accepts arrays of string index names");
                }
                names.add(item.getAsString());
            });
            if (names.isEmpty()) {
                throw new IllegalArgumentException("dropIndexes only accepts non-empty string arrays");
            }
            return names;
        }
        if (single) {
            throw new IllegalArgumentException("dropIndex only accepts a string index name or JSON document");
        }
        throw new IllegalArgumentException("dropIndexes only accepts a string index name, JSON document, or string array");
    }

    private static List<IndexInfo> listIndexInfos(MongoClient c, String database, String collection) {
        List<IndexInfo> result = new ArrayList<>();
        for (Document index : c.getDatabase(database).getCollection(collection).listIndexes()) {
            result.add(indexInfoFromDocument(index));
        }
        return result;
    }

    private static List<String> diffDroppedIndexNames(List<IndexInfo> before, List<IndexInfo> after) {
        Set<String> remaining = new HashSet<>();
        for (IndexInfo index : after) {
            remaining.add(index.getName());
        }
        List<String> droppedNames = new ArrayList<>();
        for (IndexInfo index : before) {
            if (!remaining.contains(index.getName())) {
                droppedNames.add(index.getName());
            }
        }
        return droppedNames;
    }

    private static Object insertDocument(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        String docJson = params.get("doc_json").getAsString();

        Document doc = Document.parse(docJson);
        c.getDatabase(database).getCollection(collection).insertOne(doc);
        Object insertedId = convertValue(doc.get("_id"));
        return Collections.singletonMap("inserted_id", insertedId);
    }

    static Object parseId(String id) {
        String stringId = decodeStringDocumentId(id);
        if (stringId != null) {
            return stringId;
        }
        String trimmed = id.trim();
        if (isNumberLongIdWrapper(trimmed)) {
            try {
                return Document.parse("{\"_id\":" + trimmed + "}").get("_id");
            } catch (Exception e) {
                // Fall through to the legacy ObjectId/string handling below.
            }
        }
        try {
            return new ObjectId(id);
        } catch (Exception e) {
            return id;
        }
    }

    private static String decodeStringDocumentId(String id) {
        String prefix = "__dbx_mongo_string_id__";
        if (!id.startsWith(prefix)) {
            return null;
        }
        try {
            JsonElement value = JsonParser.parseString(id.substring(prefix.length()));
            return value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() ? value.getAsString() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isNumberLongIdWrapper(String value) {
        try {
            JsonElement parsed = JsonParser.parseString(value);
            if (!parsed.isJsonObject()) {
                return false;
            }
            JsonObject wrapper = parsed.getAsJsonObject();
            JsonElement numberLong = wrapper.get("$numberLong");
            return wrapper.size() == 1
                && numberLong != null
                && numberLong.isJsonPrimitive()
                && numberLong.getAsJsonPrimitive().isString();
        } catch (Exception e) {
            return false;
        }
    }

    private static Object updateDocument(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        String id = params.get("id").getAsString();
        String docJson = params.get("doc_json").getAsString();

        var col = c.getDatabase(database).getCollection(collection);
        Document newDoc = documentForWrite(docJson);
        var filter = new Document("_id", parseId(id));
        var result = isUpdateOperatorDocument(newDoc)
            ? col.updateOne(filter, newDoc)
            : col.replaceOne(filter, replacementDocument(newDoc));
        return Collections.singletonMap("modified_count", result.getModifiedCount());
    }

    private static Object updateDocuments(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        String filterJson = params.get("filter_json").getAsString();
        String updateJson = params.get("update_json").getAsString();
        boolean many = params.get("many").getAsBoolean();
        String optionsJson = params.has("options_json") && !params.get("options_json").isJsonNull()
            ? params.get("options_json").getAsString()
            : null;

        var col = c.getDatabase(database).getCollection(collection);
        Document filter = documentForWrite(filterJson);
        UpdateOptions options = updateOptionsForWrite(optionsJson);
        var result = isUpdatePipelineJson(updateJson)
            ? updateDocumentsWithPipeline(col, filter, updatePipelineForWrite(updateJson), options, many)
            : updateDocumentsWithDocument(col, filter, documentForWrite(updateJson), options, many);
        return Collections.singletonMap("modified_count", result.getModifiedCount());
    }

    private static UpdateResult updateDocumentsWithDocument(
        MongoCollection<Document> col, Document filter, Document update,
        UpdateOptions options, boolean many) {
        requireBulkUpdateOperatorDocument(update);
        return many ? col.updateMany(filter, update, options) : col.updateOne(filter, update, options);
    }

    private static UpdateResult updateDocumentsWithPipeline(
        MongoCollection<Document> col, Document filter, List<Document> pipeline,
        UpdateOptions options, boolean many) {
        return many ? col.updateMany(filter, pipeline, options) : col.updateOne(filter, pipeline, options);
    }

    static UpdateOptions updateOptionsForWrite(String optionsJson) {
        UpdateOptions result = new UpdateOptions();
        if (optionsJson == null || optionsJson.trim().isEmpty()) {
            return result;
        }
        Document options = Document.parse(optionsJson);
        for (String key : options.keySet()) {
            if (!"arrayFilters".equals(key)) {
                throw new IllegalArgumentException("Unsupported update option: " + key);
            }
        }
        Object rawFilters = options.get("arrayFilters");
        if (rawFilters == null) {
            return result;
        }
        if (!(rawFilters instanceof List<?>)) {
            throw new IllegalArgumentException("arrayFilters must be an array");
        }
        List<Document> filters = new ArrayList<>();
        for (Object filter : (List<?>) rawFilters) {
            if (!(filter instanceof Document)) {
                throw new IllegalArgumentException("Each arrayFilters entry must be an object");
            }
            filters.add((Document) filter);
        }
        return result.arrayFilters(filters);
    }

    static Document documentForWrite(String docJson) {
        Document doc = Document.parse(docJson);
        convertMongoShellDates(doc);
        return doc;
    }

    private static boolean isUpdatePipelineJson(String updateJson) {
        return updateJson.trim().startsWith("[");
    }

    static List<Document> updatePipelineForWrite(String updateJson) {
        JsonElement parsed = JsonParser.parseString(updateJson);
        if (!parsed.isJsonArray()) {
            throw new IllegalArgumentException("Update pipeline must be an array");
        }
        JsonArray stages = parsed.getAsJsonArray();
        List<Document> pipeline = new ArrayList<>(stages.size());
        for (JsonElement stage : stages) {
            if (!stage.isJsonObject()) {
                // The Java driver pipeline overload accepts BSON stages, not scalar array entries.
                throw new IllegalArgumentException("Each update pipeline stage must be an object");
            }
            pipeline.add(documentForWrite(stage.toString()));
        }
        return pipeline;
    }

    private static Document replacementDocument(Document doc) {
        Document replacement = new Document(doc);
        replacement.remove("_id");
        return replacement;
    }

    static boolean isUpdateOperatorDocument(Document doc) {
        if (doc.isEmpty()) {
            return false;
        }
        for (String key : doc.keySet()) {
            if (!key.startsWith("$")) {
                return false;
            }
        }
        return true;
    }

    static void requireBulkUpdateOperatorDocument(Document doc) {
        if (!isUpdateOperatorDocument(doc)) {
            // updateOne/updateMany are shell-style bulk updates here; replacements stay on the
            // single-document save path so a broad filter cannot replace many documents by accident.
            throw new IllegalArgumentException("Bulk update requires update operators such as $set");
        }
    }

    private static Object deleteDocument(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        String id = params.get("id").getAsString();

        var col = c.getDatabase(database).getCollection(collection);
        var result = col.deleteOne(new Document("_id", parseId(id)));
        return Collections.singletonMap("deleted_count", result.getDeletedCount());
    }

    private static Object deleteDocuments(JsonObject params) {
        MongoClient c = requireClient();
        String database = params.get("database").getAsString();
        String collection = params.get("collection").getAsString();
        String filterJson = params.get("filter_json").getAsString();
        boolean many = params.get("many").getAsBoolean();

        var col = c.getDatabase(database).getCollection(collection);
        Document filter = documentForWrite(filterJson);
        // Shell deleteOne/deleteMany use a filter document, unlike the row-view
        // delete path which always targets a single _id.
        var result = many ? col.deleteMany(filter) : col.deleteOne(filter);
        return Collections.singletonMap("deleted_count", result.getDeletedCount());
    }

    private static Map<String, Object> bsonToJson(Document doc) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : doc.entrySet()) {
            result.put(entry.getKey(), convertDocumentFieldValue(entry.getKey(), entry.getValue()));
        }
        return result;
    }

    static Object convertDocumentFieldValue(String key, Object value) {
        if ("_id".equals(key) && value instanceof Long longValue) {
            return Collections.singletonMap("$numberLong", longValue.toString());
        }
        return convertValue(value);
    }

    static JsonObject bsonToExtendedJson(Document doc) {
        return JsonParser.parseString(doc.toJson(EXTENDED_JSON_SETTINGS)).getAsJsonObject();
    }

    static Object convertValue(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof ObjectId objectId) {
            return objectId.toHexString();
        }
        if (value instanceof Document document) {
            return bsonToJson(document);
        }
        if (value instanceof List<?> values) {
            List<Object> result = new ArrayList<>();
            for (Object item : values) {
                result.add(convertValue(item));
            }
            return result;
        }
        if (value instanceof java.util.Date date) {
            Instant instant = Instant.ofEpochMilli(date.getTime());
            return "ISODate(\"" + DATE_FORMAT.format(instant) + "\")";
        }
        if (value instanceof Long longValue) {
            return longValue < -JS_MAX_SAFE_INTEGER || longValue > JS_MAX_SAFE_INTEGER ? longValue.toString() : longValue;
        }
        if (value instanceof Boolean || value instanceof Integer || value instanceof Double || value instanceof String) {
            return value;
        }
        return value.toString();
    }

    @SuppressWarnings("unchecked")
    private static Object convertMongoShellDates(Object value) {
        if (value instanceof Document document) {
            for (String key : new ArrayList<>(document.keySet())) {
                document.put(key, convertMongoShellDates(document.get(key)));
            }
            return document;
        }
        if (value instanceof List<?> values) {
            List<Object> converted = (List<Object>) values;
            for (int i = 0; i < converted.size(); i++) {
                converted.set(i, convertMongoShellDates(converted.get(i)));
            }
            return converted;
        }
        if (value instanceof String text) {
            Date date = parseMongoShellDate(text);
            if (date == null) {
                date = parseLegacyDateDisplay(text);
            }
            return date == null ? value : date;
        }
        return value;
    }

    static Date parseMongoShellDate(String value) {
        String trimmed = value.trim();
        String inner = null;
        if (trimmed.startsWith("ISODate(") && trimmed.endsWith(")")) {
            inner = trimmed.substring("ISODate(".length(), trimmed.length() - 1).trim();
        } else if (trimmed.startsWith("new Date(") && trimmed.endsWith(")")) {
            inner = trimmed.substring("new Date(".length(), trimmed.length() - 1).trim();
        }
        if (inner == null || inner.length() < 2) {
            return null;
        }
        char quote = inner.charAt(0);
        if ((quote != '"' && quote != '\'') || inner.charAt(inner.length() - 1) != quote) {
            return null;
        }
        try {
            Instant instant = Instant.parse(inner.substring(1, inner.length() - 1));
            return Date.from(instant);
        } catch (Exception e) {
            return null;
        }
    }

    static Date parseLegacyDateDisplay(String value) {
        String trimmed = value.trim();
        if (!trimmed.matches("\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?")) {
            return null;
        }
        String normalized = trimmed.replace(' ', 'T');
        int dot = normalized.indexOf('.');
        if (dot < 0) {
            normalized = normalized + ".000";
        } else {
            int millisStart = dot + 1;
            int millisEnd = normalized.length();
            normalized = normalized.substring(0, millisStart)
                + String.format("%-3s", normalized.substring(millisStart, millisEnd)).replace(' ', '0');
        }
        try {
            return Date.from(Instant.parse(normalized + "Z"));
        } catch (Exception e) {
            return null;
        }
    }

    private static Object dispatch(String method, JsonObject params) {
        return switch (method) {
            case AgentProtocol.METHOD_HANDSHAKE -> AgentProtocol.handshakeResult();
            case AgentProtocol.METHOD_CONNECT -> connect(params);
            case AgentProtocol.MONGO_METHOD_LIST_DATABASES -> listDatabases();
            case AgentProtocol.MONGO_METHOD_LIST_COLLECTIONS -> listCollections(params);
            case AgentProtocol.METHOD_LIST_INDEXES -> listIndexes(params);
            case AgentProtocol.MONGO_METHOD_FIND_DOCUMENTS -> findDocuments(params);
            case AgentProtocol.MONGO_METHOD_FIND_DOCUMENTS_EXTENDED_JSON -> findDocumentsExtendedJson(params);
            case AgentProtocol.MONGO_METHOD_COUNT_DOCUMENTS -> countDocuments(params);
            case AgentProtocol.MONGO_METHOD_SERVER_VERSION -> serverVersion(params);
            case AgentProtocol.MONGO_METHOD_CREATE_INDEX -> createIndex(params);
            case AgentProtocol.MONGO_METHOD_DROP_INDEXES -> dropIndexes(params);
            case AgentProtocol.MONGO_METHOD_DROP_COLLECTION -> dropCollection(params);
            case AgentProtocol.MONGO_METHOD_INSERT_DOCUMENT -> insertDocument(params);
            case AgentProtocol.MONGO_METHOD_UPDATE_DOCUMENT -> updateDocument(params);
            case AgentProtocol.MONGO_METHOD_UPDATE_DOCUMENTS -> updateDocuments(params);
            case AgentProtocol.MONGO_METHOD_DELETE_DOCUMENT -> deleteDocument(params);
            case AgentProtocol.MONGO_METHOD_DELETE_DOCUMENTS -> deleteDocuments(params);
            case AgentProtocol.METHOD_DISCONNECT, AgentProtocol.METHOD_SHUTDOWN -> {
                closeLegacyClient();
                if (AgentProtocol.METHOD_SHUTDOWN.equals(method)) {
                    System.exit(0);
                }
                yield Collections.singletonMap("ok", true);
            }
            default -> throw new IllegalArgumentException("Unknown method: " + method);
        };
    }

    private static MongoClient requireClient() {
        MongoClient client = CURRENT_CLIENT.get();
        if (client == null) {
            client = legacyClient;
        }
        if (client == null) {
            throw new IllegalStateException("Not connected");
        }
        return client;
    }

    private static void closeLegacyClient() {
        if (legacyClient != null) {
            legacyClient.close();
            legacyClient = null;
        }
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    private static String defaultString(String value, String fallback) {
        return value == null ? fallback : value;
    }

    static String handleRequest(String line) {
        return handleRequest(line, null);
    }

    static String handleRequest(String line, MongoClient client) {
        if (client != null) {
            CURRENT_CLIENT.set(client);
        }
        try {
            JsonObject req = JsonParser.parseString(line).getAsJsonObject();
            JsonElement id = req.get("id");
            String method = req.get("method").getAsString();
            JsonObject params = req.has("params") && req.get("params").isJsonObject()
                ? req.getAsJsonObject("params")
                : new JsonObject();

            JsonObject response = new JsonObject();
            response.addProperty("jsonrpc", "2.0");
            response.add("id", id);

            try {
                Object result = dispatch(method, params);
                response.add("result", GSON.toJsonTree(result));
            } catch (Exception e) {
                JsonObject error = new JsonObject();
                error.addProperty("code", -1);
                error.addProperty("message", e.getMessage() == null ? "Unknown error" : e.getMessage());
                response.add("error", error);
            }

            return GSON.toJson(response);
        } finally {
            if (client != null) {
                CURRENT_CLIENT.remove();
            }
        }
    }

    public static void main(String[] args) throws Exception {
        System.out.println("{\"ready\":true}");
        System.out.flush();
        new RuntimeServer().run();
    }

    private static final class RuntimeServer {
        private final Map<String, Session> sessions = new ConcurrentHashMap<>();
        private final ExecutorService requests = Executors.newCachedThreadPool();
        private final Object outputLock = new Object();

        private void run() throws Exception {
            BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
            String line;
            while ((line = reader.readLine()) != null) {
                String request = line;
                requests.submit(() -> writeResponse(handleRuntimeRequest(request)));
            }
            closeAllSessions();
            requests.shutdownNow();
        }

        private String handleRuntimeRequest(String line) {
            JsonObject req = JsonParser.parseString(line).getAsJsonObject();
            JsonElement id = req.get("id");
            String method = req.get("method").getAsString();
            JsonObject params = req.has("params") && req.get("params").isJsonObject()
                ? req.getAsJsonObject("params")
                : new JsonObject();
            JsonObject response = new JsonObject();
            response.addProperty("jsonrpc", "2.0");
            response.add("id", id);
            try {
                Object result;
                if (AgentProtocol.METHOD_HANDSHAKE.equals(method)) {
                    result = AgentProtocol.multiSessionHandshakeResult();
                } else if (AgentProtocol.METHOD_OPEN_SESSION.equals(method)) {
                    result = openSession(requiredSessionId(params), params);
                } else if (AgentProtocol.METHOD_CLOSE_SESSION.equals(method)) {
                    result = closeSession(requiredSessionId(params));
                } else if (AgentProtocol.METHOD_VALIDATE_SESSION.equals(method)) {
                    result = session(requiredSessionId(params)).validate(params);
                } else if (AgentProtocol.METHOD_CANCEL_SESSION.equals(method)) {
                    // The legacy synchronous MongoDB driver has no safe per-operation cancel API.
                    result = Collections.singletonMap("ok", true);
                } else if (AgentProtocol.METHOD_CONNECT.equals(method)) {
                    closeSession(LEGACY_SESSION_ID);
                    result = openSession(LEGACY_SESSION_ID, params);
                } else if (AgentProtocol.METHOD_DISCONNECT.equals(method)) {
                    result = closeSession(LEGACY_SESSION_ID);
                } else if (AgentProtocol.METHOD_SHUTDOWN.equals(method)) {
                    closeAllSessions();
                    result = Collections.singletonMap("ok", true);
                } else {
                    String sessionId = params.has("agentSessionId")
                        ? params.get("agentSessionId").getAsString()
                        : LEGACY_SESSION_ID;
                    result = session(sessionId).handle(method, params);
                }
                response.add("result", GSON.toJsonTree(result));
            } catch (Exception error) {
                JsonObject rpcError = new JsonObject();
                rpcError.addProperty("code", -1);
                rpcError.addProperty("message", error.getMessage() == null ? "Unknown error" : error.getMessage());
                response.add("error", rpcError);
            }
            return GSON.toJson(response);
        }

        private Object openSession(String sessionId, JsonObject params) {
            if (sessions.size() >= MAX_SESSIONS && !sessions.containsKey(sessionId)) {
                throw new IllegalStateException("Agent session limit reached: " + MAX_SESSIONS);
            }
            Session created = new Session(openClient(params));
            Session existing = sessions.putIfAbsent(sessionId, created);
            if (existing != null) {
                created.close();
                throw new IllegalStateException("Agent session already exists: " + sessionId);
            }
            return Collections.singletonMap("ok", true);
        }

        private Object closeSession(String sessionId) {
            Session removed = sessions.remove(sessionId);
            if (removed != null) {
                removed.close();
            }
            return Collections.singletonMap("ok", true);
        }

        private Session session(String sessionId) {
            Session session = sessions.get(sessionId);
            if (session == null) {
                throw new IllegalStateException("Agent session not found: " + sessionId);
            }
            return session;
        }

        private void closeAllSessions() {
            for (String sessionId : sessions.keySet()) {
                closeSession(sessionId);
            }
        }

        private static String requiredSessionId(JsonObject params) {
            if (!params.has("agentSessionId") || params.get("agentSessionId").getAsString().trim().isEmpty()) {
                throw new IllegalArgumentException("agentSessionId is required");
            }
            return params.get("agentSessionId").getAsString();
        }

        private void writeResponse(String response) {
            synchronized (outputLock) {
                System.out.println(response);
                System.out.flush();
            }
        }
    }

    private static final class Session {
        private final MongoClient client;

        private Session(MongoClient client) {
            this.client = client;
        }

        private synchronized Object handle(String method, JsonObject params) {
            CURRENT_CLIENT.set(client);
            try {
                return dispatch(method, params);
            } finally {
                CURRENT_CLIENT.remove();
            }
        }

        private Object validate(JsonObject params) {
            JsonObject connection = params.has("connection") && params.get("connection").isJsonObject()
                ? params.getAsJsonObject("connection")
                : params;
            String database = defaultString(stringOrNull(connection, "database"), "admin");
            client.getDatabase(database).runCommand(new Document("ping", 1));
            return Collections.singletonMap("ok", true);
        }

        private synchronized void close() {
            client.close();
        }
    }
}
