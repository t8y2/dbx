package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	admin "github.com/amigoer/rocketmq-admin-go"
	rmq "github.com/apache/rocketmq-clients/golang/v5"
	"github.com/apache/rocketmq-clients/golang/v5/credentials"
	v2 "github.com/apache/rocketmq-clients/golang/v5/protocol/v2"
	"go.uber.org/zap"
	"golang.org/x/net/proxy"
	"google.golang.org/grpc"
	grpccredentials "google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// The SDK Producer does not forward its client connection options in v5.1.4.
// Use its authenticated RPC/protocol APIs with strictly per-connection options.
// No SDK global transport constructors or TLS switches are changed.
type proxyMessagingClient struct {
	rpc       rmq.RpcClient
	signer    rmq.Client
	config    connectionConfig
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
	telemetry v2.MessagingService_TelemetryClient
}

func validateProxyEndpoint(endpoint string) error {
	if strings.ContainsAny(endpoint, "/;,@?# \t\r\n") {
		return fmt.Errorf("expected a single host:port")
	}
	host, port, err := net.SplitHostPort(endpoint)
	if err != nil || host == "" {
		return fmt.Errorf("expected a single host:port")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n <= 0 || n > 65535 {
		return fmt.Errorf("invalid port")
	}
	return nil
}

func newProxyMessagingClient(setupCtx context.Context, config connectionConfig) (*proxyMessagingClient, error) {
	cfg := &rmq.Config{Endpoint: config.ProxyEndpoint}
	if config.AccessKey != "" {
		cfg.Credentials = &credentials.SessionCredentials{AccessKey: config.AccessKey, AccessSecret: config.SecretKey}
	}
	signer, err := rmq.NewClient(cfg)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &proxyMessagingClient{signer: signer, config: config, ctx: ctx, cancel: cancel}
	host, _, _ := net.SplitHostPort(config.ProxyEndpoint)
	transport := grpccredentials.TransportCredentials(insecure.NewCredentials())
	if config.ProxyTLS {
		transport = grpccredentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, ServerName: host})
	}
	direct := &net.Dialer{Timeout: config.ConnectTimeout}
	var dialer proxy.ContextDialer = direct
	if socks := config.SocksProxy; socks != nil {
		var auth *proxy.Auth
		if socks.Username != "" || socks.Password != "" {
			auth = &proxy.Auth{User: socks.Username, Password: socks.Password}
		}
		d, e := proxy.SOCKS5("tcp", net.JoinHostPort(socks.Host, strconv.Itoa(socks.Port)), auth, direct)
		if e != nil {
			cancel()
			return nil, e
		}
		var ok bool
		dialer, ok = d.(proxy.ContextDialer)
		if !ok {
			cancel()
			return nil, fmt.Errorf("SOCKS dialer does not support cancellation")
		}
	}
	dial := func(callCtx context.Context, _ string) (net.Conn, error) {
		target := config.ProxyEndpoint
		if config.ProxyDialEndpoint != "" {
			target = config.ProxyDialEndpoint
		}
		return dialer.DialContext(callCtx, "tcp", target)
	}
	dialTimeout := config.ConnectTimeout
	if deadline, ok := setupCtx.Deadline(); ok {
		dialTimeout = time.Until(deadline)
	}
	if dialTimeout <= 0 {
		cancel()
		return nil, context.DeadlineExceeded
	}
	p.rpc, err = rmq.NewRpcClient(config.ProxyEndpoint, rmq.WithRpcClientConnOption(
		rmq.WithContext(ctx), rmq.WithDialTimeout(dialTimeout), rmq.WithZapLogger(zap.NewNop()),
		rmq.WithDialOptions(grpc.WithTransportCredentials(transport), grpc.WithContextDialer(dial), grpc.WithDisableRetry()),
	))
	if err != nil {
		cancel()
		return nil, fmt.Errorf("connect RocketMQ Proxy: %w", err)
	}
	if err = p.register(setupCtx); err != nil {
		p.Close()
		return nil, err
	}
	if err = p.heartbeat(setupCtx); err != nil {
		p.Close()
		return nil, err
	}
	go p.keepAlive()
	return p, nil
}

