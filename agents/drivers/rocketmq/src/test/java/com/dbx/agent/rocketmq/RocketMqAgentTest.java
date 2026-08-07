package com.dbx.agent.rocketmq;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.apache.rocketmq.client.exception.MQBrokerException;
import org.apache.rocketmq.client.exception.MQClientException;
import org.apache.rocketmq.common.TopicConfig;
import org.apache.rocketmq.common.MixAll;
import org.apache.rocketmq.common.message.Message;
import org.apache.rocketmq.remoting.protocol.subscription.SubscriptionGroupConfig;
import org.apache.rocketmq.remoting.protocol.admin.ConsumeStats;
import org.apache.rocketmq.remoting.protocol.admin.OffsetWrapper;
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
import java.util.HashMap;
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
        // 172.15/172.32 are not RFC1918 — leave reachable public/non-private hosts alone.
        assertEquals("172.15.0.1:10911", RocketMqAgent.remapBrokerAddrForClient("172.15.0.1:10911", conn));
        assertEquals("172.32.0.1:10911", RocketMqAgent.remapBrokerAddrForClient("172.32.0.1:10911", conn));
    }

    @Test
    void isRfc1918PrivateIpv4MatchesOnlyPrivateRanges() {
        assertTrue(RocketMqAgent.isRfc1918PrivateIpv4("10.0.0.1"));
        assertTrue(RocketMqAgent.isRfc1918PrivateIpv4("172.16.0.1"));
        assertTrue(RocketMqAgent.isRfc1918PrivateIpv4("172.31.255.255"));
        assertTrue(RocketMqAgent.isRfc1918PrivateIpv4("192.168.1.1"));
        assertFalse(RocketMqAgent.isRfc1918PrivateIpv4("172.15.0.1"));
        assertFalse(RocketMqAgent.isRfc1918PrivateIpv4("172.32.0.1"));
        assertFalse(RocketMqAgent.isRfc1918PrivateIpv4("8.8.8.8"));
        assertFalse(RocketMqAgent.isRfc1918PrivateIpv4("broker.example.com"));
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
        // Missing dump must not look like NORMAL (FIFO groups would be mislabeled).
        assertEquals("UNKNOWN", RocketMqAgent.classifyConsumerGroupType("MissingConfigGroup", null));
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
            // Successful empty connection probe → genuine offline 0.
            assertEquals(0, row.get("memberCount"));
            assertEquals(List.of(), row.get("topics"));
        }
    }

    @Test
    void requireConsumerConnectionProbeResultFailsClosedWhenNoMasterAnswers() throws Exception {
        assertThrows(
            MQClientException.class,
            () -> RocketMqAgent.requireConsumerConnectionProbeResult(
                1, 0, 0, 0, null, new IllegalStateException("timeout"), "g1")
        );
        ConsumerConnection offline = new ConsumerConnection();
        assertSame(
            offline,
            RocketMqAgent.requireConsumerConnectionProbeResult(1, 1, 0, 0, offline, null, "g1")
        );
    }

    @Test
    void requireConsumerConnectionProbeResultFailsClosedOnRemapped206WithUnreachableFallback() {
        Exception cause = new IllegalStateException("fallback unreachable");
        MQClientException err = assertThrows(
            MQClientException.class,
            () -> RocketMqAgent.requireConsumerConnectionProbeResult(
                1, 1, 1, 0, new ConsumerConnection(), cause, "g1")
        );
        assertTrue(err.getMessage().contains("Docker remap address collision"));
        assertSame(cause, err.getCause());
    }

    @Test
    void requireConsumerConnectionProbeResultFailsClosedOnPartialRemappedOffline() {
        Exception cause = new IllegalStateException("broker-b timeout");
        MQClientException err = assertThrows(
            MQClientException.class,
            () -> RocketMqAgent.requireConsumerConnectionProbeResult(
                2, 1, 0, 0, new ConsumerConnection(), cause, "g1")
        );
        assertTrue(err.getMessage().contains("partial remapped probe"));
        assertSame(cause, err.getCause());
    }

    @Test
    void requireConsumerConnectionProbeResultAllowsFullOfflineCoverage() throws Exception {
        ConsumerConnection offline = new ConsumerConnection();
        assertSame(
            offline,
            RocketMqAgent.requireConsumerConnectionProbeResult(2, 2, 0, 0, offline, null, "g1")
        );
        assertSame(
            offline,
            RocketMqAgent.requireConsumerConnectionProbeResult(1, 1, 1, 1, offline, null, "g1")
        );
    }

    @Test
    void isConsumerGroupNotOnlineDetectsBrokerCode206() {
        assertTrue(RocketMqAgent.isConsumerGroupNotOnline(
            new MQBrokerException(206, "the consumer group[g1] not online")));
        assertTrue(RocketMqAgent.isConsumerGroupNotOnline(
            new MQClientException(206, "the consumer group[g1] not online")));
        assertTrue(RocketMqAgent.isConsumerGroupNotOnline(
            new RuntimeException(new MQBrokerException(206, "not online"))));
        assertFalse(RocketMqAgent.isConsumerGroupNotOnline(
            new MQBrokerException(1, "system error")));
        assertFalse(RocketMqAgent.isConsumerGroupNotOnline(new IllegalStateException("timeout")));
    }

    @Test
    void enrichConsumerGroupRowsOmitsMemberCountWhenConnectionProbeFails() {
        List<Map<String, Object>> rows = new ArrayList<>();
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("groupId", "unreachable-group");
        rows.add(row);

        RocketMqAgent.enrichConsumerGroupRows(rows, groupId -> {
            throw new MQClientException("Failed to examine consumer connection on all masters", null);
        }, 1, 1_000);

        // All-master connection probe failure must not look like offline 0.
        assertFalse(row.containsKey("memberCount"));
        assertEquals(List.of(), row.get("topics"));
    }

    @Test
    void enrichConsumerGroupRowsOmitsMemberCountWhenBudgetExpires() {
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
            // Cancelled probes must not look offline (0); UI shows '-' when memberCount is absent.
            assertFalse(row.containsKey("memberCount"));
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

    @Test
    void buildConsumerLagResultIncludesBrokerClientAndTimestamp() {
        MessageQueue mq0 = new MessageQueue("TX_TOPIC", "broker-a", 0);
        MessageQueue mq1 = new MessageQueue("TX_TOPIC", "broker-a", 1);
        OffsetWrapper offset0 = new OffsetWrapper();
        offset0.setBrokerOffset(100);
        offset0.setConsumerOffset(90);
        offset0.setLastTimestamp(1_725_000_000_000L);
        OffsetWrapper offset1 = new OffsetWrapper();
        offset1.setBrokerOffset(50);
        offset1.setConsumerOffset(50);
        offset1.setLastTimestamp(0L);

        ConsumeStats stats = new ConsumeStats();
        stats.getOffsetTable().put(mq0, offset0);
        stats.getOffsetTable().put(mq1, offset1);

        Map<MessageQueue, String> clients = new HashMap<>();
        clients.put(mq0, "172.18.2.212@7#1");

        Map<String, Object> result = RocketMqAgent.buildConsumerLagResult(stats, clients);
        assertEquals(10L, result.get("totalLag"));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> partitions = (List<Map<String, Object>>) result.get("partitions");
        assertEquals(2, partitions.size());
        assertEquals("broker-a", partitions.get(0).get("brokerName"));
        assertEquals(0, partitions.get(0).get("partition"));
        assertEquals(90L, partitions.get(0).get("currentOffset"));
        assertEquals(100L, partitions.get(0).get("endOffset"));
        assertEquals(10L, partitions.get(0).get("lag"));
        assertEquals(1_725_000_000_000L, partitions.get(0).get("lastTimestamp"));
        assertEquals("172.18.2.212@7#1", partitions.get(0).get("consumerClient"));
        // Missing client mapping still returns offsets with empty consumerClient.
        assertEquals("", partitions.get(1).get("consumerClient"));
        assertEquals(0L, partitions.get(1).get("lastTimestamp"));
    }

    @Test
    void buildConsumerLagResultHandlesNullStatsAndEmptyClientMap() {
        Map<String, Object> empty = RocketMqAgent.buildConsumerLagResult(null, null);
        assertEquals(0L, empty.get("totalLag"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> partitions = (List<Map<String, Object>>) empty.get("partitions");
        assertTrue(partitions.isEmpty());
    }

    @Test
    void mergeSubscriptionGroupConfigsPrefersFifoAndKeepsLaterOnlyGroups() {
        Map<String, SubscriptionGroupConfig> merged = new LinkedHashMap<>();

        SubscriptionGroupConfig normalA = new SubscriptionGroupConfig();
        normalA.setGroupName("group-a");
        normalA.setConsumeMessageOrderly(false);

        SubscriptionGroupConfig fifoA = new SubscriptionGroupConfig();
        fifoA.setGroupName("group-a");
        fifoA.setConsumeMessageOrderly(true);

        SubscriptionGroupConfig onlyOnLater = new SubscriptionGroupConfig();
        onlyOnLater.setGroupName("group-b");
        onlyOnLater.setConsumeMessageOrderly(true);

        // Intermediate broker repeats group-a as NORMAL (size would not grow), then later adds FIFO-only group-b.
        RocketMqAgent.mergeSubscriptionGroupConfigs(merged, Map.of("group-a", normalA));
        RocketMqAgent.mergeSubscriptionGroupConfigs(merged, Map.of("group-a", normalA));
        RocketMqAgent.mergeSubscriptionGroupConfigs(
            merged,
            Map.of("group-a", fifoA, "group-b", onlyOnLater)
        );

        assertEquals(2, merged.size());
        assertTrue(merged.get("group-a").isConsumeMessageOrderly());
        assertTrue(merged.get("group-b").isConsumeMessageOrderly());
        assertEquals("FIFO", RocketMqAgent.classifyConsumerGroupType("group-a", merged.get("group-a")));
        assertEquals("FIFO", RocketMqAgent.classifyConsumerGroupType("group-b", merged.get("group-b")));
    }

    @Test
    void mergeSubscriptionGroupConfigsDoesNotDowngradeFifoToNormal() {
        Map<String, SubscriptionGroupConfig> merged = new LinkedHashMap<>();
        SubscriptionGroupConfig fifo = new SubscriptionGroupConfig();
        fifo.setGroupName("ordered");
        fifo.setConsumeMessageOrderly(true);
        SubscriptionGroupConfig normal = new SubscriptionGroupConfig();
        normal.setGroupName("ordered");
        normal.setConsumeMessageOrderly(false);

        RocketMqAgent.mergeSubscriptionGroupConfigs(merged, Map.of("ordered", fifo));
        RocketMqAgent.mergeSubscriptionGroupConfigs(merged, Map.of("ordered", normal));

        assertTrue(merged.get("ordered").isConsumeMessageOrderly());
    }

    @Test
    void ensureConsumeStatsProbeSucceededRejectsAllBrokerFailures() {
        MQClientException noMasters = assertThrows(
            MQClientException.class,
            () -> RocketMqAgent.ensureConsumeStatsProbeSucceeded(0, 0, true, null, "GID_A"));
        assertTrue(noMasters.getMessage().contains("No reachable RocketMQ master"));

        Exception cause = new RuntimeException("broker down");
        MQClientException allFailed = assertThrows(
            MQClientException.class,
            () -> RocketMqAgent.ensureConsumeStatsProbeSucceeded(2, 0, true, cause, "GID_A"));
        assertTrue(allFailed.getMessage().contains("Failed to examine consume stats"));
        assertSame(cause, allFailed.getCause());
    }

    @Test
    void ensureConsumeStatsProbeSucceededRejectsPartialFailureWithEmptyMerge() {
        Exception cause = new RuntimeException("one broker down");
        MQClientException partialEmpty = assertThrows(
            MQClientException.class,
            () -> RocketMqAgent.ensureConsumeStatsProbeSucceeded(3, 1, true, cause, "GID_A"));
        assertTrue(partialEmpty.getMessage().contains("partial failure"));
        assertSame(cause, partialEmpty.getCause());
    }

    @Test
    void ensureConsumeStatsProbeSucceededAllowsEmptyOffsetsWhenAllBrokersSucceed() throws Exception {
        // Genuine offline / unused group: every broker answered, offset table empty.
        RocketMqAgent.ensureConsumeStatsProbeSucceeded(1, 1, true, null, "GID_A");
        RocketMqAgent.ensureConsumeStatsProbeSucceeded(3, 3, true, null, "GID_A");
    }

    @Test
    void ensureConsumeStatsProbeSucceededAllowsPartialFailureWhenMergeHasOffsets() throws Exception {
        // One broker failed but another returned queue offsets — keep partial lag.
        RocketMqAgent.ensureConsumeStatsProbeSucceeded(
            3, 1, false, new RuntimeException("partial"), "GID_A");
    }

    @Test
    void shouldFailClosedOnCollisionEmptyWhenSiblingFallbacksUnreachable() {
        assertTrue(RocketMqAgent.shouldFailClosedOnCollisionEmpty(true, 1, 0));
        assertTrue(RocketMqAgent.shouldFailClosedOnCollisionEmpty(true, 2, 1));
        assertFalse(RocketMqAgent.shouldFailClosedOnCollisionEmpty(false, 1, 0));
        assertFalse(RocketMqAgent.shouldFailClosedOnCollisionEmpty(true, 0, 0));
        assertFalse(RocketMqAgent.shouldFailClosedOnCollisionEmpty(true, 2, 2));
    }

    @Test
    void shouldFailClosedOnCollisionPartialMutationWhenSiblingFallbacksUnreachable() {
        assertTrue(RocketMqAgent.shouldFailClosedOnCollisionPartialMutation(1, 0));
        assertTrue(RocketMqAgent.shouldFailClosedOnCollisionPartialMutation(2, 1));
        assertFalse(RocketMqAgent.shouldFailClosedOnCollisionPartialMutation(0, 0));
        assertFalse(RocketMqAgent.shouldFailClosedOnCollisionPartialMutation(2, 2));
    }

    @Test
    void ensureSubscriptionGroupMutationSucceededRejectsCollisionPartialUpdate() {
        Exception cause = new RuntimeException("fallback unreachable");
        MQClientException err = assertThrows(
            MQClientException.class,
            () -> RocketMqAgent.ensureSubscriptionGroupMutationSucceeded(
                1, 1, 1, 0, cause, "delete", "GID_A"));
        assertTrue(err.getMessage().contains("Docker remap address collision"));
        assertSame(cause, err.getCause());
    }

    @Test
    void ensureSubscriptionGroupMutationSucceededRejectsPartialRemappedUpdate() {
        Exception cause = new RuntimeException("broker-b down");
        MQClientException err = assertThrows(
            MQClientException.class,
            () -> RocketMqAgent.ensureSubscriptionGroupMutationSucceeded(
                2, 1, 0, 0, cause, "update", "GID_A"));
        assertTrue(err.getMessage().contains("partial remapped update"));
        assertSame(cause, err.getCause());
    }

    @Test
    void ensureSubscriptionGroupMutationSucceededAllowsFullCoverage() throws Exception {
        RocketMqAgent.ensureSubscriptionGroupMutationSucceeded(2, 2, 0, 0, null, "delete", "GID_A");
        RocketMqAgent.ensureSubscriptionGroupMutationSucceeded(1, 1, 1, 1, null, "update", "GID_A");
    }

    @Test
    void masterBrokerAddrsFromClusterInfoKeepsCollisionFallbacksSeparate() {
        org.apache.rocketmq.remoting.protocol.body.ClusterInfo clusterInfo =
            new org.apache.rocketmq.remoting.protocol.body.ClusterInfo();
        HashMap<String, org.apache.rocketmq.remoting.protocol.route.BrokerData> table = new HashMap<>();
        table.put("broker-a", brokerData("broker-a", "172.18.0.2:10911"));
        table.put("broker-b", brokerData("broker-b", "172.18.0.3:10911"));
        clusterInfo.setBrokerAddrTable(table);

        JsonObject conn = JsonParser.parseString("""
            {"namesrvAddr":"127.0.0.1:9876"}
            """).getAsJsonObject();
        RocketMqAgent.MasterBrokerAddrPlan plan =
            RocketMqAgent.masterBrokerAddrsFromClusterInfo(clusterInfo, conn, null);

        // Both masters remap to the same published host:port; one remapped + one fallback.
        assertEquals(1, plan.remappedCount());
        assertEquals(1, plan.fallbackCount());
        assertTrue(plan.allAddrs().contains("127.0.0.1:10911"));
        assertTrue(plan.isCollisionFallback("172.18.0.3:10911") || plan.isCollisionFallback("172.18.0.2:10911"));
        // Remapped answered with offsets: collision fallbacks may stay unreachable on host agents.
        try {
            RocketMqAgent.ensureConsumeStatsProbeSucceeded(
                plan.remappedCount(), 1, false, new RuntimeException("fallback unreachable"), "GID_A");
        } catch (MQClientException e) {
            throw new AssertionError("non-empty remapped merge should be allowed", e);
        }
        // Empty merge is still allowed by the shared gate when remappedCount==success; the
        // examineConsumeStatsOnMasters collision check rejects empty+unreachable siblings.
        try {
            RocketMqAgent.ensureConsumeStatsProbeSucceeded(
                plan.remappedCount(), 1, true, null, "GID_A");
        } catch (MQClientException e) {
            throw new AssertionError("empty remapped-only success remains allowed at gate layer", e);
        }
    }

    @Test
    void operationBudgetMsFollowsRequestTimeoutMs() {
        JsonObject conn120 = JsonParser.parseString("""
            {"request_timeout_ms":120000}
            """).getAsJsonObject();
        assertEquals(120_000L, RocketMqAgent.operationBudgetMs(conn120));
        assertEquals(120_000, RocketMqAgent.operationBudgetMsAsInt(conn120));

        JsonObject connDefault = JsonParser.parseString("{}").getAsJsonObject();
        assertEquals(30_000L, RocketMqAgent.operationBudgetMs(connDefault));
        assertEquals(30_000, RocketMqAgent.operationBudgetMsAsInt(connDefault));

        JsonObject connTiny = JsonParser.parseString("""
            {"request_timeout_ms":100}
            """).getAsJsonObject();
        // Floor at 1s so budgets cannot collapse to zero.
        assertEquals(1_000L, RocketMqAgent.operationBudgetMs(connTiny));
        assertEquals(1_000, RocketMqAgent.operationBudgetMsAsInt(connTiny));
    }

    @Test
    void scaledOperationBudgetMsKeepsDefaultPhasesUnderRpcWindow() {
        JsonObject connDefault = JsonParser.parseString("{}").getAsJsonObject();
        assertEquals(12_000L, RocketMqAgent.scaledOperationBudgetMs(connDefault, 12_000L));
        assertEquals(8_000L, RocketMqAgent.scaledOperationBudgetMs(connDefault, 8_000L));
        assertEquals(10_000L, RocketMqAgent.scaledOperationBudgetMs(connDefault, 10_000L));

        JsonObject conn120 = JsonParser.parseString("""
            {"request_timeout_ms":120000}
            """).getAsJsonObject();
        assertEquals(48_000L, RocketMqAgent.scaledOperationBudgetMs(conn120, 12_000L));
        assertEquals(32_000L, RocketMqAgent.scaledOperationBudgetMs(conn120, 8_000L));
        assertEquals(40_000L, RocketMqAgent.scaledOperationBudgetMs(conn120, 10_000L));
        // Never exceed the RPC window even if baseline is larger.
        assertEquals(120_000L, RocketMqAgent.scaledOperationBudgetMs(conn120, 200_000L));
    }

    @Test
    void collectConsumerGroupConfigsSkipsFallbacksWhenRemappedNonEmpty() throws Exception {
        RocketMqAgent.MasterBrokerAddrPlan plan = collisionPlan(
            "127.0.0.1:10911", "172.18.0.3:10911");
        List<String> probed = new ArrayList<>();
        SubscriptionGroupConfig group = new SubscriptionGroupConfig();
        group.setGroupName("GID_A");

        Map<String, SubscriptionGroupConfig> configs = RocketMqAgent.collectConsumerGroupConfigs(
            plan,
            2,
            30_000L,
            30_000L,
            2_000L,
            (addr, timeout) -> {
                probed.add(addr);
                if (plan.isCollisionFallback(addr)) {
                    throw new AssertionError("collision-fallback must not be probed after non-empty remapped collect");
                }
                return Map.of("GID_A", group);
            }
        );

        assertEquals(List.of("127.0.0.1:10911"), probed);
        assertEquals(1, configs.size());
        assertTrue(configs.containsKey("GID_A"));
    }

    @Test
    void collectConsumerGroupConfigsProbesFallbacksWhenRemappedEmpty() throws Exception {
        RocketMqAgent.MasterBrokerAddrPlan plan = collisionPlan(
            "127.0.0.1:10911", "172.18.0.3:10911");
        List<String> probed = new ArrayList<>();
        SubscriptionGroupConfig group = new SubscriptionGroupConfig();
        group.setGroupName("GID_B");

        Map<String, SubscriptionGroupConfig> configs = RocketMqAgent.collectConsumerGroupConfigs(
            plan,
            2,
            30_000L,
            30_000L,
            2_000L,
            (addr, timeout) -> {
                probed.add(addr);
                if (plan.isCollisionFallback(addr)) {
                    assertEquals(2_000L, timeout);
                    return Map.of("GID_B", group);
                }
                return Map.of();
            }
        );

        assertEquals(2, probed.size());
        assertTrue(probed.contains("127.0.0.1:10911"));
        assertTrue(probed.contains("172.18.0.3:10911"));
        assertEquals(1, configs.size());
        assertTrue(configs.containsKey("GID_B"));
    }

    @Test
    void examineConsumeStatsOnMastersSkipsFallbacksWhenRemappedHasOffsets() throws Exception {
        RocketMqAgent.MasterBrokerAddrPlan plan = collisionPlan(
            "127.0.0.1:10911", "172.18.0.3:10911");
        List<String> probed = new ArrayList<>();
        ConsumeStats remappedStats = nonEmptyConsumeStats("TOPIC_A", "broker-a", 0);

        ConsumeStats merged = RocketMqAgent.examineConsumeStatsOnMasters(
            "GID_A",
            "TOPIC_A",
            plan,
            30_000L,
            2_000L,
            (addr, groupId, topic, timeout) -> {
                probed.add(addr);
                if (plan.isCollisionFallback(addr)) {
                    throw new AssertionError("collision-fallback must not be probed after non-empty remapped");
                }
                assertEquals(30_000L, timeout);
                return remappedStats;
            }
        );

        assertEquals(List.of("127.0.0.1:10911"), probed);
        assertEquals(1, merged.getOffsetTable().size());
    }

    @Test
    void examineConsumeStatsOnMastersProbesFallbacksAndFailClosesOnEmptyUnreachable() {
        RocketMqAgent.MasterBrokerAddrPlan plan = collisionPlan(
            "127.0.0.1:10911", "172.18.0.3:10911");
        List<String> probed = new ArrayList<>();

        MQClientException err = assertThrows(
            MQClientException.class,
            () -> RocketMqAgent.examineConsumeStatsOnMasters(
                "GID_A",
                "TOPIC_A",
                plan,
                30_000L,
                2_000L,
                (addr, groupId, topic, timeout) -> {
                    probed.add(addr);
                    if (plan.isCollisionFallback(addr)) {
                        assertEquals(2_000L, timeout);
                        throw new RuntimeException("docker internal unreachable");
                    }
                    assertEquals(30_000L, timeout);
                    return new ConsumeStats();
                }
            )
        );

        assertTrue(err.getMessage().contains("Docker remap address collision"));
        assertEquals(2, probed.size());
        assertTrue(probed.contains("127.0.0.1:10911"));
        assertTrue(probed.contains("172.18.0.3:10911"));
    }

    @Test
    void examineConsumeStatsOnMastersUsesFallbackWhenRemappedFails() throws Exception {
        RocketMqAgent.MasterBrokerAddrPlan plan = collisionPlan(
            "127.0.0.1:10911", "172.18.0.3:10911");
        List<String> probed = new ArrayList<>();
        ConsumeStats fallbackStats = nonEmptyConsumeStats("TOPIC_A", "broker-b", 1);

        ConsumeStats merged = RocketMqAgent.examineConsumeStatsOnMasters(
            "GID_A",
            "TOPIC_A",
            plan,
            30_000L,
            2_000L,
            (addr, groupId, topic, timeout) -> {
                probed.add(addr);
                if (!plan.isCollisionFallback(addr)) {
                    assertEquals(30_000L, timeout);
                    throw new RuntimeException("published remap unreachable");
                }
                assertEquals(2_000L, timeout);
                return fallbackStats;
            }
        );

        assertEquals(2, probed.size());
        assertEquals(1, merged.getOffsetTable().size());
    }

    private static RocketMqAgent.MasterBrokerAddrPlan collisionPlan(
        String remapped, String fallback) {
        RocketMqAgent.MasterBrokerAddrPlan plan = new RocketMqAgent.MasterBrokerAddrPlan();
        plan.addRemapped(remapped);
        plan.addCollisionFallback(fallback);
        return plan;
    }

    private static ConsumeStats nonEmptyConsumeStats(String topic, String broker, int queueId) {
        MessageQueue mq = new MessageQueue(topic, broker, queueId);
        OffsetWrapper offset = new OffsetWrapper();
        offset.setBrokerOffset(10);
        offset.setConsumerOffset(0);
        ConsumeStats stats = new ConsumeStats();
        stats.getOffsetTable().put(mq, offset);
        return stats;
    }

    private static org.apache.rocketmq.remoting.protocol.route.BrokerData brokerData(
        String name, String masterAddr) {
        org.apache.rocketmq.remoting.protocol.route.BrokerData data =
            new org.apache.rocketmq.remoting.protocol.route.BrokerData();
        data.setBrokerName(name);
        HashMap<Long, String> addrs = new HashMap<>();
        addrs.put(0L, masterAddr);
        data.setBrokerAddrs(addrs);
        return data;
    }
}
