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
import java.security.KeyStore;
import java.security.cert.X509Certificate;
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
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.admin.AlterConfigOp;
import org.apache.kafka.clients.admin.Config;
import org.apache.kafka.clients.admin.ConfigEntry;
import org.apache.kafka.clients.admin.RaftVoterEndpoint;
import org.apache.kafka.clients.admin.TopicDescription;
import org.apache.kafka.clients.admin.TopicListing;
import org.apache.kafka.common.Node;
import org.apache.kafka.common.PartitionInfo;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.TopicPartitionInfo;
import org.apache.kafka.common.Uuid;
import org.apache.kafka.common.errors.UnsupportedVersionException;
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
    void consumerGroupSnapshotCalculatesLagAndSortsTopicsAndPartitions() {
        TopicPartition alphaOne = new TopicPartition("alpha", 1);
        TopicPartition alphaZero = new TopicPartition("alpha", 0);
        TopicPartition betaZero = new TopicPartition("beta", 0);

        Map<String, Object> group = KafkaAgent.consumerGroupSnapshotRow(
            "orders-service",
            "STABLE",
            false,
            2,
            Arrays.asList(betaZero, alphaOne, alphaZero),
            Map.of(
                alphaZero, new OffsetAndMetadata(8),
                alphaOne, new OffsetAndMetadata(20),
                betaZero, new OffsetAndMetadata(5)
            ),
            true,
            Map.of(alphaZero, 10L, alphaOne, 24L, betaZero, 6L),
            Collections.emptyList()
        );

        assertEquals(List.of("alpha", "beta"), group.get("topics"));
        assertEquals(7L, group.get("totalLag"));
        assertEquals(true, group.get("lagAvailable"));
        assertEquals(2, group.get("memberCount"));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> partitions = (List<Map<String, Object>>) group.get("partitions");
        assertEquals(
            List.of("alpha:0", "alpha:1", "beta:0"),
            partitions.stream()
                .map(partition -> partition.get("topic") + ":" + partition.get("partition"))
                .toList()
        );
    }

    @Test
    void consumerGroupSnapshotDoesNotReportUnknownLagAsZero() {
        TopicPartition assignedOnly = new TopicPartition("orders", 0);
        Map<String, Object> group = KafkaAgent.consumerGroupSnapshotRow(
            "new-consumer",
            "EMPTY",
            false,
            0,
            Collections.singletonList(assignedOnly),
            Collections.emptyMap(),
            true,
            Collections.singletonMap(assignedOnly, 42L),
            Collections.emptyList()
        );

        assertEquals(false, group.get("lagAvailable"));
        assertNull(group.get("totalLag"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> partitions = (List<Map<String, Object>>) group.get("partitions");
        assertNull(partitions.get(0).get("currentOffset"));
        assertNull(partitions.get(0).get("lag"));
    }

    @Test
    void consumerGroupSnapshotPreservesPartialFailuresWithoutInventingLag() {
        TopicPartition partition = new TopicPartition("orders", 0);
        Map<String, Object> group = KafkaAgent.consumerGroupSnapshotRow(
            "orders-service",
            "UNKNOWN",
            false,
            null,
            Collections.emptyList(),
            Collections.singletonMap(partition, new OffsetAndMetadata(9)),
            true,
            Collections.emptyMap(),
            Collections.singletonList("End offsets unavailable for 1 partition(s)")
        );

        assertEquals(false, group.get("lagAvailable"));
        assertNull(group.get("totalLag"));
        assertNull(group.get("memberCount"));
        assertEquals("End offsets unavailable for 1 partition(s)", group.get("error"));
    }

    @Test
    void consumerGroupListRowsFilterToTheRequestedTopicAndSortByPartition() {
        Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
        offsets.put(new TopicPartition("orders", 2), new OffsetAndMetadata(20));
        offsets.put(new TopicPartition("payments", 0), new OffsetAndMetadata(5));
        offsets.put(new TopicPartition("orders", 0), new OffsetAndMetadata(8));

        List<Map<String, Object>> rows = KafkaAgent.offsetRows(offsets, "orders");

        assertEquals(List.of("orders:0", "orders:2"), rows.stream()
            .map(row -> row.get("topic") + ":" + row.get("partition"))
            .toList());
        assertEquals(8L, rows.get(0).get("offset"));
        assertEquals(20L, rows.get(1).get("offset"));
    }

    @Test
    void consumerGroupListRowsKeepEveryPartitionWithoutATopicFilter() {
        Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
        offsets.put(new TopicPartition("orders", 0), new OffsetAndMetadata(8));
        offsets.put(new TopicPartition("payments", 1), new OffsetAndMetadata(3));

        List<Map<String, Object>> rows = KafkaAgent.offsetRows(offsets, "");

        assertEquals(2, rows.size());
    }

    @Test
    void consumerGroupListEndOffsetRowsSkipPartitionsWithoutResolvedEndOffsets() {
        Map<TopicPartition, OffsetAndMetadata> committed = new HashMap<>();
        committed.put(new TopicPartition("orders", 0), new OffsetAndMetadata(8));
        committed.put(new TopicPartition("orders", 1), new OffsetAndMetadata(20));
        Map<TopicPartition, Long> endOffsets = new HashMap<>();
        endOffsets.put(new TopicPartition("orders", 1), 24L);

        List<Map<String, Object>> rows = KafkaAgent.endOffsetRows(committed, endOffsets, "orders");

        assertEquals(List.of("orders:1"), rows.stream()
            .map(row -> row.get("topic") + ":" + row.get("partition"))
            .toList());
        assertEquals(24L, rows.get(0).get("offset"));
    }

    @Test
    void consumerGroupListEndOffsetRowsFilterToTheRequestedTopic() {
        Map<TopicPartition, OffsetAndMetadata> committed = new HashMap<>();
        committed.put(new TopicPartition("orders", 0), new OffsetAndMetadata(8));
        committed.put(new TopicPartition("payments", 0), new OffsetAndMetadata(4));
        Map<TopicPartition, Long> endOffsets = new HashMap<>();
        endOffsets.put(new TopicPartition("orders", 0), 10L);
        endOffsets.put(new TopicPartition("payments", 0), 9L);

        List<Map<String, Object>> rows = KafkaAgent.endOffsetRows(committed, endOffsets, "orders");

        assertEquals(List.of("orders:0"), rows.stream()
            .map(row -> row.get("topic") + ":" + row.get("partition"))
            .toList());
    }

    @Test
    void explicitConsumerGroupOffsetsAcceptOneBoundedPartitionOffset() {
        JsonObject params = JsonParser.parseString("""
            {"offsets":[{"partition":1,"offset":42}]}
            """).getAsJsonObject();

        assertEquals(
            Map.of(new TopicPartition("events", 1), new org.apache.kafka.clients.consumer.OffsetAndMetadata(42L)),
            KafkaAgent.explicitConsumerGroupOffsets(params, "events")
        );
    }

    @Test
    void explicitConsumerGroupOffsetsRejectMalformedOrNegativeValues() {
        for (String json : List.of(
            "{\"offsets\":[{\"partition\":-1,\"offset\":42}]}",
            "{\"offsets\":[{\"partition\":1,\"offset\":-1}]}",
            "{\"offsets\":[{\"partition\":1.5,\"offset\":42}]}",
            "{\"offsets\":[{\"partition\":1,\"offset\":42.5}]}",
            "{\"offsets\":[{\"partition\":\"1\",\"offset\":42}]}",
            "{\"offsets\":[{\"partition\":1,\"offset\":\"42\"}]}",
            "{\"offsets\":[{\"partition\":1}]}",
            "{\"offsets\":[42]}",
            "{\"offsets\":[{\"partition\":2147483648,\"offset\":42}]}",
            "{\"offsets\":[{\"partition\":1,\"offset\":9223372036854775808}]}",
            "{\"offsets\":[{\"partition\":1,\"offset\":42},{\"partition\":1,\"offset\":43}]}",
            "{\"offsets\":[]}",
            "{\"offsets\":{}}"
        )) {
            JsonObject params = JsonParser.parseString(json).getAsJsonObject();
            assertThrows(IllegalArgumentException.class, () -> KafkaAgent.explicitConsumerGroupOffsets(params, "events"), json);
        }
    }

    @Test
    void topicListingFallsBackWhenDescriptionsAreUnsupported() throws Exception {
        Object result = KafkaAgent.topicListResult(
            Arrays.asList(
                new TopicListing("orders", Uuid.randomUuid(), false),
                new TopicListing("__consumer_offsets", Uuid.randomUuid(), true)
            ),
            names -> {
                throw new ExecutionException(new UnsupportedVersionException("The version of API is not supported."));
            }
        );

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> topics = (List<Map<String, Object>>) ((Map<String, Object>) result).get("topics");
        assertEquals(Arrays.asList("__consumer_offsets", "orders"), topics.stream().map(topic -> topic.get("name")).toList());
        assertEquals(true, topics.get(0).get("internal"));
        assertFalse(topics.get(0).containsKey("partitions"));
        assertFalse(topics.get(1).containsKey("partitions"));
    }

    @Test
    void topicListingFallsBackWhenDescriptionsTimeOut() throws Exception {
        Object result = KafkaAgent.topicListResult(
            Arrays.asList(
                new TopicListing("orders", Uuid.randomUuid(), false),
                new TopicListing("payments", Uuid.randomUuid(), false)
            ),
            names -> {
                throw new java.util.concurrent.TimeoutException("describeTopics timed out");
            }
        );

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> topics = (List<Map<String, Object>>) ((Map<String, Object>) result).get("topics");
        assertEquals(Arrays.asList("orders", "payments"), topics.stream().map(topic -> topic.get("name")).toList());
        assertFalse(topics.get(0).containsKey("partitions"));
        assertFalse(topics.get(1).containsKey("replicationFactor"));
    }

    @Test
    void topicListingPreservesNonVersionDescriptionErrors() {
        IllegalStateException failure = new IllegalStateException("metadata authorization failed");

        IllegalStateException thrown = assertThrows(IllegalStateException.class, () -> KafkaAgent.topicListResult(
            Collections.singletonList(new TopicListing("orders", Uuid.randomUuid(), false)),
            names -> {
                throw failure;
            }
        ));

        assertEquals(failure, thrown);
    }

    @Test
    void topicListingKeepsDescriptionMetadataWhenSupported() throws Exception {
        Node leader = new Node(1, "broker-1", 9092);
        Node replica = new Node(2, "broker-2", 9092);
        TopicDescription description = new TopicDescription(
            "orders",
            false,
            Collections.singletonList(new TopicPartitionInfo(
                0,
                leader,
                Arrays.asList(leader, replica),
                Collections.singletonList(leader)
            ))
        );

        Object result = KafkaAgent.topicListResult(
            Collections.singletonList(new TopicListing("orders", Uuid.randomUuid(), false)),
            names -> Collections.singletonMap("orders", description)
        );

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> topics = (List<Map<String, Object>>) ((Map<String, Object>) result).get("topics");
        assertEquals(1, topics.size());
        assertEquals(1, topics.get(0).get("partitions"));
        assertEquals(2, topics.get(0).get("replicationFactor"));
        assertEquals(false, topics.get(0).get("internal"));
    }

    @Test
    void legacyStatsFallbackRequiresAnUnsupportedVersionException() {
        assertTrue(KafkaAgent.hasUnsupportedVersionException(new ExecutionException(
            new UnsupportedVersionException(
                "MetadataRequest versions older than 4 don't support the allowAutoTopicCreation field"
            )
        )));
        assertFalse(KafkaAgent.hasUnsupportedVersionException(
            new IllegalStateException("broker reports unsupported version text")
        ));
    }

    @Test
    void legacyTopicStatsRequireAnExistingTopicFromAllTopicMetadata() {
        var error = assertThrows(
            org.apache.kafka.common.errors.UnknownTopicOrPartitionException.class,
            () -> KafkaAgent.requireExistingTopic(Collections.singleton("payments"), "orders")
        );

        assertTrue(error.getMessage().contains("orders"));
    }

    @Test
    void legacyTopicStatsConsumerUsesCompatibleMetadataOnlyForConnectedSessions() {
        assertThrows(IllegalStateException.class, () -> KafkaAgent.topicStatsConsumerProperties(null));

        JsonObject connection = new JsonObject();
        connection.addProperty("bootstrap_servers", "legacy-broker:9092");
        Properties properties = KafkaAgent.topicStatsConsumerProperties(connection);

        assertEquals("true", properties.getProperty("allow.auto.create.topics"));
        assertEquals("false", properties.getProperty("enable.auto.commit"));
    }

    @Test
    void legacyTopicStatsPreserveTheExistingStatsShape() {
        Node leader = new Node(1, "broker-1", 9092);
        Node replica = new Node(2, "broker-2", 9092);
        PartitionInfo partition = new PartitionInfo(
            "orders",
            0,
            leader,
            new Node[] { leader, replica },
            new Node[] { leader }
        );
        TopicPartition topicPartition = new TopicPartition("orders", 0);

        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) KafkaAgent.legacyTopicStatsResult(
            "orders",
            Collections.singletonList(partition),
            Collections.singletonMap(topicPartition, 4L),
            Collections.singletonMap(topicPartition, 10L)
        );

        assertEquals("orders", result.get("name"));
        assertEquals(1, result.get("partitions"));
        assertEquals(2, result.get("replicationFactor"));
        assertEquals(6L, result.get("totalMessages"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> partitionStats = (List<Map<String, Object>>) result.get("partitionStats");
        assertEquals(List.of(1, 2), partitionStats.get(0).get("replicas"));
        assertEquals(Collections.singletonList(1), partitionStats.get(0).get("isr"));
        assertEquals(4L, partitionStats.get(0).get("beginOffset"));
        assertEquals(10L, partitionStats.get(0).get("endOffset"));
    }

    @Test
    void topicConfigReturnsAnExplicitUnsupportedMarkerForLegacyBrokers() throws Exception {
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) KafkaAgent.topicConfigResult(() -> {
            throw new ExecutionException(new UnsupportedVersionException(
                "The node does not support DESCRIBE_CONFIGS"
            ));
        });

        assertEquals(Collections.emptyMap(), result.get("configs"));
        assertEquals(false, result.get("configSupported"));
        assertTrue(((String) result.get("unsupportedReason")).contains("DescribeConfigs"));
    }

    @Test
    void topicConfigPreservesModernConfigEntries() throws Exception {
        Config config = new Config(Collections.singletonList(new ConfigEntry("retention.ms", "60000")));

        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) KafkaAgent.topicConfigResult(() -> config);
        @SuppressWarnings("unchecked")
        Map<String, Map<String, Object>> configs = (Map<String, Map<String, Object>>) result.get("configs");

        assertEquals("60000", configs.get("retention.ms").get("value"));
        assertFalse(result.containsKey("configSupported"));
    }

    @Test
    void topicConfigPreservesNonVersionFailures() {
        IllegalStateException failure = new IllegalStateException("broker reports unsupported version text");

        IllegalStateException thrown = assertThrows(
            IllegalStateException.class,
            () -> KafkaAgent.topicConfigResult(() -> {
                throw failure;
            })
        );

        assertEquals(failure, thrown);
    }

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
    void producerDefaultsToLegacyCompatibleNonIdempotentDelivery() {
        JsonObject connection = new JsonObject();
        connection.addProperty("bootstrap_servers", "legacy-broker:9092");

        Properties properties = KafkaAgent.producerProperties(connection);

        assertEquals("all", properties.getProperty(ProducerConfig.ACKS_CONFIG));
        assertEquals("false", properties.getProperty(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG));
    }

    @Test
    void producerAllowsExplicitIdempotenceForModernBrokers() {
        JsonObject extraProperties = new JsonObject();
        extraProperties.addProperty(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true");
        JsonObject connection = new JsonObject();
        connection.addProperty("bootstrap_servers", "modern-broker:9092");
        connection.add("properties", extraProperties);

        Properties properties = KafkaAgent.producerProperties(connection);

        assertEquals("true", properties.getProperty(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG));
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
    void metadataQuorumControllerUsesMatchingBrokerEndpoint() {
        Map<String, Object> controller = KafkaAgent.metadataQuorumControllerToMap(
            1,
            Arrays.asList(
                new Node(1, "broker-1", 9092),
                new Node(2, "broker-2", 9092)
            ),
            Collections.emptyMap()
        );

        assertEquals(1, controller.get("id"));
        assertEquals("broker-1", controller.get("host"));
        assertEquals(9092, controller.get("port"));
    }

    @Test
    void metadataQuorumControllerUsesIsolatedControllerEndpoint() {
        Map<String, Object> controller = KafkaAgent.metadataQuorumControllerToMap(
            9,
            Collections.singletonList(new Node(1, "broker-1", 9092)),
            Collections.singletonMap(
                9,
                Collections.singletonList(new RaftVoterEndpoint("CONTROLLER", "controller-9", 19093))
            )
        );

        assertEquals(9, controller.get("id"));
        assertEquals("controller-9", controller.get("host"));
        assertEquals(19093, controller.get("port"));
    }

    @Test
    void metadataQuorumControllerKeepsLeaderIdWithoutEndpoint() {
        Map<String, Object> controller = KafkaAgent.metadataQuorumControllerToMap(
            9,
            Collections.singletonList(new Node(1, "broker-1", 9092)),
            Collections.emptyMap()
        );

        assertEquals(Collections.singletonMap("id", 9), controller);
    }

    @Test
    void metadataQuorumControllerReturnsNullWithoutLeader() {
        assertNull(KafkaAgent.metadataQuorumControllerToMap(
            -1,
            Collections.singletonList(new Node(1, "broker-1", 9092)),
            Collections.emptyMap()
        ));
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
    void latestPeekReportsWhetherTheGlobalBudgetCanCoverEveryPartitionQuota() {
        assertFalse(KafkaAgent.latestPeekBudgetLimited(20, 50));
        assertTrue(KafkaAgent.latestPeekBudgetLimited(20, 51));
        assertTrue(KafkaAgent.latestPeekBudgetLimited(100, 11));
        assertEquals(4, KafkaAgent.peekMessagesPerPartition(10, 3));
    }

    @Test
    void latestPeekSharesTheGlobalScanBudgetAcrossManyPartitions() {
        assertEquals(20, KafkaAgent.latestPeekMessagesPerPartition(20, 3));
        assertEquals(19, KafkaAgent.latestPeekMessagesPerPartition(20, 51));
        assertEquals(16, KafkaAgent.latestPeekMessagesPerPartition(20, 60));
        assertEquals(10, KafkaAgent.latestPeekMessagesPerPartition(20, 100));
        assertEquals(90, KafkaAgent.latestPeekMessagesPerPartition(100, 11));
        assertEquals(1_000, KafkaAgent.peekScanLimit(
            100, 11, KafkaAgent.PeekStartPosition.LATEST
        ));
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
    void resolvePeekPartitionsRejectsMissingPartitionBeforeOffsetLookup() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.resolvePeekPartitions("events", 5, List.of(0, 1, 2))
        );

        assertEquals(
            "Kafka partition 5 does not exist for topic 'events'. Available partitions: 0, 1, 2",
            error.getMessage()
        );
    }

    @Test
    void resolvePeekPartitionsKeepsRequestedPartitionAfterMetadataLookup() {
        var partitions = KafkaAgent.resolvePeekPartitions("events", 1, List.of(0, 1, 2));

        assertEquals(List.of(1), partitions.stream().map(TopicPartition::partition).toList());
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
        assertEquals(5L, messages.get(1).get("offset"));
        assertEquals(2L, messages.get(2).get("offset"));
        assertEquals(1, messages.get(3).get("partition"));
    }

    @Test
    void latestPeekKeepsTheFullQuotaWhenItFitsTheGlobalScanBudget() {
        assertEquals(1_000, KafkaAgent.peekScanLimit(
            100, 10, KafkaAgent.PeekStartPosition.LATEST
        ));
        assertEquals(100, KafkaAgent.latestPeekMessagesPerPartition(100, 10));
        assertEquals(20, KafkaAgent.latestPeekMessagesPerPartition(20, 50));
    }

    @Test
    void latestPeekRejectsTopicsWhosePartitionCountAloneExceedsTheScanBudget() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            KafkaAgent.latestPeekMessagesPerPartition(20, 1_001)
        );

        assertTrue(error.getMessage().contains("select a partition"));
    }

    @Test
    void latestPeekGloballyMergesInterleavedPartitionTimelinesBeforeLimiting() {
        var messages = new java.util.ArrayList<Map<String, Object>>();
        messages.add(Map.of("timestamp", 101L, "partition", 0, "offset", 8L));
        messages.add(Map.of("timestamp", 105L, "partition", 1, "offset", 3L));
        messages.add(Map.of("timestamp", 103L, "partition", 2, "offset", 9L));
        messages.add(Map.of("timestamp", 104L, "partition", 0, "offset", 9L));
        messages.add(Map.of("timestamp", 102L, "partition", 1, "offset", 2L));

        List<Map<String, Object>> latest = KafkaAgent.sortAndLimitPeekedMessages(
            messages, 3, KafkaAgent.PeekStartPosition.LATEST
        );

        assertEquals(List.of(105L, 104L, 103L), latest.stream()
            .map(message -> ((Number) message.get("timestamp")).longValue())
            .toList());
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
    void skipTlsVerificationDisablesHostnameAndCertificateChainValidation() throws Exception {
        Properties props = new Properties();
        KafkaAgent.applyConnectionProperties(JsonParser.parseString("""
            {
              "security_protocol": "SASL_SSL",
              "tls_skip_verify": true,
              "properties": {
                "ssl.endpoint.identification.algorithm": "https",
                "ssl.trustmanager.algorithm": "PKIX"
              }
            }
            """).getAsJsonObject(), props);

        assertEquals("", props.getProperty("ssl.endpoint.identification.algorithm"));
        assertEquals(
            DbxInsecureTrustManagerFactory.ALGORITHM,
            props.getProperty("ssl.trustmanager.algorithm")
        );

        TrustManagerFactory factory = TrustManagerFactory.getInstance(DbxInsecureTrustManagerFactory.ALGORITHM);
        factory.init((KeyStore) null);
        X509TrustManager trustManager = (X509TrustManager) factory.getTrustManagers()[0];
        assertDoesNotThrow(() -> trustManager.checkServerTrusted(new X509Certificate[0], "RSA"));
    }

    @Test
    void verifiedTlsKeepsKafkaDefaultTrustAndHostnameValidation() {
        Properties props = new Properties();
        KafkaAgent.applyConnectionProperties(JsonParser.parseString("""
            {
              "security_protocol": "SASL_SSL",
              "tls_skip_verify": false
            }
            """).getAsJsonObject(), props);

        assertNull(props.getProperty("ssl.endpoint.identification.algorithm"));
        assertNull(props.getProperty("ssl.trustmanager.algorithm"));
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
