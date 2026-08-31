package gohive

import (
	"context"
	"encoding/binary"
	"strings"
	"testing"

	"github.com/apache/thrift/lib/go/thrift"
)

func TestNewTSaslTransportRejectsUnsupportedMechanism(t *testing.T) {
	transport := thrift.NewTMemoryBufferLen(32)
	if _, err := NewTSaslTransport(transport, "hs2.example.com", "UNKNOWN", nil, 1024); err == nil || !strings.Contains(err.Error(), "unsupported SASL mechanism") {
		t.Fatalf("expected unsupported mechanism error, got %v", err)
	}
}

func TestNewTSaslTransportRejectsInvalidTransportAndLimit(t *testing.T) {
	if _, err := NewTSaslTransport(nil, "hs2.example.com", "PLAIN", map[string]string{}, 1024); err == nil {
		t.Fatal("expected missing transport error")
	}
	if _, err := NewTSaslTransport(thrift.NewTMemoryBufferLen(32), "hs2.example.com", "PLAIN", map[string]string{}, 0); err == nil {
		t.Fatal("expected invalid maximum length error")
	}
}

func TestRecvSaslMsgRejectsOversizedNegotiationFrame(t *testing.T) {
	underlying := thrift.NewTMemoryBufferLen(16)
	header := make([]byte, 5)
	header[0] = OK
	binary.BigEndian.PutUint32(header[1:], 2048)
	if _, err := underlying.Write(header); err != nil {
		t.Fatal(err)
	}
	transport, err := NewTSaslTransport(underlying, "hs2.example.com", "PLAIN", map[string]string{}, 1024)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = transport.recvSaslMsg(context.Background())
	if err == nil || !strings.Contains(err.Error(), "exceeds maximum") {
		t.Fatalf("expected oversized negotiation frame error, got %v", err)
	}
}
