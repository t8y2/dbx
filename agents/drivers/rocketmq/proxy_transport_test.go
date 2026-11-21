package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	v2 "github.com/apache/rocketmq-clients/golang/v5/protocol/v2"
	"google.golang.org/grpc"
	grpccredentials "google.golang.org/grpc/credentials"
)

func TestProxyDialOverridePreservesLogicalEndpoint(t *testing.T) {
	_, config := startProxyTestService(t)
	config["proxy_dial_endpoint"] = config["proxy_endpoint"]
	config["proxy_endpoint"] = "proxy.example.invalid:8081"
	a := newRocketMQAgent()
	defer a.close()
	if _, err := dispatchProxyTest(t, a, "connect", config); err != nil {
		t.Fatal(err)
	}
	if _, err := dispatchProxyTest(t, a, "mq_send_message", map[string]any{"topic": "orders", "payload": "x"}); err != nil {
		t.Fatal(err)
	}
}

func TestProxyTLSRejectsUntrustedCertificateAndPreservesAuthority(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "proxy.example.invalid"}, DNSNames: []string{"proxy.example.invalid"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		t.Fatal(err)
	}
	sni := make(chan string, 16)
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12, GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		select {
		case sni <- hello.ServerName:
		default:
		}
		return nil, nil
	}}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer(grpc.Creds(grpccredentials.NewTLS(tlsConfig)))
	v2.RegisterMessagingServiceServer(server, &proxyTestService{t: t})
	go func() { _ = server.Serve(listener) }()
	defer server.Stop()
	a := newRocketMQAgent()
	defer a.close()
	_, err = dispatchProxyTest(t, a, "connect", map[string]any{"connection_mode": "proxy", "proxy_endpoint": "proxy.example.invalid:8081", "proxy_dial_endpoint": listener.Addr().String(), "proxy_tls": true, "tls_skip_verify": true, "connect_timeout_ms": float64(150)})
	if err == nil {
		t.Fatal("untrusted self-signed TLS certificate accepted")
	}
	select {
	case name := <-sni:
		if name != "proxy.example.invalid" {
			t.Fatalf("SNI=%q, logical authority lost", name)
		}
	default:
		t.Fatal("TLS server did not receive handshake")
	}
}

func TestProxySOCKSDialerCarriesGRPCAndOriginalTarget(t *testing.T) {
	_, config := startProxyTestService(t)
	remote := config["proxy_endpoint"].(string)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	target := make(chan string, 4)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				greeting := make([]byte, 2)
				if _, err := io.ReadFull(conn, greeting); err != nil {
					return
				}
				methods := make([]byte, int(greeting[1]))
				if _, err := io.ReadFull(conn, methods); err != nil {
					return
				}
				if _, err := conn.Write([]byte{5, 0}); err != nil {
					return
				}
				header := make([]byte, 4)
				if _, err := io.ReadFull(conn, header); err != nil {
					return
				}
				var host string
				switch header[3] {
				case 1:
					b := make([]byte, 4)
					if _, err := io.ReadFull(conn, b); err != nil {
						return
					}
					host = net.IP(b).String()
				case 3:
					b := make([]byte, 1)
					if _, err := io.ReadFull(conn, b); err != nil {
						return
					}
					name := make([]byte, int(b[0]))
					if _, err := io.ReadFull(conn, name); err != nil {
						return
					}
					host = string(name)
				default:
					return
				}
				port := make([]byte, 2)
				if _, err := io.ReadFull(conn, port); err != nil {
					return
				}
				target <- net.JoinHostPort(host, strconv.Itoa(int(port[0])<<8|int(port[1])))
				upstream, err := net.DialTimeout("tcp", remote, time.Second)
				if err != nil {
					return
				}
				defer upstream.Close()
				if _, err := conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}); err != nil {
					return
				}
				done := make(chan struct{})
				go func() { _, _ = io.Copy(upstream, conn); close(done) }()
				_, _ = io.Copy(conn, upstream)
				_ = conn.Close()
				<-done
			}()
		}
	}()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	p, _ := strconv.Atoi(port)
	config["proxy_endpoint"] = "proxy.example.invalid:8081"
	config["socks_proxy"] = map[string]any{"host": host, "port": float64(p)}
	a := newRocketMQAgent()
	defer a.close()
	if _, err := dispatchProxyTest(t, a, "connect", config); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-target:
		if got != "proxy.example.invalid:8081" {
			t.Fatalf("SOCKS target %s", got)
		}
	default:
		t.Fatal("SOCKS was bypassed")
	}
}

func TestProxyPreservesTextPayloadWhitespace(t *testing.T) {
	s, config := startProxyTestService(t)
	a := newRocketMQAgent()
	defer a.close()
	if _, err := dispatchProxyTest(t, a, "connect", config); err != nil {
		t.Fatal(err)
	}
	if _, err := dispatchProxyTest(t, a, "mq_send_message", map[string]any{"topic": "orders", "payload": "  \nbody\t "}); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if string(s.received.GetBody()) != "  \nbody\t " {
		t.Fatalf("payload whitespace corrupted: %q", s.received.GetBody())
	}
}

func TestProxyClosedManagementMethodsNeverPanic(t *testing.T) {
	a := newRocketMQAgent()
	for _, method := range []string{"mq_peek_messages", "mq_view_message", "mq_query_message_by_key", "mq_query_message_by_topic", "mq_get_topic_stats", "mq_delete_topic", "mq_get_consumer_lag", "mq_describe_consumer_group"} {
		_, err := dispatchProxyTest(t, a, method, map[string]any{"topic": "orders", "name": "orders", "msgId": "x", "groupId": "g", "key": "k"})
		if err == nil || !strings.Contains(err.Error(), "not connected") {
			t.Errorf("%s: %v", method, err)
		}
	}
}
