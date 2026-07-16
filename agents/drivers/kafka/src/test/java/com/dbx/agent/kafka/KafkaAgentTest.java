package com.dbx.agent.kafka;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.common.TopicPartition;
import org.junit.jupiter.api.Test;

class KafkaAgentTest {
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
}
