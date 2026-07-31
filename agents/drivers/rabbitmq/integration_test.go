package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRabbitMQIntegration(t *testing.T) {
	if os.Getenv("RABBITMQ_INTEGRATION") != "1" {
		t.Skip("set RABBITMQ_INTEGRATION=1 to run against a real RabbitMQ broker")
	}
	host := envOrDefault("RABBITMQ_HOST", "127.0.0.1")
	amqpPort := envIntOrDefault(t, "RABBITMQ_PORT", 5672)
	managementPort := envIntOrDefault(t, "RABBITMQ_MANAGEMENT_PORT", 15672)
	username := envOrDefault("RABBITMQ_USERNAME", "dbx")
	password := envOrDefault("RABBITMQ_PASSWORD", "dbx-password")
	connection := jsonObject{
		"addresses": host,
		"port":      amqpPort,
		"username":  username,
		"password":  password,
		"properties": jsonObject{
			"management_port": managementPort,
		},
	}
	service := newServer()
	if _, err := service.connect(connection); err != nil {
		t.Fatal(err)
	}
	defer service.closeClients()

	probe, err := service.testConnection(connection)
	if err != nil {
		t.Fatal(err)
	}
	if probe.(jsonObject)["ok"] != true || probe.(jsonObject)["serverVersion"] == nil {
		t.Fatalf("unexpected probe %#v", probe)
	}
	badConnection := deepCopyObject(connection)
	badConnection["password"] = "definitely-wrong-password"
	if _, err := service.testConnection(badConnection); err == nil {
		t.Fatal("expected invalid credentials to fail")
	} else if !strings.Contains(normalizeErrorMessage(err), "authentication failed") {
		t.Fatalf("authentication error lost its actionable hint: %v", err)
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	vhost := "dbx-go-" + suffix
	queue := "queue-" + suffix
	exchange := "exchange-" + suffix
	policy := "policy-" + suffix
	user := "user-" + suffix

	defer managementSend(connection, "DELETE", "/api/users/"+urlEncodePathSegment(user), nil)
	defer managementSend(connection, "DELETE", "/api/vhosts/"+urlEncodeVhost(vhost), nil)

	if _, err := service.createNamespace(jsonObject{"namespace": vhost}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.grantPermission(jsonObject{
		"user": username, "virtual_host": vhost, "configure": ".*", "write": ".*", "read": ".*",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.getTopicStats(jsonObject{"topic": "missing-" + suffix, "virtual_host": vhost}); err == nil {
		t.Fatal("expected missing queue lookup to fail")
	} else if !strings.Contains(normalizeErrorMessage(err), "was not found") {
		t.Fatalf("unexpected missing queue error: %v", err)
	}
	if _, err := service.createTopic(jsonObject{"topic": queue, "virtual_host": vhost, "durable": true}); err != nil {
		t.Fatalf("channel did not recover after a broker-forced close: %v", err)
	}
	if _, err := service.createExchange(jsonObject{
		"name": exchange, "type": "topic", "virtual_host": vhost, "durable": true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.bind(jsonObject{
		"source": exchange, "destination": queue, "destinationType": "queue", "routingKey": "orders.*", "virtual_host": vhost,
	}); err != nil {
		t.Fatal(err)
	}
	payload := "RabbitMQ Go Agent 世界"
	if _, err := service.sendMessage(jsonObject{
		"topic": queue, "exchange": exchange, "routingKey": "orders.created", "virtual_host": vhost,
		"payloadBase64": base64.StdEncoding.EncodeToString([]byte(payload)),
		"headers":       jsonObject{"source": "integration", "attempt": 1},
	}); err != nil {
		t.Fatal(err)
	}

	peeked, err := service.peekMessages(jsonObject{"topic": queue, "virtual_host": vhost, "offset": 0, "count": 10})
	if err != nil {
		t.Fatal(err)
	}
	messages := peeked.(jsonObject)["messages"].([]jsonObject)
	if len(messages) != 1 || messages[0]["payloadText"] != payload || messages[0]["routingKey"] != "orders.created" {
		t.Fatalf("unexpected messages %#v", messages)
	}

	stats, err := service.getTopicStats(jsonObject{"topic": queue, "virtual_host": vhost})
	if err != nil {
		t.Fatal(err)
	}
	if stats.(jsonObject)["totalMessages"] != int64(1) {
		t.Fatalf("unexpected stats %#v", stats)
	}
	config, err := service.getTopicConfig(jsonObject{"topic": queue, "virtual_host": vhost})
	if err != nil {
		t.Fatal(err)
	}
	if config.(jsonObject)["configs"].(jsonObject)["durable"] != true {
		t.Fatalf("unexpected config %#v", config)
	}
	consumers, err := service.listConsumers(jsonObject{"topic": queue, "virtual_host": vhost})
	if err != nil || len(consumers.(jsonObject)["consumers"].([]jsonObject)) != 0 {
		t.Fatalf("unexpected consumers %#v, %v", consumers, err)
	}

	topics, err := service.listTopics(jsonObject{"virtual_host": vhost})
	if err != nil || !containsNamedItem(topics.(jsonObject)["topics"].([]jsonObject), queue) {
		t.Fatalf("unexpected topics %#v, %v", topics, err)
	}
	exchanges, err := service.listExchanges(jsonObject{"virtual_host": vhost})
	if err != nil || !containsNamedItem(exchanges.(jsonObject)["exchanges"].([]jsonObject), exchange) {
		t.Fatalf("unexpected exchanges %#v, %v", exchanges, err)
	}
	bindings, err := service.listBindings(jsonObject{"virtual_host": vhost, "queue": queue})
	if err != nil || len(bindings.(jsonObject)["bindings"].([]jsonObject)) == 0 {
		t.Fatalf("unexpected bindings %#v, %v", bindings, err)
	}

	if _, err := service.setPolicy(jsonObject{
		"virtual_host": vhost, "name": policy, "pattern": "^" + queue + "$", "applyTo": "queues",
		"definition": jsonObject{"max-length": 1000},
	}); err != nil {
		t.Fatal(err)
	}
	policies, err := service.listPolicies(jsonObject{"virtual_host": vhost})
	if err != nil || !containsNamedItem(policies.(jsonObject)["policies"].([]jsonObject), policy) {
		t.Fatalf("unexpected policies %#v, %v", policies, err)
	}
	if _, err := service.deletePolicy(jsonObject{"virtual_host": vhost, "name": policy}); err != nil {
		t.Fatal(err)
	}

	if _, err := service.createUser(jsonObject{"name": user, "password": "temporary-password", "tags": []any{"management"}}); err != nil {
		t.Fatal(err)
	}
	users, err := service.listUsers(jsonObject{})
	if err != nil || !containsNamedItem(users.(jsonObject)["users"].([]jsonObject), user) {
		t.Fatalf("unexpected users %#v, %v", users, err)
	}
	if _, err := service.grantPermission(jsonObject{"user": user, "virtual_host": vhost}); err != nil {
		t.Fatal(err)
	}
	permissions, err := service.listPermissions(jsonObject{"user": user, "virtual_host": vhost})
	if err != nil || len(permissions.(jsonObject)["permissions"].([]jsonObject)) != 1 {
		t.Fatalf("unexpected permissions %#v, %v", permissions, err)
	}
	if _, err := service.revokePermission(jsonObject{"user": user, "virtual_host": vhost}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.deleteUser(jsonObject{"name": user}); err != nil {
		t.Fatal(err)
	}

	namespaces, err := service.listNamespaces(jsonObject{})
	if err != nil || !containsNamedItem(namespaces.(jsonObject)["namespaces"].([]jsonObject), vhost) {
		t.Fatalf("unexpected namespaces %#v, %v", namespaces, err)
	}
	connections, err := service.listClientConnections(jsonObject{"all_vhosts": true})
	if err != nil || len(connections.(jsonObject)["connections"].([]jsonObject)) == 0 {
		t.Fatalf("unexpected connections %#v, %v", connections, err)
	}
	channels, err := service.listClientChannels(jsonObject{"all_vhosts": true})
	if err != nil || len(channels.(jsonObject)["channels"].([]jsonObject)) == 0 {
		t.Fatalf("unexpected channels %#v, %v", channels, err)
	}
	if _, err := service.getOverview(jsonObject{}); err != nil {
		t.Fatal(err)
	}
	nodes, err := service.listNodes(jsonObject{})
	if err != nil || len(nodes.(jsonObject)["nodes"].([]jsonObject)) == 0 {
		t.Fatalf("unexpected nodes %#v, %v", nodes, err)
	}
	cluster, err := service.describeCluster(jsonObject{})
	if err != nil || cluster.(jsonObject)["version"] == nil {
		t.Fatalf("unexpected cluster %#v, %v", cluster, err)
	}

	purged, err := service.purgeQueue(jsonObject{"topic": queue, "virtual_host": vhost})
	if err != nil || purged.(jsonObject)["purged"] != 1 {
		t.Fatalf("unexpected purge %#v, %v", purged, err)
	}
	if _, err := service.unbind(jsonObject{
		"source": exchange, "destination": queue, "destinationType": "queue", "routingKey": "orders.*", "virtual_host": vhost,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.deleteTopic(jsonObject{"topic": queue, "virtual_host": vhost}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.deleteExchange(jsonObject{"name": exchange, "virtual_host": vhost}); err != nil {
		t.Fatal(err)
	}
	if client := service.vhostClients[vhost]; client != nil {
		client.close()
		delete(service.vhostClients, vhost)
	}
	if _, err := service.deleteNamespace(jsonObject{"namespace": vhost}); err != nil {
		t.Fatal(err)
	}
}

func containsNamedItem(items []jsonObject, name string) bool {
	for _, item := range items {
		if stringOrEmpty(item, "name") == name {
			return true
		}
	}
	return false
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envIntOrDefault(t *testing.T, key string, fallback int) int {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		t.Fatalf("invalid %s: %v", key, err)
	}
	return parsed
}
