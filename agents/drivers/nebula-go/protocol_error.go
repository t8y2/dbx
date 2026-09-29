package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
)

type rpcError struct {
	Code    int           `json:"code"`
	Message string        `json:"message"`
	Data    *rpcErrorData `json:"data"`
}

type rpcErrorData struct {
	ContractVersion    int    `json:"contractVersion"`
	Category           string `json:"category"`
	Retryable          bool   `json:"retryable"`
	SessionDisposition string `json:"sessionDisposition"`
	Stage              string `json:"stage"`
	OperationOutcome   string `json:"operationOutcome"`
	AgentSessionID     string `json:"agentSessionId,omitempty"`
}

func errorResponse(id json.RawMessage, method, sessionID string, err error) response {
	stage := errorStage(method)
	data := &rpcErrorData{
		ContractVersion: 1, Category: "protocol", SessionDisposition: "keep",
		Stage: stage, OperationOutcome: errorOutcome(stage), AgentSessionID: strings.TrimSpace(sessionID),
	}
	var queryError *nebulaQueryError
	if errors.As(err, &queryError) {
		if stage == "execute" || stage == "fetch" {
			data.Category = "sql"
		} else {
			data.Category = "connection"
		}
	} else if errors.Is(err, io.EOF) || isNetworkError(err) {
		data.Category = "connection"
		data.Retryable = stage == "connect" || stage == "validate"
		if stage == "execute" || stage == "fetch" {
			data.SessionDisposition = "quarantine"
		}
	}
	return response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -1, Message: err.Error(), Data: data}}
}

func errorStage(method string) string {
	switch method {
	case "open_session", "connect", "test_connection":
		return "connect"
	case "validate_session", "validate_connection":
		return "validate"
	case "fetch_query_page", "fetch_table_read_page":
		return "fetch"
	case "cancel_session":
		return "cancel"
	case "close_session", "disconnect", "close_query_session", "close_table_read_session", "shutdown":
		return "close"
	case "handshake", "":
		return "request"
	default:
		return "execute"
	}
}

func errorOutcome(stage string) string {
	if stage == "request" || stage == "connect" || stage == "validate" {
		return "not_started"
	}
	return "unknown"
}

func isNetworkError(err error) bool {
	var networkError net.Error
	return errors.As(err, &networkError)
}
