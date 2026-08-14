package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/nats-io/nats.go"
)

const (
	maxRPCMessageBytes       = 32 * 1024 * 1024
	maxPublishPayloadBytes   = 16 * 1024 * 1024
	maxSubjectBytes          = 1024
	maxHeaderCount           = 100
	maxHeaderKeyBytes        = 256
	maxHeaderValueBytes      = 8 * 1024
	maxHeaderWireBytes       = 64 * 1024
	captureChannelCapacity   = 1
	maxCaptureDuration       = 60 * time.Second
	maxCaptureMessages       = 1_000
	maxCaptureBytes          = 16 * 1024 * 1024
	maxJetStreamProbeTimeout = time.Second
	maxJetStreamListItems    = 200
	maxHistoryMessages       = 1_000
	maxHistoryBytes          = 16 * 1024 * 1024
	maxLivePendingMessages   = 1_000
	maxLivePendingBytes      = 16 * 1024 * 1024
)

type jsonObject map[string]any

type rpcRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type handshakeResult struct {
	ProtocolVersion      int      `json:"protocolVersion"`
	AgentProtocolVersion int      `json:"agentProtocolVersion"`
	Capabilities         []string `json:"capabilities"`
}

type captureOptions struct {
	subject        string
	duration       time.Duration
	maxMessages    int
	maxBytes       int
	includeHeaders bool
}

type historyOptions struct {
	stream        string
	startSequence uint64
	maxMessages   int
	maxBytes      int
}

type subscriptionInfo struct {
	SubscriptionID string `json:"subscriptionId"`
	Subject        string `json:"subject"`
	QueueGroup     string `json:"queueGroup,omitempty"`
	State          string `json:"state"`
	ReceivedCount  int    `json:"receivedCount"`
	DroppedCount   int    `json:"droppedCount"`
}

type liveSubscription struct {
	info subscriptionInfo
	nc   *nats.Conn
	sub  *nats.Subscription
	seq  uint64
}

// A server owns only persistent subscriptions. Bounded RPC methods continue
// to create one short-lived connection each, which keeps MCP capture cleanup
// independent from a console subscription lifecycle.
type server struct {
	mu            sync.Mutex
	subscriptions map[string]*liveSubscription
	encoder       *json.Encoder
	writeMu       sync.Mutex
}

func newServer() *server {
	return &server{subscriptions: make(map[string]*liveSubscription)}
}

func main() {
	service := newServer()
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	service.encoder = encoder
	if _, err := fmt.Fprintln(os.Stdout, `{"ready":true}`); err != nil {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), maxRPCMessageBytes)
	for scanner.Scan() {
		// A live subscription emits notifications while ordinary JSON-RPC calls
		// must still be able to stop it. Dispatch independently and let clients
		// correlate responses by id.
		line := append([]byte(nil), scanner.Bytes()...)
		go func() {
			response, shutdown := service.handle(line)
			if err := service.write(response); err != nil {
				// This error contains encoder state only; never write request data,
				// credentials, or message payloads to stderr.
				fmt.Fprintln(os.Stderr, "unable to write NATS agent response")
				return
			}
			if shutdown {
				service.close()
			}
		}()
	}
	service.close()
}

func (s *server) handle(line []byte) (rpcResponse, bool) {
	response := rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null")}
	var request rpcRequest
	if err := json.Unmarshal(line, &request); err != nil {
		response.Error = &rpcError{Code: -1, Message: "invalid JSON-RPC request"}
		return response, false
	}
	if len(request.ID) > 0 {
		response.ID = request.ID
	}
	params := jsonObject{}
	if len(request.Params) > 0 && string(request.Params) != "null" {
		if err := json.Unmarshal(request.Params, &params); err != nil {
			response.Error = &rpcError{Code: -1, Message: "invalid JSON-RPC parameters"}
			return response, false
		}
	}
	result, shutdown, err := s.dispatch(request.Method, params)
	if err != nil {
		response.Error = &rpcError{Code: -1, Message: redactError(err, params)}
		return response, false
	}
	response.Result = result
	return response, shutdown
}

func (s *server) dispatch(method string, params jsonObject) (any, bool, error) {
	switch method {
	case "handshake":
		return handshakeResult{2, 2, []string{
			"test_connection", "nats_core", "nats_headers", "nats_subscription_events", "nats_jetstream_read",
		}}, false, nil
	case "test_connection":
		return s.testConnection(params)
	case "publish":
		return s.publish(params)
	case "capture":
		return s.capture(params)
	case "start_subscription":
		return s.startSubscription(params)
	case "stop_subscription":
		return s.stopSubscription(params)
	case "list_subscriptions":
		return s.listSubscriptions(), false, nil
	case "jetstream_info":
		return s.jetStreamInfo(params)
	case "list_streams":
		return s.listStreams(params)
	case "get_stream":
		return s.getStream(params)
	case "list_consumers":
		return s.listConsumers(params)
	case "get_consumer":
		return s.getConsumer(params)
	case "fetch_history":
		return s.fetchHistory(params)
	case "shutdown":
		return map[string]any{"ok": true}, true, nil
	default:
		return nil, false, fmt.Errorf("unknown method: %s", method)
	}
}

func (s *server) write(value any) error {
	if s.encoder == nil {
		return nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.encoder.Encode(value)
}

func (s *server) emit(method string, params any) {
	if err := s.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params}); err != nil {
		// Do not include the failing message or request in the log: they can
		// contain credentials or application payloads.
		fmt.Fprintln(os.Stderr, "unable to write NATS subscription event")
	}
}

