package main

import (
	"reflect"
	"testing"
)

func TestTopicAttributesStringEmitsOnlyRocketMQ5Modifications(t *testing.T) {
	attributes := map[string]string{
		"+message.type":  "FIFO",
		"cleanup.policy": "DELETE",
		"-reserve.time":  "",
	}
	if got := topicAttributesString(attributes); got != "+message.type=FIFO,-reserve.time" {
		t.Fatalf("topicAttributesString() = %q", got)
	}
}

func TestClassifyTopicMessageType(t *testing.T) {
	tests := map[string]string{
		"%RETRY%GID_Orders":        "RETRY",
		"%DLQ%GID_Orders":          "DLQ",
		"RMQ_SYS_TRANS_HALF_TOPIC": "SYSTEM",
		"Orders":                   "UNSPECIFIED",
	}
	for topic, want := range tests {
		if got := classifyTopicMessageType(topic, "DefaultCluster", nil); got != want {
			t.Fatalf("classifyTopicMessageType(%q) = %q, want %q", topic, got, want)
		}
	}
	attributes := map[string]string{"message.type": "ORDER"}
	if got := classifyTopicMessageType("Ordered", "DefaultCluster", attributes); got != "FIFO" {
		t.Fatalf("ORDER attribute classified as %q", got)
	}
}

func TestPaginationAndMessageQueueParsing(t *testing.T) {
	items := []int{0, 1, 2, 3}
	if got := paginate(items, 2, 0); !reflect.DeepEqual(got, []int{2, 3}) {
		t.Fatalf("paginate all from offset = %#v", got)
	}
	queue := parseMessageQueueKey(`{"topic":"Orders","brokerName":"broker-a","queueId":3}`)
	if queue.Topic != "Orders" || queue.BrokerName != "broker-a" || queue.QueueID != 3 {
		t.Fatalf("unexpected JSON queue: %#v", queue)
	}
	queue = parseMessageQueueKey("MessageQueue [topic=Order-Events, brokerName=broker-a, queueId=7]")
	if queue.Topic != "Order-Events" || queue.BrokerName != "broker-a" || queue.QueueID != 7 {
		t.Fatalf("unexpected text queue: %#v", queue)
	}
}

func TestDecodeTopicStatsRepairsObjectKeys(t *testing.T) {
	body := []byte(`{"offsetTable":{{"brokerName":"broker-a","queueId":1,"topic":"Orders"}:{"minOffset":2,"maxOffset":9,"lastUpdateTimestamp":10}}}`)
	stats, err := decodeTopicStats(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 {
		t.Fatalf("unexpected stats: %#v", stats)
	}
	for key, offset := range stats {
		queue := parseMessageQueueKey(key)
		if queue.Topic != "Orders" || queue.BrokerName != "broker-a" || queue.QueueID != 1 {
			t.Fatalf("unexpected queue key %q: %#v", key, queue)
		}
		if offset.MinOffset != 2 || offset.MaxOffset != 9 {
			t.Fatalf("unexpected offset: %#v", offset)
		}
	}
}

func TestConfigEntryMatchesAgentContract(t *testing.T) {
	entry := configEntry("8")
	if entry["value"] != "8" || entry["source"] != "USER" {
		t.Fatalf("unexpected config entry: %#v", entry)
	}
	if _, exists := entry["key"]; exists {
		t.Fatalf("config entry must be keyed by its parent object: %#v", entry)
	}
}
