package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

func TestHandshakeDispatch(t *testing.T) {
	service := &server{}
	response, shutdown := service.handle([]byte(`{"jsonrpc":"2.0","id":7,"method":"handshake","params":{"client":"dbx"}}`))
	if shutdown {
		t.Fatal("handshake must not shut down the agent")
	}
	if response.Error != nil {
		t.Fatalf("handshake returned error: %+v", response.Error)
	}
	var result handshakeResult
	encoded, err := json.Marshal(response.Result)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	if result.ProtocolVersion != 2 || result.AgentProtocolVersion != 2 {
		t.Fatalf("unexpected handshake versions: %+v", result)
	}
	if !contains(result.Capabilities, "nats_jetstream_read") {
		t.Fatalf("JetStream read capability must be advertised: %+v", result.Capabilities)
	}
}

func TestJetStreamNamesAndHistoryLimitsAreValidatedBeforeConnecting(t *testing.T) {
	for _, name := range []string{"ORDERS", "orders-archive", "tenant_orders"} {
		if err := validateJetStreamName(name, "stream"); err != nil {
			t.Fatalf("JetStream name %q should be valid: %v", name, err)
		}
	}
	for _, name := range []string{"", "orders.stream", "orders/stream", "orders stream", "orders.>"} {
		if err := validateJetStreamName(name, "stream"); err == nil {
			t.Fatalf("JetStream name %q should be rejected", name)
		}
	}
	for _, history := range []jsonObject{
		{"stream": "ORDERS", "maxMessages": 1_001},
		{"stream": "ORDERS", "maxBytes": maxHistoryBytes + 1},
		{"stream": "ORDERS", "startSequence": "0"},
	} {
		if _, err := parseHistoryOptions(history); err == nil {
			t.Fatalf("history options %#v should be rejected", history)
		}
	}

	service := &server{}
	_, _, err := service.dispatch("fetch_history", jsonObject{
		"connection": jsonObject{"serverUrl": "nats://127.0.0.1:1"},
		"history":    jsonObject{"stream": "orders.stream"},
	})
	if err == nil {
		t.Fatal("invalid history stream must be rejected before connecting")
	}
}

func TestJetStreamValuesAndHistoryMessageUseSharedDTOShape(t *testing.T) {
	stream := streamInfoValue(&nats.StreamInfo{
		Config: nats.StreamConfig{Name: "ORDERS", Subjects: []string{"orders.created"}, Storage: nats.FileStorage, Retention: nats.LimitsPolicy},
		State:  nats.StreamState{Msgs: 3, Bytes: 42, FirstSeq: 4, LastSeq: 6, Consumers: 2},
	})
	if stream["storage"] != "file" || stream["retention"] != "limits" || stream["firstSequence"] != "4" || stream["lastSequence"] != "6" {
		t.Fatalf("unexpected stream DTO: %#v", stream)
	}
	consumer := consumerInfoValue(&nats.ConsumerInfo{
		Stream: "ORDERS", Name: "DASHBOARD", Config: nats.ConsumerConfig{FilterSubject: "orders.>", AckPolicy: nats.AckExplicitPolicy},
		Delivered: nats.SequenceInfo{Consumer: 8, Stream: 10}, AckFloor: nats.SequenceInfo{Consumer: 6, Stream: 8},
		NumPending: 4, NumAckPending: 2, NumRedelivered: 1,
	})
	if consumer["ackPolicy"] != "explicit" || consumer["deliveredConsumerSequence"] != "8" || consumer["deliveredStreamSequence"] != "10" ||
		consumer["ackFloorConsumerSequence"] != "6" || consumer["ackFloorStreamSequence"] != "8" || consumer["pending"] != uint64(4) || consumer["ackPending"] != 2 {
		t.Fatalf("unexpected consumer DTO: %#v", consumer)
	}
	message, messageBytes, err := streamMessage(&nats.RawStreamMsg{
		Subject: "orders.created", Sequence: 4, Header: nats.Header{"Nats-Msg-Id": []string{"42"}}, Data: []byte("ok"),
		Time: time.UnixMilli(1_700_000_000_000),
	})
	if err != nil || message["payloadBase64"] != "b2s=" || message["receivedAtMs"] != int64(1_700_000_000_000) || messageBytes <= 2 {
		t.Fatalf("unexpected history message: value=%#v bytes=%d err=%v", message, messageBytes, err)
	}
}