func (s *server) startSubscription(params jsonObject) (any, bool, error) {
	connection, err := requiredObject(params, "connection")
	if err != nil {
		return nil, false, err
	}
	subscription, err := requiredObject(params, "subscription")
	if err != nil {
		return nil, false, err
	}
	subscriptionID, err := requiredString(subscription, "subscriptionId")
	if err != nil {
		return nil, false, err
	}
	if err := validateSubscriptionID(subscriptionID); err != nil {
		return nil, false, err
	}
	subject, err := requiredString(subscription, "subject")
	if err != nil {
		return nil, false, err
	}
	if err := validateSubject(subject, true, "subscription Subject"); err != nil {
		return nil, false, err
	}
	queueGroup, err := optionalString(subscription, "queueGroup")
	if err != nil {
		return nil, false, err
	}
	if err := validateQueueGroup(queueGroup); err != nil {
		return nil, false, err
	}

	s.mu.Lock()
	if existing := s.subscriptions[subscriptionID]; existing != nil {
		info := existing.info
		s.mu.Unlock()
		if info.Subject != subject || info.QueueGroup != queueGroup {
			return nil, false, errors.New("NATS subscriptionId is already active with a different Subject or queue group")
		}
		return info, false, nil
	}
	s.mu.Unlock()

	nc, err := s.connect(connection)
	if err != nil {
		return nil, false, err
	}
	live := &liveSubscription{info: subscriptionInfo{SubscriptionID: subscriptionID, Subject: subject, QueueGroup: queueGroup, State: "starting"}, nc: nc}
	callback := func(msg *nats.Msg) { s.deliverSubscriptionMessage(subscriptionID, msg) }
	if queueGroup == "" {
		live.sub, err = nc.Subscribe(subject, callback)
	} else {
		live.sub, err = nc.QueueSubscribe(subject, queueGroup, callback)
	}
	if err != nil {
		nc.Close()
		return nil, false, err
	}
	if err := live.sub.SetPendingLimits(maxLivePendingMessages, maxLivePendingBytes); err != nil {
		live.sub.Unsubscribe()
		nc.Close()
		return nil, false, err
	}
	if err := nc.FlushTimeout(requestTimeout(connection)); err != nil {
		live.sub.Unsubscribe()
		nc.Close()
		return nil, false, err
	}

	s.mu.Lock()
	if existing := s.subscriptions[subscriptionID]; existing != nil {
		s.mu.Unlock()
		live.sub.Unsubscribe()
		nc.Close()
		return existing.info, false, nil
	}
	live.info.State = "active"
	s.subscriptions[subscriptionID] = live
	info := live.info
	live.seq++
	stateSequence := live.seq
	// Emit the initial state while holding the subscription lock. A message
	// callback cannot overtake it and receive an earlier sequence number.
	s.emit("subscription_state", map[string]any{"subscriptionId": subscriptionID, "sequence": stateSequence, "state": "active"})
	s.mu.Unlock()
	return info, false, nil
}

func (s *server) stopSubscription(params jsonObject) (any, bool, error) {
	subscriptionID, err := requiredString(params, "subscriptionId")
	if err != nil {
		return nil, false, err
	}
	if err := validateSubscriptionID(subscriptionID); err != nil {
		return nil, false, err
	}
	live := s.removeSubscription(subscriptionID)
	if live == nil {
		return map[string]any{"ok": true}, false, nil
	}
	if err := live.sub.Unsubscribe(); err != nil && !errors.Is(err, nats.ErrBadSubscription) {
		live.nc.Close()
		return nil, false, err
	}
	live.nc.Close()
	live.seq++
	s.emit("subscription_state", map[string]any{"subscriptionId": subscriptionID, "sequence": live.seq, "state": "stopped"})
	return map[string]any{"ok": true}, false, nil
}

func (s *server) listSubscriptions() any {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]subscriptionInfo, 0, len(s.subscriptions))
	for _, live := range s.subscriptions {
		info := live.info
		if dropped, err := live.sub.Dropped(); err == nil && dropped > info.DroppedCount {
			info.DroppedCount = dropped
			live.info.DroppedCount = dropped
		}
		items = append(items, info)
	}
	sort.Slice(items, func(left, right int) bool { return items[left].SubscriptionID < items[right].SubscriptionID })
	return items
}

func (s *server) removeSubscription(subscriptionID string) *liveSubscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	live := s.subscriptions[subscriptionID]
	delete(s.subscriptions, subscriptionID)
	return live
}

func (s *server) close() {
	s.mu.Lock()
	subscriptions := s.subscriptions
	s.subscriptions = make(map[string]*liveSubscription)
	s.mu.Unlock()
	for subscriptionID, live := range subscriptions {
		_ = live.sub.Unsubscribe()
		live.nc.Close()
		live.seq++
		s.emit("subscription_state", map[string]any{"subscriptionId": subscriptionID, "sequence": live.seq, "state": "stopped"})
	}
}

