package main

import (
	"fmt"
	"math"
	"strconv"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func applyMessageProperties(publishing *amqp.Publishing, params jsonObject) error {
	if params["properties"] == nil {
		return nil
	}
	properties := objectOrNil(params, "properties")
	if properties == nil {
		return fmt.Errorf("properties must be an object of strings")
	}
	for key, raw := range properties {
		value, ok := raw.(string)
		if !ok {
			return fmt.Errorf("properties.%s must be a string", key)
		}
		if len(value) > 255 {
			return fmt.Errorf("properties.%s must not exceed 255 bytes", key)
		}
		switch key {
		case "content_type":
			publishing.ContentType = value
		case "content_encoding":
			publishing.ContentEncoding = value
		case "correlation_id":
			publishing.CorrelationId = value
		case "reply_to":
			publishing.ReplyTo = value
		case "message_id":
			publishing.MessageId = value
		case "type":
			publishing.Type = value
		case "user_id":
			publishing.UserId = value
		case "app_id":
			publishing.AppId = value
		case "delivery_mode", "priority", "expiration", "timestamp":
			number, err := strconv.ParseUint(value, 10, 63)
			if err != nil {
				return fmt.Errorf("properties.%s must be a non-negative integer", key)
			}
			switch key {
			case "delivery_mode":
				if number != 1 && number != 2 {
					return fmt.Errorf("properties.delivery_mode must be 1 or 2")
				}
				publishing.DeliveryMode = uint8(number)
			case "priority":
				if number > 255 {
					return fmt.Errorf("properties.priority must be between 0 and 255")
				}
				publishing.Priority = uint8(number)
			case "expiration":
				publishing.Expiration = strconv.FormatUint(number, 10)
			case "timestamp":
				// Peek metadata uses milliseconds, so reject seconds that would overflow it.
				if number > math.MaxInt64/1000 {
					return fmt.Errorf("properties.timestamp exceeds the supported Unix timestamp range")
				}
				publishing.Timestamp = time.Unix(int64(number), 0)
			}
		default:
			return fmt.Errorf("unsupported AMQP property: %s", key)
		}
	}
	return nil
}

func deliveryProperties(delivery amqp.Delivery) map[string]string {
	properties := map[string]string{"priority": strconv.Itoa(int(delivery.Priority))}
	for key, value := range map[string]string{
		"content_type": delivery.ContentType, "content_encoding": delivery.ContentEncoding,
		"correlation_id": delivery.CorrelationId, "reply_to": delivery.ReplyTo,
		"expiration": delivery.Expiration, "message_id": delivery.MessageId,
		"type": delivery.Type, "user_id": delivery.UserId, "app_id": delivery.AppId,
	} {
		if value != "" {
			properties[key] = value
		}
	}
	if delivery.DeliveryMode != 0 {
		properties["delivery_mode"] = strconv.Itoa(int(delivery.DeliveryMode))
	}
	if !delivery.Timestamp.IsZero() {
		properties["timestamp"] = strconv.FormatInt(delivery.Timestamp.Unix(), 10)
	}
	return properties
}
