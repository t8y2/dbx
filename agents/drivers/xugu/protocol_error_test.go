package main

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestXuguStructuredRPCErrorClassification(t *testing.T) {
	tests := []struct {
		name        string
		method      string
		err         error
		category    string
		retryable   bool
		disposition string
		stage       string
		outcome     string
		vendorCode  int32
	}{
		{
			name:        "permission remains sql",
			method:      "get_object_source",
			err:         errors.New("[E18012] 权限不够"),
			category:    "sql",
			disposition: "keep",
			stage:       "execute",
			outcome:     "unknown",
			vendorCode:  18012,
		},
		{
			name:        "first syntax code and location text are preserved",
			method:      "execute_query",
			err:         errors.New("[E19132] 语法错误 [E19260 L6 C29] unexpected end of file"),
			category:    "sql",
			disposition: "keep",
			stage:       "execute",
			outcome:     "unknown",
			vendorCode:  19132,
		},
		{
			name:        "server code with trailing nul",
			method:      "list_objects",
			err:         errors.New("[E10049 L2 C57] 字段 ON_NULL 不存在\x00"),
			category:    "sql",
			disposition: "keep",
			stage:       "execute",
			outcome:     "unknown",
			vendorCode:  10049,
		},
		{
			name:        "server error during connect",
			method:      "open_session",
			err:         errors.New("[E18012] login rejected"),
			category:    "connection",
			retryable:   true,
			disposition: "keep",
			stage:       "connect",
			outcome:     "not_started",
			vendorCode:  18012,
		},
		{
			name:        "server error during validation",
			method:      "validate_session",
			err:         errors.New("[E18012] validation failed"),
			category:    "connection",
			retryable:   true,
			disposition: "quarantine",
			stage:       "validate",
			outcome:     "not_started",
			vendorCode:  18012,
		},
		{
			name:        "context canceled",
			method:      "execute_query",
			err:         context.Canceled,
			category:    "canceled",
			disposition: "quarantine",
			stage:       "execute",
			outcome:     "unknown",
		},
		{
			name:        "deadline exceeded",
			method:      "fetch_query_page",
			err:         context.DeadlineExceeded,
			category:    "timeout",
			disposition: "quarantine",
			stage:       "fetch",
			outcome:     "unknown",
		},
		{
			name:        "agent watchdog timeout",
			method:      "execute_query",
			err:         errors.New("query timed out after 2s"),
			category:    "timeout",
			disposition: "quarantine",
			stage:       "execute",
			outcome:     "unknown",
		},
		{
			name:        "eof while executing",
			method:      "execute_query",
			err:         io.EOF,
			category:    "connection",
			disposition: "quarantine",
			stage:       "execute",
			outcome:     "unknown",
		},
		{
			name:        "bad connection while connecting",
			method:      "test_connection",
			err:         driver.ErrBadConn,
			category:    "connection",
			retryable:   true,
			disposition: "keep",
			stage:       "connect",
			outcome:     "not_started",
		},
		{
			name:        "driver connection wrapper",
			method:      "list_tables",
			err:         errors.New("接收数据库连接失败: EOF"),
			category:    "connection",
			disposition: "quarantine",
			stage:       "execute",
			outcome:     "unknown",
		},
		{
			name:        "wire parser failure quarantines live session",
			method:      "list_tables",
			err:         errors.New("parseMsg: unknown message type"),
			category:    "connection",
			disposition: "quarantine",
			stage:       "execute",
			outcome:     "unknown",
		},
		{
			name:        "server error text wins over eof words",
			method:      "execute_query",
			err:         errors.New("[E19260 L6 C29] syntax error: unexpected EOF"),
			category:    "sql",
			disposition: "keep",
			stage:       "execute",
			outcome:     "unknown",
			vendorCode:  19260,
		},
		{
			name:        "killed is not guessed as cancellation",
			method:      "execute_query",
			err:         errors.New("killed"),
			category:    "protocol",
			disposition: "keep",
			stage:       "execute",
			outcome:     "unknown",
		},
		{
			name:        "session capacity",
			method:      "open_session",
			err:         errAgentSessionLimit,
			category:    "resource",
			retryable:   true,
			disposition: "keep",
			stage:       "connect",
			outcome:     "not_started",
		},
		{
			name:        "missing runtime session",
			method:      "list_tables",
			err:         errAgentSessionNotFound,
			category:    "protocol",
			disposition: "quarantine",
			stage:       "execute",
			outcome:     "unknown",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rpcErr := classifyRPCError(test.method, "session-1", test.err)
			data := rpcErr.Data
			assertXuguStructuredErrorContract(t, data)
			if data.Category != test.category || data.Retryable != test.retryable ||
				data.SessionDisposition != test.disposition || data.Stage != test.stage ||
				data.OperationOutcome != test.outcome || data.VendorCode != test.vendorCode {
				t.Fatalf("unexpected classification: %+v", data)
			}
			if data.ContractVersion != 1 || data.AgentSessionID != "session-1" {
				t.Fatalf("missing structured error identity: %+v", data)
			}
			if rpcErr.Message != test.err.Error() {
				t.Fatalf("error message changed: got %q want %q", rpcErr.Message, test.err.Error())
			}
		})
	}
}