func (s *server) deliverSubscriptionMessage(subscriptionID string, msg *nats.Msg) {
	item, _, err := captureMessage(msg, true)
	if err != nil {
		s.emit("subscription_error", map[string]any{
			"subscriptionId": subscriptionID,
			"sequence":       s.nextSubscriptionSequence(subscriptionID),
			"message":        "Unable to decode NATS message",
		})
		return
	}
	s.mu.Lock()
	live := s.subscriptions[subscriptionID]
	if live == nil {
		s.mu.Unlock()
		return
	}
	live.seq++
	live.info.ReceivedCount++
	if dropped, dropErr := live.sub.Dropped(); dropErr == nil && dropped > live.info.DroppedCount {
		live.info.DroppedCount = dropped
	}
	sequence := live.seq
	s.mu.Unlock()
	s.emit("subscription_message", map[string]any{"subscriptionId": subscriptionID, "sequence": sequence, "message": item})
}

func (s *server) nextSubscriptionSequence(subscriptionID string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if live := s.subscriptions[subscriptionID]; live != nil {
		live.seq++
		return live.seq
	}
	return 0
}

func (s *server) testConnection(params jsonObject) (any, bool, error) {
	connection, err := requiredObject(params, "connection")
	if err != nil {
		return nil, false, err
	}
	start := time.Now()
	nc, err := s.connect(connection)
	if err != nil {
		return nil, false, err
	}
	defer nc.Close()

	return map[string]any{
		"ok":               true,
		"serverName":       nc.ConnectedServerName(),
		"serverVersion":    nc.ConnectedServerVersion(),
		"headersSupported": nc.HeadersSupported(),
		"jetstreamEnabled": s.probeJetStream(nc, connection),
		"maxPayload":       nc.MaxPayload(),
		"connectedUrl":     nc.ConnectedUrl(),
		"roundTripMs":      time.Since(start).Milliseconds(),
	}, false, nil
}

func (s *server) probeJetStream(nc *nats.Conn, connection jsonObject) bool {
	// AccountInfo can wait for a server that has no JetStream responder. Keep
	// the capability probe short so a normal connection test remains bounded.
	js, err := nc.JetStream(nats.MaxWait(jetStreamProbeTimeout(connection)))
	if err != nil {
		return false
	}
	_, err = js.AccountInfo()
	return err == nil
}

// openJetStream keeps all JetStream read RPCs on a short-lived connection.
// Unlike a Core subscription this state is never retained after the response,
// which makes read-only MCP calls independent from the desktop live runtime.
func (s *server) openJetStream(params jsonObject) (nats.JetStreamContext, *nats.Conn, jsonObject, error) {
	connection, err := requiredObject(params, "connection")
	if err != nil {
		return nil, nil, nil, err
	}
	nc, err := s.connect(connection)
	if err != nil {
		return nil, nil, nil, err
	}
	js, err := nc.JetStream(nats.MaxWait(requestTimeout(connection)))
	if err != nil {
		nc.Close()
		return nil, nil, nil, err
	}
	return js, nc, connection, nil
}

func (s *server) jetStreamInfo(params jsonObject) (any, bool, error) {
	js, nc, connection, err := s.openJetStream(params)
	if err != nil {
		return nil, false, err
	}
	defer nc.Close()
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout(connection))
	defer cancel()
	info, err := js.AccountInfo(nats.Context(ctx))
	if err != nil {
		return nil, false, fmt.Errorf("JetStream account information is unavailable: %w", err)
	}
	return map[string]any{
		"enabled":      true,
		"memoryBytes":  boundedUint64ToInt64(info.Memory),
		"storageBytes": boundedUint64ToInt64(info.Store),
		"streams":      info.Streams,
		"consumers":    info.Consumers,
	}, false, nil
}

func (s *server) listStreams(params jsonObject) (any, bool, error) {
	js, nc, connection, err := s.openJetStream(params)
	if err != nil {
		return nil, false, err
	}
	defer nc.Close()
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout(connection))
	defer cancel()
	if err := requireJetStream(js, ctx); err != nil {
		return nil, false, err
	}

	items := make([]map[string]any, 0)
	streamCh := js.Streams(nats.Context(ctx))
	if streamCh == nil {
		return nil, false, errors.New("unable to start JetStream stream listing")
	}
	for stream := range streamCh {
		if len(items) == maxJetStreamListItems {
			return map[string]any{"streams": items, "truncated": true}, false, nil
		}
		items = append(items, streamInfoValue(stream))
	}
	if err := ctx.Err(); err != nil {
		return nil, false, fmt.Errorf("JetStream stream listing timed out: %w", err)
	}
	return map[string]any{"streams": items, "truncated": false}, false, nil
}

func (s *server) getStream(params jsonObject) (any, bool, error) {
	stream, err := requiredString(params, "stream")
	if err != nil {
		return nil, false, err
	}
	if err := validateJetStreamName(stream, "stream"); err != nil {
		return nil, false, err
	}
	js, nc, connection, err := s.openJetStream(params)
	if err != nil {
		return nil, false, err
	}
	defer nc.Close()
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout(connection))
	defer cancel()
	info, err := js.StreamInfo(stream, nats.Context(ctx))
	if err != nil {
		return nil, false, fmt.Errorf("JetStream stream information is unavailable: %w", err)
	}
	return streamInfoValue(info), false, nil
}

