package com.dbx.agent.kafka;

import com.google.gson.*;
import org.apache.kafka.clients.admin.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.*;
import org.apache.kafka.common.acl.*;
import org.apache.kafka.common.config.ConfigResource;
import org.apache.kafka.common.errors.*;
import org.apache.kafka.common.header.internals.RecordHeader;
import org.apache.kafka.common.resource.PatternType;
import org.apache.kafka.common.resource.ResourcePattern;
import org.apache.kafka.common.resource.ResourcePatternFilter;
import org.apache.kafka.common.resource.ResourceType;
import org.apache.zookeeper.KeeperException;
import org.apache.zookeeper.Watcher;
import org.apache.zookeeper.ZooKeeper;
import org.apache.zookeeper.client.ZKClientConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * Kafka admin agent for DBX. Communicates with the Rust bridge via JSON-RPC
 * over stdin/stdout. Uses kafka-clients AdminClient for admin operations and
 * KafkaProducer for message production.
 */
public final class KafkaAgent {

    private static final PrintStream JSON_RPC_OUT = System.out;
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final int DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
    private static final int MAX_PEEK_MESSAGE_COUNT = 100;
    private static final int MAX_PEEK_SCAN_RECORDS = 1_000;
    private static final int DEFAULT_SESSION_TIMEOUT_MS = 30_000;
    private static final int DEFAULT_ZOOKEEPER_CONNECTION_TIMEOUT_MS = 10_000;
    private static final String ZOOKEEPER_PROPERTY_PREFIX = "zookeeper.";
    private static final Set<String> KERBEROS_SYSTEM_PROPERTY_KEYS = Set.of(
        "java.security.krb5.conf",
        "sun.security.krb5.debug",
        "javax.security.auth.useSubjectCredsOnly"
    );
    private static final Map<String, String> BASELINE_KERBEROS_SYSTEM_PROPERTIES =
        snapshotKerberosSystemProperties();