func TestXuguStructuredRPCErrorContainsRequiredContractFields(t *testing.T) {
	rpcErr := classifyRPCError("fetch_query_page", "session-2", context.DeadlineExceeded)
	assertXuguStructuredErrorContract(t, rpcErr.Data)
	payload, err := json.Marshal(rpcErr)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"category", "retryable", "sessionDisposition", "stage", "contractVersion", "operationOutcome", "agentSessionId",
	} {
		if _, ok := decoded.Data[key]; !ok {
			t.Fatalf("structured error missing %s: %s", key, payload)
		}
	}
	if decoded.Data["stage"] != "fetch" || decoded.Data["operationOutcome"] != "unknown" {
		t.Fatalf("unexpected fetch error contract: %s", payload)
	}
}

func TestXuguStructuredRPCErrorEchoesSessionIDExactly(t *testing.T) {
	const sessionID = " session-with-boundary-whitespace "
	rpcErr := classifyRPCError("list_tables", sessionID, errAgentSessionNotFound)
	if rpcErr.Data == nil || rpcErr.Data.AgentSessionID != sessionID {
		t.Fatalf("agentSessionId was normalized: got %q want %q", rpcErr.Data.AgentSessionID, sessionID)
	}
}

func TestXuguVendorCodeUsesStableHeaderOnly(t *testing.T) {
	tests := []struct {
		name    string
		message string
		code    int32
		ok      bool
	}{
		{name: "simple", message: "[E18012] 权限不够", code: 18012, ok: true},
		{name: "leading whitespace", message: "  [E19260 L6 C29] syntax error", code: 19260, ok: true},
		{name: "second line", message: "wrapper\n[E10049 L2 C57] missing", code: 10049, ok: true},
		{name: "first of multiple", message: "[E19132] syntax [E19260 L6 C29] detail", code: 19132, ok: true},
		{name: "short code", message: "[E1 L1 C8] syntax error", code: 1, ok: true},
		{name: "unstructured mention", message: "metadata request failed with E18012", ok: false},
		{name: "bracket cannot span lines", message: "[E18012\n] denied", ok: false},
		{name: "too many digits", message: "[E9999999999] invalid", ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, ok := xuguVendorCode(errors.New(test.message))
			if code != test.code || ok != test.ok {
				t.Fatalf("xuguVendorCode(%q) = (%d, %t), want (%d, %t)", test.message, code, ok, test.code, test.ok)
			}
		})
	}
}

func TestXuguRPCErrorStageMapping(t *testing.T) {
	tests := map[string]string{
		"":                         "request",
		"handshake":                "request",
		"open_session":             "connect",
		"test_connection":          "connect",
		"validate_session":         "validate",
		"cancel_session":           "cancel",
		"close_session":            "close",
		"disconnect":               "close",
		"close_query_session":      "close",
		"close_table_read_session": "close",
		"shutdown":                 "close",
		"fetch_query_page":         "fetch",
		"fetch_table_read_page":    "fetch",
		"list_tables":              "execute",
	}
	for method, want := range tests {
		if got := rpcErrorStage(method); got != want {
			t.Fatalf("rpcErrorStage(%q) = %q, want %q", method, got, want)
		}
	}
}

func TestXuguSafeRPCDiagnosticIsBoundedASCII(t *testing.T) {
	got := safeRPCDiagnostic("*errors.errorString\n权限", 12)
	if got != "*errors.erro" {
		t.Fatalf("unexpected diagnostic sanitization: %q", got)
	}
}