func TestJetStreamSequencesUseDecimalStringsAcrossTheRPCBoundary(t *testing.T) {
	const sequence uint64 = 9_007_199_254_740_993
	sequenceText := strconv.FormatUint(sequence, 10)

	stream := streamInfoValue(&nats.StreamInfo{State: nats.StreamState{FirstSeq: sequence, LastSeq: sequence + 1}})
	if stream["firstSequence"] != sequenceText || stream["lastSequence"] != strconv.FormatUint(sequence+1, 10) {
		t.Fatalf("stream sequences must be decimal strings: %#v", stream)
	}

	consumer := consumerInfoValue(&nats.ConsumerInfo{
		Delivered: nats.SequenceInfo{Consumer: sequence, Stream: sequence + 1},
		AckFloor:  nats.SequenceInfo{Consumer: sequence + 2, Stream: sequence + 3},
	})
	for key, want := range map[string]string{
		"deliveredConsumerSequence": sequenceText,
		"deliveredStreamSequence":   strconv.FormatUint(sequence+1, 10),
		"ackFloorConsumerSequence":  strconv.FormatUint(sequence+2, 10),
		"ackFloorStreamSequence":    strconv.FormatUint(sequence+3, 10),
	} {
		if consumer[key] != want {
			t.Fatalf("consumer %s must be a decimal string: got %#v want %q", key, consumer[key], want)
		}
	}

	options, err := parseHistoryOptions(jsonObject{"stream": "ORDERS", "startSequence": sequenceText})
	if err != nil || options.startSequence != sequence {
		t.Fatalf("large decimal startSequence must remain exact: options=%+v err=%v", options, err)
	}
	if _, err := parseHistoryOptions(jsonObject{"stream": "ORDERS", "startSequence": sequence}); err == nil {
		t.Fatal("numeric startSequence must be rejected at the agent boundary")
	}
}