func (s *server) listConsumers(params jsonObject) (any, bool, error) {
	stream, err := requiredString(params, "stream")
	if err != nil {
		return nil, false, err
	}
	if err := validateJetStreamName(stream, "stream"); err != nil {
		return nil, false, err
	}
	js, nc, connection, err := s.openJetStream(params)
	if err != nil {
		return nil, false, err
	}
	defer nc.Close()
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout(connection))
	defer cancel()
	if err := requireJetStream(js, ctx); err != nil {
		return nil, false, err
	}

	items := make([]map[string]any, 0)
	consumerCh := js.Consumers(stream, nats.Context(ctx))
	if consumerCh == nil {
		return nil, false, errors.New("unable to start JetStream consumer listing")
	}
	for consumer := range consumerCh {
		if len(items) == maxJetStreamListItems {
			return map[string]any{"stream": stream, "consumers": items, "truncated": true}, false, nil
		}
		items = append(items, consumerInfoValue(consumer))
	}
	if err := ctx.Err(); err != nil {
		return nil, false, fmt.Errorf("JetStream consumer listing timed out: %w", err)
	}
	return map[string]any{"stream": stream, "consumers": items, "truncated": false}, false, nil
}

func (s *server) getConsumer(params jsonObject) (any, bool, error) {
	stream, err := requiredString(params, "stream")
	if err != nil {
		return nil, false, err
	}
	consumer, err := requiredString(params, "consumer")
	if err != nil {
		return nil, false, err
	}
	if err := validateJetStreamName(stream, "stream"); err != nil {
		return nil, false, err
	}
	if err := validateJetStreamName(consumer, "consumer"); err != nil {
		return nil, false, err
	}
	js, nc, connection, err := s.openJetStream(params)
	if err != nil {
		return nil, false, err
	}
	defer nc.Close()
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout(connection))
	defer cancel()
	info, err := js.ConsumerInfo(stream, consumer, nats.Context(ctx))
	if err != nil {
		return nil, false, fmt.Errorf("JetStream consumer information is unavailable: %w", err)
	}
	return consumerInfoValue(info), false, nil
}

func (s *server) fetchHistory(params jsonObject) (any, bool, error) {
	history, err := requiredObject(params, "history")
	if err != nil {
		return nil, false, err
	}
	options, err := parseHistoryOptions(history)
	if err != nil {
		return nil, false, err
	}
	js, nc, connection, err := s.openJetStream(params)
	if err != nil {
		return nil, false, err
	}
	defer nc.Close()
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout(connection))
	defer cancel()
	stream, err := js.StreamInfo(options.stream, nats.Context(ctx))
	if err != nil {
		return nil, false, fmt.Errorf("JetStream stream information is unavailable: %w", err)
	}
	if stream.State.Msgs == 0 || stream.State.FirstSeq == 0 {
		return emptyHistoryResult(options.stream), false, nil
	}
	sequence := options.startSequence
	if sequence == 0 || sequence < stream.State.FirstSeq {
		sequence = stream.State.FirstSeq
	}
	messages := make([]map[string]any, 0, options.maxMessages)
	bytesUsed := 0
	skipped := 0
	var nextSequence any
	truncated := false
	for sequence <= stream.State.LastSeq {
		message, getErr := js.GetMsg(options.stream, sequence, nats.Context(ctx))
		if getErr != nil {
			if errors.Is(getErr, nats.ErrMsgNotFound) {
				skipped++
				sequence++
				continue
			}
			return nil, false, fmt.Errorf("JetStream history read failed: %w", getErr)
		}
		item, messageBytes, itemErr := streamMessage(message)
		if itemErr != nil {
			return nil, false, itemErr
		}
		if messageBytes > options.maxBytes-bytesUsed {
			truncated = true
			nextSequence = sequence
			break
		}
		messages = append(messages, item)
		bytesUsed += messageBytes
		sequence++
		if len(messages) == options.maxMessages && sequence <= stream.State.LastSeq {
			truncated = true
			nextSequence = sequence
			break
		}
	}
	return map[string]any{
		"stream":        options.stream,
		"messages":      messages,
		"receivedCount": len(messages),
		"skippedCount":  skipped,
		"truncated":     truncated,
		"nextSequence":  nextSequence,
		"ackMode":       "none",
		"consumerKind":  "direct_get",
	}, false, nil
}

func emptyHistoryResult(stream string) map[string]any {
	return map[string]any{
		"stream": stream, "messages": []map[string]any{}, "receivedCount": 0, "skippedCount": 0, "truncated": false,
		"ackMode": "none", "consumerKind": "direct_get",
	}
}

func requireJetStream(js nats.JetStreamContext, ctx context.Context) error {
	if _, err := js.AccountInfo(nats.Context(ctx)); err != nil {
		return fmt.Errorf("JetStream is unavailable for this connection: %w", err)
	}
	return nil
}

func boundedUint64ToInt64(value uint64) int64 {
	if value > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(value)
}

func streamInfoValue(info *nats.StreamInfo) map[string]any {
	subjects := append([]string(nil), info.Config.Subjects...)
	if subjects == nil {
		subjects = []string{}
	}
	return map[string]any{
		"name":          info.Config.Name,
		"subjects":      subjects,
		"storage":       strings.ToLower(info.Config.Storage.String()),
		"retention":     strings.ToLower(info.Config.Retention.String()),
		"messages":      info.State.Msgs,
		"bytes":         info.State.Bytes,
		"firstSequence": info.State.FirstSeq,
		"lastSequence":  info.State.LastSeq,
		"consumers":     info.State.Consumers,
	}
}

