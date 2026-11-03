package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	v2 "github.com/apache/rocketmq-clients/golang/v5/protocol/v2"
	"google.golang.org/grpc"
	grpccredentials "google.golang.org/grpc/credentials"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestProxyTrustedTLSWithDialOverride(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	certificate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "proxy.example.invalid"}, DNSNames: []string{"proxy.example.invalid"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	pair, err := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		t.Fatal(err)
	}
	rootFile := filepath.Join(t.TempDir(), "trusted-proxy.pem")
	if err = os.WriteFile(rootFile, certPEM, 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	service := &proxyTestService{t: t, address: listener.Addr().String(), heartbeatCode: v2.Code_OK, routeCode: v2.Code_OK, sendCode: v2.Code_OK, entryCode: v2.Code_OK, permission: v2.Permission_READ_WRITE, messageType: v2.MessageType_NORMAL}
	server := grpc.NewServer(grpc.Creds(grpccredentials.NewTLS(&tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12})))
	v2.RegisterMessagingServiceServer(server, service)
	go func() { _ = server.Serve(listener) }()
	defer server.Stop()
	runProxyProcessTest(t, map[string]any{"connection_mode": "proxy", "proxy_endpoint": "proxy.example.invalid:8081", "proxy_dial_endpoint": listener.Addr().String(), "proxy_tls": true, "access_key": "access", "secret_key": "secret", "connect_timeout_ms": float64(2000)}, []string{"DBX_ROCKETMQ_TEST_ROOTS=" + rootFile, "GODEBUG=x509usefallbackroots=1"})
}

func TestProxyProcessKeepsSDKLogsOffStdout(t *testing.T) {
	_, config := startProxyTestService(t)
	runProxyProcessTest(t, config, nil)
}

func runProxyProcessTest(t *testing.T, config map[string]any, environment []string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRocketMQAgentHelperProcess$")
	command.Env = append(os.Environ(), rocketMQHelperProcessEnv+"=1", "mq.consoleAppender.enabled=true")
	command.Env = append(command.Env, environment...)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr synchronizedBuffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	}()
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != `{"ready":true}` {
		t.Fatalf("unexpected ready %q %s", scanner.Text(), stderr.String())
	}
	for index, request := range []struct {
		method string
		params map[string]any
	}{{"connect", config}, {"mq_send_message", map[string]any{"topic": "orders", "payload": "hello"}}, {"shutdown", map[string]any{}}} {
		raw, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": index + 1, "method": request.method, "params": request.params})
		if err != nil {
			t.Fatal(err)
		}
		writeRPCRequest(t, stdin, string(raw))
		response := readRPCResponse(t, scanner, stderr.String())
		if response.Error != nil {
			t.Fatalf("%s: %s", request.method, response.Error.Message)
		}
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("agent failed: %v %s", err, stderr.String())
	}
}
