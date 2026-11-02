package main

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"

	"github.com/sijms/go-ora/v2/network"
)

type oracleRPCCodedError int

func (e oracleRPCCodedError) Error() string { return "native diagnostic without a number or SQL text" }
func (e oracleRPCCodedError) Code() int     { return int(e) }

func rpcDiagnostics(t *testing.T, resp response) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err = json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	rpc, ok := decoded["error"].(map[string]any)
	if !ok {
		t.Fatal("expected RPC failure")
	}
	data, ok := rpc["data"].(map[string]any)
	if !ok {
		t.Fatal("native diagnostic is lost at the real RPC boundary")
	}
	if data["contractVersion"] != float64(1) {
		t.Fatalf("wrong diagnostic contract: %v", data)
	}
	return data
}

func TestQueryRPCPreservesTypedOracleCodesWithoutParsingTheMessage(t *testing.T) {
	for _, cause := range []error{network.NewOracleError(942), oracleRPCCodedError(1031), fmt.Errorf("wrapped: %w", oracleRPCCodedError(1422))} {
		t.Run(fmt.Sprintf("%T", cause), func(t *testing.T) {
			db, scripted := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
				{queryContains: "DBA_JOBS", args: []driver.Value{}, err: cause},
				{queryContains: "USER_JOBS", args: []driver.Value{}, columns: []string{"JOB"}, rows: [][]driver.Value{{"41"}}},
			})
			s := newServer()
			s.db = db
			runtime := newRuntimeServer()
			runtime.sessions["job-metadata"] = &agentSession{server: s}
			resp, shutdown := runtime.handleLine(`{"id":1,"method":"execute_query","params":{"agentSessionId":"job-metadata","sql":"SELECT JOB FROM DBA_JOBS"}}`)
			if shutdown || resp.Error == nil {
				t.Fatal("catalog failure must not shut down or become a successful empty result")
			}
			data := rpcDiagnostics(t, resp)
			want := map[string]any{"category": "sql", "retryable": false, "sessionDisposition": "keep", "stage": "execute", "operationOutcome": "unknown", "agentSessionId": "job-metadata"}
			for key, value := range want {
				if data[key] != value {
					t.Errorf("%s: got %v, want %v", key, data[key], value)
				}
			}
			if data["vendorCode"] != float64(*oracleVendorCode(cause)) {
				t.Errorf("native code lost: %v", data)
			}
			followUp, _ := runtime.handleLine(`{"id":2,"method":"execute_query","params":{"agentSessionId":"job-metadata","sql":"SELECT JOB FROM USER_JOBS"}}`)
			if followUp.Error != nil || scripted.next != 2 {
				t.Fatal("a dictionary visibility error must keep the same session usable")
			}
		})
	}
}

func TestRPCDoesNotInferNativeCodesFromErrorText(t *testing.T) {
	s := newServer()
	db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{{queryContains: "DBA_JOBS", args: []driver.Value{}, err: errors.New("ORA-00942 is only untrusted text")}})
	s.db = db
	resp, _ := s.handleLine(`{"id":1,"method":"execute_query","params":{"sql":"SELECT JOB FROM DBA_JOBS"}}`)
	data := rpcDiagnostics(t, resp)
	if _, exists := data["vendorCode"]; exists || data["category"] != "protocol" {
		t.Fatalf("uncoded failure must not authorize catalog fallback: %v", data)
	}
}

func TestRPCErrorContractPreservesStageAndNeverAuthorizesExecutionRetry(t *testing.T) {
	for _, scenario := range []struct {
		method, category, disposition, outcome string
		cause                                  error
	}{
		{"open_session", "connection", "keep", "not_started", oracleRPCCodedError(1017)},
		{"validate_session", "connection", "quarantine", "not_started", net.ErrClosed},
		{"execute_query", "timeout", "quarantine", "unknown", context.DeadlineExceeded},
		{"execute_query", "canceled", "quarantine", "unknown", context.Canceled},
		{"commit_manual_transaction", "connection", "quarantine", "unknown", oracleRPCCodedError(3113)},
		{"fetch_query_page", "sql", "keep", "unknown", oracleRPCCodedError(942)},
		{"close_session", "protocol", "keep", "unknown", errors.New("close failure")},
	} {
		t.Run(scenario.method, func(t *testing.T) {
			data := rpcDiagnostics(t, errorResponse(json.RawMessage("1"), scenario.cause, scenario.method, "session"))
			if data["category"] != scenario.category || data["sessionDisposition"] != scenario.disposition || data["operationOutcome"] != scenario.outcome {
				t.Fatalf("incorrect recovery facts: %v", data)
			}
			if data["retryable"] == true && scenario.outcome != "not_started" {
				t.Fatal("a sent operation must never be labeled safe to retry")
			}
		})
	}
}

func TestRPCNativeDebugErrorKeepsAuthoritativeOutcome(t *testing.T) {
	for _, sample := range []struct{ category, stage, outcome, wantCategory, wantStage, disposition string }{
		{"timeout", "execute", "unknown", "timeout", "execute", "quarantine"},
		{"canceled", "request", "not_started", "canceled", "request", "quarantine"},
		{"", "", "unknown", "sql", "execute", "keep"},
	} {
		native := &plDebugNativeError{message: "debug operation failed", category: sample.category, stage: sample.stage, outcome: sample.outcome, agentSessionID: "original"}
		data := rpcDiagnostics(t, errorResponse(json.RawMessage("1"), fmt.Errorf("wrapped: %w", native), "connect", "replacement"))
		if data["category"] != sample.wantCategory || data["stage"] != sample.wantStage || data["operationOutcome"] != sample.outcome || data["sessionDisposition"] != sample.disposition || data["agentSessionId"] != "original" || data["retryable"] != false {
			t.Fatalf("native debug facts were reclassified: %#v", data)
		}
	}
}

func TestRuntimeNegotiatesStructuredErrorsAndLegacyHandshakeStaysCompatible(t *testing.T) {
	legacy, _ := newServer().handleLine(`{"id":1,"method":"handshake","params":{}}`)
	runtime, _ := newRuntimeServer().handleLine(`{"id":1,"method":"handshake","params":{}}`)
	encodedLegacy, _ := json.Marshal(legacy.Result)
	encodedRuntime, _ := json.Marshal(runtime.Result)
	if strings.Contains(string(encodedLegacy), `"structured_error_v1"`) {
		t.Fatal("the legacy handshake must stay within its v1 capability contract")
	}
	if !strings.Contains(string(encodedRuntime), `"structured_error_v1"`) {
		t.Fatal("typed errors must be negotiated before the Core consumes their native codes")
	}
}
