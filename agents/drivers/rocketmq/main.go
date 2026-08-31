package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

const maxRPCMessageBytes = 32 * 1024 * 1024

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
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

func main() {
	agent := newRocketMQAgent()
	defer agent.close()

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(map[string]bool{"ready": true})

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), maxRPCMessageBytes)
	for scanner.Scan() {
		var request rpcRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			_ = encoder.Encode(rpcResponse{
				JSONRPC: "2.0",
				ID:      json.RawMessage("null"),
				Error:   &rpcError{Code: -32700, Message: normalizeError(err)},
			})
			continue
		}

		result, err := agent.dispatch(request.Method, request.Params)
		response := rpcResponse{JSONRPC: "2.0", ID: request.ID}
		if len(response.ID) == 0 {
			response.ID = json.RawMessage("null")
		}
		if err != nil {
			response.Error = &rpcError{Code: -1, Message: normalizeError(err)}
		} else {
			response.Result = result
		}
		if err := encoder.Encode(response); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		if agent.shutdownRequested {
			return
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}
