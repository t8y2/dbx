package com.dbx.agent.rocketmq;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.apache.rocketmq.client.exception.MQClientException;
import org.apache.rocketmq.common.TopicConfig;
import org.apache.rocketmq.common.MixAll;
import org.apache.rocketmq.common.message.Message;
import org.apache.rocketmq.remoting.protocol.subscription.SubscriptionGroupConfig;
import org.apache.rocketmq.remoting.protocol.admin.TopicStatsTable;
import org.apache.rocketmq.remoting.protocol.admin.TopicOffset;
import org.apache.rocketmq.remoting.protocol.body.ProducerInfo;
import org.apache.rocketmq.remoting.protocol.body.ProducerTableInfo;
import org.apache.rocketmq.remoting.protocol.body.TopicConfigSerializeWrapper;
import org.apache.rocketmq.remoting.protocol.body.ConsumerConnection;
import org.apache.rocketmq.remoting.protocol.route.QueueData;
import org.apache.rocketmq.remoting.protocol.route.TopicRouteData;
import org.apache.rocketmq.common.message.MessageQueue;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

class RocketMqAgentTest {
    @Test
    void namesrvAddrAcceptsSnakeCaseField() {
        assertEquals(
            "127.0.0.1:9876",
            RocketMqAgent.namesrvAddr(JsonParser.parseString("""
                {"namesrv_addr":"127.0.0.1:9876"}
                """).getAsJsonObject())
        );
    }

    @Test
    void namesrvAddrAcceptsCamelCaseField() {
        assertEquals(
            "127.0.0.1:9876",
            RocketMqAgent.namesrvAddr(JsonParser.parseString("""
                {"namesrvAddr":"127.0.0.1:9876"}
                """).getAsJsonObject())
        );
    }

    @Test
    void namesrvAddrRequiresValue() {
        assertThrows(
            IllegalArgumentException.class,
            () -> RocketMqAgent.namesrvAddr(JsonParser.parseString("{}").getAsJsonObject())
        );
    }

    @Test
    void isUserTopicFiltersRocketMqSystemTopics() {
        assertEquals(false, RocketMqAgent.isUserTopic("RMQ_SYS_TRANS_HALF_TOPIC"));
        assertEquals(false, RocketMqAgent.isUserTopic("BenchmarkTest"));
        assertEquals(false, RocketMqAgent.isUserTopic("SCHEDULE_TOPIC_XXXX"));
        assertEquals(false, RocketMqAgent.isUserTopic("DefaultCluster_REPLY_TOPIC"));
        assertEquals(false, RocketMqAgent.isUserTopic("%RETRY%MyGroup"));
        assertEquals(true, RocketMqAgent.isUserTopic("CS123"));
        assertEquals(true, RocketMqAgent.isUserTopic("OrderCreated"));
    }

    @Test
    void classifyTopicMessageTypeMatchesDashboardRules() {
        assertEquals("RETRY", RocketMqAgent.classifyTopicMessageType(
            "%RETRY%MyGroup", null, Set.of(), Set.of(), ""));
        assertEquals("DLQ", RocketMqAgent.classifyTopicMessageType(
            "%DLQ%MyGroup", null, Set.of(), Set.of(), ""));
        assertEquals("SYSTEM", RocketMqAgent.classifyTopicMessageType(
            "RMQ_SYS_TRANS_HALF_TOPIC", null, Set.of(), Set.of(), ""));
        assertEquals("UNSPECIFIED", RocketMqAgent.classifyTopicMessageType(
            "CS123", null, Set.of(), Set.of(), ""));
        assertEquals("UNSPECIFIED", RocketMqAgent.classifyTopicMessageType(
            "CS123", Map.of(), Set.of(), Set.of(), ""));
        assertEquals("NORMAL", RocketMqAgent.classifyTopicMessageType(
            "CS123",
            Map.of("+message.type", "NORMAL"),
            Set.of(),
            Set.of(),
            ""));
        assertEquals("NORMAL", RocketMqAgent.classifyTopicMessageType(
            "OrderCreated",
            Map.of("message.type", "NORMAL"),
            Set.of(),
            Set.of(),
            ""));
        assertEquals("DELAY", RocketMqAgent.classifyTopicMessageType(
            "DelayTopic",
            Map.of("message.type", "DELAY"),
            Set.of(),
            Set.of(),
            ""));
        assertEquals("UNSPECIFIED", RocketMqAgent.classifyTopicMessageType(
            "LegacyTopic",
            Map.of("message.type", "UNSPECIFIED"),
            Set.of(),
            Set.of(),
            ""));
        assertEquals("FIFO", RocketMqAgent.classifyTopicMessageType(
            "OrderedTopic",
            Map.of("message.type", "ORDER"),
            Set.of(),
            Set.of(),
            ""));
    }

