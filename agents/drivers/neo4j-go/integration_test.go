package main

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

func TestLiveNeo4jAgent(t *testing.T) {
	if os.Getenv("DBX_NEO4J_LIVE") != "1" {
		t.Skip("set DBX_NEO4J_LIVE=1 to run against a real Neo4j server")
	}
	params := connectParams{
		Host:      envOr("DBX_NEO4J_HOST", "127.0.0.1"),
		Port:      envIntOr("DBX_NEO4J_PORT", defaultNeo4jPort),
		Database:  envOr("DBX_NEO4J_DATABASE", defaultDatabase),
		Username:  envOr("DBX_NEO4J_USER", "neo4j"),
		Password:  os.Getenv("DBX_NEO4J_PASSWORD"),
		URLParams: "scheme=" + envOr("DBX_NEO4J_SCHEME", "bolt"),
	}
	runtime, err := newConnectionRuntime(params)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.close()
	server := newServer(runtime, params)

	databases, err := server.listDatabases()
	if err != nil || len(databases) == 0 {
		t.Fatalf("listDatabases() = %#v, %v", databases, err)
	}
	result, err := server.executeQuery(queryOptions{SQL: "RETURN 1 AS value", MaxRows: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 || result.Rows[0][0] != "1" {
		t.Fatalf("unexpected query result: %#v", result)
	}
	transaction, err := server.executeTransaction(rawParams(map[string]any{
		"statements": []string{"CREATE (n:DBXNeo4jGoAgentSmoke {createdAt: datetime()})", "MATCH (n:DBXNeo4jGoAgentSmoke) DELETE n"},
	}))
	if err != nil || transaction.AffectedRows != 0 {
		t.Fatalf("unexpected transaction result: %#v, %v", transaction, err)
	}
}

func rawParams(values map[string]any) map[string]json.RawMessage {
	result := make(map[string]json.RawMessage, len(values))
	for key, value := range values {
		data, _ := json.Marshal(value)
		result[key] = data
	}
	return result
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envIntOr(name string, fallback int) int {
	if value, err := strconv.Atoi(os.Getenv(name)); err == nil && value > 0 {
		return value
	}
	return fallback
}