func (p *proxyMessagingClient) Close() {
	if p != nil {
		p.closeOnce.Do(func() {
			p.cancel()
			if p.rpc != nil {
				_ = p.rpc.GracefulStop()
			}
		})
	}
}
func proxyStatus(operation string, status *v2.Status) error {
	if status == nil {
		return fmt.Errorf("RocketMQ Proxy %s: missing status", operation)
	}
	if status.Code != v2.Code_OK {
		return fmt.Errorf("RocketMQ Proxy %s: %s (%s)", operation, status.Code, status.Message)
	}
	return nil
}
func (p *proxyMessagingClient) register(setupCtx context.Context) error {
	stream, err := p.rpc.Telemetry(p.signer.Sign(p.ctx))
	if err != nil {
		return fmt.Errorf("RocketMQ Proxy telemetry: %w", err)
	}
	p.telemetry = stream
	kind := v2.ClientType_PRODUCER
	host, _ := os.Hostname()
	command := &v2.TelemetryCommand{Command: &v2.TelemetryCommand_Settings{Settings: &v2.Settings{
		ClientType: &kind, AccessPoint: proxyProtoEndpoints(p.config.ProxyEndpoint), RequestTimeout: durationpb.New(p.config.RequestTimeout),
		BackoffPolicy: &v2.RetryPolicy{MaxAttempts: 1}, PubSub: &v2.Settings_Publishing{Publishing: &v2.Publishing{}},
		UserAgent: &v2.UA{Language: v2.Language_GOLANG, Version: "5.1.4", Platform: "DBX", Hostname: host},
	}}}
	ready := make(chan error, 1)
	go func() {
		if err := stream.Send(command); err != nil {
			ready <- err
			p.Close()
			return
		}
		first := true
		for {
			response, err := stream.Recv()
			if err != nil {
				if first {
					ready <- err
				}
				p.Close()
				return
			}
			if response.GetStatus() != nil {
				if err = proxyStatus("telemetry", response.GetStatus()); err != nil {
					if first {
						ready <- err
					}
					p.Close()
					return
				}
			}
			if first && response.GetSettings() != nil {
				ready <- nil
				first = false
			}
		}
	}()
	select {
	case err := <-ready:
		if err != nil {
			return fmt.Errorf("RocketMQ Proxy settings: %w", err)
		}
		return nil
	case <-setupCtx.Done():
		return fmt.Errorf("RocketMQ Proxy settings: %w", setupCtx.Err())
	}
}

func (p *proxyMessagingClient) keepAlive() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(p.ctx, p.config.RequestTimeout)
			err := p.heartbeat(ctx)
			cancel()
			if err != nil {
				p.Close()
				return
			}
		}
	}
}

func (p *proxyMessagingClient) heartbeat(ctx context.Context) error {
	response, err := p.rpc.HeartBeat(p.signer.Sign(ctx), &v2.HeartbeatRequest{ClientType: v2.ClientType_PRODUCER})
	if err != nil {
		return fmt.Errorf("RocketMQ Proxy heartbeat: %w", err)
	}
	return proxyStatus("heartbeat", response.GetStatus())
}