func TestXuguRuntimeErrorsCarryRequestStageAndSession(t *testing.T) {
	runtime := newRuntimeServer()

	malformed, shutdown := runtime.handleLine(`{"jsonrpc":`)
	if shutdown || malformed.Error == nil {
		t.Fatalf("unexpected malformed request response: shutdown=%v response=%+v", shutdown, malformed)
	}
	if malformed.Error.Data.Stage != "request" || malformed.Error.Data.OperationOutcome != "not_started" ||
		malformed.Error.Data.AgentSessionID != "" {
		t.Fatalf("unexpected malformed request contract: %+v", malformed.Error.Data)
	}

	missing, shutdown := runtime.handleLine(`{"jsonrpc":"2.0","id":9,"method":"list_tables","params":{"agentSessionId":"missing-session"}}`)
	if shutdown || missing.Error == nil {
		t.Fatalf("unexpected missing session response: shutdown=%v response=%+v", shutdown, missing)
	}
	if missing.Error.Data.AgentSessionID != "missing-session" || missing.Error.Data.Category != "protocol" ||
		missing.Error.Data.SessionDisposition != "quarantine" {
		t.Fatalf("unexpected missing session contract: %+v", missing.Error.Data)
	}
}

func TestXuguLegacyHandshakeDoesNotAdvertiseStructuredErrors(t *testing.T) {
	s := newServer()
	resp, _ := s.handleLine(`{"jsonrpc":"2.0","id":1,"method":"handshake","params":{}}`)
	encoded, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "structured_error_v1") {
		t.Fatalf("protocol v1 handshake must not advertise v2 structured errors: %s", encoded)
	}
}

func TestXuguLegacyErrorPathsRemainContractCompatible(t *testing.T) {
	s := newServer()

	malformed, shutdown := s.handleLine(`{"jsonrpc":`)
	if shutdown || malformed.Error == nil {
		t.Fatalf("unexpected malformed legacy response: shutdown=%v response=%+v", shutdown, malformed)
	}
	assertXuguStructuredErrorContract(t, malformed.Error.Data)
	if malformed.Error.Data.Stage != "request" || malformed.Error.Data.AgentSessionID != "" {
		t.Fatalf("unexpected malformed legacy contract: %+v", malformed.Error.Data)
	}

	dispatch, shutdown := s.handleLine(`{"jsonrpc":"2.0","id":2,"method":"list_tables","params":{}}`)
	if shutdown || dispatch.Error == nil {
		t.Fatalf("unexpected legacy dispatch response: shutdown=%v response=%+v", shutdown, dispatch)
	}
	assertXuguStructuredErrorContract(t, dispatch.Error.Data)
	if dispatch.Error.Data.Stage != "execute" || dispatch.Error.Data.Category != "connection" {
		t.Fatalf("unexpected legacy dispatch contract: %+v", dispatch.Error.Data)
	}
}

func assertXuguStructuredErrorContract(t *testing.T, data *rpcErrorData) {
	t.Helper()
	if data == nil || data.ContractVersion != 1 {
		t.Fatalf("missing structured error contract: %+v", data)
	}
	expectedOutcome := "unknown"
	if data.Stage == "request" || data.Stage == "connect" || data.Stage == "validate" {
		expectedOutcome = "not_started"
	}
	if data.OperationOutcome != expectedOutcome {
		t.Fatalf("stage/outcome violates the Agent contract: %+v", data)
	}
	switch data.Category {
	case "connection":
		if data.SessionDisposition == "replace_runtime" {
			t.Fatalf("connection error cannot replace the runtime: %+v", data)
		}
	case "sql":
		if data.Stage != "execute" && data.Stage != "fetch" && data.Stage != "cancel" && data.Stage != "close" {
			t.Fatalf("sql error has invalid stage: %+v", data)
		}
		if data.SessionDisposition == "replace_runtime" {
			t.Fatalf("sql error cannot replace the runtime: %+v", data)
		}
	case "resource":
		if data.SessionDisposition != "replace_runtime" && data.OperationOutcome != "not_started" {
			t.Fatalf("resource error has invalid disposition/outcome: %+v", data)
		}
	case "protocol":
		if data.SessionDisposition == "replace_runtime" && data.OperationOutcome == "not_started" {
			t.Fatalf("protocol error has unsafe disposition/outcome: %+v", data)
		}
	case "timeout", "canceled":
		if data.SessionDisposition != "quarantine" {
			t.Fatalf("%s error must quarantine its session: %+v", data.Category, data)
		}
	default:
		t.Fatalf("unknown structured error category: %+v", data)
	}
}
