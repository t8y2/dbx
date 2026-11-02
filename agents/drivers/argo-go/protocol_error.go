package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"

	"github.com/t8y2/dbx/agents/go-common/gohive"
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
	VendorCode         int32  `json:"vendorCode,omitempty"`
	ExceptionClass     string `json:"exceptionClass,omitempty"`
	AgentSessionID     string `json:"agentSessionId,omitempty"`
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

	var hiveError *gohive.Error
	if errors.As(err, &hiveError) {
		data.Category = "sql"
		data.SQLState = safeRPCDiagnostic(hiveError.SQLState, 160)
		data.VendorCode = int32(hiveError.ErrorCode)
		data.ExceptionClass = "gohive.Error"
	} else if errors.Is(err, context.Canceled) {
		data.Category = "canceled"
		data.SessionDisposition = "quarantine"
	} else if errors.Is(err, context.DeadlineExceeded) || isTimeoutError(err) {
		data.Category = "timeout"
		data.Retryable = stage == "connect" || stage == "validate"
		data.SessionDisposition = "quarantine"
	} else if isConnectionError(err) {
		data.Category = "connection"
		data.Retryable = stage == "connect" || stage == "validate"
		if stage != "connect" {
			data.SessionDisposition = "quarantine"
		}
	} else if isHiveSQLError(err) {
		data.Category = "sql"
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
	if stage == "request" || stage == "connect" || stage == "validate" {
		return "not_started"
	}
	return "unknown"
}

func isTimeoutError(err error) bool {
	var timeout interface{ Timeout() bool }
	return errors.As(err, &timeout) && timeout.Timeout()
}

func isConnectionError(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) || errors.Is(err, sql.ErrConnDone) {
		return true
	}
	var networkError *net.OpError
	if errors.As(err, &networkError) {
		return true
	}
	lower := strings.ToLower(err.Error())
	for _, marker := range []string{
		"connection refused", "connection reset", "broken pipe", "connection closed", "connection lost",
		"unexpected eof", "no route to host", "all hiveserver2 endpoints failed", "transport is not open",
		"socket is closed", "not open",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func isHiveSQLError(err error) bool {
	lower := strings.ToLower(err.Error())
	for _, marker := range []string{"semanticexception", "parseexception", "hive error", "sqlstate", "error while compiling statement"} {
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
