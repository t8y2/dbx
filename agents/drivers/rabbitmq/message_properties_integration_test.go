package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func TestRabbitMQMessagePropertiesIntegration(t *testing.T) {
	if os.Getenv("RABBITMQ_INTEGRATION") != "1" {
		t.Skip("set RABBITMQ_INTEGRATION=1 to run against a real RabbitMQ broker")
	}
	username := envOrDefault("RABBITMQ_USERNAME", "dbx")
	config := jsonObject{
		"addresses": envOrDefault("RABBITMQ_HOST", "127.0.0.1"),
		"port":      envIntOrDefault(t, "RABBITMQ_PORT", 5672),
		"username":  username, "password": envOrDefault("RABBITMQ_PASSWORD", "dbx-password"),
	}
	service := newServer()
	if _, err := service.connect(config); err != nil {
		t.Fatal(err)
	}
	defer service.closeClients()
	queue := fmt.Sprintf("dbx-properties-%d", time.Now().UnixNano())
	if _, err := service.createTopic(jsonObject{"topic": queue, "durable": true}); err != nil {
		t.Fatal(err)
	}
	defer service.deleteTopic(jsonObject{"topic": queue})
	reader, err := openConnection(config)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	channel, err := reader.Channel()
	if err != nil {
		t.Fatal(err)
	}
	defer channel.Close()
	get := func(autoAck bool) amqp.Delivery {
		deadline := time.Now().Add(5 * time.Second)
		for {
			delivery, ok, err := channel.Get(queue, autoAck)
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				return delivery
			}
			if time.Now().After(deadline) {
				t.Fatal("published message did not arrive")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	properties := jsonObject{
		"content_type": "application/json", "content_encoding": "utf-8", "delivery_mode": "2", "priority": "5",
		"correlation_id": "correlation", "reply_to": "reply", "expiration": "60000", "message_id": "message",
		"timestamp": "1735689600", "type": "order.created", "user_id": username, "app_id": "integration",
	}
	payload := `{"orderId":13512}`
	params := jsonObject{
		"topic": queue, "payloadBase64": base64.StdEncoding.EncodeToString([]byte(payload)),
		"headers": jsonObject{"content_type": "custom-header"}, "properties": properties,
	}
	if _, err := service.sendMessage(params); err != nil {
		t.Fatal(err)
	}
	delivery := get(false)
	want := make(map[string]string, len(properties))
	for key, value := range properties {
		want[key] = value.(string)
	}
	if string(delivery.Body) != payload || delivery.Headers["content_type"] != "custom-header" || !reflect.DeepEqual(deliveryProperties(delivery), want) {
		t.Fatalf("broker did not receive body, custom headers and standard properties separately: %#v", delivery)
	}
	if err := delivery.Nack(false, true); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		result, err := service.peekMessages(jsonObject{"topic": queue, "count": 1})
		if err != nil {
			t.Fatal(err)
		}
		messages := result.(jsonObject)["messages"].([]jsonObject)
		if len(messages) == 1 {
			if !reflect.DeepEqual(messages[0]["properties"], want) {
				t.Fatalf("peek did not return properties: %#v", messages[0])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("requeued message was not visible to peek")
		}
		time.Sleep(10 * time.Millisecond)
	}
	get(true)
	params["properties"] = jsonObject{"priority": "0", "timestamp": "0"}
	if _, err := service.sendMessage(params); err != nil {
		t.Fatal(err)
	}
	zero := deliveryProperties(get(true))
	if zero["priority"] != "0" || zero["timestamp"] != "0" {
		t.Fatalf("zero values did not roundtrip: %#v", zero)
	}
	params["properties"] = jsonObject{"expiration": "50"}
	if _, err := service.sendMessage(params); err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	if _, ok, err := channel.Get(queue, true); err != nil || ok {
		t.Fatalf("50ms message TTL was not applied: exists=%v, error=%v", ok, err)
	}
}
