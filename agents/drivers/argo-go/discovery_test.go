package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/go-zookeeper/zk"
)

func TestParseHiveServerRegistrationFromChildName(t *testing.T) {
	value, err := parseHiveServerRegistration("serverUri=hs2.example.com:10000;version=4.0.1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if value != (endpoint{Host: "hs2.example.com", Port: 10000}) {
		t.Fatalf("unexpected endpoint: %#v", value)
	}
}

func TestParseHiveServerRegistrationFromData(t *testing.T) {
	value, err := parseHiveServerRegistration("instance-0001", []byte(`{"serverUri":"thrift://kyuubi.example.com:10009"}`))
	if err != nil {
		t.Fatal(err)
	}
	if value != (endpoint{Host: "kyuubi.example.com", Port: 10009}) {
		t.Fatalf("unexpected endpoint: %#v", value)
	}
}

func TestRejectedEndpointsAreExcluded(t *testing.T) {
	values := shuffledEndpoints([]endpoint{{Host: "one", Port: 1}, {Host: "two", Port: 2}}, map[string]bool{"one:1": true})
	if len(values) != 1 || values[0].Host != "two" {
		t.Fatalf("unexpected endpoints: %#v", values)
	}
}

func TestParsePublishedHiveServerConfiguration(t *testing.T) {
	value, err := parseHiveServerRegistration("instance-1", []byte(
		"hive.server2.thrift.bind.host=hs2.example.com;"+
			"hive.server2.transport.mode=http;"+
			"hive.server2.thrift.http.port=10001;"+
			"hive.server2.thrift.http.path=cliservice;"+
			"hive.server2.authentication=KERBEROS;"+
			"hive.server2.authentication.kerberos.principal=hive/_HOST@EXAMPLE.COM;"+
			"hive.server2.use.ssl=true",
	))
	if err != nil {
		t.Fatal(err)
	}
	if value.Host != "hs2.example.com" || value.Port != 10001 || value.TransportMode != "http" || value.HTTPPath != "cliservice" || value.Auth != "KERBEROS" || !value.SSL {
		t.Fatalf("unexpected endpoint: %#v", value)
	}
}