    @Test
    void remapBrokerAddrUsesNamesrvHostForDockerBrokerIp() {
        JsonObject conn = JsonParser.parseString("""
            {"namesrv_addr":"127.0.0.1:9876"}
            """).getAsJsonObject();
        assertEquals("127.0.0.1:10911", RocketMqAgent.remapBrokerAddrForClient("172.18.0.3:10911", conn));
        assertEquals("127.0.0.1:10911", RocketMqAgent.remapBrokerAddrForClient("10.0.0.5:10911", conn));
        assertEquals("broker.example.com:10911", RocketMqAgent.remapBrokerAddrForClient("broker.example.com:10911", conn));
    }

    @Test
    void remapBrokerAddrUsesFirstNamesrvHostWhenMultipleConfigured() {
        JsonObject conn = JsonParser.parseString("""
            {"namesrv_addr":"ns1:9876;ns2:9876"}
            """).getAsJsonObject();
        assertEquals("ns1:10911", RocketMqAgent.remapBrokerAddrForClient("172.18.0.3:10911", conn));
    }

    @Test
    void remapBrokerAddrSupportsIpv6NamesrvHost() {
        JsonObject conn = JsonParser.parseString("""
            {"namesrv_addr":"[2001:db8::1]:9876"}
            """).getAsJsonObject();
        assertEquals("[2001:db8::1]:10911", RocketMqAgent.remapBrokerAddrForClient("10.0.0.5:10911", conn));
        assertEquals("[::1]:10911", RocketMqAgent.remapBrokerAddrForClient("172.18.0.2:10911", JsonParser.parseString("""
            {"namesrv_addr":"[::1]:9876"}
            """).getAsJsonObject()));
    }

    @Test
    void remapBrokerAddrHonorsExplicitBrokerAddress() {
        JsonObject conn = JsonParser.parseString("""
            {"namesrv_addr":"127.0.0.1:9876","broker_addr":"published.example.com:10911"}
            """).getAsJsonObject();
        assertEquals("published.example.com:10911", RocketMqAgent.remapBrokerAddrForClient("172.18.0.3:10911", conn));
    }

    @Test
    void parseHostFromSocketAddressHandlesIpv6AndPorts() {
        assertEquals("127.0.0.1", RocketMqAgent.parseHostFromSocketAddress("127.0.0.1:9876"));
        assertEquals("2001:db8::1", RocketMqAgent.parseHostFromSocketAddress("[2001:db8::1]:9876"));
        assertEquals("::1", RocketMqAgent.parseHostFromSocketAddress("[::1]:9876"));
    }

    @Test
    void applySendHeadersSetsUserPropertiesAndSkipsSystemKeys() {
        Message message = new Message("TopicA", "tag-a", "body".getBytes());
        JsonObject params = JsonParser.parseString("""
            {"headers":{"TAGS":"tag-a","KEYS":"k1","Region":"Hangzhou","color":"blue"}}
            """).getAsJsonObject();
        RocketMqAgent.applySendHeaders(message, params);
        assertEquals("Hangzhou", message.getProperty("Region"));
        assertEquals("blue", message.getProperty("color"));
        assertEquals("tag-a", message.getTags());
        assertEquals(null, message.getProperty("KEYS"));
    }

