package main

import (
	v2 "github.com/apache/rocketmq-clients/golang/v5/protocol/v2"
	"testing"
	"time"
)

func TestProxyPeriodicHeartbeatFailureClosesRPCTransport(t *testing.T) {
	service, config := startProxyTestService(t)
	a := newRocketMQAgent()
	defer a.close()
	if _, err := dispatchProxyTest(t, a, "connect", config); err != nil {
		t.Fatal(err)
	}
	service.mu.Lock()
	service.heartbeatCode = v2.Code_FORBIDDEN
	service.mu.Unlock()
	select {
	case <-service.connectionEnded:
	case <-time.After(12 * time.Second):
		t.Fatal("periodic heartbeat failure leaked the RPC connection")
	}
}

func TestProxyTelemetryFailureClosesRPCTransport(t *testing.T) {
	for _, business := range []bool{false, true} {
		t.Run(map[bool]string{false: "receive", true: "status"}[business], func(t *testing.T) {
			service, config := startProxyTestService(t)
			a := newRocketMQAgent()
			defer a.close()
			if _, err := dispatchProxyTest(t, a, "connect", config); err != nil {
				t.Fatal(err)
			}
			service.failTelemetry <- business
			select {
			case <-service.connectionEnded:
			case <-time.After(time.Second):
				t.Fatal("terminal Telemetry error did not close underlying RPC transport")
			}
		})
	}
}

func TestProxyDoesNotInstallSessionLostDuringManagement(t *testing.T) {
	_, oldConfig := startProxyTestService(t)
	a := newRocketMQAgent()
	defer a.close()
	if _, err := dispatchProxyTest(t, a, "connect", oldConfig); err != nil {
		t.Fatal(err)
	}
	a.mu.RLock()
	old := a.messaging
	a.mu.RUnlock()
	service, config := startProxyTestService(t)
	address, _ := startProxyManagementFixture(t)
	config["management_enabled"] = true
	config["namesrv_addr"] = address
	config["connect_timeout_ms"] = float64(600)
	config["request_timeout_ms"] = float64(600)
	result := make(chan error, 1)
	go func() { _, err := dispatchProxyTest(t, a, "connect", config); result <- err }()
	select {
	case <-service.heartbeatSeen:
	case <-time.After(time.Second):
		t.Fatal("new session never reached heartbeat")
	}
	service.failTelemetry <- false
	if err := <-result; err == nil {
		t.Fatal("dead messaging session reported ready after management setup")
	}
	a.mu.RLock()
	current := a.messaging
	a.mu.RUnlock()
	if current != old || old.ctx.Err() != nil {
		t.Fatal("failed replacement destroyed the prior working session")
	}
	select {
	case <-service.connectionEnded:
	case <-time.After(time.Second):
		t.Fatal("failed replacement leaked RPC connection")
	}
}
