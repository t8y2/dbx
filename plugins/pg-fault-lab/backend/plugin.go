package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"

	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/control"
	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/faultproxy"
)

type lifecycle struct {
	Connection struct {
		ReadOnly  bool              `json:"read_only"`
		ID        string            `json:"id"`
		Host      string            `json:"host"`
		Port      int               `json:"port"`
		Transport []json.RawMessage `json:"transport_layers"`
		Config    struct {
			ProxyPort  int  `json:"proxy_port"`
			Allow      bool `json:"allow_injection"`
			Disposable bool `json:"disposable_lab"`
		} `json:"external_config"`
	} `json:"connection"`
	Runtime struct {
		Host  string          `json:"host"`
		Port  int             `json:"port"`
		Proxy json.RawMessage `json:"proxy"`
	} `json:"runtime"`
}

func (l lifecycle) config() (faultproxy.Config, error) {
	c := l.Connection
	if c.ID == "" || len(c.ID) > 256 {
		return faultproxy.Config{}, errors.New("connection id required")
	}
	if len(c.Transport) > 0 || len(l.Runtime.Proxy) > 0 && string(l.Runtime.Proxy) != "null" {
		return faultproxy.Config{}, errors.New("tunnels and transport routes are disabled in the loopback lab")
	}
	if l.Runtime.Host != "" && (l.Runtime.Host != c.Host || l.Runtime.Port != c.Port) {
		return faultproxy.Config{}, errors.New("runtime endpoint must match the synthetic loopback endpoint")
	}
	proxyPort := c.Config.ProxyPort
	if proxyPort == 0 {
		proxyPort = 55433
	}
	return faultproxy.Config{Upstream: net.JoinHostPort(c.Host, strconv.Itoa(c.Port)), Listen: net.JoinHostPort("127.0.0.1", strconv.Itoa(proxyPort)), DisposableLab: c.Config.Disposable, AllowInjection: c.Config.Allow && !c.ReadOnly}, nil
}

type plugin struct {
	mu        sync.Mutex
	instances map[string]*control.Instance
}