    @Test
    void paginateReturnsSecondPageAfter200Topics() {
        List<Integer> items = IntStream.range(0, 201).boxed().toList();
        assertEquals(200, RocketMqAgent.paginate(items, 0, 200).size());
        assertEquals(1, RocketMqAgent.paginate(items, 200, 200).size());
        assertEquals(200, RocketMqAgent.paginate(items, 200, 200).get(0));
    }

    @Test
    void paginateLimitZeroReturnsAllFromOffset() {
        List<Integer> items = IntStream.range(0, 341).boxed().toList();
        assertEquals(341, RocketMqAgent.paginate(items, 0, 0).size());
        assertEquals(141, RocketMqAgent.paginate(items, 200, 0).size());
        assertEquals(200, RocketMqAgent.paginate(items, 200, 0).get(0));
    }

    @Test
    void collectBrokerNamesFromClusterInfoSnapshot() {
        org.apache.rocketmq.remoting.protocol.body.ClusterInfo clusterInfo =
            new org.apache.rocketmq.remoting.protocol.body.ClusterInfo();
        java.util.HashMap<String, org.apache.rocketmq.remoting.protocol.route.BrokerData> table =
            new java.util.HashMap<>();
        org.apache.rocketmq.remoting.protocol.route.BrokerData broker =
            new org.apache.rocketmq.remoting.protocol.route.BrokerData();
        broker.setBrokerName("broker-a");
        table.put("broker-a", broker);
        clusterInfo.setBrokerAddrTable(table);
        assertEquals(Set.of("broker-a"), RocketMqAgent.collectBrokerNames(clusterInfo));
        assertEquals(Set.of(), RocketMqAgent.collectBrokerNames(null));
    }

    @Test
    void resolveNameServerAddrSetSplitsMultiAddr() {
        JsonObject conn = JsonParser.parseString("""
            {"namesrv_addr":"127.0.0.1:9876;192.168.1.2:9876"}
            """).getAsJsonObject();
        assertEquals(
            Set.of("127.0.0.1:9876", "192.168.1.2:9876"),
            RocketMqAgent.resolveNameServerAddrSet(conn)
        );
    }

    @Test
    void buildTopicConfigForCreateSetsPartitionsAndMessageType() {
        TopicConfig config = RocketMqAgent.buildTopicConfigForCreate("OrderCreated", 8, "DELAY");
        assertEquals("OrderCreated", config.getTopicName());
        assertEquals(8, config.getReadQueueNums());
        assertEquals(8, config.getWriteQueueNums());
        assertEquals(6, config.getPerm());
        assertEquals("DELAY", config.getAttributes().get("+message.type"));
    }

    @Test
    void buildTopicConfigForCreateSupportsSeparateQueuesAndPerm() {
        TopicConfig config = RocketMqAgent.buildTopicConfigForCreate("T1", 8, 4, "NORMAL", 4);
        assertEquals(8, config.getReadQueueNums());
        assertEquals(4, config.getWriteQueueNums());
        assertEquals(4, config.getPerm());
    }

    @Test
    void normalizeTopicPermAllowsReadWriteValues() {
        assertEquals(6, RocketMqAgent.normalizeTopicPerm(6));
        assertEquals(4, RocketMqAgent.normalizeTopicPerm(4));
        assertEquals(2, RocketMqAgent.normalizeTopicPerm(2));
        assertEquals(6, RocketMqAgent.normalizeTopicPerm(7));
    }

    @Test
    void classifyConsumerGroupTypeMatchesDashboard() {
        assertEquals("SYSTEM", RocketMqAgent.classifyConsumerGroupType(MixAll.CID_SYS_RMQ_TRANS, null));
        SubscriptionGroupConfig fifo = new SubscriptionGroupConfig();
        fifo.setConsumeMessageOrderly(true);
        assertEquals("FIFO", RocketMqAgent.classifyConsumerGroupType("OrderGroup", fifo));
        SubscriptionGroupConfig normal = new SubscriptionGroupConfig();
        normal.setConsumeMessageOrderly(false);
        assertEquals("NORMAL", RocketMqAgent.classifyConsumerGroupType("MyGroup", normal));
    }