func consumerInfoValue(info *nats.ConsumerInfo) map[string]any {
	return map[string]any{
		"stream":                    info.Stream,
		"name":                      info.Name,
		"filterSubject":             info.Config.FilterSubject,
		"ackPolicy":                 strings.TrimPrefix(strings.ToLower(info.Config.AckPolicy.String()), "ack"),
		"deliveredConsumerSequence": info.Delivered.Consumer,
		"deliveredStreamSequence":   info.Delivered.Stream,
		"ackFloorConsumerSequence":  info.AckFloor.Consumer,
		"ackFloorStreamSequence":    info.AckFloor.Stream,
		"pending":                   info.NumPending,
		"ackPending":                info.NumAckPending,
		"redelivered":               info.NumRedelivered,
	}
}

func (s *server) publish(params jsonObject) (any, bool, error) {
	connection, err := requiredObject(params, "connection")
	if err != nil {
		return nil, false, err
	}
	publish, err := requiredObject(params, "publish")
	if err != nil {
		return nil, false, err
	}
	subject, err := requiredString(publish, "subject")
	if err != nil {
		return nil, false, err
	}
	if err := validateSubject(subject, false, "publish Subject"); err != nil {
		return nil, false, err
	}
	reply, err := optionalString(publish, "reply")
	if err != nil {
		return nil, false, err
	}
	if reply != "" {
		if err := validateSubject(reply, false, "reply Subject"); err != nil {
			return nil, false, err
		}
	}
	headers, err := parseHeaders(publish)
	if err != nil {
		return nil, false, err
	}
	payloadBase64, err := requiredString(publish, "payloadBase64")
	if err != nil {
		return nil, false, err
	}
	payload, err := decodePayloadBase64(payloadBase64)
	if err != nil {
		return nil, false, err
	}

	nc, err := s.connect(connection)
	if err != nil {
		return nil, false, err
	}
	defer nc.Close()
	if len(headers) > 0 && !nc.HeadersSupported() {
		return nil, false, errors.New("NATS server does not support message headers")
	}
	headerBytes, err := serializedHeaderBytes(headers)
	if err != nil {
		return nil, false, err
	}
	if maxPayload := nc.MaxPayload(); maxPayload > 0 && int64(len(payload)+headerBytes) > maxPayload {
		return nil, false, fmt.Errorf("NATS message exceeds server maxPayload (%d bytes)", maxPayload)
	}
	if err := nc.PublishMsg(&nats.Msg{Subject: subject, Reply: reply, Data: payload, Header: headers}); err != nil {
		return nil, false, err
	}
	if err := nc.FlushTimeout(requestTimeout(connection)); err != nil {
		return nil, false, err
	}
	return map[string]any{"acceptedByClient": true, "payloadBytes": len(payload)}, false, nil
}

func (s *server) capture(params jsonObject) (any, bool, error) {
	connection, err := requiredObject(params, "connection")
	if err != nil {
		return nil, false, err
	}
	capture, err := requiredObject(params, "capture")
	if err != nil {
		return nil, false, err
	}
	options, err := parseCaptureOptions(capture)
	if err != nil {
		return nil, false, err
	}

	nc, err := s.connect(connection)
	if err != nil {
		return nil, false, err
	}
	defer nc.Close()
	// A one-message channel keeps a high-volume wildcard capture from growing
	// memory with maxMessages * serverMaxPayload buffered messages.
	ch := make(chan *nats.Msg, captureChannelCapacity)
	sub, err := nc.ChanSubscribe(options.subject, ch)
	if err != nil {
		return nil, false, err
	}
	defer sub.Unsubscribe()
	if err := nc.FlushTimeout(requestTimeout(connection)); err != nil {
		return nil, false, err
	}

	messages := make([]map[string]any, 0, options.maxMessages)
	bytesUsed := 0
	received := 0
	dropped := 0
	timer := time.NewTimer(options.duration)
	defer timer.Stop()
	stopReason := "duration"

captureLoop:
	for {
		select {
		case msg := <-ch:
			if msg == nil {
				continue
			}
			received++
			item, messageBytes, err := captureMessage(msg, options.includeHeaders)
			if err != nil {
				return nil, false, err
			}
			if messageBytes > options.maxBytes-bytesUsed {
				dropped++
				stopReason = "byte_limit"
				break captureLoop
			}
			bytesUsed += messageBytes
			messages = append(messages, item)
			if len(messages) >= options.maxMessages {
				stopReason = "message_limit"
				break captureLoop
			}
			if bytesUsed >= options.maxBytes {
				stopReason = "byte_limit"
				break captureLoop
			}
		case <-timer.C:
			break captureLoop
		}
	}

	// ChanSubscribe reports overflow through Subscription.Dropped. Read it
	// before Unsubscribe closes the subscription and makes the metric invalid.
	if clientDropped, dropErr := sub.Dropped(); dropErr == nil && clientDropped > 0 {
		dropped += clientDropped
		received += clientDropped
	}
	if err := sub.Unsubscribe(); err != nil {
		return nil, false, err
	}
	return map[string]any{
		"subject":       options.subject,
		"messages":      messages,
		"receivedCount": received,
		"droppedCount":  dropped,
		"truncated":     stopReason != "duration" || dropped > 0,
		"stopReason":    stopReason,
	}, false, nil
}

