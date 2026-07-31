package main

import "testing"

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

func TestAttachVhost(t *testing.T) {
	info := jsonObject{"name": "q"}
	attachVhost(info, mustObject(t, `{"vhost":"orders"}`))
	if info["vhost"] != "orders" {
		t.Fatalf("unexpected info %#v", info)
	}
}
