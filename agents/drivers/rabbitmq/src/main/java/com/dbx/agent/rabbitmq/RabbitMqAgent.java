package com.dbx.agent.rabbitmq;

import com.google.gson.*;
import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Address;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import com.rabbitmq.client.GetResponse;
import com.rabbitmq.client.ShutdownSignalException;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * RabbitMQ admin agent for DBX. Communicates with the Rust bridge via JSON-RPC
 * over stdin/stdout. Uses the RabbitMQ AMQP Java client for queue operations
 * and the HTTP management API (when available) for queue listing.
 */
public final class RabbitMqAgent {

    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final int DEFAULT_PORT = 5672;
    private static final int DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
    private static final int DEFAULT_MANAGEMENT_PORT = 15672;
    private static final int DEFAULT_MANAGEMENT_TLS_PORT = 15671;
    private static final int MAX_PEEK_MESSAGES = 10_000;

    private static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList(
        "mq_connect", "mq_test_connection", "mq_topics",
        "mq_messages", "mq_config", "mq_monitoring", "mq_exchanges",
        "mq_client_connections", "mq_user_permissions", "mq_policies"
    ));

    private static Connection connection;
    private static Channel channel;
    private static JsonObject cachedConnection;
    // Lazily created AMQP clients for virtual hosts other than the connection's
    // default vhost; AMQP connections are scoped to a single vhost, so each
    // extra vhost needs its own connection/channel pair.
    private static final Map<String, VhostClient> vhostClients = new HashMap<>();
    private static volatile boolean shutdownRequested;

    private RabbitMqAgent() {}

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    public static void main(String[] args) throws Exception {
        System.setProperty("org.slf4j.simpleLogger.logFile", "System.err");
        // The JSON-RPC pipe with the Rust bridge is UTF-8; relying on the
        // platform default charset mangles non-ASCII payloads on Windows.
        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        out.println("{\"ready\":true}");
        out.flush();

        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        while (true) {
            String line = reader.readLine();
            if (line == null) break;
            String response = handleRequest(line);
            out.println(response);
            out.flush();
            if (shutdownRequested) {
                System.exit(0);
            }
        }
    }

    // -----------------------------------------------------------------------
    // JSON-RPC dispatch
    // -----------------------------------------------------------------------

    static String handleRequest(String line) {
        JsonObject response = new JsonObject();
        response.addProperty("jsonrpc", "2.0");
        try {
            // Parse and extract inside the try: a malformed request must yield
            // a JSON-RPC error (with a null id), never kill the agent process.
            JsonObject req = JsonParser.parseString(line).getAsJsonObject();
            JsonElement id = req.get("id");
            response.add("id", id != null ? id : JsonNull.INSTANCE);
            String method = req.get("method").getAsString();
            JsonObject params = req.has("params") && req.get("params").isJsonObject()
                ? req.getAsJsonObject("params") : new JsonObject();

            Object result = dispatch(method, params);
            response.add("result", GSON.toJsonTree(result));
        } catch (Exception e) {
            if (!response.has("id")) {
                response.add("id", JsonNull.INSTANCE);
            }
            JsonObject error = new JsonObject();
            error.addProperty("code", -1);
            error.addProperty("message", normalizeErrorMessage(e));
            response.add("error", error);
        }
        return GSON.toJson(response);
    }

    /**
     * Operations that act on a single vhost-scoped resource. The {@code all_vhosts}
     * sentinel only makes sense for cluster-wide listings; for these methods it
     * must fail fast instead of silently falling back to the default vhost.
     */
    private static final Set<String> ALL_VHOSTS_UNSUPPORTED_METHODS = Set.of(
        "mq_create_topic", "mq_delete_topic", "mq_purge_queue", "mq_send_message",
        "mq_bind", "mq_unbind", "mq_create_exchange", "mq_delete_exchange",
        "mq_peek_messages", "mq_get_topic_stats", "mq_list_consumers", "mq_close_connection",
        "mq_grant_permission", "mq_revoke_permission", "mq_set_policy", "mq_delete_policy");

    private static Object dispatch(String method, JsonObject params) throws Exception {
        if (ALL_VHOSTS_UNSUPPORTED_METHODS.contains(method) && allVhostsRequested(params)) {
            throw new IllegalArgumentException("all_vhosts is only supported for list operations");
        }
        return switch (method) {
            case "handshake" -> handshakeResult();
            case "connect" -> connect(params);
            case "test_connection" -> testConnection(params);
            case "disconnect" -> { closeClients(); yield Collections.singletonMap("ok", true); }
            case "shutdown" -> { closeClients(); shutdownRequested = true; yield Collections.singletonMap("ok", true); }
            // Topic (queue) management
            case "mq_list_topics" -> listTopics(params);
            case "mq_create_topic" -> createTopic(params);
            case "mq_delete_topic" -> deleteTopic(params);
            case "mq_get_topic_stats" -> getTopicStats(params);
            case "mq_get_topic_config" -> getTopicConfig(params);
            case "mq_alter_topic_config" -> alterTopicConfig(params);
            case "mq_purge_queue" -> purgeQueue(params);
            case "mq_list_consumers" -> listConsumers(params);
            // Namespaces (virtual hosts)
            case "mq_list_namespaces" -> listNamespaces(params);
            case "mq_create_namespace" -> createNamespace(params);
            case "mq_delete_namespace" -> deleteNamespace(params);
            // Exchanges & bindings
            case "mq_list_exchanges" -> listExchanges(params);
            case "mq_create_exchange" -> createExchange(params);
            case "mq_delete_exchange" -> deleteExchange(params);
            case "mq_list_bindings" -> listBindings(params);
            case "mq_bind" -> bind(params);
            case "mq_unbind" -> unbind(params);
            // Client connections & channels
            case "mq_list_connections" -> listClientConnections(params);
            case "mq_list_channels" -> listClientChannels(params);
            case "mq_close_connection" -> closeClientConnection(params);
            // Users & permissions
            case "mq_list_users" -> listUsers(params);
            case "mq_create_user" -> createUser(params);
            case "mq_delete_user" -> deleteUser(params);
            case "mq_list_permissions" -> listPermissions(params);
            case "mq_grant_permission" -> grantPermission(params);
            case "mq_revoke_permission" -> revokePermission(params);
            // Policies
            case "mq_list_policies" -> listPolicies(params);
            case "mq_set_policy" -> setPolicy(params);
            case "mq_delete_policy" -> deletePolicy(params);
            // Messages
            case "mq_peek_messages" -> peekMessages(params);
            case "mq_send_message" -> sendMessage(params);
            // Cluster / monitoring
            case "mq_describe_cluster" -> describeCluster(params);
            case "mq_overview" -> getOverview(params);
            case "mq_list_nodes" -> listNodes(params);
            default -> throw new IllegalArgumentException("Unknown method: " + method);
        };
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    private static Object handshakeResult() {
        return new HandshakeResult(1, 1, CAPABILITIES);
    }

    private static Object connect(JsonObject params) throws Exception {
        JsonObject conn = connectionObject(params);
        Connection nextConnection = null;
        Channel nextChannel = null;
        try {
            nextConnection = openConnection(conn);
            nextChannel = nextConnection.createChannel();
            closeClients();
            connection = nextConnection;
            channel = nextChannel;
            cachedConnection = conn.deepCopy();
            return Collections.singletonMap("ok", true);
        } catch (Exception e) {
            closeQuietly(nextChannel);
            closeQuietly(nextConnection);
            throw e;
        }
    }

    private static Object testConnection(JsonObject params) throws Exception {
        JsonObject conn = connectionObject(params);
        Connection probe = null;
        try {
            probe = openConnection(conn);
            Map<String, Object> serverProps = probe.getServerProperties();

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("ok", true);
            result.put("product", serverString(serverProps, "product"));
            result.put("version", serverString(serverProps, "version"));
            result.put("serverVersion", serverString(serverProps, "version"));
            result.put("clusterName", serverString(serverProps, "cluster_name"));
            result.put("platform", serverString(serverProps, "platform"));
            return result;
        } finally {
            closeQuietly(probe);
        }
    }

    private static void closeClients() {
        for (VhostClient client : vhostClients.values()) {
            client.closeQuietly();
        }
        vhostClients.clear();
        closeQuietly(channel);
        channel = null;
        closeQuietly(connection);
        connection = null;
        cachedConnection = null;
    }

    private static void closeQuietly(Channel ch) {
        if (ch != null) {
            try {
                ch.close();
            } catch (Exception ignored) {}
        }
    }

    private static void closeQuietly(Connection conn) {
        if (conn != null) {
            try {
                conn.close();
            } catch (Exception ignored) {}
        }
    }

    // -----------------------------------------------------------------------
    // Client builders
    // -----------------------------------------------------------------------

    private static Connection openConnection(JsonObject conn) throws Exception {
        ConnectionFactory factory = buildConnectionFactory(conn);
        List<Address> addresses = resolveAddresses(conn);
        return factory.newConnection(addresses);
    }

    static ConnectionFactory buildConnectionFactory(JsonObject conn) throws Exception {
        ConnectionFactory factory = new ConnectionFactory();
        factory.setUsername(credentialOrGuest(conn, "username"));
        factory.setPassword(credentialOrGuest(conn, "password"));
        factory.setVirtualHost(stringOrDefault(conn, "virtual_host", "/"));
        factory.setConnectionTimeout(intOrDefault(conn, "request_timeout_ms", DEFAULT_REQUEST_TIMEOUT_MS));
        applyTlsSettings(conn, factory);
        applyExtraProperties(conn, factory);
        return factory;
    }

    static void applyTlsSettings(JsonObject conn, ConnectionFactory factory) throws Exception {
        JsonObject tls = conn.has("tls") && conn.get("tls").isJsonObject()
            ? conn.getAsJsonObject("tls") : null;
        boolean tlsEnabled = tls != null
            || boolOrDefault(conn, "tls_skip_verify", false)
            || boolProperty(conn, "ssl")
            || boolProperty(conn, "tls");
        if (!tlsEnabled) {
            return;
        }
        boolean skipVerify = tlsSkipVerify(conn);
        if (skipVerify) {
            factory.useSslProtocol(trustAllSslContext());
        } else {
            factory.useSslProtocol();
            factory.enableHostnameVerification();
        }
    }

    static void applyExtraProperties(JsonObject conn, ConnectionFactory factory) {
        JsonObject properties = conn.has("properties") && conn.get("properties").isJsonObject()
            ? conn.getAsJsonObject("properties") : null;
        if (properties == null) {
            return;
        }
        Integer heartbeat = integerProperty(properties, "requested_heartbeat");
        if (heartbeat != null) {
            factory.setRequestedHeartbeat(heartbeat);
        }
        Integer connectionTimeout = integerProperty(properties, "connection_timeout_ms");
        if (connectionTimeout != null) {
            factory.setConnectionTimeout(connectionTimeout);
        }
        Integer handshakeTimeout = integerProperty(properties, "handshake_timeout_ms");
        if (handshakeTimeout != null) {
            factory.setHandshakeTimeout(handshakeTimeout);
        }
        Boolean automaticRecovery = booleanProperty(properties, "automatic_recovery");
        if (automaticRecovery != null) {
            factory.setAutomaticRecoveryEnabled(automaticRecovery);
        }
        Boolean topologyRecovery = booleanProperty(properties, "topology_recovery");
        if (topologyRecovery != null) {
            factory.setTopologyRecoveryEnabled(topologyRecovery);
        }
    }

    /**
     * Parse the {@code addresses} connection parameter: a comma-separated list of
     * {@code host[:port]} entries. Bare hosts fall back to {@code defaultPort}
     * (the {@code port} connection parameter, defaulting to 5672).
     */
    static List<Address> resolveAddresses(JsonObject conn) {
        String addresses = stringOrEmpty(conn, "addresses");
        if (addresses.isBlank()) {
            addresses = stringOrEmpty(conn, "host");
        }
        if (addresses.isBlank()) {
            throw new IllegalArgumentException("addresses is required");
        }
        return parseAddresses(addresses, intOrDefault(conn, "port", DEFAULT_PORT));
    }

    static List<Address> parseAddresses(String addresses, int defaultPort) {
        List<Address> result = new ArrayList<>();
        for (String part : addresses.split(",")) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            int colon = trimmed.lastIndexOf(':');
            if (colon > 0 && colon < trimmed.length() - 1) {
                result.add(new Address(trimmed.substring(0, colon), Integer.parseInt(trimmed.substring(colon + 1))));
            } else {
                result.add(new Address(trimmed, defaultPort));
            }
        }
        if (result.isEmpty()) {
            throw new IllegalArgumentException("addresses is required");
        }
        return result;
    }

    /** Whether the connection config asks to skip TLS certificate verification. */
    static boolean tlsSkipVerify(JsonObject conn) {
        JsonObject tls = conn.has("tls") && conn.get("tls").isJsonObject()
            ? conn.getAsJsonObject("tls") : null;
        return boolOrDefault(conn, "tls_skip_verify", false)
            || (tls != null && boolOrDefault(tls, "skip_verify", false));
    }

    private static SSLContext trustAllSslContext() throws Exception {
        TrustManager[] trustAll = new TrustManager[] {
            new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trustAll, new SecureRandom());
        return context;
    }

    // -----------------------------------------------------------------------
    // Topic (queue) management
    // -----------------------------------------------------------------------

    private static Object listTopics(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        boolean allVhosts = allVhostsRequested(params);
        JsonArray queues = managementGetAll(conn, managementListPath(params, conn, "queues"));

        List<Map<String, Object>> topics = new ArrayList<>();
        for (JsonElement element : queues) {
            JsonObject queue = element.getAsJsonObject();
            Map<String, Object> topic = new LinkedHashMap<>();
            topic.put("name", stringOrEmpty(queue, "name"));
            topic.put("durable", boolOrDefault(queue, "durable", false));
            topic.put("autoDelete", boolOrDefault(queue, "auto_delete", false));
            topic.put("state", stringOrEmpty(queue, "state"));
            topic.put("messages", longOrDefault(queue, "messages", 0));
            topic.put("consumers", longOrDefault(queue, "consumers", 0));
            if (allVhosts) {
                attachVhost(topic, queue);
            }
            topics.add(topic);
        }
        topics.sort(Comparator.comparing(m -> (String) m.get("name")));
        return Collections.singletonMap("topics", topics);
    }

    private static Object createTopic(JsonObject params) throws Exception {
        Channel ch = channelFor(params);
        String name = queueName(params);
        boolean durable = boolOrDefault(params, "durable", true);

        Map<String, Object> arguments = new HashMap<>();
        JsonObject configs = params.has("configs") && params.get("configs").isJsonObject()
            ? params.getAsJsonObject("configs") : null;
        if (configs != null) {
            for (Map.Entry<String, JsonElement> entry : configs.entrySet()) {
                Object value = argumentValue(entry.getValue());
                if (value != null) {
                    arguments.put(entry.getKey(), value);
                }
            }
        }

        ch.queueDeclare(name, durable, false, false, arguments);
        return Collections.singletonMap("ok", true);
    }

    private static Object deleteTopic(JsonObject params) throws Exception {
        Channel ch = channelFor(params);
        ch.queueDelete(queueName(params));
        return Collections.singletonMap("ok", true);
    }

    private static Object getTopicStats(JsonObject params) throws Exception {
        String name = queueName(params);

        // Prefer the management API: it is read-only and works for exclusive
        // queues, whereas a passive declare on an exclusive queue owned by
        // another connection fails with 405 RESOURCE_LOCKED and the broker
        // force-closes the channel.
        JsonObject conn = currentConnectionConfig(params);
        if (conn != null) {
            String vhost = effectiveVhost(params, conn);
            try {
                JsonElement queue = managementGet(conn,
                    "/api/queues/" + urlEncodeVhost(vhost) + "/" + urlEncodePathSegment(name));
                if (queue.isJsonObject()) {
                    JsonObject info = queue.getAsJsonObject();
                    long messages = longOrDefault(info, "messages", 0);
                    Map<String, Object> result = new LinkedHashMap<>();
                    result.put("name", name);
                    result.put("messageCount", messages);
                    result.put("consumerCount", longOrDefault(info, "consumers", 0));
                    result.put("totalMessages", messages);
                    return result;
                }
            } catch (Exception managementError) {
                System.err.println("Management API unavailable for queue stats, "
                    + "falling back to passive declare: " + managementError.getMessage());
            }
        }

        Channel ch = channelFor(params);
        AMQP.Queue.DeclareOk declared = ch.queueDeclarePassive(name);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", name);
        result.put("messageCount", declared.getMessageCount());
        result.put("consumerCount", declared.getConsumerCount());
        result.put("totalMessages", declared.getMessageCount());
        return result;
    }

    private static Object getTopicConfig(JsonObject params) throws Exception {
        Channel ch = channelFor(params);
        String name = queueName(params);

        Map<String, Object> configs = new LinkedHashMap<>();
        JsonObject conn = currentConnectionConfig(params);
        if (conn != null) {
            String vhost = effectiveVhost(params, conn);
            try {
                JsonElement queue = managementGet(conn,
                    "/api/queues/" + urlEncodeVhost(vhost) + "/" + urlEncodePathSegment(name));
                if (queue.isJsonObject()) {
                    JsonObject info = queue.getAsJsonObject();
                    configs.put("durable", boolOrDefault(info, "durable", false));
                    configs.put("auto_delete", boolOrDefault(info, "auto_delete", false));
                    configs.put("exclusive", boolOrDefault(info, "exclusive", false));
                    if (info.has("arguments") && info.get("arguments").isJsonObject()) {
                        for (Map.Entry<String, JsonElement> entry : info.getAsJsonObject("arguments").entrySet()) {
                            configs.put(entry.getKey(), entry.getValue().isJsonNull()
                                ? null : entry.getValue().getAsString());
                        }
                    }
                }
            } catch (Exception managementError) {
                System.err.println("Management API unavailable for queue config: " + managementError.getMessage());
            }
        }

        // Fall back to a passive declare so the call still verifies the queue exists.
        if (configs.isEmpty()) {
            ch.queueDeclarePassive(name);
        }
        return Collections.singletonMap("configs", configs);
    }

    private static Object alterTopicConfig(JsonObject params) {
        throw new UnsupportedOperationException(
            "RabbitMQ queue arguments are immutable after declaration; delete and re-declare the queue to change them");
    }

    private static Object purgeQueue(JsonObject params) throws Exception {
        String name = queueName(params);
        Channel ch = channelFor(params);
        AMQP.Queue.PurgeOk purged = ch.queuePurge(name);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", true);
        result.put("purged", purged.getMessageCount());
        return result;
    }

    private static Object listConsumers(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        String name = queueName(params);
        String vhost = effectiveVhost(params, conn);
        JsonElement queue = managementGet(conn,
            "/api/queues/" + urlEncodeVhost(vhost) + "/" + urlEncodePathSegment(name));
        if (!queue.isJsonObject()) {
            throw new IllegalStateException("Unexpected management API response for queue details");
        }
        return Collections.singletonMap("consumers", consumersFromQueueInfo(queue.getAsJsonObject()));
    }

    /**
     * Map the management API queue detail's {@code consumer_details} array to the
     * bridge's consumer shape. A queue without consumers may omit the array
     * entirely, which maps to an empty list.
     */
    static List<Map<String, Object>> consumersFromQueueInfo(JsonObject info) {
        List<Map<String, Object>> consumers = new ArrayList<>();
        JsonElement details = info.get("consumer_details");
        if (details == null || !details.isJsonArray()) {
            return consumers;
        }
        for (JsonElement element : details.getAsJsonArray()) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject consumer = element.getAsJsonObject();
            Map<String, Object> entry = new LinkedHashMap<>();
            String channelName = "";
            JsonElement channelDetails = consumer.get("channel_details");
            if (channelDetails != null && channelDetails.isJsonObject()) {
                channelName = stringOrEmpty(channelDetails.getAsJsonObject(), "name");
            }
            entry.put("name", channelName);
            entry.put("tag", stringOrEmpty(consumer, "consumer_tag"));
            entry.put("active", boolOrDefault(consumer, "active", false));
            entry.put("ackRequired", boolOrDefault(consumer, "ack_required", false));
            Integer prefetch = integerOrNull(consumer, "prefetch_count");
            if (prefetch != null) {
                entry.put("prefetch", prefetch);
            }
            consumers.add(entry);
        }
        return consumers;
    }

    // -----------------------------------------------------------------------
    // Namespaces (virtual hosts)
    // -----------------------------------------------------------------------

    private static Object listNamespaces(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        JsonElement vhosts = managementGet(conn, "/api/vhosts");
        if (!vhosts.isJsonArray()) {
            throw new IllegalStateException("Unexpected management API response for vhost listing");
        }

        List<Map<String, Object>> namespaces = new ArrayList<>();
        for (JsonElement element : vhosts.getAsJsonArray()) {
            if (!element.isJsonObject()) {
                continue;
            }
            namespaces.add(Collections.singletonMap("name", stringOrEmpty(element.getAsJsonObject(), "name")));
        }
        return Collections.singletonMap("namespaces", namespaces);
    }

    private static Object createNamespace(JsonObject params) throws Exception {
        String namespace = namespaceName(params);
        JsonObject conn = requireConnectionConfig(params);
        managementSend(conn, "PUT", "/api/vhosts/" + urlEncodeVhost(namespace));
        return Collections.singletonMap("ok", true);
    }

    private static Object deleteNamespace(JsonObject params) throws Exception {
        String namespace = namespaceName(params);
        // The default vhost is protected even before checking connectivity, so
        // the guard error is semantic rather than a connection failure.
        assertNamespaceDeletable(namespace, null);
        JsonObject conn = requireConnectionConfig(params);
        assertNamespaceDeletable(namespace, stringOrDefault(conn, "virtual_host", "/"));
        managementSend(conn, "DELETE", "/api/vhosts/" + urlEncodeVhost(namespace));
        return Collections.singletonMap("ok", true);
    }

    /** Guard rails for vhost deletion: never "/", never the vhost in use. */
    static void assertNamespaceDeletable(String namespace, String connectedVhost) {
        if ("/".equals(namespace)) {
            throw new IllegalArgumentException("The default virtual host '/' cannot be deleted");
        }
        if (connectedVhost != null && namespace.equals(connectedVhost)) {
            throw new IllegalArgumentException(
                "Cannot delete the virtual host '" + namespace + "' while connected to it");
        }
    }

    private static String namespaceName(JsonObject params) {
        String name = stringOrEmpty(params, "namespace");
        if (name.isBlank()) {
            throw new IllegalArgumentException("namespace is required");
        }
        // '*' is the all-vhosts marker used by listings, never a real vhost name;
        // without this guard a create/delete would address /api/vhosts/%2A.
        if ("*".equals(name.trim())) {
            throw new IllegalArgumentException("namespace create/delete requires a specific virtual host (all-vhosts context)");
        }
        return name;
    }

    // -----------------------------------------------------------------------
    // Exchanges & bindings
    // -----------------------------------------------------------------------

    private static final Set<String> EXCHANGE_TYPES = Set.of("direct", "fanout", "topic", "headers");

    private static Object listExchanges(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        boolean allVhosts = allVhostsRequested(params);
        JsonArray exchanges = managementGetAll(conn, managementListPath(params, conn, "exchanges"));

        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonElement element : exchanges) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject exchange = element.getAsJsonObject();
            Map<String, Object> info = exchangeInfoFromJson(exchange);
            if (allVhosts) {
                attachVhost(info, exchange);
            }
            result.add(info);
        }
        result.sort(Comparator.comparing(m -> (String) m.get("name")));
        return Collections.singletonMap("exchanges", result);
    }

    /**
     * Map one management API exchange entry to the bridge shape. The default
     * exchange ("") reports an empty type in the API; surface it as "default".
     */
    static Map<String, Object> exchangeInfoFromJson(JsonObject exchange) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("name", stringOrEmpty(exchange, "name"));
        String type = stringOrEmpty(exchange, "type");
        info.put("type", type.isEmpty() ? "default" : type);
        info.put("durable", boolOrDefault(exchange, "durable", false));
        info.put("autoDelete", boolOrDefault(exchange, "auto_delete", false));
        info.put("internal", boolOrDefault(exchange, "internal", false));
        return info;
    }

    private static Object createExchange(JsonObject params) throws Exception {
        // Validate before touching connectivity so type errors are semantic.
        String name = exchangeName(params);
        String type = validateExchangeType(stringOrEmpty(params, "type"));
        JsonObject conn = requireConnectionConfig(params);
        String vhost = effectiveVhost(params, conn);

        JsonObject body = new JsonObject();
        body.addProperty("type", type);
        body.addProperty("durable", boolOrDefault(params, "durable", true));
        body.addProperty("auto_delete", boolOrDefault(params, "autoDelete", false));
        managementSend(conn, "PUT",
            "/api/exchanges/" + urlEncodeVhost(vhost) + "/" + urlEncodePathSegment(name),
            body);
        return Collections.singletonMap("ok", true);
    }

    private static Object deleteExchange(JsonObject params) throws Exception {
        // Guard before connectivity: the error is semantic, not a connection failure.
        String name = stringOrEmpty(params, "name");
        assertExchangeDeletable(name);
        if (name.isBlank()) {
            throw new IllegalArgumentException("name is required");
        }
        JsonObject conn = requireConnectionConfig(params);
        String vhost = effectiveVhost(params, conn);
        managementSend(conn, "DELETE",
            "/api/exchanges/" + urlEncodeVhost(vhost) + "/" + urlEncodePathSegment(name));
        return Collections.singletonMap("ok", true);
    }

    /** Exchange type whitelist; anything else is rejected before hitting the broker. */
    static String validateExchangeType(String type) {
        if (!EXCHANGE_TYPES.contains(type)) {
            throw new IllegalArgumentException(
                "Invalid exchange type '" + type + "'. Supported types: direct, fanout, topic, headers");
        }
        return type;
    }

    /** Guard rails for exchange deletion: never the default exchange, never amq.* built-ins. */
    static void assertExchangeDeletable(String name) {
        if (name.isEmpty()) {
            throw new IllegalArgumentException("The default exchange cannot be deleted");
        }
        if (name.startsWith("amq.")) {
            throw new IllegalArgumentException("The built-in exchange '" + name + "' cannot be deleted");
        }
    }

    private static String exchangeName(JsonObject params) {
        String name = stringOrEmpty(params, "name");
        if (name.isBlank()) {
            throw new IllegalArgumentException("name is required");
        }
        return name;
    }

    private static Object listBindings(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        boolean allVhosts = allVhostsRequested(params);
        JsonArray bindings = managementGetAll(conn, managementListPath(params, conn, "bindings"));
        String exchange = stringOrEmpty(params, "exchange");
        String queue = stringOrEmpty(params, "queue");

        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonElement element : bindings) {
            if (!element.isJsonObject()) {
                continue;
            }
            Map<String, Object> binding = bindingInfoFromJson(element.getAsJsonObject());
            if (!exchange.isEmpty() && !exchange.equals(binding.get("source"))) {
                continue;
            }
            // A queue filter means "bindings feeding this queue": the
            // destination must be the queue itself, not an exchange.
            if (!queue.isEmpty() && !(queue.equals(binding.get("destination"))
                    && "queue".equals(binding.get("destinationType")))) {
                continue;
            }
            if (allVhosts) {
                attachVhost(binding, element.getAsJsonObject());
            }
            result.add(binding);
        }
        return Collections.singletonMap("bindings", result);
    }

    /** Map one management API binding entry (snake_case) to the bridge shape (camelCase). */
    static Map<String, Object> bindingInfoFromJson(JsonObject binding) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("source", stringOrEmpty(binding, "source"));
        info.put("destination", stringOrEmpty(binding, "destination"));
        info.put("destinationType", stringOrEmpty(binding, "destination_type"));
        info.put("routingKey", stringOrEmpty(binding, "routing_key"));
        JsonElement arguments = binding.get("arguments");
        if (arguments != null && arguments.isJsonObject() && !arguments.getAsJsonObject().isEmpty()) {
            Map<String, Object> args = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> entry : arguments.getAsJsonObject().entrySet()) {
                if (entry.getValue().isJsonNull()) {
                    continue;
                }
                Object value = argumentValue(entry.getValue());
                args.put(entry.getKey(), value != null ? value : entry.getValue().toString());
            }
            info.put("arguments", args);
        }
        return info;
    }

    private static Object bind(JsonObject params) throws Exception {
        applyBinding(params, true);
        return Collections.singletonMap("ok", true);
    }

    private static Object unbind(JsonObject params) throws Exception {
        applyBinding(params, false);
        return Collections.singletonMap("ok", true);
    }

    /**
     * Bind or unbind via AMQP. Queue destinations use queueBind/queueUnbind;
     * exchange destinations (exchange-to-exchange) use exchangeBind/exchangeUnbind.
     */
    private static void applyBinding(JsonObject params, boolean bind) throws Exception {
        String source = requireBindingName(params, "source");
        String destination = requireBindingName(params, "destination");
        String destinationType = stringOrDefault(params, "destinationType",
            stringOrEmpty(params, "destination_type"));
        // Validate the destination type before touching connectivity so a bad
        // value fails fast instead of surfacing as a connection error.
        if (!"queue".equals(destinationType) && !"exchange".equals(destinationType)) {
            throw new IllegalArgumentException(
                "destinationType must be 'queue' or 'exchange', got '" + destinationType + "'");
        }
        String routingKey = stringOrDefault(params, "routingKey", stringOrEmpty(params, "routing_key"));
        Map<String, Object> arguments = bindingArguments(params);
        Channel ch = channelFor(params);

        switch (destinationType) {
            case "queue" -> {
                if (bind) {
                    ch.queueBind(destination, source, routingKey, arguments);
                } else {
                    ch.queueUnbind(destination, source, routingKey, arguments);
                }
            }
            case "exchange" -> {
                if (bind) {
                    ch.exchangeBind(destination, source, routingKey, arguments);
                } else {
                    ch.exchangeUnbind(destination, source, routingKey, arguments);
                }
            }
            default -> throw new IllegalStateException("unreachable");
        }
    }

    private static String requireBindingName(JsonObject params, String key) {
        String name = stringOrEmpty(params, key);
        if (name.isBlank()) {
            throw new IllegalArgumentException(key + " is required");
        }
        return name;
    }

    private static Map<String, Object> bindingArguments(JsonObject params) {
        Map<String, Object> arguments = new HashMap<>();
        JsonObject args = params.has("arguments") && params.get("arguments").isJsonObject()
            ? params.getAsJsonObject("arguments") : null;
        if (args != null) {
            for (Map.Entry<String, JsonElement> entry : args.entrySet()) {
                Object value = argumentValue(entry.getValue());
                if (value != null) {
                    arguments.put(entry.getKey(), value);
                }
            }
        }
        return arguments;
    }

    // -----------------------------------------------------------------------
    // Client connections & channels
    // -----------------------------------------------------------------------

    private static Object listClientConnections(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        JsonArray connections = managementGetAll(conn, "/api/connections");
        boolean allVhosts = allVhostsRequested(params);
        String vhostFilter = vhostFilter(params, conn);

        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonElement element : connections) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject connection = element.getAsJsonObject();
            if (!vhostFilter.isEmpty() && !vhostFilter.equals(stringOrEmpty(connection, "vhost"))) {
                continue;
            }
            Map<String, Object> info = clientConnectionInfoFromJson(connection);
            if (allVhosts) {
                attachVhost(info, connection);
            }
            result.add(info);
        }
        result.sort(Comparator.comparing(m -> (String) m.get("name")));
        return Collections.singletonMap("connections", result);
    }

    /**
     * Map one management API connection entry (snake_case) to the bridge shape
     * (camelCase). Rates come from the *_oct_details blocks; connected_at is a
     * millisecond timestamp. Both are omitted when the broker does not report them.
     */
    static Map<String, Object> clientConnectionInfoFromJson(JsonObject connection) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("name", stringOrEmpty(connection, "name"));
        info.put("user", stringOrEmpty(connection, "user"));
        info.put("peerHost", stringOrEmpty(connection, "peer_host"));
        info.put("peerPort", longOrDefault(connection, "peer_port", 0));
        info.put("state", stringOrEmpty(connection, "state"));
        info.put("channels", longOrDefault(connection, "channels", 0));
        Double recvRate = rateFromDetails(connection, "recv_oct_details");
        if (recvRate != null) {
            info.put("recvRate", recvRate);
        }
        Double sendRate = rateFromDetails(connection, "send_oct_details");
        if (sendRate != null) {
            info.put("sendRate", sendRate);
        }
        Long connectedAt = longOrNull(connection, "connected_at");
        if (connectedAt != null) {
            info.put("connectedAt", connectedAt);
        }
        return info;
    }

    /** Per-second byte rate from a {@code recv_oct_details}/{@code send_oct_details} block. */
    static Double rateFromDetails(JsonObject object, String key) {
        JsonElement details = object.get(key);
        if (details == null || !details.isJsonObject()) {
            return null;
        }
        JsonElement rate = details.getAsJsonObject().get("rate");
        return rate == null || rate.isJsonNull() ? null : rate.getAsDouble();
    }

    private static Object listClientChannels(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        JsonArray channels = managementGetAll(conn, "/api/channels");
        String connectionFilter = stringOrEmpty(params, "connection");
        boolean allVhosts = allVhostsRequested(params);
        String vhostFilter = vhostFilter(params, conn);

        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonElement element : channels) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject channel = element.getAsJsonObject();
            if (!vhostFilter.isEmpty() && !vhostFilter.equals(stringOrEmpty(channel, "vhost"))) {
                continue;
            }
            Map<String, Object> info = channelInfoFromJson(channel);
            if (allVhosts) {
                attachVhost(info, channel);
            }
            if (!connectionFilter.isEmpty() && !channelMatchesConnection(info, connectionFilter)) {
                continue;
            }
            result.add(info);
        }
        result.sort(Comparator.comparing(m -> (String) m.get("name")));
        return Collections.singletonMap("channels", result);
    }

    /** Map one management API channel entry (snake_case) to the bridge shape (camelCase). */
    static Map<String, Object> channelInfoFromJson(JsonObject channel) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("name", stringOrEmpty(channel, "name"));
        JsonElement connectionDetails = channel.get("connection_details");
        if (connectionDetails != null && connectionDetails.isJsonObject()) {
            String connectionName = stringOrEmpty(connectionDetails.getAsJsonObject(), "name");
            if (!connectionName.isEmpty()) {
                info.put("connectionName", connectionName);
            }
        }
        info.put("state", stringOrEmpty(channel, "state"));
        Integer prefetch = integerOrNull(channel, "prefetch_count");
        if (prefetch != null) {
            info.put("prefetch", prefetch);
        }
        Long unacked = longOrNull(channel, "messages_unacknowledged");
        if (unacked != null) {
            info.put("messagesUnacked", unacked);
        }
        Long consumers = longOrNull(channel, "consumer_count");
        if (consumers != null) {
            info.put("consumerCount", consumers);
        }
        return info;
    }

    /**
     * A channel belongs to a connection when its {@code connection_details.name}
     * matches, or when its own name starts with the connection name (channel
     * names are "{connectionName} ({channelNumber})").
     */
    static boolean channelMatchesConnection(Map<String, Object> channelInfo, String connectionName) {
        if (connectionName.equals(channelInfo.get("connectionName"))) {
            return true;
        }
        Object name = channelInfo.get("name");
        return name instanceof String && ((String) name).startsWith(connectionName);
    }

    private static Object closeClientConnection(JsonObject params) throws Exception {
        // Validate before touching connectivity so the error is semantic.
        String name = stringOrEmpty(params, "name");
        if (name.isBlank()) {
            throw new IllegalArgumentException("name is required");
        }
        JsonObject conn = requireConnectionConfig(params);
        managementSend(conn, "DELETE", "/api/connections/" + urlEncodeName(name));
        return Collections.singletonMap("ok", true);
    }

    /**
     * URL-encode a connection name for the management API path. Connection names
     * contain " -> " and spaces, so URLEncoder's '+' for spaces must become %20.
     */
    static String urlEncodeName(String name) {
        return urlEncodePathSegment(name);
    }

    // -----------------------------------------------------------------------
    // Users & permissions
    // -----------------------------------------------------------------------

    private static Object listUsers(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        JsonArray users = managementGetAll(conn, "/api/users");

        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonElement element : users) {
            if (!element.isJsonObject()) {
                continue;
            }
            result.add(userInfoFromJson(element.getAsJsonObject()));
        }
        result.sort(Comparator.comparing(m -> (String) m.get("name")));
        return Collections.singletonMap("users", result);
    }

    /**
     * Map one management API user entry to the bridge shape. The API reports tags
     * as a single comma-separated string; the bridge shape carries them as an array.
     */
    static Map<String, Object> userInfoFromJson(JsonObject user) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("name", stringOrEmpty(user, "name"));
        info.put("tags", parseUserTags(stringOrEmpty(user, "tags")));
        return info;
    }

    /** Split the management API's comma-separated tag string; blank entries are dropped. */
    static List<String> parseUserTags(String tags) {
        List<String> result = new ArrayList<>();
        for (String tag : tags.split(",")) {
            String trimmed = tag.trim();
            if (!trimmed.isEmpty()) {
                result.add(trimmed);
            }
        }
        return result;
    }

    private static Object createUser(JsonObject params) throws Exception {
        // Validate before touching connectivity so the errors are semantic.
        String name = userName(params);
        String password = stringOrEmpty(params, "password");
        if (password.isEmpty()) {
            throw new IllegalArgumentException("password is required");
        }
        JsonObject conn = requireConnectionConfig(params);
        // PUT /api/users upserts, so "creating" the connected user would actually
        // change its credentials; reject it just like deletion.
        assertNotConnectedUser("create or modify", name, stringOrDefault(conn, "username", "guest"));

        JsonObject body = new JsonObject();
        body.addProperty("password", password);
        body.addProperty("tags", userTagsParam(params));
        managementSend(conn, "PUT", "/api/users/" + urlEncodePathSegment(name), body);
        return Collections.singletonMap("ok", true);
    }

    /** Tags for user creation: accepts a JSON array or a comma-separated string. */
    static String userTagsParam(JsonObject params) {
        JsonElement tags = params.get("tags");
        if (tags == null || tags.isJsonNull()) {
            return "";
        }
        if (tags.isJsonArray()) {
            List<String> parts = new ArrayList<>();
            for (JsonElement element : tags.getAsJsonArray()) {
                String tag = element.getAsString().trim();
                if (!tag.isEmpty()) {
                    parts.add(tag);
                }
            }
            return String.join(",", parts);
        }
        return tags.getAsString();
    }

    private static Object deleteUser(JsonObject params) throws Exception {
        String name = userName(params);
        JsonObject conn = requireConnectionConfig(params);
        assertNotConnectedUser("delete", name, stringOrDefault(conn, "username", "guest"));
        managementSend(conn, "DELETE", "/api/users/" + urlEncodePathSegment(name));
        return Collections.singletonMap("ok", true);
    }

    /** Guard rail for user changes: never touch the user the agent itself connects as. */
    static void assertNotConnectedUser(String action, String name, String connectedUser) {
        if (name.equals(connectedUser)) {
            throw new IllegalArgumentException(
                "Cannot " + action + " user '" + name + "' while connected as that user");
        }
    }

    private static Object listPermissions(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        JsonElement permissions = managementGet(conn, "/api/permissions");
        if (!permissions.isJsonArray()) {
            throw new IllegalStateException("Unexpected management API response for permission listing");
        }
        // The management API only lists permissions cluster-wide; virtual_host and
        // user are client-side filters. all_vhosts simply disables the vhost filter.
        String vhostFilter = allVhostsRequested(params) ? "" : stringOrEmpty(params, "virtual_host");
        String userFilter = stringOrEmpty(params, "user");

        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonElement element : permissions.getAsJsonArray()) {
            if (!element.isJsonObject()) {
                continue;
            }
            Map<String, Object> permission = permissionInfoFromJson(element.getAsJsonObject());
            if (!vhostFilter.isEmpty() && !vhostFilter.equals(permission.get("vhost"))) {
                continue;
            }
            if (!userFilter.isEmpty() && !userFilter.equals(permission.get("user"))) {
                continue;
            }
            result.add(permission);
        }
        result.sort(Comparator.comparing((Map<String, Object> m) -> (String) m.get("user"))
            .thenComparing(m -> (String) m.get("vhost")));
        return Collections.singletonMap("permissions", result);
    }

    /** Map one management API permission entry (user x vhost regex triple) to the bridge shape. */
    static Map<String, Object> permissionInfoFromJson(JsonObject permission) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("user", stringOrEmpty(permission, "user"));
        info.put("vhost", stringOrEmpty(permission, "vhost"));
        info.put("configure", stringOrEmpty(permission, "configure"));
        info.put("write", stringOrEmpty(permission, "write"));
        info.put("read", stringOrEmpty(permission, "read"));
        return info;
    }

    private static final String DEFAULT_PERMISSION_PATTERN = ".*";

    private static Object grantPermission(JsonObject params) throws Exception {
        // Validate before touching connectivity so the errors are semantic.
        String user = userName(params);
        String vhost = permissionVhost(params);
        JsonObject conn = requireConnectionConfig(params);

        JsonObject body = new JsonObject();
        body.addProperty("configure", permissionPattern(params, "configure"));
        body.addProperty("write", permissionPattern(params, "write"));
        body.addProperty("read", permissionPattern(params, "read"));
        managementSend(conn, "PUT",
            "/api/permissions/" + urlEncodeVhost(vhost) + "/" + urlEncodePathSegment(user), body);
        return Collections.singletonMap("ok", true);
    }

    private static Object revokePermission(JsonObject params) throws Exception {
        String user = userName(params);
        String vhost = permissionVhost(params);
        JsonObject conn = requireConnectionConfig(params);
        managementSend(conn, "DELETE",
            "/api/permissions/" + urlEncodeVhost(vhost) + "/" + urlEncodePathSegment(user));
        return Collections.singletonMap("ok", true);
    }

    /** Permission pattern defaulting to ".*" (full access) when omitted or blank. */
    static String permissionPattern(JsonObject params, String key) {
        String pattern = stringOrEmpty(params, key);
        return pattern.isBlank() ? DEFAULT_PERMISSION_PATTERN : pattern;
    }

    /**
     * Vhost for permission and policy writes: the {@code *} all-vhosts sentinel
     * only makes sense for listings; a write always targets one concrete vhost.
     */
    static String permissionVhost(JsonObject params) {
        String vhost = stringOrEmpty(params, "virtual_host");
        if (vhost.isBlank()) {
            throw new IllegalArgumentException("virtual_host is required");
        }
        if ("*".equals(vhost)) {
            throw new IllegalArgumentException("all_vhosts is only supported for list operations");
        }
        return vhost;
    }

    /** User name: create/delete send {@code name}, grant/revoke send {@code user}. */
    private static String userName(JsonObject params) {
        String name = stringOrEmpty(params, "name");
        if (name.isBlank()) {
            name = stringOrEmpty(params, "user");
        }
        if (name.isBlank()) {
            throw new IllegalArgumentException("user name is required");
        }
        return name;
    }

    /**
     * URL-encode one path segment (queue/exchange name) for the management API.
     * URLEncoder is form-oriented and encodes spaces as '+', which the management
     * API does not decode back in path segments (causing 404s), so '+' becomes %20.
     */
    static String urlEncodePathSegment(String name) {
        return URLEncoder.encode(name, StandardCharsets.UTF_8).replace("+", "%20");
    }

    // -----------------------------------------------------------------------
    // Policies
    // -----------------------------------------------------------------------

    private static Object listPolicies(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        // Accept the '*' all-vhosts sentinel as a synonym for all_vhosts=true;
        // both select the vhost-less management API variant.
        boolean allVhosts = allVhostsRequested(params) || "*".equals(stringOrEmpty(params, "virtual_host"));
        JsonArray policies = managementGetAll(conn, allVhosts ? "/api/policies"
            : "/api/policies/" + urlEncodeVhost(effectiveVhost(params, conn)));

        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonElement element : policies) {
            if (!element.isJsonObject()) {
                continue;
            }
            result.add(policyInfoFromJson(element.getAsJsonObject()));
        }
        result.sort(Comparator.comparing((Map<String, Object> m) -> (String) m.get("vhost"))
            .thenComparing(m -> (String) m.get("name")));
        return Collections.singletonMap("policies", result);
    }

    /**
     * Map one management API policy entry to the bridge shape: kebab-case
     * {@code apply-to} becomes camelCase {@code applyTo}, and the definition map
     * is passed through with plain values. Each policy always carries its own
     * {@code vhost}, so flat and cross-vhost listings share one shape.
     */
    static Map<String, Object> policyInfoFromJson(JsonObject policy) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("name", stringOrEmpty(policy, "name"));
        info.put("vhost", stringOrEmpty(policy, "vhost"));
        info.put("pattern", stringOrEmpty(policy, "pattern"));
        info.put("applyTo", stringOrEmpty(policy, "apply-to"));
        info.put("priority", longOrDefault(policy, "priority", 0));
        Map<String, Object> definition = new LinkedHashMap<>();
        JsonElement rawDefinition = policy.get("definition");
        if (rawDefinition != null && rawDefinition.isJsonObject()) {
            for (Map.Entry<String, JsonElement> entry : rawDefinition.getAsJsonObject().entrySet()) {
                if (entry.getValue().isJsonNull()) {
                    continue;
                }
                Object value = argumentValue(entry.getValue());
                definition.put(entry.getKey(), value != null ? value : entry.getValue().toString());
            }
        }
        info.put("definition", definition);
        return info;
    }

    private static Object setPolicy(JsonObject params) throws Exception {
        // Validate before touching connectivity so the errors are semantic.
        String vhost = permissionVhost(params);
        String name = policyName(params);
        String pattern = stringOrEmpty(params, "pattern");
        if (pattern.isBlank()) {
            throw new IllegalArgumentException("pattern is required");
        }
        JsonElement definition = params.get("definition");
        if (definition == null || !definition.isJsonObject()) {
            throw new IllegalArgumentException("definition is required");
        }
        JsonObject conn = requireConnectionConfig(params);

        JsonObject body = new JsonObject();
        body.addProperty("pattern", pattern);
        // The bridge sends camelCase applyTo; the management API wants apply-to.
        // applyTo defaults to queues and priority to 0, matching broker defaults.
        body.addProperty("apply-to", stringOrDefault(params, "applyTo", "queues"));
        body.addProperty("priority", intOrDefault(params, "priority", 0));
        body.add("definition", definition);
        managementSend(conn, "PUT",
            "/api/policies/" + urlEncodeVhost(vhost) + "/" + urlEncodePathSegment(name), body);
        return Collections.singletonMap("ok", true);
    }

    private static Object deletePolicy(JsonObject params) throws Exception {
        // Validate before touching connectivity so the errors are semantic.
        String vhost = permissionVhost(params);
        String name = policyName(params);
        JsonObject conn = requireConnectionConfig(params);
        managementSend(conn, "DELETE",
            "/api/policies/" + urlEncodeVhost(vhost) + "/" + urlEncodePathSegment(name));
        return Collections.singletonMap("ok", true);
    }

    /** Policy name for set/delete. */
    private static String policyName(JsonObject params) {
        String name = stringOrEmpty(params, "name");
        if (name.isBlank()) {
            throw new IllegalArgumentException("name is required");
        }
        return name;
    }

    // -----------------------------------------------------------------------
    // Messages
    // -----------------------------------------------------------------------

    private static Object peekMessages(JsonObject params) throws Exception {
        String queue = queueName(params);
        long offset = normalizePeekOffset(longOrDefault(params, "offset", 0));
        int count = normalizePeekCount(intOrDefault(params, "count", 10));
        long totalToFetch = Math.min(offset + count, MAX_PEEK_MESSAGES);
        if (offset >= MAX_PEEK_MESSAGES) {
            return Collections.singletonMap("messages", Collections.emptyList());
        }

        Channel ch;
        Connection ownedConnection = null;
        if (cachedConnection != null) {
            ch = channelFor(params);
        } else {
            // Not connected: open a short-lived connection from inline params,
            // mirroring how the Kafka agent accepts a `connection` object for peek.
            JsonObject conn = connectionObject(params);
            String vhost = stringOrNull(params, "virtual_host");
            if (vhost != null && !vhost.isBlank()) {
                conn = conn.deepCopy();
                conn.addProperty("virtual_host", vhost);
            }
            ownedConnection = openConnection(conn);
            ch = ownedConnection.createChannel();
        }
        try {
            List<GetResponse> fetched = new ArrayList<>();
            long lastDeliveryTag = -1;
            for (long i = 0; i < totalToFetch; i++) {
                GetResponse response = ch.basicGet(queue, false);
                if (response == null) {
                    break;
                }
                fetched.add(response);
                lastDeliveryTag = response.getEnvelope().getDeliveryTag();
            }
            // Requeue everything so peeking never consumes messages.
            if (lastDeliveryTag >= 0) {
                ch.basicNack(lastDeliveryTag, true, true);
            }

            List<Map<String, Object>> messages = new ArrayList<>();
            for (long i = offset; i < fetched.size() && messages.size() < count; i++) {
                messages.add(peekedMessageFromGetResponse(queue, i, fetched.get((int) i)));
            }
            return Collections.singletonMap("messages", messages);
        } finally {
            if (ownedConnection != null) {
                closeQuietly(ch);
                closeQuietly(ownedConnection);
            }
        }
    }

    static long normalizePeekOffset(long requestedOffset) {
        return Math.max(0, requestedOffset);
    }

    /**
     * Routing key for publishes: {@code routing_key}/{@code routingKey} win;
     * the Rust bridge sends the message key as {@code key}; the default is the
     * queue name so publishes through the default exchange reach the queue.
     */
    static String resolveRoutingKey(JsonObject params, String queue) {
        String routingKey = stringOrDefault(params, "routing_key", "");
        if (routingKey.isEmpty()) {
            routingKey = stringOrDefault(params, "routingKey", "");
        }
        if (routingKey.isEmpty()) {
            routingKey = stringOrDefault(params, "key", "");
        }
        // A blank key must not win over the queue fallback: publishing through
        // the default exchange with an empty routing key silently drops the message.
        if (routingKey.isBlank()) {
            routingKey = queue;
        }
        return routingKey;
    }

    static int normalizePeekCount(int requestedCount) {
        return Math.max(1, requestedCount);
    }

    private static Map<String, Object> peekedMessageFromGetResponse(String queue, long index, GetResponse response) {
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("topic", queue);
        msg.put("offset", index);
        msg.put("exchange", response.getEnvelope().getExchange());
        msg.put("routingKey", response.getEnvelope().getRoutingKey());
        msg.put("redelivered", response.getEnvelope().isRedeliver());
        msg.put("deliveryTag", response.getEnvelope().getDeliveryTag());

        AMQP.BasicProperties props = response.getProps();
        if (props != null && props.getMessageId() != null) {
            msg.put("messageId", props.getMessageId());
        }
        Date timestamp = props != null ? props.getTimestamp() : null;
        msg.put("timestamp", timestamp != null ? timestamp.getTime() : 0L);

        Map<String, String> headers = new LinkedHashMap<>();
        if (props != null && props.getHeaders() != null) {
            for (Map.Entry<String, Object> entry : props.getHeaders().entrySet()) {
                headers.put(entry.getKey(), String.valueOf(entry.getValue()));
            }
        }
        msg.put("headers", headers);

        byte[] body = response.getBody();
        if (body != null) {
            msg.put("payloadBase64", Base64.getEncoder().encodeToString(body));
            String text = tryDecodeUtf8(body);
            if (text != null) {
                msg.put("payloadText", text);
            }
        } else {
            msg.put("payloadBase64", "");
        }
        return msg;
    }

    private static Object sendMessage(JsonObject params) throws Exception {
        Channel ch = channelFor(params);
        String queue = queueName(params);
        String exchange = stringOrDefault(params, "exchange", "");
        String routingKey = resolveRoutingKey(params, queue);

        String payloadBase64 = stringOrEmpty(params, "payloadBase64");
        byte[] body = payloadBase64.isEmpty() ? new byte[0] : Base64.getDecoder().decode(payloadBase64);

        AMQP.BasicProperties properties = null;
        JsonObject headers = params.has("headers") && params.get("headers").isJsonObject()
            ? params.getAsJsonObject("headers") : null;
        if (headers != null) {
            Map<String, Object> headerMap = new HashMap<>();
            for (Map.Entry<String, JsonElement> entry : headers.entrySet()) {
                Object value = argumentValue(entry.getValue());
                if (value != null) {
                    headerMap.put(entry.getKey(), value);
                }
            }
            properties = new AMQP.BasicProperties.Builder().headers(headerMap).build();
        }

        ch.basicPublish(exchange, routingKey, properties, body);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", true);
        result.put("exchange", exchange);
        result.put("routingKey", routingKey);
        return result;
    }

    // -----------------------------------------------------------------------
    // Cluster / monitoring
    // -----------------------------------------------------------------------

    private static Object describeCluster(JsonObject params) throws Exception {
        Connection conn = requireConnection();
        JsonObject connConfig = currentConnectionConfig(params);
        Map<String, Object> serverProps = conn.getServerProperties();

        List<Map<String, Object>> nodes = new ArrayList<>();
        if (connConfig != null) {
            for (Address address : resolveAddresses(connConfig)) {
                Map<String, Object> node = new LinkedHashMap<>();
                node.put("name", address.getHost());
                node.put("port", address.getPort());
                nodes.add(node);
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("clusterName", serverString(serverProps, "cluster_name"));
        result.put("product", serverString(serverProps, "product"));
        result.put("version", serverString(serverProps, "version"));
        result.put("platform", serverString(serverProps, "platform"));
        result.put("nodes", nodes);
        result.put("nodeCount", nodes.size());
        return result;
    }

    private static Object getOverview(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        JsonElement overview = managementGet(conn, "/api/overview");
        if (!overview.isJsonObject()) {
            throw new IllegalStateException("Unexpected management API response for cluster overview");
        }
        return overviewInfoFromJson(overview.getAsJsonObject());
    }

    /**
     * Map the management API overview (snake_case totals and message stats) to
     * the bridge shape (camelCase). Rates come from each stat's
     * {@code *_details.rate} block; anything the broker does not report is
     * omitted rather than zeroed.
     */
    static Map<String, Object> overviewInfoFromJson(JsonObject overview) {
        Map<String, Object> info = new LinkedHashMap<>();
        putIfPresent(info, "messagesReady", nestedLongOrNull(overview, "queue_totals", "messages_ready"));
        putIfPresent(info, "messagesUnacked", nestedLongOrNull(overview, "queue_totals", "messages_unacknowledged"));

        JsonElement stats = overview.get("message_stats");
        if (stats != null && stats.isJsonObject()) {
            JsonObject messageStats = stats.getAsJsonObject();
            putIfPresent(info, "publishRate", rateFromDetails(messageStats, "publish_details"));
            putIfPresent(info, "deliverRate", rateFromDetails(messageStats, "deliver_get_details"));
            putIfPresent(info, "ackRate", rateFromDetails(messageStats, "ack_details"));
        }

        putIfPresent(info, "totalQueues", nestedLongOrNull(overview, "object_totals", "queues"));
        putIfPresent(info, "totalExchanges", nestedLongOrNull(overview, "object_totals", "exchanges"));
        putIfPresent(info, "totalConnections", nestedLongOrNull(overview, "object_totals", "connections"));
        putIfPresent(info, "totalChannels", nestedLongOrNull(overview, "object_totals", "channels"));
        putIfPresent(info, "totalConsumers", nestedLongOrNull(overview, "object_totals", "consumers"));
        return info;
    }

    private static Object listNodes(JsonObject params) throws Exception {
        JsonObject conn = requireConnectionConfig(params);
        JsonElement nodes = managementGet(conn, "/api/nodes");
        if (!nodes.isJsonArray()) {
            throw new IllegalStateException("Unexpected management API response for node listing");
        }

        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonElement element : nodes.getAsJsonArray()) {
            if (!element.isJsonObject()) {
                continue;
            }
            result.add(nodeInfoFromJson(element.getAsJsonObject()));
        }
        result.sort(Comparator.comparing(m -> (String) m.get("name")));
        return Collections.singletonMap("nodes", result);
    }

    /**
     * Map one management API node entry (snake_case) to the bridge shape
     * (camelCase). The API reports uptime in milliseconds; resource counters
     * the broker does not report are omitted rather than zeroed.
     */
    static Map<String, Object> nodeInfoFromJson(JsonObject node) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("name", stringOrEmpty(node, "name"));
        info.put("running", boolOrDefault(node, "running", false));
        putIfPresent(info, "memUsed", longOrNull(node, "mem_used"));
        putIfPresent(info, "memLimit", longOrNull(node, "mem_limit"));
        putIfPresent(info, "diskFree", longOrNull(node, "disk_free"));
        putIfPresent(info, "fdUsed", longOrNull(node, "fd_used"));
        putIfPresent(info, "fdTotal", longOrNull(node, "fd_total"));
        putIfPresent(info, "socketsUsed", longOrNull(node, "sockets_used"));
        putIfPresent(info, "socketsTotal", longOrNull(node, "sockets_total"));
        putIfPresent(info, "uptimeMs", longOrNull(node, "uptime"));
        return info;
    }

    /** Long value one level down (e.g. {@code object_totals.queues}); null when absent. */
    static Long nestedLongOrNull(JsonObject object, String block, String key) {
        JsonElement element = object.get(block);
        if (element == null || !element.isJsonObject()) {
            return null;
        }
        return longOrNull(element.getAsJsonObject(), key);
    }

    /** Adds the value only when the broker reported it (missing stats stay absent). */
    private static void putIfPresent(Map<String, Object> info, String key, Object value) {
        if (value != null) {
            info.put(key, value);
        }
    }

    // -----------------------------------------------------------------------
    // HTTP management API helpers
    // -----------------------------------------------------------------------

    static JsonElement managementGet(JsonObject conn, String path) throws Exception {
        return managementRequest(conn, "GET", path);
    }

    /** Management API call without a JSON body (PUT/DELETE); accepts 2xx. */
    static JsonElement managementSend(JsonObject conn, String method, String path) throws Exception {
        return managementRequest(conn, method, path);
    }

    /** Management API call with a JSON body (PUT/POST); accepts 2xx. */
    static JsonElement managementSend(JsonObject conn, String method, String path, JsonObject body) throws Exception {
        return managementRequest(conn, method, path, body);
    }

    static JsonElement managementRequest(JsonObject conn, String method, String path) throws Exception {
        return managementRequest(conn, method, path, null);
    }

    static JsonElement managementRequest(JsonObject conn, String method, String path, JsonObject body) throws Exception {
        // Candidates are tried in order; only connection-level failures
        // (refused/timeout/DNS) move to the next candidate. A non-2xx HTTP
        // status means the endpoint answered, so the answer is final.
        IOException lastConnectionError = null;
        for (String baseUrl : managementBaseUrls(conn)) {
            try {
                return managementRequestOnce(baseUrl, conn, method, path, body);
            } catch (IOException e) {
                lastConnectionError = e;
            }
        }
        throw lastConnectionError != null ? lastConnectionError
            : new IllegalStateException("No management API endpoint candidates");
    }

    private static JsonElement managementRequestOnce(String baseUrl, JsonObject conn,
            String method, String path, JsonObject body) throws Exception {
        URL url = URI.create(baseUrl + path).toURL();
        HttpURLConnection http = (HttpURLConnection) url.openConnection();
        try {
            // tls_skip_verify previously only applied to AMQP; honor it for the
            // management API too, or self-signed brokers fail every HTTP call.
            if (tlsSkipVerify(conn) && http instanceof HttpsURLConnection https) {
                https.setSSLSocketFactory(trustAllSslContext().getSocketFactory());
                https.setHostnameVerifier((hostname, session) -> true);
            }
            http.setRequestMethod(method);
            http.setConnectTimeout(10_000);
            http.setReadTimeout(10_000);
            http.setRequestProperty("Authorization",
                basicAuthHeader(credentialOrGuest(conn, "username"),
                    credentialOrGuest(conn, "password")));
            if (body != null) {
                http.setDoOutput(true);
                http.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = http.getOutputStream()) {
                    out.write(GSON.toJson(body).getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = http.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IllegalStateException(managementErrorMessage(status, method, path));
            }
            if (status == 204) {
                return JsonNull.INSTANCE;
            }
            try (InputStream in = http.getInputStream()) {
                String responseBody = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                if (responseBody.isBlank()) {
                    return JsonNull.INSTANCE;
                }
                return JsonParser.parseString(responseBody);
            }
        } finally {
            http.disconnect();
        }
    }

    static String managementBaseUrl(String host, int port, boolean tls) {
        return (tls ? "https" : "http") + "://" + host + ":" + port;
    }

    /**
     * Candidate management API base URLs. An explicit {@code management_url}
     * wins and is used verbatim (scheme/host/port/path prefix, e.g. a reverse
     * proxy mount like {@code https://proxy:8443/rmq}); otherwise one candidate
     * per AMQP address is derived with the management port, and
     * {@link #managementRequest} fails over across them.
     */
    static List<String> managementBaseUrls(JsonObject conn) {
        String explicit = stringOrNull(conn, "management_url");
        if (explicit != null && !explicit.isBlank()) {
            return List.of(normalizeManagementUrl(explicit));
        }
        boolean tls = managementTls(conn);
        int port = managementPort(conn, tls);
        List<String> baseUrls = new ArrayList<>();
        for (Address address : resolveAddresses(conn)) {
            baseUrls.add(managementBaseUrl(address.getHost(), port, tls));
        }
        return baseUrls;
    }

    /**
     * Trailing slashes are trimmed so base + "/api/..." joins cleanly; the path
     * prefix itself is kept verbatim (no re-encoding).
     */
    static String normalizeManagementUrl(String url) {
        String trimmed = url.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    /**
     * Whether the derived management endpoint uses TLS. Only explicit tls/ssl
     * parameters count: tls_skip_verify is a verification flag, not a scheme
     * indicator, and must not flip the management API to https.
     */
    static boolean managementTls(JsonObject conn) {
        return (conn.has("tls") && conn.get("tls").isJsonObject())
            || boolProperty(conn, "ssl")
            || boolProperty(conn, "tls");
    }

    /**
     * Username/password with blank normalization: a missing, null, or
     * whitespace-only credential falls back to "guest". Without this an empty
     * string from the bridge authenticates as ":" and fails confusingly.
     */
    static String credentialOrGuest(JsonObject conn, String key) {
        String value = stringOrNull(conn, key);
        return value == null || value.isBlank() ? "guest" : value;
    }

    private static final int MANAGEMENT_PAGE_SIZE = 100;

    /**
     * Fetch every item of a management API list endpoint. RabbitMQ answers a
     * paginated request ({@code page}/{@code page_size}) with
     * {@code {items, page, page_count, total_count}}, so the loop walks to the
     * last page; brokers that ignore the parameters answer with a plain array,
     * which is returned as-is.
     */
    static JsonArray managementGetAll(JsonObject conn, String path) throws Exception {
        JsonArray all = new JsonArray();
        for (int page = 1;; page++) {
            String separator = path.contains("?") ? "&" : "?";
            JsonElement response = managementGet(conn,
                path + separator + "page=" + page + "&page_size=" + MANAGEMENT_PAGE_SIZE);
            if (response.isJsonArray()) {
                response.getAsJsonArray().forEach(all::add);
                return all;
            }
            if (!response.isJsonObject() || !response.getAsJsonObject().has("items")) {
                throw new IllegalStateException(
                    "Unexpected management API response for list endpoint " + path);
            }
            JsonObject paged = response.getAsJsonObject();
            JsonElement items = paged.get("items");
            if (items.isJsonArray()) {
                items.getAsJsonArray().forEach(all::add);
            }
            Integer pageCount = integerOrNull(paged, "page_count");
            if (pageCount == null || page >= pageCount) {
                return all;
            }
        }
    }

    /**
     * Error text for a non-2xx management API response. 401/403 mean the plugin
     * answered but rejected the credentials or the user's management tag, so
     * blaming the plugin would mislead debugging; other statuses keep the
     * plugin hint (connection refused/timeouts never reach this method).
     */
    static String managementErrorMessage(int status, String method, String path) {
        String base = "RabbitMQ management API returned HTTP " + status + " for " + method + " " + path + ".";
        if (status == 401 || status == 403) {
            return base + " Hint: check the username/password and that the user has a management"
                + " permission tag (management, policymaker, monitoring, or administrator).";
        }
        return base + " The rabbitmq_management plugin must be enabled for this operation.";
    }

    static int managementPort(JsonObject conn, boolean tls) {
        Integer configured = null;
        JsonObject properties = conn.has("properties") && conn.get("properties").isJsonObject()
            ? conn.getAsJsonObject("properties") : null;
        if (properties != null) {
            configured = integerProperty(properties, "management_port");
        }
        if (configured != null) {
            return configured;
        }
        return tls ? DEFAULT_MANAGEMENT_TLS_PORT : DEFAULT_MANAGEMENT_PORT;
    }

    static String basicAuthHeader(String username, String password) {
        String credentials = username + ":" + password;
        return "Basic " + Base64.getEncoder().encodeToString(credentials.getBytes(StandardCharsets.UTF_8));
    }

    static String urlEncodeVhost(String vhost) {
        return URLEncoder.encode(vhost, StandardCharsets.UTF_8).replace("+", "%20");
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static final Pattern QUOTED_NAME = Pattern.compile("'([^']+)'");
    private static final Pattern DECLARED_RESOURCE_NAME =
        Pattern.compile("for (queue|exchange) '([^']+)'");

    static String normalizeErrorMessage(Exception e) {
        // AMQP channel/connection shutdowns carry a broker reply code; map the
        // known ones to a readable message instead of leaking raw AMQP text.
        String friendly = amqpFriendlyMessage(e);
        if (friendly != null) {
            return friendly;
        }
        String message = e.getMessage() == null || e.getMessage().isBlank()
            ? e.getClass().getName()
            : e.getMessage();
        Throwable root = rootCause(e);
        if (root != e && root.getMessage() != null && !root.getMessage().isBlank()
            && !message.contains(root.getMessage())) {
            message = message + ": " + root.getMessage();
        }
        if (isAuthenticationError(e)) {
            message = message + ". Hint: authentication failed. Check the RabbitMQ username, "
                + "password, and virtual host permissions.";
        }
        return message;
    }

    /**
     * Walk the cause chain for an AMQP shutdown signal and map its broker reply
     * code to a friendly message. Returns null when there is no AMQP shutdown
     * or the reply code has no mapping (caller keeps the raw message).
     */
    static String amqpFriendlyMessage(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            if (!(current instanceof ShutdownSignalException shutdown)) {
                continue;
            }
            Object reason = shutdown.getReason();
            Integer replyCode = null;
            String replyText = null;
            if (reason instanceof AMQP.Channel.Close channelClose) {
                replyCode = channelClose.getReplyCode();
                replyText = channelClose.getReplyText();
            } else if (reason instanceof AMQP.Connection.Close connectionClose) {
                replyCode = connectionClose.getReplyCode();
                replyText = connectionClose.getReplyText();
            }
            if (replyCode != null) {
                String friendly = mapAmqpError(replyCode, replyText);
                if (friendly != null) {
                    return friendly;
                }
            }
        }
        return null;
    }

    /** Friendly message for a broker reply code, or null to keep the raw message. */
    static String mapAmqpError(int replyCode, String replyText) {
        String text = replyText == null ? "" : replyText;
        switch (replyCode) {
            case 405: {
                String name = extractQuotedName(text);
                String subject = name != null ? "Queue '" + name + "'" : "The queue";
                return subject + " is exclusive and owned by another connection."
                    + " Hint: exclusive queues can only be accessed by their owning connection;"
                    + " stats via the management API are still available.";
            }
            case 404: {
                String name = extractQuotedName(text);
                boolean exchange = text.contains("no exchange");
                String kind = exchange ? "Exchange" : "Queue";
                String subject = name != null ? kind + " '" + name + "'" : "The " + kind.toLowerCase();
                return subject + " was not found."
                    + " Hint: it may have been deleted, or it never existed on this virtual host.";
            }
            case 406: {
                // "PRECONDITION_FAILED - inequivalent arg 'durable' for queue 'q1'
                // in vhost '/': ..." — the first quoted token is the argument
                // name, so the resource name needs its own extraction.
                String name = extractDeclaredResourceName(text);
                boolean exchange = text.contains("for exchange");
                String kind = exchange ? "Exchange" : "Queue";
                String subject = name != null ? kind + " '" + name + "'" : "The " + kind.toLowerCase();
                return subject + " already exists with different parameters."
                    + " Hint: " + kind.toLowerCase() + " parameters are immutable after declaration;"
                    + " delete and re-declare the " + kind.toLowerCase() + " to change them.";
            }
            case 403: {
                // "ACCESS_REFUSED - access to queue 'q1' in vhost '/' refused for user 'dbx'"
                String name = extractQuotedName(text);
                String subject = name != null ? "'" + name + "'" : "the requested resource";
                return "Access to " + subject + " was refused."
                    + " Hint: check the user's configure/write/read permissions on the virtual host.";
            }
            default:
                return null;
        }
    }

    /** First single-quoted token in a broker reply text (usually the queue/exchange name). */
    static String extractQuotedName(String replyText) {
        if (replyText == null) {
            return null;
        }
        Matcher matcher = QUOTED_NAME.matcher(replyText);
        return matcher.find() ? matcher.group(1) : null;
    }

    /**
     * Queue/exchange name in a 406 PRECONDITION_FAILED reply ("... for queue 'q1'
     * in vhost ..."); the first quoted token there is the mismatched argument name.
     */
    static String extractDeclaredResourceName(String replyText) {
        if (replyText == null) {
            return null;
        }
        Matcher matcher = DECLARED_RESOURCE_NAME.matcher(replyText);
        return matcher.find() ? matcher.group(2) : null;
    }

    private static boolean isAuthenticationError(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String className = current.getClass().getName();
            if (className.contains("AuthenticationFailureException")
                || className.contains("PossibleAuthenticationFailureException")) {
                return true;
            }
        }
        return false;
    }

    private static Throwable rootCause(Throwable error) {
        Throwable current = error;
        for (int depth = 0; current.getCause() != null && current.getCause() != current && depth < 32; depth++) {
            current = current.getCause();
        }
        return current;
    }

    /**
     * Channel for the request's effective virtual host. The default vhost reuses
     * the primary channel; any other vhost lazily opens (and caches) its own
     * connection/channel pair, since AMQP connections are bound to one vhost.
     * Channels closed by the broker (e.g. after a 405/404 channel error) are
     * detected via {@link #needsNewChannel(Channel)} and rebuilt transparently,
     * so one failed call never poisons later ones.
     */
    private static Channel channelFor(JsonObject params) throws Exception {
        String defaultVhost = cachedConnection != null
            ? stringOrDefault(cachedConnection, "virtual_host", "/") : "/";
        String vhost = effectiveVhost(params, cachedConnection);
        if (vhost.equals(defaultVhost)) {
            return primaryChannel();
        }

        VhostClient client = vhostClients.get(vhost);
        if (client != null && client.isOpen()) {
            return client.channel;
        }
        if (client != null) {
            client.closeQuietly();
            vhostClients.remove(vhost);
        }
        JsonObject config = cachedConnection.deepCopy();
        config.addProperty("virtual_host", vhost);
        Connection vhostConnection = openConnection(config);
        Channel vhostChannel;
        try {
            vhostChannel = vhostConnection.createChannel();
        } catch (Exception e) {
            closeQuietly(vhostConnection);
            throw e;
        }
        vhostClients.put(vhost, new VhostClient(vhostConnection, vhostChannel));
        return vhostChannel;
    }

    /**
     * Primary channel for the connection's default vhost, recreating the channel
     * (or the whole connection) when the broker has closed it.
     */
    private static Channel primaryChannel() throws Exception {
        if (!needsNewChannel(channel)) {
            return channel;
        }
        if (connection == null || !connection.isOpen()) {
            if (cachedConnection == null) {
                throw new IllegalStateException("Not connected. Call connect first.");
            }
            closeQuietly(connection);
            connection = openConnection(cachedConnection);
        }
        closeQuietly(channel);
        channel = connection.createChannel();
        return channel;
    }

    /** A channel must be rebuilt when it is missing or the broker closed it. */
    static boolean needsNewChannel(Channel ch) {
        return ch == null || !ch.isOpen();
    }

    /**
     * Effective virtual host: an explicit {@code virtual_host} request parameter
     * wins (null/blank means "use the connection's vhost", which is what the
     * Rust bridge sends for flat/no-namespace contexts).
     */
    static String effectiveVhost(JsonObject params, JsonObject conn) {
        String vhost = stringOrNull(params, "virtual_host");
        if (vhost == null || vhost.isBlank()) {
            return conn != null ? stringOrDefault(conn, "virtual_host", "/") : "/";
        }
        return vhost;
    }

    /**
     * Whether the request asks for a cross-vhost listing ("all vhosts"). Wins
     * over {@code virtual_host}: the vhost-less management API variant is used
     * and each returned item carries its own {@code vhost} field.
     */
    static boolean allVhostsRequested(JsonObject params) {
        return boolOrDefault(params, "all_vhosts", false);
    }

    /**
     * Management API path for a list endpoint: the vhost-less variant when
     * {@code all_vhosts} is set, otherwise scoped to the effective vhost.
     */
    static String managementListPath(JsonObject params, JsonObject conn, String resource) {
        if (allVhostsRequested(params)) {
            return "/api/" + resource;
        }
        return "/api/" + resource + "/" + urlEncodeVhost(effectiveVhost(params, conn));
    }

    /**
     * Client-side vhost filter for connections/channels (the management API
     * always lists these cluster-wide); {@code all_vhosts} disables the filter.
     * Without an explicit {@code virtual_host} the filter falls back to the
     * connection's effective vhost, matching the topic/exchange list behavior.
     */
    static String vhostFilter(JsonObject params, JsonObject conn) {
        if (allVhostsRequested(params)) {
            return "";
        }
        return effectiveVhost(params, conn);
    }

    /** Copies the source entry's {@code vhost} into the mapped item (all-vhosts listings). */
    static void attachVhost(Map<String, Object> info, JsonObject source) {
        info.put("vhost", stringOrEmpty(source, "vhost"));
    }

    private static Connection requireConnection() {
        if (connection == null) {
            throw new IllegalStateException("Not connected. Call connect first.");
        }
        return connection;
    }

    private static JsonObject requireConnectionConfig(JsonObject params) {
        JsonObject conn = currentConnectionConfig(params);
        if (conn == null) {
            throw new IllegalStateException("Not connected. Call connect first.");
        }
        return conn;
    }

    private static JsonObject currentConnectionConfig(JsonObject params) {
        if (params.has("connection") && params.get("connection").isJsonObject()) {
            return params.getAsJsonObject("connection");
        }
        return cachedConnection;
    }

    private static JsonObject connectionObject(JsonObject params) {
        JsonElement connection = params.get("connection");
        return connection != null && connection.isJsonObject()
            ? connection.getAsJsonObject() : params;
    }

    /** Queue name: RabbitMQ semantics are flat, so a {@code namespace} parameter is ignored. */
    private static String queueName(JsonObject params) {
        String name = stringOrEmpty(params, "topic");
        if (name.isBlank()) {
            name = stringOrEmpty(params, "name");
        }
        if (name.isBlank()) {
            throw new IllegalArgumentException("topic (queue name) is required");
        }
        return name;
    }

    private static Object argumentValue(JsonElement element) {
        if (element == null || !element.isJsonPrimitive()) {
            return null;
        }
        if (element.getAsJsonPrimitive().isBoolean()) {
            return element.getAsBoolean();
        }
        if (element.getAsJsonPrimitive().isNumber()) {
            return element.getAsLong();
        }
        return element.getAsString();
    }

    private static String serverString(Map<String, Object> serverProps, String key) {
        Object value = serverProps.get(key);
        return value != null ? String.valueOf(value) : null;
    }

    private static String tryDecodeUtf8(byte[] bytes) {
        try {
            String text = new String(bytes, StandardCharsets.UTF_8);
            // Verify round-trip
            byte[] reEncoded = text.getBytes(StandardCharsets.UTF_8);
            if (Arrays.equals(bytes, reEncoded)) {
                return text;
            }
        } catch (Exception ignored) {}
        return null;
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

    private static Integer integerOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? null : element.getAsInt();
    }

    private static Long longOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? null : element.getAsLong();
    }

    private static int intOrDefault(JsonObject object, String key, int fallback) {
        Integer value = integerOrNull(object, key);
        return value == null ? fallback : value;
    }

    private static long longOrDefault(JsonObject object, String key, long fallback) {
        Long value = longOrNull(object, key);
        return value == null ? fallback : value;
    }

    private static boolean boolOrDefault(JsonObject object, String key, boolean fallback) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? fallback : element.getAsBoolean();
    }

    private static Integer integerProperty(JsonObject properties, String key) {
        try {
            return integerOrNull(properties, key);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Boolean booleanProperty(JsonObject properties, String key) {
        JsonElement element = properties.get(key);
        return element == null || element.isJsonNull() ? null : element.getAsBoolean();
    }

    private static boolean boolProperty(JsonObject conn, String key) {
        JsonObject properties = conn.has("properties") && conn.get("properties").isJsonObject()
            ? conn.getAsJsonObject("properties") : null;
        return properties != null && boolOrDefault(properties, key, false);
    }

    // -----------------------------------------------------------------------
    // Inner types
    // -----------------------------------------------------------------------

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

    /** Connection/channel pair cached for one non-default virtual host. */
    private static final class VhostClient {
        private final Connection connection;
        private final Channel channel;

        private VhostClient(Connection connection, Channel channel) {
            this.connection = connection;
            this.channel = channel;
        }

        private boolean isOpen() {
            return connection.isOpen() && channel.isOpen();
        }

        private void closeQuietly() {
            RabbitMqAgent.closeQuietly(channel);
            RabbitMqAgent.closeQuietly(connection);
        }
    }
}
