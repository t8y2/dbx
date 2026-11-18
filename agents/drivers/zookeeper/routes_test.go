package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"
)

func TestEndpointRoutesDecodeAndValidation(t *testing.T) {
	config, err := decodeConnectionConfig(json.RawMessage(`{"connection":{"zookeeper_connect_string":"remote.invalid,[2001:db8::1]:2182/root","zookeeper_endpoint_routes":{"remote.invalid:2181":"127.0.0.1:3001","[2001:db8::1]:2182":"[::1]:3002"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	target, err := parseConnectTarget(connectionString(config))
	if err != nil {
		t.Fatal(err)
	}
	routes, err := validateEndpointRoutes(target.Servers, config.EndpointRoutes)
	if err != nil || target.Chroot != "/root" || len(routes) != 2 {
		t.Fatalf("target=%+v routes=%v err=%v", target, routes, err)
	}
	config.EndpointRoutes["remote.invalid:2181"] = "127.0.0.1:9999"
	if routes["remote.invalid:2181"] != "127.0.0.1:3001" {
		t.Fatal("routes alias mutable input")
	}
	for name, routes := range map[string]map[string]string{
		"empty":                  {},
		"missing":                {"other:2181": "127.0.0.1:3001"},
		"nonlocal":               {"remote.invalid:2181": "192.0.2.1:3001"},
		"dns destination":        {"remote.invalid:2181": "localhost:3001"},
		"invalid port":           {"remote.invalid:2181": "127.0.0.1:0"},
		"duplicate normalized":   {"remote.invalid": "127.0.0.1:3001", "remote.invalid:2181": "127.0.0.1:3002"},
		"duplicate numeric port": {"remote.invalid:02181": "127.0.0.1:3001", "remote.invalid:2181": "127.0.0.1:3002"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := validateEndpointRoutes([]string{"remote.invalid"}, routes); err == nil {
				t.Fatal("expected invalid routes")
			}
		})
	}
	if routes, err := validateEndpointRoutes(target.Servers, nil); routes != nil || err != nil {
		t.Fatalf("direct route changed: %v %v", routes, err)
	}
}

func TestRoutedHostProviderPreservesNamesAndFailoverCycle(t *testing.T) {
	provider := &routedHostProvider{}
	if err := provider.Init([]string{"unresolvable.invalid:02181", "[2001:db8::1]:2182", "third.invalid:2183"}); err != nil {
		t.Fatal(err)
	}
	if provider.Len() != 3 {
		t.Fatal("lost servers")
	}
	first, retry := provider.Next()
	if first != "unresolvable.invalid:2181" || retry {
		t.Fatalf("first=%s retry=%v", first, retry)
	}
	second, retry := provider.Next()
	if second != "[2001:db8::1]:2182" || retry {
		t.Fatalf("second=%s retry=%v", second, retry)
	}
	provider.Connected()
	third, retry := provider.Next()
	if third != "third.invalid:2183" || retry {
		t.Fatalf("third=%s retry=%v", third, retry)
	}
	provider.Next()
	next, retry := provider.Next()
	if next != second || !retry {
		t.Fatalf("reconnect cycle=%s retry=%v", next, retry)
	}
}

func TestRoutedDialAndMetadataNeverNeedLocalDNS(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(time.Second))
				b := make([]byte, 4)
				if n, _ := conn.Read(b); n == 4 {
					_, _ = conn.Write([]byte("Zookeeper version: 3.8.6, built on test\n"))
				}
			}()
		}
	}()
	routes, err := validateEndpointRoutes([]string{"remote.invalid:02181"}, map[string]string{"remote.invalid:2181": listener.Addr().String()})
	if err != nil {
		t.Fatal(err)
	}
	if err := requireReachableServer([]string{"remote.invalid:02181"}, time.Second, nil, routes); err != nil {
		t.Fatal(err)
	}
	conn, err := newZooKeeperDialer(time.Second, nil, nil, routes)("tcp", "remote.invalid:02181", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if version := detectServerVersion([]string{"remote.invalid:02181"}, time.Second, nil, routes); version != "3.8.6" {
		t.Fatalf("version=%q", version)
	}
	// A valid, listening direct address still must not be dialed if absent in
	// an explicitly supplied routing table.
	if conn, err := dialZooKeeperConnection(listener.Addr().String(), time.Second, nil, routes); err == nil {
		conn.Close()
		t.Fatal("missing route fell back to direct dial")
	}
	if conn, err := dialZooKeeperConnection(listener.Addr().String(), time.Second, nil, nil); err != nil {
		t.Fatal(err)
	} else {
		conn.Close()
	}
}

func TestRoutedTLSVerifiesLogicalIdentity(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"secure.invalid"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool.AddCert(parsed)
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(time.Second))
				_ = conn.(*tls.Conn).Handshake()
			}()
		}
	}()
	config := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	routes := map[string]string{"secure.invalid:2181": listener.Addr().String(), "wrong.invalid:2181": listener.Addr().String()}
	conn, err := dialZooKeeperConnection("secure.invalid:2181", time.Second, config, routes)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if config.ServerName != "" {
		t.Fatal("mutated shared TLS config")
	}
	conn, err = dialZooKeeperConnection("wrong.invalid:2181", time.Second, config, routes)
	if err == nil {
		conn.Close()
		t.Fatal("accepted wrong logical peer")
	}
	if !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("unexpected error: %v", err)
	}
}
