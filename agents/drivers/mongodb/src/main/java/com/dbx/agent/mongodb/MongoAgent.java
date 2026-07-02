package com.dbx.agent.mongodb;

import com.dbx.agent.AgentProtocol;
import com.dbx.agent.IndexInfo;
import com.google.gson.Gson;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
    private static MongoClient client;

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

    private static Object connect(JsonObject params) {
        JsonObject connObj = params.has("connection") && params.get("connection").isJsonObject()
            ? params.getAsJsonObject("connection")
            : params;
        String database = defaultString(stringOrNull(connObj, "database"), "admin");

        MongoClientSettings.Builder builder = configureBuilder(connObj);

        if (client != null) {
            client.close();
        }
        client = MongoClients.create(builder.build());
        client.getDatabase(database).runCommand(new Document("ping", 1));
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

    private static Object parseId(String id) {
        try {
            return new ObjectId(id);
        } catch (Exception e) {
            return id;
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

        var col = c.getDatabase(database).getCollection(collection);
        Document filter = documentForWrite(filterJson);
        Document update = documentForWrite(updateJson);
        requireBulkUpdateOperatorDocument(update);
        var result = many ? col.updateMany(filter, update) : col.updateOne(filter, update);
        return Collections.singletonMap("modified_count", result.getModifiedCount());
    }

    static Document documentForWrite(String docJson) {
        Document doc = Document.parse(docJson);
        convertMongoShellDates(doc);
        return doc;
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
            result.put(entry.getKey(), convertValue(entry.getValue()));
        }
        return result;
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
            case AgentProtocol.MONGO_METHOD_SERVER_VERSION -> serverVersion(params);
            case AgentProtocol.MONGO_METHOD_INSERT_DOCUMENT -> insertDocument(params);
            case AgentProtocol.MONGO_METHOD_UPDATE_DOCUMENT -> updateDocument(params);
            case AgentProtocol.MONGO_METHOD_UPDATE_DOCUMENTS -> updateDocuments(params);
            case AgentProtocol.MONGO_METHOD_DELETE_DOCUMENT -> deleteDocument(params);
            case AgentProtocol.MONGO_METHOD_DELETE_DOCUMENTS -> deleteDocuments(params);
            case AgentProtocol.METHOD_DISCONNECT, AgentProtocol.METHOD_SHUTDOWN -> {
                if (client != null) {
                    client.close();
                    client = null;
                }
                if (AgentProtocol.METHOD_SHUTDOWN.equals(method)) {
                    System.exit(0);
                }
                yield Collections.singletonMap("ok", true);
            }
            default -> throw new IllegalArgumentException("Unknown method: " + method);
        };
    }

    private static MongoClient requireClient() {
        if (client == null) {
            throw new IllegalStateException("Not connected");
        }
        return client;
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    private static String defaultString(String value, String fallback) {
        return value == null ? fallback : value;
    }

    static String handleRequest(String line) {
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
    }

    public static void main(String[] args) throws Exception {
        System.out.println("{\"ready\":true}");
        System.out.flush();

        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        while (true) {
            String line = reader.readLine();
            if (line == null) {
                break;
            }

            System.out.println(handleRequest(line));
            System.out.flush();
        }
    }
}