func (s *server) connect(config jsonObject) (*nats.Conn, error) {
	endpoint, tlsConfig, err := connectionEndpoint(config)
	if err != nil {
		return nil, err
	}
	username, err := optionalString(config, "username")
	if err != nil {
		return nil, err
	}
	password, err := optionalString(config, "password")
	if err != nil {
		return nil, err
	}
	token, err := optionalString(config, "token")
	if err != nil {
		return nil, err
	}
	if token != "" && (username != "" || password != "") {
		return nil, errors.New("NATS token authentication cannot be combined with username/password authentication")
	}
	if username == "" && password != "" {
		return nil, errors.New("NATS password authentication requires a username")
	}

	opts := []nats.Option{nats.Name("DBX NATS Agent"), nats.Timeout(connectTimeout(config))}
	if tlsConfig != nil {
		opts = append(opts, nats.Secure(tlsConfig))
	}
	if username != "" {
		opts = append(opts, nats.UserInfo(username, password))
	}
	if token != "" {
		opts = append(opts, nats.Token(token))
	}
	return nats.Connect(endpoint, opts...)
}

// connectionEndpoint separates the configured URL (and therefore TLS SNI)
// from the local DBX tunnel endpoint. The latter is never persisted as a
// replacement server URL, which keeps reconnects and certificate validation
// pointed at the logical NATS host.
func connectionEndpoint(config jsonObject) (string, *tls.Config, error) {
	serverURL, err := requiredString(config, "serverUrl")
	if err != nil {
		return "", nil, err
	}
	parsedURL, err := url.Parse(serverURL)
	if err != nil || !matchesNATSScheme(parsedURL.Scheme) || parsedURL.Host == "" {
		return "", nil, errors.New("serverUrl must use nats:// or tls:// and include a host")
	}
	if parsedURL.User != nil {
		return "", nil, errors.New("serverUrl must not include credentials; use the dedicated authentication fields")
	}
	serverName := parsedURL.Hostname()

	connectHost, err := optionalString(config, "connectHost")
	if err != nil {
		return "", nil, err
	}
	if connectHost != "" {
		connectPort, ok := integerValue(config["connectPort"])
		if !ok || connectPort < 1 || connectPort > 65535 {
			return "", nil, errors.New("connectPort must be a valid port when connectHost is configured")
		}
		parsedURL.Host = net.JoinHostPort(connectHost, strconv.FormatInt(connectPort, 10))
	} else if value, exists := config["connectPort"]; exists && value != nil {
		return "", nil, errors.New("connectPort requires connectHost")
	}

	usesTLS := parsedURL.Scheme == "tls"
	if !usesTLS && boolValue(config, "tlsSkipVerify", false) {
		return "", nil, errors.New("tlsSkipVerify requires a tls:// NATS server URL")
	}
	if !usesTLS {
		return parsedURL.String(), nil, nil
	}
	return parsedURL.String(), &tls.Config{
		ServerName:         serverName,
		InsecureSkipVerify: boolValue(config, "tlsSkipVerify", false),
	}, nil
}

func parseCaptureOptions(capture jsonObject) (captureOptions, error) {
	subject, err := requiredString(capture, "subject")
	if err != nil {
		return captureOptions{}, err
	}
	if err := validateSubject(subject, true, "capture Subject"); err != nil {
		return captureOptions{}, err
	}
	durationMs, err := boundedInteger(capture, "durationMs", 5_000, 1, int64(maxCaptureDuration/time.Millisecond))
	if err != nil {
		return captureOptions{}, err
	}
	maxMessages, err := boundedInteger(capture, "maxMessages", 100, 1, maxCaptureMessages)
	if err != nil {
		return captureOptions{}, err
	}
	maxBytes, err := boundedInteger(capture, "maxBytes", 1<<20, 1, maxCaptureBytes)
	if err != nil {
		return captureOptions{}, err
	}
	includeHeaders, err := optionalBool(capture, "includeHeaders", true)
	if err != nil {
		return captureOptions{}, err
	}
	return captureOptions{
		subject: subject, duration: time.Duration(durationMs) * time.Millisecond,
		maxMessages: int(maxMessages), maxBytes: int(maxBytes), includeHeaders: includeHeaders,
	}, nil
}

func parseHistoryOptions(history jsonObject) (historyOptions, error) {
	stream, err := requiredString(history, "stream")
	if err != nil {
		return historyOptions{}, err
	}
	if err := validateJetStreamName(stream, "stream"); err != nil {
		return historyOptions{}, err
	}
	startSequence := uint64(0)
	if raw, exists := history["startSequence"]; exists && raw != nil {
		value, ok := integerValue(raw)
		if !ok || value < 1 {
			return historyOptions{}, errors.New("startSequence must be a positive integer when provided")
		}
		startSequence = uint64(value)
	}
	maxMessages, err := boundedInteger(history, "maxMessages", 100, 1, maxHistoryMessages)
	if err != nil {
		return historyOptions{}, err
	}
	maxBytes, err := boundedInteger(history, "maxBytes", 1<<20, 1, maxHistoryBytes)
	if err != nil {
		return historyOptions{}, err
	}
	return historyOptions{
		stream: stream, startSequence: startSequence, maxMessages: int(maxMessages), maxBytes: int(maxBytes),
	}, nil
}

func captureMessage(msg *nats.Msg, includeHeaders bool) (map[string]any, int, error) {
	return natsMessageValue(msg.Subject, msg.Reply, msg.Data, msg.Header, time.Now(), includeHeaders)
}

func streamMessage(msg *nats.RawStreamMsg) (map[string]any, int, error) {
	return natsMessageValue(msg.Subject, "", msg.Data, msg.Header, msg.Time, true)
}

