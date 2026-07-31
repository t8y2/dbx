package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

var (
	quotedNamePattern       = regexp.MustCompile(`'([^']+)'`)
	declaredResourcePattern = regexp.MustCompile(`for (queue|exchange) '([^']+)'`)
)

func decodeJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(target)
}

func deepCopyObject(source jsonObject) jsonObject {
	if source == nil {
		return nil
	}
	encoded, err := json.Marshal(source)
	if err != nil {
		return nil
	}
	copy := jsonObject{}
	if err := decodeJSON(encoded, &copy); err != nil {
		return nil
	}
	return copy
}

func okResult() jsonObject {
	return jsonObject{"ok": true}
}

func objectOrNil(object jsonObject, key string) jsonObject {
	if object == nil {
		return nil
	}
	switch value := object[key].(type) {
	case jsonObject:
		return value
	case map[string]any:
		return jsonObject(value)
	default:
		return nil
	}
}

func arrayOrNil(object jsonObject, key string) []any {
	if object == nil {
		return nil
	}
	array, _ := object[key].([]any)
	return array
}

func stringOrNull(object jsonObject, key string) *string {
	if object == nil {
		return nil
	}
	value, exists := object[key]
	if !exists || value == nil {
		return nil
	}
	var result string
	switch typed := value.(type) {
	case string:
		result = typed
	case json.Number:
		result = typed.String()
	case bool:
		result = strconv.FormatBool(typed)
	case float64:
		result = strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		result = fmt.Sprint(typed)
	}
	return &result
}

func stringOrEmpty(object jsonObject, key string) string {
	return stringOrDefault(object, key, "")
}

func stringOrDefault(object jsonObject, key, fallback string) string {
	value := stringOrNull(object, key)
	if value == nil {
		return fallback
	}
	return *value
}

func integerOrNull(object jsonObject, key string) *int {
	value, ok := numberAsInt64(object, key)
	if !ok {
		return nil
	}
	converted := int(value)
	return &converted
}

func longOrNull(object jsonObject, key string) *int64 {
	value, ok := numberAsInt64(object, key)
	if !ok {
		return nil
	}
	return &value
}

func numberAsInt64(object jsonObject, key string) (int64, bool) {
	if object == nil {
		return 0, false
	}
	value, exists := object[key]
	if !exists || value == nil {
		return 0, false
	}
	switch typed := value.(type) {
	case json.Number:
		if integer, err := typed.Int64(); err == nil {
			return integer, true
		}
		decimal, err := typed.Float64()
		return int64(decimal), err == nil
	case float64:
		return int64(typed), true
	case float32:
		return int64(typed), true
	case int:
		return int64(typed), true
	case int8:
		return int64(typed), true
	case int16:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case int64:
		return typed, true
	case uint:
		return int64(typed), true
	case uint8:
		return int64(typed), true
	case uint16:
		return int64(typed), true
	case uint32:
		return int64(typed), true
	case uint64:
		return int64(typed), true
	case string:
		integer, err := strconv.ParseInt(typed, 10, 64)
		return integer, err == nil
	default:
		return 0, false
	}
}

func intOrDefault(object jsonObject, key string, fallback int) int {
	value := integerOrNull(object, key)
	if value == nil {
		return fallback
	}
	return *value
}

func longOrDefault(object jsonObject, key string, fallback int64) int64 {
	value := longOrNull(object, key)
	if value == nil {
		return fallback
	}
	return *value
}

func floatOrNull(object jsonObject, key string) *float64 {
	if object == nil {
		return nil
	}
	value, exists := object[key]
	if !exists || value == nil {
		return nil
	}
	var result float64
	var err error
	switch typed := value.(type) {
	case json.Number:
		result, err = typed.Float64()
	case float64:
		result = typed
	case float32:
		result = float64(typed)
	case int:
		result = float64(typed)
	case int64:
		result = float64(typed)
	case string:
		result, err = strconv.ParseFloat(typed, 64)
	default:
		return nil
	}
	if err != nil {
		return nil
	}
	return &result
}

func boolOrDefault(object jsonObject, key string, fallback bool) bool {
	if object == nil {
		return fallback
	}
	value, exists := object[key]
	if !exists || value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		parsed, err := strconv.ParseBool(typed)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func integerProperty(properties jsonObject, key string) (int, bool) {
	if properties == nil {
		return 0, false
	}
	value := integerOrNull(properties, key)
	if value == nil {
		return 0, false
	}
	return *value, true
}

func boolProperty(config jsonObject, key string) bool {
	return boolOrDefault(objectOrNil(config, "properties"), key, false)
}

func durationMilliseconds(object jsonObject, key string, fallback time.Duration) time.Duration {
	value := integerOrNull(object, key)
	if value == nil {
		return fallback
	}
	return time.Duration(*value) * time.Millisecond
}

func argumentValue(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case bool, string:
		return typed
	case json.Number:
		if integer, err := typed.Int64(); err == nil {
			return integer
		}
		if decimal, err := typed.Float64(); err == nil {
			return int64(decimal)
		}
		return nil
	case float64:
		return int64(typed)
	case float32:
		return int64(typed)
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return typed
	default:
		return nil
	}
}

