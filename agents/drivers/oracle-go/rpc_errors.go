package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"

	"github.com/sijms/go-ora/v2/network"
)

// The shared structured_error_v1 contract, also consumed by ordinary query callers.
type rpcErrorData struct {
	ContractVersion    int    `json:"contractVersion"`
	Category           string `json:"category"`
	Retryable          bool   `json:"retryable"`
	SessionDisposition string `json:"sessionDisposition"`
	Stage              string `json:"stage"`
	OperationOutcome   string `json:"operationOutcome"`
	VendorCode         *int   `json:"vendorCode,omitempty"`
	ExceptionClass     string `json:"exceptionClass,omitempty"`
	AgentSessionID     string `json:"agentSessionId,omitempty"`
}

func oracleVendorCode(err error) *int {
	var thin *network.OracleError
	if errors.As(err, &thin) {
		code := thin.ErrCode
		return &code
	}
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		code := coded.Code()
		return &code
	}
	return nil
}

func oracleRPCStage(method string) string {
	switch method {
	case "", "handshake":
		return "request"
	case "connect", "open_session", "test_connection":
		return "connect"
	case "validate_connection", "validate_session":
		return "validate"
	case "cancel_session":
		return "cancel"
	case "close_session", "disconnect", "shutdown", "close_query_session", "close_table_read_session":
		return "close"
	case "fetch_query_page", "fetch_table_read_page":
		return "fetch"
	default:
		return "execute"
	}
}

func oracleConnectionCode(code int) bool {
	switch code {
	case 28, 1012, 3113, 3114, 3135:
		return true
	default:
		return code >= 12500 && code <= 12699
	}
}

func errorResponse(id json.RawMessage, err error, method, sessionID string) response {
	var native *plDebugNativeError
	if errors.As(err, &native) {
		category, stage := native.category, native.stage
		if category == "" {
			category = "sql"
		}
		if stage == "" {
			stage = "execute"
		}
		disposition := "keep"
		if category == "timeout" || category == "canceled" {
			disposition = "quarantine"
		}
		data := &rpcErrorData{ContractVersion: 1, Category: category, Retryable: false, SessionDisposition: disposition,
			Stage: stage, OperationOutcome: native.outcome, AgentSessionID: native.agentSessionID}
		return response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -1, Message: err.Error(), Data: data}}
	}
	stage := oracleRPCStage(method)
	data := &rpcErrorData{ContractVersion: 1, Category: "protocol", SessionDisposition: "keep", Stage: stage,
		OperationOutcome: "unknown", VendorCode: oracleVendorCode(err), ExceptionClass: fmt.Sprintf("%T", err), AgentSessionID: sessionID}
	if stage == "request" || stage == "connect" || stage == "validate" {
		data.OperationOutcome = "not_started"
	}
	var netError net.Error
	switch {
	case errors.Is(err, context.Canceled) || data.VendorCode != nil && *data.VendorCode == 1013:
		data.Category, data.SessionDisposition = "canceled", "quarantine"
	case errors.Is(err, context.DeadlineExceeded) || errors.As(err, &netError) && netError.Timeout():
		data.Category, data.SessionDisposition = "timeout", "quarantine"
	case errors.Is(err, driver.ErrBadConn) || errors.Is(err, sql.ErrConnDone) || errors.Is(err, net.ErrClosed) ||
		errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &netError) ||
		data.VendorCode != nil && (oracleConnectionCode(*data.VendorCode) || stage == "connect" || stage == "validate"):
		data.Category = "connection"
		if stage != "connect" {
			data.SessionDisposition = "quarantine"
		}
		data.Retryable = stage == "connect" || stage == "validate"
	case data.VendorCode != nil && stage != "request":
		data.Category = "sql"
	}
	return response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -1, Message: err.Error(), Data: data}}
}
