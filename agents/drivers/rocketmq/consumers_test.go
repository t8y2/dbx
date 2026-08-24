package main

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	admin "github.com/amigoer/rocketmq-admin-go"
	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
)

type fakeConsumeStatusReader struct {
	calls      int
	topic      string
	groupID    string
	clientAddr string
	status     map[string]map[string]int64
	err        error
}

func (f *fakeConsumeStatusReader) GetConsumeStatus(
	_ context.Context,
	topic string,
	groupID string,
	clientAddr string,
) (map[string]map[string]int64, error) {
	f.calls++
	f.topic = topic
	f.groupID = groupID
	f.clientAddr = clientAddr
	return f.status, f.err
}

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

func TestDecodeConsumerStatusUnwrapsRocketMQ48Body(t *testing.T) {
	body := []byte(`{
		"messageQueueTable": {},
		"consumerTable": {
			"client-b": {{"brokerName":"broker-a","queueId":0,"topic":"Orders"}:90},
			"client-a": {
				"MessageQueue [topic=Orders, brokerName=broker-a, queueId=1]": 50
			}
		}
	}`)

	status, err := decodeConsumerStatus(body)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]map[string]int64{
		"client-b": {
			`{"brokerName":"broker-a","queueId":0,"topic":"Orders"}`: 90,
		},
		"client-a": {
			`MessageQueue [topic=Orders, brokerName=broker-a, queueId=1]`: 50,
		},
	}
	if !reflect.DeepEqual(status, want) {
		t.Fatalf("consumer status = %#v, want %#v", status, want)
	}
}