func connectionObject(params jsonObject) jsonObject {
	if connection := objectOrNil(params, "connection"); connection != nil {
		return connection
	}
	return params
}

func (s *server) currentConnectionConfig(params jsonObject) jsonObject {
	if connection := objectOrNil(params, "connection"); connection != nil {
		return connection
	}
	return s.cachedConnection
}

func (s *server) requireConnectionConfig(params jsonObject) (jsonObject, error) {
	connection := s.currentConnectionConfig(params)
	if connection == nil {
		return nil, errors.New("Not connected. Call connect first.")
	}
	return connection, nil
}

func (s *server) requireConnection() (*amqp.Connection, error) {
	if s.connection == nil {
		return nil, errors.New("Not connected. Call connect first.")
	}
	return s.connection, nil
}

func queueName(params jsonObject) (string, error) {
	name := stringOrEmpty(params, "topic")
	if strings.TrimSpace(name) == "" {
		name = stringOrEmpty(params, "name")
	}
	if strings.TrimSpace(name) == "" {
		return "", errors.New("topic (queue name) is required")
	}
	return name, nil
}

func effectiveVhost(params, connection jsonObject) string {
	vhost := stringOrNull(params, "virtual_host")
	if vhost == nil || strings.TrimSpace(*vhost) == "" {
		if connection != nil {
			return stringOrDefault(connection, "virtual_host", "/")
		}
		return "/"
	}
	return *vhost
}

func allVhostsRequested(params jsonObject) bool {
	return boolOrDefault(params, "all_vhosts", false)
}

func managementListPath(params, connection jsonObject, resource string) string {
	if allVhostsRequested(params) {
		return "/api/" + resource
	}
	return "/api/" + resource + "/" + urlEncodeVhost(effectiveVhost(params, connection))
}

func vhostFilter(params, connection jsonObject) string {
	if allVhostsRequested(params) {
		return ""
	}
	return effectiveVhost(params, connection)
}

func attachVhost(info jsonObject, source jsonObject) {
	info["vhost"] = stringOrEmpty(source, "vhost")
}

func serverString(properties amqp.Table, key string) any {
	value, exists := properties[key]
	if !exists || value == nil {
		return nil
	}
	switch typed := value.(type) {
	case []byte:
		return string(typed)
	default:
		return fmt.Sprint(typed)
	}
}

func normalizeErrorMessage(err error) string {
	if err == nil {
		return "error"
	}
	if errors.Is(err, amqp.ErrCredentials) {
		return err.Error() + ". Hint: authentication failed. Check the RabbitMQ username, password, and virtual host permissions."
	}
	var amqpError *amqp.Error
	if errors.As(err, &amqpError) {
		if friendly := mapAMQPError(amqpError.Code, amqpError.Reason); friendly != "" {
			return friendly
		}
	}
	message := strings.TrimSpace(err.Error())
	if message == "" {
		return fmt.Sprintf("%T", err)
	}
	return message
}

func mapAMQPError(replyCode int, replyText string) string {
	switch replyCode {
	case 405:
		name := extractQuotedName(replyText)
		subject := "The queue"
		if name != "" {
			subject = "Queue '" + name + "'"
		}
		return subject + " is exclusive and owned by another connection. Hint: exclusive queues can only be accessed by their owning connection; stats via the management API are still available."
	case 404:
		name := extractQuotedName(replyText)
		kind := "Queue"
		if strings.Contains(replyText, "no exchange") {
			kind = "Exchange"
		}
		subject := "The " + strings.ToLower(kind)
		if name != "" {
			subject = kind + " '" + name + "'"
		}
		return subject + " was not found. Hint: it may have been deleted, or it never existed on this virtual host."
	case 406:
		name := extractDeclaredResourceName(replyText)
		kind := "Queue"
		if strings.Contains(replyText, "for exchange") {
			kind = "Exchange"
		}
		subject := "The " + strings.ToLower(kind)
		if name != "" {
			subject = kind + " '" + name + "'"
		}
		lowerKind := strings.ToLower(kind)
		return subject + " already exists with different parameters. Hint: " + lowerKind + " parameters are immutable after declaration; delete and re-declare the " + lowerKind + " to change them."
	case 403:
		name := extractQuotedName(replyText)
		subject := "the requested resource"
		if name != "" {
			subject = "'" + name + "'"
		}
		return "Access to " + subject + " was refused. Hint: check the user's configure/write/read permissions on the virtual host."
	default:
		return ""
	}
}

func extractQuotedName(replyText string) string {
	match := quotedNamePattern.FindStringSubmatch(replyText)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

func extractDeclaredResourceName(replyText string) string {
	match := declaredResourcePattern.FindStringSubmatch(replyText)
	if len(match) < 3 {
		return ""
	}
	return match[2]
}
