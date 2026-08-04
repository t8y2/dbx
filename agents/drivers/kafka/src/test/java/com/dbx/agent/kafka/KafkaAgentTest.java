package com.dbx.agent.kafka;

import com.google.gson.JsonObject;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.admin.AlterConfigOp;
import org.apache.kafka.clients.admin.Config;
import org.apache.kafka.clients.admin.ConfigEntry;
import org.apache.kafka.common.TopicPartition;
import org.apache.zookeeper.CreateMode;
import org.apache.zookeeper.Watcher;
import org.apache.zookeeper.ZooDefs;
import org.apache.zookeeper.ZooKeeper;
import org.apache.zookeeper.client.ZKClientConfig;
import org.apache.zookeeper.server.NIOServerCnxnFactory;
import org.apache.zookeeper.server.ZooKeeperServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class KafkaAgentTest {
    @TempDir
    Path tempDir;

    @Test
    void resolvesBootstrapServersFromKafka11ZooKeeperRegistrationWithChroot() throws Exception {
        Path snapshots = Files.createDirectory(tempDir.resolve("snapshots"));
        Path logs = Files.createDirectory(tempDir.resolve("logs"));
        ZooKeeperServer server = new ZooKeeperServer(snapshots.toFile(), logs.toFile(), 2_000);
        NIOServerCnxnFactory factory = new NIOServerCnxnFactory();
        factory.configure(new InetSocketAddress("127.0.0.1", 0), 10);
        factory.startup(server);

        ZooKeeper client = null;
        String previousSaslSetting = System.getProperty("zookeeper.sasl.client");
        try {
            CountDownLatch connected = new CountDownLatch(1);
            System.setProperty("zookeeper.sasl.client", "false");
            client = new ZooKeeper("127.0.0.1:" + factory.getLocalPort(), 5_000, event -> {
                if (event.getState() == Watcher.Event.KeeperState.SyncConnected) connected.countDown();
            });
            assertTrue(connected.await(5, TimeUnit.SECONDS));
            client.create("/kafka", new byte[0], ZooDefs.Ids.OPEN_ACL_UNSAFE, CreateMode.PERSISTENT);
            client.create("/kafka/brokers", new byte[0], ZooDefs.Ids.OPEN_ACL_UNSAFE, CreateMode.PERSISTENT);
            client.create("/kafka/brokers/ids", new byte[0], ZooDefs.Ids.OPEN_ACL_UNSAFE, CreateMode.PERSISTENT);
            client.create(
                "/kafka/brokers/ids/0",
                "{\"listener_security_protocol_map\":{\"PLAINTEXT\":\"PLAINTEXT\"},\"endpoints\":[\"PLAINTEXT://legacy-broker:9092\"]}".getBytes(StandardCharsets.UTF_8),
                ZooDefs.Ids.OPEN_ACL_UNSAFE,
                CreateMode.EPHEMERAL
            );

            JsonObject connection = new JsonObject();
            connection.addProperty("zookeeper_connect_string", "127.0.0.1:" + factory.getLocalPort() + "/kafka");
            connection.addProperty("security_protocol", "PLAINTEXT");
            connection.addProperty("zookeeper_connection_timeout_ms", 5_000);

            JsonObject resolved = KafkaAgent.resolveBrokerConnection(connection);

            assertEquals("legacy-broker:9092", resolved.get("bootstrap_servers").getAsString());
        } finally {
            if (client != null) client.close();
            factory.shutdown();
            server.shutdown();
            server.getTxnLogFactory().close();
            if (previousSaslSetting == null) {
                System.clearProperty("zookeeper.sasl.client");
            } else {
                System.setProperty("zookeeper.sasl.client", previousSaslSetting);
            }
        }
    }

    @Test
    void zooKeeperClientConfigPreservesSaslAndTlsSystemDefaults() {
        Map<String, String> previous = preserveSystemProperties(
            "zookeeper.sasl.client",
            "zookeeper.sasl.clientconfig",
            "zookeeper.client.secure",
            "zookeeper.clientCnxnSocket",
            "zookeeper.ssl.trustStore.location",
            "java.security.auth.login.config"
        );
        try {
            System.setProperty("zookeeper.sasl.client", "true");
            System.setProperty("zookeeper.sasl.clientconfig", "DbxZooKeeperClient");
            System.setProperty("zookeeper.client.secure", "true");
            System.setProperty("zookeeper.clientCnxnSocket", "org.apache.zookeeper.ClientCnxnSocketNetty");
            System.setProperty("zookeeper.ssl.trustStore.location", "/etc/dbx/zookeeper-truststore.p12");
            System.setProperty("java.security.auth.login.config", "/etc/dbx/zookeeper-jaas.conf");

            ZKClientConfig config = KafkaAgent.zooKeeperClientConfig(new JsonObject());

            assertTrue(config.isSaslClientEnabled());
            assertEquals("DbxZooKeeperClient", config.getProperty("zookeeper.sasl.clientconfig"));
            assertEquals("true", config.getProperty("zookeeper.client.secure"));
            assertEquals(
                "org.apache.zookeeper.ClientCnxnSocketNetty",
                config.getProperty("zookeeper.clientCnxnSocket")
            );
            assertEquals(
                "/etc/dbx/zookeeper-truststore.p12",
                config.getProperty("zookeeper.ssl.trustStore.location")
            );
            assertEquals("/etc/dbx/zookeeper-jaas.conf", config.getJaasConfKey());
        } finally {
            restoreSystemProperties(previous);
        }
    }

    @Test
    void zooKeeperClientConfigAppliesPerConnectionSaslAndTlsOverridesWithoutChangingJvmState() {
        Map<String, String> previous = preserveSystemProperties(
            "zookeeper.sasl.client",
            "zookeeper.sasl.clientconfig",
            "zookeeper.client.secure",
            "zookeeper.clientCnxnSocket",
            "zookeeper.ssl.keyStore.location"
        );
        try {
            System.setProperty("zookeeper.sasl.client", "false");
            System.setProperty("zookeeper.client.secure", "false");

            JsonObject properties = new JsonObject();
            properties.addProperty("zookeeper.sasl.client", "true");
            properties.addProperty("zookeeper.sasl.clientconfig", "DbxZooKeeperClient");
            properties.addProperty("zookeeper.client.secure", "true");
            properties.addProperty("zookeeper.clientCnxnSocket", "org.apache.zookeeper.ClientCnxnSocketNetty");
            properties.addProperty("zookeeper.ssl.keyStore.location", "/etc/dbx/zookeeper-keystore.p12");
            properties.addProperty("security.protocol", "SASL_SSL");
            JsonObject connection = new JsonObject();
            connection.add("properties", properties);

            ZKClientConfig config = KafkaAgent.zooKeeperClientConfig(connection);

            assertTrue(config.isSaslClientEnabled());
            assertEquals("DbxZooKeeperClient", config.getProperty("zookeeper.sasl.clientconfig"));
            assertEquals("true", config.getProperty("zookeeper.client.secure"));
            assertEquals(
                "org.apache.zookeeper.ClientCnxnSocketNetty",
                config.getProperty("zookeeper.clientCnxnSocket")
            );
            assertEquals(
                "/etc/dbx/zookeeper-keystore.p12",
                config.getProperty("zookeeper.ssl.keyStore.location")
            );
            assertNull(config.getProperty("security.protocol"));
            assertEquals("false", System.getProperty("zookeeper.sasl.client"));
            assertEquals("false", System.getProperty("zookeeper.client.secure"));
        } finally {
            restoreSystemProperties(previous);
        }
    }

    @Test
    void brokerEndpointsUseListenerSecurityProtocolMapForNamedListenersAndKeepBrokerOrder() {
        List<JsonObject> registrations = Arrays.asList(
            broker("{\"listener_security_protocol_map\":{\"INTERNAL\":\"PLAINTEXT\",\"CLIENT\":\"SASL_SSL\"},\"endpoints\":[\"INTERNAL://broker-2:9092\",\"CLIENT://public-2:9093\"]}"),
            broker("{\"listener_security_protocol_map\":{\"INTERNAL\":\"PLAINTEXT\",\"CLIENT\":\"SASL_SSL\"},\"endpoints\":[\"CLIENT://public-1:9093\",\"INTERNAL://broker-1:9092\"]}")
        );

        assertEquals("public-2:9093,public-1:9093", KafkaAgent.brokerEndpoints(registrations, "SASL_SSL"));
    }

    @Test
    void kafkaClientPropertiesExcludeZooKeeperSecuritySettings() {
        JsonObject properties = new JsonObject();
        properties.addProperty("client.id", "dbx");
        properties.addProperty("zookeeper.sasl.client", "true");
        properties.addProperty("zookeeper.ssl.trustStore.password", "secret");
        JsonObject connection = new JsonObject();
        connection.add("properties", properties);

        Properties kafkaProperties = new Properties();
        KafkaAgent.applyConnectionProperties(connection, kafkaProperties);

        assertEquals("dbx", kafkaProperties.getProperty("client.id"));
        assertNull(kafkaProperties.getProperty("zookeeper.sasl.client"));
        assertNull(kafkaProperties.getProperty("zookeeper.ssl.trustStore.password"));
    }

    @Test
    void brokerEndpointsFallBackToLegacyHostAndPort() {
        assertEquals("legacy-broker:9092", KafkaAgent.brokerEndpoints(
            Collections.singletonList(broker("{\"host\":\"legacy-broker\",\"port\":9092}")), "PLAINTEXT"));
    }

    @Test
    void brokerEndpointsSkipMalformedRegistrationWhenAnotherBrokerIsUsable() {
        assertEquals("healthy-broker:9092", KafkaAgent.brokerEndpoints(Arrays.asList(
            broker("{\"host\":\"broken\",\"port\":\"not-a-port\"}"),
            broker("{\"host\":\"healthy-broker\",\"port\":9092}")
        ), "PLAINTEXT"));
    }

    @Test
    void brokerEndpointsRejectRegistrationsWithoutUsableAddresses() {
        var error = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
            () -> KafkaAgent.brokerEndpoints(Collections.singletonList(broker("{\"endpoints\":[]}")), "PLAINTEXT"));
        assertTrue(error.getMessage().contains("usable Kafka broker endpoints"));
    }

    @Test
    void peekConsumerPropertiesReuseResolvedConnection() {
        JsonObject resolved = new JsonObject();
        resolved.addProperty("bootstrap_servers", "legacy-broker:9092");
        resolved.addProperty("security_protocol", "PLAINTEXT");

        Properties properties = KafkaAgent.peekConsumerProperties(resolved, 25);

        assertEquals("legacy-broker:9092", properties.getProperty("bootstrap.servers"));
        assertEquals(25, properties.get("max.poll.records"));
    }

    @Test
    void aclDisabledDetectionOnlyAcceptsKnownAuthorizerErrors() {
        Exception disabled = new RuntimeException(
            "ACL probe failed",
            new IllegalStateException("No Authorizer is configured on the broker")
        );

        assertTrue(KafkaAgent.isAclDisabledError(disabled));
        assertFalse(KafkaAgent.isAclDisabledError(new RuntimeException("Timed out waiting for broker response")));
    }

    @Test
    void legacyTopicConfigAppliesSetAndDeleteWithoutLosingExistingOverrides() {
        Config current = new Config(Arrays.asList(
            new ConfigEntry("cleanup.policy", "delete"),
            new ConfigEntry("retention.ms", "60000"),
            new ConfigEntry(
                "segment.bytes",
                "1073741824",
                ConfigEntry.ConfigSource.DYNAMIC_BROKER_CONFIG,
                false,
                false,
                Collections.emptyList(),
                ConfigEntry.ConfigType.LONG,
                null
            )
        ));
        List<AlterConfigOp> ops = Arrays.asList(
            new AlterConfigOp(new ConfigEntry("retention.ms", "120000"), AlterConfigOp.OpType.SET),
            new AlterConfigOp(new ConfigEntry("cleanup.policy", null), AlterConfigOp.OpType.DELETE)
        );

        Map<String, String> merged = KafkaAgent.legacyTopicConfig(current, ops);

        assertEquals(Collections.singletonMap("retention.ms", "120000"), merged);
    }

    @Test
    void legacyTopicConfigRejectsAppendAndSubtractOperations() {
        Config current = new Config(Collections.singletonList(new ConfigEntry("cleanup.policy", "delete")));
        AlterConfigOp append = new AlterConfigOp(new ConfigEntry("cleanup.policy", "compact"), AlterConfigOp.OpType.APPEND);

        var error = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
            () -> KafkaAgent.legacyTopicConfig(current, Collections.singletonList(append)));
        assertTrue(error.getMessage().contains("APPEND"));
    }
    @Test
    void normalizesPeekOffsetToEarliestAvailableOffset() {
        assertEquals(5L, KafkaAgent.normalizePeekOffset(0, 5, 10));
    }

    @Test
    void normalizesNegativePeekOffsetToEarliestAvailableOffset() {
        assertEquals(0L, KafkaAgent.normalizePeekOffset(-1, 0, 10));
    }

    @Test
    void keepsPeekOffsetWhenItIsWithinAvailableRange() {
        assertEquals(7L, KafkaAgent.normalizePeekOffset(7, 5, 10));
    }

    @Test
    void returnsNoSeekOffsetWhenRequestedOffsetIsAtOrAfterEnd() {
        assertNull(KafkaAgent.normalizePeekOffset(10, 5, 10));
    }

    @Test
    void returnsNoSeekOffsetWhenTopicHasNoReadableMessages() {
        assertNull(KafkaAgent.normalizePeekOffset(0, 5, 5));
    }

    @Test
    void peekStartPositionDefaultsToEarliestForOlderClients() {
        assertEquals(KafkaAgent.PeekStartPosition.EARLIEST,
            KafkaAgent.peekStartPosition(new JsonObject()));
    }

    @Test
    void peekStartPositionRecognizesEveryExplicitMode() {
        JsonObject latest = new JsonObject();
        latest.addProperty("startPosition", "latest");
        JsonObject earliest = new JsonObject();
        earliest.addProperty("startPosition", "earliest");
        JsonObject offset = new JsonObject();
        offset.addProperty("startPosition", "offset");

        assertEquals(KafkaAgent.PeekStartPosition.LATEST, KafkaAgent.peekStartPosition(latest));
        assertEquals(KafkaAgent.PeekStartPosition.EARLIEST, KafkaAgent.peekStartPosition(earliest));
        assertEquals(KafkaAgent.PeekStartPosition.OFFSET, KafkaAgent.peekStartPosition(offset));
    }

    @Test
    void peekStartPositionRejectsUnknownValues() {
        JsonObject params = new JsonObject();
        params.addProperty("startPosition", "middle");

        assertThrows(IllegalArgumentException.class, () -> KafkaAgent.peekStartPosition(params));
    }

    @Test
    void offsetStartPositionAllowsAllPartitionsButRequiresANonNegativeOffset() {
        assertDoesNotThrow(() ->
            KafkaAgent.validatePeekRequest(KafkaAgent.PeekStartPosition.OFFSET, true, null, 0L));
        assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.validatePeekRequest(KafkaAgent.PeekStartPosition.OFFSET, true, 0, null));
        assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.validatePeekRequest(KafkaAgent.PeekStartPosition.OFFSET, true, -1, 0L));
        assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.validatePeekRequest(KafkaAgent.PeekStartPosition.OFFSET, true, 0, -1L));
    }

    @Test
    void nonOffsetStartPositionsRejectAnOffset() {
        assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.validatePeekRequest(KafkaAgent.PeekStartPosition.LATEST, true, 0, 7L));
        assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.validatePeekRequest(KafkaAgent.PeekStartPosition.EARLIEST, true, 0, 7L));
    }

    @Test
    void latestSkipsEmptyPartitions() {
        assertNull(KafkaAgent.requestedPeekOffset(
            KafkaAgent.PeekStartPosition.LATEST, null, false, 5L, 5L
        ));
    }

    @Test
    void everyStartPositionRejectsNegativePartitions() {
        assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.validatePeekRequest(KafkaAgent.PeekStartPosition.LATEST, true, -1, null));
        assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.validatePeekRequest(KafkaAgent.PeekStartPosition.EARLIEST, true, -1, null));
    }

    @Test
    void legacyOffsetWithoutStartPositionKeepsTheExistingReadBehavior() {
        KafkaAgent.validatePeekRequest(KafkaAgent.PeekStartPosition.EARLIEST, false, null, 7L);
        assertEquals(7L, KafkaAgent.requestedPeekOffset(
            KafkaAgent.PeekStartPosition.EARLIEST, 7L, true, 0L, 10L
        ));
    }

    @Test
    void explicitEarliestDoesNotReuseAnOffsetFromAnOlderRequest() {
        assertEquals(0L, KafkaAgent.requestedPeekOffset(
            KafkaAgent.PeekStartPosition.EARLIEST, 7L, false, 0L, 10L
        ));
    }

    @Test
    void offsetSortUsesPartitionAsADeterministicTieBreaker() {
        var messages = new java.util.ArrayList<Map<String, Object>>();
        messages.add(Map.of("partition", 2, "offset", 7L));
        messages.add(Map.of("partition", 1, "offset", 7L));
        messages.add(Map.of("partition", 0, "offset", 8L));

        KafkaAgent.sortPeekedMessages(messages, KafkaAgent.PeekStartPosition.OFFSET);

        assertEquals(1, messages.get(0).get("partition"));
        assertEquals(2, messages.get(1).get("partition"));
        assertEquals(8L, messages.get(2).get("offset"));
    }

    @Test
    void splitsMessageWindowAcrossPartitions() {
        assertEquals(4, KafkaAgent.peekMessagesPerPartition(10, 3));
        assertEquals(10, KafkaAgent.peekMessagesPerPartition(10, 1));
    }

    @Test
    void startsLatestMessageWindowNearThePartitionEnd() {
        assertEquals(90L, KafkaAgent.recentPeekStartOffset(0, 100, 10));
        assertEquals(5L, KafkaAgent.recentPeekStartOffset(5, 8, 10));
    }

    @Test
    void boundsThePerPartitionMessageQuotaBeforeTrimmingTheResult() {
        assertEquals(12, KafkaAgent.recentPeekFetchCount(4, 3));
        assertEquals(4, KafkaAgent.peekMessagesPerPartition(10, 3));
    }

    @Test
    void peekRejectsAWindowThatExceedsTheScanLimit() {
        assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.peekScanLimit(100, 1_001));
    }

    @Test
    void peekWindowCalculationDoesNotOverflow() {
        assertEquals(1, KafkaAgent.peekMessagesPerPartition(
            Integer.MAX_VALUE, Integer.MAX_VALUE
        ));
    }

    @Test
    void latestPeekExpandsBackwardAcrossSparseOffsetGaps() {
        assertEquals(6L, KafkaAgent.recentPeekStartOffset(0L, 11L, 5));
        assertEquals(0L, KafkaAgent.previousLatestPeekStartOffset(0L, 6L, 5L));
        assertEquals(12L, KafkaAgent.previousLatestPeekStartOffset(0L, 32L, 10L));
    }

    @Test
    void latestPeekRetainsTheNewestRecordsFromAnExpandedRange() {
        Deque<Long> latestOffsets = new ArrayDeque<>();
        for (long offset = 86L; offset <= 95L; offset++) {
            KafkaAgent.retainLatestPeekRecord(latestOffsets, offset, 4);
        }

        assertEquals(List.of(92L, 93L, 94L, 95L), new ArrayList<>(latestOffsets));
    }

    @Test
    void peekCountMustStayWithinTheServiceLimit() {
        assertEquals(100, KafkaAgent.validatedPeekCount(100));
        assertThrows(IllegalArgumentException.class, () -> KafkaAgent.validatedPeekCount(0));
        assertThrows(IllegalArgumentException.class, () -> KafkaAgent.validatedPeekCount(101));
    }

    @Test
    void peekUsesTheConfiguredConsumerRequestTimeout() {
        Properties properties = new Properties();
        properties.put("request.timeout.ms", "1500");

        assertEquals(1_500, KafkaAgent.peekRequestTimeoutMs(new JsonObject(), properties));
    }

    @Test
    void peekRequestTimeoutPrefersTheConnectionOverrideAndRejectsInvalidValues() {
        Properties properties = new Properties();
        properties.put("request.timeout.ms", "1500");
        JsonObject connection = new JsonObject();
        connection.addProperty("request_timeout_ms", 2_500);

        assertEquals(2_500, KafkaAgent.peekRequestTimeoutMs(connection, properties));

        properties.put("request.timeout.ms", "0");
        assertThrows(IllegalArgumentException.class, () -> KafkaAgent.peekRequestTimeoutMs(new JsonObject(), properties));
    }

    @Test
    void incompletePeekResultsAreExplicitlyMarked() {
        Map<String, Object> partial = KafkaAgent.peekMessagesResult(List.of(), true);
        Map<String, Object> complete = KafkaAgent.peekMessagesResult(List.of(), false);

        assertEquals(true, partial.get("incomplete"));
        assertEquals(false, complete.get("incomplete"));
    }

    @Test
    void resolvePeekPartitionsUsesSinglePartitionWhenSpecified() {
        var partitions = KafkaAgent.resolvePeekPartitions("events", 2, List.of(0, 1, 2));
        assertEquals(1, partitions.size());
        assertEquals(2, partitions.get(0).partition());
        assertEquals("events", partitions.get(0).topic());
    }

    @Test
    void resolvePeekPartitionsUsesAllPartitionsWhenUnspecified() {
        var partitions = KafkaAgent.resolvePeekPartitions("events", null, List.of(2, 0, 1));
        assertEquals(List.of(0, 1, 2), partitions.stream().map(org.apache.kafka.common.TopicPartition::partition).toList());
    }

    @Test
    void sortPeekedMessagesOrdersByTimestampThenPartitionThenOffset() {
        var messages = new java.util.ArrayList<Map<String, Object>>();
        messages.add(Map.of("timestamp", 20L, "partition", 1, "offset", 1L));
        messages.add(Map.of("timestamp", 10L, "partition", 0, "offset", 5L));
        messages.add(Map.of("timestamp", 10L, "partition", 0, "offset", 2L));
        messages.add(Map.of("timestamp", 10L, "partition", 1, "offset", 0L));
        KafkaAgent.sortPeekedMessages(messages);
        assertEquals(2L, messages.get(0).get("offset"));
        assertEquals(5L, messages.get(1).get("offset"));
        assertEquals(1, messages.get(2).get("partition"));
        assertEquals(20L, messages.get(3).get("timestamp"));
    }

    @Test
    void sortPeekedMessagesCanOrderNewestFirst() {
        var messages = new java.util.ArrayList<Map<String, Object>>();
        messages.add(Map.of("timestamp", 20L, "partition", 1, "offset", 1L));
        messages.add(Map.of("timestamp", 10L, "partition", 0, "offset", 5L));
        messages.add(Map.of("timestamp", 10L, "partition", 0, "offset", 2L));
        messages.add(Map.of("timestamp", 10L, "partition", 1, "offset", 0L));

        KafkaAgent.sortPeekedMessages(messages, KafkaAgent.PeekStartPosition.LATEST);

        assertEquals(20L, messages.get(0).get("timestamp"));
        assertEquals(0, messages.get(1).get("partition"));
        assertEquals(2L, messages.get(1).get("offset"));
        assertEquals(5L, messages.get(2).get("offset"));
        assertEquals(1, messages.get(3).get("partition"));
    }

    @Test
    void sortPeekedMessagesOrdersOffsetModeByOffsetAscending() {
        var messages = new java.util.ArrayList<Map<String, Object>>();
        messages.add(Map.of("timestamp", 10L, "partition", 0, "offset", 5L));
        messages.add(Map.of("timestamp", 30L, "partition", 0, "offset", 2L));
        messages.add(Map.of("timestamp", 20L, "partition", 0, "offset", 3L));

        KafkaAgent.sortPeekedMessages(messages, KafkaAgent.PeekStartPosition.OFFSET);

        assertEquals(2L, messages.get(0).get("offset"));
        assertEquals(3L, messages.get(1).get("offset"));
        assertEquals(5L, messages.get(2).get("offset"));
    }

    @Test
    void allPeekPartitionsCaughtUpRequiresEveryPartitionAtEndOffset() {
        TopicPartition p0 = new TopicPartition("events", 0);
        TopicPartition p1 = new TopicPartition("events", 1);
        Map<TopicPartition, Long> endOffsets = Map.of(p0, 10L, p1, 5L);

        assertFalse(KafkaAgent.allPeekPartitionsCaughtUp(
            List.of(p0, p1),
            Map.of(p0, 10L, p1, 4L),
            endOffsets
        ));
        assertTrue(KafkaAgent.allPeekPartitionsCaughtUp(
            List.of(p0, p1),
            Map.of(p0, 10L, p1, 5L),
            endOffsets
        ));
    }

    @Test
    void peekCompletionStopsAfterEachPartitionSuppliesItsQuota() {
        TopicPartition p0 = new TopicPartition("events", 0);
        TopicPartition p1 = new TopicPartition("events", 1);
        List<TopicPartition> partitions = List.of(p0, p1);
        Map<TopicPartition, Long> endOffsets = Map.of(p0, 100L, p1, 100L);

        assertTrue(KafkaAgent.allPeekPartitionsComplete(
            partitions,
            Map.of(p0, 0, p1, 0),
            Map.of(p0, 1L, p1, 1L),
            endOffsets
        ));
        assertFalse(KafkaAgent.allPeekPartitionsComplete(
            partitions,
            Map.of(p0, 0, p1, 1),
            Map.of(p0, 1L, p1, 1L),
            endOffsets
        ));
        assertTrue(KafkaAgent.allPeekPartitionsComplete(
            partitions,
            Map.of(p0, 0, p1, 1),
            Map.of(p0, 1L, p1, 100L),
            endOffsets
        ));
    }

    @Test
    void collectPeekedMessagesRetriesAfterEmptyFirstPoll() {
        TopicPartition tp = new TopicPartition("events", 0);
        ConsumerRecord<String, byte[]> record = new ConsumerRecord<>(
            "events",
            0,
            7L,
            "k",
            "hello".getBytes(StandardCharsets.UTF_8)
        );
        Map<TopicPartition, List<ConsumerRecord<String, byte[]>>> batch = new HashMap<>();
        batch.put(tp, List.of(record));
        ConsumerRecords<String, byte[]> withData = new ConsumerRecords<>(batch);

        AtomicInteger polls = new AtomicInteger();
        List<Map<String, Object>> messages = KafkaAgent.collectPeekedMessages(
            timeout -> polls.getAndIncrement() == 0 ? ConsumerRecords.empty() : withData,
            () -> polls.get() >= 2,
            ignored -> true,
            List.of(tp),
            1,
            1_000,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals(2, polls.get());
        assertEquals(1, messages.size());
        assertEquals(7L, messages.get(0).get("offset"));
        assertEquals("hello", messages.get(0).get("payloadText"));
    }

    @Test
    void collectPeekedMessagesDoesNotPollWhenAlreadyCaughtUp() {
        TopicPartition tp = new TopicPartition("events", 0);
        AtomicInteger polls = new AtomicInteger();
        List<Map<String, Object>> messages = KafkaAgent.collectPeekedMessages(
            timeout -> {
                polls.incrementAndGet();
                return ConsumerRecords.empty();
            },
            () -> true,
            record -> true,
            List.of(tp),
            10,
            1_000,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals(0, polls.get());
        assertTrue(messages.isEmpty());
    }

    @Test
    void collectPeekedMessagesExcludesRecordsPastTheSnapshotEndOffset() {
        TopicPartition tp = new TopicPartition("events", 0);
        ConsumerRecord<String, byte[]> included = new ConsumerRecord<>(
            "events", 0, 9L, "before", "before".getBytes(StandardCharsets.UTF_8)
        );
        ConsumerRecord<String, byte[]> excluded = new ConsumerRecord<>(
            "events", 0, 10L, "after", "after".getBytes(StandardCharsets.UTF_8)
        );
        ConsumerRecords<String, byte[]> batch = new ConsumerRecords<>(Map.of(tp, List.of(included, excluded)));
        AtomicInteger polls = new AtomicInteger();
        AtomicInteger caughtUpChecks = new AtomicInteger();

        List<Map<String, Object>> messages = KafkaAgent.collectPeekedMessages(
            timeout -> {
                polls.incrementAndGet();
                return batch;
            },
            () -> caughtUpChecks.getAndIncrement() > 0,
            record -> record.offset() < 10L,
            List.of(tp),
            2,
            1_000,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals(1, polls.get());
        assertEquals(1, messages.size());
        assertEquals(9L, messages.get(0).get("offset"));
    }

    @Test
    void peekCollectsFromEveryPartitionBeforeTrimming() {
        TopicPartition p0 = new TopicPartition("events", 0);
        TopicPartition p1 = new TopicPartition("events", 1);
        ConsumerRecords<String, byte[]> batch = new ConsumerRecords<>(Map.of(
            p0, List.of(
                new ConsumerRecord<>("events", 0, 9L, "p0-first", "one".getBytes(StandardCharsets.UTF_8)),
                new ConsumerRecord<>("events", 0, 10L, "p0-second", "two".getBytes(StandardCharsets.UTF_8))
            ),
            p1, List.of(
                new ConsumerRecord<>("events", 1, 7L, "p1-first", "three".getBytes(StandardCharsets.UTF_8))
            )
        ));
        AtomicInteger polls = new AtomicInteger();

        List<Map<String, Object>> messages = KafkaAgent.collectPeekedMessages(
            timeout -> polls.getAndIncrement() == 0 ? batch : ConsumerRecords.empty(),
            () -> polls.get() > 0,
            record -> true,
            List.of(p0, p1),
            1,
            1_000,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals(2, messages.size());
        assertTrue(messages.stream().anyMatch(message -> message.get("partition").equals(0)));
        assertTrue(messages.stream().anyMatch(message -> message.get("partition").equals(1)));
    }

    @Test
    void peekWaitsForEveryPartitionWindowWhenOnePartitionRespondsFirst() {
        TopicPartition p0 = new TopicPartition("events", 0);
        TopicPartition p1 = new TopicPartition("events", 1);
        ConsumerRecords<String, byte[]> firstPartition = new ConsumerRecords<>(Map.of(p0, List.of(
            new ConsumerRecord<>("events", 0, 0L, "p0-first", "one".getBytes(StandardCharsets.UTF_8)),
            new ConsumerRecord<>("events", 0, 1L, "p0-second", "two".getBytes(StandardCharsets.UTF_8))
        )));
        ConsumerRecords<String, byte[]> secondPartition = new ConsumerRecords<>(Map.of(p1, List.of(
            new ConsumerRecord<>("events", 1, 0L, "p1-first", "three".getBytes(StandardCharsets.UTF_8))
        )));
        AtomicInteger polls = new AtomicInteger();

        List<Map<String, Object>> messages = KafkaAgent.collectPeekedMessages(
            timeout -> polls.getAndIncrement() == 0 ? firstPartition : secondPartition,
            () -> polls.get() >= 2,
            ignored -> true,
            List.of(p0, p1),
            1,
            1_000,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals(2, polls.get());
        assertEquals(2, messages.size());
        assertTrue(messages.stream().anyMatch(message -> message.get("partition").equals(0)));
        assertTrue(messages.stream().anyMatch(message -> message.get("partition").equals(1)));
    }

    @Test
    void peekRetainsRecordsReadBeforeTheScanLimit() {
        TopicPartition partition = new TopicPartition("events", 0);
        ConsumerRecords<String, byte[]> batch = new ConsumerRecords<>(Map.of(partition, List.of(
            new ConsumerRecord<>("events", 0, 9L, "first", "one".getBytes(StandardCharsets.UTF_8)),
            new ConsumerRecord<>("events", 0, 10L, "second", "two".getBytes(StandardCharsets.UTF_8))
        )));

        List<Map<String, Object>> messages = KafkaAgent.collectPeekedMessages(
            timeout -> batch,
            () -> false,
            record -> true,
            List.of(partition),
            2,
            1,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals(1, messages.size());
        assertEquals(9L, messages.get(0).get("offset"));
    }

    @Test
    void peekCountsSparseOffsetsAsRecordsInsteadOfOffsetWindowWidth() {
        TopicPartition partition = new TopicPartition("events", 0);
        // A compacted topic can retain these two records while offsets 1..9 are absent.
        ConsumerRecords<String, byte[]> batch = new ConsumerRecords<>(Map.of(partition, List.of(
            new ConsumerRecord<>("events", 0, 0L, "first", "one".getBytes(StandardCharsets.UTF_8)),
            new ConsumerRecord<>("events", 0, 10L, "second", "two".getBytes(StandardCharsets.UTF_8))
        )));
        AtomicInteger polls = new AtomicInteger();

        List<Map<String, Object>> messages = KafkaAgent.collectPeekedMessages(
            timeout -> polls.getAndIncrement() == 0 ? batch : ConsumerRecords.empty(),
            () -> polls.get() > 0,
            record -> true,
            List.of(partition),
            5,
            1_000,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals(2, messages.size());
        assertEquals(0L, messages.get(0).get("offset"));
        assertEquals(10L, messages.get(1).get("offset"));
    }

    @Test
    void peekHandlesKafkaHeadersWithNullValues() {
        TopicPartition partition = new TopicPartition("events", 0);
        ConsumerRecord<String, byte[]> record = new ConsumerRecord<>(
            "events", 0, 0L, "key", "value".getBytes(StandardCharsets.UTF_8)
        );
        record.headers().add("tombstone", null);
        ConsumerRecords<String, byte[]> batch = new ConsumerRecords<>(Map.of(partition, List.of(record)));
        AtomicInteger polls = new AtomicInteger();

        List<Map<String, Object>> messages = KafkaAgent.collectPeekedMessages(
            timeout -> {
                polls.incrementAndGet();
                return batch;
            },
            () -> polls.get() > 0,
            ignored -> true,
            List.of(partition),
            1,
            1_000,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals("", ((Map<?, ?>) messages.get(0).get("headers")).get("tombstone"));
    }

    @Test
    void incompleteCollectCanBeReturnedWithAnExplicitStatus() {
        TopicPartition partition = new TopicPartition("events", 0);
        ConsumerRecords<String, byte[]> batch = new ConsumerRecords<>(Map.of(partition, List.of(
            new ConsumerRecord<>("events", 0, 0L, "only", "one".getBytes(StandardCharsets.UTF_8))
        )));

        List<Map<String, Object>> partial = KafkaAgent.collectPeekedMessages(
            timeout -> batch,
            () -> false,
            record -> true,
            List.of(partition),
            5,
            1_000,
            System.nanoTime() - 1,
            Duration.ofMillis(1)
        );

        assertEquals(0, partial.size());
        Map<String, Object> result = KafkaAgent.peekMessagesResult(partial, true);
        assertEquals(true, result.get("incomplete"));
    }

    @Test
    void appliesKerberosKafkaProperties() {
        Properties props = new Properties();
        KafkaAgent.applyConnectionProperties(JsonParser.parseString("""
            {
              "security_protocol": "SASL_SSL",
              "sasl_mechanism": "GSSAPI",
              "properties": {
                "sasl.jaas.config": "com.sun.security.auth.module.Krb5LoginModule required useKeyTab=true keyTab=\\"/tmp/user.keytab\\" principal=\\"user@EXAMPLE.COM\\";",
                "sasl.kerberos.service.name": "kafka"
              }
            }
            """).getAsJsonObject(), props);

        assertEquals("SASL_SSL", props.getProperty("security.protocol"));
        assertEquals("GSSAPI", props.getProperty("sasl.mechanism"));
        assertEquals("kafka", props.getProperty("sasl.kerberos.service.name"));
        assertEquals(
            "com.sun.security.auth.module.Krb5LoginModule required useKeyTab=true keyTab=\"/tmp/user.keytab\" principal=\"user@EXAMPLE.COM\";",
            props.getProperty("sasl.jaas.config")
        );
    }

    @Test
    void appliesAllowedKerberosSystemPropertiesFromConnectionProperties() {
        Map<String, String> previous = KafkaAgent.applyKerberosSystemProperties(JsonParser.parseString("""
            {
              "properties": {
                "java.security.krb5.conf": "/tmp/krb5.conf",
                "sun.security.krb5.debug": "true",
                "custom.system.property": "should-not-leak"
              }
            }
            """).getAsJsonObject());
        try {
            assertEquals("/tmp/krb5.conf", System.getProperty("java.security.krb5.conf"));
            assertEquals("true", System.getProperty("sun.security.krb5.debug"));
            assertNull(System.getProperty("custom.system.property"));
        } finally {
            KafkaAgent.restoreKerberosSystemProperties(previous);
        }
    }

    @Test
    void clearsPreviousKerberosSystemPropertiesForNextConnection() {
        String baseline = System.getProperty("java.security.krb5.conf");
        Map<String, String> previous = KafkaAgent.applyKerberosSystemProperties(JsonParser.parseString("""
            {
              "properties": {
                "java.security.krb5.conf": "/tmp/cluster-a.krb5.conf"
              }
            }
            """).getAsJsonObject());
        try {
            assertEquals("/tmp/cluster-a.krb5.conf", System.getProperty("java.security.krb5.conf"));

            Map<String, String> beforeSecondConnection = KafkaAgent.applyKerberosSystemProperties(JsonParser.parseString("""
                {
                  "properties": {
                    "sasl.kerberos.service.name": "kafka"
                  }
                }
                """).getAsJsonObject());
            try {
                assertEquals(baseline, System.getProperty("java.security.krb5.conf"));
            } finally {
                KafkaAgent.restoreKerberosSystemProperties(beforeSecondConnection);
            }
        } finally {
            KafkaAgent.restoreKerberosSystemProperties(previous);
        }
    }

    @Test
    void restoresKerberosSystemPropertiesWhenTestConnectionClientConstructionFails() {
        String previous = System.getProperty("java.security.krb5.conf");
        try {
            String response = KafkaAgent.handleRequest("""
                {
                  "jsonrpc": "2.0",
                  "id": 42,
                  "method": "test_connection",
                  "params": {
                    "connection": {
                      "bootstrap_servers": "",
                      "properties": {
                        "java.security.krb5.conf": "/tmp/leaked-test-connection.krb5.conf"
                      }
                    }
                  }
                }
                """);

            assertEquals(-1, JsonParser.parseString(response).getAsJsonObject()
                .getAsJsonObject("error").get("code").getAsInt());
            assertEquals(previous, System.getProperty("java.security.krb5.conf"));
        } finally {
            if (previous == null) {
                System.clearProperty("java.security.krb5.conf");
            } else {
                System.setProperty("java.security.krb5.conf", previous);
            }
        }
    }

    private static JsonObject broker(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    private static Map<String, String> preserveSystemProperties(String... keys) {
        Map<String, String> previous = new HashMap<>();
        for (String key : keys) previous.put(key, System.getProperty(key));
        return previous;
    }

    private static void restoreSystemProperties(Map<String, String> properties) {
        for (Map.Entry<String, String> entry : properties.entrySet()) {
            if (entry.getValue() == null) {
                System.clearProperty(entry.getKey());
            } else {
                System.setProperty(entry.getKey(), entry.getValue());
            }
        }
    }
}
