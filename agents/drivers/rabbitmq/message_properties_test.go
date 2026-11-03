package main

import (
	"reflect"
	"strings"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func TestApplyMessageProperties(t *testing.T) {
	properties := mustObject(t, `{"properties": {
		"content_type":"application/json", "content_encoding":"utf-8", "delivery_mode":"2", "priority":"255",
		"correlation_id":"correlation", "reply_to":"reply", "expiration":"60000", "message_id":"message",
		"timestamp":"1735689600", "type":"order.created", "user_id":"user", "app_id":"app"
	}}`)
	publishing := amqp.Publishing{Body: []byte("payload"), Headers: amqp.Table{"content_type": "custom-header"}}
	if err := applyMessageProperties(&publishing, properties); err != nil {
		t.Fatal(err)
	}
	want := amqp.Publishing{
		Body: []byte("payload"), Headers: amqp.Table{"content_type": "custom-header"},
		ContentType: "application/json", ContentEncoding: "utf-8", DeliveryMode: 2, Priority: 255,
		CorrelationId: "correlation", ReplyTo: "reply", Expiration: "60000", MessageId: "message",
		Timestamp: time.Unix(1735689600, 0), Type: "order.created", UserId: "user", AppId: "app",
	}
	if !reflect.DeepEqual(publishing, want) {
		t.Fatalf("got %#v, want %#v", publishing, want)
	}
}

func TestApplyMessagePropertiesDefaultsAndZero(t *testing.T) {
	for _, source := range []string{`{}`, `{"properties":null}`, `{"properties":{}}`} {
		publishing := amqp.Publishing{Body: []byte("payload")}
		if err := applyMessageProperties(&publishing, mustObject(t, source)); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(publishing, amqp.Publishing{Body: []byte("payload")}) {
			t.Fatalf("legacy defaults changed: %#v", publishing)
		}
	}
	publishing := amqp.Publishing{}
	if err := applyMessageProperties(&publishing, mustObject(t,
		`{"properties":{"delivery_mode":"1","priority":"0","expiration":"0","timestamp":"0"}}`)); err != nil {
		t.Fatal(err)
	}
	if publishing.DeliveryMode != 1 || publishing.Priority != 0 || publishing.Expiration != "0" || !publishing.Timestamp.Equal(time.Unix(0, 0)) {
		t.Fatalf("explicit zero values were lost: %#v", publishing)
	}
	preview := deliveryProperties(amqp.Delivery{Timestamp: publishing.Timestamp})
	if preview["priority"] != "0" || preview["timestamp"] != "0" {
		t.Fatalf("zero properties were lost from preview: %#v", preview)
	}
	if got := deliveryProperties(amqp.Delivery{}); !reflect.DeepEqual(got, map[string]string{"priority": "0"}) {
		t.Fatalf("unexpected absent properties: %#v", got)
	}
}

func TestApplyMessagePropertiesValidation(t *testing.T) {
	for _, test := range []struct {
		name, source, errorField string
	}{
		{"invalid object", `{"properties":[]}`, "properties"},
		{"non-string", `{"properties":{"priority":2}}`, "priority"},
		{"unsupported", `{"properties":{"contentType":"application/json"}}`, "contentType"},
		{"delivery zero", `{"properties":{"delivery_mode":"0"}}`, "delivery_mode"},
		{"delivery three", `{"properties":{"delivery_mode":"3"}}`, "delivery_mode"},
		{"priority overflow", `{"properties":{"priority":"256"}}`, "priority"},
		{"priority negative", `{"properties":{"priority":"-1"}}`, "priority"},
		{"priority decimal", `{"properties":{"priority":"1.5"}}`, "priority"},
		{"expiration empty", `{"properties":{"expiration":""}}`, "expiration"},
		{"expiration negative", `{"properties":{"expiration":"-1"}}`, "expiration"},
		{"expiration overflow", `{"properties":{"expiration":"9223372036854775808"}}`, "expiration"},
		{"timestamp negative", `{"properties":{"timestamp":"-1"}}`, "timestamp"},
		{"timestamp decimal", `{"properties":{"timestamp":"1.5"}}`, "timestamp"},
		{"timestamp milliseconds overflow", `{"properties":{"timestamp":"9223372036854776"}}`, "timestamp"},
		{"timestamp seconds overflow", `{"properties":{"timestamp":"9223372036854775808"}}`, "timestamp"},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := applyMessageProperties(&amqp.Publishing{}, mustObject(t, test.source))
			if err == nil || !strings.Contains(err.Error(), test.errorField) {
				t.Fatalf("got %v, want an error for %s", err, test.errorField)
			}
		})
	}
	if err := applyMessageProperties(&amqp.Publishing{}, jsonObject{"properties": jsonObject{"content_type": strings.Repeat("界", 86)}}); err == nil || !strings.Contains(err.Error(), "content_type") {
		t.Fatalf("expected shortstr byte limit error, got %v", err)
	}
}

func TestPeekedMessageIncludesBasicProperties(t *testing.T) {
	message := peekedMessageFromDelivery("queue", 0, amqp.Delivery{
		Body: []byte(`{"orderId":13512}`), Headers: amqp.Table{"content_type": "custom-header"},
		ContentType: "application/json", ContentEncoding: "utf-8", DeliveryMode: 2, Priority: 5,
		CorrelationId: "correlation", ReplyTo: "reply", Expiration: "60000", MessageId: "message",
		Timestamp: time.Unix(1735689600, 0), Type: "order.created", UserId: "user", AppId: "app",
	})
	want := map[string]string{
		"content_type": "application/json", "content_encoding": "utf-8", "delivery_mode": "2", "priority": "5",
		"correlation_id": "correlation", "reply_to": "reply", "expiration": "60000", "message_id": "message",
		"timestamp": "1735689600", "type": "order.created", "user_id": "user", "app_id": "app",
	}
	if !reflect.DeepEqual(message["properties"], want) {
		t.Fatalf("got properties %#v, want %#v", message["properties"], want)
	}
	if message["headers"].(map[string]string)["content_type"] != "custom-header" {
		t.Fatalf("custom headers were changed: %#v", message["headers"])
	}
	if message["messageId"] != "message" || message["timestamp"] != int64(1735689600000) {
		t.Fatalf("existing message metadata was changed: %#v", message)
	}
}
