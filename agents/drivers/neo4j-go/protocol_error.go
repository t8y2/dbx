package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"

	neo4j "github.com/neo4j/neo4j-go-driver/v6/neo4j"
	neo4jdb "github.com/neo4j/neo4j-go-driver/v6/neo4j/db"
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
	SQLState           string `json:"sqlState,omitempty"`
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
		ExceptionClass:     safeRPCDiagnostic(fmt.Sprintf("%T", err), 160),
		AgentSessionID:     strings.TrimSpace(agentSessionID),
	}

	var databaseError *neo4jdb.Neo4jError
	if errors.As(err, &databaseError) {
		data.SQLState = safeRPCDiagnostic(databaseError.Code, 160)
		data.Retryable = neo4j.IsRetryable(err)
		code := strings.ToLower(databaseError.Code)
		switch {
		case strings.Contains(code, ".security."):
			data.Category = "connection"
			data.Retryable = stage == "connect" || stage == "validate"
		case strings.Contains(code, ".transienterror."), strings.Contains(code, "databaseunavailable"):
			data.Category = "resource"
			data.Retryable = true
		case strings.Contains(code, ".statement."), strings.Contains(code, ".schema."), strings.Contains(code, ".procedure."):
			data.Category = "sql"
		default:
			data.Category = "sql"
		}
	} else if errors.Is(err, context.Canceled) {
		data.Category = "canceled"
		data.SessionDisposition = "quarantine"
	} else if errors.Is(err, context.DeadlineExceeded) || isTimeoutError(err) {
		data.Category = "timeout"
		data.SessionDisposition = "quarantine"
	} else if isConnectionError(err) {
		data.Category = "connection"
		data.Retryable = stage == "connect" || stage == "validate"
		if stage != "connect" {
			data.SessionDisposition = "quarantine"
		}
	}

	return &rpcError{Code: -1, Message: err.Error(), Data: data}
}

func rpcErrorStage(method string) string {
	switch method {
	case "connect", "open_session", "test_connection":
		return "connect"
	case "validate_connection", "validate_session":
		return "validate"
	case "cancel_session":
		return "cancel"
	case "close_session", "disconnect", "close_query_session", "close_table_read_session", "shutdown":
		return "close"
	case "fetch_query_page", "fetch_table_read_page":
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
		"connection refused", "connection reset", "broken pipe", "connection closed", "connection lost",
		"unexpected eof", "no route to host", "no servers available", "routing table",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
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