func TestJetStreamReadRPCsUseOnlyReadAPIs(t *testing.T) {
	service := &server{}
	connection := jsonObject{
		"serverUrl": startFakeNATSServer(t, fakeNATSOptions{headersSupported: true, jetStream: true}), "requestTimeoutMs": 500,
	}
	info, _, err := service.dispatch("jetstream_info", jsonObject{"connection": connection})
	if err != nil || !info.(map[string]any)["enabled"].(bool) {
		t.Fatalf("JetStream info must succeed: value=%#v err=%v", info, err)
	}
	streams, _, err := service.dispatch("list_streams", jsonObject{"connection": connection})
	if err != nil || len(streams.(map[string]any)["streams"].([]map[string]any)) != 1 {
		t.Fatalf("JetStream Stream list must use API response: value=%#v err=%v", streams, err)
	}
	stream, _, err := service.dispatch("get_stream", jsonObject{"connection": connection, "stream": "ORDERS"})
	if err != nil || stream.(map[string]any)["lastSequence"] != "2" {
		t.Fatalf("JetStream Stream info must succeed: value=%#v err=%v", stream, err)
	}
	consumers, _, err := service.dispatch("list_consumers", jsonObject{"connection": connection, "stream": "ORDERS"})
	if err != nil || len(consumers.(map[string]any)["consumers"].([]map[string]any)) != 1 {
		t.Fatalf("JetStream Consumer list must use API response: value=%#v err=%v", consumers, err)
	}
	consumer, _, err := service.dispatch("get_consumer", jsonObject{
		"connection": connection, "stream": "ORDERS", "consumer": "DASHBOARD",
	})
	if err != nil || consumer.(map[string]any)["ackPolicy"] != "explicit" {
		t.Fatalf("JetStream Consumer info must succeed: value=%#v err=%v", consumer, err)
	}
	history, _, err := service.dispatch("fetch_history", jsonObject{
		"connection": connection, "history": jsonObject{"stream": "ORDERS", "maxMessages": 1, "maxBytes": 1024},
	})
	if err != nil {
		t.Fatalf("JetStream direct history read must succeed: %v", err)
	}
	historyResult := history.(map[string]any)
	if historyResult["ackMode"] != "none" || historyResult["consumerKind"] != "direct_get" || !historyResult["truncated"].(bool) {
		t.Fatalf("history must be bounded and side-effect free: %#v", historyResult)
	}
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func TestPublishRejectsWildcardBeforeConnecting(t *testing.T) {
	service := &server{}
	_, _, err := service.dispatch("publish", jsonObject{
		"connection": jsonObject{"serverUrl": "nats://127.0.0.1:1"},
		"publish":    jsonObject{"subject": "orders.>", "payloadBase64": ""},
	})
	if err == nil {
		t.Fatal("wildcard publish should fail before attempting a connection")
	}
}

func TestCaptureRejectsUnboundedLimitsBeforeConnecting(t *testing.T) {
	service := &server{}
	_, _, err := service.dispatch("capture", jsonObject{
		"connection": jsonObject{"serverUrl": "nats://127.0.0.1:1"},
		"capture":    jsonObject{"subject": "orders.>", "durationMs": 60_001},
	})
	if err == nil {
		t.Fatal("capture with an excessive duration should be rejected")
	}
}

func TestMalformedRPCReturnsError(t *testing.T) {
	service := &server{}
	response, shutdown := service.handle([]byte("not-json"))
	if shutdown || response.Error == nil {
		t.Fatalf("malformed RPC should return an error response: %+v", response)
	}
}

func TestValidateSubjectEnforcesNATSTokens(t *testing.T) {
	for _, subject := range []string{"orders.created", "orders.*", "orders.*.created", "orders.>", ">"} {
		if err := validateSubject(subject, true, "capture Subject"); err != nil {
			t.Fatalf("capture subject %q should be valid: %v", subject, err)
		}
	}
	for _, subject := range []string{"", "orders..created", "orders.>.created", "orders.foo*", "orders. created", "orders.\ncreated"} {
		if err := validateSubject(subject, true, "capture Subject"); err == nil {
			t.Fatalf("capture subject %q should be rejected", subject)
		}
	}
	for _, subject := range []string{"orders.*", "orders.>"} {
		if err := validateSubject(subject, false, "publish Subject"); err == nil {
			t.Fatalf("publish subject %q should reject wildcards", subject)
		}
	}
}

func TestHeaderAndPayloadValidation(t *testing.T) {
	headers, err := parseHeaders(jsonObject{"headers": []any{
		jsonObject{"key": "Nats-Msg-Id", "value": "42"},
		jsonObject{"key": "Nats-Msg-Id", "value": "43"},
	}})
	if err != nil || len(headers["Nats-Msg-Id"]) != 2 {
		t.Fatalf("valid repeated headers should be preserved: headers=%#v err=%v", headers, err)
	}
	for _, header := range []jsonObject{
		{"key": "", "value": "value"},
		{"key": "bad key", "value": "value"},
		{"key": "X-Test", "value": "line\r\nbreak"},
	} {
		if _, err := parseHeaders(jsonObject{"headers": []any{header}}); err == nil {
			t.Fatalf("header %#v should be rejected", header)
		}
	}

	if _, err := decodePayloadBase64("not base64"); err == nil {
		t.Fatal("malformed base64 should be rejected")
	}
	if _, err := decodePayloadBase64("YWJj\n"); err == nil {
		t.Fatal("non-canonical base64 should be rejected")
	}
	overLimit := strings.Repeat("A", base64.StdEncoding.EncodedLen(maxPublishPayloadBytes)+1)
	if _, err := decodePayloadBase64(overLimit); err == nil {
		t.Fatal("payload over the Agent limit should be rejected")
	}
}

func TestPublishRejectsHeadersWhenServerDoesNotSupportThem(t *testing.T) {
	service := &server{}
	_, _, err := service.dispatch("publish", jsonObject{
		"connection": jsonObject{"serverUrl": startFakeNATSServer(t, fakeNATSOptions{headersSupported: false})},
		"publish": jsonObject{
			"subject": "orders.created", "payloadBase64": "",
			"headers": []any{jsonObject{"key": "Nats-Msg-Id", "value": "42"}},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "does not support message headers") {
		t.Fatalf("expected explicit headers-unsupported error, got %v", err)
	}
}

func TestPublishRejectsPayloadOverServerMaxPayload(t *testing.T) {
	service := &server{}
	_, _, err := service.dispatch("publish", jsonObject{
		"connection": jsonObject{"serverUrl": startFakeNATSServer(t, fakeNATSOptions{headersSupported: true, maxPayload: 3})},
		"publish":    jsonObject{"subject": "orders.created", "payloadBase64": base64.StdEncoding.EncodeToString([]byte("four"))},
	})
	if err == nil || !strings.Contains(err.Error(), "exceeds server maxPayload") {
		t.Fatalf("expected server maxPayload error, got %v", err)
	}
}

func TestCaptureStopsAtMessageAndByteLimits(t *testing.T) {
	service := &server{}
	messageLimitedURL := startFakeNATSServer(t, fakeNATSOptions{messages: [][]byte{[]byte("one"), []byte("two")}})
	result, _, err := service.dispatch("capture", jsonObject{
		"connection": jsonObject{"serverUrl": messageLimitedURL, "requestTimeoutMs": 500},
		"capture":    jsonObject{"subject": "orders.created", "durationMs": 500, "maxMessages": 2, "maxBytes": 32},
	})
	if err != nil {
		t.Fatalf("message-limited capture failed: %v", err)
	}
	messageLimited := result.(map[string]any)
	if messageLimited["stopReason"] != "message_limit" || !messageLimited["truncated"].(bool) || len(messageLimited["messages"].([]map[string]any)) != 2 {
		t.Fatalf("unexpected message-limited capture result: %#v", messageLimited)
	}

	byteLimitedURL := startFakeNATSServer(t, fakeNATSOptions{messages: [][]byte{[]byte("five!")}})
	result, _, err = service.dispatch("capture", jsonObject{
		"connection": jsonObject{"serverUrl": byteLimitedURL, "requestTimeoutMs": 500},
		"capture":    jsonObject{"subject": "orders.created", "durationMs": 500, "maxMessages": 2, "maxBytes": 4},
	})
	if err != nil {
		t.Fatalf("byte-limited capture failed: %v", err)
	}
	byteLimited := result.(map[string]any)
	if byteLimited["stopReason"] != "byte_limit" || !byteLimited["truncated"].(bool) || byteLimited["droppedCount"].(int) != 1 {
		t.Fatalf("unexpected byte-limited capture result: %#v", byteLimited)
	}
}

func TestJetStreamProbeUsesRequestBound(t *testing.T) {
	if timeout := jetStreamProbeTimeout(jsonObject{"requestTimeoutMs": 30_000}); timeout != maxJetStreamProbeTimeout {
		t.Fatalf("JetStream probe timeout should be capped at %s, got %s", maxJetStreamProbeTimeout, timeout)
	}
	service := &server{}
	start := time.Now()
	result, _, err := service.dispatch("test_connection", jsonObject{
		"connection": jsonObject{
			"serverUrl":        startFakeNATSServer(t, fakeNATSOptions{headersSupported: true}),
			"requestTimeoutMs": 75,
		},
	})
	if err != nil {
		t.Fatalf("test connection failed: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 750*time.Millisecond {
		t.Fatalf("JetStream probe exceeded its request bound: %s", elapsed)
	}
	if result.(map[string]any)["jetstreamEnabled"].(bool) {
		t.Fatalf("server without a JetStream response must not be reported as enabled: %#v", result)
	}
}

func TestTimeoutsSaturateAtMaximumDuration(t *testing.T) {
	if timeout := requestTimeout(jsonObject{"requestTimeoutMs": int64(math.MaxInt64)}); timeout != time.Duration(math.MaxInt64) {
		t.Fatalf("request timeout should saturate at max duration, got %s", timeout)
	}
	if timeout := connectTimeout(jsonObject{"connectTimeoutMs": int64(math.MaxInt64)}); timeout != time.Duration(math.MaxInt64) {
		t.Fatalf("connect timeout should saturate at max duration, got %s", timeout)
	}
}

func TestRedactErrorDoesNotExposeCredentials(t *testing.T) {
	params := jsonObject{"connection": jsonObject{
		"serverUrl": "nats://alice:hunter2@localhost:4222",
		"password":  "hunter2",
		"token":     "token-secret",
	}}
	message := redactError(errors.New("failed nats://alice:hunter2@localhost:4222 with hunter2 and token-secret"), params)
	if strings.Contains(message, "hunter2") || strings.Contains(message, "token-secret") {
		t.Fatalf("credential leaked in error message: %q", message)
	}
}

func TestConnectionEndpointKeepsTLSNameWhenUsingTunnel(t *testing.T) {
	endpoint, tlsConfig, err := connectionEndpoint(jsonObject{
		"serverUrl":     "tls://nats.example.test:4222",
		"connectHost":   "127.0.0.1",
		"connectPort":   43123,
		"tlsSkipVerify": false,
	})
	if err != nil {
		t.Fatalf("tunnel endpoint should be valid: %v", err)
	}
	if endpoint != "tls://127.0.0.1:43123" {
		t.Fatalf("unexpected tunnel endpoint: %q", endpoint)
	}
	if tlsConfig == nil || tlsConfig.ServerName != "nats.example.test" || tlsConfig.InsecureSkipVerify {
		t.Fatalf("TLS must preserve the configured server name: %#v", tlsConfig)
	}
}

func TestConnectionEndpointRejectsIncompleteOrInsecureOverrides(t *testing.T) {
	for _, config := range []jsonObject{
		{"serverUrl": "nats://localhost:4222", "connectPort": 4223},
		{"serverUrl": "nats://localhost:4222", "connectHost": "127.0.0.1", "connectPort": 0},
		{"serverUrl": "nats://localhost:4222", "tlsSkipVerify": true},
	} {
		if _, _, err := connectionEndpoint(config); err == nil {
			t.Fatalf("connection override %#v should be rejected", config)
		}
	}
}

func TestPersistentSubscriptionLifecycleIsIdempotent(t *testing.T) {
	service := newServer()
	params := jsonObject{
		"connection":   jsonObject{"serverUrl": startFakeNATSServer(t, fakeNATSOptions{headersSupported: true})},
		"subscription": jsonObject{"subscriptionId": "sub-1", "subject": "orders.>"},
	}
	result, _, err := service.dispatch("start_subscription", params)
	if err != nil {
		t.Fatalf("start subscription failed: %v", err)
	}
	if info := result.(subscriptionInfo); info.State != "active" || info.SubscriptionID != "sub-1" {
		t.Fatalf("unexpected subscription info: %#v", info)
	}
	result, _, err = service.dispatch("start_subscription", params)
	if err != nil {
		t.Fatalf("duplicate subscription start failed: %v", err)
	}
	if info := result.(subscriptionInfo); info.SubscriptionID != "sub-1" {
		t.Fatalf("duplicate start should return the existing subscription: %#v", info)
	}
	result, _, err = service.dispatch("list_subscriptions", jsonObject{})
	if err != nil {
		t.Fatalf("list subscriptions failed: %v", err)
	}
	if items := result.([]subscriptionInfo); len(items) != 1 || items[0].SubscriptionID != "sub-1" {
		t.Fatalf("unexpected active subscriptions: %#v", items)
	}
	result, _, err = service.dispatch("stop_subscription", jsonObject{"subscriptionId": "sub-1"})
	if err != nil || !result.(map[string]any)["ok"].(bool) || !result.(map[string]any)["found"].(bool) {
		t.Fatalf("stop subscription failed: result=%#v error=%v", result, err)
	}
	result, _, err = service.dispatch("list_subscriptions", jsonObject{})
	if err != nil || len(result.([]subscriptionInfo)) != 0 {
		t.Fatalf("subscription must be removed after stop: result=%#v error=%v", result, err)
	}
	result, _, err = service.dispatch("stop_subscription", jsonObject{"subscriptionId": "missing"})
	if err != nil || result.(map[string]any)["found"].(bool) {
		t.Fatalf("unknown subscription should report found=false: result=%#v error=%v", result, err)
	}
}

func TestPersistentSubscriptionRejectsInvalidIdsAndQueueGroups(t *testing.T) {
	service := newServer()
	base := jsonObject{
		"connection":   jsonObject{"serverUrl": "nats://127.0.0.1:1"},
		"subscription": jsonObject{"subscriptionId": "sub-1", "subject": "orders.created"},
	}
	for _, subscription := range []jsonObject{
		{"subscriptionId": "bad id", "subject": "orders.created"},
		{"subscriptionId": "sub-1", "subject": "orders.>.created"},
		{"subscriptionId": "sub-1", "subject": "orders.created", "queueGroup": "queue group"},
	} {
		params := jsonObject{"connection": base["connection"], "subscription": subscription}
		if _, _, err := service.dispatch("start_subscription", params); err == nil {
			t.Fatalf("invalid subscription %#v must be rejected before connecting", subscription)
		}
	}
}

type fakeNATSOptions struct {
	headersSupported bool
	maxPayload       int64
	messages         [][]byte
	jetStream        bool
}

func startFakeNATSServer(t *testing.T, options fakeNATSOptions) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if options.maxPayload == 0 {
		options.maxPayload = 1024 * 1024
	}
	done := make(chan struct{})
	var connections sync.WaitGroup
	go func() {
		defer close(done)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			connections.Add(1)
			go func() {
				defer connections.Done()
				serveFakeNATSConnection(connection, options)
			}()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("fake NATS server did not stop")
		}
		waitForConnections := make(chan struct{})
		go func() {
			connections.Wait()
			close(waitForConnections)
		}()
		select {
		case <-waitForConnections:
		case <-time.After(time.Second):
			t.Error("fake NATS connections did not stop")
		}
	})
	return "nats://" + listener.Addr().String()
}

func serveFakeNATSConnection(connection net.Conn, options fakeNATSOptions) {
	defer connection.Close()
	info, _ := json.Marshal(map[string]any{
		"server_id": "DBX-TEST", "server_name": "dbx-test", "version": "2.10.0", "proto": 1,
		"headers": options.headersSupported, "max_payload": options.maxPayload,
	})
	if _, err := fmt.Fprintf(connection, "INFO %s\r\n", info); err != nil {
		return
	}
	reader := bufio.NewReader(connection)
	var subscriptionSubject, subscriptionID string
	subscriptions := make(map[string]string)
	messagesSent := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "PING":
			if _, err := fmt.Fprint(connection, "PONG\r\n"); err != nil {
				return
			}
			if subscriptionID != "" && !messagesSent {
				messagesSent = true
				for _, payload := range options.messages {
					time.Sleep(8 * time.Millisecond)
					if _, err := fmt.Fprintf(connection, "MSG %s %s %d\r\n%s\r\n", subscriptionSubject, subscriptionID, len(payload), payload); err != nil {
						return
					}
				}
			}
		case "SUB":
			if len(fields) >= 3 {
				subject := fields[len(fields)-2]
				sid := fields[len(fields)-1]
				subscriptions[subject] = sid
				if !strings.HasPrefix(subject, "_INBOX.") {
					subscriptionSubject = subject
					subscriptionID = sid
				}
			}
		case "PUB", "HPUB":
			payload, err := readNATSPayload(reader, fields)
			if err != nil {
				return
			}
			if options.jetStream && fields[0] == "PUB" && len(fields) == 4 && strings.HasPrefix(fields[1], "$JS.API.") {
				reply := fields[2]
				if sid := fakeSubscriptionID(subscriptions, reply); sid != "" {
					response, responseErr := fakeJetStreamResponse(fields[1], payload)
					if responseErr != nil || writeFakeMessage(connection, reply, sid, response) != nil {
						return
					}
				}
			}
		}
	}
}