    @Test
    void enrichConsumerGroupRowsRunsIndependentLookupsConcurrently() throws Exception {
        List<Map<String, Object>> rows = IntStream.range(0, 4)
            .mapToObj(index -> {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("groupId", "group-" + index);
                return row;
            })
            .toList();
        CountDownLatch started = new CountDownLatch(rows.size());
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maxActive = new AtomicInteger();

        CompletableFuture<Void> enrichment = CompletableFuture.runAsync(() ->
            RocketMqAgent.enrichConsumerGroupRows(rows, groupId -> {
                int current = active.incrementAndGet();
                maxActive.accumulateAndGet(current, Math::max);
                started.countDown();
                try {
                    release.await(1, TimeUnit.SECONDS);
                    return new ConsumerConnection();
                } finally {
                    active.decrementAndGet();
                }
            }, 4, 1_000)
        );

        assertTrue(started.await(1, TimeUnit.SECONDS));
        release.countDown();
        enrichment.get(2, TimeUnit.SECONDS);

        assertTrue(maxActive.get() > 1);
        for (Map<String, Object> row : rows) {
            assertEquals(0, row.get("memberCount"));
            assertEquals(List.of(), row.get("topics"));
        }
    }

    @Test
    void enrichConsumerGroupRowsReturnsDefaultsWhenBudgetExpires() {
        List<Map<String, Object>> rows = IntStream.range(0, 4)
            .mapToObj(index -> {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("groupId", "slow-group-" + index);
                return row;
            })
            .toList();
        CountDownLatch blocked = new CountDownLatch(1);
        long startedAt = System.nanoTime();

        RocketMqAgent.enrichConsumerGroupRows(rows, groupId -> {
            blocked.await();
            return new ConsumerConnection();
        }, 2, 50);

        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt);
        assertTrue(elapsedMs < 1_000, "enrichment exceeded its response budget: " + elapsedMs + "ms");
        for (Map<String, Object> row : rows) {
            assertEquals(0, row.get("memberCount"));
            assertEquals(List.of(), row.get("topics"));
        }
    }

    @Test
    void enrichTopicPartitionsRunsIndependentLookupsConcurrently() throws Exception {
        List<Map<String, Object>> rows = IntStream.range(0, 4)
            .mapToObj(index -> {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("name", "topic-" + index);
                row.put("partitions", 1);
                return row;
            })
            .toList();
        CountDownLatch started = new CountDownLatch(rows.size());
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maxActive = new AtomicInteger();

        CompletableFuture<Void> enrichment = CompletableFuture.runAsync(() ->
            RocketMqAgent.enrichTopicPartitions(rows, topic -> {
                int current = active.incrementAndGet();
                maxActive.accumulateAndGet(current, Math::max);
                started.countDown();
                try {
                    release.await(1, TimeUnit.SECONDS);
                    return routeWithReadQueues(8);
                } finally {
                    active.decrementAndGet();
                }
            }, 4, 1_000)
        );

        assertTrue(started.await(1, TimeUnit.SECONDS));
        release.countDown();
        enrichment.get(2, TimeUnit.SECONDS);

        assertTrue(maxActive.get() > 1);
        for (Map<String, Object> row : rows) {
            assertEquals(8, row.get("partitions"));
        }
    }

    @Test
    void enrichTopicPartitionsReturnsDefaultsWhenBudgetExpires() {
        List<Map<String, Object>> rows = IntStream.range(0, 4)
            .mapToObj(index -> {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("name", "slow-topic-" + index);
                row.put("partitions", 1);
                return row;
            })
            .toList();
        CountDownLatch blocked = new CountDownLatch(1);
        long startedAt = System.nanoTime();

        RocketMqAgent.enrichTopicPartitions(rows, topic -> {
            blocked.await();
            return routeWithReadQueues(16);
        }, 2, 50);

        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt);
        assertTrue(elapsedMs < 1_000, "topic route enrichment exceeded its response budget: " + elapsedMs + "ms");
        for (Map<String, Object> row : rows) {
            assertEquals(1, row.get("partitions"));
        }
    }

    @Test
    void buildTopicCatalogRowsFallbackIssuesAtMostOneRouteRpcPerTopic() {
        Set<String> topicNames = new TreeSet<>(List.of("Alpha", "Beta", "Gamma"));
        Map<String, AtomicInteger> routeCalls = new ConcurrentHashMap<>();
        AtomicInteger totalRouteCalls = new AtomicInteger();

        List<Map<String, Object>> rows = RocketMqAgent.buildTopicCatalogRows(
            topicNames,
            Collections.emptyMap(),
            Collections.emptyMap(),
            Set.of(),
            Set.of(),
            "DefaultCluster",
            "",
            topic -> {
                totalRouteCalls.incrementAndGet();
                routeCalls.computeIfAbsent(topic, ignored -> new AtomicInteger()).incrementAndGet();
                return routeWithReadQueues(4);
            },
            8,
            2_000
        );

        assertEquals(3, rows.size());
        assertEquals(3, totalRouteCalls.get(), "fallback must not repeat examineTopicRouteInfo per topic");
        for (String topic : topicNames) {
            assertEquals(1, routeCalls.get(topic).get());
        }
        for (Map<String, Object> row : rows) {
            assertEquals(4, row.get("partitions"));
            // Bulk config unavailable — classify without per-topic examineTopicConfig.
            assertEquals("UNSPECIFIED", row.get("messageType"));
        }
    }

    @Test
    void buildTopicCatalogRowsUsesBrokerConfigWithoutRouteLookup() {
        TopicConfig config = new TopicConfig("Orders");
        config.setReadQueueNums(12);
        config.setAttributes(Map.of("message.type", "NORMAL"));
        Map<String, TopicConfig> brokerTopics = Map.of("Orders", config);
        AtomicInteger routeCalls = new AtomicInteger();

        List<Map<String, Object>> rows = RocketMqAgent.buildTopicCatalogRows(
            Set.of("Orders"),
            brokerTopics,
            Map.of("Orders", Map.of("message.type", "NORMAL")),
            Set.of(),
            Set.of(),
            "DefaultCluster",
            "",
            topic -> {
                routeCalls.incrementAndGet();
                return routeWithReadQueues(99);
            },
            8,
            2_000
        );

        assertEquals(1, rows.size());
        assertEquals(0, routeCalls.get(), "broker catalog path must not call examineTopicRouteInfo");
        assertEquals(12, rows.get(0).get("partitions"));
        assertEquals("NORMAL", rows.get(0).get("messageType"));
    }

    @Test
    void partialBrokerTopicConfigsMergeNameServerCatalog() {
        TopicConfig orders = new TopicConfig("Orders");
        TopicConfigSerializeWrapper wrapper = new TopicConfigSerializeWrapper();
        wrapper.setTopicConfigTable(new ConcurrentHashMap<>(Map.of("Orders", orders)));

        RocketMqAgent.BrokerTopicConfigSnapshot snapshot = RocketMqAgent.collectBrokerTopicConfigs(
            List.of("broker-a", "broker-b"),
            brokerAddr -> {
                if (brokerAddr.equals("broker-b")) {
                    throw new IllegalStateException("broker unavailable");
                }
                return wrapper;
            }
        );

        assertFalse(snapshot.complete());
        assertEquals(Set.of("Orders"), snapshot.topics().keySet());
        assertEquals(
            Set.of("Invoices", "Orders"),
            RocketMqAgent.topicCatalogNames(snapshot, Set.of("Invoices", "Orders"))
        );
    }

    @Test
    void completeBrokerTopicConfigsRemainAuthoritative() {
        TopicConfig orders = new TopicConfig("Orders");
        TopicConfigSerializeWrapper wrapper = new TopicConfigSerializeWrapper();
        wrapper.setTopicConfigTable(new ConcurrentHashMap<>(Map.of("Orders", orders)));

        RocketMqAgent.BrokerTopicConfigSnapshot snapshot = RocketMqAgent.collectBrokerTopicConfigs(
            List.of("broker-a"),
            brokerAddr -> wrapper
        );

        assertTrue(snapshot.complete());
        assertEquals(
            Set.of("Orders"),
            RocketMqAgent.topicCatalogNames(snapshot, Set.of("DeletedButStillRouted", "Orders"))
        );
    }

    private static TopicRouteData routeWithReadQueues(int readQueueNums) {
        QueueData queueData = new QueueData();
        queueData.setBrokerName("broker-a");
        queueData.setReadQueueNums(readQueueNums);
        queueData.setWriteQueueNums(readQueueNums);
        TopicRouteData route = new TopicRouteData();
        route.setQueueDatas(List.of(queueData));
        return route;
    }

    @Test
    void isEmptyQueryMessageResultDetectsRocketMqCode208() {
        MQClientException empty = new MQClientException(208, "query message by key finished, but no message");
        assertTrue(RocketMqAgent.isEmptyQueryMessageResult(empty));
        MQClientException other = new MQClientException(1, "other error");
        assertFalse(RocketMqAgent.isEmptyQueryMessageResult(other));
    }

    @Test
    void shouldQueryClusterProducerTableOnlyWithoutTopicOrGroup() {
        assertTrue(RocketMqAgent.shouldQueryClusterProducerTable("", ""));
        assertTrue(RocketMqAgent.shouldQueryClusterProducerTable(null, null));
        assertFalse(RocketMqAgent.shouldQueryClusterProducerTable("CS-SW", ""));
        assertFalse(RocketMqAgent.shouldQueryClusterProducerTable("CS-SW", null));
        assertFalse(RocketMqAgent.shouldQueryClusterProducerTable("", "p-test"));
        assertFalse(RocketMqAgent.shouldQueryClusterProducerTable("CS-SW", "p-test"));
    }

    @Test
    void topicHasProduceActivityDetectsQueuedMessages() {
        TopicStatsTable empty = new TopicStatsTable();
        MessageQueue queue = new MessageQueue("CS-SX", "broker-a", 0);
        TopicOffset offset = new TopicOffset();
        offset.setMinOffset(0);
        offset.setMaxOffset(0);
        empty.getOffsetTable().put(queue, offset);
        assertFalse(RocketMqAgent.topicHasProduceActivity(empty));
        assertFalse(RocketMqAgent.topicHasProduceActivity(null));

        TopicStatsTable active = new TopicStatsTable();
        TopicOffset activeOffset = new TopicOffset();
        activeOffset.setMinOffset(0);
        activeOffset.setMaxOffset(2);
        active.getOffsetTable().put(new MessageQueue("CS-PT", "broker-a", 0), activeOffset);
        assertTrue(RocketMqAgent.topicHasProduceActivity(active));
    }

    @Test
    void appendProducerTableRowsDedupesDuplicateConnections() {
        ProducerInfo first = new ProducerInfo("client-1", "127.0.0.1:39688", null, 5050, 1L);
        ProducerInfo duplicate = new ProducerInfo("client-2", "127.0.0.1:39688", null, 5050, 2L);

        Map<String, List<ProducerInfo>> data = new LinkedHashMap<>();
        data.put("CLIENT_INNER_PRODUCER", List.of(first, duplicate));
        ProducerTableInfo tableInfo = new ProducerTableInfo(data);

        List<Map<String, Object>> producers = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        RocketMqAgent.appendProducerTableRows(producers, seen, 1L, tableInfo);

        assertEquals(1, producers.size());
        assertEquals("CLIENT_INNER_PRODUCER", producers.get(0).get("producerName"));
        assertEquals("127.0.0.1:39688", producers.get(0).get("address"));
    }

    @Test
    void connectionMatchesComparesRocketMqConnectFields() {
        JsonObject base = JsonParser.parseString("""
            {
              "namesrv_addr": "127.0.0.1:9876",
              "cluster_name": "DefaultCluster",
              "broker_addr": "",
              "access_key": "ak",
              "secret_key": "sk"
            }
            """).getAsJsonObject();
        JsonObject same = base.deepCopy();
        JsonObject differentNamesrv = base.deepCopy();
        differentNamesrv.addProperty("namesrv_addr", "127.0.0.1:9877");

        assertTrue(RocketMqAgent.connectionMatches(base, same));
        assertFalse(RocketMqAgent.connectionMatches(base, differentNamesrv));
    }
}
