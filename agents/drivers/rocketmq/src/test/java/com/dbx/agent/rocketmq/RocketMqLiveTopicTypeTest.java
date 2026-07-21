package com.dbx.agent.rocketmq;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.List;
import java.util.Map;
import org.apache.rocketmq.common.TopicConfig;
import org.apache.rocketmq.remoting.protocol.body.TopicConfigSerializeWrapper;
import org.apache.rocketmq.tools.admin.DefaultMQAdminExt;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Live verification against local RocketMQ (127.0.0.1:9876). Skipped when namesrv is unavailable.
 */
class RocketMqLiveTopicTypeTest {
    private static DefaultMQAdminExt admin;
    private static boolean available;

    @BeforeAll
    static void connect() {
        admin = new DefaultMQAdminExt();
        admin.setNamesrvAddr("127.0.0.1:9876");
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
    void cs123BrokerConfigHasNormalMessageType() throws Exception {
        assumeTrue(available, "RocketMQ namesrv not available on 127.0.0.1:9876");
        JsonObject conn = JsonParser.parseString("""
            {"namesrv_addr":"127.0.0.1:9876"}
            """).getAsJsonObject();
        String brokerAddr = RocketMqAgent.remapBrokerAddrForClient(
            admin.examineBrokerClusterInfo().getBrokerAddrTable().values().iterator().next().selectBrokerAddr(),
            conn);
        TopicConfig config = admin.examineTopicConfig(brokerAddr, "CS123");
        assumeTrue(config != null, "CS123 topic config missing");
        String fromAttributes = config.getAttributes() == null ? null : config.getAttributes().get("message.type");
        assertEquals("NORMAL", fromAttributes, "attributes.message.type");
    }

    @Test
    void getAllTopicConfigIncludesCs123MessageType() throws Exception {
        assumeTrue(available, "RocketMQ namesrv not available on 127.0.0.1:9876");
        JsonObject conn = JsonParser.parseString("""
            {"namesrv_addr":"127.0.0.1:9876"}
            """).getAsJsonObject();
        String brokerAddr = RocketMqAgent.remapBrokerAddrForClient(
            admin.examineBrokerClusterInfo().getBrokerAddrTable().values().iterator().next().selectBrokerAddr(),
            conn);
        TopicConfigSerializeWrapper wrapper = admin.getAllTopicConfig(brokerAddr, 10_000L);
        TopicConfig config = wrapper.getTopicConfigTable().get("CS123");
        assumeTrue(config != null, "CS123 missing from getAllTopicConfig");
        String fromAttributes = config.getAttributes() == null ? null : config.getAttributes().get("message.type");
        assertEquals("NORMAL", fromAttributes, "bulk attributes.message.type");
    }

    @Test
    void agentListTopicsClassifiesAllTopicsAgainstBroker() throws Exception {
        assumeTrue(available, "RocketMQ namesrv not available on 127.0.0.1:9876");
        JsonObject params = JsonParser.parseString("""
            {"connection":{"namesrv_addr":"127.0.0.1:9876"},"limit":500,"offset":0}
            """).getAsJsonObject();
        Object result = RocketMqAgent.listTopicsWithAdminForTest(admin, params);
        assumeTrue(result instanceof Map, "unexpected listTopics result");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> topics = (List<Map<String, Object>>) ((Map<?, ?>) result).get("topics");
        assumeTrue(topics != null && !topics.isEmpty(), "no topics returned");

        Map<String, Object> cs123 = topics.stream()
            .filter(row -> "CS123".equals(String.valueOf(row.get("name"))))
            .findFirst()
            .orElse(null);
        assumeTrue(cs123 != null, "CS123 not in agent topic list");
        assertEquals("NORMAL", String.valueOf(cs123.get("messageType")), "agent messageType for CS123");

        Map<String, String> expected = Map.ofEntries(
            Map.entry("CS123", "NORMAL"),
            Map.entry("BenchmarkTest", "SYSTEM"),
            Map.entry("SCHEDULE_TOPIC_XXXX", "SYSTEM"),
            Map.entry("RMQ_SYS_TRANS_HALF_TOPIC", "SYSTEM"),
            Map.entry("RMQ_SYS_TRANS_OP_HALF_TOPIC", "SYSTEM"),
            Map.entry("RMQ_SYS_ROCKSDB_TRANS_HALF_TOPIC", "SYSTEM"),
            Map.entry("RMQ_SYS_ROCKSDB_TRANS_OP_HALF_TOPIC", "SYSTEM"),
            Map.entry("rmq_sys_wheel_timer", "SYSTEM"),
            Map.entry("rmq_sys_REVIVE_LOG_DefaultCluster", "SYSTEM"),
            Map.entry("rmq_sys_SYNC_BROKER_MEMBER_37e06a7b803c", "SYSTEM"),
            Map.entry("rmq_sys_SYNC_BROKER_MEMBER_broker-a", "SYSTEM"),
            Map.entry("DefaultHeartBeatSyncerTopic", "SYSTEM"),
            Map.entry("DefaultCluster_REPLY_TOPIC", "SYSTEM"),
            Map.entry("SELF_TEST_TOPIC", "SYSTEM"),
            Map.entry("OFFSET_MOVED_EVENT", "SYSTEM"),
            Map.entry("TBW102", "SYSTEM"),
            Map.entry("DefaultCluster", "SYSTEM"),
            Map.entry("broker-a", "SYSTEM"),
            Map.entry("37e06a7b803c", "UNSPECIFIED"),
            Map.entry("%RETRY%CID_DefaultHeartBeatSyncerTopic", "RETRY")
        );

        for (Map<String, Object> row : topics) {
            String name = String.valueOf(row.get("name"));
            String messageType = String.valueOf(row.get("messageType"));
            if (expected.containsKey(name)) {
                assertEquals(expected.get(name), messageType, "messageType for " + name);
            }
        }
    }
}
