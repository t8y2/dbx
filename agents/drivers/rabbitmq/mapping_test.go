package main

import (
	"encoding/json"
	"testing"
)

func TestConsumersFromQueueInfo(t *testing.T) {
	info := mustObject(t, `{
      "consumer_details": [
        {"consumer_tag":"ctag","active":true,"ack_required":true,"prefetch_count":25,"channel_details":{"name":"conn (1)"}},
        "ignored"
      ]
    }`)
	consumers := consumersFromQueueInfo(info)
	if len(consumers) != 1 || consumers[0]["name"] != "conn (1)" || consumers[0]["tag"] != "ctag" || consumers[0]["prefetch"] != 25 {
		t.Fatalf("unexpected consumers %#v", consumers)
	}
	if got := consumersFromQueueInfo(jsonObject{}); len(got) != 0 {
		t.Fatalf("unexpected consumers %#v", got)
	}
}

func TestExchangeAndBindingMappings(t *testing.T) {
	defaultExchange := exchangeInfoFromJSON(mustObject(t, `{"name":"","type":"","durable":true,"auto_delete":false,"internal":false}`))
	if defaultExchange["type"] != "default" || defaultExchange["durable"] != true {
		t.Fatalf("unexpected exchange %#v", defaultExchange)
	}
	topicExchange := exchangeInfoFromJSON(mustObject(t, `{"name":"events","type":"topic","durable":true,"auto_delete":true,"internal":true}`))
	if topicExchange["type"] != "topic" || topicExchange["autoDelete"] != true || topicExchange["internal"] != true {
		t.Fatalf("unexpected exchange %#v", topicExchange)
	}
	binding := bindingInfoFromJSON(mustObject(t, `{
      "source":"events","destination":"orders","destination_type":"queue","routing_key":"orders.*",
      "arguments":{"x-priority":5,"alternate":true,"ignored":null}
    }`))
	if binding["destinationType"] != "queue" || binding["routingKey"] != "orders.*" {
		t.Fatalf("unexpected binding %#v", binding)
	}
	arguments := binding["arguments"].(jsonObject)
	if arguments["x-priority"] != int64(5) || arguments["alternate"] != true {
		t.Fatalf("unexpected arguments %#v", arguments)
	}
	withoutArguments := bindingInfoFromJSON(mustObject(t, `{"source":"e","destination":"q","destination_type":"queue","routing_key":"","arguments":{}}`))
	if _, exists := withoutArguments["arguments"]; exists {
		t.Fatalf("unexpected arguments %#v", withoutArguments)
	}
}

func TestConnectionAndChannelMappings(t *testing.T) {
	connection := clientConnectionInfoFromJSON(mustObject(t, `{
      "name":"127.0.0.1:1 -> 127.0.0.1:5672","user":"dbx","peer_host":"127.0.0.1","peer_port":1234,
      "state":"running","channels":2,"recv_oct_details":{"rate":12.5},"send_oct_details":{"rate":8.25},"connected_at":1700000000000
    }`))
	if connection["recvRate"] != 12.5 || connection["sendRate"] != 8.25 || connection["connectedAt"] != int64(1700000000000) {
		t.Fatalf("unexpected connection %#v", connection)
	}
	minimal := clientConnectionInfoFromJSON(mustObject(t, `{"name":"conn"}`))
	for _, key := range []string{"recvRate", "sendRate", "connectedAt"} {
		if _, exists := minimal[key]; exists {
			t.Fatalf("unexpected %s in %#v", key, minimal)
		}
	}
	channel := channelInfoFromJSON(mustObject(t, `{
      "name":"conn (1)","connection_details":{"name":"conn"},"state":"running",
      "prefetch_count":10,"messages_unacknowledged":4,"consumer_count":2
    }`))
	if channel["connectionName"] != "conn" || channel["messagesUnacked"] != int64(4) || channel["consumerCount"] != int64(2) {
		t.Fatalf("unexpected channel %#v", channel)
	}
	if !channelMatchesConnection(channel, "conn") || !channelMatchesConnection(jsonObject{"name": "other (1)"}, "other") {
		t.Fatal("connection matching failed")
	}
	if channelMatchesConnection(channel, "missing") {
		t.Fatal("unexpected connection match")
	}
}

