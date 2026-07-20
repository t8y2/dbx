package com.dbx.agent.rocketmq;

import com.google.gson.*;
import org.apache.rocketmq.acl.common.AclClientRPCHook;
import org.apache.rocketmq.acl.common.SessionCredentials;
import org.apache.rocketmq.client.QueryResult;
import org.apache.rocketmq.client.exception.MQClientException;
import org.apache.rocketmq.client.consumer.DefaultLitePullConsumer;
import org.apache.rocketmq.client.consumer.DefaultMQPullConsumer;
import org.apache.rocketmq.client.consumer.PullResult;
import org.apache.rocketmq.client.consumer.PullStatus;
import org.apache.rocketmq.client.producer.DefaultMQProducer;
import org.apache.rocketmq.client.producer.SendResult;
import org.apache.rocketmq.common.MixAll;
import org.apache.rocketmq.common.PlainAccessConfig;
import org.apache.rocketmq.common.TopicConfig;
import org.apache.rocketmq.common.message.Message;
import org.apache.rocketmq.common.message.MessageConst;
import org.apache.rocketmq.common.message.MessageExt;
import org.apache.rocketmq.common.message.MessageQueue;
import org.apache.rocketmq.remoting.RPCHook;
import org.apache.rocketmq.remoting.protocol.admin.ConsumeStats;
import org.apache.rocketmq.remoting.protocol.admin.TopicStatsTable;
import org.apache.rocketmq.remoting.protocol.body.AclInfo;
import org.apache.rocketmq.remoting.protocol.body.ClusterInfo;
import org.apache.rocketmq.remoting.protocol.body.Connection;
import org.apache.rocketmq.remoting.protocol.body.ConsumerConnection;
import org.apache.rocketmq.remoting.protocol.body.GroupList;
import org.apache.rocketmq.remoting.protocol.body.ProducerConnection;
import org.apache.rocketmq.remoting.protocol.body.ProducerInfo;
import org.apache.rocketmq.remoting.protocol.body.ProducerTableInfo;
import org.apache.rocketmq.remoting.protocol.body.SubscriptionGroupWrapper;
import org.apache.rocketmq.remoting.protocol.body.TopicConfigSerializeWrapper;
import org.apache.rocketmq.remoting.protocol.body.TopicList;
import org.apache.rocketmq.remoting.protocol.heartbeat.SubscriptionData;
import org.apache.rocketmq.remoting.protocol.route.BrokerData;
import org.apache.rocketmq.remoting.protocol.route.QueueData;
import org.apache.rocketmq.remoting.protocol.route.TopicRouteData;
import org.apache.rocketmq.remoting.protocol.subscription.SubscriptionGroupConfig;
import org.apache.rocketmq.tools.admin.DefaultMQAdminExt;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * RocketMQ admin agent for DBX. Communicates with the Rust bridge via JSON-RPC
 * over stdin/stdout. Uses DefaultMQAdminExt for admin operations and
 * DefaultMQProducer for message production.
 */
public final class RocketMqAgent {

    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final int DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
    private static final int DEFAULT_LIST_LIMIT = 200;
    private static final String AUTO_CREATE_TOPIC_KEY = "TBW102";
    /** RocketMQ 5.x topic attribute key for message type (NORMAL/DELAY/FIFO/TRANSACTION). */
    private static final String TOPIC_MESSAGE_TYPE_ATTRIBUTE = "message.type";
    private static final Set<String> RESERVED_TOPIC_NAMES = Set.of(
        AUTO_CREATE_TOPIC_KEY,
        "BenchmarkTest",
        "SELF_TEST_TOPIC",
        "OFFSET_MOVED_EVENT",
        "DefaultHeartBeatSyncerTopic"
    );
    /** Same set as rocketmq-dashboard ConsumerServiceImpl.SYSTEM_GROUP_SET. */
    private static final Set<String> SYSTEM_CONSUMER_GROUPS = Set.of(
        MixAll.TOOLS_CONSUMER_GROUP,
        MixAll.FILTERSRV_CONSUMER_GROUP,
        MixAll.SELF_TEST_CONSUMER_GROUP,
        MixAll.ONS_HTTP_PROXY_GROUP,
        MixAll.CID_ONSAPI_PULL_GROUP,
        MixAll.CID_ONSAPI_PERMISSION_GROUP,
        MixAll.CID_ONSAPI_OWNER_GROUP,
        MixAll.CID_SYS_RMQ_TRANS,
        "CID_DefaultHeartBeatSyncerTopic"
    );

    static boolean isSystemConsumerGroup(String groupId) {
        return groupId != null && SYSTEM_CONSUMER_GROUPS.contains(groupId);
    }

    /**
     * Align with rocketmq-dashboard ConsumerServiceImpl group type: SYSTEM / FIFO / NORMAL.
     */
    static String classifyConsumerGroupType(String groupId, SubscriptionGroupConfig config) {
        if (isSystemConsumerGroup(groupId)) {
            return "SYSTEM";
        }
        if (config != null && config.isConsumeMessageOrderly()) {
            return "FIFO";
        }
        return "NORMAL";
    }