func TestParseActivePassiveServiceRecord(t *testing.T) {
	value, err := parseHiveServerRegistration("instance-0001", []byte(`{
		"hive.server2.transport.mode":"binary",
		"hive.server2.authentication":"KERBEROS",
		"hive.server2.authentication.kerberos.principal":"hive/_HOST@EXAMPLE.COM",
		"internal":[{
			"api":"activeEndpoint",
			"addresses":[{"host":"active.example.com","port":"10000"}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if value.Host != "active.example.com" || value.Port != 10000 || value.Auth != "KERBEROS" || value.TransportMode != "binary" {
		t.Fatalf("unexpected active endpoint: %#v", value)
	}
}

func TestZooKeeperHAPaths(t *testing.T) {
	discovery := &zooKeeperDiscovery{namespace: "hs2ActivePassiveHA", discoveryMode: "zooKeeperHA"}
	want := []string{
		"/hs2ActivePassiveHA/instances",
		"/hs2ActivePassiveHA-unsecure/instances",
		"/hs2ActivePassiveHA-sasl/instances",
	}
	got := discovery.paths()
	if len(got) != len(want) {
		t.Fatalf("unexpected paths: %#v", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("path %d = %q, want %q", index, got[index], want[index])
		}
	}
}

func TestZooKeeperPathNormalizesEmptyNamespace(t *testing.T) {
	if value := zooKeeperPath(""); value != "/" {
		t.Fatalf("unexpected root path: %q", value)
	}
	if value := zooKeeperPath("", "instances"); value != "/instances" {
		t.Fatalf("unexpected instances path: %q", value)
	}
}

func TestWaitForZooKeeperSession(t *testing.T) {
	events := make(chan zk.Event, 2)
	events <- zk.Event{State: zk.StateConnected}
	events <- zk.Event{State: zk.StateHasSession}
	if err := waitForZooKeeperSession(context.Background(), events, time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestWaitForZooKeeperSessionRejectsAuthFailure(t *testing.T) {
	events := make(chan zk.Event, 1)
	events <- zk.Event{State: zk.StateAuthFailed}
	if err := waitForZooKeeperSession(context.Background(), events, time.Second); err == nil {
		t.Fatal("expected authentication failure")
	}
}

type fakeZooKeeperClient struct {
	children map[string][]string
	data     map[string][]byte
	auth     []byte
	closed   bool
}

func (client *fakeZooKeeperClient) AddAuth(_ string, auth []byte) error {
	client.auth = append([]byte(nil), auth...)
	return nil
}

func (client *fakeZooKeeperClient) Children(path string) ([]string, *zk.Stat, error) {
	children, ok := client.children[path]
	if !ok {
		return nil, nil, zk.ErrNoNode
	}
	return append([]string(nil), children...), nil, nil
}

func (client *fakeZooKeeperClient) Get(path string) ([]byte, *zk.Stat, error) {
	data, ok := client.data[path]
	if !ok {
		return nil, nil, zk.ErrNoNode
	}
	return append([]byte(nil), data...), nil, nil
}

func (client *fakeZooKeeperClient) Close() { client.closed = true }

func TestZooKeeperDiscoveryUsesSessionAuthAndSkipsStaleNodes(t *testing.T) {
	client := &fakeZooKeeperClient{
		children: map[string][]string{"/hiveserver2": {"stale", "live"}},
		data: map[string][]byte{
			"/hiveserver2/live": []byte("serverUri=live.example.com:10000"),
		},
	}
	discovery := &zooKeeperDiscovery{
		servers:       []endpoint{{Host: "zk.example.com", Port: 2181}},
		namespace:     "hiveserver2",
		authScheme:    "digest",
		auth:          "user:password",
		timeout:       time.Second,
		discoveryMode: "zookeeper",
		dialer: func([]string, time.Duration) (zooKeeperClient, <-chan zk.Event, error) {
			events := make(chan zk.Event, 1)
			events <- zk.Event{State: zk.StateHasSession}
			return client, events, nil
		},
	}
	values, err := discovery.Endpoints(context.Background(), map[string]bool{})
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 1 || values[0].Host != "live.example.com" {
		t.Fatalf("unexpected endpoints: %#v", values)
	}
	if string(client.auth) != "user:password" || !client.closed {
		t.Fatalf("auth=%q closed=%v", client.auth, client.closed)
	}
}

func TestZooKeeperHAFallsThroughStaleCandidatePath(t *testing.T) {
	client := &fakeZooKeeperClient{
		children: map[string][]string{
			"/hs2ActivePassiveHA/instances":          {"stale"},
			"/hs2ActivePassiveHA-unsecure/instances": {"live"},
		},
		data: map[string][]byte{
			"/hs2ActivePassiveHA-unsecure/instances/live": []byte("serverUri=active.example.com:10000"),
		},
	}
	discovery := &zooKeeperDiscovery{
		servers:       []endpoint{{Host: "zk.example.com", Port: 2181}},
		namespace:     "hs2ActivePassiveHA",
		timeout:       time.Second,
		discoveryMode: "zookeeperHA",
		dialer: func([]string, time.Duration) (zooKeeperClient, <-chan zk.Event, error) {
			events := make(chan zk.Event, 1)
			events <- zk.Event{State: zk.StateHasSession}
			return client, events, nil
		},
	}
	values, err := discovery.Endpoints(context.Background(), map[string]bool{})
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 1 || values[0].Host != "active.example.com" {
		t.Fatalf("unexpected HA endpoints: %#v", values)
	}
}

func TestZooKeeperDiscoveryPropagatesDialError(t *testing.T) {
	discovery := &zooKeeperDiscovery{
		servers: []endpoint{{Host: "zk.example.com", Port: 2181}},
		dialer: func([]string, time.Duration) (zooKeeperClient, <-chan zk.Event, error) {
			return nil, nil, errors.New("dial failed")
		},
	}
	if _, err := discovery.Endpoints(context.Background(), nil); err == nil {
		t.Fatal("expected dial error")
	}
}
