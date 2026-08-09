package dbxpluginsdk

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
)

func TestServerInitializesAndDispatches(t *testing.T) {
	input := bytes.NewBufferString(
		"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"plugin/initialize\",\"params\":{\"host\":{\"protocolVersions\":[1]}}}\n" +
			"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"sample/ping\",\"params\":{\"name\":\"DBX\"}}\n",
	)
	var output bytes.Buffer
	server := NewServer(
		Metadata{ID: "sample.plugin", Version: "1.0.0", Capabilities: []string{"commands"}},
		HandlerFunc(func(_ RequestContext, method string, _ json.RawMessage, _ *Emitter) (any, *PluginError) {
			if method != "sample/ping" {
				return nil, MethodNotFound(method)
			}
			return map[string]any{"ok": true}, nil
		}),
	).WithIO(input, &output, &bytes.Buffer{})
	if err := server.Serve(); err != nil {
		t.Fatal(err)
	}
	var responses []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'}) {
		var response map[string]any
		if err := json.Unmarshal(line, &response); err != nil {
			t.Fatal(err)
		}
		responses = append(responses, response)
	}
	if len(responses) != 2 {
		t.Fatalf("expected 2 responses, got %d", len(responses))
	}
	initialize := responses[0]["result"].(map[string]any)
	if initialize["protocolVersion"] != float64(ProtocolVersion) {
		t.Fatalf("unexpected initialize response: %#v", initialize)
	}
	pong := responses[1]["result"].(map[string]any)
	if pong["ok"] != true {
		t.Fatalf("unexpected handler response: %#v", pong)
	}
}

func TestEmitterWritesEvents(t *testing.T) {
	var output bytes.Buffer
	emitter := &Emitter{writer: &output, mutex: &sync.Mutex{}}
	if pluginError := emitter.Event("sample/progress", map[string]any{"value": 1}); pluginError != nil {
		t.Fatal(pluginError.Message)
	}
	var event map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &event); err != nil {
		t.Fatal(err)
	}
	if event["method"] != "sample/progress" {
		t.Fatalf("unexpected event: %#v", event)
	}
}