    private static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList(
        "mq_connect", "mq_test_connection", "mq_topics", "mq_consumer_groups",
        "mq_messages", "mq_acl", "mq_config", "mq_monitoring"
    ));

    private static AdminClient adminClient;
    private static KafkaProducer<String, byte[]> producer;
    private static JsonObject activeConnection;
    private static volatile boolean shutdownRequested;

    private KafkaAgent() {}

    private static Logger logger() {
        // Initialize only after main redirects System.out, so any logging backend
        // that defaults to stdout still cannot write into the JSON-RPC channel.
        return LoggerHolder.INSTANCE;
    }

    private static final class LoggerHolder {
        private static final Logger INSTANCE = LoggerFactory.getLogger(KafkaAgent.class);
    }

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    public static void main(String[] args) throws Exception {
        // Keep the original stdout exclusively for JSON-RPC. Redirect accidental
        // System.out writes from dependencies to stderr so they cannot corrupt the protocol.
        System.setOut(System.err);
        System.setProperty("org.slf4j.simpleLogger.logFile", "System.err");
        JSON_RPC_OUT.println("{\"ready\":true}");
        JSON_RPC_OUT.flush();

        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        while (true) {
            String line = reader.readLine();
            if (line == null) break;
            String response = handleRequest(line);
            JSON_RPC_OUT.println(response);
            JSON_RPC_OUT.flush();
            if (shutdownRequested) {
                System.exit(0);
            }
        }
    }

    // -----------------------------------------------------------------------
    // JSON-RPC dispatch
    // -----------------------------------------------------------------------

    static String handleRequest(String line) {
        JsonObject req = JsonParser.parseString(line).getAsJsonObject();
        JsonElement id = req.get("id");
        String method = req.get("method").getAsString();
        JsonObject params = req.has("params") && req.get("params").isJsonObject()
            ? req.getAsJsonObject("params") : new JsonObject();

        JsonObject response = new JsonObject();
        response.addProperty("jsonrpc", "2.0");
        response.add("id", id);

        try {
            Object result = dispatch(method, params);
            response.add("result", GSON.toJsonTree(result));
        } catch (Exception e) {
            logger().warn("Kafka Agent request failed: method={}, id={}", method, id, e);
            JsonObject error = new JsonObject();
            error.addProperty("code", -1);
            error.addProperty("message", normalizeErrorMessage(e));
            response.add("error", error);
        }
        return GSON.toJson(response);
    }

    private static Object dispatch(String method, JsonObject params) throws Exception {
        return switch (method) {
            case "handshake" -> handshakeResult();
            case "connect" -> connect(params);
            case "test_connection" -> testConnection(params);
            case "disconnect" -> { closeClients(); yield Collections.singletonMap("ok", true); }
            case "shutdown" -> { closeClients(); shutdownRequested = true; yield Collections.singletonMap("ok", true); }
            // Topic management
            case "mq_list_topics" -> listTopics(params);
            case "mq_create_topic" -> createTopic(params);
            case "mq_delete_topic" -> deleteTopic(params);
            case "mq_update_partitions" -> updatePartitions(params);
            case "mq_get_topic_stats" -> getTopicStats(params);
            case "mq_get_topic_config" -> getTopicConfig(params);
            case "mq_alter_topic_config" -> alterTopicConfig(params);
            // Consumer groups
            case "mq_list_consumer_groups" -> listConsumerGroups(params);
            case "mq_describe_consumer_group" -> describeConsumerGroup(params);
            case "mq_delete_consumer_group" -> deleteConsumerGroup(params);
            case "mq_reset_consumer_group_offsets" -> resetConsumerGroupOffsets(params);
            case "mq_list_producers" -> listProducers(params);
            // Messages
            case "mq_peek_messages" -> peekMessages(params);
            case "mq_send_message" -> sendMessage(params);
            // ACLs
            case "mq_list_acls" -> listAcls(params);
            case "mq_create_acls" -> createAcls(params);
            case "mq_delete_acls" -> deleteAcls(params);
            // Cluster / monitoring
            case "mq_describe_cluster" -> describeCluster(params);
            case "mq_get_consumer_lag" -> getConsumerLag(params);
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
        JsonObject conn = resolveBrokerConnection(connectionObject(params));
        Map<String, String> previousKerberosSystemProperties = applyKerberosSystemProperties(conn);
        AdminClient nextAdmin = null;
        KafkaProducer<String, byte[]> nextProducer = null;
        try {
            nextAdmin = buildAdminClient(conn);
            // Verify connectivity
            nextAdmin.describeCluster().clusterId().get(
                intOrDefault(conn, "request_timeout_ms", DEFAULT_REQUEST_TIMEOUT_MS), TimeUnit.MILLISECONDS);
            nextProducer = buildProducer(conn);
            closeClients();
            applyKerberosSystemProperties(conn);
            adminClient = nextAdmin;
            producer = nextProducer;
            activeConnection = conn.deepCopy();
            return Collections.singletonMap("ok", true);
        } catch (Exception e) {
            if (nextAdmin != null) {
                nextAdmin.close(Duration.ofSeconds(5));
            }
            if (nextProducer != null) {
                nextProducer.close(Duration.ofSeconds(5));
            }
            restoreKerberosSystemProperties(previousKerberosSystemProperties);
            throw e;
        }
    }

    private static Object testConnection(JsonObject params) throws Exception {
        JsonObject conn = resolveBrokerConnection(connectionObject(params));
        Map<String, String> previousKerberosSystemProperties = applyKerberosSystemProperties(conn);
        AdminClient probe = null;
        try {
            probe = buildAdminClient(conn);
            int timeout = intOrDefault(conn, "request_timeout_ms", DEFAULT_REQUEST_TIMEOUT_MS);
            DescribeClusterResult cluster = probe.describeCluster();
            String clusterId = cluster.clusterId().get(timeout, TimeUnit.MILLISECONDS);
            Node controller = cluster.controller().get(timeout, TimeUnit.MILLISECONDS);
            Collection<Node> brokers = cluster.nodes().get(timeout, TimeUnit.MILLISECONDS);

            // Probe ACL support: try a describe operation and catch security errors.
            boolean aclEnabled = true;
            try {
                probe.describeAcls(AclBindingFilter.ANY)
                    .values().get(timeout, TimeUnit.MILLISECONDS);
            } catch (Exception aclEx) {
                if (isAclDisabledError(aclEx)) {
                    aclEnabled = false;
                    logger().debug("Kafka ACL support is disabled by the broker");
                } else {
                    logger().warn("Kafka ACL capability probe failed; leaving the capability enabled", aclEx);
                }
            }

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("ok", true);
            result.put("clusterId", clusterId);
            result.put("controller", controller != null ? nodeToMap(controller) : null);
            result.put("aclEnabled", aclEnabled);
            List<Map<String, Object>> brokerList = new ArrayList<>();
            for (Node node : brokers) {
                brokerList.add(nodeToMap(node));
            }
            result.put("brokers", brokerList);
            return result;
        } finally {
            if (probe != null) {
                probe.close(Duration.ofSeconds(5));
            }
            restoreKerberosSystemProperties(previousKerberosSystemProperties);
        }
    }

    static boolean isAclDisabledError(Throwable error) {
        Throwable cause = error;
        while (cause != null) {
            if (cause.getClass().getSimpleName().contains("SecurityDisabled")
                || (cause.getMessage() != null && cause.getMessage().contains("No Authorizer"))) {
                return true;
            }
            cause = cause.getCause();
        }
        return false;
    }

    private static void closeClients() {
        if (adminClient != null) {
            adminClient.close(Duration.ofSeconds(5));
            adminClient = null;
        }
        if (producer != null) {
            producer.close(Duration.ofSeconds(5));
            producer = null;
        }
        activeConnection = null;
        restoreKerberosSystemProperties(BASELINE_KERBEROS_SYSTEM_PROPERTIES);
    }

    // -----------------------------------------------------------------------
    // Client builders
    // -----------------------------------------------------------------------

    static AdminClient buildAdminClient(JsonObject conn) {
        Properties props = new Properties();
        props.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers(conn));
        props.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG,
            intOrDefault(conn, "request_timeout_ms", DEFAULT_REQUEST_TIMEOUT_MS));
        props.put(AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG,
            intOrDefault(conn, "request_timeout_ms", DEFAULT_REQUEST_TIMEOUT_MS));
        applyConnectionProperties(conn, props);
        return AdminClient.create(props);
    }

    private static KafkaProducer<String, byte[]> buildProducer(JsonObject conn) {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers(conn));
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
            "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
            "org.apache.kafka.common.serialization.ByteArraySerializer");
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        applyConnectionProperties(conn, props);
        return new KafkaProducer<>(props);
    }

    private static String bootstrapServers(JsonObject conn) {
        String servers = stringOrEmpty(conn, "bootstrap_servers");
        if (servers.isBlank()) {
            servers = stringOrEmpty(conn, "bootstrapServers");
        }
        if (servers.isBlank()) {
            throw new IllegalArgumentException("bootstrap_servers is required");
        }
        return servers;
    }

    static JsonObject resolveBrokerConnection(JsonObject conn) throws Exception {
        String configured = stringOrEmpty(conn, "bootstrap_servers");
        if (configured.isBlank()) configured = stringOrEmpty(conn, "bootstrapServers");
        if (!configured.isBlank()) return conn;

        String connectString = stringOrEmpty(conn, "zookeeper_connect_string");
        if (connectString.isBlank()) connectString = stringOrEmpty(conn, "zookeeperServers");
        if (connectString.isBlank()) {
            throw new IllegalArgumentException("bootstrap_servers or zookeeper_connect_string is required");
        }

        JsonObject resolved = conn.deepCopy();
        resolved.addProperty("bootstrap_servers", discoverBootstrapServers(connectString, securityProtocol(conn), conn));
        return resolved;
    }

    private static String discoverBootstrapServers(String connectString, String securityProtocol, JsonObject conn)
        throws Exception {
        int sessionTimeout = intOrDefault(conn, "zookeeper_session_timeout_ms", DEFAULT_SESSION_TIMEOUT_MS);
        int connectionTimeout = intOrDefault(
            conn,
            "zookeeper_connection_timeout_ms",
            DEFAULT_ZOOKEEPER_CONNECTION_TIMEOUT_MS
        );
        CountDownLatch connected = new CountDownLatch(1);
        ZooKeeper zooKeeper = new ZooKeeper(connectString, sessionTimeout, event -> {
            if (event.getState() == Watcher.Event.KeeperState.SyncConnected) connected.countDown();
        }, zooKeeperClientConfig(conn));
        try {
            if (!connected.await(connectionTimeout, TimeUnit.MILLISECONDS)) {
                throw new IllegalStateException("Timed out connecting to ZooKeeper for Kafka broker discovery");
            }

            List<String> brokerIds;
            try {
                brokerIds = new ArrayList<>(zooKeeper.getChildren("/brokers/ids", false));
            } catch (KeeperException.NoNodeException e) {
                throw new IllegalStateException("ZooKeeper path /brokers/ids does not exist", e);
            }
            brokerIds.sort(KafkaAgent::compareBrokerIds);

            List<JsonObject> registrations = new ArrayList<>();
            for (String brokerId : brokerIds) {
                try {
                    byte[] data = zooKeeper.getData("/brokers/ids/" + brokerId, false, null);
                    registrations.add(JsonParser.parseString(new String(data, StandardCharsets.UTF_8)).getAsJsonObject());
                } catch (KeeperException.NoNodeException e) {
                    // Expected race: a broker may refresh its ephemeral node between list and read.
                    logger().debug("Kafka broker {} disappeared during ZooKeeper discovery", brokerId);
                } catch (RuntimeException e) {
                    logger().warn("Skipping malformed ZooKeeper registration for Kafka broker {}", brokerId, e);
                }
            }
            return brokerEndpoints(registrations, securityProtocol);
        } finally {
            zooKeeper.close();
        }
    }

    static ZKClientConfig zooKeeperClientConfig(JsonObject conn) {
        ZKClientConfig clientConfig = new ZKClientConfig();
        JsonObject properties = connectionProperties(conn);
        if (properties == null) return clientConfig;

        for (Map.Entry<String, JsonElement> entry : properties.entrySet()) {
            if (entry.getKey().startsWith(ZOOKEEPER_PROPERTY_PREFIX)
                && entry.getValue().isJsonPrimitive()) {
                clientConfig.setProperty(entry.getKey(), entry.getValue().getAsString());
            }
        }
        return clientConfig;
    }

    private static int compareBrokerIds(String left, String right) {
        try {
            return Integer.compare(Integer.parseInt(left), Integer.parseInt(right));
        } catch (NumberFormatException e) {
            // Third-party registries may use non-numeric IDs; lexical ordering remains deterministic.
            logger().debug("Sorting non-numeric Kafka broker IDs lexically: left={}, right={}", left, right);
            return left.compareTo(right);
        }
    }

    static String brokerEndpoints(List<JsonObject> registrations, String securityProtocol) {
        String targetProtocol = securityProtocol == null || securityProtocol.isBlank()
            ? "PLAINTEXT"
            : securityProtocol.toUpperCase(Locale.ROOT);
        Set<String> addresses = new LinkedHashSet<>();

        for (JsonObject registration : registrations) {
            int addressCount = addresses.size();
            JsonObject protocolMap = registration.has("listener_security_protocol_map")
                && registration.get("listener_security_protocol_map").isJsonObject()
                ? registration.getAsJsonObject("listener_security_protocol_map")
                : new JsonObject();
            JsonArray endpoints = registration.has("endpoints") && registration.get("endpoints").isJsonArray()
                ? registration.getAsJsonArray("endpoints")
                : new JsonArray();

            for (JsonElement element : endpoints) {
                if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) continue;
                String endpoint = element.getAsString();
                int separator = endpoint.indexOf("://");
                if (separator <= 0) continue;
                String listener = endpoint.substring(0, separator).toUpperCase(Locale.ROOT);
                JsonElement mapped = protocolMap.get(listener);
                String mappedProtocol = mapped != null && mapped.isJsonPrimitive()
                    ? mapped.getAsString().toUpperCase(Locale.ROOT)
                    : listener;
                if (!targetProtocol.equals(mappedProtocol)) continue;
                String address = endpointAddress(endpoint);
                if (address != null) addresses.add(address);
            }

            if (addresses.size() == addressCount && endpoints.size() == 0 && registration.has("host") && registration.has("port")) {
                try {
                    String host = registration.get("host").getAsString().trim();
                    int port = registration.get("port").getAsInt();
                    if (!host.isEmpty() && port > 0 && port <= 65535) addresses.add(formatHostPort(host, port));
                } catch (RuntimeException e) {
                    logger().warn("Skipping malformed legacy Kafka broker registration", e);
                }
            }
        }

        if (addresses.isEmpty()) {
            throw new IllegalArgumentException("ZooKeeper did not return any usable Kafka broker endpoints");
        }
        return String.join(",", addresses);
    }

    private static String endpointAddress(String endpoint) {
        try {
            URI uri = URI.create(endpoint);
            String host = uri.getHost();
            int port = uri.getPort();
            if (host == null || host.isBlank() || port <= 0 || port > 65535) return null;
            return formatHostPort(host, port);
        } catch (IllegalArgumentException e) {
            logger().debug("Skipping malformed Kafka broker endpoint", e);
            return null;
        }
    }

    private static String formatHostPort(String host, int port) {
        return host.contains(":") && !host.startsWith("[") ? "[" + host + "]:" + port : host + ":" + port;
    }

    private static String securityProtocol(JsonObject conn) {
        String protocol = stringOrEmpty(conn, "security_protocol");
        if (protocol.isBlank()) protocol = stringOrEmpty(conn, "securityProtocol");
        return protocol.isBlank() ? "PLAINTEXT" : protocol;
    }

    static void applySecurityProperties(JsonObject conn, Properties props) {
        String securityProtocol = stringOrEmpty(conn, "security_protocol");
        if (securityProtocol.isBlank()) {
            securityProtocol = stringOrEmpty(conn, "securityProtocol");
        }
        if (securityProtocol.isBlank()) {
            securityProtocol = "PLAINTEXT";
        }
        props.put("security.protocol", securityProtocol);

        String saslMechanism = stringOrEmpty(conn, "sasl_mechanism");
        if (saslMechanism.isBlank()) {
            saslMechanism = stringOrEmpty(conn, "saslMechanism");
        }
        if (!saslMechanism.isBlank()) {
            props.put("sasl.mechanism", saslMechanism);
        }

        String saslUsername = stringOrEmpty(conn, "sasl_username");
        if (saslUsername.isBlank()) saslUsername = stringOrEmpty(conn, "saslUsername");
        String saslPassword = stringOrEmpty(conn, "sasl_password");
        if (saslPassword.isBlank()) saslPassword = stringOrEmpty(conn, "saslPassword");

        if (!saslUsername.isBlank() && !saslMechanism.isBlank()) {
            String jaasTemplate = switch (saslMechanism.toUpperCase()) {
                case "PLAIN" -> "org.apache.kafka.common.security.plain.PlainLoginModule required "
                    + "username=\"%s\" password=\"%s\";";
                case "SCRAM-SHA-256", "SCRAM-SHA-512" ->
                    "org.apache.kafka.common.security.scram.ScramLoginModule required "
                    + "username=\"%s\" password=\"%s\";";
                default -> null;
            };
            if (jaasTemplate != null) {
                props.put("sasl.jaas.config", String.format(jaasTemplate, jaasValue(saslUsername), jaasValue(saslPassword)));
            }
        }

        JsonObject tls = conn.has("tls") && conn.get("tls").isJsonObject()
            ? conn.getAsJsonObject("tls") : null;
        boolean skipVerify = boolOrDefault(conn, "tls_skip_verify", false)
            || boolOrDefault(conn, "tlsSkipVerify", false)
            || (tls != null && boolOrDefault(tls, "skip_verify", false));
        if (skipVerify) {
            props.put("ssl.endpoint.identification.algorithm", "");
        }

        // TLS properties
        if (tls != null) {
            String truststorePath = stringOrEmpty(tls, "truststore_path");
            if (!truststorePath.isBlank()) {
                props.put("ssl.truststore.location", truststorePath);
                String truststorePassword = stringOrEmpty(tls, "truststore_password");
                if (!truststorePassword.isBlank()) {
                    props.put("ssl.truststore.password", truststorePassword);
                }
            }
            String keystorePath = stringOrEmpty(tls, "keystore_path");
            if (!keystorePath.isBlank()) {
                props.put("ssl.keystore.location", keystorePath);
                String keystorePassword = stringOrEmpty(tls, "keystore_password");
                if (!keystorePassword.isBlank()) {
                    props.put("ssl.keystore.password", keystorePassword);
                }
            }
        }
    }

    static void applyConnectionProperties(JsonObject conn, Properties props) {
        applySecurityProperties(conn, props);
        applyExtraProperties(conn, props);
    }

    static String jaasValue(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    @SuppressWarnings("unchecked")
    private static void applyExtraProperties(JsonObject conn, Properties props) {
        JsonObject properties = conn.has("properties") && conn.get("properties").isJsonObject()
            ? conn.getAsJsonObject("properties") : null;
        if (properties != null) {
            for (Map.Entry<String, JsonElement> entry : properties.entrySet()) {
                if (entry.getValue().isJsonPrimitive()) {
                    String key = entry.getKey();
                    if (key.startsWith(ZOOKEEPER_PROPERTY_PREFIX)) continue;
                    String value = entry.getValue().getAsString();
                    props.put(key, value);
                }
            }
        }
    }

    static Map<String, String> applyKerberosSystemProperties(JsonObject conn) {
        Map<String, String> previous = snapshotKerberosSystemProperties();
        JsonObject properties = connectionProperties(conn);
        for (String key : KERBEROS_SYSTEM_PROPERTY_KEYS) {
            String value = stringProperty(properties, key);
            if (value == null || value.isBlank()) {
                value = BASELINE_KERBEROS_SYSTEM_PROPERTIES.get(key);
            }
            setOrClearSystemProperty(key, value);
        }
        return previous;
    }

    static void restoreKerberosSystemProperties(Map<String, String> values) {
        for (String key : KERBEROS_SYSTEM_PROPERTY_KEYS) {
            setOrClearSystemProperty(key, values.get(key));
        }
    }

    private static Map<String, String> snapshotKerberosSystemProperties() {
        Map<String, String> values = new LinkedHashMap<>();
        for (String key : KERBEROS_SYSTEM_PROPERTY_KEYS) {
            values.put(key, System.getProperty(key));
        }
        return values;
    }

    private static JsonObject connectionProperties(JsonObject conn) {
        return conn.has("properties") && conn.get("properties").isJsonObject()
            ? conn.getAsJsonObject("properties") : null;
    }

    private static String stringProperty(JsonObject properties, String key) {
        if (properties == null || !properties.has(key) || !properties.get(key).isJsonPrimitive()) {
            return null;
        }
        return properties.get(key).getAsString();
    }

    private static void setOrClearSystemProperty(String key, String value) {
        if (value == null || value.isBlank()) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, value);
        }
    }

    // -----------------------------------------------------------------------
    // Topic management
    // -----------------------------------------------------------------------

    private static Object listTopics(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        Set<String> names = admin.listTopics(new ListTopicsOptions().timeoutMs(timeout))
            .names().get(timeout, TimeUnit.MILLISECONDS);
        if (names.isEmpty()) {
            return Collections.singletonMap("topics", Collections.emptyList());
        }

        Map<String, TopicDescription> descriptions = admin.describeTopics(names)
            .allTopicNames().get(timeout, TimeUnit.MILLISECONDS);

        List<Map<String, Object>> topics = new ArrayList<>();
        for (Map.Entry<String, TopicDescription> entry : descriptions.entrySet()) {
            TopicDescription desc = entry.getValue();
            Map<String, Object> topic = new LinkedHashMap<>();
            topic.put("name", desc.name());
            topic.put("partitions", desc.partitions().size());
            topic.put("replicationFactor", desc.partitions().isEmpty() ? 0
                : desc.partitions().get(0).replicas().size());
            topic.put("internal", desc.isInternal());
            topics.add(topic);
        }
        topics.sort(Comparator.comparing(m -> (String) m.get("name")));
        return Collections.singletonMap("topics", topics);
    }

    private static Object createTopic(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String name = stringOrEmpty(params, "name");
        int partitions = intOrDefault(params, "partitions", 1);
        short replicationFactor = (short) intOrDefault(params, "replicationFactor", 1);

        NewTopic newTopic = new NewTopic(name, partitions, replicationFactor);

        // Optional configs
        JsonObject configs = params.has("configs") && params.get("configs").isJsonObject()
            ? params.getAsJsonObject("configs") : null;
        if (configs != null) {
            Map<String, String> configMap = new HashMap<>();
            for (Map.Entry<String, JsonElement> entry : configs.entrySet()) {
                configMap.put(entry.getKey(), entry.getValue().getAsString());
            }
            newTopic.configs(configMap);
        }

        admin.createTopics(Collections.singletonList(newTopic))
            .all().get(timeout, TimeUnit.MILLISECONDS);
        return Collections.singletonMap("ok", true);
    }

    private static Object deleteTopic(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String name = stringOrEmpty(params, "name");
        admin.deleteTopics(Collections.singletonList(name))
            .all().get(timeout, TimeUnit.MILLISECONDS);
        return Collections.singletonMap("ok", true);
    }

    private static Object updatePartitions(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String name = stringOrEmpty(params, "name");
        int totalPartitions = intOrDefault(params, "totalPartitions", 1);
        admin.createPartitions(Collections.singletonMap(name, NewPartitions.increaseTo(totalPartitions)))
            .all().get(timeout, TimeUnit.MILLISECONDS);
        return Collections.singletonMap("ok", true);
    }

    private static Object getTopicStats(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String name = stringOrEmpty(params, "name");

        TopicDescription desc = admin.describeTopics(Collections.singletonList(name))
            .allTopicNames().get(timeout, TimeUnit.MILLISECONDS).get(name);

        // Collect offsets for size estimation
        Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> endOffsets = new LinkedHashMap<>();
        Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> beginOffsets = new LinkedHashMap<>();
        for (TopicPartitionInfo pi : desc.partitions()) {
            TopicPartition tp = new TopicPartition(name, pi.partition());
            endOffsets.put(tp, admin.listOffsets(Collections.singletonMap(tp, OffsetSpec.latest()))
                .all().get(timeout, TimeUnit.MILLISECONDS).get(tp));
            beginOffsets.put(tp, admin.listOffsets(Collections.singletonMap(tp, OffsetSpec.earliest()))
                .all().get(timeout, TimeUnit.MILLISECONDS).get(tp));
        }

        long totalMessages = 0;
        List<Map<String, Object>> partitionStats = new ArrayList<>();
        for (TopicPartitionInfo pi : desc.partitions()) {
            TopicPartition tp = new TopicPartition(name, pi.partition());
            long end = endOffsets.get(tp).offset();
            long begin = beginOffsets.get(tp).offset();
            long count = end - begin;
            totalMessages += count;

            Map<String, Object> ps = new LinkedHashMap<>();
            ps.put("partition", pi.partition());
            ps.put("leader", pi.leader() != null ? pi.leader().id() : -1);
            ps.put("replicas", pi.replicas().stream().map(Node::id).collect(Collectors.toList()));
            ps.put("isr", pi.isr().stream().map(Node::id).collect(Collectors.toList()));
            ps.put("beginOffset", begin);
            ps.put("endOffset", end);
            ps.put("messageCount", count);
            partitionStats.add(ps);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", name);
        result.put("partitions", desc.partitions().size());
        result.put("replicationFactor", desc.partitions().isEmpty() ? 0
            : desc.partitions().get(0).replicas().size());
        result.put("totalMessages", totalMessages);
        result.put("partitionStats", partitionStats);
        return result;
    }

    private static Object getTopicConfig(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String name = stringOrEmpty(params, "name");

        ConfigResource resource = new ConfigResource(ConfigResource.Type.TOPIC, name);
        Config config = admin.describeConfigs(Collections.singletonList(resource))
            .all().get(timeout, TimeUnit.MILLISECONDS).get(resource);

        Map<String, Object> configs = new LinkedHashMap<>();
        for (ConfigEntry entry : config.entries()) {
            Map<String, Object> entryMap = new LinkedHashMap<>();
            entryMap.put("value", entry.value());
            entryMap.put("source", entry.source().name());
            entryMap.put("isSensitive", entry.isSensitive());
            entryMap.put("isReadOnly", entry.isReadOnly());
            entryMap.put("isDefault", entry.isDefault());
            configs.put(entry.name(), entryMap);
        }
        return Collections.singletonMap("configs", configs);
    }

    private static Object alterTopicConfig(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String name = stringOrEmpty(params, "name");

        JsonArray entries = params.has("configs") && params.get("configs").isJsonArray()
            ? params.getAsJsonArray("configs") : new JsonArray();

        List<AlterConfigOp> ops = new ArrayList<>();
        for (JsonElement el : entries) {
            JsonObject entry = el.getAsJsonObject();
            String key = entry.get("key").getAsString();
            String value = entry.has("value") && !entry.get("value").isJsonNull()
                ? entry.get("value").getAsString() : null;
            String opStr = stringOrDefault(entry, "op", "set");
            AlterConfigOp.OpType opType = switch (opStr.toLowerCase()) {
                case "delete" -> AlterConfigOp.OpType.DELETE;
                case "append" -> AlterConfigOp.OpType.APPEND;
                case "subtract" -> AlterConfigOp.OpType.SUBTRACT;
                default -> AlterConfigOp.OpType.SET;
            };
            ops.add(new AlterConfigOp(new ConfigEntry(key, value), opType));
        }

        ConfigResource resource = new ConfigResource(ConfigResource.Type.TOPIC, name);
        try {
            admin.incrementalAlterConfigs(Collections.singletonMap(resource, ops))
                .all().get(timeout, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            if (!isUnsupportedVersionError(e)) throw e;
            logger().info("Kafka broker does not support incrementalAlterConfigs; using legacy alterConfigs for topic {}", name);
            Config current = admin.describeConfigs(Collections.singletonList(resource))
                .all().get(timeout, TimeUnit.MILLISECONDS).get(resource);
            Map<String, String> values = legacyTopicConfig(current, ops);
            Config replacement = new Config(values.entrySet().stream()
                .map(entry -> new ConfigEntry(entry.getKey(), entry.getValue()))
                .collect(Collectors.toList()));
            admin.alterConfigs(Collections.singletonMap(resource, replacement))
                .all().get(timeout, TimeUnit.MILLISECONDS);
        }
        return Collections.singletonMap("ok", true);
    }

    static Map<String, String> legacyTopicConfig(Config current, List<AlterConfigOp> ops) {
        Map<String, String> values = new LinkedHashMap<>();
        for (ConfigEntry entry : current.entries()) {
            boolean topicOverride = entry.source() == ConfigEntry.ConfigSource.DYNAMIC_TOPIC_CONFIG
                || entry.source() == ConfigEntry.ConfigSource.UNKNOWN;
            if (topicOverride && !entry.isReadOnly() && !entry.isSensitive() && entry.value() != null) {
                values.put(entry.name(), entry.value());
            }
        }

        for (AlterConfigOp op : ops) {
            String key = op.configEntry().name();
            switch (op.opType()) {
                case SET -> values.put(key, op.configEntry().value());
                case DELETE -> values.remove(key);
                case APPEND, SUBTRACT -> throw new IllegalArgumentException(
                    "Kafka broker does not support " + op.opType() + " config operations through the legacy alterConfigs API"
                );
            }
        }
        return values;
    }

    // -----------------------------------------------------------------------
    // Consumer groups
    // -----------------------------------------------------------------------

    private static Object listConsumerGroups(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        Collection<ConsumerGroupListing> groups = admin.listConsumerGroups(
                new ListConsumerGroupsOptions().timeoutMs(timeout))
            .all().get(timeout, TimeUnit.MILLISECONDS);

        List<Map<String, Object>> result = new ArrayList<>();
        for (ConsumerGroupListing group : groups) {
            Map<String, Object> g = new LinkedHashMap<>();
            g.put("groupId", group.groupId());
            g.put("state", group.state().map(Enum::name).orElse("UNKNOWN"));
            g.put("simpleGroup", group.isSimpleConsumerGroup());
            result.add(g);
        }
        result.sort(Comparator.comparing(m -> (String) m.get("groupId")));
        return Collections.singletonMap("groups", result);
    }

    private static Object describeConsumerGroup(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String groupId = stringOrEmpty(params, "groupId");

        ConsumerGroupDescription desc = admin.describeConsumerGroups(Collections.singletonList(groupId))
            .all().get(timeout, TimeUnit.MILLISECONDS).get(groupId);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("groupId", desc.groupId());
        result.put("state", desc.state().name());
        result.put("coordinator", nodeToMap(desc.coordinator()));
        result.put("partitionAssignor", desc.partitionAssignor());

        List<Map<String, Object>> members = new ArrayList<>();
        for (MemberDescription member : desc.members()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("memberId", member.consumerId());
            m.put("clientId", member.clientId());
            m.put("host", member.host());
            List<Map<String, Object>> assignments = new ArrayList<>();
            for (TopicPartition tp : member.assignment().topicPartitions()) {
                Map<String, Object> a = new LinkedHashMap<>();
                a.put("topic", tp.topic());
                a.put("partition", tp.partition());
                assignments.add(a);
            }
            m.put("assignments", assignments);
            members.add(m);
        }
        result.put("members", members);
        return result;
    }

    private static Object listProducers(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String topic = stringOrEmpty(params, "topic");

        try {
            TopicDescription desc = admin.describeTopics(Collections.singletonList(topic))
                .allTopicNames().get(timeout, TimeUnit.MILLISECONDS).get(topic);
            List<TopicPartition> partitions = desc.partitions().stream()
                .map(pi -> new TopicPartition(topic, pi.partition()))
                .collect(Collectors.toList());

            DescribeProducersResult described = admin.describeProducers(
                partitions,
                new DescribeProducersOptions().timeoutMs(timeout));

            Map<Long, Map<String, Object>> byProducer = new LinkedHashMap<>();
            for (TopicPartition tp : partitions) {
                DescribeProducersResult.PartitionProducerState state =
                    described.partitionResult(tp).get(timeout, TimeUnit.MILLISECONDS);
                for (ProducerState producerState : state.activeProducers()) {
                    long producerId = producerState.producerId();
                    Map<String, Object> producer = byProducer.computeIfAbsent(producerId, id -> {
                        Map<String, Object> p = new LinkedHashMap<>();
                        p.put("producerId", id);
                        p.put("producerName", "producer-" + id);
                        p.put("msgRateIn", 0.0);
                        p.put("msgThroughputIn", 0.0);
                        p.put("clientVersion", "Kafka producer");
                        p.put("partitions", new ArrayList<Integer>());
                        p.put("lastTimestamp", producerState.lastTimestamp());
                        return p;
                    });
                    @SuppressWarnings("unchecked")
                    List<Integer> producerPartitions = (List<Integer>) producer.get("partitions");
                    producerPartitions.add(tp.partition());
                    long currentLastTimestamp = (long) producer.get("lastTimestamp");
                    if (producerState.lastTimestamp() > currentLastTimestamp) {
                        producer.put("lastTimestamp", producerState.lastTimestamp());
                    }
                }
            }

            for (Map<String, Object> producer : byProducer.values()) {
                @SuppressWarnings("unchecked")
                List<Integer> producerPartitions = (List<Integer>) producer.get("partitions");
                producerPartitions.sort(Integer::compareTo);
                producer.put(
                    "address",
                    producerPartitions.size() == 1
                        ? "partition " + producerPartitions.get(0)
                        : "partitions " + producerPartitions.stream().map(String::valueOf).collect(Collectors.joining(", "))
                );
            }

            return Collections.singletonMap("producers", new ArrayList<>(byProducer.values()));
        } catch (Exception e) {
            if (isUnsupportedVersionError(e)) {
                logger().info("Kafka broker does not support describeProducers; returning an empty producer list");
                return Collections.singletonMap("producers", Collections.emptyList());
            }
            throw e;
        }
    }

    private static Object deleteConsumerGroup(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String groupId = stringOrEmpty(params, "groupId");
        admin.deleteConsumerGroups(Collections.singletonList(groupId))
            .all().get(timeout, TimeUnit.MILLISECONDS);
        return Collections.singletonMap("ok", true);
    }

    private static Object resetConsumerGroupOffsets(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String groupId = stringOrEmpty(params, "groupId");
        String topic = stringOrEmpty(params, "topic");

        Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
        JsonArray offsetArray = params.has("offsets") && params.get("offsets").isJsonArray()
            ? params.getAsJsonArray("offsets") : new JsonArray();

        for (JsonElement el : offsetArray) {
            JsonObject offsetObj = el.getAsJsonObject();
            int partition = offsetObj.get("partition").getAsInt();
            long offset = offsetObj.get("offset").getAsLong();
            offsets.put(new TopicPartition(topic, partition), new OffsetAndMetadata(offset));
        }

        // If no explicit offsets, check for a "position" parameter.
        if (offsets.isEmpty()) {
            String position = stringOrDefault(params, "position", "latest");
            Long timestampMs = params.has("timestampMs") && !params.get("timestampMs").isJsonNull()
                ? params.get("timestampMs").getAsLong() : null;
            TopicDescription desc = admin.describeTopics(Collections.singletonList(topic))
                .allTopicNames().get(timeout, TimeUnit.MILLISECONDS).get(topic);

            Map<TopicPartition, OffsetSpec> specMap = new HashMap<>();
            for (TopicPartitionInfo pi : desc.partitions()) {
                TopicPartition tp = new TopicPartition(topic, pi.partition());
                specMap.put(tp, offsetSpecForPosition(position, timestampMs));
            }
            Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> resolved =
                admin.listOffsets(specMap).all().get(timeout, TimeUnit.MILLISECONDS);
            List<TopicPartition> unresolvedTimestampPartitions = new ArrayList<>();
            for (Map.Entry<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> entry : resolved.entrySet()) {
                long offset = entry.getValue().offset();
                if (offset >= 0) {
                    offsets.put(entry.getKey(), new OffsetAndMetadata(offset));
                } else {
                    unresolvedTimestampPartitions.add(entry.getKey());
                }
            }
            if (!unresolvedTimestampPartitions.isEmpty()) {
                Map<TopicPartition, OffsetSpec> latestSpecs = new HashMap<>();
                for (TopicPartition tp : unresolvedTimestampPartitions) {
                    latestSpecs.put(tp, OffsetSpec.latest());
                }
                Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> latest =
                    admin.listOffsets(latestSpecs).all().get(timeout, TimeUnit.MILLISECONDS);
                for (Map.Entry<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> entry : latest.entrySet()) {
                    offsets.put(entry.getKey(), new OffsetAndMetadata(entry.getValue().offset()));
                }
            }
        }

        admin.alterConsumerGroupOffsets(groupId, offsets)
            .all().get(timeout, TimeUnit.MILLISECONDS);
        return Collections.singletonMap("ok", true);
    }

    static OffsetSpec offsetSpecForPosition(String position, Long timestampMs) {
        String normalized = position == null ? "latest" : position.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "earliest" -> OffsetSpec.earliest();
            case "latest", "" -> OffsetSpec.latest();
            case "timestamp" -> {
                if (timestampMs == null) {
                    throw new IllegalArgumentException("timestampMs is required when position is timestamp");
                }
                yield OffsetSpec.forTimestamp(timestampMs);
            }
            default -> throw new IllegalArgumentException("Unsupported reset position: " + position);
        };
    }

    // -----------------------------------------------------------------------
    // Messages
    // -----------------------------------------------------------------------

    private static Object peekMessages(JsonObject params) throws Exception {
        String topic = stringOrEmpty(params, "topic");
        Integer partition = integerOrNull(params, "partition");
        Long offset = longOrNull(params, "offset");
        int count = validatedPeekCount(intOrDefault(params, "count", 10));
        PeekStartPosition startPosition = peekStartPosition(params);
        boolean explicitStartPosition = stringOrNull(params, "startPosition") != null;
        validatePeekRequest(startPosition, explicitStartPosition, partition, offset);
        boolean legacyOffsetRequest = !explicitStartPosition && offset != null;

        JsonObject conn = activeConnection;
        if (conn == null) {
            throw new IllegalStateException("Kafka Agent is not connected");
        }
        Properties props = peekConsumerProperties(conn, count);
        Duration requestTimeout = Duration.ofMillis(peekRequestTimeoutMs(conn, props));

        try (KafkaConsumer<String, byte[]> consumer = new KafkaConsumer<>(props)) {
            List<TopicPartition> candidatePartitions = resolvePeekPartitions(
                consumer, topic, partition, requestTimeout
            );
            if (candidatePartitions.isEmpty()) {
                return peekMessagesResult(Collections.emptyList(), false);
            }

            Map<TopicPartition, Long> beginningOffsets =
                consumer.beginningOffsets(candidatePartitions, requestTimeout);
            Map<TopicPartition, Long> endOffsets =
                consumer.endOffsets(candidatePartitions, requestTimeout);

            List<TopicPartition> readablePartitions = new ArrayList<>();
            Map<TopicPartition, Long> seekOffsets = new LinkedHashMap<>();
            for (TopicPartition tp : candidatePartitions) {
                long beginningOffset = beginningOffsets.getOrDefault(tp, 0L);
                long endOffset = endOffsets.getOrDefault(tp, beginningOffset);
                Long requestedOffset = requestedPeekOffset(
                    startPosition, offset, legacyOffsetRequest, beginningOffset, endOffset
                );
                if (requestedOffset == null) {
                    continue;
                }
                Long seekOffset = normalizePeekOffset(requestedOffset, beginningOffset, endOffset);
                if (seekOffset == null) {
                    continue;
                }
                readablePartitions.add(tp);
                seekOffsets.put(tp, seekOffset);
            }
            if (readablePartitions.isEmpty()) {
                return peekMessagesResult(Collections.emptyList(), false);
            }

            int messagesPerPartition = peekMessagesPerPartition(count, readablePartitions.size());
            int scanLimit = peekScanLimit(count, readablePartitions.size());
            Map<TopicPartition, Long> snapshotEndOffsets = new LinkedHashMap<>();
            if (startPosition == PeekStartPosition.LATEST) {
                for (TopicPartition tp : readablePartitions) {
                    long beginningOffset = beginningOffsets.getOrDefault(tp, 0L);
                    long endOffset = endOffsets.getOrDefault(tp, beginningOffset);
                    seekOffsets.put(tp, recentPeekStartOffset(
                        beginningOffset, endOffset, messagesPerPartition
                    ));
                }
            }
            for (TopicPartition tp : readablePartitions) {
                snapshotEndOffsets.put(tp, endOffsets.getOrDefault(tp, 0L));
            }

            consumer.assign(readablePartitions);
            for (Map.Entry<TopicPartition, Long> entry : seekOffsets.entrySet()) {
                consumer.seek(entry.getKey(), entry.getValue());
            }

            long deadlineNs = System.nanoTime() + requestTimeout.toNanos();
            Duration pollTimeout = Duration.ofMillis(Math.min(500L, requestTimeout.toMillis()));
            PeekCollectionState collection;
            if (startPosition == PeekStartPosition.LATEST) {
                collection = collectLatestPeekedMessages(
                    consumer,
                    readablePartitions,
                    beginningOffsets,
                    seekOffsets,
                    snapshotEndOffsets,
                    messagesPerPartition,
                    scanLimit,
                    deadlineNs,
                    pollTimeout
                );
            } else {
                PeekCollectionCompletionChecker snapshotComplete = state -> allPeekPartitionsComplete(
                    readablePartitions,
                    state.remainingByPartition,
                    currentPeekPositions(consumer, readablePartitions),
                    snapshotEndOffsets
                );
                collection = new PeekCollectionState(readablePartitions, messagesPerPartition);
                collection.incomplete = !collectPeekedMessages(
                    timeout -> consumer.poll(timeout),
                    snapshotComplete,
                    record -> recordIsBeforeEndOffset(record, snapshotEndOffsets),
                    collection,
                    scanLimit,
                    deadlineNs,
                    pollTimeout
                );
            }
            List<Map<String, Object>> messages = collection.messages;
            sortPeekedMessages(messages, startPosition);
            if (messages.size() > count) {
                messages = new ArrayList<>(messages.subList(0, count));
            }
            return peekMessagesResult(messages, collection.incomplete);
        }
    }

    static Map<String, Object> peekMessagesResult(List<Map<String, Object>> messages, boolean incomplete) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("messages", messages);
        result.put("incomplete", incomplete);
        return result;
    }

    static int validatedPeekCount(int count) {
        if (count < 1 || count > MAX_PEEK_MESSAGE_COUNT) {
            throw new IllegalArgumentException(
                "Peek message count must be between 1 and " + MAX_PEEK_MESSAGE_COUNT
            );
        }
        return count;
    }

    static int peekRequestTimeoutMs(JsonObject conn, Properties props) {
        Integer connectionTimeout = integerOrNull(conn, "request_timeout_ms");
        if (connectionTimeout != null) {
            return positiveTimeoutMs("request_timeout_ms", connectionTimeout);
        }
        String configuredTimeout = props.getProperty(
            ConsumerConfig.REQUEST_TIMEOUT_MS_CONFIG,
            String.valueOf(DEFAULT_REQUEST_TIMEOUT_MS)
        );
        try {
            return positiveTimeoutMs(ConsumerConfig.REQUEST_TIMEOUT_MS_CONFIG, Integer.parseInt(configuredTimeout));
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(
                ConsumerConfig.REQUEST_TIMEOUT_MS_CONFIG + " must be a positive integer", error
            );
        }
    }

    private static int positiveTimeoutMs(String name, int timeoutMs) {
        if (timeoutMs <= 0) {
            throw new IllegalArgumentException(name + " must be a positive integer");
        }
        return timeoutMs;
    }

    static Properties peekConsumerProperties(JsonObject conn, int count) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers(conn));
        applyConnectionProperties(conn, props);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "dbx-peek-" + UUID.randomUUID());
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
            "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
            "org.apache.kafka.common.serialization.ByteArrayDeserializer");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "none");
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, count);
        return props;
    }

    /**
     * Reads until each partition supplies its share of the page or reaches the snapshot boundary.
     * This counts retained records, rather than treating an offset range as a record count.
     */
    static List<Map<String, Object>> collectPeekedMessages(
        PeekRecordPoller poller,
        PeekCaughtUpChecker caughtUpChecker,
        PeekRecordFilter recordFilter,
        List<TopicPartition> partitions,
        int messagesPerPartition,
        int maxScanRecords,
        long deadlineNs,
        Duration pollTimeout
    ) {
        PeekCollectionState collection = new PeekCollectionState(partitions, messagesPerPartition);
        collectPeekedMessages(
            poller,
            state -> state.allPartitionQuotasSatisfied() || caughtUpChecker.allPartitionsCaughtUp(),
            recordFilter,
            collection,
            maxScanRecords,
            deadlineNs,
            pollTimeout
        );
        return collection.messages;
    }

    private static boolean collectPeekedMessages(
        PeekRecordPoller poller,
        PeekCollectionCompletionChecker completionChecker,
        PeekRecordFilter recordFilter,
        PeekCollectionState collection,
        int maxScanRecords,
        long deadlineNs,
        Duration pollTimeout
    ) {
        while (System.nanoTime() < deadlineNs) {
            if (completionChecker.isComplete(collection)) {
                return true;
            }
            long remainingNs = deadlineNs - System.nanoTime();
            if (remainingNs <= 0) {
                break;
            }
            Duration timeout = pollTimeout.toNanos() > remainingNs
                ? Duration.ofNanos(remainingNs)
                : pollTimeout;
            ConsumerRecords<String, byte[]> records = poller.poll(timeout);
            if (records.isEmpty()) {
                continue;
            }
            for (ConsumerRecord<String, byte[]> record : records) {
                if (++collection.scannedRecords > maxScanRecords) {
                    return false;
                }
                TopicPartition partition = new TopicPartition(record.topic(), record.partition());
                int remaining = collection.remainingByPartition.getOrDefault(partition, 0);
                if (remaining <= 0 || !recordFilter.include(record)) {
                    continue;
                }
                collection.messages.add(peekedMessageFromRecord(record));
                collection.remainingByPartition.put(partition, remaining - 1);
            }
        }
        return completionChecker.isComplete(collection);
    }

    /**
     * Starts at the snapshot tail and widens backward when compacted or retained-offset gaps
     * leave a partition short of its record quota.
     */
    private static PeekCollectionState collectLatestPeekedMessages(
        KafkaConsumer<String, byte[]> consumer,
        List<TopicPartition> partitions,
        Map<TopicPartition, Long> beginningOffsets,
        Map<TopicPartition, Long> initialSeekOffsets,
        Map<TopicPartition, Long> snapshotEndOffsets,
        int messagesPerPartition,
        int maxScanRecords,
        long deadlineNs,
        Duration pollTimeout
    ) {
        Map<TopicPartition, Long> rangeStartOffsets = new LinkedHashMap<>(initialSeekOffsets);
        Map<TopicPartition, Long> rangeEndOffsets = new LinkedHashMap<>(snapshotEndOffsets);
        Map<TopicPartition, Long> rangeWidths = new LinkedHashMap<>();
        for (TopicPartition partition : partitions) {
            long rangeStart = rangeStartOffsets.getOrDefault(partition, 0L);
            long rangeEnd = rangeEndOffsets.getOrDefault(partition, rangeStart);
            rangeWidths.put(partition, Math.max(1L, rangeEnd - rangeStart));
        }

        PeekCollectionState collection = new PeekCollectionState(partitions, messagesPerPartition);
        while (!collection.allPartitionQuotasSatisfied()) {
            PeekCollectionCompletionChecker rangeComplete = state -> allPeekPartitionsComplete(
                partitions,
                state.remainingByPartition,
                currentPeekPositions(consumer, partitions),
                rangeEndOffsets
            );
            if (!collectLatestPeekRange(
                timeout -> consumer.poll(timeout),
                rangeComplete,
                record -> recordIsBeforeEndOffset(record, rangeEndOffsets),
                collection,
                maxScanRecords,
                deadlineNs,
                pollTimeout
            )) {
                collection.incomplete = true;
                break;
            }
            if (collection.allPartitionQuotasSatisfied()) {
                break;
            }

            boolean expanded = false;
            for (TopicPartition partition : partitions) {
                if (collection.remainingByPartition.getOrDefault(partition, 0) <= 0) {
                    continue;
                }
                long beginningOffset = beginningOffsets.getOrDefault(partition, 0L);
                long currentStart = rangeStartOffsets.getOrDefault(partition, beginningOffset);
                if (currentStart <= beginningOffset) {
                    continue;
                }
                long nextStart = previousLatestPeekStartOffset(
                    beginningOffset,
                    currentStart,
                    rangeWidths.getOrDefault(partition, 1L)
                );
                rangeEndOffsets.put(partition, currentStart);
                rangeStartOffsets.put(partition, nextStart);
                rangeWidths.put(partition, Math.max(1L, currentStart - nextStart));
                consumer.seek(partition, nextStart);
                expanded = true;
            }
            if (!expanded) {
                break;
            }
        }
        return collection;
    }

    /**
     * Scans one backward-expanded range to its end, retaining only each partition's newest
     * remaining records. Stopping early would select older records from a widened range.
     */
    private static boolean collectLatestPeekRange(
        PeekRecordPoller poller,
        PeekCollectionCompletionChecker rangeComplete,
        PeekRecordFilter recordFilter,
        PeekCollectionState collection,
        int maxScanRecords,
        long deadlineNs,
        Duration pollTimeout
    ) {
        Map<TopicPartition, Deque<Map<String, Object>>> rangeMessages = new HashMap<>();
        while (System.nanoTime() < deadlineNs) {
            if (rangeComplete.isComplete(collection)) {
                break;
            }
            long remainingNs = deadlineNs - System.nanoTime();
            if (remainingNs <= 0) {
                break;
            }
            Duration timeout = pollTimeout.toNanos() > remainingNs
                ? Duration.ofNanos(remainingNs)
                : pollTimeout;
            ConsumerRecords<String, byte[]> records = poller.poll(timeout);
            for (ConsumerRecord<String, byte[]> record : records) {
                if (++collection.scannedRecords > maxScanRecords) {
                    commitLatestPeekRange(rangeMessages, collection);
                    return false;
                }
                TopicPartition partition = new TopicPartition(record.topic(), record.partition());
                int remaining = collection.remainingByPartition.getOrDefault(partition, 0);
                if (remaining <= 0 || !recordFilter.include(record)) {
                    continue;
                }
                Deque<Map<String, Object>> latestRecords = rangeMessages.computeIfAbsent(
                    partition,
                    ignored -> new ArrayDeque<>()
                );
                retainLatestPeekRecord(latestRecords, peekedMessageFromRecord(record), remaining);
            }
        }
        boolean complete = rangeComplete.isComplete(collection);
        commitLatestPeekRange(rangeMessages, collection);
        return complete;
    }

    private static void commitLatestPeekRange(
        Map<TopicPartition, Deque<Map<String, Object>>> rangeMessages,
        PeekCollectionState collection
    ) {
        for (Map.Entry<TopicPartition, Deque<Map<String, Object>>> entry : rangeMessages.entrySet()) {
            int retainedCount = entry.getValue().size();
            collection.messages.addAll(entry.getValue());
            collection.remainingByPartition.computeIfPresent(
                entry.getKey(),
                (ignored, remaining) -> remaining - retainedCount
            );
        }
    }

    static <T> void retainLatestPeekRecord(Deque<T> records, T record, int maxRecords) {
        records.addLast(record);
        if (records.size() > maxRecords) {
            records.removeFirst();
        }
    }

    private static boolean recordIsBeforeEndOffset(
        ConsumerRecord<String, byte[]> record,
        Map<TopicPartition, Long> endOffsets
    ) {
        Long endOffset = endOffsets.get(new TopicPartition(record.topic(), record.partition()));
        return endOffset != null && record.offset() < endOffset;
    }

    private static Map<TopicPartition, Long> currentPeekPositions(
        KafkaConsumer<String, byte[]> consumer,
        List<TopicPartition> partitions
    ) {
        Map<TopicPartition, Long> positions = new LinkedHashMap<>();
        for (TopicPartition partition : partitions) {
            positions.put(partition, consumer.position(partition));
        }
        return positions;
    }

    static boolean allPeekPartitionsComplete(
        List<TopicPartition> partitions,
        Map<TopicPartition, Integer> remainingByPartition,
        Map<TopicPartition, Long> positions,
        Map<TopicPartition, Long> endOffsets
    ) {
        for (TopicPartition partition : partitions) {
            if (remainingByPartition.getOrDefault(partition, 0) <= 0) {
                continue;
            }
            long endOffset = endOffsets.getOrDefault(partition, 0L);
            long position = positions.getOrDefault(partition, 0L);
            if (position < endOffset) {
                return false;
            }
        }
        return true;
    }

    static boolean allPeekPartitionsCaughtUp(
        List<TopicPartition> partitions,
        Map<TopicPartition, Long> positions,
        Map<TopicPartition, Long> endOffsets
    ) {
        for (TopicPartition tp : partitions) {
            long endOffset = endOffsets.getOrDefault(tp, 0L);
            long position = positions.getOrDefault(tp, 0L);
            if (position < endOffset) {
                return false;
            }
        }
        return true;
    }

    @FunctionalInterface
    interface PeekRecordPoller {
        ConsumerRecords<String, byte[]> poll(Duration timeout);
    }

    @FunctionalInterface
    interface PeekCaughtUpChecker {
        boolean allPartitionsCaughtUp();
    }

    @FunctionalInterface
    private interface PeekCollectionCompletionChecker {
        boolean isComplete(PeekCollectionState collection);
    }

    @FunctionalInterface
    interface PeekRecordFilter {
        boolean include(ConsumerRecord<String, byte[]> record);
    }

    private static final class PeekCollectionState {
        private final List<Map<String, Object>> messages = new ArrayList<>();
        private final Map<TopicPartition, Integer> remainingByPartition = new HashMap<>();
        private int scannedRecords;
        private boolean incomplete;

        private PeekCollectionState(List<TopicPartition> partitions, int messagesPerPartition) {
            for (TopicPartition partition : partitions) {
                remainingByPartition.put(partition, messagesPerPartition);
            }
        }

        private boolean allPartitionQuotasSatisfied() {
            return remainingByPartition.values().stream().allMatch(remaining -> remaining <= 0);
        }
    }

    /** When partition is null, peek across every partition of the topic. */
    static List<TopicPartition> resolvePeekPartitions(
        KafkaConsumer<String, byte[]> consumer,
        String topic,
        Integer partition,
        Duration timeout
    ) {
        if (partition != null) {
            return resolvePeekPartitions(topic, partition, Collections.emptyList());
        }
        List<PartitionInfo> infos = consumer.partitionsFor(topic, timeout);
        if (infos == null || infos.isEmpty()) {
            return Collections.emptyList();
        }
        List<Integer> available = infos.stream().map(PartitionInfo::partition).collect(Collectors.toList());
        return resolvePeekPartitions(topic, null, available);
    }

    static List<TopicPartition> resolvePeekPartitions(String topic, Integer partition, List<Integer> availablePartitions) {
        if (partition != null) {
            return Collections.singletonList(new TopicPartition(topic, partition));
        }
        if (availablePartitions == null || availablePartitions.isEmpty()) {
            return Collections.emptyList();
        }
        return availablePartitions.stream()
            .sorted()
            .map(id -> new TopicPartition(topic, id))
            .collect(Collectors.toList());
    }

    enum PeekStartPosition {
        EARLIEST,
        LATEST,
        OFFSET,
    }

    /** Omitting startPosition preserves the old earliest default (or explicit legacy offset) behavior. */
    static PeekStartPosition peekStartPosition(JsonObject params) {
        String value = stringOrNull(params, "startPosition");
        if (value == null) {
            return PeekStartPosition.EARLIEST;
        }
        return switch (value.trim().toLowerCase(Locale.ROOT)) {
            case "earliest" -> PeekStartPosition.EARLIEST;
            case "latest" -> PeekStartPosition.LATEST;
            case "offset" -> PeekStartPosition.OFFSET;
            default -> throw new IllegalArgumentException("Unsupported peek startPosition: " + value);
        };
    }

    static void validatePeekRequest(
        PeekStartPosition startPosition,
        boolean explicitStartPosition,
        Integer partition,
        Long offset
    ) {
        if (partition != null && partition < 0) {
            throw new IllegalArgumentException("partition must be non-negative");
        }
        if (!explicitStartPosition) {
            // Older clients used offset directly without a startPosition field.
            if (offset != null && offset < 0) {
                throw new IllegalArgumentException("offset must be non-negative");
            }
            return;
        }
        if (startPosition != PeekStartPosition.OFFSET) {
            if (offset != null) {
                throw new IllegalArgumentException("offset is only supported when startPosition is offset");
            }
            return;
        }
        if (offset == null) {
            throw new IllegalArgumentException("offset is required when startPosition is offset");
        }
        if (offset < 0) {
            throw new IllegalArgumentException("offset must be non-negative when startPosition is offset");
        }
    }

    static Long requestedPeekOffset(
        PeekStartPosition startPosition,
        Long offset,
        boolean legacyOffsetRequest,
        long beginningOffset,
        long endOffset
    ) {
        return switch (startPosition) {
            case LATEST -> endOffset > beginningOffset ? beginningOffset : null;
            case OFFSET -> offset;
            case EARLIEST -> legacyOffsetRequest ? offset : beginningOffset;
        };
    }

    static int peekScanLimit(int count, int readablePartitionCount) {
        int fetchCount = recentPeekFetchCount(
            peekMessagesPerPartition(count, readablePartitionCount), readablePartitionCount
        );
        if (fetchCount > MAX_PEEK_SCAN_RECORDS) {
            throw new IllegalArgumentException(
                "Kafka message browse would scan more than " + MAX_PEEK_SCAN_RECORDS + " records"
            );
        }
        return MAX_PEEK_SCAN_RECORDS;
    }

    static void sortPeekedMessages(List<Map<String, Object>> messages) {
        sortPeekedMessages(messages, PeekStartPosition.EARLIEST);
    }

    static void sortPeekedMessages(List<Map<String, Object>> messages, PeekStartPosition startPosition) {
        if (startPosition == PeekStartPosition.OFFSET) {
            messages.sort(Comparator
                .comparingLong((Map<String, Object> message) ->
                    ((Number) message.getOrDefault("offset", 0L)).longValue()
                )
                .thenComparingInt(message -> ((Number) message.getOrDefault("partition", 0)).intValue())
            );
            return;
        }

        Comparator<Map<String, Object>> comparator = (left, right) -> {
            long leftTs = ((Number) left.getOrDefault("timestamp", 0L)).longValue();
            long rightTs = ((Number) right.getOrDefault("timestamp", 0L)).longValue();
            int byTs = Long.compare(leftTs, rightTs);
            if (byTs != 0) {
                return startPosition == PeekStartPosition.LATEST ? -byTs : byTs;
            }
            int leftPartition = ((Number) left.getOrDefault("partition", 0)).intValue();
            int rightPartition = ((Number) right.getOrDefault("partition", 0)).intValue();
            int byPartition = Integer.compare(leftPartition, rightPartition);
            if (byPartition != 0) {
                return byPartition;
            }
            long leftOffset = ((Number) left.getOrDefault("offset", 0L)).longValue();
            long rightOffset = ((Number) right.getOrDefault("offset", 0L)).longValue();
            return Long.compare(leftOffset, rightOffset);
        };
        messages.sort(comparator);
    }

    private static Map<String, Object> peekedMessageFromRecord(ConsumerRecord<String, byte[]> record) {
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("topic", record.topic());
        msg.put("partition", record.partition());
        msg.put("offset", record.offset());
        msg.put("timestamp", record.timestamp());
        msg.put("key", record.key());
        Map<String, String> headers = new LinkedHashMap<>();
        record.headers().forEach(h ->
            headers.put(h.key(), h.value() == null ? "" : new String(h.value(), StandardCharsets.UTF_8)));
        msg.put("headers", headers);
        if (record.value() != null) {
            msg.put("payloadBase64", Base64.getEncoder().encodeToString(record.value()));
            String text = tryDecodeUtf8(record.value());
            if (text != null) {
                msg.put("payloadText", text);
            }
        } else {
            msg.put("payloadBase64", "");
        }
        return msg;
    }

    private static Object sendMessage(JsonObject params) throws Exception {
        if (producer == null) {
            throw new IllegalStateException("Producer is not initialized. Call connect first.");
        }

        String topic = stringOrEmpty(params, "topic");
        String key = params.has("key") && !params.get("key").isJsonNull()
            ? params.get("key").getAsString() : null;

        // Decode payload from base64
        String payloadBase64 = stringOrEmpty(params, "payloadBase64");
        byte[] value = payloadBase64.isEmpty() ? new byte[0] : Base64.getDecoder().decode(payloadBase64);

        // Build the record
        Integer partition = params.has("partition") && !params.get("partition").isJsonNull()
            ? params.get("partition").getAsInt() : null;

        ProducerRecord<String, byte[]> record;
        if (partition != null) {
            record = new ProducerRecord<>(topic, partition, key, value);
        } else {
            record = new ProducerRecord<>(topic, key, value);
        }

        // Add headers
        JsonObject headers = params.has("headers") && params.get("headers").isJsonObject()
            ? params.getAsJsonObject("headers") : null;
        if (headers != null) {
            for (Map.Entry<String, JsonElement> entry : headers.entrySet()) {
                record.headers().add(new RecordHeader(
                    entry.getKey(),
                    entry.getValue().getAsString().getBytes(StandardCharsets.UTF_8)));
            }
        }

        RecordMetadata metadata = producer.send(record).get(30, TimeUnit.SECONDS);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", true);
        result.put("topic", metadata.topic());
        result.put("partition", metadata.partition());
        result.put("offset", metadata.offset());
        result.put("timestamp", metadata.timestamp());
        return result;
    }

    // -----------------------------------------------------------------------
    // ACLs
    // -----------------------------------------------------------------------

    private static Object listAcls(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);

        AclBindingFilter filter = buildAclFilter(params);
        Collection<AclBinding> bindings = admin.describeAcls(filter)
            .values().get(timeout, TimeUnit.MILLISECONDS);

        List<Map<String, Object>> acls = new ArrayList<>();
        for (AclBinding binding : bindings) {
            Map<String, Object> acl = new LinkedHashMap<>();
            acl.put("resourceType", binding.pattern().resourceType().name());
            acl.put("resourceName", binding.pattern().name());
            acl.put("patternType", binding.pattern().patternType().name());
            acl.put("principal", binding.entry().principal());
            acl.put("host", binding.entry().host());
            acl.put("operation", binding.entry().operation().name());
            acl.put("permissionType", binding.entry().permissionType().name());
            acls.add(acl);
        }
        return Collections.singletonMap("acls", acls);
    }

    private static Object createAcls(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        JsonArray aclsArray = params.has("acls") && params.get("acls").isJsonArray()
            ? params.getAsJsonArray("acls") : new JsonArray();

        List<AclBinding> bindings = new ArrayList<>();
        for (JsonElement el : aclsArray) {
            JsonObject acl = el.getAsJsonObject();
            ResourceType resourceType = ResourceType.valueOf(stringOrDefault(acl, "resourceType", "TOPIC"));
            String resourceName = stringOrEmpty(acl, "resourceName");
            PatternType patternType = PatternType.valueOf(stringOrDefault(acl, "patternType", "LITERAL"));
            String principal = stringOrEmpty(acl, "principal");
            String host = stringOrDefault(acl, "host", "*");
            AclOperation operation = AclOperation.valueOf(stringOrDefault(acl, "operation", "ALL"));
            AclPermissionType permissionType = AclPermissionType.valueOf(
                stringOrDefault(acl, "permissionType", "ALLOW"));

            ResourcePattern pattern = new ResourcePattern(resourceType, resourceName, patternType);
            AccessControlEntry entry = new AccessControlEntry(principal, host, operation, permissionType);
            bindings.add(new AclBinding(pattern, entry));
        }

        admin.createAcls(bindings).all().get(timeout, TimeUnit.MILLISECONDS);
        return Collections.singletonMap("ok", true);
    }

    private static Object deleteAcls(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        JsonArray filtersArray = params.has("filters") && params.get("filters").isJsonArray()
            ? params.getAsJsonArray("filters") : new JsonArray();

        List<AclBindingFilter> filters = new ArrayList<>();
        for (JsonElement el : filtersArray) {
            filters.add(buildAclFilter(el.getAsJsonObject()));
        }
        if (filters.isEmpty()) {
            filters.add(AclBindingFilter.ANY);
        }

        Collection<AclBinding> deletedBindings = admin.deleteAcls(filters).all().get(timeout, TimeUnit.MILLISECONDS);
        int deleted = deletedAclCount(deletedBindings);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", true);
        result.put("deleted", deleted);
        return result;
    }

    static int deletedAclCount(Collection<AclBinding> deletedBindings) {
        return deletedBindings == null ? 0 : deletedBindings.size();
    }

    private static AclBindingFilter buildAclFilter(JsonObject params) {
        ResourceType resourceType = params.has("resourceType")
            ? ResourceType.valueOf(params.get("resourceType").getAsString()) : ResourceType.ANY;
        String resourceName = params.has("resourceName") && !params.get("resourceName").isJsonNull()
            ? params.get("resourceName").getAsString() : null;
        PatternType patternType = params.has("patternType")
            ? PatternType.valueOf(params.get("patternType").getAsString()) : PatternType.ANY;

        ResourcePatternFilter patternFilter = new ResourcePatternFilter(
            resourceType, resourceName, patternType);

        String principal = params.has("principal") && !params.get("principal").isJsonNull()
            ? params.get("principal").getAsString() : null;
        String host = params.has("host") && !params.get("host").isJsonNull()
            ? params.get("host").getAsString() : null;
        AclOperation operation = params.has("operation")
            ? AclOperation.valueOf(params.get("operation").getAsString()) : AclOperation.ANY;
        AclPermissionType permissionType = params.has("permissionType")
            ? AclPermissionType.valueOf(params.get("permissionType").getAsString()) : AclPermissionType.ANY;

        AccessControlEntryFilter entryFilter = new AccessControlEntryFilter(
            principal, host, operation, permissionType);
        return new AclBindingFilter(patternFilter, entryFilter);
    }

    // -----------------------------------------------------------------------
    // Cluster / monitoring
    // -----------------------------------------------------------------------

    private static Object describeCluster(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);

        DescribeClusterResult cluster = admin.describeCluster();
        DescribeMetadataQuorumResult metadataQuorum = admin.describeMetadataQuorum();
        String clusterId = cluster.clusterId().get(timeout, TimeUnit.MILLISECONDS);
        Collection<Node> nodes = cluster.nodes().get(timeout, TimeUnit.MILLISECONDS);
        Map<String, Object> controller = resolveClusterController(metadataQuorum, cluster, nodes, timeout);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("clusterId", clusterId);
        result.put("controller", controller);
        List<Map<String, Object>> brokerList = new ArrayList<>();
        for (Node node : nodes) {
            brokerList.add(nodeToMap(node));
        }
        result.put("brokers", brokerList);
        result.put("nodeCount", nodes.size());
        return result;
    }

    private static Map<String, Object> resolveClusterController(
        DescribeMetadataQuorumResult metadataQuorum,
        DescribeClusterResult cluster,
        Collection<Node> brokers,
        int timeout
    ) throws Exception {
        try {
            QuorumInfo quorum = metadataQuorum.quorumInfo().get(timeout, TimeUnit.MILLISECONDS);
            Map<Integer, List<RaftVoterEndpoint>> endpointsByNode = new HashMap<>();
            for (Map.Entry<Integer, QuorumInfo.Node> entry : quorum.nodes().entrySet()) {
                endpointsByNode.put(entry.getKey(), entry.getValue().endpoints());
            }
            return metadataQuorumControllerToMap(quorum.leaderId(), brokers, endpointsByNode);
        } catch (Exception e) {
            if (isUnsupportedVersionError(e)) {
                Node controller = cluster.controller().get(timeout, TimeUnit.MILLISECONDS);
                return controller != null ? nodeToMap(controller) : null;
            }
            logger().warn("Unable to resolve Kafka metadata quorum leader; omitting the controller", e);
            return null;
        }
    }

    static Map<String, Object> metadataQuorumControllerToMap(
        int leaderId,
        Collection<Node> brokers,
        Map<Integer, List<RaftVoterEndpoint>> endpointsByNode
    ) {
        if (leaderId < 0) {
            return null;
        }
        for (Node broker : brokers) {
            if (broker.id() == leaderId) {
                return nodeToMap(broker);
            }
        }
        List<RaftVoterEndpoint> endpoints = endpointsByNode.getOrDefault(leaderId, Collections.emptyList());
        if (!endpoints.isEmpty()) {
            RaftVoterEndpoint endpoint = endpoints.get(0);
            return nodeToMap(new Node(leaderId, endpoint.host(), endpoint.port()));
        }
        Map<String, Object> controller = new LinkedHashMap<>();
        controller.put("id", leaderId);
        return controller;
    }

    private static Object getConsumerLag(JsonObject params) throws Exception {
        AdminClient admin = requireAdmin();
        int timeout = requestTimeout(params);
        String groupId = stringOrEmpty(params, "groupId");
        String topic = stringOrEmpty(params, "topic");

        // Get committed offsets for the consumer group
        Map<TopicPartition, OffsetAndMetadata> committed = admin.listConsumerGroupOffsets(groupId)
            .partitionsToOffsetAndMetadata().get(timeout, TimeUnit.MILLISECONDS);

        // Filter to the requested topic
        Map<TopicPartition, OffsetAndMetadata> topicCommitted = committed.entrySet().stream()
            .filter(e -> e.getKey().topic().equals(topic))
            .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));

        if (topicCommitted.isEmpty()) {
            return Collections.singletonMap("partitions", Collections.emptyList());
        }

        // Get end offsets
        Map<TopicPartition, OffsetSpec> specMap = new HashMap<>();
        for (TopicPartition tp : topicCommitted.keySet()) {
            specMap.put(tp, OffsetSpec.latest());
        }
        Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> endOffsets =
            admin.listOffsets(specMap).all().get(timeout, TimeUnit.MILLISECONDS);

        List<Map<String, Object>> partitions = new ArrayList<>();
        long totalLag = 0;
        for (Map.Entry<TopicPartition, OffsetAndMetadata> entry : topicCommitted.entrySet()) {
            TopicPartition tp = entry.getKey();
            long currentOffset = entry.getValue().offset();
            ListOffsetsResult.ListOffsetsResultInfo endInfo = endOffsets.get(tp);
            long endOffset = endInfo != null ? endInfo.offset() : -1;
            long lag = endOffset >= 0 ? Math.max(0, endOffset - currentOffset) : -1;
            totalLag += Math.max(0, lag);

            Map<String, Object> p = new LinkedHashMap<>();
            p.put("partition", tp.partition());
            p.put("currentOffset", currentOffset);
            p.put("endOffset", endOffset);
            p.put("lag", lag);
            partitions.add(p);
        }
        partitions.sort(Comparator.comparingInt(a -> (int) a.get("partition")));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("partitions", partitions);
        result.put("totalLag", totalLag);
        return result;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static String normalizeErrorMessage(Exception e) {
        String message = e.getMessage() == null || e.getMessage().isBlank()
            ? e.getClass().getName()
            : e.getMessage();
        Throwable root = rootCause(e);
        if (root != e && root.getMessage() != null && !root.getMessage().isBlank()
            && !message.contains(root.getMessage())) {
            message = message + ": " + root.getMessage();
        }
        if (isSslHandshakeError(e)) {
            message = message
                + ". Hint: SSL handshake failed. Check the Kafka security protocol. "
                + "Use PLAINTEXT for a PLAINTEXT broker listener, SSL for SSL, "
                + "SASL_PLAINTEXT for SASL without TLS, or SASL_SSL for SASL with TLS. "
                + "For older Kafka/JDK TLS setups, also check truststore settings, certificates, "
                + "hostname verification, and enabled TLS protocol versions.";
        }
        return message;
    }

    private static boolean isSslHandshakeError(Throwable error) {
        for (Throwable current : causeChain(error)) {
            String className = current.getClass().getName();
            String message = current.getMessage() == null ? "" : current.getMessage().toLowerCase(Locale.ROOT);
            if (className.contains("SslAuthenticationException")
                || className.contains("SSLHandshakeException")
                || message.contains("ssl handshake failed")) {
                return true;
            }
        }
        return false;
    }

    private static boolean isUnsupportedVersionError(Throwable error) {
        for (Throwable current : causeChain(error)) {
            String className = current.getClass().getName();
            String message = current.getMessage() == null ? "" : current.getMessage().toLowerCase(Locale.ROOT);
            if (className.contains("UnsupportedVersionException")
                || message.contains("unsupported version")) {
                return true;
            }
        }
        return false;
    }

    private static Throwable rootCause(Throwable error) {
        Throwable current = null;
        for (Throwable cause : causeChain(error)) {
            current = cause;
        }
        return current == null ? error : current;
    }

    private static List<Throwable> causeChain(Throwable error) {
        List<Throwable> chain = new ArrayList<>();
        Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        Throwable current = error;
        for (int depth = 0; current != null && depth < 32 && seen.add(current); depth++) {
            chain.add(current);
            Throwable next = current.getCause();
            if (next == current) {
                break;
            }
            current = next;
        }
        return chain;
    }

    private static AdminClient requireAdmin() {
        if (adminClient == null) {
            throw new IllegalStateException("Not connected. Call connect first.");
        }
        return adminClient;
    }

    private static JsonObject connectionObject(JsonObject params) {
        JsonElement connection = params.get("connection");
        return connection != null && connection.isJsonObject()
            ? connection.getAsJsonObject() : params;
    }

    private static int requestTimeout(JsonObject params) {
        return intOrDefault(params, "timeout_ms", DEFAULT_REQUEST_TIMEOUT_MS);
    }

    private static Map<String, Object> nodeToMap(Node node) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", node.id());
        m.put("host", node.host());
        m.put("port", node.port());
        m.put("rack", node.rack());
        return m;
    }

    private static String tryDecodeUtf8(byte[] bytes) {
        String text = new String(bytes, StandardCharsets.UTF_8);
        // Replacement characters change the bytes on round-trip, identifying invalid UTF-8 without exceptions.
        byte[] reEncoded = text.getBytes(StandardCharsets.UTF_8);
        return Arrays.equals(bytes, reEncoded) ? text : null;
    }

    static Long normalizePeekOffset(long requestedOffset, long beginningOffset, long endOffset) {
        if (endOffset <= beginningOffset) {
            return null;
        }
        if (requestedOffset < beginningOffset) {
            return beginningOffset;
        }
        if (requestedOffset >= endOffset) {
            return null;
        }
        return requestedOffset;
    }

    /** Splits the requested page quota across partitions. */
    static int peekMessagesPerPartition(int count, int partitionCount) {
        int safePartitionCount = Math.max(1, partitionCount);
        return (int) (((long) count + safePartitionCount - 1) / safePartitionCount);
    }

    static long recentPeekStartOffset(long beginningOffset, long endOffset, int messagesPerPartition) {
        return Math.max(beginningOffset, endOffset - messagesPerPartition);
    }

    static long previousLatestPeekStartOffset(
        long beginningOffset,
        long currentStartOffset,
        long currentWindowWidth
    ) {
        long safeWindowWidth = Math.max(1L, currentWindowWidth);
        long expandedWindowWidth = safeWindowWidth > Long.MAX_VALUE / 2
            ? Long.MAX_VALUE
            : safeWindowWidth * 2;
        long distanceToBeginning = currentStartOffset - beginningOffset;
        return currentStartOffset - Math.min(distanceToBeginning, expandedWindowWidth);
    }

    static int recentPeekFetchCount(int messagesPerPartition, int partitionCount) {
        long total = (long) messagesPerPartition * Math.max(1, partitionCount);
        return (int) Math.min(Integer.MAX_VALUE, total);
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
}