    static boolean isUserTopic(String topic) {
        if (topic == null || topic.isBlank()) {
            return false;
        }
        if (topic.startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX)
            || topic.startsWith(MixAll.DLQ_GROUP_TOPIC_PREFIX)
            || topic.startsWith("%")) {
            return false;
        }
        // RocketMQ system topics use RMQ_SYS / rmq_sys prefixes (see apache/rocketmq#1203).
        if (topic.startsWith("RMQ_SYS") || topic.startsWith("rmq_sys")) {
            return false;
        }
        if (topic.startsWith("SCHEDULE_TOPIC_") || topic.startsWith("rocketmq-broker-")) {
            return false;
        }
        if (topic.endsWith("_REPLY_TOPIC")) {
            return false;
        }
        if (RESERVED_TOPIC_NAMES.contains(topic)) {
            return false;
        }
        return true;
    }

    /**
     * RocketMQ Dashboard Publishing Management queries producers via
     * {@code mqadmin producerConnection -g <group> -t <topic>}. Without a producer group the
     * broker cannot filter producers by topic (apache/rocketmq#6371); list broker tables on
     * topic-route brokers instead.
     */
    static boolean shouldQueryClusterProducerTable(String topic, String producerGroup) {
        return (topic == null || topic.isBlank()) && (producerGroup == null || producerGroup.isBlank());
    }

    static boolean isRocketMqSystemTopic(
        String topic,
        Set<String> brokerSystemTopics,
        Set<String> brokerNames,
        String cluster
    ) {
        return !isUserTopic(topic)
            || brokerSystemTopics.contains(topic)
            || brokerNames.contains(topic)
            || (!cluster.isBlank() && cluster.equals(topic));
    }

    /**
     * Classify RocketMQ topic message type using the same rules as rocketmq-dashboard
     * {@code TopicServiceImpl#classifyTopicType}, plus broker/cluster reserved names.
     */
    static String classifyTopicMessageType(
        String topicName,
        Map<String, String> attributes,
        Set<String> brokerSystemTopics,
        Set<String> brokerNames,
        String cluster
    ) {
        if (topicName == null || topicName.isBlank()) {
            return "UNSPECIFIED";
        }
        if (topicName.startsWith(MixAll.RETRY_GROUP_TOPIC_PREFIX) || topicName.startsWith("%R")) {
            return "RETRY";
        }
        if (topicName.startsWith(MixAll.DLQ_GROUP_TOPIC_PREFIX) || topicName.startsWith("%D")) {
            return "DLQ";
        }
        if (brokerSystemTopics.contains(topicName)
            || topicName.startsWith("RMQ_SYS")
            || topicName.startsWith("rmq_sys")
            || topicName.equals("DefaultHeartBeatSyncerTopic")
            || brokerNames.contains(topicName)
            || (!cluster.isBlank() && cluster.equals(topicName))
            || !isUserTopic(topicName)) {
            return "SYSTEM";
        }
        String messageType = readTopicMessageTypeAttribute(attributes);
        if (messageType == null || messageType.isBlank()) {
            return "UNSPECIFIED";
        }
        return normalizeMessageType(messageType);
    }

    private static String readTopicMessageTypeAttribute(Map<String, String> attributes) {
        if (attributes == null || attributes.isEmpty()) {
            return null;
        }
        String attrName = TOPIC_MESSAGE_TYPE_ATTRIBUTE;
        String messageType = attributes.get(attrName);
        if (messageType == null || messageType.isBlank()) {
            messageType = attributes.get("+" + attrName);
        }
        if (messageType == null || messageType.isBlank()) {
            for (Map.Entry<String, String> entry : attributes.entrySet()) {
                String key = entry.getKey();
                if (key != null && key.endsWith(attrName) && entry.getValue() != null && !entry.getValue().isBlank()) {
                    messageType = entry.getValue();
                    break;
                }
            }
        }
        return messageType;
    }

    private static String readTopicMessageType(TopicConfig config) {
        if (config == null) {
            return null;
        }
        // Prefer raw broker attributes: getTopicMessageType() may return UNSPECIFIED
        // even when attributes already contain message.type=NORMAL (RocketMQ 5.x stores without '+').
        String fromAttributes = readTopicMessageTypeAttribute(config.getAttributes());
        if (fromAttributes != null && !fromAttributes.isBlank()) {
            return fromAttributes;
        }
        return null;
    }

    /** Test hook: run listTopics against an existing admin client. */
    static Object listTopicsWithAdminForTest(DefaultMQAdminExt admin, JsonObject params) throws Exception {
        DefaultMQAdminExt previous = adminClient;
        adminClient = admin;
        try {
            return listTopics(params);
        } finally {
            adminClient = previous;
        }
    }

    /** Test hook: send via an existing producer instance. */
    static Object sendMessageForTest(DefaultMQProducer activeProducer, JsonObject params) throws Exception {
        DefaultMQProducer previous = producer;
        producer = activeProducer;
        try {
            return sendMessage(params);
        } finally {
            producer = previous;
        }
    }

    /** Test hook: peek messages with an existing admin client. */
    static Object peekMessagesForTest(DefaultMQAdminExt admin, JsonObject params) throws Exception {
        DefaultMQAdminExt previous = adminClient;
        adminClient = admin;
        try {
            return peekMessages(params);
        } finally {
            adminClient = previous;
        }
    }

    static String normalizeMessageType(String raw) {
        if (raw == null || raw.isBlank()) {
            return "NORMAL";
        }
        String upper = raw.trim().toUpperCase(Locale.ROOT);
        if ("ORDER".equals(upper)) {
            return "FIFO";
        }
        return upper;
    }

    private static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList(
        "mq_connect", "mq_test_connection", "mq_topics", "mq_consumer_groups",
        "mq_messages", "mq_acl", "mq_config", "mq_monitoring"
    ));

    private static DefaultMQAdminExt adminClient;
    private static DefaultMQProducer producer;
    private static JsonObject cachedConnection;
    private static String cachedBrokerAddr;
    private static String cachedClusterName;
    private static volatile boolean shutdownRequested;

    private RocketMqAgent() {}

    public static void main(String[] args) throws Exception {
        System.setProperty("org.slf4j.simpleLogger.logFile", "System.err");
        System.out.println("{\"ready\":true}");
        System.out.flush();

        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        while (true) {
            String line = reader.readLine();
            if (line == null) {
                break;
            }
            String response = handleRequest(line);
            System.out.println(response);
            System.out.flush();
            if (shutdownRequested) {
                System.exit(0);
            }
        }
    }

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
            case "mq_list_topics" -> listTopics(params);
            case "mq_create_topic" -> createTopic(params);
            case "mq_delete_topic" -> deleteTopic(params);
            case "mq_update_partitions" -> updatePartitions(params);
            case "mq_get_topic_stats" -> getTopicStats(params);
            case "mq_get_topic_route" -> getTopicRoute(params);
            case "mq_get_topic_config" -> getTopicConfig(params);
            case "mq_alter_topic_config" -> alterTopicConfig(params);
            case "mq_skip_topic_accumulation" -> skipTopicAccumulation(params);
            case "mq_list_consumer_groups" -> listConsumerGroups(params);
            case "mq_describe_consumer_group" -> describeConsumerGroup(params);
            case "mq_delete_consumer_group" -> deleteConsumerGroup(params);
            case "mq_get_subscription_group_config" -> getSubscriptionGroupConfig(params);
            case "mq_alter_subscription_group_config" -> alterSubscriptionGroupConfig(params);
            case "mq_reset_consumer_group_offsets" -> resetConsumerGroupOffsets(params);
            case "mq_get_consumer_lag" -> getConsumerLag(params);
            case "mq_list_producers" -> listProducers(params);
            case "mq_peek_messages" -> peekMessages(params);
            case "mq_view_message" -> viewMessage(params);
            case "mq_query_message_by_key" -> queryMessageByKey(params);
            case "mq_query_message_by_topic" -> queryMessageByTopic(params);
            case "mq_query_message_trace" -> queryMessageTrace(params);
            case "mq_send_message" -> sendMessage(params);
            case "mq_list_acls" -> listAcls(params);
            case "mq_create_acls" -> createAcls(params);
            case "mq_delete_acls" -> deleteAcls(params);
            case "mq_describe_cluster" -> describeCluster(params);
            default -> throw new IllegalArgumentException("Unknown method: " + method);
        };
    }

    private static Object handshakeResult() {
        return new HandshakeResult(1, 1, CAPABILITIES);
    }

    private static Object connect(JsonObject params) throws Exception {
        JsonObject conn = connectionObject(params);
        DefaultMQAdminExt nextAdmin = null;
        DefaultMQProducer nextProducer = null;
        try {
            nextAdmin = buildAdminClient(conn);
            nextAdmin.examineBrokerClusterInfo();
            nextProducer = buildProducer(conn);
            closeClients();
            adminClient = nextAdmin;
            producer = nextProducer;
            cachedConnection = conn.deepCopy();
            cachedClusterName = resolveClusterName(nextAdmin, conn);
            cachedBrokerAddr = resolveBrokerAddr(nextAdmin, conn);
            return Collections.singletonMap("ok", true);
        } catch (Exception e) {
            if (nextAdmin != null) {
                nextAdmin.shutdown();
            }
            if (nextProducer != null) {
                nextProducer.shutdown();
            }
            throw e;
        }
    }

    private static Object testConnection(JsonObject params) throws Exception {
        JsonObject conn = connectionObject(params);
        DefaultMQAdminExt probe = null;
        try {
            probe = buildAdminClient(conn);
            ClusterInfo clusterInfo = probe.examineBrokerClusterInfo();
            String clusterName = resolveClusterName(clusterInfo, conn);
            List<Map<String, Object>> brokers = brokerNodes(clusterInfo);
            boolean aclEnabled = probeAclSupport(probe);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("ok", true);
            result.put("clusterId", clusterName);
            result.put("brokers", brokers);
            result.put("nodeCount", brokers.size());
            result.put("controller", brokers.isEmpty() ? null : brokers.get(0));
            result.put("aclEnabled", aclEnabled);
            return result;
        } finally {
            if (probe != null) {
                probe.shutdown();
            }
        }
    }

    private static void closeClients() {
        if (adminClient != null) {
            adminClient.shutdown();
            adminClient = null;
        }
        if (producer != null) {
            producer.shutdown();
            producer = null;
        }
        cachedConnection = null;
        cachedBrokerAddr = null;
        cachedClusterName = null;
    }

    private static Object listTopics(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String keyword = stringOrEmpty(params, "keyword").toLowerCase(Locale.ROOT);
        int offset = Math.max(0, intOrDefault(params, "offset", 0));
        int limit = intOrDefault(params, "limit", DEFAULT_LIST_LIMIT);
        if (limit <= 0) {
            limit = DEFAULT_LIST_LIMIT;
        }

        TopicList topicList = fetchTopicList(admin, connectionObject(params));
        Set<String> brokerSystemTopics = collectBrokerSystemTopics(admin);
        Set<String> brokerNames = collectBrokerNames(admin);
        String cluster = clusterName(params, admin);
        JsonObject conn = connectionObject(params);
        Map<String, TopicConfig> brokerTopics = collectBrokerTopicConfigs(admin, conn);
        Map<String, Map<String, String>> topicAttributes = topicAttributesFromConfigs(brokerTopics);
        // Prefer broker topic configs (Dashboard ground truth); nameserver routes can outlive broker deletion.
        Set<String> topicNames = brokerTopics.isEmpty()
            ? new TreeSet<>(topicList.getTopicList())
            : brokerTopics.keySet();
        List<Map<String, Object>> topics = new ArrayList<>();
        for (String topic : topicNames) {
            if (!keyword.isBlank() && !topic.toLowerCase(Locale.ROOT).contains(keyword)) {
                continue;
            }
            TopicConfig brokerConfig = brokerTopics.get(topic);
            int partitions = brokerConfig == null ? 1 : Math.max(brokerConfig.getReadQueueNums(), 1);
            if (brokerConfig == null) {
                try {
                    TopicRouteData route = admin.examineTopicRouteInfo(topic);
                    if (route.getQueueDatas() != null && !route.getQueueDatas().isEmpty()) {
                        partitions = Math.max(route.getQueueDatas().get(0).getReadQueueNums(), 1);
                    }
                } catch (Exception ignored) {
                    // Stale nameserver-only topics are skipped below when broker configs are available.
                    if (!brokerTopics.isEmpty()) {
                        continue;
                    }
                }
            }
            Map<String, String> attributes = topicAttributes.get(topic);
            if (isUserTopic(topic) && readTopicMessageTypeAttribute(attributes) == null) {
                String resolved = brokerConfig == null
                    ? resolveTopicMessageType(admin, conn, topic)
                    : readTopicMessageType(brokerConfig);
                if (resolved != null && !resolved.isBlank()) {
                    attributes = attributes == null ? new HashMap<>() : new HashMap<>(attributes);
                    attributes.put("+" + TOPIC_MESSAGE_TYPE_ATTRIBUTE, resolved);
                }
            }
            String messageType = classifyTopicMessageType(
                topic, attributes, brokerSystemTopics, brokerNames, cluster);
            boolean internal = "SYSTEM".equals(messageType)
                || "RETRY".equals(messageType)
                || "DLQ".equals(messageType);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", topic);
            row.put("partitions", partitions);
            row.put("replicationFactor", 1);
            row.put("internal", internal);
            row.put("messageType", messageType);
            topics.add(row);
        }
        topics.sort(Comparator.comparing(m -> String.valueOf(m.get("name"))));

        int total = topics.size();
        List<Map<String, Object>> page = paginate(topics, offset, limit);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("topics", page);
        result.put("total", total);
        result.put("offset", offset);
        result.put("limit", limit);
        return result;
    }

    private static Object createTopic(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String name = requireString(params, "name");
        int readQueues = intOrDefault(params, "readQueueNums", intOrDefault(params, "partitions", 8));
        int writeQueues = intOrDefault(params, "writeQueueNums", readQueues);
        int perm = normalizeTopicPerm(intOrDefault(params, "perm", 6));
        String messageType = normalizeMessageType(stringOrDefault(params, "messageType", "NORMAL"));
        String brokerName = stringOrEmpty(params, "brokerName");
        TopicConfig config = buildTopicConfigForCreate(name, readQueues, writeQueues, messageType, perm);
        for (String brokerAddr : resolveMasterBrokerAddrs(
            admin, conn, brokerName.isBlank() ? null : brokerName)) {
            admin.createAndUpdateTopicConfig(brokerAddr, config);
        }
        return Collections.singletonMap("ok", true);
    }

    private static Object deleteTopic(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String name = requireString(params, "name");
        String brokerName = stringOrEmpty(params, "brokerName");
        // Match RocketMQ Dashboard: delete broker configs and nameserver routes (remapped addrs for docker).
        Set<String> masterAddrs = new LinkedHashSet<>(resolveMasterBrokerAddrs(
            admin, conn, brokerName.isBlank() ? null : brokerName));
        if (!masterAddrs.isEmpty()) {
            admin.deleteTopicInBroker(masterAddrs, name);
        }
        Set<String> nameServerSet = resolveNameServerAddrSet(conn);
        if (!nameServerSet.isEmpty()) {
            admin.deleteTopicInNameServer(nameServerSet, name);
        }
        return Collections.singletonMap("ok", true);
    }

    private static Object updatePartitions(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String name = requireString(params, "name");
        int totalPartitions = intOrDefault(params, "totalPartitions", 1);
        int readQueues = intOrDefault(params, "readQueueNums", totalPartitions);
        int writeQueues = intOrDefault(params, "writeQueueNums", totalPartitions);
        String brokerAddr = brokerAddr(params, admin, conn);
        TopicConfig config = loadTopicConfig(admin, brokerAddr, name);
        config.setReadQueueNums(readQueues);
        config.setWriteQueueNums(writeQueues);
        admin.createAndUpdateTopicConfig(brokerAddr, config);
        return Collections.singletonMap("ok", true);
    }

    private static Object getTopicRoute(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String name = requireString(params, "name");
        TopicRouteData route = admin.examineTopicRouteInfo(name);
        List<Map<String, Object>> queueDatas = new ArrayList<>();
        if (route.getQueueDatas() != null) {
            for (QueueData queueData : route.getQueueDatas()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("brokerName", queueData.getBrokerName());
                row.put("readQueueNums", queueData.getReadQueueNums());
                row.put("writeQueueNums", queueData.getWriteQueueNums());
                row.put("perm", queueData.getPerm());
                queueDatas.add(row);
            }
        }
        List<Map<String, Object>> brokerDatas = new ArrayList<>();
        if (route.getBrokerDatas() != null) {
            for (BrokerData brokerData : route.getBrokerDatas()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("brokerName", brokerData.getBrokerName());
                row.put("cluster", brokerData.getCluster());
                row.put("brokerAddrs", brokerData.getBrokerAddrs());
                brokerDatas.add(row);
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("topic", name);
        result.put("queueDatas", queueDatas);
        result.put("brokerDatas", brokerDatas);
        return result;
    }

    private static Object skipTopicAccumulation(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String topic = requireString(params, "topic");
        Set<String> groupIds = queryTopicConsumeByWhoRemapped(admin, conn, topic);
        if (groupIds.isEmpty()) {
            return Map.of("ok", true, "resetGroups", 0);
        }
        long timestamp = System.currentTimeMillis();
        int resetGroups = 0;
        for (String groupId : groupIds) {
            admin.resetOffsetByTimestamp(topic, groupId, timestamp, true);
            resetGroups++;
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", true);
        result.put("resetGroups", resetGroups);
        return result;
    }

    private static Object viewMessage(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String topic = requireString(params, "topic");
        String msgId = requireString(params, "msgId");
        Integer partition = integerOrNull(params, "partition");
        Long offset = longOrNull(params, "offset");
        MessageExt message = resolveViewMessage(admin, conn, topic, msgId, partition, offset);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("message", peekedMessageFromRecord(topic, message));
        return result;
    }

    /**
     * Match rocketmq-dashboard 5.x: query by msgId across topic clusters, then fall back to
     * queue offset when peek/list responses already include partition + offset.
     */
    static MessageExt resolveViewMessage(
        DefaultMQAdminExt admin,
        JsonObject conn,
        String topic,
        String msgId,
        Integer partition,
        Long offset
    ) throws Exception {
        MessageExt message = queryMessageByIdAcrossClusters(admin, topic, msgId);
        if (message != null) {
            return message;
        }
        if (partition != null && offset != null) {
            message = readMessageAtQueueOffset(conn, admin, topic, partition, offset);
            if (message != null) {
                return message;
            }
        }
        throw new MQClientException(
            208,
            "query message by key finished, but no message. For more information, please visit the url, "
                + "https://rocketmq.apache.org/docs/bestPractice/06FAQ"
        );
    }

    static MessageExt queryMessageByIdAcrossClusters(DefaultMQAdminExt admin, String topic, String msgId) {
        try {
            return admin.viewMessage(topic, msgId);
        } catch (Exception ignored) {
        }
        try {
            Set<String> clusters = admin.getTopicClusterList(topic);
            if (clusters != null && !clusters.isEmpty()) {
                for (String cluster : clusters) {
                    MessageExt message = queryMessageByIdInCluster(admin, cluster, topic, msgId);
                    if (message != null) {
                        return message;
                    }
                }
                return null;
            }
            return queryMessageByIdInCluster(admin, "", topic, msgId);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static MessageExt queryMessageByIdInCluster(
        DefaultMQAdminExt admin,
        String cluster,
        String topic,
        String msgId
    ) {
        try {
            return admin.queryMessage(cluster, topic, msgId);
        } catch (MQClientException e) {
            if (isEmptyQueryMessageResult(e)) {
                return null;
            }
            return null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static MessageExt readMessageAtQueueOffset(
        JsonObject conn,
        DefaultMQAdminExt admin,
        String topic,
        int partition,
        long offset
    ) throws Exception {
        List<MessageQueue> queues = resolvePeekQueues(admin, topic, partition);
        if (queues.isEmpty()) {
            return null;
        }
        DefaultLitePullConsumer consumer = buildLitePullConsumer(conn);
        consumer.start();
        try {
            for (MessageQueue queue : queues) {
                if (queue.getQueueId() != partition) {
                    continue;
                }
                consumer.assign(Collections.singletonList(queue));
                consumer.seek(queue, offset);
                consumer.setPullBatchSize(1);
                List<MessageExt> polled = consumer.poll(3000);
                if (polled == null || polled.isEmpty()) {
                    continue;
                }
                for (MessageExt message : polled) {
                    if (message.getQueueOffset() == offset) {
                        return message;
                    }
                }
                return polled.get(0);
            }
            return null;
        } finally {
            consumer.shutdown();
        }
    }

    private static Object queryMessageByKey(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String topic = requireString(params, "topic");
        String key = requireString(params, "key");
        int maxNum = Math.max(1, Math.min(intOrDefault(params, "maxNum", 32), 200));
        long begin = longOrDefault(params, "begin", 0L);
        long end = longOrDefault(params, "end", System.currentTimeMillis());
        try {
            QueryResult queryResult = admin.queryMessage(topic, key, maxNum, begin, end);
            return queryResultToMap(topic, queryResult);
        } catch (MQClientException e) {
            if (isEmptyQueryMessageResult(e)) {
                return emptyQueryResultMap();
            }
            throw e;
        }
    }

    private static Object queryMessageByTopic(JsonObject params) throws Exception {
        JsonObject conn = connectionObject(params);
        String topic = requireString(params, "topic");
        int maxNum = Math.max(1, Math.min(intOrDefault(params, "maxNum", 32), 200));
        long begin = longOrDefault(params, "begin", 0L);
        long end = longOrDefault(params, "end", System.currentTimeMillis());
        // Match rocketmq-dashboard: scan queues by store timestamp instead of queryMessage(topic, topic, ...).
        List<Map<String, Object>> messages = queryMessagesByTopicTimeRange(conn, topic, begin, end, maxNum);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("messages", messages);
        result.put("indexLastUpdateTimestamp", 0L);
        return result;
    }

    private static Object queryMessageTrace(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String msgId = requireString(params, "msgId");
        String traceTopic = stringOrDefault(params, "traceTopic", "RMQ_SYS_TRACE_TOPIC");
        int maxNum = Math.max(1, Math.min(intOrDefault(params, "maxNum", 64), 200));
        long begin = longOrDefault(params, "begin", 0L);
        long end = longOrDefault(params, "end", System.currentTimeMillis());
        try {
            QueryResult queryResult = admin.queryMessage(traceTopic, msgId, maxNum, begin, end);
            Map<String, Object> result = queryResultToMap(traceTopic, queryResult);
            result.put("msgId", msgId);
            result.put("traceTopic", traceTopic);
            return result;
        } catch (MQClientException e) {
            if (isEmptyQueryMessageResult(e)) {
                Map<String, Object> result = emptyQueryResultMap();
                result.put("msgId", msgId);
                result.put("traceTopic", traceTopic);
                return result;
            }
            throw e;
        }
    }

    /**
     * RocketMQ client code 208 means the key/index lookup completed with zero matches.
     * Dashboard treats this as an empty result, not a hard failure.
     */
    static boolean isEmptyQueryMessageResult(MQClientException e) {
        return e != null && e.getResponseCode() == 208;
    }

    private static Map<String, Object> emptyQueryResultMap() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("messages", Collections.emptyList());
        result.put("indexLastUpdateTimestamp", 0L);
        return result;
    }

    private static List<Map<String, Object>> queryMessagesByTopicTimeRange(
        JsonObject conn,
        String topic,
        long begin,
        long end,
        int maxNum
    ) throws Exception {
        DefaultMQPullConsumer consumer = buildPullConsumer(conn);
        consumer.start();
        try {
            List<Map<String, Object>> messages = new ArrayList<>();
            Set<MessageQueue> queues = consumer.fetchSubscribeMessageQueues(topic);
            for (MessageQueue queue : queues) {
                if (messages.size() >= maxNum) {
                    break;
                }
                long minOffset;
                long maxOffset;
                try {
                    minOffset = consumer.searchOffset(queue, begin);
                    maxOffset = consumer.searchOffset(queue, end);
                } catch (Exception ignored) {
                    continue;
                }
                if (maxOffset < minOffset) {
                    continue;
                }
                READQ:
                for (long offset = minOffset; offset <= maxOffset; ) {
                    if (messages.size() >= maxNum) {
                        break;
                    }
                    PullResult pullResult = consumer.pull(queue, "*", offset, 32);
                    offset = pullResult.getNextBeginOffset();
                    switch (pullResult.getPullStatus()) {
                        case FOUND -> {
                            for (MessageExt message : pullResult.getMsgFoundList()) {
                                long storeTimestamp = message.getStoreTimestamp();
                                if (storeTimestamp >= begin && storeTimestamp <= end) {
                                    messages.add(peekedMessageFromRecord(topic, message));
                                    if (messages.size() >= maxNum) {
                                        break READQ;
                                    }
                                }
                            }
                        }
                        case NO_MATCHED_MSG, NO_NEW_MSG, OFFSET_ILLEGAL -> {
                            break READQ;
                        }
                        default -> {
                        }
                    }
                }
            }
            sortPeekedMessages(messages);
            if (messages.size() > maxNum) {
                messages = new ArrayList<>(messages.subList(0, maxNum));
            }
            return messages;
        } finally {
            consumer.shutdown();
        }
    }

    private static Map<String, Object> queryResultToMap(String topic, QueryResult queryResult) {
        List<Map<String, Object>> messages = new ArrayList<>();
        if (queryResult.getMessageList() != null) {
            for (MessageExt message : queryResult.getMessageList()) {
                messages.add(peekedMessageFromRecord(topic, message));
            }
        }
        sortPeekedMessages(messages);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("messages", messages);
        result.put("indexLastUpdateTimestamp", queryResult.getIndexLastUpdateTimestamp());
        return result;
    }

    private static Object getTopicStats(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String name = requireString(params, "name");
        TopicStatsTable stats = examineTopicStatsRemapped(admin, conn, name);

        long totalMessages = 0;
        List<Map<String, Object>> partitionStats = new ArrayList<>();
        if (stats.getOffsetTable() != null) {
            for (var entry : stats.getOffsetTable().entrySet()) {
                long begin = entry.getValue().getMinOffset();
                long end = entry.getValue().getMaxOffset();
                long count = Math.max(0, end - begin);
                totalMessages += count;

                Map<String, Object> ps = new LinkedHashMap<>();
                ps.put("partition", entry.getKey().getQueueId());
                ps.put("brokerName", entry.getKey().getBrokerName());
                ps.put("beginOffset", begin);
                ps.put("endOffset", end);
                ps.put("messageCount", count);
                partitionStats.add(ps);
            }
        }
        partitionStats.sort(Comparator.comparingInt(a -> (int) a.get("partition")));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", name);
        result.put("partitions", partitionStats.size());
        result.put("replicationFactor", 1);
        result.put("totalMessages", totalMessages);
        result.put("partitionStats", partitionStats);
        return result;
    }

    /**
     * DefaultMQAdminExt.examineTopicStats(topic) uses broker addresses from NameServer route
     * directly. Docker brokers often register unreachable internal IPs; remap to the namesrv host.
     */
    private static TopicStatsTable examineTopicStatsRemapped(
        DefaultMQAdminExt admin, JsonObject conn, String topic) throws Exception {
        TopicRouteData route = admin.examineTopicRouteInfo(topic);
        TopicStatsTable merged = new TopicStatsTable();
        if (route.getBrokerDatas() != null) {
            for (BrokerData brokerData : route.getBrokerDatas()) {
                String rawAddr = brokerData.selectBrokerAddr();
                if (rawAddr == null || rawAddr.isBlank()) {
                    continue;
                }
                String brokerAddr = remapBrokerAddrForClient(rawAddr, conn);
                TopicStatsTable partial = admin.examineTopicStats(brokerAddr, topic);
                if (partial != null && partial.getOffsetTable() != null) {
                    merged.getOffsetTable().putAll(partial.getOffsetTable());
                }
            }
        }
        if (merged.getOffsetTable().isEmpty()) {
            throw new MQClientException("Not found the topic stats info", null);
        }
        return merged;
    }

    private static SubscriptionGroupConfig findSubscriptionGroupConfig(
        DefaultMQAdminExt admin, JsonObject conn, String groupId) throws Exception {
        for (String brokerAddr : resolveMasterBrokerAddrs(admin, conn)) {
            try {
                SubscriptionGroupWrapper wrapper = admin.getAllSubscriptionGroup(brokerAddr, DEFAULT_REQUEST_TIMEOUT_MS);
                if (wrapper == null || wrapper.getSubscriptionGroupTable() == null) {
                    continue;
                }
                SubscriptionGroupConfig config = wrapper.getSubscriptionGroupTable().get(groupId);
                if (config != null) {
                    return config;
                }
            } catch (Exception ignored) {
                // Try next broker.
            }
        }
        return null;
    }

    /**
     * DefaultMQAdminExt.examineConsumerConnectionInfo(group) picks a broker from route using
     * NameServer-registered addresses. Remap to the client-reachable host before querying.
     */
    private static ConsumerConnection examineConsumerConnectionInfoRemapped(
        DefaultMQAdminExt admin, JsonObject conn, String groupId) {
        try {
            for (String brokerAddr : resolveMasterBrokerAddrs(admin, conn)) {
                try {
                    ConsumerConnection connection = admin.examineConsumerConnectionInfo(groupId, brokerAddr);
                    if (connection.getConnectionSet() != null && !connection.getConnectionSet().isEmpty()) {
                        return connection;
                    }
                } catch (Exception ignored) {
                    // Try next broker; offline groups return an empty connection below.
                }
            }
        } catch (Exception ignored) {
            // No reachable broker addresses.
        }
        return new ConsumerConnection();
    }

    private static ConsumeStats examineConsumeStatsRemapped(
        DefaultMQAdminExt admin, JsonObject conn, String groupId, String topic) throws Exception {
        ConsumeStats merged = new ConsumeStats();
        for (String brokerAddr : resolveMasterBrokerAddrs(admin, conn)) {
            try {
                ConsumeStats stats = admin.examineConsumeStats(brokerAddr, groupId, topic);
                if (stats != null && stats.getOffsetTable() != null) {
                    merged.getOffsetTable().putAll(stats.getOffsetTable());
                    merged.setConsumeTps(merged.getConsumeTps() + stats.getConsumeTps());
                }
            } catch (Exception ignored) {
                // Try next broker.
            }
        }
        return merged;
    }

    /**
     * RocketMQ admin {@code queryTopicConsumeByWho(topic)} contacts the first broker using
     * NameServer-registered addresses (often Docker-internal IPs). Remap each broker before
     * querying, matching Dashboard {@code queryTopicConsumerInfo}.
     */
    private static Set<String> queryTopicConsumeByWhoRemapped(
        DefaultMQAdminExt admin, JsonObject conn, String topic) {
        Set<String> groups = new TreeSet<>();
        try {
            TopicRouteData route = admin.examineTopicRouteInfo(topic);
            if (route != null && route.getBrokerDatas() != null) {
                for (BrokerData brokerData : route.getBrokerDatas()) {
                    String rawAddr = brokerData.selectBrokerAddr();
                    if (rawAddr == null || rawAddr.isBlank()) {
                        continue;
                    }
                    String brokerAddr = remapBrokerAddrForClient(rawAddr, conn);
                    try {
                        GroupList groupList = queryTopicConsumeByWhoOnBroker(admin, brokerAddr, topic);
                        if (groupList != null && groupList.getGroupList() != null) {
                            groups.addAll(groupList.getGroupList());
                        }
                    } catch (Exception ignored) {
                        // Try next broker.
                    }
                }
            }
        } catch (Exception ignored) {
            // Fall through to aggregate admin call below.
        }
        if (groups.isEmpty()) {
            try {
                GroupList groupList = admin.queryTopicConsumeByWho(topic);
                if (groupList != null && groupList.getGroupList() != null) {
                    groups.addAll(groupList.getGroupList());
                }
            } catch (Exception ignored) {
                // Topic may have no registered consumer groups yet.
            }
        }
        return groups;
    }

    /** Broker-scoped query; DefaultMQAdminExt only exposes topic-level aggregation. */
    private static GroupList queryTopicConsumeByWhoOnBroker(
        DefaultMQAdminExt admin, String brokerAddr, String topic) throws Exception {
        try {
            var implField = DefaultMQAdminExt.class.getDeclaredField("defaultMQAdminExtImpl");
            implField.setAccessible(true);
            Object impl = implField.get(admin);
            var mqClientMethod = impl.getClass().getMethod("getMqClientInstance");
            Object mqClient = mqClientMethod.invoke(impl);
            var apiMethod = mqClient.getClass().getMethod("getMQClientAPIImpl");
            Object api = apiMethod.invoke(mqClient);
            var timeoutField = impl.getClass().getDeclaredField("timeoutMillis");
            timeoutField.setAccessible(true);
            long timeout = timeoutField.getLong(impl);
            var queryMethod = api.getClass().getMethod(
                "queryTopicConsumeByWho", String.class, String.class, long.class);
            return (GroupList) queryMethod.invoke(api, brokerAddr, topic, timeout);
        } catch (ReflectiveOperationException e) {
            throw new MQClientException("Failed to query topic consumers on broker " + brokerAddr, e);
        }
    }

    /** Topic config dialog exposes the same editable fields as rocketmq-dashboard. */
    private static final Set<String> EDITABLE_TOPIC_CONFIG_KEYS = Set.of(
        "readQueueNums", "writeQueueNums", "perm"
    );

    private static Object getTopicConfig(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String name = requireString(params, "name");
        String brokerAddr = brokerAddr(params, admin);
        TopicConfig config = loadTopicConfig(admin, brokerAddr, name);

        Map<String, Object> configs = new LinkedHashMap<>();
        putConfigEntry(configs, "readQueueNums", String.valueOf(config.getReadQueueNums()));
        putConfigEntry(configs, "writeQueueNums", String.valueOf(config.getWriteQueueNums()));
        putConfigEntry(configs, "perm", String.valueOf(config.getPerm()));
        return Collections.singletonMap("configs", configs);
    }

    private static Object alterTopicConfig(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String name = requireString(params, "name");
        String brokerAddr = brokerAddr(params, admin);
        TopicConfig config = loadTopicConfig(admin, brokerAddr, name);

        JsonArray entries = params.has("configs") && params.get("configs").isJsonArray()
            ? params.getAsJsonArray("configs") : new JsonArray();
        for (JsonElement element : entries) {
            JsonObject entry = element.getAsJsonObject();
            String key = entry.get("key").getAsString();
            String op = stringOrDefault(entry, "op", "set");
            if ("delete".equalsIgnoreCase(op)) {
                if (config.getAttributes() != null) {
                    config.getAttributes().remove(key);
                }
                continue;
            }
            String value = entry.has("value") && !entry.get("value").isJsonNull()
                ? entry.get("value").getAsString() : null;
            if (!EDITABLE_TOPIC_CONFIG_KEYS.contains(key)) {
                continue;
            }
            applyTopicConfigValue(config, key, value);
        }

        admin.createAndUpdateTopicConfig(brokerAddr, config);
        return Collections.singletonMap("ok", true);
    }

    private static Object listConsumerGroups(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String topicFilter = stringOrEmpty(params, "topic");
        String keyword = stringOrEmpty(params, "keyword").toLowerCase(Locale.ROOT);
        int offset = Math.max(0, intOrDefault(params, "offset", 0));
        int limit = intOrDefault(params, "limit", DEFAULT_LIST_LIMIT);
        if (limit <= 0) {
            limit = DEFAULT_LIST_LIMIT;
        }

        Set<String> groups = new TreeSet<>();
        if (!topicFilter.isBlank()) {
            groups.addAll(queryTopicConsumeByWhoRemapped(admin, conn, topicFilter));
        } else {
            groups.addAll(collectAllConsumerGroups(admin, conn));
        }

        List<Map<String, Object>> rows = new ArrayList<>();
        for (String groupId : groups) {
            if (!keyword.isBlank() && !groupId.toLowerCase(Locale.ROOT).contains(keyword)) {
                continue;
            }
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("groupId", groupId);
            row.put("state", "UNKNOWN");
            row.put("simpleGroup", false);
            row.put("groupType", "NORMAL");
            row.put("messageModel", "CLUSTERING");
            rows.add(row);
        }

        int total = rows.size();
        List<Map<String, Object>> page = paginate(rows, offset, limit);
        for (Map<String, Object> row : page) {
            String groupId = String.valueOf(row.get("groupId"));
            SubscriptionGroupConfig config = findSubscriptionGroupConfig(admin, conn, groupId);
            row.put("groupType", classifyConsumerGroupType(groupId, config));
        }
        if (boolOrDefault(params, "enrich", false)) {
            for (Map<String, Object> row : page) {
                enrichConsumerGroupRow(admin, conn, String.valueOf(row.get("groupId")), row);
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("groups", page);
        result.put("total", total);
        result.put("offset", offset);
        result.put("limit", limit);
        return result;
    }

    private static void enrichConsumerGroupRow(
        DefaultMQAdminExt admin, JsonObject conn, String groupId, Map<String, Object> row) {
        try {
            SubscriptionGroupConfig config = findSubscriptionGroupConfig(admin, conn, groupId);
            row.put("groupType", classifyConsumerGroupType(groupId, config));
            ConsumerConnection connection = examineConsumerConnectionInfoRemapped(admin, conn, groupId);
            row.put("consumeType", connection.getConsumeType() != null ? connection.getConsumeType().name() : "UNKNOWN");
            if (connection.getMessageModel() != null) {
                row.put("messageModel", connection.getMessageModel().name());
            }
            int memberCount = connection.getConnectionSet() == null ? 0 : connection.getConnectionSet().size();
            row.put("memberCount", memberCount);
            List<String> topics = new ArrayList<>();
            if (connection.getSubscriptionTable() != null) {
                for (SubscriptionData sub : connection.getSubscriptionTable().values()) {
                    if (sub.getTopic() != null && !sub.getTopic().isBlank()) {
                        topics.add(sub.getTopic());
                    }
                }
            }
            row.put("topics", topics);
        } catch (Exception ignored) {
            row.putIfAbsent("memberCount", 0);
            row.putIfAbsent("topics", Collections.emptyList());
        }
    }

    private static Object describeConsumerGroup(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String groupId = requireString(params, "groupId");
        ConsumerConnection connection = examineConsumerConnectionInfoRemapped(admin, conn, groupId);

        List<Map<String, Object>> sharedAssignments = new ArrayList<>();
        if (connection.getSubscriptionTable() != null) {
            for (SubscriptionData sub : connection.getSubscriptionTable().values()) {
                Map<String, Object> assignment = new LinkedHashMap<>();
                assignment.put("topic", sub.getTopic());
                assignment.put("subExpression", sub.getSubString());
                sharedAssignments.add(assignment);
            }
        }

        List<Map<String, Object>> members = new ArrayList<>();
        if (connection.getConnectionSet() != null) {
            for (Connection clientConn : connection.getConnectionSet()) {
                Map<String, Object> member = new LinkedHashMap<>();
                member.put("memberId", clientConn.getClientId());
                member.put("clientId", clientConn.getClientId());
                member.put("host", clientConn.getClientAddr());
                member.put("assignments", sharedAssignments);
                members.add(member);
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("groupId", groupId);
        result.put("state", connection.getConsumeType() != null ? connection.getConsumeType().name() : "UNKNOWN");
        result.put("partitionAssignor", connection.getMessageModel() != null
            ? connection.getMessageModel().name() : null);
        result.put("messageModel", connection.getMessageModel() != null
            ? connection.getMessageModel().name() : null);
        result.put("members", members);
        return result;
    }

    private static Object deleteConsumerGroup(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String groupId = requireString(params, "groupId");
        admin.deleteSubscriptionGroup(brokerAddr(params, admin), groupId);
        return Collections.singletonMap("ok", true);
    }

    private static Object getSubscriptionGroupConfig(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String groupId = requireString(params, "groupId");
        SubscriptionGroupConfig config = findSubscriptionGroupConfig(admin, conn, groupId);
        if (config == null) {
            throw new IllegalArgumentException("Consumer group not found: " + groupId);
        }
        return subscriptionGroupConfigToMap(config);
    }

    private static Object alterSubscriptionGroupConfig(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String groupId = requireString(params, "groupId");
        SubscriptionGroupConfig config = findSubscriptionGroupConfig(admin, conn, groupId);
        if (config == null) {
            config = new SubscriptionGroupConfig();
            config.setGroupName(groupId);
        }
        applySubscriptionGroupConfigUpdates(config, params);
        for (String brokerAddr : resolveMasterBrokerAddrs(admin, conn)) {
            try {
                admin.createAndUpdateSubscriptionGroupConfig(brokerAddr, config);
            } catch (Exception ignored) {
                // Try next broker when Docker/internal broker addresses are unreachable.
            }
        }
        return Collections.singletonMap("ok", true);
    }

    private static Map<String, Object> subscriptionGroupConfigToMap(SubscriptionGroupConfig config) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("groupName", config.getGroupName());
        map.put("consumeEnable", config.isConsumeEnable());
        map.put("consumeFromMinEnable", config.isConsumeFromMinEnable());
        map.put("consumeBroadcastEnable", config.isConsumeBroadcastEnable());
        map.put("consumeMessageOrderly", config.isConsumeMessageOrderly());
        map.put("retryQueueNums", config.getRetryQueueNums());
        map.put("retryMaxTimes", config.getRetryMaxTimes());
        map.put("brokerId", config.getBrokerId());
        map.put("whichBrokerWhenConsumeSlowly", config.getWhichBrokerWhenConsumeSlowly());
        return map;
    }

    private static void applySubscriptionGroupConfigUpdates(SubscriptionGroupConfig config, JsonObject params) {
        if (params.has("consumeEnable") && !params.get("consumeEnable").isJsonNull()) {
            config.setConsumeEnable(params.get("consumeEnable").getAsBoolean());
        }
        if (params.has("consumeFromMinEnable") && !params.get("consumeFromMinEnable").isJsonNull()) {
            config.setConsumeFromMinEnable(params.get("consumeFromMinEnable").getAsBoolean());
        }
        if (params.has("consumeBroadcastEnable") && !params.get("consumeBroadcastEnable").isJsonNull()) {
            config.setConsumeBroadcastEnable(params.get("consumeBroadcastEnable").getAsBoolean());
        }
        if (params.has("consumeMessageOrderly") && !params.get("consumeMessageOrderly").isJsonNull()) {
            config.setConsumeMessageOrderly(params.get("consumeMessageOrderly").getAsBoolean());
        }
        if (params.has("retryQueueNums") && !params.get("retryQueueNums").isJsonNull()) {
            config.setRetryQueueNums(params.get("retryQueueNums").getAsInt());
        }
        if (params.has("retryMaxTimes") && !params.get("retryMaxTimes").isJsonNull()) {
            config.setRetryMaxTimes(params.get("retryMaxTimes").getAsInt());
        }
        if (params.has("brokerId") && !params.get("brokerId").isJsonNull()) {
            config.setBrokerId(params.get("brokerId").getAsLong());
        }
        if (params.has("whichBrokerWhenConsumeSlowly") && !params.get("whichBrokerWhenConsumeSlowly").isJsonNull()) {
            config.setWhichBrokerWhenConsumeSlowly(params.get("whichBrokerWhenConsumeSlowly").getAsLong());
        }
    }

    private static Object resetConsumerGroupOffsets(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String groupId = requireString(params, "groupId");
        String topic = requireString(params, "topic");
        String brokerAddr = brokerAddr(params, admin);

        JsonArray offsetArray = params.has("offsets") && params.get("offsets").isJsonArray()
            ? params.getAsJsonArray("offsets") : new JsonArray();
        if (!offsetArray.isEmpty()) {
            for (JsonElement element : offsetArray) {
                JsonObject offsetObj = element.getAsJsonObject();
                int partition = offsetObj.get("partition").getAsInt();
                long offset = offsetObj.get("offset").getAsLong();
                admin.resetOffsetByQueueId(brokerAddr, groupId, topic, partition, offset);
            }
            return Collections.singletonMap("ok", true);
        }

        String position = stringOrDefault(params, "position", "latest");
        long timestamp = switch (position.toLowerCase(Locale.ROOT)) {
            case "earliest" -> 0L;
            case "latest" -> System.currentTimeMillis();
            case "timestamp" -> longOrDefault(params, "timestampMs", System.currentTimeMillis());
            default -> throw new IllegalArgumentException("Unsupported reset position: " + position);
        };
        admin.resetOffsetByTimestamp(topic, groupId, timestamp, true);
        return Collections.singletonMap("ok", true);
    }

    private static Object getConsumerLag(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String groupId = requireString(params, "groupId");
        String topic = requireString(params, "topic");
        ConsumeStats stats = examineConsumeStatsRemapped(admin, conn, groupId, topic);

        long totalLag = 0;
        List<Map<String, Object>> partitions = new ArrayList<>();
        if (stats.getOffsetTable() != null) {
            for (var entry : stats.getOffsetTable().entrySet()) {
                long consumerOffset = entry.getValue().getConsumerOffset();
                long brokerOffset = entry.getValue().getBrokerOffset();
                long lag = Math.max(0, brokerOffset - consumerOffset);
                totalLag += lag;

                Map<String, Object> partition = new LinkedHashMap<>();
                partition.put("partition", entry.getKey().getQueueId());
                partition.put("currentOffset", consumerOffset);
                partition.put("endOffset", brokerOffset);
                partition.put("lag", lag);
                partitions.add(partition);
            }
        }
        partitions.sort(Comparator.comparingInt(a -> (int) a.get("partition")));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("partitions", partitions);
        result.put("totalLag", totalLag);
        return result;
    }

    private static Object listProducers(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        JsonObject conn = connectionObject(params);
        String topic = stringOrEmpty(params, "topic");
        String producerGroup = stringOrEmpty(params, "producerGroup");
        if (producerGroup.isBlank()) {
            producerGroup = stringOrEmpty(params, "group");
        }

        if (!producerGroup.isBlank()) {
            if (topic.isBlank()) {
                throw new IllegalArgumentException("topic is required when producerGroup is specified");
            }
            ProducerConnection connection = admin.examineProducerConnectionInfo(producerGroup, topic);
            List<Map<String, Object>> producers = new ArrayList<>();
            long producerId = 1;
            if (connection.getConnectionSet() != null) {
                for (Connection client : connection.getConnectionSet()) {
                    producers.add(producerRow(producerId++, producerGroup, client));
                }
            }
            return Collections.singletonMap("producers", producers);
        }

        List<String> brokerAddrs;
        if (!topic.isBlank()) {
            // Broker APIs cannot map producer connections to a topic (apache/rocketmq#6371).
            // Gate on topic produce stats: topics with no queued messages have no producers to show.
            TopicStatsTable stats = examineTopicStatsRemapped(admin, conn, topic);
            if (!topicHasProduceActivity(stats)) {
                return Collections.singletonMap("producers", Collections.emptyList());
            }
            brokerAddrs = resolveTopicRouteBrokerAddrs(admin, conn, topic);
        } else if (shouldQueryClusterProducerTable(topic, producerGroup)) {
            brokerAddrs = List.of(brokerAddr(params, admin, conn));
        } else {
            return Collections.singletonMap("producers", Collections.emptyList());
        }

        return Collections.singletonMap("producers", listProducersFromBrokers(admin, brokerAddrs));
    }

    /**
     * Returns true when the topic has ever received messages on at least one queue.
     * RocketMQ tracks this via {@code examineTopicStats}; empty topics should not inherit
     * broker-wide producer tables from unrelated groups.
     */
    static boolean topicHasProduceActivity(TopicStatsTable stats) {
        if (stats == null || stats.getOffsetTable() == null || stats.getOffsetTable().isEmpty()) {
            return false;
        }
        for (var entry : stats.getOffsetTable().entrySet()) {
            if (entry.getValue().getMaxOffset() > entry.getValue().getMinOffset()) {
                return true;
            }
        }
        return false;
    }

    static List<String> resolveTopicRouteBrokerAddrs(
        DefaultMQAdminExt admin, JsonObject conn, String topic) throws Exception {
        TopicRouteData route = admin.examineTopicRouteInfo(topic);
        LinkedHashSet<String> addrs = new LinkedHashSet<>();
        if (route.getBrokerDatas() != null) {
            for (BrokerData brokerData : route.getBrokerDatas()) {
                String rawAddr = brokerData.selectBrokerAddr();
                if (rawAddr == null || rawAddr.isBlank()) {
                    continue;
                }
                addrs.add(remapBrokerAddrForClient(rawAddr, conn));
            }
        }
        return new ArrayList<>(addrs);
    }

    static List<Map<String, Object>> listProducersFromBrokers(
        DefaultMQAdminExt admin, List<String> brokerAddrs) {
        List<Map<String, Object>> producers = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        long producerId = 1;
        for (String brokerAddr : brokerAddrs) {
            try {
                ProducerTableInfo tableInfo = admin.getAllProducerInfo(brokerAddr);
                producerId = appendProducerTableRows(producers, seen, producerId, tableInfo);
            } catch (Exception ignored) {
                // Try next broker when Docker/internal broker addresses are unreachable.
            }
        }
        return producers;
    }

    static long appendProducerTableRows(
        List<Map<String, Object>> producers,
        Set<String> seen,
        long producerId,
        ProducerTableInfo tableInfo) {
        if (tableInfo == null || tableInfo.getData() == null) {
            return producerId;
        }
        for (Map.Entry<String, List<ProducerInfo>> entry : tableInfo.getData().entrySet()) {
            String group = entry.getKey();
            if (entry.getValue() == null) {
                continue;
            }
            for (ProducerInfo info : entry.getValue()) {
                String dedupeKey = group + "|" + info.getRemoteIP();
                if (!seen.add(dedupeKey)) {
                    continue;
                }
                producers.add(producerRow(producerId++, group, info));
            }
        }
        return producerId;
    }

    private static Object peekMessages(JsonObject params) throws Exception {
        JsonObject conn = connectionObject(params);
        DefaultMQAdminExt admin = requireAdmin();
        String topic = requireString(params, "topic");
        int count = Math.max(1, Math.min(intOrDefault(params, "count", 10), 100));
        Integer partition = integerOrNull(params, "partition");
        Long offset = longOrNull(params, "offset");

        List<MessageQueue> queues = resolvePeekQueues(admin, topic, partition);
        if (queues.isEmpty()) {
            return Collections.singletonMap("messages", Collections.emptyList());
        }

        DefaultLitePullConsumer consumer = buildLitePullConsumer(conn);
        consumer.start();
        try {
            List<Map<String, Object>> messages = new ArrayList<>();
            for (MessageQueue queue : queues) {
                if (messages.size() >= count) {
                    break;
                }
                long minOffset = admin.minOffset(queue);
                long maxOffset = admin.maxOffset(queue);
                if (maxOffset <= minOffset) {
                    continue;
                }
                long seekOffset = offset != null ? offset : minOffset;
                if (seekOffset < minOffset) {
                    seekOffset = minOffset;
                }
                if (seekOffset >= maxOffset) {
                    continue;
                }

                consumer.assign(Collections.singletonList(queue));
                consumer.seek(queue, seekOffset);
                consumer.setPullBatchSize(count - messages.size());
                List<MessageExt> polled = consumer.poll(3000);
                for (MessageExt message : polled) {
                    messages.add(peekedMessageFromRecord(topic, message));
                    if (messages.size() >= count) {
                        break;
                    }
                }
            }
            sortPeekedMessages(messages);
            if (messages.size() > count) {
                messages = new ArrayList<>(messages.subList(0, count));
            }
            return Collections.singletonMap("messages", messages);
        } finally {
            consumer.shutdown();
        }
    }

    private static Object sendMessage(JsonObject params) throws Exception {
        DefaultMQProducer activeProducer = requireProducer();
        String topic = requireString(params, "topic");
        String key = params.has("key") && !params.get("key").isJsonNull()
            ? params.get("key").getAsString() : null;
        String tag = stringOrEmpty(params, "tag");
        if (tag.isBlank() && params.has("headers") && params.get("headers").isJsonObject()) {
            tag = stringOrEmpty(params.getAsJsonObject("headers"), "TAGS");
        }
        byte[] payload = decodePayload(params);
        Integer partition = integerOrNull(params, "partition");

        Message message = tag.isBlank() ? new Message(topic, payload) : new Message(topic, tag, payload);
        if (key != null && !key.isBlank()) {
            message.setKeys(key);
        } else if (params.has("headers") && params.get("headers").isJsonObject()) {
            String headerKey = stringOrEmpty(params.getAsJsonObject("headers"), "KEYS");
            if (!headerKey.isBlank()) {
                message.setKeys(headerKey);
            }
        }
        applySendHeaders(message, params);
        if (partition != null) {
            message.setWaitStoreMsgOK(true);
        }

        SendResult result = activeProducer.send(message);
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", true);
        response.put("topic", topic);
        response.put("partition", result.getMessageQueue().getQueueId());
        response.put("offset", result.getQueueOffset());
        response.put("timestamp", System.currentTimeMillis());
        return response;
    }

    private static Object listAcls(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String brokerAddr = brokerAddr(params, admin);
        String subjectFilter = stringOrNull(params, "principal");
        if (subjectFilter != null && subjectFilter.startsWith("User:")) {
            subjectFilter = subjectFilter.substring("User:".length());
        }
        if (subjectFilter == null) {
            subjectFilter = stringOrEmpty(params, "subject");
        }
        String resourceFilter = stringOrNull(params, "resourceName");

        List<Map<String, Object>> acls = new ArrayList<>();
        try {
            List<AclInfo> aclInfos = admin.listAcl(
                brokerAddr,
                subjectFilter == null ? "" : subjectFilter,
                resourceFilter == null ? "" : resourceFilter
            );
            if (aclInfos != null) {
                for (AclInfo aclInfo : aclInfos) {
                    acls.addAll(flattenAclInfo(aclInfo));
                }
            }
        } catch (Exception acl2Error) {
            // Fall back to empty list when ACL 2.0 APIs are unavailable.
            if (acls.isEmpty()) {
                throw acl2Error;
            }
        }
        return Collections.singletonMap("acls", acls);
    }

    private static Object createAcls(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String brokerAddr = brokerAddr(params, admin);
        JsonArray aclsArray = params.has("acls") && params.get("acls").isJsonArray()
            ? params.getAsJsonArray("acls") : new JsonArray();

        for (JsonElement element : aclsArray) {
            JsonObject acl = element.getAsJsonObject();
            if (acl.has("accessKey") || acl.has("secretKey")) {
                PlainAccessConfig config = plainAccessConfigFromJson(acl);
                admin.createAndUpdatePlainAccessConfig(brokerAddr, config);
                continue;
            }

            String subject = stringOrEmpty(acl, "principal");
            if (subject.startsWith("User:")) {
                subject = subject.substring("User:".length());
            }
            if (subject.isBlank()) {
                subject = stringOrEmpty(acl, "subject");
            }
            String resourceName = stringOrDefault(acl, "resourceName", "*");
            String operation = stringOrDefault(acl, "operation", "ALL");
            String permissionType = stringOrDefault(acl, "permissionType", "ALLOW");
            AclInfo aclInfo = AclInfo.of(
                subject,
                List.of(resourceName),
                List.of(mapOperation(operation)),
                List.of(stringOrDefault(acl, "host", "*")),
                permissionType
            );
            admin.createAcl(brokerAddr, aclInfo);
        }
        return Collections.singletonMap("ok", true);
    }

    private static Object deleteAcls(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        String brokerAddr = brokerAddr(params, admin);
        JsonArray filtersArray = params.has("filters") && params.get("filters").isJsonArray()
            ? params.getAsJsonArray("filters") : new JsonArray();

        int deleted = 0;
        if (filtersArray.isEmpty()) {
            @SuppressWarnings("unchecked")
            Map<String, Object> listed = (Map<String, Object>) listAcls(params);
            List<Map<String, Object>> existing = (List<Map<String, Object>>) listed.get("acls");
            for (Map<String, Object> acl : existing) {
                deleted += deleteAclEntry(admin, brokerAddr, acl);
            }
        } else {
            for (JsonElement element : filtersArray) {
                deleted += deleteAclEntry(admin, brokerAddr, jsonToMap(element.getAsJsonObject()));
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", true);
        result.put("deleted", deleted);
        return result;
    }

    private static Object describeCluster(JsonObject params) throws Exception {
        DefaultMQAdminExt admin = requireAdmin();
        ClusterInfo clusterInfo = admin.examineBrokerClusterInfo();
        String clusterName = clusterName(params, admin);
        List<Map<String, Object>> brokers = brokerNodes(clusterInfo);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("clusterId", clusterName);
        result.put("controller", brokers.isEmpty() ? null : brokers.get(0));
        result.put("brokers", brokers);
        result.put("nodeCount", brokers.size());
        return result;
    }

    static DefaultMQAdminExt buildAdminClient(JsonObject conn) throws Exception {
        long timeoutMs = intOrDefault(conn, "request_timeout_ms", DEFAULT_REQUEST_TIMEOUT_MS);
        RPCHook rpcHook = buildRpcHook(conn);
        DefaultMQAdminExt admin = rpcHook != null
            ? new DefaultMQAdminExt(rpcHook, timeoutMs)
            : new DefaultMQAdminExt();
        admin.setNamesrvAddr(namesrvAddr(conn));
        admin.setAdminExtGroup("_DBX_ROCKETMQ_ADMIN_" + UUID.randomUUID());
        admin.setInstanceName("DBX_" + UUID.randomUUID());
        admin.start();
        return admin;
    }

    static DefaultMQProducer buildProducer(JsonObject conn) throws Exception {
        RPCHook rpcHook = buildRpcHook(conn);
        DefaultMQProducer nextProducer = rpcHook != null
            ? new DefaultMQProducer("_DBX_ROCKETMQ_PRODUCER", rpcHook)
            : new DefaultMQProducer("_DBX_ROCKETMQ_PRODUCER");
        nextProducer.setNamesrvAddr(namesrvAddr(conn));
        nextProducer.setInstanceName("DBX_" + UUID.randomUUID());
        nextProducer.start();
        return nextProducer;
    }

    static DefaultLitePullConsumer buildLitePullConsumer(JsonObject conn) throws Exception {
        RPCHook rpcHook = buildRpcHook(conn);
        DefaultLitePullConsumer consumer = rpcHook != null
            ? new DefaultLitePullConsumer(rpcHook)
            : new DefaultLitePullConsumer();
        consumer.setNamesrvAddr(namesrvAddr(conn));
        consumer.setConsumerGroup("_DBX_PEEK_" + UUID.randomUUID());
        consumer.setInstanceName("DBX_" + UUID.randomUUID());
        consumer.setAutoCommit(false);
        return consumer;
    }

    static DefaultMQPullConsumer buildPullConsumer(JsonObject conn) throws Exception {
        RPCHook rpcHook = buildRpcHook(conn);
        DefaultMQPullConsumer consumer = rpcHook != null
            ? new DefaultMQPullConsumer(MixAll.TOOLS_CONSUMER_GROUP, rpcHook)
            : new DefaultMQPullConsumer(MixAll.TOOLS_CONSUMER_GROUP);
        consumer.setNamesrvAddr(namesrvAddr(conn));
        consumer.setInstanceName("DBX_" + UUID.randomUUID());
        return consumer;
    }

    static RPCHook buildRpcHook(JsonObject conn) {
        String accessKey = credential(conn, "access_key", "accessKey");
        String secretKey = credential(conn, "secret_key", "secretKey");
        if (accessKey.isBlank() && secretKey.isBlank()) {
            return null;
        }
        return new AclClientRPCHook(new SessionCredentials(accessKey, secretKey));
    }

    static String namesrvAddr(JsonObject conn) {
        String addr = stringOrEmpty(conn, "namesrv_addr");
        if (addr.isBlank()) {
            addr = stringOrEmpty(conn, "namesrvAddr");
        }
        if (addr.isBlank()) {
            throw new IllegalArgumentException("namesrv_addr is required");
        }
        return addr;
    }

    private static TopicList fetchTopicList(DefaultMQAdminExt admin, JsonObject conn) throws Exception {
        String cluster = clusterName(conn, admin);
        if (!cluster.isBlank()) {
            return admin.fetchTopicsByCLuster(cluster);
        }
        return admin.fetchAllTopicList();
    }

    private static Set<String> collectAllConsumerGroups(DefaultMQAdminExt admin, JsonObject conn) throws Exception {
        Set<String> groups = new TreeSet<>();
        for (String brokerAddr : resolveMasterBrokerAddrs(admin, conn)) {
            try {
                SubscriptionGroupWrapper wrapper = admin.getAllSubscriptionGroup(brokerAddr, DEFAULT_REQUEST_TIMEOUT_MS);
                if (wrapper != null && wrapper.getSubscriptionGroupTable() != null) {
                    groups.addAll(wrapper.getSubscriptionGroupTable().keySet());
                }
            } catch (Exception ignored) {
                // Try next broker when Docker/internal broker addresses are unreachable.
            }
        }
        return groups;
    }

    private static TopicConfig loadTopicConfig(DefaultMQAdminExt admin, String brokerAddr, String topic)
        throws Exception {
        TopicConfig config = admin.examineTopicConfig(brokerAddr, topic);
        if (config == null) {
            config = new TopicConfig(topic);
        }
        return config;
    }

    static TopicConfig buildTopicConfigForCreate(String topicName, int partitions, String messageType) {
        return buildTopicConfigForCreate(topicName, partitions, partitions, messageType, 6);
    }

    static TopicConfig buildTopicConfigForCreate(
        String topicName, int readQueueNums, int writeQueueNums, String messageType, int perm) {
        TopicConfig config = new TopicConfig(topicName);
        config.setReadQueueNums(Math.max(readQueueNums, 1));
        config.setWriteQueueNums(Math.max(writeQueueNums, 1));
        config.setPerm(normalizeTopicPerm(perm));
        Map<String, String> attributes = new HashMap<>();
        attributes.put("+" + TOPIC_MESSAGE_TYPE_ATTRIBUTE, messageType);
        config.setAttributes(attributes);
        return config;
    }

    static int normalizeTopicPerm(int perm) {
        return switch (perm) {
            case 2, 4, 6 -> perm;
            default -> 6;
        };
    }

    private static List<String> resolveMasterBrokerAddrs(DefaultMQAdminExt admin, JsonObject conn) throws Exception {
        return resolveMasterBrokerAddrs(admin, conn, null);
    }

    static List<String> resolveMasterBrokerAddrs(
        DefaultMQAdminExt admin, JsonObject conn, String brokerNameFilter) throws Exception {
        ClusterInfo clusterInfo = admin.examineBrokerClusterInfo();
        LinkedHashSet<String> addrs = new LinkedHashSet<>();
        if (clusterInfo.getBrokerAddrTable() != null) {
            for (BrokerData broker : clusterInfo.getBrokerAddrTable().values()) {
                if (brokerNameFilter != null && !brokerNameFilter.isBlank()
                    && !brokerNameFilter.equals(broker.getBrokerName())) {
                    continue;
                }
                String masterAddr = null;
                if (broker.getBrokerAddrs() != null && broker.getBrokerAddrs().containsKey(0L)) {
                    masterAddr = broker.getBrokerAddrs().get(0L);
                }
                if (masterAddr == null || masterAddr.isBlank()) {
                    masterAddr = broker.selectBrokerAddr();
                }
                if (masterAddr != null && !masterAddr.isBlank()) {
                    addrs.add(remapBrokerAddrForClient(masterAddr, conn));
                }
            }
        }
        if (addrs.isEmpty()) {
            addrs.add(resolveBrokerAddr(admin, conn));
        }
        return new ArrayList<>(addrs);
    }

    private static void applyTopicConfigValue(TopicConfig config, String key, String value) {
        if (value == null) {
            return;
        }
        switch (key) {
            case "readQueueNums" -> config.setReadQueueNums(Integer.parseInt(value));
            case "writeQueueNums" -> config.setWriteQueueNums(Integer.parseInt(value));
            case "perm" -> config.setPerm(Integer.parseInt(value));
            default -> {
            }
        }
    }

    private static List<MessageQueue> resolvePeekQueues(DefaultMQAdminExt admin, String topic, Integer partition)
        throws Exception {
        TopicRouteData route = admin.examineTopicRouteInfo(topic);
        if (route.getQueueDatas() == null || route.getQueueDatas().isEmpty()) {
            return Collections.emptyList();
        }
        String brokerName = route.getQueueDatas().get(0).getBrokerName();
        if (partition != null) {
            return List.of(new MessageQueue(topic, brokerName, partition));
        }
        int queueCount = Math.max(route.getQueueDatas().get(0).getReadQueueNums(), 1);
        List<MessageQueue> queues = new ArrayList<>();
        for (int queueId = 0; queueId < queueCount; queueId++) {
            queues.add(new MessageQueue(topic, brokerName, queueId));
        }
        return queues;
    }

    private static Map<String, Object> peekedMessageFromRecord(String topic, MessageExt message) {
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("topic", topic);
        msg.put("messageId", message.getMsgId());
        msg.put("partition", message.getQueueId());
        msg.put("offset", message.getQueueOffset());
        msg.put("timestamp", message.getStoreTimestamp());
        msg.put("key", message.getKeys());
        msg.put("tag", message.getTags());
        Map<String, String> headers = new LinkedHashMap<>();
        if (message.getProperties() != null) {
            headers.putAll(message.getProperties());
        }
        msg.put("headers", headers);
        if (message.getBody() != null) {
            msg.put("payloadBase64", Base64.getEncoder().encodeToString(message.getBody()));
            String text = tryDecodeUtf8(message.getBody());
            if (text != null) {
                msg.put("payloadText", text);
            }
        } else {
            msg.put("payloadBase64", "");
        }
        return msg;
    }

    static void sortPeekedMessages(List<Map<String, Object>> messages) {
        messages.sort((left, right) -> {
            long leftTs = ((Number) left.getOrDefault("timestamp", 0L)).longValue();
            long rightTs = ((Number) right.getOrDefault("timestamp", 0L)).longValue();
            int byTs = Long.compare(leftTs, rightTs);
            if (byTs != 0) {
                return byTs;
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
        });
    }

    private static Map<String, Object> producerRow(long producerId, String producerGroup, Connection conn) {
        Map<String, Object> producer = new LinkedHashMap<>();
        producer.put("producerId", producerId);
        producer.put("producerName", producerGroup);
        producer.put("msgRateIn", 0.0);
        producer.put("msgThroughputIn", 0.0);
        producer.put("clientVersion", String.valueOf(conn.getVersion()));
        producer.put("address", conn.getClientAddr());
        producer.put("lastTimestamp", 0L);
        return producer;
    }

    private static Map<String, Object> producerRow(long producerId, String producerGroup, ProducerInfo info) {
        Map<String, Object> producer = new LinkedHashMap<>();
        producer.put("producerId", producerId);
        producer.put("producerName", producerGroup);
        producer.put("msgRateIn", 0.0);
        producer.put("msgThroughputIn", 0.0);
        producer.put("clientVersion", String.valueOf(info.getVersion()));
        producer.put("address", info.getRemoteIP());
        producer.put("lastTimestamp", info.getLastUpdateTimestamp());
        return producer;
    }

    private static List<Map<String, Object>> flattenAclInfo(AclInfo aclInfo) {
        List<Map<String, Object>> rows = new ArrayList<>();
        if (aclInfo.getPolicies() == null) {
            return rows;
        }
        for (AclInfo.PolicyInfo policy : aclInfo.getPolicies()) {
            if (policy.getEntries() == null) {
                continue;
            }
            for (AclInfo.PolicyEntryInfo entry : policy.getEntries()) {
                List<String> actions = entry.getActions() == null ? List.of("ALL") : entry.getActions();
                for (String action : actions) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("resourceType", "TOPIC");
                    row.put("resourceName", entry.getResource());
                    row.put("patternType", "LITERAL");
                    row.put("principal", aclInfo.getSubject());
                    row.put("host", entry.getSourceIps() == null || entry.getSourceIps().isEmpty()
                        ? "*" : String.join(",", entry.getSourceIps()));
                    row.put("operation", action);
                    row.put("permissionType", entry.getDecision());
                    rows.add(row);
                }
            }
        }
        return rows;
    }

    private static PlainAccessConfig plainAccessConfigFromJson(JsonObject acl) {
        PlainAccessConfig config = new PlainAccessConfig();
        config.setAccessKey(stringOrEmpty(acl, "accessKey"));
        config.setSecretKey(stringOrEmpty(acl, "secretKey"));
        config.setAdmin(boolOrDefault(acl, "admin", false));
        config.setWhiteRemoteAddress(stringOrDefault(acl, "whiteRemoteAddress", "*"));
        config.setDefaultTopicPerm(stringOrDefault(acl, "defaultTopicPerm", "DENY"));
        config.setDefaultGroupPerm(stringOrDefault(acl, "defaultGroupPerm", "DENY"));
        if (acl.has("topicPerms") && acl.get("topicPerms").isJsonArray()) {
            List<String> topicPerms = new ArrayList<>();
            for (JsonElement element : acl.getAsJsonArray("topicPerms")) {
                topicPerms.add(element.getAsString());
            }
            config.setTopicPerms(topicPerms);
        }
        if (acl.has("groupPerms") && acl.get("groupPerms").isJsonArray()) {
            List<String> groupPerms = new ArrayList<>();
            for (JsonElement element : acl.getAsJsonArray("groupPerms")) {
                groupPerms.add(element.getAsString());
            }
            config.setGroupPerms(groupPerms);
        }
        return config;
    }

    private static int deleteAclEntry(DefaultMQAdminExt admin, String brokerAddr, Map<String, Object> acl) throws Exception {
        String accessKey = stringValue(acl.get("accessKey"));
        if (accessKey == null) {
            accessKey = stringValue(acl.get("principal"));
        }
        if (accessKey != null && !accessKey.isBlank()) {
            admin.deletePlainAccessConfig(brokerAddr, accessKey);
            return 1;
        }
        String subject = stringValue(acl.get("principal"));
        String resource = stringValue(acl.get("resourceName"));
        if (subject != null && resource != null) {
            admin.deleteAcl(brokerAddr, subject, resource);
            return 1;
        }
        return 0;
    }

    private static String mapOperation(String operation) {
        return switch (operation.toUpperCase(Locale.ROOT)) {
            case "WRITE", "PRODUCE" -> "PUB";
            case "READ", "CONSUME" -> "SUB";
            default -> "ALL";
        };
    }

    private static boolean probeAclSupport(DefaultMQAdminExt admin) {
        try {
            ClusterInfo clusterInfo = admin.examineBrokerClusterInfo();
            for (BrokerData broker : clusterInfo.getBrokerAddrTable().values()) {
                String brokerAddr = broker.selectBrokerAddr();
                if (brokerAddr == null || brokerAddr.isBlank()) {
                    continue;
                }
                admin.examineBrokerClusterAclVersionInfo(brokerAddr);
                return true;
            }
        } catch (Exception ignored) {
            // ACL not enabled or broker does not expose ACL metadata.
        }
        return false;
    }

    private static String resolveClusterName(DefaultMQAdminExt admin, JsonObject conn) throws Exception {
        String configured = clusterName(conn);
        if (!configured.isBlank()) {
            return configured;
        }
        return resolveClusterName(admin.examineBrokerClusterInfo(), conn);
    }

    private static String resolveClusterName(ClusterInfo clusterInfo, JsonObject conn) {
        String configured = clusterName(conn);
        if (!configured.isBlank()) {
            return configured;
        }
        if (clusterInfo.getClusterAddrTable() != null && !clusterInfo.getClusterAddrTable().isEmpty()) {
            return clusterInfo.getClusterAddrTable().keySet().iterator().next();
        }
        return "DefaultCluster";
    }

    private static String resolveBrokerAddr(DefaultMQAdminExt admin, JsonObject conn) throws Exception {
        String explicit = brokerAddress(conn);
        if (!explicit.isBlank()) {
            return explicit;
        }
        ClusterInfo clusterInfo = admin.examineBrokerClusterInfo();
        for (BrokerData broker : clusterInfo.getBrokerAddrTable().values()) {
            String addr = broker.selectBrokerAddr();
            if (addr != null && !addr.isBlank()) {
                return remapBrokerAddrForClient(addr, conn);
            }
        }
        throw new IllegalStateException("No RocketMQ broker address found");
    }

    private static String clusterName(JsonObject params, DefaultMQAdminExt admin) throws Exception {
        String configured = clusterName(params);
        if (!configured.isBlank()) {
            return configured;
        }
        if (cachedClusterName != null && !cachedClusterName.isBlank()) {
            return cachedClusterName;
        }
        return resolveClusterName(admin, params);
    }

    private static String clusterName(JsonObject conn) {
        String cluster = stringOrEmpty(conn, "cluster_name");
        if (cluster.isBlank()) {
            cluster = stringOrEmpty(conn, "clusterName");
        }
        return cluster;
    }

    private static String brokerAddr(JsonObject params, DefaultMQAdminExt admin) throws Exception {
        return brokerAddr(params, admin, connectionObject(params));
    }

    private static String brokerAddr(JsonObject params, DefaultMQAdminExt admin, JsonObject conn) throws Exception {
        String brokerName = stringOrEmpty(params, "brokerName");
        if (!brokerName.isBlank()) {
            List<String> addrs = resolveMasterBrokerAddrs(admin, conn, brokerName);
            if (!addrs.isEmpty()) {
                return addrs.get(0);
            }
        }
        String explicit = brokerAddress(conn);
        if (!explicit.isBlank()) {
            return explicit;
        }
        if (cachedBrokerAddr != null && !cachedBrokerAddr.isBlank()) {
            return cachedBrokerAddr;
        }
        return resolveBrokerAddr(admin, conn);
    }

    private static String brokerAddress(JsonObject conn) {
        String broker = stringOrEmpty(conn, "broker_addr");
        if (broker.isBlank()) {
            broker = stringOrEmpty(conn, "brokerAddr");
        }
        return broker;
    }

    /**
     * RocketMQ brokers often register docker/internal IPs with NameServer. Remap to the
     * namesrv host with the same broker port so host-side agents can reach published ports.
     */
    static String remapBrokerAddrForClient(String brokerAddr, JsonObject conn) {
        if (brokerAddr == null || brokerAddr.isBlank()) {
            return brokerAddr;
        }
        String explicit = brokerAddress(conn);
        if (!explicit.isBlank()) {
            return explicit;
        }
        String brokerHost = parseHostFromSocketAddress(brokerAddr);
        String brokerPort = parsePortFromSocketAddress(brokerAddr);
        if (brokerPort.isBlank()) {
            return brokerAddr;
        }
        if (!isLikelyUnreachableBrokerHost(brokerHost)) {
            return brokerAddr;
        }
        String namesrvHost = primaryNamesrvHost(conn);
        return formatSocketAddress(namesrvHost, brokerPort);
    }

    /**
     * Copy non-system UI headers onto the message as user properties so SQL92 filters work.
     * TAGS/KEYS are applied via tag/keys APIs and must not be duplicated here.
     */
    static void applySendHeaders(Message message, JsonObject params) {
        if (!params.has("headers") || !params.get("headers").isJsonObject()) {
            return;
        }
        JsonObject headers = params.getAsJsonObject("headers");
        for (Map.Entry<String, JsonElement> entry : headers.entrySet()) {
            String key = entry.getKey();
            if (key == null || key.isBlank() || entry.getValue() == null || entry.getValue().isJsonNull()) {
                continue;
            }
            if (MessageConst.PROPERTY_TAGS.equals(key) || MessageConst.PROPERTY_KEYS.equals(key)) {
                continue;
            }
            if (isRocketMqSystemMessageProperty(key)) {
                continue;
            }
            String value = entry.getValue().getAsString();
            if (value.isBlank()) {
                continue;
            }
            message.putUserProperty(key, value);
        }
    }

    private static boolean isRocketMqSystemMessageProperty(String key) {
        return MessageConst.STRING_HASH_SET.contains(key);
    }

    /** Host part of a single {@code host:port} or {@code [ipv6]:port} socket address. */
    static String parseHostFromSocketAddress(String hostPort) {
        if (hostPort == null) {
            return "";
        }
        String trimmed = hostPort.trim();
        if (trimmed.isEmpty()) {
            return "";
        }
        if (trimmed.startsWith("[")) {
            int close = trimmed.indexOf(']');
            if (close > 0) {
                return trimmed.substring(1, close);
            }
        }
        int colon = trimmed.lastIndexOf(':');
        if (colon <= 0) {
            return trimmed;
        }
        String portPart = trimmed.substring(colon + 1);
        if (isNumericPort(portPart)) {
            return trimmed.substring(0, colon);
        }
        return trimmed;
    }

    static String parsePortFromSocketAddress(String hostPort) {
        if (hostPort == null) {
            return "";
        }
        String trimmed = hostPort.trim();
        if (trimmed.isEmpty()) {
            return "";
        }
        if (trimmed.startsWith("[")) {
            int close = trimmed.indexOf(']');
            if (close > 0 && close + 1 < trimmed.length() && trimmed.charAt(close + 1) == ':') {
                return trimmed.substring(close + 2);
            }
            return "";
        }
        int colon = trimmed.lastIndexOf(':');
        if (colon <= 0 || colon >= trimmed.length() - 1) {
            return "";
        }
        return trimmed.substring(colon + 1);
    }

    static String formatSocketAddress(String host, String port) {
        if (host == null || host.isBlank()) {
            return port == null ? "" : port;
        }
        if (port == null || port.isBlank()) {
            return host;
        }
        if (host.indexOf(':') >= 0) {
            return "[" + host + "]:" + port;
        }
        return host + ":" + port;
    }

    /**
     * First reachable NameServer host for Docker broker remap. When auto-remap is wrong,
     * set {@code broker_addr} / {@code brokerAddr} on the connection explicitly.
     */
    static String primaryNamesrvHost(JsonObject conn) {
        for (String entry : resolveNameServerAddrSet(conn)) {
            String host = parseHostFromSocketAddress(entry);
            if (!host.isBlank()) {
                return host;
            }
        }
        return "127.0.0.1";
    }

    private static boolean isNumericPort(String portPart) {
        if (portPart == null || portPart.isEmpty()) {
            return false;
        }
        for (int i = 0; i < portPart.length(); i++) {
            if (!Character.isDigit(portPart.charAt(i))) {
                return false;
            }
        }
        return true;
    }

    private static boolean isLikelyUnreachableBrokerHost(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        if ("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host) || "::1".equals(host)) {
            return false;
        }
        return host.startsWith("172.")
            || host.startsWith("10.")
            || host.startsWith("192.168.")
            || host.endsWith(".docker")
            || host.contains(".docker.");
    }

    private static List<Map<String, Object>> brokerNodes(ClusterInfo clusterInfo) {
        List<Map<String, Object>> brokers = new ArrayList<>();
        int id = 0;
        for (BrokerData broker : clusterInfo.getBrokerAddrTable().values()) {
            String brokerName = broker.getBrokerName();
            if (broker.getBrokerAddrs() != null && !broker.getBrokerAddrs().isEmpty()) {
                for (Map.Entry<Long, String> entry : broker.getBrokerAddrs().entrySet()) {
                    brokers.add(brokerNode(id++, brokerName, entry.getKey(), entry.getValue()));
                }
                continue;
            }
            String addr = broker.selectBrokerAddr();
            if (addr == null || addr.isBlank()) {
                continue;
            }
            brokers.add(brokerNode(id++, brokerName, 0L, addr));
        }
        return brokers;
    }

    private static Map<String, Object> brokerNode(int id, String brokerName, long brokerId, String addr) {
        String host = parseHostFromSocketAddress(addr);
        String portText = parsePortFromSocketAddress(addr);
        int port = portText.isBlank() ? 0 : Integer.parseInt(portText);
        Map<String, Object> node = new LinkedHashMap<>();
        node.put("id", id);
        node.put("host", host);
        node.put("port", port);
        node.put("rack", null);
        node.put("brokerName", brokerName);
        node.put("brokerId", brokerId);
        node.put("role", brokerId == 0L ? "MASTER" : "SLAVE");
        return node;
    }

    private static Set<String> collectBrokerNames(DefaultMQAdminExt admin) {
        Set<String> names = new HashSet<>();
        try {
            ClusterInfo clusterInfo = admin.examineBrokerClusterInfo();
            if (clusterInfo.getBrokerAddrTable() != null) {
                for (BrokerData brokerData : clusterInfo.getBrokerAddrTable().values()) {
                    if (brokerData.getBrokerName() != null && !brokerData.getBrokerName().isBlank()) {
                        names.add(brokerData.getBrokerName());
                    }
                }
            }
        } catch (Exception ignored) {
            // Fall back to static reserved-topic filtering only.
        }
        return names;
    }

    private static Set<String> collectBrokerSystemTopics(DefaultMQAdminExt admin) {
        // DefaultMQAdminExt 5.3.x does not expose getSystemTopicListFromBroker; reserved-name rules cover most cases.
        return Set.of();
    }

    static Set<String> resolveNameServerAddrSet(JsonObject conn) {
        Set<String> addrs = new LinkedHashSet<>();
        for (String part : namesrvAddr(conn).split(";")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) {
                addrs.add(trimmed);
            }
        }
        return addrs;
    }

    private static Map<String, TopicConfig> collectBrokerTopicConfigs(DefaultMQAdminExt admin, JsonObject conn) {
        Map<String, TopicConfig> merged = new LinkedHashMap<>();
        try {
            for (String brokerAddr : resolveMasterBrokerAddrs(admin, conn)) {
                try {
                    TopicConfigSerializeWrapper wrapper =
                        admin.getAllTopicConfig(brokerAddr, DEFAULT_REQUEST_TIMEOUT_MS);
                    if (wrapper == null || wrapper.getTopicConfigTable() == null) {
                        continue;
                    }
                    for (TopicConfig config : wrapper.getTopicConfigTable().values()) {
                        if (config.getTopicName() == null || config.getTopicName().isBlank()) {
                            continue;
                        }
                        merged.merge(config.getTopicName(), config, RocketMqAgent::preferTopicConfig);
                    }
                } catch (Exception ignored) {
                    // Some brokers may reject bulk config reads.
                }
            }
        } catch (Exception ignored) {
            // Fall back to nameserver topic list in listTopics.
        }
        return merged;
    }

    private static TopicConfig preferTopicConfig(TopicConfig left, TopicConfig right) {
        String leftType = readTopicMessageType(left);
        String rightType = readTopicMessageType(right);
        if ((leftType == null || leftType.isBlank()) && rightType != null && !rightType.isBlank()) {
            return right;
        }
        if (right.getReadQueueNums() > left.getReadQueueNums()) {
            return right;
        }
        return left;
    }

    private static Map<String, Map<String, String>> topicAttributesFromConfigs(Map<String, TopicConfig> brokerTopics) {
        Map<String, Map<String, String>> topicAttributes = new HashMap<>();
        Map<String, String> topicMessageTypes = new HashMap<>();
        for (TopicConfig config : brokerTopics.values()) {
            mergeTopicAttributes(topicAttributes, topicMessageTypes, config);
        }
        for (Map.Entry<String, String> entry : topicMessageTypes.entrySet()) {
            Map<String, String> attrs = topicAttributes.computeIfAbsent(entry.getKey(), ignored -> new HashMap<>());
            attrs.putIfAbsent("+" + TOPIC_MESSAGE_TYPE_ATTRIBUTE, entry.getValue());
            attrs.putIfAbsent(TOPIC_MESSAGE_TYPE_ATTRIBUTE, entry.getValue());
        }
        return topicAttributes;
    }

    private static Map<String, Map<String, String>> collectTopicAttributes(DefaultMQAdminExt admin, JsonObject conn) {
        return topicAttributesFromConfigs(collectBrokerTopicConfigs(admin, conn));
    }

    private static void mergeTopicAttributes(
        Map<String, Map<String, String>> topicAttributes,
        Map<String, String> topicMessageTypes,
        TopicConfig config
    ) {
        String topicName = config.getTopicName();
        if (topicName == null || topicName.isBlank()) {
            return;
        }
        String messageType = readTopicMessageType(config);
        if (messageType != null && !messageType.isBlank()) {
            topicMessageTypes.putIfAbsent(topicName, messageType);
        }
        Map<String, String> attrs = config.getAttributes();
        Map<String, String> existing = topicAttributes.get(topicName);
        if (existing == null) {
            topicAttributes.put(topicName, attrs == null ? new HashMap<>() : new HashMap<>(attrs));
            return;
        }
        if (readTopicMessageTypeAttribute(existing) == null && attrs != null && !attrs.isEmpty()) {
            existing.putAll(attrs);
        }
    }

    private static String resolveTopicMessageType(DefaultMQAdminExt admin, JsonObject conn, String topic) {
        try {
            TopicRouteData route = admin.examineTopicRouteInfo(topic);
            if (route.getQueueDatas() == null || route.getQueueDatas().isEmpty()) {
                return null;
            }
            String brokerName = route.getQueueDatas().get(0).getBrokerName();
            ClusterInfo clusterInfo = admin.examineBrokerClusterInfo();
            BrokerData brokerData = clusterInfo.getBrokerAddrTable().get(brokerName);
            if (brokerData == null) {
                return null;
            }
            String brokerAddr = remapBrokerAddrForClient(brokerData.selectBrokerAddr(), conn);
            if (brokerAddr == null || brokerAddr.isBlank()) {
                return null;
            }
            TopicConfig config = admin.examineTopicConfig(brokerAddr, topic);
            return readTopicMessageType(config);
        } catch (Exception ignored) {
            return null;
        }
    }

    static <T> List<T> paginate(List<T> items, int offset, int limit) {
        if (offset >= items.size()) {
            return Collections.emptyList();
        }
        int end = Math.min(items.size(), offset + limit);
        return new ArrayList<>(items.subList(offset, end));
    }

    private static DefaultMQAdminExt requireAdmin() {
        if (adminClient == null) {
            throw new IllegalStateException("Not connected. Call connect first.");
        }
        return adminClient;
    }

    private static DefaultMQProducer requireProducer() {
        if (producer == null) {
            throw new IllegalStateException("Producer is not initialized. Call connect first.");
        }
        return producer;
    }

    private static JsonObject connectionObject(JsonObject params) {
        if (params.has("connection") && params.get("connection").isJsonObject()) {
            return params.getAsJsonObject("connection");
        }
        if (cachedConnection != null) {
            return cachedConnection;
        }
        return params;
    }

    private static String credential(JsonObject conn, String snakeCase, String camelCase) {
        String value = stringOrEmpty(conn, snakeCase);
        if (value.isBlank()) {
            value = stringOrEmpty(conn, camelCase);
        }
        return value;
    }

    private static byte[] decodePayload(JsonObject params) {
        String payloadBase64 = stringOrEmpty(params, "payloadBase64");
        if (!payloadBase64.isBlank()) {
            return Base64.getDecoder().decode(payloadBase64);
        }
        String text = stringOrEmpty(params, "payloadText");
        if (!text.isBlank()) {
            return text.getBytes(StandardCharsets.UTF_8);
        }
        return new byte[0];
    }

    private static void putConfigEntry(Map<String, Object> configs, String key, String value) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("value", value);
        entry.put("source", "USER");
        entry.put("isSensitive", false);
        entry.put("isReadOnly", false);
        entry.put("isDefault", false);
        configs.put(key, entry);
    }

    private static Map<String, Object> jsonToMap(JsonObject object) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : object.entrySet()) {
            if (entry.getValue().isJsonNull()) {
                map.put(entry.getKey(), null);
            } else if (entry.getValue().isJsonPrimitive()) {
                map.put(entry.getKey(), entry.getValue().getAsString());
            }
        }
        return map;
    }

    private static String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static String tryDecodeUtf8(byte[] bytes) {
        try {
            String text = new String(bytes, StandardCharsets.UTF_8);
            byte[] reEncoded = text.getBytes(StandardCharsets.UTF_8);
            if (Arrays.equals(bytes, reEncoded)) {
                return text;
            }
        } catch (Exception ignored) {
            // Not valid UTF-8 text.
        }
        return null;
    }

    private static String normalizeErrorMessage(Exception e) {
        String message = e.getMessage() == null || e.getMessage().isBlank()
            ? e.getClass().getName()
            : e.getMessage();
        Throwable root = rootCause(e);
        if (root != e && root.getMessage() != null && !root.getMessage().isBlank()
            && !message.contains(root.getMessage())) {
            message = message + ": " + root.getMessage();
        }
        return message;
    }

    private static Throwable rootCause(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        return current;
    }

    static String stringOrEmpty(JsonObject object, String key) {
        return stringOrDefault(object, key, "");
    }

    private static String stringOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? null : element.getAsString();
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

    static int intOrDefault(JsonObject object, String key, int fallback) {
        Integer value = integerOrNull(object, key);
        return value == null ? fallback : value;
    }

    static long longOrDefault(JsonObject object, String key, long fallback) {
        Long value = longOrNull(object, key);
        return value == null ? fallback : value;
    }

    private static boolean boolOrDefault(JsonObject object, String key, boolean fallback) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? fallback : element.getAsBoolean();
    }

    private static String requireString(JsonObject object, String key) {
        String value = stringOrEmpty(object, key);
        if (value.isBlank()) {
            throw new IllegalArgumentException(key + " is required");
        }
        return value;
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