func newPlugin() *plugin { return &plugin{instances: map[string]*control.Instance{}} }
func (p *plugin) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, i := range p.instances {
		i.Close()
	}
	p.instances = map[string]*control.Instance{}
}
func (p *plugin) Handle(_ sdk.RequestContext, method string, raw json.RawMessage, _ *sdk.Emitter) (any, *sdk.PluginError) {
	result, err := p.handle(method, raw)
	if err != nil {
		return nil, sdk.NewError(-32602, err.Error())
	}
	return result, nil
}
func (p *plugin) handle(method string, raw json.RawMessage) (any, error) {
	p.mu.Lock()
	defer p.mu.Unlock() // Lifecycle, tools and controls share the same scope registry.
	switch method {
	case "connection/connect", "connection/test", "connection/disconnect":
		var l lifecycle
		if err := json.Unmarshal(raw, &l); err != nil {
			return nil, errors.New("invalid lifecycle payload")
		}
		if method == "connection/disconnect" {
			if i := p.instances[l.Connection.ID]; i != nil {
				i.Close()
				delete(p.instances, l.Connection.ID)
			}
			return map[string]any{"success": true}, nil
		}
		cfg, err := l.config()
		if err != nil {
			return nil, err
		}
		if method == "connection/test" {
			_, err = faultproxy.New(cfg)
			if err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "message": "Configuration valid; no database connection or listener was opened"}, nil
		}
		if _, ok := p.instances[l.Connection.ID]; ok {
			return nil, errors.New("already connected; disconnect before changing settings")
		}
		if len(p.instances) >= 4 {
			return nil, errors.New("four lab instances maximum")
		}
		i, err := control.Start(cfg)
		if err != nil {
			return nil, err
		}
		p.instances[l.Connection.ID] = i
		return map[string]any{"success": true, "address": i.Server.Addr(), "observe": i.Observe, "inject": i.Inject}, nil
	case "mcp/tools":
		var a struct {
			ConnectionID string `json:"connectionId"`
		}
		if json.Unmarshal(raw, &a) != nil {
			return nil, errors.New("invalid tool discovery")
		}
		// External dbx-mcp discovers the schema before it has a bound connection.
		// Discovery must never start a proxy or expose ephemeral capabilities.
		if a.ConnectionID == "" {
			return externalToolList(), nil
		}
		i := p.instances[a.ConnectionID]
		if i == nil {
			return nil, errors.New("open the bound lab connection first")
		}
		return toolList(i.Server.Snapshot().AllowInjection), nil
	case "mcp/call":
		var a struct {
			Tool      string          `json:"tool"`
			Arguments json.RawMessage `json:"arguments"`
			Lifecycle lifecycle       `json:"lifecycle"`
		}
		if json.Unmarshal(raw, &a) != nil {
			return nil, errors.New("invalid tool call")
		}
		var params struct {
			ConnectionID string          `json:"connectionId"`
			Rule         faultproxy.Rule `json:"rule"`
			ID           string          `json:"id"`
		}
		if json.Unmarshal(a.Arguments, &params) != nil {
			return nil, errors.New("invalid tool arguments")
		}

		id := a.Lifecycle.Connection.ID
		if id == "" || params.ConnectionID != "" && params.ConnectionID != id {
			return nil, errors.New("tool must use its host-bound connection")
		}
		if a.Lifecycle.Connection.ReadOnly && a.Tool != "lab_snapshot" {
			return toolResult("saved connection is read-only", true), nil
		}
		if a.Tool != "lab_start" && a.Tool != "lab_stop" && a.Tool != "lab_snapshot" && !a.Lifecycle.Connection.Config.Allow {
			return toolResult("saved connection has disabled fault injection", true), nil
		}
		i := p.instances[id]
		if a.Tool == "lab_start" {
			cfg, err := a.Lifecycle.config()
			if err != nil {
				return toolResult(err.Error(), true), nil
			}
			if i != nil && i.Config != cfg {
				return toolResult("saved connection settings changed; stop and restart the lab", true), nil
			}
			if i == nil {
				if len(p.instances) >= 4 {
					return toolResult("four lab instances maximum", true), nil
				}
				i, err = control.Start(cfg)
				if err != nil {
					return toolResult(err.Error(), true), nil
				}
				p.instances[id] = i
			}
			data, _ := json.Marshal(map[string]any{"connected": true, "address": i.Server.Addr(), "allowInjection": i.Server.Snapshot().AllowInjection})
			return toolResult(string(data), false), nil
		}
		if a.Tool == "lab_stop" {
			if i != nil {
				i.Close()
				delete(p.instances, id)
			}
			return toolResult(`{"connected":false}`, false), nil
		}
		if i == nil {
			return toolResult("lab is not running; call lab_start (write permission required) or connect it in DBX", true), nil
		}
		action := strings.TrimPrefix(a.Tool, "lab_")
		result, err := control.Dispatch(i.Server, control.Request{Method: action, Rule: params.Rule, ID: params.ID}, i.Server.Snapshot().AllowInjection)
		if err != nil {
			return toolResult(err.Error(), true), nil
		}
		data, _ := json.Marshal(result)
		return toolResult(string(data), false), nil
	default:
		if !strings.HasPrefix(method, "lab/") {
			return nil, errors.New("unknown plugin method")
		}
		var a struct {
			ConnectionID string          `json:"connectionId"`
			Rule         faultproxy.Rule `json:"rule"`
			ID           string          `json:"id"`
		}
		if json.Unmarshal(raw, &a) != nil {
			return nil, errors.New("invalid control arguments")
		}
		i := p.instances[a.ConnectionID]
		if i == nil {
			return nil, errors.New("open this lab connection first")
		}
		action := strings.TrimPrefix(method, "lab/")
		if action == "cli_endpoints" {
			return map[string]any{"observe": i.Observe, "inject": i.Inject}, nil
		}
		result, err := control.Dispatch(i.Server, control.Request{Method: action, Rule: a.Rule, ID: a.ID}, i.Server.Snapshot().AllowInjection)
		if err == nil && action == "snapshot" {
			return map[string]any{"snapshot": result, "observeAddress": i.Observe.Address}, nil
		}
		return result, err
	}
}
func toolResult(text string, failed bool) any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "isError": failed}
}
func toolList(inject bool) any {
	methods := []string{"snapshot"}
	if inject {
		methods = append(methods, "add_rule", "delete_rule", "resume", "abort")
	}
	out := []any{}
	str := func(description string) any { return map[string]any{"type": "string", "description": description} }
	for _, m := range methods {
		props := map[string]any{"connectionId": str("Host-bound open fault lab connection")}
		required := []string{"connectionId"}
		if m == "add_rule" {
			selector := map[string]any{}
			for _, k := range []string{"application", "database", "user", "connectionId", "sqlHash", "command"} {
				selector[k] = str("Exact match; no raw SQL or parameter values")
			}
			props["rule"] = map[string]any{"type": "object", "properties": map[string]any{"selector": map[string]any{"type": "object", "properties": selector}, "phase": map[string]any{"type": "string", "enum": []string{"execute", "commit", "connect"}}, "action": map[string]any{"type": "string", "enum": []string{"pause", "abort", "drop"}}, "hits": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}, "ttlMs": map[string]any{"type": "integer", "minimum": 10, "maximum": 300000}}, "required": []string{"selector", "phase", "action", "hits", "ttlMs"}}
			required = append(required, "rule")
		} else if m != "snapshot" {
			props["id"] = str("Exact rule or pause id from snapshot")
			required = append(required, "id")
		}
		out = append(out, map[string]any{"name": "lab_" + m, "description": fmt.Sprintf("%s in the disposable PostgreSQL lab; abort closes both connections before forwarding", m), "inputSchema": map[string]any{"type": "object", "properties": props, "required": required}, "annotations": map[string]any{"readOnlyHint": m == "snapshot", "destructiveHint": m != "snapshot", "openWorldHint": false}})
	}
	return map[string]any{"tools": out}
}

// Connection-less discovery includes explicitly mutating lifecycle tools. Saved
// read-only policy and this plugin's immutable injection opt-in apply at call time.
func externalToolList() any {
	result := toolList(true).(map[string]any)
	list := result["tools"].([]any)
	for _, action := range []string{"start", "stop"} {
		list = append(list, map[string]any{"name": "lab_" + action, "description": action + " the saved disposable loopback fault lab; changes listener lifecycle", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"connectionId": map[string]any{"type": "string", "description": "Host-bound saved lab connection"}}, "required": []string{"connectionId"}}, "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}})
	}
	result["tools"] = list
	return result
}
