package main

import (
	"encoding/json"
	"testing"
)

func TestHandshakeAndShutdown(t *testing.T) {
	agent := newRocketMQAgent()
	result, err := agent.dispatch("handshake", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	handshake := result.(map[string]any)
	if handshake["protocolVersion"] != protocolVersion || handshake["agentProtocolVersion"] != agentProtocolVersion {
		t.Fatalf("unexpected handshake: %#v", handshake)
	}
	if _, err := agent.dispatch("shutdown", nil); err != nil {
		t.Fatal(err)
	}
	if !agent.shutdownRequested {
		t.Fatal("shutdown flag was not set")
	}
}

func TestDispatchRejectsInvalidParamsAndUnknownMethods(t *testing.T) {
	agent := newRocketMQAgent()
	if _, err := agent.dispatch("handshake", json.RawMessage(`[]`)); err == nil {
		t.Fatal("expected array params to fail")
	}
	if _, err := agent.dispatch("does_not_exist", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected unknown method to fail")
	}
}
