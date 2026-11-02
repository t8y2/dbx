package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
)

func startProxyManagementFixture(t *testing.T) (string, *atomic.Bool) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var ready atomic.Bool
	var connections sync.Map
	done := make(chan struct{})
	t.Cleanup(func() {
		close(done)
		_ = listener.Close()
		connections.Range(func(k, v any) bool { _ = k.(net.Conn).Close(); return true })
	})
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			connections.Store(conn, true)
			go func() {
				defer conn.Close()
				defer connections.Delete(conn)
				for {
					size := make([]byte, 4)
					if _, err := io.ReadFull(conn, size); err != nil {
						return
					}
					n := binary.BigEndian.Uint32(size)
					if n > 1024*1024 {
						return
					}
					data := make([]byte, n)
					if _, err := io.ReadFull(conn, data); err != nil {
						return
					}
					request, err := remoting.Decode(data)
					if err != nil {
						return
					}
					if !ready.Load() {
						select {
						case <-done:
							return
						case <-time.After(2 * time.Second):
							return
						}
					}
					body, _ := json.Marshal(map[string]any{"clusterAddrTable": map[string]any{"DefaultCluster": []string{"broker-a"}}, "brokerAddrTable": map[string]any{"broker-a": map[string]any{"cluster": "DefaultCluster", "brokerName": "broker-a", "brokerAddrs": map[string]string{"0": listener.Addr().String()}}}})
					response := &remoting.RemotingCommand{Code: 0, Opaque: request.Opaque, Flag: 1, Body: body}
					encoded, err := response.Encode()
					if err != nil {
						return
					}
					if _, err = conn.Write(encoded); err != nil {
						return
					}
				}
			}()
		}
	}()
	return listener.Addr().String(), &ready
}

func TestProxyManagementBudgetDoesNotConsumeMessagingConnectBudget(t *testing.T) {
	_, config := startProxyTestService(t)
	address, _ := startProxyManagementFixture(t)
	config["management_enabled"] = true
	config["namesrv_addr"] = address
	config["connect_timeout_ms"] = float64(450)
	config["request_timeout_ms"] = float64(450)
	a := newRocketMQAgent()
	defer a.close()
	start := time.Now()
	result, err := dispatchProxyTest(t, a, "connect", config)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 320*time.Millisecond {
		t.Fatalf("optional management exhausted messaging connect budget: %v", elapsed)
	}
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), `"status":"degraded"`) {
		t.Fatalf("expected degraded management: %s", data)
	}
}

func TestProxyTestConnectionRestoresSameActiveManagementChannel(t *testing.T) {
	_, config := startProxyTestService(t)
	address, ready := startProxyManagementFixture(t)
	config["management_enabled"] = true
	config["namesrv_addr"] = address
	config["connect_timeout_ms"] = float64(300)
	config["request_timeout_ms"] = float64(300)
	a := newRocketMQAgent()
	defer a.close()
	if _, err := dispatchProxyTest(t, a, "connect", config); err != nil {
		t.Fatal(err)
	}
	a.mu.RLock()
	old := a.messaging
	a.mu.RUnlock()
	ready.Store(true)
	result, err := dispatchProxyTest(t, a, "test_connection", config)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), `"management":{"status":"ready"}`) {
		t.Fatalf("expected management recovery: %s", data)
	}
	a.mu.RLock()
	client, current := a.client, a.messaging
	a.mu.RUnlock()
	if client == nil {
		t.Fatal("test reports management ready but active management client is nil")
	}
	if current == old || old.ctx.Err() == nil {
		t.Fatal("old messaging connection was not replaced and closed")
	}
	if _, err := dispatchProxyTest(t, a, "mq_describe_cluster", map[string]any{}); err != nil {
		t.Fatalf("recovered management is unusable: %v", err)
	}
}