func TestDecodeConsumerStatusHandlesEmptyAndMalformedBodies(t *testing.T) {
	status, err := decodeConsumerStatus([]byte(`{"messageQueueTable":{},"consumerTable":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(status) != 0 {
		t.Fatalf("empty consumer table decoded as %#v", status)
	}
	if _, err := decodeConsumerStatus([]byte(`{"consumerTable":[]}`)); err == nil {
		t.Fatal("expected malformed consumer table to fail")
	}
}

func TestReadConsumerStatusFromBrokersUsesBoundedRequestsAndMerges(t *testing.T) {
	responses := map[string][]byte{
		"broker-a:10911": []byte(`{"consumerTable":{"client-a":{"{\"topic\":\"Orders\",\"brokerName\":\"broker-a\",\"queueId\":0}":90,"{\"topic\":\"Orders\",\"brokerName\":\"broker-a\",\"queueId\":1}":50}}}`),
		"broker-b:10911": []byte(`{"consumerTable":{"client-a":{"MessageQueue [topic=Orders, brokerName=broker-b, queueId=0]":20}}}`),
	}
	calls := make([]string, 0, len(responses))
	invoke := func(_ context.Context, address string, command *remoting.RemotingCommand) (*remoting.RemotingCommand, error) {
		calls = append(calls, address)
		if command.Code != remoting.InvokeBrokerToGetConsumerStatus {
			t.Fatalf("request code = %d, want %d", command.Code, remoting.InvokeBrokerToGetConsumerStatus)
		}
		if command.ExtFields["topic"] != "Orders" || command.ExtFields["group"] != "GID_Orders" {
			t.Fatalf("unexpected request fields: %#v", command.ExtFields)
		}
		if _, exists := command.ExtFields["clientAddr"]; exists {
			t.Fatalf("empty client address sent on wire: %#v", command.ExtFields)
		}
		return &remoting.RemotingCommand{Code: remoting.Success, Body: responses[address]}, nil
	}

	status, err := readConsumerStatusFromBrokers(
		context.Background(), []string{"broker-b:10911", "broker-a:10911"},
		"Orders", "GID_Orders", "", invoke,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, []string{"broker-a:10911", "broker-b:10911"}) {
		t.Fatalf("broker calls = %#v", calls)
	}
	if len(status["client-a"]) != 3 {
		t.Fatalf("merged status = %#v", status)
	}
}

func TestReadConsumerStatusFromBrokersKeepsPartialResults(t *testing.T) {
	invoke := func(_ context.Context, address string, _ *remoting.RemotingCommand) (*remoting.RemotingCommand, error) {
		if address == "broker-b:10911" {
			return nil, errors.New("consumer offline")
		}
		return &remoting.RemotingCommand{Code: remoting.Success, Body: []byte(
			`{"consumerTable":{"client-a":{"{\"topic\":\"Orders\",\"brokerName\":\"broker-a\",\"queueId\":0}":90}}}`,
		)}, nil
	}

	status, err := readConsumerStatusFromBrokers(
		context.Background(), []string{"broker-a:10911", "broker-b:10911"},
		"Orders", "GID_Orders", "", invoke,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(status["client-a"]) != 1 {
		t.Fatalf("partial status = %#v", status)
	}

	_, err = readConsumerStatusFromBrokers(
		context.Background(), []string{"broker-b:10911"},
		"Orders", "GID_Orders", "", invoke,
	)
	if err == nil {
		t.Fatal("expected all-broker request failure")
	}
}

func TestResolveConsumerClientsUsesOneBestEffortLookup(t *testing.T) {
	reader := &fakeConsumeStatusReader{status: map[string]map[string]int64{
		"client-z": {
			`{"topic":"Orders","brokerName":"broker-a","queueId":0}`: 90,
		},
		"client-a": {
			`MessageQueue [topic=Orders, brokerName=broker-a, queueId=0]`: 90,
			`{"topic":"Orders","brokerName":"broker-a","queueId":1}`:      50,
			"malformed": 1,
		},
		"client-b": {
			`{"topic":"Orders","brokerName":"broker-b","queueId":0}`: 7,
		},
		"": {
			`{"topic":"Orders","brokerName":"broker-b","queueId":1}`: 3,
		},
	}}

	clients := resolveConsumerClients(context.Background(), reader, "GID_Orders", "Orders")
	if reader.calls != 1 {
		t.Fatalf("consume status calls = %d, want 1", reader.calls)
	}
	if reader.topic != "Orders" || reader.groupID != "GID_Orders" || reader.clientAddr != "" {
		t.Fatalf("unexpected consume status request: %#v", reader)
	}
	want := map[parsedMessageQueue]string{
		{Topic: "Orders", BrokerName: "broker-a", QueueID: 0}: "client-a",
		{Topic: "Orders", BrokerName: "broker-a", QueueID: 1}: "client-a",
		{Topic: "Orders", BrokerName: "broker-b", QueueID: 0}: "client-b",
	}
	if !reflect.DeepEqual(clients, want) {
		t.Fatalf("consumer clients = %#v, want %#v", clients, want)
	}
}

func TestResolveConsumerClientsKeepsLagAvailableOnStatusFailure(t *testing.T) {
	reader := &fakeConsumeStatusReader{err: errors.New("consumer offline")}
	clients := resolveConsumerClients(context.Background(), reader, "GID_Orders", "Orders")
	if reader.calls != 1 {
		t.Fatalf("consume status calls = %d, want 1", reader.calls)
	}
	if len(clients) != 0 {
		t.Fatalf("consumer clients after failed lookup = %#v", clients)
	}
}

func TestBuildConsumerLagResultIncludesConsumerAssignments(t *testing.T) {
	stats := &admin.ConsumeStats{OffsetTable: map[string]*admin.OffsetWrapper{
		`{"topic":"Orders","brokerName":"broker-b","queueId":1}`: {
			BrokerOffset: 2, ConsumerOffset: 3, LastTimestamp: 40,
		},
		`{"topic":"Orders","brokerName":"broker-a","queueId":1}`: {
			BrokerOffset: 50, ConsumerOffset: 50, LastTimestamp: 20,
		},
		`{"topic":"Orders","brokerName":"broker-b","queueId":0}`: {
			BrokerOffset: 12, ConsumerOffset: 7, LastTimestamp: 30,
		},
		`{"topic":"Orders","brokerName":"broker-a","queueId":0}`: {
			BrokerOffset: 100, ConsumerOffset: 90, LastTimestamp: 10,
		},
	}}
	clients := map[parsedMessageQueue]string{
		{Topic: "Orders", BrokerName: "broker-a", QueueID: 0}: "client-a",
		{Topic: "Orders", BrokerName: "broker-a", QueueID: 1}: "client-a",
		{Topic: "Orders", BrokerName: "broker-b", QueueID: 0}: "client-b",
	}

	result := buildConsumerLagResult(stats, clients)
	if result["totalLag"] != int64(15) {
		t.Fatalf("total lag = %#v, want 15", result["totalLag"])
	}
	want := []map[string]any{
		{
			"partition": 0, "currentOffset": int64(90), "endOffset": int64(100),
			"lag": int64(10), "brokerName": "broker-a", "lastTimestamp": int64(10),
			"consumerClient": "client-a",
		},
		{
			"partition": 1, "currentOffset": int64(50), "endOffset": int64(50),
			"lag": int64(0), "brokerName": "broker-a", "lastTimestamp": int64(20),
			"consumerClient": "client-a",
		},
		{
			"partition": 0, "currentOffset": int64(7), "endOffset": int64(12),
			"lag": int64(5), "brokerName": "broker-b", "lastTimestamp": int64(30),
			"consumerClient": "client-b",
		},
		{
			"partition": 1, "currentOffset": int64(3), "endOffset": int64(2),
			"lag": int64(0), "brokerName": "broker-b", "lastTimestamp": int64(40),
			"consumerClient": "",
		},
	}
	if got := result["partitions"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("partitions = %#v, want %#v", got, want)
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