func (p *proxyMessagingClient) Send(params map[string]any) (any, error) {
	message, err := ordinaryProxyMessage(params)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(p.ctx, p.config.RequestTimeout)
	defer cancel()
	// Keep messaging on the configured Proxy gRPC endpoint, including dial
	// overrides. Proxy resolves physical broker endpoints itself.
	route, err := p.rpc.QueryRoute(p.signer.Sign(ctx), &v2.QueryRouteRequest{Topic: message.Topic, Endpoints: proxyProtoEndpoints(p.config.ProxyEndpoint)})
	if err != nil {
		return nil, fmt.Errorf("RocketMQ Proxy route: %w", err)
	}
	if err = proxyStatus("route", route.GetStatus()); err != nil {
		return nil, err
	}
	var selected *v2.MessageQueue
	for _, queue := range route.GetMessageQueues() {
		if queue == nil || queue.GetId() < 0 || queue.GetTopic().GetName() != message.Topic.Name {
			continue
		}
		if queue.Permission != v2.Permission_WRITE && queue.Permission != v2.Permission_READ_WRITE {
			continue
		}
		normal := false
		for _, kind := range queue.AcceptMessageTypes {
			if kind == v2.MessageType_NORMAL {
				normal = true
			}
		}
		if normal {
			selected = queue
			break
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("unsupported: no writable NORMAL message queue for topic %s", message.Topic.Name)
	}
	// Ordinary Proxy sends select their physical queue server-side. Route data
	// establishes eligibility only; the send receipt does not expose queue ID.
	// One attempt only: retrying an ambiguous send can duplicate application data.
	response, err := p.rpc.SendMessage(p.signer.Sign(ctx), &v2.SendMessageRequest{Messages: []*v2.Message{message}})
	if err != nil {
		return nil, fmt.Errorf("RocketMQ Proxy send (delivery outcome may be unknown): %w", err)
	}
	if err = proxyStatus("send", response.GetStatus()); err != nil {
		return nil, err
	}
	entries := response.GetEntries()
	if len(entries) != 1 {
		return nil, fmt.Errorf("RocketMQ Proxy send: expected one result entry, got %d", len(entries))
	}
	for _, entry := range entries {
		if err = proxyStatus("send entry", entry.GetStatus()); err != nil {
			return nil, err
		}
		if entry.GetMessageId() == "" {
			return nil, fmt.Errorf("RocketMQ Proxy send: missing message ID")
		}
	}
	return map[string]any{"ok": true, "topic": message.Topic.Name, "partition": nil, "offset": entries[0].Offset, "timestamp": time.Now().UnixMilli(), "messageId": entries[0].MessageId}, nil
}

func proxyProtoEndpoints(endpoint string) *v2.Endpoints {
	host, port, _ := net.SplitHostPort(endpoint)
	n, _ := strconv.Atoi(port)
	scheme := v2.AddressScheme_DOMAIN_NAME
	if ip := net.ParseIP(host); ip != nil {
		scheme = v2.AddressScheme_IPv4
		if ip.To4() == nil {
			scheme = v2.AddressScheme_IPv6
		}
	}
	return &v2.Endpoints{Scheme: scheme, Addresses: []*v2.Address{{Host: host, Port: int32(n)}}}
}

// Reject special semantics rather than silently dropping requested guarantees.
func ordinaryProxyMessage(params map[string]any) (*v2.Message, error) {
	for _, key := range []string{"partition", "delay", "delayLevel", "delayTimeLevel", "delay_level", "deliveryTimestamp", "delivery_timestamp", "messageGroup", "message_group", "fifo", "transaction", "transactional", "transactionId", "transaction_id", "priority", "liteTopic", "lite_topic", "retry", "reconsumeTimes", "reconsume_times", "maxReconsumeTimes", "max_reconsume_times"} {
		if value, ok := params[key]; ok && value != nil {
			return nil, fmt.Errorf("unsupported: Proxy ordinary messages do not support %s", key)
		}
	}
	if typ := stringValue(params, "messageType", "message_type"); typ != "" && strings.ToUpper(typ) != "NORMAL" {
		return nil, fmt.Errorf("unsupported Proxy message type: %s", typ)
	}
	text := func(key string) (string, error) {
		value, ok := params[key]
		if !ok || value == nil {
			return "", nil
		}
		s, ok := value.(string)
		if !ok || !utf8.ValidString(s) {
			return "", fmt.Errorf("%s must be a UTF-8 string", key)
		}
		return s, nil
	}
	topic, err := text("topic")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(topic) == "" || topic != strings.TrimSpace(topic) || strings.ContainsAny(topic, "\x00\r\n") {
		return nil, fmt.Errorf("valid topic is required")
	}
	if strings.HasPrefix(topic, "%RETRY%") || strings.HasPrefix(topic, "%DLQ%") {
		return nil, fmt.Errorf("unsupported: retry and dead-letter topics cannot receive ordinary Proxy messages")
	}
	encoded, err := text("payloadBase64")
	if err != nil {
		return nil, err
	}
	var body []byte
	if _, has := params["payloadBase64"]; has {
		body, err = base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fmt.Errorf("invalid payloadBase64: %w", err)
		}
	} else {
		key := "payload"
		if _, ok := params[key]; !ok {
			key = "payloadText"
		}
		value, e := text(key)
		if e != nil {
			return nil, e
		}
		body = []byte(value)
	}
	if len(body) > 4*1024*1024 {
		return nil, fmt.Errorf("Proxy message body exceeds 4 MiB")
	}
	key, err := text("key")
	if err != nil {
		return nil, err
	}
	tag, err := text("tag")
	if err != nil {
		return nil, err
	}
	properties := map[string]string{}
	for _, field := range []string{"headers", "properties", "customProps"} {
		raw, exists := params[field]
		if !exists || raw == nil {
			continue
		}
		headers, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s must be an object of strings", field)
		}
		for name, value := range headers {
			val, ok := value.(string)
			if !ok || !utf8.ValidString(val) || !utf8.ValidString(name) || name == "" || strings.ContainsAny(name+val, "\x00\x01\x02") {
				return nil, fmt.Errorf("invalid Proxy user property %q: string key/value required", name)
			}
			switch name {
			case "KEYS":
				if key == "" {
					key = val
				}
				continue
			case "TAGS":
				if tag == "" {
					tag = val
				}
				continue
			}
			upper := strings.ToUpper(name)
			if isReservedMessageProperty(upper) || strings.HasPrefix(upper, "__") || strings.HasPrefix(upper, "PROPERTY_") || strings.Contains(upper, "TIMER_") || upper == "DELAY" || upper == "SHARDING_KEY" || upper == "TRAN_MSG" {
				return nil, fmt.Errorf("unsupported: reserved Proxy message property %s", name)
			}
			properties[name] = val
		}
	}
	if strings.ContainsAny(key+tag, "\x00\x01\x02\r\n") {
		return nil, fmt.Errorf("invalid Key or Tag")
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "localhost"
	}
	msg := &v2.Message{Topic: &v2.Resource{Name: topic}, Body: body, UserProperties: properties, SystemProperties: &v2.SystemProperties{MessageId: rmq.GetMessageIdCodecInstance().NextMessageId().String(), BornTimestamp: timestamppb.Now(), BornHost: host, BodyEncoding: v2.Encoding_IDENTITY, MessageType: v2.MessageType_NORMAL}}
	if key != "" {
		msg.SystemProperties.Keys = []string{key}
	}
	if tag != "" {
		msg.SystemProperties.Tag = &tag
	}
	return msg, nil
}

