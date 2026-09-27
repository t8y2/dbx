package dbxpluginsdk

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type binaryTestHandler struct {
	HandlerFunc
	channel string
	data    []byte
}

func (handler *binaryTestHandler) HandleBinary(channel string, data []byte, _ *Emitter) *PluginError {
	handler.channel = channel
	handler.data = append(handler.data, data...)
	return nil
}

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

func TestFramedServerDispatchesBinaryInput(t *testing.T) {
	input := &bytes.Buffer{}
	writeFrame := func(kind byte, payload []byte) {
		input.WriteByte(kind)
		_ = binary.Write(input, binary.BigEndian, uint32(len(payload)))
		input.Write(payload)
	}
	initialize, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "plugin/initialize", "params": map[string]any{"host": map[string]any{"protocolVersions": []int{1}}}})
	writeFrame(frameKindJSON, initialize)
	channel := []byte("sample.upload")
	binaryPayload := make([]byte, 2+len(channel)+3)
	binary.BigEndian.PutUint16(binaryPayload[:2], uint16(len(channel)))
	copy(binaryPayload[2:], channel)
	copy(binaryPayload[2+len(channel):], []byte("abc"))
	writeFrame(frameKindBinary, binaryPayload)
	var output bytes.Buffer
	handler := &binaryTestHandler{HandlerFunc: HandlerFunc(func(_ RequestContext, _ string, _ json.RawMessage, _ *Emitter) (any, *PluginError) {
		return nil, nil
	})}
	server := NewServer(Metadata{ID: "sample.plugin", Version: "1.0.0"}, handler).
		WithTransport(TransportFramed).
		WithIO(input, &output, &bytes.Buffer{})
	if err := server.Serve(); err != nil {
		t.Fatal(err)
	}
	if handler.channel != "sample.upload" || string(handler.data) != "abc" {
		t.Fatalf("unexpected binary callback: channel=%q data=%q", handler.channel, handler.data)
	}
	if output.Len() == 0 {
		t.Fatal("expected framed initialize response")
	}
}

func TestDataDirHelpers(t *testing.T) {
	t.Setenv(DataDirEnvVar, "")
	if DataDir() != "" {
		t.Fatal("expected empty data dir without host environment")
	}
	if _, err := EnsureDataDir(); err == nil {
		t.Fatal("expected an error without host environment")
	}

	dir := t.TempDir()
	t.Setenv(DataDirEnvVar, dir)
	if DataDir() != dir {
		t.Fatalf("unexpected data dir: %q", DataDir())
	}
	if _, err := EnsureDataDir(); err != nil {
		t.Fatal(err)
	}
	deep := filepath.Join(dir, "nested", "state")
	t.Setenv(DataDirEnvVar, deep)
	created, err := EnsureDataDir()
	if err != nil {
		t.Fatal(err)
	}
	if created != deep {
		t.Fatalf("unexpected created dir: %q", created)
	}
	if info, err := os.Stat(deep); err != nil || !info.IsDir() {
		t.Fatalf("expected created directory: %v %v", info, err)
	}
}
