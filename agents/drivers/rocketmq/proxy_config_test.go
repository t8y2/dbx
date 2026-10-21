package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProxyConnectionDoesNotRequireNameServer(t *testing.T) {
	if _, err := parseConnection(map[string]any{"connection_mode": "proxy", "proxy_endpoint": "proxy.example.com:8081"}); err != nil {
		t.Fatalf("proxy-only connection must not require namesrv_addr: %v", err)
	}
}

func TestProxyConnectionValidation(t *testing.T) {
	tests := []map[string]any{
		{"connection_mode": "invalid", "namesrv_addr": "localhost:9876"},
		{"connection_mode": "proxy"},
		{"connection_mode": "proxy", "proxy_endpoint": "https://proxy:8081"},
		{"connection_mode": "proxy", "proxy_endpoint": "proxy:8081", "management_enabled": true},
		{"connection_mode": "proxy", "proxy_endpoint": "proxy:8081", "access_key": "only-ak"},
	}
	for _, params := range tests {
		if _, err := parseConnection(params); err == nil {
			t.Errorf("expected invalid config to fail: %v", params)
		}
	}
}

func TestHandshakeAdvertisesProxyTransport(t *testing.T) {
	result, err := newRocketMQAgent().dispatch("handshake", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), `"rocketmq_proxy_grpc"`) {
		t.Fatalf("handshake missing proxy capability: %s", data)
	}
}
