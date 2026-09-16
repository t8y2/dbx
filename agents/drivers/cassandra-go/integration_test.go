package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCassandraIntegration(t *testing.T) {
	host := strings.TrimSpace(os.Getenv("CASSANDRA_TEST_HOST"))
	if host == "" {
		t.Skip("Cassandra integration environment is not configured")
	}
	port := 9042
	if rawPort := strings.TrimSpace(os.Getenv("CASSANDRA_TEST_PORT")); rawPort != "" {
		parsedPort, err := strconv.Atoi(rawPort)
		if err != nil {
			t.Fatal(err)
		}
		port = parsedPort
	}
	ssl, err := strconv.ParseBool(envDefault("CASSANDRA_TEST_SSL", "false"))
	if err != nil {
		t.Fatal(err)
	}
	connection := connectParams{
		Host:           host,
		Port:           port,
		Username:       os.Getenv("CASSANDRA_TEST_USERNAME"),
		Password:       os.Getenv("CASSANDRA_TEST_PASSWORD"),
		URLParams:      os.Getenv("CASSANDRA_TEST_URL_PARAMS"),
		SSL:            ssl,
		CACertPath:     os.Getenv("CASSANDRA_TEST_CA_CERT_PATH"),
		ClientCertPath: os.Getenv("CASSANDRA_TEST_CLIENT_CERT_PATH"),
		ClientKeyPath:  os.Getenv("CASSANDRA_TEST_CLIENT_KEY_PATH"),
	}
	runtime, err := newConnectionRuntime(connection)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.close()
	server := newServer(runtime, connection)
	if err := server.validateConnection(); err != nil {
		t.Fatal(err)
	}

	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	keyspace := "dbx_native_it_" + suffix
	table := "all_types"
	pagedTable := "paged_rows"
	mustCQL(t, server, "CREATE KEYSPACE "+quoteCQLIdentifier(keyspace)+" WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}", "")
	t.Cleanup(func() {
		_, _ = server.executeQuery(queryOptions{SQL: "DROP KEYSPACE IF EXISTS " + quoteCQLIdentifier(keyspace)})
	})
	mustCQL(t, server, "CREATE TABLE "+qualifiedCQLName(keyspace, table)+" ("+
		"id int PRIMARY KEY, txt text, flag boolean, amount decimal, payload blob, created timestamp, address inet, "+
		"tags set<text>, items list<int>, attrs map<text, int>, pair frozen<tuple<int, text>>)", keyspace)
	mustCQL(t, server, "CREATE INDEX "+quoteCQLIdentifier(table+"_txt_idx")+" ON "+qualifiedCQLName(keyspace, table)+" (txt)", keyspace)
	mustCQL(t, server, "INSERT INTO "+qualifiedCQLName(keyspace, table)+" "+
		"(id, txt, flag, amount, payload, created, address, tags, items, attrs, pair) VALUES "+
		"(1, 'hello', true, 12.34, 0x00ff, '2026-08-03T00:00:00Z', '127.0.0.1', {'a', 'b'}, [1, 2], {'a': 1}, (7, 'seven'))", keyspace)
	mustCQL(t, server, "CREATE TABLE "+qualifiedCQLName(keyspace, pagedTable)+" (id int PRIMARY KEY, txt text)", keyspace)

	for start := 0; start < 250; start += 50 {
		statements := make([]string, 0, 50)
		for id := start; id < start+50; id++ {
			statements = append(statements, fmt.Sprintf("INSERT INTO %s (id, txt) VALUES (%d, 'row-%d')", qualifiedCQLName(keyspace, pagedTable), id, id))
		}
		mustStatements(t, server, keyspace, statements, false)
	}
	mustStatements(t, server, keyspace, []string{
		"INSERT INTO " + qualifiedCQLName(keyspace, pagedTable) + " (id, txt) VALUES (1001, 'unlogged')",
	}, false)
	mustStatements(t, server, keyspace, []string{
		"INSERT INTO " + qualifiedCQLName(keyspace, pagedTable) + " (id, txt) VALUES (1002, 'logged')",
	}, true)

	connectionInfo, err := server.connectionInfo()
	if err != nil || strings.TrimSpace(fmt.Sprint(connectionInfo["database_version"])) == "" {
		t.Fatalf("connection info failed: info=%v err=%v", connectionInfo, err)
	}
	databases, err := server.listDatabases()
	if err != nil || !containsDatabase(databases, keyspace) {
		t.Fatalf("keyspace metadata missing: databases=%v err=%v", databases, err)
	}
	tables, err := server.listTables(keyspace, metadataListConstraints{})
	if err != nil || !containsTable(tables, table) || !containsTable(tables, pagedTable) {
		t.Fatalf("table metadata missing: tables=%v err=%v", tables, err)
	}
	columns, err := server.getColumns(keyspace, table)
	if err != nil || len(columns) != 11 || !containsPrimaryKeyColumn(columns, "id") {
		t.Fatalf("column metadata mismatch: columns=%v err=%v", columns, err)
	}
	indexes, err := server.listIndexes(keyspace, table)
	if err != nil || !containsIndex(indexes, table+"_txt_idx") {
		t.Fatalf("index metadata missing: indexes=%v err=%v", indexes, err)
	}
	ddl, err := server.getTableDDL(keyspace, table)
	if err != nil || !strings.Contains(ddl, "tuple<int, text>") || !strings.Contains(ddl, "PRIMARY KEY") {
		t.Fatalf("table DDL mismatch: ddl=%q err=%v", ddl, err)
	}
	result, err := server.executeQuery(queryOptions{
		SQL:    "SELECT * FROM " + qualifiedCQLName(keyspace, table) + " WHERE id = 1",
		Schema: keyspace,
	})
	if err != nil || len(result.Rows) != 1 || len(result.Rows[0]) != len(result.Columns) {
		t.Fatalf("all-types query failed: result=%v err=%v", result, err)
	}
	for _, value := range result.Rows[0] {
		if value != nil {
			if _, ok := value.(string); !ok {
				t.Fatalf("legacy result contract requires strings, got %T (%v)", value, value)
			}
		}
	}

	page, err := server.executeQueryPage(queryOptions{
		SQL:     "SELECT id, txt FROM " + qualifiedCQLName(keyspace, pagedTable),
		Schema:  keyspace,
		MaxRows: 250,
	}, 100)
	if err != nil || len(page.Rows) != 100 || !page.HasMore || page.SessionID == nil {
		t.Fatalf("first page mismatch: page=%v err=%v", page, err)
	}
	totalRows := len(page.Rows)
	for page.HasMore {
		page, err = server.fetchQueryPage(*page.SessionID, 100)
		if err != nil {
			t.Fatal(err)
		}
		totalRows += len(page.Rows)
	}
	if totalRows != 250 {
		t.Fatalf("unexpected paged row count: %d", totalRows)
	}
}

func envDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func qualifiedCQLName(keyspace, object string) string {
	return quoteCQLIdentifier(keyspace) + "." + quoteCQLIdentifier(object)
}

func mustCQL(t *testing.T, server *server, sql, keyspace string) {
	t.Helper()
	if _, err := server.executeQuery(queryOptions{SQL: sql, Schema: keyspace}); err != nil {
		t.Fatalf("execute %q: %v", sql, err)
	}
}

func mustStatements(t *testing.T, server *server, keyspace string, statements []string, transactional bool) {
	t.Helper()
	rawStatements, _ := json.Marshal(statements)
	rawSchema, _ := json.Marshal(keyspace)
	if _, err := server.executeStatements(map[string]json.RawMessage{
		"schema":     rawSchema,
		"statements": rawStatements,
	}, transactional); err != nil {
		t.Fatal(err)
	}
}

func containsDatabase(databases []databaseInfo, name string) bool {
	for _, database := range databases {
		if database.Name == name {
			return true
		}
	}
	return false
}

func containsTable(tables []tableInfo, name string) bool {
	for _, table := range tables {
		if table.Name == name {
			return true
		}
	}
	return false
}

func containsIndex(indexes []indexInfo, name string) bool {
	for _, index := range indexes {
		if index.Name == name {
			return true
		}
	}
	return false
}

func containsPrimaryKeyColumn(columns []columnInfo, name string) bool {
	for _, column := range columns {
		if column.Name == name && column.IsPrimaryKey {
			return true
		}
	}
	return false
}