func TestUserPermissionPolicyMappings(t *testing.T) {
	user := userInfoFromJSON(mustObject(t, `{"name":"admin","tags":"administrator, management"}`))
	if user["name"] != "admin" || len(user["tags"].([]string)) != 2 {
		t.Fatalf("unexpected user %#v", user)
	}
	permission := permissionInfoFromJSON(mustObject(t, `{"user":"dbx","vhost":"/","configure":".*","write":"^orders","read":".*"}`))
	if permission["write"] != "^orders" || permission["vhost"] != "/" {
		t.Fatalf("unexpected permission %#v", permission)
	}
	policy := policyInfoFromJSON(mustObject(t, `{
      "name":"ha","vhost":"/","pattern":"^ha","apply-to":"queues","priority":5,
      "definition":{"ha-mode":"all","ha-sync-mode":"automatic","expires":60000,"ignored":null}
    }`))
	if policy["applyTo"] != "queues" || policy["priority"] != int64(5) {
		t.Fatalf("unexpected policy %#v", policy)
	}
	definition := policy["definition"].(jsonObject)
	if definition["expires"] != int64(60000) || definition["ha-mode"] != "all" {
		t.Fatalf("unexpected definition %#v", definition)
	}
}

func TestOverviewAndNodeMappings(t *testing.T) {
	overview := overviewInfoFromJSON(mustObject(t, `{
      "queue_totals":{"messages_ready":10,"messages_unacknowledged":2},
      "message_stats":{"publish_details":{"rate":1.5},"deliver_get_details":{"rate":2.5},"ack_details":{"rate":3.5}},
      "object_totals":{"queues":4,"exchanges":5,"connections":6,"channels":7,"consumers":8}
    }`))
	if overview["messagesReady"] != int64(10) || overview["publishRate"] != 1.5 || overview["totalConsumers"] != int64(8) {
		t.Fatalf("unexpected overview %#v", overview)
	}
	minimal := overviewInfoFromJSON(jsonObject{})
	if len(minimal) != 0 {
		t.Fatalf("unexpected overview %#v", minimal)
	}
	node := nodeInfoFromJSON(mustObject(t, `{
      "name":"rabbit@node","running":true,"mem_used":100,"mem_limit":200,"disk_free":300,
      "fd_used":4,"fd_total":5,"sockets_used":6,"sockets_total":7,"uptime":8000
    }`))
	if node["running"] != true || node["memUsed"] != int64(100) || node["uptimeMs"] != int64(8000) {
		t.Fatalf("unexpected node %#v", node)
	}
}

func TestTopicInfoMappingIncludesQueueMessageCounts(t *testing.T) {
	topic := topicInfoFromJSON(mustObject(t, `{
      "name":"orders","durable":true,"messages":12,
      "messages_ready":10,"messages_unacknowledged":2,"consumers":3
    }`))

	if topic["messages"] != int64(12) || topic["messagesReady"] != int64(10) || topic["messagesUnacked"] != int64(2) {
		t.Fatalf("unexpected topic counts %#v", topic)
	}
	if topic["consumers"] != int64(3) {
		t.Fatalf("expected consumers wire field, got %#v", topic)
	}

	minimal := topicInfoFromJSON(mustObject(t, `{"name":"empty"}`))
	if _, ok := minimal["messagesReady"]; ok {
		t.Fatalf("unexpected ready count %#v", minimal)
	}
	if _, ok := minimal["messagesUnacked"]; ok {
		t.Fatalf("unexpected unacked count %#v", minimal)
	}
}

func TestAttachVhost(t *testing.T) {
	info := jsonObject{"name": "q"}
	attachVhost(info, mustObject(t, `{"vhost":"orders"}`))
	if info["vhost"] != "orders" {
		t.Fatalf("unexpected info %#v", info)
	}
}

