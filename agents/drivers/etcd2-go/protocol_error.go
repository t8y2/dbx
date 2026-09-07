package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
)

type rpcError struct {
	Code    int           `json:"code"`
	Message string        `json:"message"`
	Data    *rpcErrorData `json:"data,omitempty"`
}

type rpcErrorData struct {
	Category           string `json:"category"`
	Retryable          bool   `json:"retryable"`
	SessionDisposition string `json:"sessionDisposition"`
	Stage              string `json:"stage"`
	ContractVersion    int    `json:"contractVersion"`
	OperationOutcome   string `json:"operationOutcome"`
	ExceptionClass     string `json:"exceptionClass,omitempty"`
	AgentSessionID     string `json:"agentSessionId,omitempty"`
}

func errorResponse(id json.RawMessage, method, agentSessionID string, err error) response {
	return response{JSONRPC: "2.0", ID: id, Error: classifyRPCError(method, agentSessionID, err)}
}

func classifyRPCError(method, agentSessionID string, err error) *rpcError {
	stage := rpcErrorStage(method)
	data := &rpcErrorData{
		Category:           "protocol",
		Retryable:          false,
		SessionDisposition: "keep",
		Stage:              stage,
		ContractVersion:    1,
		OperationOutcome:   rpcOperationOutcome(stage),
		ExceptionClass:     safeRPCDiagnostic(errTypeName(err), 160),
		AgentSessionID:     strings.TrimSpace(agentSessionID),
	}

	switch {
	case errors.Is(err, context.Canceled):
		data.Category = "canceled"
		data.SessionDisposition = "quarantine"
	case errors.Is(err, context.DeadlineExceeded) || isTimeoutError(err):
		data.Category = "timeout"
		data.SessionDisposition = "quarantine"
	case isConnectionError(err):
		data.Category = "connection"
		data.Retryable = stage == "connect" || stage == "validate"
		if stage != "connect" {
			data.SessionDisposition = "quarantine"
		}
	}

	return &rpcError{Code: -1, Message: err.Error(), Data: data}
}

func isConnectionError(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	var networkError *net.OpError
	if errors.As(err, &networkError) {
		return true
	}
	lower := strings.ToLower(err.Error())
	for _, marker := range []string{
		"connection refused", "connection reset", "broken pipe", "connection closed",
		"connection lost", "unexpected eof", "no route to host", "etcd connection error",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func errTypeName(err error) string {
	if err == nil {
		return ""
	}
	return strings.ReplaceAll(strings.TrimSpace(err.Error()), "\n", " ")
}

func rpcErrorStage(method string) string {
	switch method {
	case "connect", "open_session", "test_connection":
		return "connect"
	case "validate_connection", "validate_session":
		return "validate"
	case "cancel_session":
		return "cancel"
	case "close_session", "disconnect", "shutdown":
		return "close"
	case "etcd_watch_poll":
		return "fetch"
	case "handshake", "":
		return "request"
	default:
		return "execute"
	}
}

func rpcOperationOutcome(stage string) string {
	switch stage {
	case "request", "connect", "validate":
		return "not_started"
	default:
		return "unknown"
	}
}

func isTimeoutError(err error) bool {
	var timeout interface{ Timeout() bool }
	return errors.As(err, &timeout) && timeout.Timeout()
}

func safeRPCDiagnostic(value string, maxLength int) string {
	var result strings.Builder
	for _, char := range value {
		if result.Len() >= maxLength {
			break
		}
		if char >= 0x21 && char <= 0x7e {
			result.WriteRune(char)
		}
	}
	return result.String()
}
