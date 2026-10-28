package main

import (
	"database/sql/driver"
	"encoding/json"
	"testing"

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
