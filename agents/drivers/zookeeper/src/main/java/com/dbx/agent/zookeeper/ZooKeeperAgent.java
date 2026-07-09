package com.dbx.agent.zookeeper;

import com.dbx.agent.AgentProtocol;
import com.google.gson.*;
import org.apache.curator.framework.CuratorFramework;
import org.apache.curator.framework.CuratorFrameworkFactory;
import org.apache.curator.retry.ExponentialBackoffRetry;
import org.apache.zookeeper.CreateMode;
import org.apache.zookeeper.KeeperException;
import org.apache.zookeeper.data.Stat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class ZooKeeperAgent {
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final int DEFAULT_LIMIT = 100;
    private static final int DEFAULT_SESSION_TIMEOUT_MS = 30000;
    private static final int DEFAULT_CONNECTION_TIMEOUT_MS = 15000;
    private static final int DEFAULT_BASE_SLEEP_TIME_MS = 1000;
    private static final int DEFAULT_MAX_RETRIES = 3;
    private static final String STAT_LOOKUP_CONCURRENCY_PROPERTY = "dbx.zookeeper.statLookupConcurrency";
    private static final String STAT_LOOKUP_CONCURRENCY_ENV = "DBX_ZOOKEEPER_STAT_LOOKUP_CONCURRENCY";
    private static final int DEFAULT_STAT_LOOKUP_CONCURRENCY = 16;
    private static final int MIN_STAT_LOOKUP_CONCURRENCY = 1;
    private static final int MAX_STAT_LOOKUP_CONCURRENCY = 64;
    private static final int STAT_LOOKUP_CONCURRENCY = configuredStatLookupConcurrency();
    private static final ExecutorService STAT_LOOKUP_EXECUTOR = Executors.newFixedThreadPool(
        STAT_LOOKUP_CONCURRENCY,
        daemonThreadFactory("dbx-zookeeper-stat-lookup-")
    );
    private static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList(
        AgentProtocol.CAPABILITY_CONNECT,
        AgentProtocol.CAPABILITY_TEST_CONNECTION,
        AgentProtocol.CAPABILITY_KV
    ));
    private static CuratorFramework client;

    private ZooKeeperAgent() {
    }

    private static Object handshakeResult() {
        return new HandshakeResult(AgentProtocol.PROTOCOL_VERSION, AgentProtocol.PROTOCOL_VERSION, CAPABILITIES);
    }

    private static Object connect(JsonObject params) throws Exception {
        JsonObject connection = connectionObject(params);
        CuratorFramework nextClient = buildClient(connection);
        try {
            startAndVerify(nextClient, connection);
            closeClient();
            client = nextClient;
            return Collections.singletonMap("ok", true);
        } catch (Exception e) {
            nextClient.close();
            throw e;
        }
    }

    private static Object testConnection(JsonObject params) throws Exception {
        JsonObject connection = connectionObject(params);
        CuratorFramework probe = buildClient(connection);
        try {
            startAndVerify(probe, connection);
            return Collections.singletonMap("ok", true);
        } finally {
            probe.close();
        }
    }

    static CuratorFramework buildClient(JsonObject connection) {
        if (hasTlsOptions(connection)) {
            throw new IllegalArgumentException("ZooKeeper TLS is not supported");
        }

        int baseSleepTimeMs = intOrDefault(connection, "base_sleep_time_ms", DEFAULT_BASE_SLEEP_TIME_MS);
        int maxRetries = intOrDefault(connection, "max_retries", DEFAULT_MAX_RETRIES);
        CuratorFrameworkFactory.Builder builder = CuratorFrameworkFactory.builder()
            .connectString(connectString(connection))
            .sessionTimeoutMs(intOrDefault(connection, "session_timeout_ms", DEFAULT_SESSION_TIMEOUT_MS))
            .connectionTimeoutMs(intOrDefault(connection, "connection_timeout_ms", DEFAULT_CONNECTION_TIMEOUT_MS))
            .retryPolicy(new ExponentialBackoffRetry(baseSleepTimeMs, maxRetries));

        String namespace = trimSlashes(stringOrEmpty(connection, "namespace"));
        if (!namespace.isBlank()) {
            builder.namespace(namespace);
        }

        String username = stringOrEmpty(connection, "username");
        String password = stringOrEmpty(connection, "password");
        if (!username.isBlank()) {
            builder.authorization("digest", (username + ":" + password).getBytes(StandardCharsets.UTF_8));
        }

        return builder.build();
    }

    static String connectString(JsonObject connection) {
        String configured = firstNonBlank(
            stringOrNull(connection, "zookeeper_connect_string"),
            stringOrNull(connection, "connect_string"),
            stringOrNull(connection, "connection_string")
        );
        if (configured != null) {
            return configured;
        }
        return stringOrDefault(connection, "host", "127.0.0.1") + ":"
            + intOrDefault(connection, "port", 2181);
    }

    private static void startAndVerify(CuratorFramework active, JsonObject connection) throws Exception {
        active.start();
        int timeoutMs = intOrDefault(connection, "connection_timeout_ms", DEFAULT_CONNECTION_TIMEOUT_MS);
        if (!active.blockUntilConnected(timeoutMs, TimeUnit.MILLISECONDS)) {
            throw new IllegalStateException("Connection timed out");
        }
        if (active.checkExists().forPath("/") == null) {
            throw new IllegalStateException("Root znode is not readable");
        }
    }

    private static Object listPrefix(JsonObject params) throws Exception {
        CuratorFramework active = requireClient();
        String root = normalizePath(stringOrDefault(params, "prefix", "/"));
        boolean recursive = boolOrDefault(params, "recursive", true);
        int limit = Math.max(1, intOrDefault(params, "limit", DEFAULT_LIMIT));
        Cursor cursor = null;
        String continuation = stringOrNull(params, "continuation");
        if (continuation != null && !continuation.isBlank()) {
            cursor = decodeCursor(continuation);
            if (!root.equals(cursor.root) || recursive != cursor.recursive) {
                throw new IllegalArgumentException("Continuation does not match request");
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        List<Map<String, Object>> keys = new ArrayList<>();
        Stat rootStat = active.checkExists().forPath(root);
        if (rootStat == null) {
            result.put("keys", keys);
            result.put("continuation", null);
            return result;
        }

        List<String> paths = recursive ? listRecursive(active, root) : listDirectChildren(active, root);
        Collections.sort(paths);
        int offset = cursor == null ? 0 : Math.max(0, cursor.offset);
        int end = Math.min(paths.size(), offset + limit);
        keys.addAll(listRowsWithMetadata(active, paths.subList(offset, end)));

        result.put("keys", keys);
        result.put("continuation", end < paths.size() ? encodeCursor(new Cursor(root, recursive, end)) : null);
        return result;
    }

    private static Object get(JsonObject params) throws Exception {
        CuratorFramework active = requireClient();
        String path = normalizePath(stringOrDefault(params, "key", ""));
        Map<String, Object> result = new LinkedHashMap<>();
        Stat exists = active.checkExists().forPath(path);
        if (exists == null) {
            result.put("found", false);
            result.put("key", path);
            result.put("value", null);
            result.put("metadata", null);
            return result;
        }

        Stat stat = new Stat();
        byte[] bytes = active.getData().storingStatIn(stat).forPath(path);
        result.put("found", true);
        result.put("key", path);
        result.put("value", valueObject(bytes));
        result.put("metadata", statMetadata(stat));
        return result;
    }

    private static Object put(JsonObject params) throws Exception {
        CuratorFramework active = requireClient();
        String path = normalizePath(stringOrDefault(params, "key", ""));
        requireMutablePath(path, "modified");
        byte[] bytes = parseValue(params.getAsJsonObject("value"));

        String writeMode = stringOrDefault(params, "writeMode", "upsert");
        return switch (writeMode) {
            case "create" -> create(active, path, bytes, createMode(params));
            case "update" -> update(active, path, bytes);
            case "upsert" -> upsert(active, path, bytes);
            default -> throw new IllegalArgumentException("Unsupported writeMode: " + writeMode);
        };
    }

    private static Object upsert(CuratorFramework active, String path, byte[] bytes) throws Exception {
        Stat stat = active.checkExists().forPath(path);
        if (stat == null) {
            active.create().creatingParentsIfNeeded().forPath(path, bytes);
            stat = active.checkExists().forPath(path);
        } else {
            stat = active.setData().forPath(path, bytes);
        }
        return putResult(stat);
    }

    private static Object create(CuratorFramework active, String path, byte[] bytes, CreateMode createMode) throws Exception {
        String createdPath = active.create()
            .creatingParentsIfNeeded()
            .withMode(createMode)
            .forPath(path, bytes);
        Stat stat = active.checkExists().forPath(createdPath);
        Map<String, Object> result = putResult(stat);
        result.put("key", createdPath);
        result.put("createdKey", createdPath);
        return result;
    }

    private static Object update(CuratorFramework active, String path, byte[] bytes) throws Exception {
        return putResult(active.setData().forPath(path, bytes));
    }

    private static Map<String, Object> putResult(Stat stat) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("version", stat.getVersion());
        result.put("mtime", stat.getMtime());
        return result;
    }

    private static CreateMode createMode(JsonObject params) {
        String createMode = stringOrDefault(params, "createMode", "persistent");
        return switch (createMode) {
            case "persistent" -> CreateMode.PERSISTENT;
            case "ephemeral" -> CreateMode.EPHEMERAL;
            case "persistent_sequential" -> CreateMode.PERSISTENT_SEQUENTIAL;
            case "ephemeral_sequential" -> CreateMode.EPHEMERAL_SEQUENTIAL;
            default -> throw new IllegalArgumentException("Unsupported createMode: " + createMode);
        };
    }

    private static Object delete(JsonObject params) throws Exception {
        CuratorFramework active = requireClient();
        String path = normalizePath(stringOrDefault(params, "key", ""));
        requireMutablePath(path, "deleted");
        boolean recursive = boolOrDefault(params, "recursive", false);
        int deleted;
        try {
            if (active.checkExists().forPath(path) == null) {
                deleted = 0;
            } else if (recursive) {
                deleted = countSubtree(active, path);
                active.delete().deletingChildrenIfNeeded().forPath(path);
            } else {
                active.delete().forPath(path);
                deleted = 1;
            }
        } catch (KeeperException.NoNodeException e) {
            deleted = 0;
        }
        return Collections.singletonMap("deleted", deleted);
    }

    private static Object dispatch(String method, JsonObject params) throws Exception {
        return switch (method) {
            case AgentProtocol.METHOD_HANDSHAKE -> handshakeResult();
            case AgentProtocol.METHOD_CONNECT -> connect(params);
            case AgentProtocol.METHOD_TEST_CONNECTION -> testConnection(params);
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
                STAT_LOOKUP_EXECUTOR.shutdownNow();
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

    private static CuratorFramework requireClient() {
        if (client == null) {
            throw new IllegalStateException("Not connected");
        }
        return client;
    }

    private static void closeClient() {
        if (client != null) {
            client.close();
            client = null;
        }
    }

    static String normalizePath(String path) {
        String normalized = path == null ? "" : path;
        if (normalized.isEmpty() || "/".equals(normalized)) {
            return "/";
        }
        if (!normalized.startsWith("/")) {
            normalized = "/" + normalized;
        }
        while (normalized.length() > 1 && normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    private static String childPath(String parent, String child) {
        return "/".equals(parent) ? "/" + child : parent + "/" + child;
    }

    private static void requireMutablePath(String path, String action) {
        if ("/".equals(path)) {
            throw new IllegalArgumentException("Root znode cannot be " + action);
        }
    }

    private static Map<String, Object> statMetadata(Stat stat) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        long czxid = stat.getCzxid();
        long mzxid = stat.getMzxid();
        long pzxid = stat.getPzxid();
        int dataLength = stat.getDataLength();
        metadata.put("czxid", czxid);
        metadata.put("mzxid", mzxid);
        metadata.put("pzxid", pzxid);
        metadata.put("ctime", stat.getCtime());
        metadata.put("mtime", stat.getMtime());
        metadata.put("version", stat.getVersion());
        metadata.put("cversion", stat.getCversion());
        metadata.put("aversion", stat.getAversion());
        metadata.put("ephemeralOwner", stat.getEphemeralOwner());
        metadata.put("dataLength", dataLength);
        metadata.put("numChildren", stat.getNumChildren());
        metadata.put("createRevision", czxid);
        metadata.put("modRevision", mzxid);
        metadata.put("valueSize", dataLength);
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
        if (value == null) {
            return new byte[0];
        }
        String encoding = stringOrDefault(value, "encoding", "utf8");
        String data = stringOrDefault(value, "data", "");
        if ("base64".equals(encoding)) {
            return Base64.getDecoder().decode(data);
        }
        if (!"utf8".equals(encoding)) {
            throw new IllegalArgumentException("Unsupported value encoding: " + encoding);
        }
        return data.getBytes(StandardCharsets.UTF_8);
    }

    private static String strictUtf8(byte[] bytes) {
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            return decoder.decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    private static String encodeCursor(Cursor cursor) {
        JsonObject object = new JsonObject();
        object.addProperty("root", cursor.root);
        object.addProperty("recursive", cursor.recursive);
        object.addProperty("offset", cursor.offset);
        return Base64.getEncoder().encodeToString(GSON.toJson(object).getBytes(StandardCharsets.UTF_8));
    }

    private static Cursor decodeCursor(String continuation) {
        String json = new String(Base64.getDecoder().decode(continuation), StandardCharsets.UTF_8);
        JsonObject object = JsonParser.parseString(json).getAsJsonObject();
        return new Cursor(
            object.get("root").getAsString(),
            object.get("recursive").getAsBoolean(),
            object.get("offset").getAsInt()
        );
    }

    private static List<String> listDirectChildren(CuratorFramework active, String root) throws Exception {
        List<String> paths = new ArrayList<>();
        List<String> children = new ArrayList<>(active.getChildren().forPath(root));
        Collections.sort(children);
        for (String child : children) {
            paths.add(childPath(root, child));
        }
        return paths;
    }

    private static List<String> listRecursive(CuratorFramework active, String root) throws Exception {
        List<String> result = new ArrayList<>();
        collectRecursive(active, root, result);
        return result;
    }

    private static List<Map<String, Object>> listRowsWithMetadata(CuratorFramework active, List<String> paths) throws Exception {
        if (paths.isEmpty()) {
            return Collections.emptyList();
        }

        try {
            List<Future<Map<String, Object>>> futures = new ArrayList<>();
            for (String path : paths) {
                futures.add(STAT_LOOKUP_EXECUTOR.submit(() -> rowWithMetadata(active, path)));
            }

            List<Map<String, Object>> rows = new ArrayList<>();
            for (Future<Map<String, Object>> future : futures) {
                Map<String, Object> row = future.get();
                if (row != null) {
                    rows.add(row);
                }
            }
            return rows;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw e;
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception exception) {
                throw exception;
            }
            if (cause instanceof Error error) {
                throw error;
            }
            throw new RuntimeException(cause);
        }
    }

    private static Map<String, Object> rowWithMetadata(CuratorFramework active, String path) throws Exception {
        try {
            Stat stat = active.checkExists().forPath(path);
            if (stat == null) {
                return null;
            }
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", path);
            row.putAll(statMetadata(stat));
            return row;
        } catch (KeeperException.NoNodeException e) {
            return null;
        }
    }

    private static void collectRecursive(CuratorFramework active, String path, List<String> result) throws Exception {
        List<String> children;
        try {
            children = new ArrayList<>(active.getChildren().forPath(path));
        } catch (KeeperException.NoNodeException e) {
            return;
        }
        Collections.sort(children);
        for (String child : children) {
            String childPath = childPath(path, child);
            result.add(childPath);
            collectRecursive(active, childPath, result);
        }
    }

    private static int countSubtree(CuratorFramework active, String path) throws Exception {
        try {
            if (active.checkExists().forPath(path) == null) {
                return 0;
            }
            int count = 1;
            for (String child : active.getChildren().forPath(path)) {
                count += countSubtree(active, childPath(path, child));
            }
            return count;
        } catch (KeeperException.NoNodeException e) {
            return 0;
        }
    }

    private static boolean hasTlsOptions(JsonObject connection) {
        return boolOrDefault(connection, "ssl", false)
            || firstNonBlank(
                stringOrNull(connection, "ca_cert_path"),
                stringOrNull(connection, "client_cert_path"),
                stringOrNull(connection, "client_key_path"),
                stringOrNull(connection, "cert_path"),
                stringOrNull(connection, "key_path")
            ) != null;
    }

    private static String trimSlashes(String value) {
        String trimmed = value.trim();
        while (trimmed.startsWith("/")) {
            trimmed = trimmed.substring(1);
        }
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
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

    static int configuredStatLookupConcurrency(String propertyValue, String envValue) {
        String configured = firstNonBlank(propertyValue, envValue);
        if (configured == null) {
            return DEFAULT_STAT_LOOKUP_CONCURRENCY;
        }
        try {
            int parsed = Integer.parseInt(configured.trim());
            return Math.max(MIN_STAT_LOOKUP_CONCURRENCY, Math.min(MAX_STAT_LOOKUP_CONCURRENCY, parsed));
        } catch (NumberFormatException e) {
            return DEFAULT_STAT_LOOKUP_CONCURRENCY;
        }
    }

    private static int configuredStatLookupConcurrency() {
        return configuredStatLookupConcurrency(
            System.getProperty(STAT_LOOKUP_CONCURRENCY_PROPERTY),
            System.getenv(STAT_LOOKUP_CONCURRENCY_ENV)
        );
    }

    private static ThreadFactory daemonThreadFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger(1);
        return runnable -> {
            Thread thread = new Thread(runnable, prefix + sequence.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        };
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
        // Entry point for the standalone DBX agent process.
        System.setProperty("org.slf4j.simpleLogger.logFile", "System.err");
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

    private static final class Cursor {
        private final String root;
        private final boolean recursive;
        private final int offset;

        private Cursor(String root, boolean recursive, int offset) {
            this.root = root;
            this.recursive = recursive;
            this.offset = offset;
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
