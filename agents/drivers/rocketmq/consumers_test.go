package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestClassifyConsumerGroup(t *testing.T) {
	if got := classifyConsumerGroup("TOOLS_CONSUMER", nil); got != "SYSTEM" {
		t.Fatalf("system group classified as %q", got)
	}
	if got := classifyConsumerGroup("GID_Orders", nil); got != "UNKNOWN" {
		t.Fatalf("missing config classified as %q", got)
	}
	if got := classifyConsumerGroup("GID_Orders", &subscriptionGroupConfig{}); got != "NORMAL" {
		t.Fatalf("normal group classified as %q", got)
	}
	if got := classifyConsumerGroup("GID_FIFO", &subscriptionGroupConfig{ConsumeMessageOrderly: true}); got != "FIFO" {
		t.Fatalf("FIFO group classified as %q", got)
	}
}

func TestDecodeConsumeStatsRepairsObjectKeys(t *testing.T) {
	body := []byte(`{"consumeTps":1.5,"offsetTable":{{"brokerName":"broker-a","queueId":2,"topic":"Orders"}:{"brokerOffset":20,"consumerOffset":12,"lastTimestamp":9,"pullOffset":13}}}`)
	stats, err := decodeConsumeStats(body)
	if err != nil {
		t.Fatal(err)
	}
	if stats.ConsumeTps != 1.5 || len(stats.OffsetTable) != 1 {
		t.Fatalf("unexpected consume stats: %#v", stats)
	}
	for key, offset := range stats.OffsetTable {
		queue := parseMessageQueueKey(key)
		if queue.Topic != "Orders" || queue.BrokerName != "broker-a" || queue.QueueID != 2 {
			t.Fatalf("unexpected queue key %q: %#v", key, queue)
		}
		if offset.BrokerOffset != 20 || offset.ConsumerOffset != 12 {
			t.Fatalf("unexpected offset: %#v", offset)
		}
	}
}

func TestMutationCoverageFailureMessage(t *testing.T) {
	err := ensureMutationCoverage("update", "consumer group GID_Orders", 2, 1, nil)
	if err == nil || !strings.Contains(err.Error(), "1 of 2") {
		t.Fatalf("unexpected partial mutation error: %v", err)
	}
	if err := ensureMutationCoverage("update", "consumer group GID_Orders", 2, 2, nil); err != nil {
		t.Fatal(err)
	}
}

func TestSubscriptionGroupConfigWireShape(t *testing.T) {
	config := subscriptionGroupConfig{
		GroupName: "GID_Orders", ConsumeEnable: true, ConsumeMessageOrderly: true,
		RetryQueueNums: 2, RetryMaxTimes: 20, NotifyConsumerIDsChangedEnable: true,
	}
	body, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["groupName"] != "GID_Orders" || decoded["consumeMessageOrderly"] != true {
		t.Fatalf("unexpected group wire body: %#v", decoded)
	}
}
