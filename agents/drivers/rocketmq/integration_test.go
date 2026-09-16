package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

type integrationTopicList struct {
	Topics []struct {
		Name           string `json:"name"`
		Partitions     int    `json:"partitions"`
		ReadQueueNums  int    `json:"readQueueNums"`
		WriteQueueNums int    `json:"writeQueueNums"`
		MessageType    string `json:"messageType"`
	} `json:"topics"`
}

type integrationTopicConfig struct {
	Configs map[string]struct {
		Value string `json:"value"`
	} `json:"configs"`
}

type integrationMessages struct {
	Messages []struct {
		MessageID   string            `json:"messageId"`
		Partition   int               `json:"partition"`
		Offset      int64             `json:"offset"`
		PayloadText string            `json:"payloadText"`
		Headers     map[string]string `json:"headers"`
	} `json:"messages"`
}

type integrationLag struct {
	TotalLag int64 `json:"totalLag"`
}

type integrationConsumerGroups struct {
	Groups []struct {
		GroupID   string `json:"groupId"`
		GroupType string `json:"groupType"`
	} `json:"groups"`
}

func TestRocketMQIntegration(t *testing.T) {
	if os.Getenv("ROCKETMQ_INTEGRATION") != "1" {
		t.Skip("set ROCKETMQ_INTEGRATION=1 to run against a real RocketMQ broker")
	}
	nameServer := envString("ROCKETMQ_NAMESRV_ADDR", "127.0.0.1:9876")
	version := envString("ROCKETMQ_VERSION", "unknown")
	agent := newRocketMQAgent()
	t.Cleanup(agent.close)
	connection := map[string]any{
		"namesrv_addr": nameServer, "request_timeout_ms": 20_000, "connect_timeout_ms": 20_000,
	}

	var connectionResult struct {
		OK        bool `json:"ok"`
		NodeCount int  `json:"nodeCount"`
	}
	integrationCall(t, agent, "test_connection", map[string]any{"connection": connection}, &connectionResult)
	if !connectionResult.OK || connectionResult.NodeCount < 1 {
		t.Fatalf("unexpected test connection result: %#v", connectionResult)
	}
	integrationCall(t, agent, "connect", map[string]any{"connection": connection}, &connectionResult)
	if !connectionResult.OK || connectionResult.NodeCount < 1 {
		t.Fatalf("unexpected connection result: %#v", connectionResult)
	}

	var cluster struct {
		ClusterID string `json:"clusterId"`
		NodeCount int    `json:"nodeCount"`
		Brokers   []any  `json:"brokers"`
	}
	integrationCall(t, agent, "mq_describe_cluster", map[string]any{}, &cluster)
	if cluster.ClusterID == "" || cluster.NodeCount < 1 || len(cluster.Brokers) < 1 {
		t.Fatalf("unexpected cluster result: %#v", cluster)
	}

	suffix := fmt.Sprintf("%s_%d", strings.ReplaceAll(version, ".", "_"), time.Now().UnixNano())
	topic := "DBX_GO_INTEGRATION_" + suffix
	groupID := "GID_DBX_GO_" + suffix
	t.Cleanup(func() {
		integrationCleanupCall(agent, "mq_delete_consumer_group", map[string]any{"groupId": groupID})
		integrationCleanupCall(agent, "mq_delete_topic", map[string]any{"name": topic})
	})

	integrationCall[map[string]any](t, agent, "mq_create_topic", map[string]any{
		"name": topic, "readQueueNums": 2, "writeQueueNums": 2, "perm": 6, "messageType": "NORMAL",
	}, nil)

	var route struct {
		Topic       string `json:"topic"`
		BrokerDatas []any  `json:"brokerDatas"`
		QueueDatas  []struct {
			ReadQueueNums  int `json:"readQueueNums"`
			WriteQueueNums int `json:"writeQueueNums"`
		} `json:"queueDatas"`
	}
	integrationCall(t, agent, "mq_get_topic_route", map[string]any{"name": topic}, &route)
	if route.Topic != topic || len(route.BrokerDatas) == 0 || len(route.QueueDatas) == 0 {
		t.Fatalf("unexpected route: %#v", route)
	}
	if route.QueueDatas[0].ReadQueueNums != 2 || route.QueueDatas[0].WriteQueueNums != 2 {
		t.Fatalf("unexpected initial route queues: %#v", route.QueueDatas)
	}
	var topicsAfterCreate integrationTopicList
	integrationCall(t, agent, "mq_list_topics", map[string]any{"keyword": topic, "limit": 10}, &topicsAfterCreate)
	if len(topicsAfterCreate.Topics) != 1 || topicsAfterCreate.Topics[0].Name != topic {
		t.Fatalf("unexpected topic list after creation: %#v", topicsAfterCreate.Topics)
	}
	createdTopic := topicsAfterCreate.Topics[0]
	if createdTopic.Partitions != 2 || createdTopic.ReadQueueNums != 2 || createdTopic.WriteQueueNums != 2 {
		t.Fatalf("unexpected created topic queues: %#v", createdTopic)
	}
	if strings.HasPrefix(version, "5.") && createdTopic.MessageType != "NORMAL" {
		t.Fatalf("RocketMQ %s lost the 5.x message.type attribute: %#v", version, createdTopic)
	}

	var topicConfig integrationTopicConfig
	integrationCall(t, agent, "mq_get_topic_config", map[string]any{"name": topic}, &topicConfig)
	if topicConfig.Configs["readQueueNums"].Value != "2" || topicConfig.Configs["writeQueueNums"].Value != "2" {
		t.Fatalf("unexpected topic config: %#v", topicConfig)
	}
	integrationCall[map[string]any](t, agent, "mq_update_partitions", map[string]any{
		"name": topic, "readQueueNums": 3, "writeQueueNums": 2,
	}, nil)
	integrationCall(t, agent, "mq_get_topic_config", map[string]any{"name": topic}, &topicConfig)
	if topicConfig.Configs["readQueueNums"].Value != "3" || topicConfig.Configs["writeQueueNums"].Value != "2" {
		t.Fatalf("unexpected topic config after partition update: %#v", topicConfig)
	}
	integrationCall[map[string]any](t, agent, "mq_alter_topic_config", map[string]any{
		"name": topic,
		"configs": []map[string]any{
			{"key": "readQueueNums", "value": "4"},
			{"key": "writeQueueNums", "value": "3"},
			{"key": "perm", "value": "6"},
		},
	}, nil)
	integrationCall(t, agent, "mq_get_topic_config", map[string]any{"name": topic}, &topicConfig)
	if topicConfig.Configs["readQueueNums"].Value != "4" || topicConfig.Configs["writeQueueNums"].Value != "3" || topicConfig.Configs["perm"].Value != "6" {
		t.Fatalf("unexpected topic config after alteration: %#v", topicConfig)
	}
	if strings.HasPrefix(version, "5.") {
		var topicsAfterAlter integrationTopicList
		integrationCall(t, agent, "mq_list_topics", map[string]any{"keyword": topic, "limit": 10}, &topicsAfterAlter)
		if len(topicsAfterAlter.Topics) != 1 || topicsAfterAlter.Topics[0].MessageType != "NORMAL" {
			t.Fatalf("RocketMQ %s lost message.type after config updates: %#v", version, topicsAfterAlter.Topics)
		}
	}

	payload := "RocketMQ Go Agent 世界 " + version
	var sendResult struct {
		OK        bool  `json:"ok"`
		Partition int   `json:"partition"`
		Offset    int64 `json:"offset"`
	}
	integrationCall(t, agent, "mq_send_message", map[string]any{
		"topic": topic, "partition": 0, "key": "dbx-integration-key", "tag": "dbx-integration",
		"payloadBase64": base64.StdEncoding.EncodeToString([]byte(payload)),
		"headers":       map[string]any{"source": "integration", "empty": "", "nil": nil},
	}, &sendResult)
	if !sendResult.OK || sendResult.Partition != 0 || sendResult.Offset < 0 {
		t.Fatalf("unexpected send result: %#v", sendResult)
	}

	peeked := waitForIntegrationMessages(t, agent, "mq_peek_messages", map[string]any{
		"topic": topic, "partition": 0, "count": 10,
	})
	if peeked.Messages[0].PayloadText != payload || peeked.Messages[0].Headers["source"] != "integration" {
		t.Fatalf("unexpected peeked message: %#v", peeked.Messages[0])
	}
	if _, ok := peeked.Messages[0].Headers["empty"]; ok {
		t.Fatalf("empty user property should be omitted: %#v", peeked.Messages[0].Headers)
	}
	if peeked.Messages[0].MessageID == "" {
		t.Fatalf("peeked message has no message ID: %#v", peeked.Messages[0])
	}

	var viewed struct {
		Message struct {
			MessageID   string `json:"messageId"`
			PayloadText string `json:"payloadText"`
		} `json:"message"`
	}
	integrationCall(t, agent, "mq_view_message", map[string]any{
		"topic": topic, "msgId": peeked.Messages[0].MessageID,
		"partition": peeked.Messages[0].Partition, "offset": peeked.Messages[0].Offset,
	}, &viewed)
	if viewed.Message.MessageID == "" || viewed.Message.PayloadText != payload {
		t.Fatalf("unexpected viewed message: %#v", viewed.Message)
	}

	queried := waitForIntegrationMessages(t, agent, "mq_query_message_by_key", map[string]any{
		"topic": topic, "key": "dbx-integration-key", "maxNum": 10,
		"begin": 0, "end": time.Now().Add(time.Minute).UnixMilli(),
	})
	if queried.Messages[0].PayloadText != payload {
		t.Fatalf("unexpected queried message: %#v", queried.Messages[0])
	}

	queriedByTopic := waitForIntegrationMessages(t, agent, "mq_query_message_by_topic", map[string]any{
		"topic": topic, "maxNum": 10, "begin": 0, "end": time.Now().Add(time.Minute).UnixMilli(),
	})
	if queriedByTopic.Messages[0].PayloadText != payload {
		t.Fatalf("unexpected topic query message: %#v", queriedByTopic.Messages[0])
	}

	var stats struct {
		TotalMessages int64 `json:"totalMessages"`
	}
	integrationCall(t, agent, "mq_get_topic_stats", map[string]any{"name": topic}, &stats)
	if stats.TotalMessages < 1 {
		t.Fatalf("unexpected topic stats: %#v", stats)
	}

	integrationCall[map[string]any](t, agent, "mq_alter_subscription_group_config", map[string]any{
		"groupId": groupID, "consumeEnable": true, "consumeMessageOrderly": true,
		"retryQueueNums": 2, "retryMaxTimes": 20,
	}, nil)

	var groupConfig struct {
		GroupName             string `json:"groupName"`
		ConsumeMessageOrderly bool   `json:"consumeMessageOrderly"`
	}
	integrationCall(t, agent, "mq_get_subscription_group_config", map[string]any{"groupId": groupID}, &groupConfig)
	if groupConfig.GroupName != groupID {
		t.Fatalf("unexpected group config: %#v", groupConfig)
	}
	if strings.HasPrefix(version, "5.") && !groupConfig.ConsumeMessageOrderly {
		t.Fatalf("RocketMQ %s did not preserve FIFO group config: %#v", version, groupConfig)
	}

	var groups integrationConsumerGroups
	integrationCall(t, agent, "mq_list_consumer_groups", map[string]any{
		"keyword": groupID, "limit": 10,
	}, &groups)
	if len(groups.Groups) != 1 || groups.Groups[0].GroupID != groupID {
		t.Fatalf("unexpected consumer groups: %#v", groups)
	}
	if strings.HasPrefix(version, "5.") && groups.Groups[0].GroupType != "FIFO" {
		t.Fatalf("RocketMQ %s did not classify FIFO group: %#v", version, groups.Groups[0])
	}

	var producers struct {
		Producers []any `json:"producers"`
	}
	integrationCall(t, agent, "mq_list_producers", map[string]any{}, &producers)
	if producers.Producers == nil {
		t.Fatal("producer list must be an array")
	}

	var lagBefore integrationLag
	integrationCall(t, agent, "mq_get_consumer_lag", map[string]any{"groupId": groupID, "topic": topic}, &lagBefore)
	if lagBefore.TotalLag < 1 {
		t.Fatalf("unexpected lag before reset: %#v", lagBefore)
	}
	integrationCall[map[string]any](t, agent, "mq_reset_consumer_group_offsets", map[string]any{
		"groupId": groupID, "topic": topic,
		"offsets": []map[string]any{{"partition": 0, "offset": sendResult.Offset + 1}, {"partition": 1, "offset": 0}},
	}, nil)
	var lagAfter integrationLag
	integrationCall(t, agent, "mq_get_consumer_lag", map[string]any{"groupId": groupID, "topic": topic}, &lagAfter)
	if lagAfter.TotalLag != 0 {
		t.Fatalf("unexpected lag after reset: %#v", lagAfter)
	}

	var skipped struct {
		OK          bool `json:"ok"`
		ResetGroups int  `json:"resetGroups"`
	}
	integrationCall(t, agent, "mq_skip_topic_accumulation", map[string]any{"topic": topic}, &skipped)
	if !skipped.OK || skipped.ResetGroups < 0 {
		t.Fatalf("unexpected skip accumulation result: %#v", skipped)
	}

	integrationCall[map[string]any](t, agent, "mq_delete_consumer_group", map[string]any{"groupId": groupID}, nil)
	integrationCall[map[string]any](t, agent, "mq_delete_topic", map[string]any{"name": topic}, nil)
	var topics integrationTopicList
	integrationCall(t, agent, "mq_list_topics", map[string]any{"keyword": topic, "limit": 10}, &topics)
	if len(topics.Topics) != 0 {
		t.Fatalf("topic still exists after deletion: %#v", topics.Topics)
	}
	integrationCall[map[string]any](t, agent, "disconnect", map[string]any{}, nil)
}

func integrationCall[T any](t *testing.T, agent *rocketMQAgent, method string, params map[string]any, target *T) {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	result, err := agent.dispatch(method, raw)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	if target == nil {
		return
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, target); err != nil {
		t.Fatalf("%s decode: %v; result=%s", method, err, encoded)
	}
}

func integrationCleanupCall(agent *rocketMQAgent, method string, params map[string]any) {
	raw, err := json.Marshal(params)
	if err == nil {
		_, _ = agent.dispatch(method, raw)
	}
}

func waitForIntegrationMessages(t *testing.T, agent *rocketMQAgent, method string, params map[string]any) integrationMessages {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		var messages integrationMessages
		integrationCall(t, agent, method, params, &messages)
		if len(messages.Messages) > 0 {
			return messages
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s returned no messages before timeout", method)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func envString(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
