package com.dbx.agent.etcd;

import com.dbx.agent.AgentProtocol;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.grpc.netty.GrpcSslContexts;
import io.etcd.jetcd.ByteSequence;
import io.etcd.jetcd.Client;
import io.etcd.jetcd.ClientBuilder;
import io.etcd.jetcd.KV;
import io.etcd.jetcd.KeyValue;
import io.etcd.jetcd.kv.DeleteResponse;
import io.etcd.jetcd.kv.GetResponse;
import io.etcd.jetcd.kv.PutResponse;
import io.etcd.jetcd.options.GetOption;
import io.etcd.jetcd.options.PutOption;
import io.netty.handler.ssl.SslContext;
import io.netty.handler.ssl.SslContextBuilder;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

public final class EtcdAgent {
    private static final Gson GSON = new Gson();
    private static final int DEFAULT_LIMIT = 100;
    private static final int RPC_TIMEOUT_SECONDS = 30;
    private static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList(
        AgentProtocol.CAPABILITY_CONNECT,
        AgentProtocol.CAPABILITY_TEST_CONNECTION,
        AgentProtocol.CAPABILITY_KV
    ));
    private static Client client;
    private static KV kv;

    private EtcdAgent() {
    }

    private static Object handshakeResult() {
        return new HandshakeResult(AgentProtocol.PROTOCOL_VERSION, AgentProtocol.PROTOCOL_VERSION, CAPABILITIES);
    }

    private static Object connect(JsonObject params) throws Exception {
        JsonObject connection = connectionObject(params);
        Client nextClient = buildClient(connection);
        nextClient.getKVClient().get(byteSequence("\0")).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        closeClient();
        client = nextClient;
        kv = client.getKVClient();
        return Collections.singletonMap("ok", true);
    }

    static Client buildClient(JsonObject connection) throws Exception {
        List<String> endpoints = endpoints(connection);
        ClientBuilder builder = Client.builder().endpoints(endpoints.toArray(String[]::new));
        String username = stringOrEmpty(connection, "username");
        String password = stringOrEmpty(connection, "password");
        if (!username.isBlank()) {
            builder.user(byteSequence(username));
            builder.password(byteSequence(password));
        }
        if (boolOrDefault(connection, "ssl", false)) {
            builder.sslContext(sslContext(connection));
        }
        return builder.build();
    }

    static List<String> endpoints(JsonObject connection) {
        String configured = firstNonBlank(
            stringOrNull(connection, "etcd_endpoints"),
            stringOrNull(connection, "endpoints"),
            stringOrNull(connection, "connection_string")
        );
        List<String> result = new ArrayList<>();
        if (configured != null) {
            for (String endpoint : configured.split("[,\\n]")) {
                String normalized = normalizeEndpoint(endpoint.trim(), boolOrDefault(connection, "ssl", false));
                if (!normalized.isBlank()) {
                    result.add(normalized);
                }
            }
        }
        if (result.isEmpty()) {
            String host = stringOrDefault(connection, "host", "127.0.0.1");
            int port = intOrDefault(connection, "port", 2379);
            result.add(normalizeEndpoint(host + ":" + port, boolOrDefault(connection, "ssl", false)));
        }
        return result;
    }

    private static String normalizeEndpoint(String endpoint, boolean tls) {
        if (endpoint.isBlank()) {
            return "";
        }
        if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
            return endpoint;
        }
        return (tls ? "https://" : "http://") + endpoint;
    }

    private static SslContext sslContext(JsonObject connection) throws Exception {
        SslContextBuilder builder = GrpcSslContexts.forClient();
        String ca = stringOrEmpty(connection, "ca_cert_path");
        if (!ca.isBlank()) {
            builder.trustManager(new File(ca));
        }
        String cert = firstNonBlank(stringOrNull(connection, "client_cert_path"), stringOrNull(connection, "cert_path"));
        String key = firstNonBlank(stringOrNull(connection, "client_key_path"), stringOrNull(connection, "key_path"));
        if ((cert == null) != (key == null)) {
            throw new IllegalArgumentException("Client certificate and key must be provided together");
        }
        if (cert != null) {
            builder.keyManager(new File(cert), new File(key));
        }
        return builder.build();
    }

    private static Object listPrefix(JsonObject params) throws Exception {
        KV active = requireKv();
        String prefix = stringOrDefault(params, "prefix", "");
        int limit = intOrDefault(params, "limit", DEFAULT_LIMIT);
        String continuation = stringOrNull(params, "continuation");
        ByteSequence start = continuation == null || continuation.isBlank()
            ? prefixStart(prefix)
            : ByteSequence.from(Base64.getDecoder().decode(continuation));
        GetOption option = GetOption.newBuilder()
            .withRange(prefixEnd(byteSequence(prefix)))
            .withLimit(Math.max(1, limit))
            .withSortField(GetOption.SortTarget.KEY)
            .withSortOrder(GetOption.SortOrder.ASCEND)
            .build();
        GetResponse response = active.get(start, option).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);

        List<Map<String, Object>> keys = new ArrayList<>();
        List<KeyValue> kvs = response.getKvs();
        for (KeyValue item : kvs) {
            Map<String, Object> row = metadata(item);
            row.put("key", displayBytes(item.getKey().getBytes()));
            keys.add(row);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("keys", keys);
        result.put("continuation", response.isMore() && !kvs.isEmpty() ? nextContinuation(kvs.get(kvs.size() - 1)) : null);
        result.put("revision", response.getHeader().getRevision());
        return result;
    }

    private static Object get(JsonObject params) throws Exception {
        KV active = requireKv();
        String key = params.get("key").getAsString();
        GetResponse response = active.get(byteSequence(key)).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        Map<String, Object> result = new LinkedHashMap<>();
        if (response.getKvs().isEmpty()) {
            result.put("found", false);
            result.put("key", null);
            result.put("value", null);
            result.put("metadata", null);
            return result;
        }
        KeyValue item = response.getKvs().get(0);
        result.put("found", true);
        result.put("key", displayBytes(item.getKey().getBytes()));
        result.put("value", valueObject(item.getValue().getBytes()));
        result.put("metadata", metadata(item));
        return result;
    }

    private static Object put(JsonObject params) throws Exception {
        KV active = requireKv();
        String key = params.get("key").getAsString();
        byte[] value = parseValue(params.getAsJsonObject("value"));
        JsonElement leaseElement = params.get("lease");
        PutResponse response;
        if (leaseElement != null && !leaseElement.isJsonNull()) {
            PutOption option = PutOption.newBuilder().withLeaseId(leaseElement.getAsLong()).build();
            response = active.put(byteSequence(key), ByteSequence.from(value), option).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } else {
            response = active.put(byteSequence(key), ByteSequence.from(value)).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        }
        return Collections.singletonMap("revision", response.getHeader().getRevision());
    }

    private static Object delete(JsonObject params) throws Exception {
        KV active = requireKv();
        DeleteResponse response =
            active.delete(byteSequence(params.get("key").getAsString())).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("deleted", response.getDeleted());
        result.put("revision", response.getHeader().getRevision());
        return result;
    }

    private static Object dispatch(String method, JsonObject params) throws Exception {
        return switch (method) {
            case AgentProtocol.METHOD_HANDSHAKE -> handshakeResult();
            case AgentProtocol.METHOD_CONNECT, AgentProtocol.METHOD_TEST_CONNECTION -> connect(params);
            case AgentProtocol.KV_METHOD_LIST_PREFIX -> listPrefix(params);
            case AgentProtocol.KV_METHOD_GET -> get(params);
            case AgentProtocol.KV_METHOD_PUT -> put(params);
            case AgentProtocol.KV_METHOD_DELETE -> delete(params);
            case AgentProtocol.METHOD_DISCONNECT -> {
                closeClient();
                yield Collections.singletonMap("ok", true);
            }
            case AgentProtocol.METHOD_SHUTDOWN -> {
                closeClient();
                System.exit(0);
                yield Collections.singletonMap("ok", true);
            }
            default -> throw new IllegalArgumentException("Unknown method: " + method);
        };
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

    private static JsonObject connectionObject(JsonObject params) {
        JsonElement connection = params.get("connection");
        return connection != null && connection.isJsonObject() ? connection.getAsJsonObject() : params;
    }

    private static KV requireKv() {
        if (kv == null) {
            throw new IllegalStateException("Not connected");
        }
        return kv;
    }

    private static void closeClient() {
        if (kv != null) {
            kv.close();
            kv = null;
        }
        if (client != null) {
            client.close();
            client = null;
        }
    }

    private static ByteSequence byteSequence(String value) {
        return ByteSequence.from(value, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static ByteSequence prefixEnd(ByteSequence prefix) {
        byte[] bytes = prefix.getBytes();
        if (bytes.length == 0) {
            return ByteSequence.from(new byte[] {0});
        }
        byte[] end = Arrays.copyOf(bytes, bytes.length);
        for (int i = end.length - 1; i >= 0; i--) {
            if ((end[i] & 0xff) < 0xff) {
                end[i]++;
                return ByteSequence.from(Arrays.copyOf(end, i + 1));
            }
        }
        return ByteSequence.from(new byte[] {0});
    }

    private static ByteSequence prefixStart(String prefix) {
        if (prefix.isEmpty()) {
            return ByteSequence.from(new byte[] {0});
        }
        return byteSequence(prefix);
    }

    private static String nextContinuation(KeyValue item) {
        byte[] key = item.getKey().getBytes();
        byte[] next = Arrays.copyOf(key, key.length + 1);
        next[next.length - 1] = 0;
        return Base64.getEncoder().encodeToString(next);
    }

    private static Map<String, Object> metadata(KeyValue item) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("createRevision", item.getCreateRevision());
        metadata.put("modRevision", item.getModRevision());
        metadata.put("version", item.getVersion());
        metadata.put("lease", item.getLease());
        metadata.put("valueSize", item.getValue().size());
        return metadata;
    }

    private static Map<String, Object> valueObject(byte[] bytes) {
        Map<String, Object> value = new LinkedHashMap<>();
        String utf8 = strictUtf8(bytes);
        if (utf8 != null) {
            value.put("encoding", "utf8");
            value.put("data", utf8);
        } else {
            value.put("encoding", "base64");
            value.put("data", Base64.getEncoder().encodeToString(bytes));
        }
        return value;
    }

    private static byte[] parseValue(JsonObject value) {
        String encoding = stringOrDefault(value, "encoding", "utf8");
        String data = stringOrDefault(value, "data", "");
        if ("base64".equals(encoding)) {
            return Base64.getDecoder().decode(data);
        }
        if (!"utf8".equals(encoding)) {
            throw new IllegalArgumentException("Unsupported value encoding: " + encoding);
        }
        return data.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    private static String displayBytes(byte[] bytes) {
        String utf8 = strictUtf8(bytes);
        return utf8 == null ? Base64.getEncoder().encodeToString(bytes) : utf8;
    }

    private static String strictUtf8(byte[] bytes) {
        CharsetDecoder decoder = java.nio.charset.StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            return decoder.decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    private static String stringOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? null : element.getAsString();
    }

    private static String stringOrEmpty(JsonObject object, String key) {
        return stringOrDefault(object, key, "");
    }

    private static String stringOrDefault(JsonObject object, String key, String fallback) {
        String value = stringOrNull(object, key);
        return value == null ? fallback : value;
    }

    private static int intOrDefault(JsonObject object, String key, int fallback) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? fallback : element.getAsInt();
    }

    private static boolean boolOrDefault(JsonObject object, String key, boolean fallback) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? fallback : element.getAsBoolean();
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
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

    private static final class HandshakeResult {
        private final int protocolVersion;
        private final int agentProtocolVersion;
        private final List<String> capabilities;

        private HandshakeResult(int protocolVersion, int agentProtocolVersion, List<String> capabilities) {
            this.protocolVersion = protocolVersion;
            this.agentProtocolVersion = agentProtocolVersion;
            this.capabilities = capabilities;
        }
    }
}
