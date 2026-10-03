package main

import (
	"encoding/json"
	"net"
	"strconv"
	"strings"
	"testing"
)

func raw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func lifecycleFixture(t *testing.T, id string, inject bool) map[string]any {
	t.Helper()
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	_, p, _ := net.SplitHostPort(l.Addr().String())
	port, _ := strconv.Atoi(p)
	l.Close()
	return map[string]any{"connection": map[string]any{"id": id, "host": "127.0.0.1", "port": 55432, "external_config": map[string]any{"proxy_port": port, "disposable_lab": true, "allow_injection": inject}}}
}
func TestPluginLifecycleMCPAuthorization(t *testing.T) {
	p := newPlugin()
	defer p.close()
	l := lifecycleFixture(t, "one", false)
	if _, e := p.handle("connection/test", raw(l)); e != nil {
		t.Fatal(e)
	}
	if len(p.instances) != 0 {
		t.Fatal("test started server")
	}
	if _, e := p.handle("connection/connect", raw(l)); e != nil {
		t.Fatal(e)
	}
	list, e := p.handle("mcp/tools", raw(map[string]any{"connectionId": "one"}))
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(list)
	if strings.Contains(string(b), "lab_add_rule") {
		t.Fatal("mutation tools exposed in observe-only")
	}
	if _, e = p.handle("mcp/call", raw(map[string]any{"tool": "lab_snapshot", "arguments": map[string]any{"connectionId": "other"}, "lifecycle": l})); e == nil {
		t.Fatal("spoofed connection id allowed")
	}
	if _, e = p.handle("mcp/call", raw(map[string]any{"tool": "lab_snapshot", "arguments": map[string]any{}})); e == nil {
		t.Fatal("unbound call allowed")
	}
	result, e := p.handle("mcp/call", raw(map[string]any{"tool": "lab_add_rule", "arguments": map[string]any{}, "lifecycle": l}))
	if e != nil {
		t.Fatal(e)
	}
	b, _ = json.Marshal(result)
	if !strings.Contains(string(b), `"isError":true`) {
		t.Fatal("MCP observe mutation allowed")
	}
	if _, e = p.handle("connection/disconnect", raw(l)); e != nil {
		t.Fatal(e)
	}
	if len(p.instances) != 0 {
		t.Fatal("disconnect retained instance")
	}
}
func TestPluginInjectionToolsAndRedaction(t *testing.T) {
	p := newPlugin()
	defer p.close()
	l := lifecycleFixture(t, "two", true)
	if _, e := p.handle("connection/connect", raw(l)); e != nil {
		t.Fatal(e)
	}
	list, e := p.handle("mcp/tools", raw(map[string]any{"connectionId": "two"}))
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(list)
	if !strings.Contains(string(b), "lab_add_rule") || !strings.Contains(string(b), `"readOnlyHint":false`) {
		t.Fatal("missing mutation annotation")
	}
	result, e := p.handle("lab/snapshot", raw(map[string]any{"connectionId": "two"}))
	if e != nil {
		t.Fatal(e)
	}
	b, _ = json.Marshal(result)
	if strings.Contains(string(b), "capability") {
		t.Fatal("capability leaked")
	}
}
func TestPluginRejectsTunnels(t *testing.T) {
	p := newPlugin()
	defer p.close()
	l := lifecycleFixture(t, "tunnel", true)
	l["runtime"] = map[string]any{"host": "127.0.0.1", "port": 11111}
	if _, e := p.handle("connection/connect", raw(l)); e == nil {
		t.Fatal("tunnel runtime accepted")
	}
}

func TestExternalMCPDiscoveryAndExplicitLifecycle(t *testing.T) {
	p := newPlugin()
	defer p.close()
	result, e := p.handle("mcp/tools", raw(map[string]any{}))
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(result)
	if !strings.Contains(string(b), "lab_start") || !strings.Contains(string(b), "lab_stop") {
		t.Fatal("external lifecycle tools absent")
	}
	if len(p.instances) != 0 {
		t.Fatal("discovery opened listener")
	}
	l := lifecycleFixture(t, "external", true)
	call := func(tool string) any {
		r, e := p.handle("mcp/call", raw(map[string]any{"tool": tool, "arguments": map[string]any{}, "lifecycle": l}))
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	b, _ = json.Marshal(call("lab_snapshot"))
	if !strings.Contains(string(b), `"isError":true`) || len(p.instances) != 0 {
		t.Fatal("read-only snapshot started proxy")
	}
	b, _ = json.Marshal(call("lab_start"))
	if strings.Contains(string(b), `"isError":true`) || len(p.instances) != 1 {
		t.Fatal("explicit start failed", string(b))
	}
	call("lab_start")
	if len(p.instances) != 1 {
		t.Fatal("start not idempotent")
	}
	call("lab_stop")
	if len(p.instances) != 0 {
		t.Fatal("external stop retained instance")
	}
}

func TestExternalMCPSavedPolicy(t *testing.T) {
	p := newPlugin()
	defer p.close()
	l := lifecycleFixture(t, "saved-policy", true)
	l["connection"].(map[string]any)["read_only"] = true
	r, e := p.handle("mcp/call", raw(map[string]any{"tool": "lab_start", "arguments": map[string]any{}, "lifecycle": l}))
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(r)
	if !strings.Contains(string(b), `"isError":true`) || len(p.instances) != 0 {
		t.Fatal("saved read-only policy bypassed")
	}
}