func TestTopicInfoMappingIncludesQueueFeaturesAndArguments(t *testing.T) {
	topic := topicInfoFromJSON(mustObject(t, `{
      "name": "orders",
      "durable": true,
      "auto_delete": false,
      "exclusive": true,
      "state": "running",
      "type": "quorum",
      "messages": 123,
      "messages_ready": 100,
      "messages_unacknowledged": 23,
      "consumers": 4,
      "arguments": {
        "x-queue-type": "quorum",
        "x-message-ttl": 60000,
        "x-max-length": 1000,
        "x-queue-master-locator": "random"
      }
    }`))

	if topic["durable"] != true || topic["autoDelete"] != false || topic["exclusive"] != true {
		t.Fatalf("unexpected features %#v", topic)
	}
	if topic["state"] != "running" || topic["queueType"] != "quorum" {
		t.Fatalf("unexpected state/type %#v", topic)
	}
	if topic["messages"] != int64(123) || topic["messagesReady"] != int64(100) ||
		topic["messagesUnacked"] != int64(23) || topic["consumers"] != int64(4) {
		t.Fatalf("unexpected counts %#v", topic)
	}
	arguments := topic["arguments"].(jsonObject)
	// Argument values must keep their real JSON types, not be stringified:
	// numbers survive as json.Number and booleans/strings pass through.
	if ttl, ok := arguments["x-message-ttl"].(json.Number); !ok || ttl.String() != "60000" {
		t.Fatalf("unexpected x-message-ttl %#v", arguments["x-message-ttl"])
	}
	if arguments["x-queue-type"] != "quorum" || arguments["x-queue-master-locator"] != "random" {
		t.Fatalf("unexpected arguments %#v", arguments)
	}
}

func TestTopicInfoMappingFallsBackToXQueueTypeArgument(t *testing.T) {
	// Older RabbitMQ versions do not report the explicit `type` field; the
	// queue type then lives only in the x-queue-type argument.
	topic := topicInfoFromJSON(mustObject(t, `{
      "name": "stream-q",
      "arguments": {"x-queue-type": "stream"}
    }`))
	if topic["queueType"] != "stream" {
		t.Fatalf("expected x-queue-type fallback, got %#v", topic["queueType"])
	}

	minimal := topicInfoFromJSON(mustObject(t, `{"name": "plain"}`))
	if _, exists := minimal["queueType"]; exists {
		t.Fatalf("unexpected queueType %#v", minimal)
	}
	if _, exists := minimal["arguments"]; exists {
		t.Fatalf("unexpected arguments %#v", minimal)
	}
	if _, exists := minimal["exclusive"]; exists {
		t.Fatalf("unexpected exclusive %#v", minimal)
	}
}

func TestTopicInfoMappingIncludesMessageStatsRates(t *testing.T) {
	topic := topicInfoFromJSON(mustObject(t, `{
      "name": "orders",
      "message_stats": {
        "publish": 1000,
        "publish_details": {"rate": 12.5},
        "deliver_get": 900,
        "deliver_get_details": {"rate": 11.8},
        "ack": 880,
        "ack_details": {"rate": 11.2}
      }
    }`))
	if topic["publishRate"] != 12.5 || topic["deliverRate"] != 11.8 || topic["ackRate"] != 11.2 {
		t.Fatalf("unexpected rates %#v", topic)
	}

	// No message_stats: rates must be absent, not fabricated as zero.
	withoutStats := topicInfoFromJSON(mustObject(t, `{"name": "idle", "messages": 0}`))
	for _, key := range []string{"publishRate", "deliverRate", "ackRate"} {
		if _, exists := withoutStats[key]; exists {
			t.Fatalf("unexpected %s in %#v", key, withoutStats)
		}
	}

	// A real sampled rate of zero is preserved as zero (distinct from absent).
	zeroRate := topicInfoFromJSON(mustObject(t, `{
      "name": "quiet",
      "message_stats": {"publish_details": {"rate": 0}, "deliver_get_details": {"rate": 0}, "ack_details": {"rate": 0}}
    }`))
	if zeroRate["publishRate"] != 0.0 || zeroRate["deliverRate"] != 0.0 || zeroRate["ackRate"] != 0.0 {
		t.Fatalf("expected preserved zero rates, got %#v", zeroRate)
	}
}

