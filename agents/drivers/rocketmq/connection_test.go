package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	admin "github.com/amigoer/rocketmq-admin-go"
)

func TestParseConnectionSupportsAliasesAndMultipleNameServers(t *testing.T) {
	config, err := parseConnection(map[string]any{"connection": map[string]any{
		"namesrvAddr":        "127.0.0.1:9876; [2001:db8::1]:9876,127.0.0.1:9876",
		"clusterName":        "DefaultCluster",
		"brokerAddr":         "broker.example.com:10911",
		"accessKey":          "access",
		"secretKey":          "secret",
		"request_timeout_ms": float64(12_000),
		"connect_timeout_ms": "4500",
		"tls_skip_verify":    true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	wantServers := []string{"127.0.0.1:9876", "[2001:db8::1]:9876"}
	if !reflect.DeepEqual(config.NameServers, wantServers) {
		t.Fatalf("NameServers = %#v, want %#v", config.NameServers, wantServers)
	}
	if config.ClusterName != "DefaultCluster" || config.BrokerAddr != "broker.example.com:10911" {
		t.Fatalf("unexpected route config: %#v", config)
	}
	if config.AccessKey != "access" || config.SecretKey != "secret" {
		t.Fatalf("unexpected credentials: %#v", config)
	}
	if config.RequestTimeout != 12*time.Second || config.ConnectTimeout != 4500*time.Millisecond {
		t.Fatalf("unexpected timeouts: %#v", config)
	}
	if !config.TLSSkipVerify {
		t.Fatal("tls_skip_verify was not parsed")
	}
}

func TestParseConnectionValidatesNameServerAndSocksProxy(t *testing.T) {
	if _, err := parseConnection(map[string]any{}); err == nil {
		t.Fatal("expected missing namesrv_addr to fail")
	}
	if _, err := parseConnection(map[string]any{
		"namesrv_addr": "127.0.0.1:9876",
		"socks_proxy":  map[string]any{"host": "127.0.0.1"},
	}); err == nil {
		t.Fatal("expected incomplete socks_proxy to fail")
	}
}

func TestConnectionConfigEqualIncludesTLSSkipVerify(t *testing.T) {
	base := connectionConfig{NameServers: []string{"127.0.0.1:9876"}}
	other := base
	other.TLSSkipVerify = true
	if base.equal(other) {
		t.Fatal("configs with different tls_skip_verify values must not be equal")
	}
}

func TestWaitForBrokerRegistrationRetriesUntilMasterAppears(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	calls := 0
	info, err := waitForBrokerRegistration(ctx, time.Millisecond, func(context.Context) (*admin.ClusterInfo, error) {
		calls++
		if calls < 3 {
			return &admin.ClusterInfo{BrokerAddrTable: map[string]*admin.BrokerData{}}, nil
		}
		return &admin.ClusterInfo{BrokerAddrTable: map[string]*admin.BrokerData{
			"broker-a": {BrokerAddrs: map[string]string{"0": "127.0.0.1:10911"}},
		}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 3 || !hasMasterBroker(info) {
		t.Fatalf("calls = %d, info = %#v", calls, info)
	}
}

func TestWaitForBrokerRegistrationTimesOut(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err := waitForBrokerRegistration(ctx, time.Millisecond, func(context.Context) (*admin.ClusterInfo, error) {
		return &admin.ClusterInfo{BrokerAddrTable: map[string]*admin.BrokerData{}}, nil
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context deadline exceeded", err)
	}
}

func TestParseAndFormatSocketAddress(t *testing.T) {
	tests := []struct {
		address   string
		host      string
		port      string
		formatted string
	}{
		{"127.0.0.1:9876", "127.0.0.1", "9876", "127.0.0.1:9876"},
		{"[2001:db8::1]:9876", "2001:db8::1", "9876", "[2001:db8::1]:9876"},
		{"broker.example.com", "broker.example.com", "", "broker.example.com"},
	}
	for _, test := range tests {
		host, port := parseSocketAddress(test.address)
		if host != test.host || port != test.port {
			t.Fatalf("parseSocketAddress(%q) = %q, %q", test.address, host, port)
		}
		if formatted := formatSocketAddress(host, port); formatted != test.formatted {
			t.Fatalf("formatSocketAddress(%q, %q) = %q", host, port, formatted)
		}
	}
}
