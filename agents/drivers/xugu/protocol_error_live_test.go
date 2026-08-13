package main

import (
	"encoding/json"
	"os"
	"testing"
)

// TestLiveXuguStructuredErrorRoundTrip verifies the v2 runtime contract with a
// real Xugu server. It is opt-in because public CI does not provide XuguDB.
// The test is read-only: it triggers an object-not-found error, confirms the
// structured response, and then proves that the same logical session remains
// usable for a successful query.
func TestLiveXuguStructuredErrorRoundTrip(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* connection settings to run the XuguDB integration test")
	}
	params := connectParams{
		Host:     os.Getenv("XUGU_LIVE_HOST"),
		Port:     parsePort(os.Getenv("XUGU_LIVE_PORT")),
		Database: os.Getenv("XUGU_LIVE_DATABASE"),
		Username: os.Getenv("XUGU_LIVE_USERNAME"),
		Password: os.Getenv("XUGU_LIVE_PASSWORD"),
	}
	if params.Host == "" || params.Database == "" || params.Username == "" || params.Password == "" {
		t.Fatal("XUGU_LIVE_HOST, XUGU_LIVE_DATABASE, XUGU_LIVE_USERNAME, and XUGU_LIVE_PASSWORD are required")
	}

	runtime := newRuntimeServer()
	const agentSessionID = "xugu-structured-error-live"
	openParams := map[string]any{
		"agentSessionId": agentSessionID,
		"host":           params.Host,
		"port":           params.Port,
		"database":       params.Database,
		"username":       params.Username,
		"password":       params.Password,
	}
	open := liveXuguRPCRequest(t, runtime, 1, "open_session", openParams)
	if open.Error != nil {
		t.Fatalf("open live Xugu session: %s", open.Error.Message)
	}
	defer runtime.closeSession(agentSessionID)

	invalid := liveXuguRPCRequest(t, runtime, 2, "execute_query", map[string]any{
		"agentSessionId": agentSessionID,
		"database":       params.Database,
		"schema":         params.Username,
		"sql":            `SELECT * FROM "DBX_JAR12_OBJECT_THAT_MUST_NOT_EXIST"`,
		"maxRows":        1,
	})
	if invalid.Error == nil {
		t.Fatal("expected the missing object query to fail")
	}
	assertXuguStructuredErrorContract(t, invalid.Error.Data)
	if invalid.Error.Data.Category != "sql" || invalid.Error.Data.SessionDisposition != "keep" ||
		invalid.Error.Data.AgentSessionID != agentSessionID || invalid.Error.Data.VendorCode == 0 {
		t.Fatalf("unexpected live Xugu error contract: %+v", invalid.Error.Data)
	}

	valid := liveXuguRPCRequest(t, runtime, 3, "execute_query", map[string]any{
		"agentSessionId": agentSessionID,
		"database":       params.Database,
		"schema":         params.Username,
		"sql":            "SELECT 1",
		"maxRows":        1,
	})
	if valid.Error != nil {
		t.Fatalf("live Xugu session was not reusable after SQL error: %s", valid.Error.Message)
	}
}

func liveXuguRPCRequest(t *testing.T, runtime *runtimeServer, id int, method string, params map[string]any) response {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, shutdown := runtime.handleLine(string(payload))
	if shutdown {
		t.Fatalf("%s unexpectedly shut down the Xugu runtime", method)
	}
	return result
}
