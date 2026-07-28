package com.dbx.agent.kafka;

import com.google.gson.JsonObject;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.Collections;
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
            () -> false,
            1,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals(2, polls.get());
        assertEquals(1, messages.size());
        assertEquals(7L, messages.get(0).get("offset"));
        assertEquals("hello", messages.get(0).get("payloadText"));
    }

    @Test
    void collectPeekedMessagesStopsOnEmptyPollWhenCaughtUp() {
        AtomicInteger polls = new AtomicInteger();
        List<Map<String, Object>> messages = KafkaAgent.collectPeekedMessages(
            timeout -> {
                polls.incrementAndGet();
                return ConsumerRecords.empty();
            },
            () -> true,
            10,
            System.nanoTime() + Duration.ofSeconds(5).toNanos(),
            Duration.ofMillis(1)
        );

        assertEquals(1, polls.get());
        assertTrue(messages.isEmpty());
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
