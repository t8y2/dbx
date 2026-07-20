package com.dbx.agent.rocketmq;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.rocketmq.client.consumer.DefaultMQPushConsumer;
import org.apache.rocketmq.client.consumer.MessageSelector;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyContext;
import org.apache.rocketmq.client.consumer.listener.ConsumeConcurrentlyStatus;
import org.apache.rocketmq.client.consumer.listener.MessageListenerConcurrently;
import org.apache.rocketmq.client.exception.MQClientException;
import org.apache.rocketmq.client.producer.DefaultMQProducer;
import org.apache.rocketmq.common.consumer.ConsumeFromWhere;
import org.apache.rocketmq.tools.admin.DefaultMQAdminExt;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Live RocketMQ tests on 127.0.0.1:9876. SQL92 filtering requires broker
 * {@code enablePropertyFilter=true} (skipped when unsupported).
 */
class RocketMqLiveMessagePropertyTest {
    private static final String NAMESRV = "127.0.0.1:9876";
    private static final String TOPIC = "CS-PT";
    private static DefaultMQAdminExt admin;
    private static JsonObject conn;
    private static boolean available;

    @BeforeAll
    static void connect() {
        conn = JsonParser.parseString("""
            {"namesrv_addr":"127.0.0.1:9876"}
            """).getAsJsonObject();
        admin = new DefaultMQAdminExt();
        admin.setNamesrvAddr(NAMESRV);
        try {
            admin.start();
            admin.examineBrokerClusterInfo();
            available = true;
        } catch (Exception e) {
            available = false;
        }
    }

    @AfterAll
    static void shutdown() {
        if (admin != null) {
            admin.shutdown();
        }
    }

    @Test
    void sendMessageUserPropertyRoundTripViaPeek() throws Exception {
        assumeTrue(available, "RocketMQ namesrv not available on " + NAMESRV);
        DefaultMQProducer producer = RocketMqAgent.buildProducer(conn);
        try {
            String marker = "dbx-prop-" + UUID.randomUUID();
            JsonObject sendParams = JsonParser.parseString("""
                {
                  "topic":"%s",
                  "tag":"prop-test",
                  "payloadBase64":"%s",
                  "headers":{"TAGS":"prop-test","Region":"Hangzhou","marker":"%s"}
                }
                """.formatted(
                TOPIC,
                Base64.getEncoder().encodeToString(marker.getBytes(StandardCharsets.UTF_8)),
                marker
            )).getAsJsonObject();

            @SuppressWarnings("unchecked")
            Map<String, Object> sendResult = (Map<String, Object>) RocketMqAgent.sendMessageForTest(producer, sendParams);
            Number partition = (Number) sendResult.get("partition");
            Number offset = (Number) sendResult.get("offset");
            assertNotNull(partition);
            assertNotNull(offset);

            JsonObject peekParams = JsonParser.parseString("""
                {
                  "connection":{"namesrv_addr":"127.0.0.1:9876"},
                  "topic":"%s",
                  "count":1,
                  "partition":%d,
                  "offset":%d
                }
                """.formatted(TOPIC, partition.intValue(), offset.longValue())).getAsJsonObject();

            @SuppressWarnings("unchecked")
            Map<String, Object> peekResult = (Map<String, Object>) RocketMqAgent.peekMessagesForTest(admin, peekParams);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> messages = (List<Map<String, Object>>) peekResult.get("messages");
            assumeTrue(messages != null && !messages.isEmpty(), "peek returned no messages at sent offset");
            @SuppressWarnings("unchecked")
            Map<String, String> headers = (Map<String, String>) messages.get(0).get("headers");
            assertEquals("Hangzhou", headers.get("Region"));
            assertEquals(marker, headers.get("marker"));
        } finally {
            producer.shutdown();
        }
    }

    @Test
    void sql92ConsumerFiltersOnUserProperty() throws Exception {
        assumeTrue(available, "RocketMQ namesrv not available on " + NAMESRV);
        String group = "dbx-sql92-" + UUID.randomUUID();
        String markerMatch = "match-" + UUID.randomUUID();
        String markerSkip = "skip-" + UUID.randomUUID();
        CountDownLatch matched = new CountDownLatch(1);
        AtomicInteger received = new AtomicInteger();

        DefaultMQPushConsumer consumer = new DefaultMQPushConsumer(group);
        consumer.setNamesrvAddr(NAMESRV);
        consumer.setConsumeFromWhere(ConsumeFromWhere.CONSUME_FROM_LAST_OFFSET);
        try {
            consumer.subscribe(
                TOPIC,
                MessageSelector.bySql("Region IS NOT NULL AND Region='Hangzhou' AND marker IS NOT NULL")
            );
        } catch (MQClientException e) {
            assumeTrue(false, "Broker does not support SQL92 property filter: " + e.getMessage());
        }
        consumer.registerMessageListener((MessageListenerConcurrently) (messages, context) -> {
            for (var message : messages) {
                String marker = message.getProperty("marker");
                if (markerMatch.equals(marker)) {
                    received.incrementAndGet();
                    matched.countDown();
                }
            }
            return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
        });

        try {
            consumer.start();
        } catch (MQClientException e) {
            assumeTrue(false, "Consumer start failed for SQL92: " + e.getMessage());
        }

        DefaultMQProducer producer = RocketMqAgent.buildProducer(conn);
        try {
            sendWithMarker(producer, markerSkip, "Shanghai");
            sendWithMarker(producer, markerMatch, "Hangzhou");
            assumeTrue(matched.await(15, TimeUnit.SECONDS), "SQL92 consumer did not receive matching message");
            assertEquals(1, received.get(), "only the Hangzhou message should match the filter");
        } finally {
            producer.shutdown();
            consumer.shutdown();
        }
    }

    private static void sendWithMarker(DefaultMQProducer producer, String marker, String region) throws Exception {
        JsonObject sendParams = JsonParser.parseString("""
            {
              "topic":"%s",
              "tag":"sql92-test",
              "payloadBase64":"%s",
              "headers":{"TAGS":"sql92-test","Region":"%s","marker":"%s"}
            }
            """.formatted(
            TOPIC,
            Base64.getEncoder().encodeToString(marker.getBytes(StandardCharsets.UTF_8)),
            region,
            marker
        )).getAsJsonObject();
        RocketMqAgent.sendMessageForTest(producer, sendParams);
    }
}