func natsMessageValue(
	subject, reply string, data []byte, headers nats.Header, receivedAt time.Time, includeHeaders bool,
) (map[string]any, int, error) {
	messageBytes := len(data)
	if receivedAt.IsZero() {
		receivedAt = time.Now()
	}
	item := map[string]any{
		"subject":       subject,
		"payloadBase64": base64.StdEncoding.EncodeToString(data),
		"receivedAtMs":  receivedAt.UnixMilli(),
		"sizeBytes":     len(data),
	}
	if utf8.Valid(data) {
		item["payloadText"] = string(data)
	}
	if includeHeaders && len(headers) > 0 {
		headerBytes, err := serializedHeaderBytes(headers)
		if err != nil {
			return nil, 0, errors.New("received NATS message has invalid headers")
		}
		messageBytes += headerBytes
		item["headers"] = headerArray(headers)
	} else if includeHeaders {
		item["headers"] = []map[string]string{}
	}
	if reply != "" {
		item["reply"] = reply
	}
	return item, messageBytes, nil
}

func validateSubject(subject string, allowWildcards bool, field string) error {
	if subject == "" {
		return fmt.Errorf("NATS %s is required", field)
	}
	if len(subject) > maxSubjectBytes {
		return fmt.Errorf("NATS %s exceeds the %d byte agent limit", field, maxSubjectBytes)
	}
	tokens := strings.Split(subject, ".")
	for index, token := range tokens {
		if token == "" {
			return fmt.Errorf("NATS %s cannot contain empty tokens", field)
		}
		switch token {
		case "*":
			if allowWildcards {
				continue
			}
			return fmt.Errorf("NATS %s must be a concrete subject", field)
		case ">":
			if allowWildcards && index == len(tokens)-1 {
				continue
			}
			return fmt.Errorf("NATS %s wildcard > must be the final token", field)
		}
		if strings.ContainsAny(token, "*>") {
			return fmt.Errorf("NATS %s has an invalid wildcard token", field)
		}
		for _, character := range token {
			if unicode.IsSpace(character) || unicode.IsControl(character) {
				return fmt.Errorf("NATS %s cannot contain whitespace or control characters", field)
			}
		}
	}
	return nil
}

func validateJetStreamName(value, kind string) error {
	if value == "" || len(value) > 256 {
		return fmt.Errorf("NATS JetStream %s name is required and must be at most 256 bytes", kind)
	}
	for _, character := range value {
		if unicode.IsSpace(character) || unicode.IsControl(character) || strings.ContainsRune(".*>/\\", character) {
			return fmt.Errorf("NATS JetStream %s name contains unsupported characters", kind)
		}
	}
	return nil
}

func validateSubscriptionID(value string) error {
	if value == "" || len(value) > 128 {
		return errors.New("NATS subscriptionId is required and must be at most 128 bytes")
	}
	for _, character := range value {
		if unicode.IsSpace(character) || unicode.IsControl(character) {
			return errors.New("NATS subscriptionId cannot contain whitespace or control characters")
		}
	}
	return nil
}

func validateQueueGroup(value string) error {
	if value == "" {
		return nil
	}
	if len(value) > 256 {
		return errors.New("NATS queue group exceeds the 256 byte agent limit")
	}
	for _, character := range value {
		if unicode.IsSpace(character) || unicode.IsControl(character) {
			return errors.New("NATS queue group cannot contain whitespace or control characters")
		}
	}
	return nil
}

func parseHeaders(parent jsonObject) (nats.Header, error) {
	raw, exists := parent["headers"]
	if !exists || raw == nil {
		return nil, nil
	}
	values, ok := raw.([]any)
	if !ok {
		return nil, errors.New("NATS headers must be an array")
	}
	if len(values) > maxHeaderCount {
		return nil, fmt.Errorf("NATS headers cannot contain more than %d entries", maxHeaderCount)
	}
	result := nats.Header{}
	for _, rawValue := range values {
		item, ok := asObject(rawValue)
		if !ok {
			return nil, errors.New("each NATS header must be an object")
		}
		key, err := requiredString(item, "key")
		if err != nil {
			return nil, fmt.Errorf("invalid NATS header key: %w", err)
		}
		value, err := requiredString(item, "value")
		if err != nil {
			return nil, fmt.Errorf("invalid NATS header value: %w", err)
		}
		if !validHeaderKey(key) || len(key) > maxHeaderKeyBytes {
			return nil, errors.New("NATS header key must be a valid, bounded HTTP token")
		}
		if !validHeaderValue(value) || len(value) > maxHeaderValueBytes {
			return nil, errors.New("NATS header value contains invalid or oversized data")
		}
		result.Add(key, value)
	}
	headerBytes, err := serializedHeaderBytes(result)
	if err != nil {
		return nil, errors.New("NATS headers are invalid")
	}
	if headerBytes > maxHeaderWireBytes {
		return nil, fmt.Errorf("NATS headers exceed the %d byte agent limit", maxHeaderWireBytes)
	}
	return result, nil
}

func validHeaderKey(key string) bool {
	if key == "" {
		return false
	}
	for _, character := range key {
		if !(character >= '0' && character <= '9' || character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || strings.ContainsRune("!#$%&'*+-.^_`|~", character)) {
			return false
		}
	}
	return true
}

func validHeaderValue(value string) bool {
	for _, character := range value {
		if character == '\r' || character == '\n' || character == 0 || character == 0x7f || (character < 0x20 && character != '\t') {
			return false
		}
	}
	return true
}