func transportCapabilities(management bool) map[string]any {
	caps := map[string]any{"supportsSendMessage": true}
	for _, key := range []string{"supportsListTopics", "supportsCreateTopic", "supportsDeleteTopic", "supportsTopicStats", "supportsBrokerAdmin", "supportsProducerListing", "supportsSubscriptions", "supportsResetCursor", "supportsSkipMessages", "supportsClearBacklog", "supportsPeekMessages", "supportsPermissions", "supportsMessageQuery", "supportsDlq", "supportsMessageTrace"} {
		caps[key] = management
	}
	return caps
}

func (a *rocketMQAgent) connectProxy(config connectionConfig, testOnly bool) (any, error) {
	if testOnly {
		a.mu.RLock()
		if a.messaging != nil && a.connection.equal(config) {
			testOnly = false
		}
		a.mu.RUnlock()
	}
	setupCtx, setupCancel := context.WithTimeout(context.Background(), config.ConnectTimeout)
	defer setupCancel()
	messaging, err := newProxyMessagingClient(setupCtx, config)
	if err != nil {
		return nil, err
	}
	var client *admin.Client
	var proxies *proxyManager
	var info *admin.ClusterInfo
	management := map[string]any{"status": "disabled"}
	clusterName, brokerAddr := "", ""
	if config.ManagementEnabled {
		managementConfig := config
		budget := minDuration(config.ConnectTimeout/3, 3*time.Second)
		if deadline, ok := setupCtx.Deadline(); ok && time.Until(deadline) < budget {
			budget = time.Until(deadline)
		}
		if budget <= 0 {
			err = context.DeadlineExceeded
		} else {
			managementConfig.ConnectTimeout = budget
			managementConfig.RequestTimeout = minDuration(config.RequestTimeout, budget)
			client, proxies, info, err = buildClient(managementConfig)
		}
		if err == nil {
			brokerAddr, err = resolveBrokerAddr(info, config, proxies)
		}
		if err != nil {
			if client != nil {
				_ = client.Close()
				client = nil
			}
			if proxies != nil {
				proxies.Close()
				proxies = nil
			}
			management = map[string]any{"status": "degraded", "error": "RocketMQ Remoting management connection failed"}
		} else {
			management = map[string]any{"status": "ready"}
			clusterName = resolveClusterName(info, config.ClusterName)
		}
	}
	if err := messaging.ctx.Err(); err != nil {
		messaging.Close()
		if client != nil {
			_ = client.Close()
		}
		if proxies != nil {
			proxies.Close()
		}
		return nil, fmt.Errorf("RocketMQ Proxy messaging session ended during connection setup: %w", err)
	}
	result := map[string]any{"ok": true, "clusterId": clusterName, "nodeCount": 0, "brokers": []any{}, "aclEnabled": config.AccessKey != "", "capabilities": transportCapabilities(client != nil), "channels": map[string]any{"messaging": map[string]any{"status": "ready"}, "management": management}}
	if client != nil {
		result["brokers"] = brokerNodes(info, proxies)
		result["nodeCount"] = len(brokerNodes(info, proxies))
	}
	if testOnly {
		messaging.Close()
		if client != nil {
			_ = client.Close()
		}
		if proxies != nil {
			proxies.Close()
		}
		return result, nil
	}
	a.mu.Lock()
	oldClient, oldProxies, oldMessaging := a.client, a.proxies, a.messaging
	a.client, a.proxies, a.messaging = client, proxies, messaging
	a.connection = config
	a.clusterName, a.brokerAddr = clusterName, brokerAddr
	a.mu.Unlock()
	if oldMessaging != nil {
		oldMessaging.Close()
	}
	if oldClient != nil {
		_ = oldClient.Close()
	}
	if oldProxies != nil {
		oldProxies.Close()
	}
	return result, nil
}
