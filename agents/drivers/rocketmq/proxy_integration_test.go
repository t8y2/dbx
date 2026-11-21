package main

import (
	"os"
	"testing"
	"time"
)

// This test intentionally starts no mock server: it proves that the official
// Proxy accepts Settings registration, authenticated Heartbeat and ordinary sends.
// Provision a NORMAL topic first; this test publishes one message to that topic.
func TestRocketMQProxyIntegration(t *testing.T) {
	if os.Getenv("ROCKETMQ_PROXY_INTEGRATION") != "1" {
		t.Skip("set ROCKETMQ_PROXY_INTEGRATION=1 with an official Proxy and pre-created NORMAL topic")
	}
	endpoint := os.Getenv("ROCKETMQ_PROXY_ENDPOINT")
	if endpoint == "" {
		t.Fatal("ROCKETMQ_PROXY_ENDPOINT is required")
	}
	topic := os.Getenv("ROCKETMQ_PROXY_TOPIC")
	if topic == "" {
		t.Fatal("ROCKETMQ_PROXY_TOPIC is required")
	}
	config := map[string]any{"connection_mode": "proxy", "proxy_endpoint": endpoint, "proxy_tls": os.Getenv("ROCKETMQ_PROXY_TLS") != "false", "access_key": os.Getenv("ROCKETMQ_PROXY_ACCESS_KEY"), "secret_key": os.Getenv("ROCKETMQ_PROXY_SECRET_KEY"), "connect_timeout_ms": float64(5000), "request_timeout_ms": float64(10000)}
	if dial := os.Getenv("ROCKETMQ_PROXY_DIAL_ENDPOINT"); dial != "" {
		config["proxy_dial_endpoint"] = dial
	}
	a := newRocketMQAgent()
	defer a.close()
	if _, err := dispatchProxyTest(t, a, "connect", config); err != nil {
		t.Fatal(err)
	}
	result, err := dispatchProxyTest(t, a, "mq_send_message", map[string]any{"topic": topic, "payload": "DBX official Proxy interoperability " + time.Now().UTC().Format(time.RFC3339Nano), "key": "DBX_PROXY_INTEROP", "tag": "DBX", "headers": map[string]any{"dbxProbe": "ordinary"}})
	if err != nil {
		t.Fatalf("official Proxy ordinary send after Telemetry registration: %v", err)
	}
	row := result.(map[string]any)
	if row["ok"] != true || row["messageId"] == "" {
		t.Fatalf("invalid send receipt: %#v", row)
	}
	t.Logf("official Proxy accepted ordinary send after Telemetry registration: messageId=%v partition=%v offset=%v", row["messageId"], row["partition"], row["offset"])
}
