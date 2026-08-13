package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
)

func nestedMap(params map[string]any, key string) map[string]any {
	value, ok := params[key]
	if !ok || value == nil {
		return nil
	}
	if result, ok := value.(map[string]any); ok {
		return result
	}
	return nil
}

func stringValue(params map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := params[key]; ok && value != nil {
			switch typed := value.(type) {
			case string:
				return strings.TrimSpace(typed)
			case json.Number:
				return typed.String()
			case float64:
				return strconv.FormatFloat(typed, 'f', -1, 64)
			}
		}
	}
	return ""
}

func requireString(params map[string]any, keys ...string) (string, error) {
	value := stringValue(params, keys...)
	if value == "" {
		return "", fmt.Errorf("%s is required", keys[0])
	}
	return value, nil
}

func intValue(params map[string]any, defaultValue int, keys ...string) int {
	for _, key := range keys {
		value, ok := params[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case float64:
			return int(typed)
		case json.Number:
			parsed, err := typed.Int64()
			if err == nil {
				return int(parsed)
			}
		case string:
			parsed, err := strconv.Atoi(strings.TrimSpace(typed))
			if err == nil {
				return parsed
			}
		}
	}
	return defaultValue
}

func int64Value(params map[string]any, defaultValue int64, keys ...string) int64 {
	for _, key := range keys {
		value, ok := params[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case float64:
			return int64(typed)
		case json.Number:
			parsed, err := typed.Int64()
			if err == nil {
				return parsed
			}
		case string:
			parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
			if err == nil {
				return parsed
			}
		}
	}
	return defaultValue
}

func boolValue(params map[string]any, defaultValue bool, keys ...string) bool {
	for _, key := range keys {
		value, ok := params[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case bool:
			return typed
		case string:
			parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
			if err == nil {
				return parsed
			}
		}
	}
	return defaultValue
}

func decodePayload(params map[string]any) ([]byte, error) {
	encoded := stringValue(params, "payloadBase64")
	if encoded != "" {
		payload, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fmt.Errorf("invalid payloadBase64: %w", err)
		}
		return payload, nil
	}
	return []byte(stringValue(params, "payload", "payloadText")), nil
}

func splitAddresses(value string) []string {
	fields := strings.FieldsFunc(value, func(char rune) bool {
		return char == ';' || char == ',' || char == '\n' || char == '\r' || char == '\t' || char == ' '
	})
	seen := map[string]struct{}{}
	result := make([]string, 0, len(fields))
	for _, field := range fields {
		address := strings.TrimSpace(field)
		if address == "" {
			continue
		}
		if _, ok := seen[address]; ok {
			continue
		}
		seen[address] = struct{}{}
		result = append(result, address)
	}
	return result
}

func parseSocketAddress(address string) (string, string) {
	trimmed := strings.TrimSpace(address)
	if trimmed == "" {
		return "", ""
	}
	if host, port, err := net.SplitHostPort(trimmed); err == nil {
		return strings.Trim(host, "[]"), port
	}
	colon := strings.LastIndex(trimmed, ":")
	if colon <= 0 || colon == len(trimmed)-1 {
		return trimmed, ""
	}
	if _, err := strconv.Atoi(trimmed[colon+1:]); err != nil {
		return trimmed, ""
	}
	return strings.Trim(trimmed[:colon], "[]"), trimmed[colon+1:]
}

func formatSocketAddress(host, port string) string {
	if host == "" {
		return port
	}
	if port == "" {
		return host
	}
	return net.JoinHostPort(strings.Trim(host, "[]"), port)
}

func isLikelyUnreachableBrokerHost(host string) bool {
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "" || host == "127.0.0.1" || host == "localhost" || host == "::1" {
		return false
	}
	if strings.HasSuffix(host, ".docker") || strings.Contains(host, ".docker.") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsPrivate()
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func paginate[T any](items []T, offset, limit int) []T {
	if offset < 0 {
		offset = 0
	}
	if offset >= len(items) {
		return []T{}
	}
	end := len(items)
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	return items[offset:end]
}

func normalizeTopicPerm(perm int) int {
	switch perm {
	case 2, 4, 6:
		return perm
	default:
		return 6
	}
}

func normalizeMessageType(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if value == "" {
		return "NORMAL"
	}
	if value == "ORDER" {
		return "FIFO"
	}
	return value
}
