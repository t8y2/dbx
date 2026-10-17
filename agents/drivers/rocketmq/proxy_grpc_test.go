package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	v2 "github.com/apache/rocketmq-clients/golang/v5/protocol/v2"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/stats"
)

type proxyTestService struct {
	v2.UnimplementedMessagingServiceServer
	mu              sync.Mutex
	t               *testing.T
	address         string
	heartbeatCode   v2.Code
	routeCode       v2.Code
	sendCode        v2.Code
	entryCode       v2.Code
	permission      v2.Permission
	messageType     v2.MessageType
	emptyEntries    bool
	heartbeats      int
	sends           int
	received        *v2.Message
	registered      map[string]bool
	failTelemetry   chan bool
	connectionEnded chan struct{}
	heartbeatSeen   chan struct{}
}

func (s *proxyTestService) TagRPC(ctx context.Context, _ *stats.RPCTagInfo) context.Context {
	return ctx
}
func (s *proxyTestService) HandleRPC(context.Context, stats.RPCStats) {}
func (s *proxyTestService) TagConn(ctx context.Context, _ *stats.ConnTagInfo) context.Context {
	return ctx
}
func (s *proxyTestService) HandleConn(_ context.Context, event stats.ConnStats) {
	if _, ok := event.(*stats.ConnEnd); ok && s.connectionEnded != nil {
		select {
		case s.connectionEnded <- struct{}{}:
		default:
		}
	}
}

func (s *proxyTestService) Telemetry(stream v2.MessagingService_TelemetryServer) error {
	s.checkAuth(stream.Context())
	md, _ := metadata.FromIncomingContext(stream.Context())
	ids := md.Get("x-mq-client-id")
	if len(ids) != 1 {
		return fmt.Errorf("missing client ID")
	}
	request, err := stream.Recv()
	if err != nil {
		return err
	}
	settings := request.GetSettings()
	if settings == nil || settings.GetClientType() != v2.ClientType_PRODUCER || settings.GetPublishing() == nil {
		return fmt.Errorf("producer settings required")
	}
	s.mu.Lock()
	if s.registered == nil {
		s.registered = map[string]bool{}
	}
	s.registered[ids[0]] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.registered, ids[0]); s.mu.Unlock() }()
	if err = stream.Send(&v2.TelemetryCommand{Status: &v2.Status{Code: v2.Code_OK}, Command: &v2.TelemetryCommand_Settings{Settings: settings}}); err != nil {
		return err
	}
	if s.failTelemetry != nil {
		select {
		case business := <-s.failTelemetry:
			if business {
				return stream.Send(&v2.TelemetryCommand{Status: &v2.Status{Code: v2.Code_FORBIDDEN}})
			}
			return fmt.Errorf("injected telemetry failure")
		case <-stream.Context().Done():
			return stream.Context().Err()
		}
	}
	for {
		if _, err = stream.Recv(); err != nil {
			return err
		}
	}
}