func fakeSubscriptionID(subscriptions map[string]string, reply string) string {
	if sid := subscriptions[reply]; sid != "" {
		return sid
	}
	for subject, sid := range subscriptions {
		if strings.HasSuffix(subject, ".*") && strings.HasPrefix(reply, strings.TrimSuffix(subject, "*")) {
			return sid
		}
	}
	return ""
}

func fakeJetStreamResponse(subject string, request []byte) ([]byte, error) {
	stream := map[string]any{
		"config": map[string]any{"name": "ORDERS", "subjects": []string{"orders.created"}, "storage": "file", "retention": "limits"},
		"state":  map[string]any{"messages": 2, "bytes": 4, "first_seq": 1, "last_seq": 2, "consumer_count": 1},
	}
	consumer := map[string]any{
		"stream_name": "ORDERS", "name": "DASHBOARD",
		"config":      map[string]any{"filter_subject": "orders.>", "ack_policy": "explicit"},
		"delivered":   map[string]any{"consumer_seq": 2, "stream_seq": 2},
		"ack_floor":   map[string]any{"consumer_seq": 1, "stream_seq": 1},
		"num_pending": 1, "num_ack_pending": 1, "num_redelivered": 0,
	}
	var response any
	switch subject {
	case "$JS.API.INFO":
		response = map[string]any{"memory": 1, "storage": 4, "streams": 1, "consumers": 1, "limits": map[string]any{}}
	case "$JS.API.STREAM.LIST":
		response = map[string]any{"total": 1, "offset": 0, "limit": 1024, "streams": []any{stream}}
	case "$JS.API.STREAM.INFO.ORDERS":
		response = stream
	case "$JS.API.CONSUMER.LIST.ORDERS":
		response = map[string]any{"total": 1, "offset": 0, "limit": 1024, "consumers": []any{consumer}}
	case "$JS.API.CONSUMER.INFO.ORDERS.DASHBOARD":
		response = consumer
	case "$JS.API.STREAM.MSG.GET.ORDERS":
		var getRequest struct {
			Sequence uint64 `json:"seq"`
		}
		if err := json.Unmarshal(request, &getRequest); err != nil {
			return nil, err
		}
		response = map[string]any{
			"message": map[string]any{
				"subject": "orders.created", "seq": getRequest.Sequence, "data": []byte("ok"), "time": "2026-08-14T00:00:00Z",
			},
		}
	default:
		return nil, fmt.Errorf("unexpected JetStream API subject %s", subject)
	}
	return json.Marshal(response)
}

func writeFakeMessage(writer io.Writer, subject, sid string, payload []byte) error {
	_, err := fmt.Fprintf(writer, "MSG %s %s %d\r\n%s\r\n", subject, sid, len(payload), payload)
	return err
}

func readNATSPayload(reader *bufio.Reader, fields []string) ([]byte, error) {
	if len(fields) == 0 {
		return nil, nil
	}
	payloadBytes, err := strconv.Atoi(fields[len(fields)-1])
	if err != nil || payloadBytes < 0 {
		return nil, errors.New("invalid NATS payload length")
	}
	data := make([]byte, payloadBytes+2)
	if _, err := io.ReadFull(reader, data); err != nil {
		return nil, err
	}
	if !bytes.HasSuffix(data, []byte("\r\n")) {
		return nil, errors.New("invalid NATS payload terminator")
	}
	return data[:payloadBytes], nil
}
