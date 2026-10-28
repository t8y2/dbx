package main

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/sijms/go-ora/v2/network"
)

func TestConnectionInfoRPCOpensNativeJobIdentity(t *testing.T) {
	db, scripted := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
		{queryContains: "PRODUCT_COMPONENT_VERSION", args: []driver.Value{}, columns: []string{"VERSION"}, rows: [][]driver.Value{{"11.2.0.2.0"}}},
		{queryContains: "SELECT USER AS DBX_SESSION_USER FROM DUAL", args: []driver.Value{}, columns: []string{"DBX_SESSION_USER"}, rows: [][]driver.Value{{"Job_Owner"}}},
	})
	s := newServer()
	s.db = db
	runtime := newRuntimeServer()
	runtime.sessions["native-jobs"] = &agentSession{server: s}
	// Exercise the real multi-session RPC corridor, not a replacement handler.
	resp, shutdown := runtime.handleLine(`{"id":1,"method":"connection_info","params":{"agentSessionId":"native-jobs"}}`)
	if shutdown || resp.Error != nil {
		t.Fatalf("native job connection_info failed: %+v", resp)
	}
	encoded, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		IdentifierQuote string            `json:"identifierQuote"`
		DatabaseInfo    map[string]string `json:"databaseInfo"`
	}
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	if result.IdentifierQuote != `"` || result.DatabaseInfo["productName"] != "Oracle" || result.DatabaseInfo["productVersion"] != "11.2.0.2.0" || result.DatabaseInfo["unquotedIdentifierCase"] != "upper" || result.DatabaseInfo["quotedIdentifierCase"] != "mixed" {
		t.Fatalf("wrong connection_info contract: %s", encoded)
	}
	resp, shutdown = runtime.handleLine(`{"id":2,"method":"execute_query","params":{"agentSessionId":"native-jobs","sql":"SELECT USER AS DBX_SESSION_USER FROM DUAL"}}`)
	if shutdown || resp.Error != nil || scripted.next != 2 {
		t.Fatalf("native job session user read failed: %+v", resp)
	}
	query, ok := resp.Result.(queryResult)
	if !ok || len(query.Rows) != 1 || query.Rows[0][0] != "Job_Owner" {
		t.Fatalf("wrong session identity: %+v", resp.Result)
	}
}

func TestConnectionInfoVersionVisibilityIsOptional(t *testing.T) {
	for _, fallback := range []bool{false, true} {
		t.Run(map[bool]string{false: "unavailable", true: "banner-fallback"}[fallback], func(t *testing.T) {
			last := oracleViewSourceQueryStep{queryContains: "V$VERSION", args: []driver.Value{}, err: network.NewOracleError(942)}
			if fallback {
				last.err = nil
				last.columns = []string{"BANNER"}
				last.rows = [][]driver.Value{{"Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production"}}
			}
			db, scripted := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
				{queryContains: "PRODUCT_COMPONENT_VERSION", args: []driver.Value{}, err: network.NewOracleError(1031)}, last,
			})
			s := newServer()
			s.db = db
			info, err := s.connectionInfo()
			if err != nil || scripted.next != 2 {
				t.Fatalf("optional version metadata blocked connection_info: %v", err)
			}
			metadata := info["databaseInfo"].(map[string]string)
			if metadata["productName"] != "Oracle" || (metadata["productVersion"] != "") != fallback {
				t.Fatalf("wrong fallback metadata: %v", metadata)
			}
		})
	}
}

func TestConnectionInfoRequiresConnectedSession(t *testing.T) {
	resp, shutdown := newServer().handleLine(`{"id":1,"method":"connection_info","params":{}}`)
	if shutdown || resp.Error == nil || resp.Error.Message != "agent is not connected" {
		t.Fatalf("disconnected connection_info should fail: %+v", resp)
	}
}
func TestConnectionInfoHonorsCancelledContext(t *testing.T) {
	db, _ := openOracleViewSourceTestDB(t, nil)
	s := newServer()
	s.db = db
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.statementCtx = ctx
	if _, _, err := s.dispatch("connection_info", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancelled context, got %v", err)
	}
}

func TestConnectionInfoProbeTimeoutRemainsOptional(t *testing.T) {
	db, _ := openOracleViewSourceTestDB(t, nil)
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	s := newServer()
	s.db = db
	result, _, err := s.dispatch("connection_info", nil)
	if err != nil || result == nil {
		t.Fatalf("optional version probe timeout must not fail connection_info: %v", err)
	}
}

func TestConnectionInfoCanCancelConnectionAcquisition(t *testing.T) {
	db, _ := openOracleViewSourceTestDB(t, nil)
	db.SetMaxOpenConns(1)
	reserved, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer reserved.Close()
	s := newServer()
	s.db = db
	runtime := newRuntimeServer()
	runtime.sessions["identity"] = &agentSession{server: s}
	finished := make(chan response, 1)
	go func() {
		result, _ := runtime.handleLine(`{"id":1,"method":"connection_info","params":{"agentSessionId":"identity"}}`)
		finished <- result
	}()
	deadline := time.Now().Add(time.Second)
	for {
		s.activeCancelMu.Lock()
		registered := s.activeCancel != nil
		s.activeCancelMu.Unlock()
		if registered {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("identity request did not register cancellation before acquiring a connection")
		}
		time.Sleep(time.Millisecond)
	}
	cancelled, _ := runtime.handleLine(`{"id":2,"method":"cancel_session","params":{"agentSessionId":"identity"}}`)
	if cancelled.Error != nil {
		t.Fatal(cancelled.Error)
	}
	select {
	case result := <-finished:
		if result.Error == nil || !strings.Contains(result.Error.Message, "canceled") {
			t.Fatalf("cancelled identity request must fail: %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel_session did not release the waiting identity request")
	}
}