func (s *proxyTestService) checkAuth(ctx context.Context) {
	s.t.Helper()
	md, _ := metadata.FromIncomingContext(ctx)
	date := md.Get("x-mq-date-time")
	if len(date) != 1 {
		s.t.Error("missing RPC timestamp")
		return
	}
	h := hmac.New(sha1.New, []byte("secret"))
	_, _ = h.Write([]byte(date[0]))
	want := fmt.Sprintf("MQv2-HMAC-SHA1 Credential=access//Rocketmq, SignedHeaders=x-mq-date-time, Signature=%s", hex.EncodeToString(h.Sum(nil)))
	if got := md.Get("authorization"); len(got) != 1 || got[0] != want {
		s.t.Errorf("invalid authorization: %v want %s", got, want)
	}
	if len(md.Get("x-mq-client-id")) != 1 {
		s.t.Error("missing client ID")
	}
}
func (s *proxyTestService) Heartbeat(ctx context.Context, _ *v2.HeartbeatRequest) (*v2.HeartbeatResponse, error) {
	s.checkAuth(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.heartbeats++
	if s.heartbeatSeen != nil {
		select {
		case s.heartbeatSeen <- struct{}{}:
		default:
		}
	}
	md, _ := metadata.FromIncomingContext(ctx)
	ids := md.Get("x-mq-client-id")
	if len(ids) != 1 || !s.registered[ids[0]] {
		return &v2.HeartbeatResponse{Status: &v2.Status{Code: v2.Code_UNRECOGNIZED_CLIENT_TYPE}}, nil
	}
	return &v2.HeartbeatResponse{Status: &v2.Status{Code: s.heartbeatCode}}, nil
}
func (s *proxyTestService) QueryRoute(ctx context.Context, r *v2.QueryRouteRequest) (*v2.QueryRouteResponse, error) {
	s.checkAuth(ctx)
	host, port, _ := net.SplitHostPort(s.address)
	p, _ := strconv.Atoi(port)
	s.mu.Lock()
	defer s.mu.Unlock()
	return &v2.QueryRouteResponse{Status: &v2.Status{Code: s.routeCode}, MessageQueues: []*v2.MessageQueue{{Topic: r.Topic, Id: 3, Permission: s.permission, AcceptMessageTypes: []v2.MessageType{s.messageType}, Broker: &v2.Broker{Name: "broker-a", Endpoints: &v2.Endpoints{Scheme: v2.AddressScheme_IPv4, Addresses: []*v2.Address{{Host: host, Port: int32(p)}}}}}}}, nil
}
func (s *proxyTestService) SendMessage(ctx context.Context, r *v2.SendMessageRequest) (*v2.SendMessageResponse, error) {
	s.checkAuth(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sends++
	if len(r.Messages) != 1 {
		s.t.Errorf("messages=%d", len(r.Messages))
	} else {
		s.received = r.Messages[0]
	}
	response := &v2.SendMessageResponse{Status: &v2.Status{Code: s.sendCode}}
	if !s.emptyEntries {
		response.Entries = []*v2.SendResultEntry{{Status: &v2.Status{Code: s.entryCode}, MessageId: r.Messages[0].GetSystemProperties().GetMessageId(), Offset: 42}}
	}
	return response, nil
}
func startProxyTestService(t *testing.T) (*proxyTestService, map[string]any) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &proxyTestService{t: t, address: listener.Addr().String(), heartbeatCode: v2.Code_OK, routeCode: v2.Code_OK, sendCode: v2.Code_OK, entryCode: v2.Code_OK, permission: v2.Permission_READ_WRITE, messageType: v2.MessageType_NORMAL}
	s.failTelemetry = make(chan bool, 1)
	s.connectionEnded = make(chan struct{}, 16)
	s.heartbeatSeen = make(chan struct{}, 16)
	server := grpc.NewServer(grpc.StatsHandler(s))
	v2.RegisterMessagingServiceServer(server, s)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	return s, map[string]any{"connection_mode": "proxy", "proxy_endpoint": s.address, "proxy_tls": false, "access_key": "access", "secret_key": "secret", "connect_timeout_ms": float64(500), "request_timeout_ms": float64(500)}
}
func dispatchProxyTest(t *testing.T, a *rocketMQAgent, method string, params map[string]any) (any, error) {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	return a.dispatch(method, raw)
}

func TestProxyConnectSendAndLifecycle(t *testing.T) {
	s, config := startProxyTestService(t)
	a := newRocketMQAgent()
	t.Cleanup(a.close)
	result, err := dispatchProxyTest(t, a, "connect", config)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if !strings.Contains(string(encoded), `"management":{"status":"disabled"}`) || !strings.Contains(string(encoded), `"messaging":{"status":"ready"}`) {
		t.Fatalf("invalid channels %s", encoded)
	}
	payload := []byte{0, 1, 255, ' '}
	result, err = dispatchProxyTest(t, a, "mq_send_message", map[string]any{"topic": "orders", "payloadBase64": "AAH/IA==", "key": "order-1", "tag": "created", "headers": map[string]any{"custom": "value"}})
	if err != nil {
		t.Fatal(err)
	}
	row := result.(map[string]any)
	if row["ok"] != true || row["offset"] != int64(42) || row["partition"] != nil {
		t.Fatalf("send result %v", row)
	}
	s.mu.Lock()
	msg := s.received
	count := s.sends
	s.mu.Unlock()
	if count != 1 || !bytes.Equal(msg.GetBody(), payload) || msg.GetSystemProperties().GetQueueId() != 0 || msg.GetSystemProperties().GetTag() != "created" || len(msg.GetSystemProperties().GetKeys()) != 1 || msg.GetUserProperties()["custom"] != "value" {
		t.Fatalf("incorrect message %v count=%d", msg, count)
	}
	if msg.GetSystemProperties().GetMessageId() == "" || msg.GetSystemProperties().GetMessageType() != v2.MessageType_NORMAL {
		t.Fatalf("missing normal system properties %v", msg)
	}
	for _, method := range []string{"mq_list_topics", "mq_peek_messages", "mq_view_message", "mq_describe_cluster", "mq_create_acls"} {
		if _, err = dispatchProxyTest(t, a, method, map[string]any{"topic": "orders", "msgId": "x"}); err == nil || !strings.Contains(strings.ToLower(err.Error()), "unsupported") {
			t.Errorf("%s should return unsupported, got %v", method, err)
		}
	}
	a.close()
	a.close()
	if _, err = dispatchProxyTest(t, a, "mq_send_message", map[string]any{"topic": "orders", "payload": "x"}); err == nil {
		t.Fatal("send after disconnect succeeded")
	}
}

func TestProxyRejectsUnsupportedSendBeforeRPC(t *testing.T) {
	s, config := startProxyTestService(t)
	a := newRocketMQAgent()
	t.Cleanup(a.close)
	if _, err := dispatchProxyTest(t, a, "connect", config); err != nil {
		t.Fatal(err)
	}
	invalid := []map[string]any{{"partition": 0}, {"delayLevel": 1}, {"messageGroup": "a"}, {"transaction": true}, {"headers": map[string]any{"DELAY": "1"}}, {"headers": map[string]any{"KEYS": 123}}, {"key": 42}, {"payloadBase64": "%%%"}, {"headers": map[string]any{"x": map[string]any{}}}}
	for _, extra := range invalid {
		params := map[string]any{"topic": "orders", "payload": "text"}
		for k, v := range extra {
			params[k] = v
		}
		if _, err := dispatchProxyTest(t, a, "mq_send_message", params); err == nil {
			t.Errorf("invalid message accepted: %v", extra)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sends != 0 {
		t.Fatalf("invalid requests reached SendMessage: %d", s.sends)
	}
}

func TestProxyProtocolFailuresDoNotSilentlySucceed(t *testing.T) {
	for _, failure := range []string{"heartbeat", "route", "permission", "type", "send", "entry", "emptyEntries"} {
		t.Run(failure, func(t *testing.T) {
			s, config := startProxyTestService(t)
			a := newRocketMQAgent()
			t.Cleanup(a.close)
			if failure == "heartbeat" {
				s.heartbeatCode = v2.Code_FORBIDDEN
			}
			_, err := dispatchProxyTest(t, a, "connect", config)
			if failure == "heartbeat" {
				if err == nil {
					t.Fatal("heartbeat business error ignored")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			switch failure {
			case "route":
				s.routeCode = v2.Code_FORBIDDEN
			case "permission":
				s.permission = v2.Permission_READ
			case "type":
				s.messageType = v2.MessageType_FIFO
			case "send":
				s.sendCode = v2.Code_FORBIDDEN
			case "entry":
				s.entryCode = v2.Code_FORBIDDEN
			case "emptyEntries":
				s.emptyEntries = true
			}
			s.mu.Unlock()
			if _, err = dispatchProxyTest(t, a, "mq_send_message", map[string]any{"topic": "orders", "payload": "x"}); err == nil {
				t.Fatalf("%s failure ignored", failure)
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.sends > 1 {
				t.Fatalf("send retried implicitly: %d", s.sends)
			}
		})
	}
}

func TestProxyManagementFailureIsDegradedAndTestDoesNotReplaceSession(t *testing.T) {
	_, config := startProxyTestService(t)
	a := newRocketMQAgent()
	t.Cleanup(a.close)
	if _, err := dispatchProxyTest(t, a, "connect", config); err != nil {
		t.Fatal(err)
	}
	config["management_enabled"] = true
	config["namesrv_addr"] = "127.0.0.1:1"
	config["connect_timeout_ms"] = float64(30)
	config["request_timeout_ms"] = float64(30)
	result, err := dispatchProxyTest(t, a, "test_connection", config)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if !strings.Contains(string(encoded), `"status":"degraded"`) {
		t.Fatalf("not degraded: %s", encoded)
	}
	if _, err := dispatchProxyTest(t, a, "mq_send_message", map[string]any{"topic": "orders", "payload": "x"}); err != nil {
		t.Fatalf("test_connection damaged active session: %v", err)
	}
}

func TestProxyConnectTimeoutIsBounded(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	// A listening TCP peer which never performs HTTP/2 must not hang the driver.
	a := newRocketMQAgent()
	defer a.close()
	start := time.Now()
	_, err = dispatchProxyTest(t, a, "connect", map[string]any{"connection_mode": "proxy", "proxy_endpoint": listener.Addr().String(), "proxy_tls": false, "connect_timeout_ms": float64(40)})
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("connect was not bounded: %v %v", err, time.Since(start))
	}
}
