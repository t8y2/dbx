package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
)

var (
	errAgentSessionLimit     = errors.New("agent session limit reached")
	errAgentSessionNotFound  = errors.New("agent session not found")
	errXuguOperationTimeout  = errors.New("xugu operation timed out")
	errXuguOperationCanceled = errors.New("xugu operation canceled")

	// go-xugu-driver exposes server errors as plain strings rather than a typed
	// error. Match only the stable server error header and keep the complete
	// original message for diagnostics. A response can contain more than one
	// Xugu error; vendorCode intentionally records the first/top-level code.
	xuguServerErrorHeader = regexp.MustCompile(`(?im)^[\t ]*(?:error:[\t ]*)?\[[\t ]*E([0-9]{1,9})(?:[\t ]+L([0-9]+))?(?:[\t ]+C([0-9]+))?[\t ]*\]`)
	xuguQueryTimeout      = regexp.MustCompile(`(?i)^query timed out after [1-9][0-9]*s$`)
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
		// The structured-error contract requires an exact echo of the request
		// session identifier. Validation belongs at the request boundary; an
		// error response must never normalize the identifier it received.
		AgentSessionID: agentSessionID,
	}
	if err == nil {
		return &rpcError{Code: -1, Message: "unknown agent error", Data: data}
	}
	data.ExceptionClass = safeRPCDiagnostic(fmt.Sprintf("%T", err), 160)

	if vendorCode, ok := xuguVendorCode(err); ok {
		data.VendorCode = vendorCode
	}

	switch {
	case errors.Is(err, errAgentSessionLimit):
		// Session capacity is checked before a database operation starts, so
		// keeping the shared runtime is safe and the caller may retry later.
		if data.OperationOutcome == "not_started" {
			data.Category = "resource"
			data.Retryable = true
		}
	case errors.Is(err, errXuguOperationCanceled) || errors.Is(err, context.Canceled):
		data.Category = "canceled"
		data.SessionDisposition = "quarantine"
	case errors.Is(err, errXuguOperationTimeout) || errors.Is(err, context.DeadlineExceeded) || isXuguTimeoutError(err):
		data.Category = "timeout"
		data.Retryable = stage == "connect" || stage == "validate"
		data.SessionDisposition = "quarantine"
	case errors.Is(err, errAgentSessionNotFound):
		data.Category = "protocol"
		data.SessionDisposition = "quarantine"
	case isXuguTypedConnectionError(err):
		data.Category = "connection"
		data.Retryable = stage == "connect" || stage == "validate"
		if stage != "connect" {
			data.SessionDisposition = "quarantine"
		}
	case data.VendorCode != 0:
		if stage == "connect" || stage == "validate" {
			// The strict Agent contract does not allow category=sql during
			// connect/validate. Preserve the Xugu code while reporting the
			// failed connection stage accurately.
			data.Category = "connection"
			data.Retryable = true
			if stage == "validate" {
				data.SessionDisposition = "quarantine"
			}
		} else if stage == "request" {
			data.Category = "protocol"
		} else {
			data.Category = "sql"
		}
	case isXuguWireProtocolError(err):
		// go-xugu-driver v1.0.12 discards the error from its first socket
		// read. A zero-byte EOF consequently surfaces as this parser text,
		// and the read buffer is no longer trustworthy. Treat it as a broken
		// connection rather than asking the caller to reuse the session.
		data.Category = "connection"
		data.Retryable = stage == "connect" || stage == "validate"
		if stage != "connect" {
			data.SessionDisposition = "quarantine"
		}
	case isXuguConnectionError(err):
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

func xuguVendorCode(err error) (int32, bool) {
	if err == nil {
		return 0, false
	}
	message := strings.TrimRight(err.Error(), "\x00")
	match := xuguServerErrorHeader.FindStringSubmatch(message)
	if len(match) < 2 {
		return 0, false
	}
	value, parseErr := strconv.ParseInt(match[1], 10, 32)
	if parseErr != nil || value <= 0 {
		return 0, false
	}
	return int32(value), true
}

func isXuguTimeoutError(err error) bool {
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return true
	}
	return xuguQueryTimeout.MatchString(strings.TrimSpace(err.Error()))
}

func isXuguConnectionError(err error) bool {
	if isXuguTypedConnectionError(err) {
		return true
	}
	lower := strings.ToLower(strings.TrimSpace(err.Error()))
	for _, marker := range []string{
		"connection refused",
		"connection reset",
		"broken pipe",
		"connection closed",
		"connection lost",
		"driver: bad connection",
		"unexpected eof",
		"no route to host",
		"agent is not connected",
		"向数据库发起连接失败",
		"接收数据库连接失败",
		"数据库连接失败",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return lower == "not connected"
}

func isXuguTypedConnectionError(err error) bool {
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, sql.ErrConnDone) || errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	var networkError *net.OpError
	return errors.As(err, &networkError)
}

func isXuguWireProtocolError(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "parsemsg: unknown message type")
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
