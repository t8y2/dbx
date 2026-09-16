package main

import (
	"context"
	"encoding/json"
	"testing"

	pq "gitcode.com/opengauss/openGauss-connector-go-pq"
)

func TestStructuredRPCErrorClassification(t *testing.T) {
	tests := []struct {
		name        string
		method      string
		err         error
		category    string
		retryable   bool
		disposition string
		sqlState    string
	}{
		{name: "sql", method: "execute_query", err: &pq.Error{Code: pq.ErrorCode("42P01"), Message: "relation missing"}, category: "sql", disposition: "keep", sqlState: "42P01"},
		{name: "connection", method: "execute_query", err: &pq.Error{Code: pq.ErrorCode("08006"), Message: "connection failure"}, category: "connection", disposition: "quarantine", sqlState: "08006"},
		{name: "connect", method: "open_session", err: &pq.Error{Code: pq.ErrorCode("28P01"), Message: "bad password"}, category: "connection", retryable: true, disposition: "keep", sqlState: "28P01"},
		{name: "query canceled", method: "execute_query", err: &pq.Error{Code: pq.ErrorCode("57014"), Message: "canceling statement"}, category: "canceled", disposition: "quarantine", sqlState: "57014"},
		{name: "context canceled", method: "execute_query", err: context.Canceled, category: "canceled", disposition: "quarantine"},
		{name: "timeout", method: "execute_query", err: context.DeadlineExceeded, category: "timeout", disposition: "quarantine"},
		{name: "capacity", method: "execute_query", err: errOperationCapacity, category: "resource", retryable: true, disposition: "keep"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rpcErr := classifyRPCError(test.method, "session-1", test.err)
			if rpcErr.Data.Category != test.category || rpcErr.Data.Retryable != test.retryable || rpcErr.Data.SessionDisposition != test.disposition || rpcErr.Data.SQLState != test.sqlState {
				t.Fatalf("unexpected classification: %+v", rpcErr.Data)
			}
			if rpcErr.Data.AgentSessionID != "session-1" || rpcErr.Data.ContractVersion != 1 {
				t.Fatalf("missing structured error identity: %+v", rpcErr.Data)
			}
		})
	}
}

func TestStructuredRPCErrorContainsRequiredContractFields(t *testing.T) {
	rpcErr := classifyRPCError("fetch_query_page", "session-2", context.DeadlineExceeded)
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
	for _, key := range []string{"category", "retryable", "sessionDisposition", "stage", "contractVersion", "operationOutcome", "agentSessionId"} {
		if _, ok := decoded.Data[key]; !ok {
			t.Fatalf("structured error missing %s: %s", key, payload)
		}
	}
	if decoded.Data["stage"] != "fetch" || decoded.Data["operationOutcome"] != "unknown" {
		t.Fatalf("unexpected fetch error contract: %s", payload)
	}
}
