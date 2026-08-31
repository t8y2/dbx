package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

const (
	protocolVersion      = 1
	agentProtocolVersion = 1
	maxRPCMessageBytes   = 32 * 1024 * 1024
)

var capabilities = []string{"connect", "test_connection", "connection_info", "kv"}

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

type server struct {
	activeClient          znodeClient
	activeConfig          connectionConfig
	statLookupConcurrency int
}

func main() {
	service := newServer()
	defer service.closeClient()

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	fmt.Fprintln(os.Stdout, `{"ready":true}`)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), maxRPCMessageBytes)
	for scanner.Scan() {
		response, shutdown := service.handleRequest(scanner.Bytes())
		if err := encoder.Encode(response); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		if shutdown {
			return
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}

func newServer() *server {
	return &server{statLookupConcurrency: configuredStatLookupConcurrency(os.Getenv(statLookupConcurrencyEnv))}
}

func (service *server) handleRequest(payload []byte) (rpcResponse, bool) {
	var request rpcRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: -1, Message: err.Error()}}, false
	}

	result, shutdown, err := service.dispatch(request.Method, request.Params)
	if err != nil {
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      request.ID,
			Error:   &rpcError{Code: -1, Message: err.Error()},
		}, false
	}
	return rpcResponse{JSONRPC: "2.0", ID: request.ID, Result: result}, shutdown
}

func (service *server) dispatch(method string, params json.RawMessage) (any, bool, error) {
	switch method {
	case "handshake":
		return handshakeResult{
			ProtocolVersion:      protocolVersion,
			AgentProtocolVersion: agentProtocolVersion,
			Capabilities:         capabilities,
		}, false, nil
	case "connect":
		result, err := service.connect(params)
		return result, false, err
	case "test_connection":
		result, err := service.testConnection(params)
		return result, false, err
	case "connection_info":
		result, err := service.connectionInfo()
		return result, false, err
	case "kv_list_prefix":
		result, err := service.listPrefix(params)
		return result, false, err
	case "kv_get":
		result, err := service.get(params)
		return result, false, err
	case "kv_put":
		result, err := service.put(params)
		return result, false, err
	case "kv_delete":
		result, err := service.delete(params)
		return result, false, err
	case "disconnect":
		service.closeClient()
		return map[string]bool{"ok": true}, false, nil
	case "shutdown":
		service.closeClient()
		return map[string]bool{"ok": true}, true, nil
	default:
		return nil, false, fmt.Errorf("Unknown method: %s", method)
	}
}