func TestGetTopicStatsPreservesMessageStatsFromManagementPayload(t *testing.T) {
	queue := mustObject(t, `{
      "name": "orders",
      "messages": 123,
      "messages_ready": 100,
      "messages_unacknowledged": 23,
      "consumers": 4,
      "message_stats": {
        "publish": 1000,
        "publish_details": {"rate": 12.5},
        "deliver_get": 900,
        "deliver_get_details": {"rate": 11.8},
        "ack": 880,
        "ack_details": {"rate": 11.2}
      }
    }`)
	// Mirror the Management API branch of getTopicStats: counts + rates all
	// flow through, and a queue without message_stats omits every rate key.
	messages := longOrDefault(queue, "messages", 0)
	result := jsonObject{
		"name":          "orders",
		"messageCount":  messages,
		"consumerCount": longOrDefault(queue, "consumers", 0),
		"totalMessages": messages,
	}
	putIfPresent(result, "messagesReady", longOrNull(queue, "messages_ready"))
	putIfPresent(result, "messagesUnacked", longOrNull(queue, "messages_unacknowledged"))
	if stats := objectOrNil(queue, "message_stats"); stats != nil {
		putIfPresent(result, "publishRate", rateFromDetails(stats, "publish_details"))
		putIfPresent(result, "deliverRate", rateFromDetails(stats, "deliver_get_details"))
		putIfPresent(result, "ackRate", rateFromDetails(stats, "ack_details"))
		putIfPresent(result, "publishTotal", longOrNull(stats, "publish"))
		putIfPresent(result, "deliverGetTotal", longOrNull(stats, "deliver_get"))
		putIfPresent(result, "ackTotal", longOrNull(stats, "ack"))
	}

	if result["messageCount"] != int64(123) || result["messagesReady"] != int64(100) ||
		result["messagesUnacked"] != int64(23) || result["consumerCount"] != int64(4) {
		t.Fatalf("unexpected counts %#v", result)
	}
	if result["publishRate"] != 12.5 || result["deliverRate"] != 11.8 || result["ackRate"] != 11.2 {
		t.Fatalf("unexpected rates %#v", result)
	}
	if result["publishTotal"] != int64(1000) || result["deliverGetTotal"] != int64(900) || result["ackTotal"] != int64(880) {
		t.Fatalf("unexpected totals %#v", result)
	}

	withoutStats := jsonObject{"name": "idle", "messageCount": 0, "consumerCount": 0, "totalMessages": 0}
	for _, key := range []string{"publishRate", "deliverRate", "ackRate", "publishTotal", "deliverGetTotal", "ackTotal"} {
		if _, exists := withoutStats[key]; exists {
			t.Fatalf("unexpected %s in %#v", key, withoutStats)
		}
	}
}

func TestGetTopicConfigPreservesArgumentTypes(t *testing.T) {
	configs := jsonObject{}
	object := mustObject(t, `{
      "durable": true,
      "auto_delete": false,
      "exclusive": false,
      "type": "quorum",
      "arguments": {
        "x-message-ttl": 60000,
        "x-max-priority": 5,
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "dlx",
        "x-single-active-consumer": true
      }
    }`)
	configs["durable"] = boolOrDefault(object, "durable", false)
	configs["auto_delete"] = boolOrDefault(object, "auto_delete", false)
	configs["exclusive"] = boolOrDefault(object, "exclusive", false)
	if queueType := queueTypeFromQueue(object); queueType != "" {
		configs["queue_type"] = queueType
	}
	if arguments := objectOrNil(object, "arguments"); arguments != nil {
		for key, value := range arguments {
			configs[key] = value
		}
	}

	if configs["queue_type"] != "quorum" || configs["durable"] != true {
		t.Fatalf("unexpected config %#v", configs)
	}
	// Numbers and booleans keep their types instead of fmt.Sprint strings:
	// the decoder produced json.Number, and pass-through preserves it verbatim.
	if ttl, ok := configs["x-message-ttl"].(json.Number); !ok || ttl.String() != "60000" {
		t.Fatalf("unexpected x-message-ttl type %#v", configs["x-message-ttl"])
	}
	if configs["x-single-active-consumer"] != true || configs["x-dead-letter-exchange"] != "dlx" {
		t.Fatalf("unexpected argument values %#v", configs)
	}
}