func serializedHeaderBytes(headers nats.Header) (int, error) {
	if len(headers) == 0 {
		return 0, nil
	}
	var buffer bytes.Buffer
	if _, err := buffer.WriteString("NATS/1.0\r\n"); err != nil {
		return 0, err
	}
	if err := http.Header(headers).Write(&buffer); err != nil {
		return 0, err
	}
	if _, err := buffer.WriteString("\r\n"); err != nil {
		return 0, err
	}
	return buffer.Len(), nil
}

func decodePayloadBase64(encoded string) ([]byte, error) {
	if len(encoded) > base64.StdEncoding.EncodedLen(maxPublishPayloadBytes) {
		return nil, fmt.Errorf("NATS payload exceeds the %d byte agent limit", maxPublishPayloadBytes)
	}
	if strings.ContainsAny(encoded, "\r\n") {
		return nil, errors.New("payloadBase64 must be canonical base64")
	}
	payload, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(payload) != encoded {
		return nil, errors.New("payloadBase64 must be canonical base64")
	}
	if len(payload) > maxPublishPayloadBytes {
		return nil, fmt.Errorf("NATS payload exceeds the %d byte agent limit", maxPublishPayloadBytes)
	}
	return payload, nil
}

func requiredObject(parent jsonObject, key string) (jsonObject, error) {
	value, exists := parent[key]
	if !exists || value == nil {
		return nil, fmt.Errorf("%s is required", key)
	}
	if object, ok := asObject(value); ok {
		return object, nil
	}
	return nil, fmt.Errorf("%s must be an object", key)
}

func asObject(value any) (jsonObject, bool) {
	switch object := value.(type) {
	case jsonObject:
		return object, true
	case map[string]any:
		return jsonObject(object), true
	default:
		return nil, false
	}
}

func requiredString(object jsonObject, key string) (string, error) {
	value, exists := object[key]
	if !exists || value == nil {
		return "", fmt.Errorf("%s is required", key)
	}
	stringValue, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return stringValue, nil
}

func optionalString(object jsonObject, key string) (string, error) {
	value, exists := object[key]
	if !exists || value == nil {
		return "", nil
	}
	stringValue, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return stringValue, nil
}

func optionalBool(object jsonObject, key string, fallback bool) (bool, error) {
	value, exists := object[key]
	if !exists || value == nil {
		return fallback, nil
	}
	boolean, ok := value.(bool)
	if !ok {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return boolean, nil
}

func boolValue(object jsonObject, key string, fallback bool) bool {
	value, err := optionalBool(object, key, fallback)
	if err != nil {
		return fallback
	}
	return value
}

func boundedInteger(object jsonObject, key string, fallback, minimum, maximum int64) (int64, error) {
	value, exists := object[key]
	if !exists || value == nil {
		return fallback, nil
	}
	integer, ok := integerValue(value)
	if !ok {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	if integer < minimum || integer > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", key, minimum, maximum)
	}
	return integer, nil
}

func integerValue(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int8:
		return int64(number), true
	case int16:
		return int64(number), true
	case int32:
		return int64(number), true
	case int64:
		return number, true
	case uint:
		if uint64(number) <= math.MaxInt64 {
			return int64(number), true
		}
	case uint8:
		return int64(number), true
	case uint16:
		return int64(number), true
	case uint32:
		return int64(number), true
	case uint64:
		if number <= math.MaxInt64 {
			return int64(number), true
		}
	case float64:
		if !math.IsNaN(number) && !math.IsInf(number, 0) && math.Trunc(number) == number && number >= math.MinInt64 && number <= math.MaxInt64 {
			return int64(number), true
		}
	case json.Number:
		integer, err := number.Int64()
		if err == nil {
			return integer, true
		}
	}
	return 0, false
}

func requestTimeout(config jsonObject) time.Duration {
	ms, ok := integerValue(config["requestTimeoutMs"])
	if !ok || ms <= 0 {
		ms = 30_000
	}
	return time.Duration(ms) * time.Millisecond
}

func connectTimeout(config jsonObject) time.Duration {
	ms, ok := integerValue(config["connectTimeoutMs"])
	if !ok || ms <= 0 {
		ms = 15_000
	}
	return time.Duration(ms) * time.Millisecond
}

func jetStreamProbeTimeout(config jsonObject) time.Duration {
	timeout := requestTimeout(config)
	if timeout > maxJetStreamProbeTimeout {
		return maxJetStreamProbeTimeout
	}
	return timeout
}

func matchesNATSScheme(scheme string) bool {
	return scheme == "nats" || scheme == "tls"
}

func headerArray(header nats.Header) []map[string]string {
	keys := make([]string, 0, len(header))
	for key := range header {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]map[string]string, 0)
	for _, key := range keys {
		for _, value := range header[key] {
			result = append(result, map[string]string{"key": key, "value": value})
		}
	}
	return result
}

func redactError(err error, params jsonObject) string {
	message := err.Error()
	connection, ok := asObject(params["connection"])
	if !ok {
		return message
	}
	for _, key := range []string{"password", "token"} {
		if value, valueErr := optionalString(connection, key); valueErr == nil && value != "" {
			message = strings.ReplaceAll(message, value, "[REDACTED]")
		}
	}
	if serverURL, urlErr := optionalString(connection, "serverUrl"); urlErr == nil {
		if parsedURL, parseErr := url.Parse(serverURL); parseErr == nil && parsedURL.User != nil {
			message = strings.ReplaceAll(message, parsedURL.User.String(), "[REDACTED]")
		}
	}
	return message
}
