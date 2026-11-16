package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
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
	t.Cleanup(runtime.close)
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
		if _, err := server.executeQuery(queryOptions{SQL: "DROP KEYSPACE IF EXISTS " + quoteCQLIdentifier(keyspace)}); err != nil {
			t.Errorf("drop integration keyspace %s: %v", keyspace, err)
		}
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

func TestCassandraTableDataCursorIntegration(t *testing.T) {
	host := strings.TrimSpace(os.Getenv("CASSANDRA_TEST_HOST"))
	if host == "" {
		t.Skip("Cassandra integration environment is not configured")
	}
	port, err := strconv.Atoi(envDefault("CASSANDRA_TEST_PORT", "9042"))
	if err != nil {
		t.Fatal(err)
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
	t.Cleanup(runtime.close)
	server := newServer(runtime, connection)
	if err := server.validateConnection(); err != nil {
		t.Fatal(err)
	}

	keyspace := "dbx_issue7465_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	mustCQL(t, server, "CREATE KEYSPACE "+quoteCQLIdentifier(keyspace)+" WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}", "")
	t.Cleanup(func() {
		if _, err := server.executeQuery(queryOptions{SQL: "DROP KEYSPACE IF EXISTS " + quoteCQLIdentifier(keyspace)}); err != nil {
			t.Errorf("drop integration keyspace %s: %v", keyspace, err)
		}
	})
	mustCQL(t, server, "CREATE TABLE "+qualifiedCQLName(keyspace, "paged_rows")+" (id int PRIMARY KEY)", keyspace)
	mustCQL(t, server, "CREATE TABLE "+qualifiedCQLName(keyspace, "empty_rows")+" (id int PRIMARY KEY)", keyspace)
	for start := 0; start < 205; start += 25 {
		end := min(start+25, 205)
		statements := make([]string, 0, end-start)
		for id := start; id < end; id++ {
			statements = append(statements, fmt.Sprintf("INSERT INTO %s (id) VALUES (%d)", qualifiedCQLName(keyspace, "paged_rows"), id))
		}
		mustStatements(t, server, keyspace, statements, false)
	}

	tableSQL := `SELECT * FROM "paged_rows";`
	page, err := server.executeQueryPage(queryOptions{SQL: tableSQL, Schema: keyspace, MaxRows: 1_000}, 100)
	if err != nil || len(page.Rows) != 100 || !page.HasMore || page.SessionID == nil {
		t.Fatalf("first page mismatch: rows=%d has_more=%v session=%v err=%v", len(page.Rows), page.HasMore, page.SessionID, err)
	}
	firstSessionID := *page.SessionID
	page, err = server.fetchQueryPage(firstSessionID, 100)
	if err != nil || len(page.Rows) != 100 || !page.HasMore || page.SessionID == nil || *page.SessionID != firstSessionID {
		t.Fatalf("middle page mismatch: rows=%d has_more=%v session=%v err=%v", len(page.Rows), page.HasMore, page.SessionID, err)
	}
	page, err = server.fetchQueryPage(firstSessionID, 100)
	if err != nil || len(page.Rows) != 5 || page.HasMore || page.SessionID != nil {
		t.Fatalf("last page mismatch: rows=%d has_more=%v session=%v err=%v", len(page.Rows), page.HasMore, page.SessionID, err)
	}
	if _, err := server.fetchQueryPage(firstSessionID, 100); err == nil {
		t.Fatal("exhausted query session remained usable")
	}

	page, err = server.executeQueryPage(queryOptions{SQL: tableSQL, Schema: keyspace, MaxRows: 150}, 100)
	if err != nil || len(page.Rows) != 100 || page.SessionID == nil {
		t.Fatalf("maxRows first page mismatch: page=%v err=%v", page, err)
	}
	page, err = server.fetchQueryPage(*page.SessionID, 100)
	if err != nil || len(page.Rows) != 50 || page.HasMore || !page.Truncated {
		t.Fatalf("maxRows terminal page mismatch: rows=%d has_more=%v truncated=%v err=%v", len(page.Rows), page.HasMore, page.Truncated, err)
	}

	page, err = server.executeQueryPage(queryOptions{SQL: tableSQL, Schema: keyspace, MaxRows: 1_000}, 100)
	if err != nil || page.SessionID == nil {
		t.Fatalf("close-session setup failed: page=%v err=%v", page, err)
	}
	closedSessionID := *page.SessionID
	if !server.closeQuerySession(closedSessionID) {
		t.Fatal("query session was not closed")
	}
	if _, err := server.fetchQueryPage(closedSessionID, 100); err == nil {
		t.Fatal("closed query session remained usable")
	}

	page, err = server.executeQueryPage(queryOptions{SQL: tableSQL, Schema: keyspace, MaxRows: 1_000}, 40)
	if err != nil || len(page.Rows) != 40 || page.SessionID == nil {
		t.Fatalf("page-size restart mismatch: page=%v err=%v", page, err)
	}
	page, err = server.fetchQueryPage(*page.SessionID, 40)
	if err != nil || len(page.Rows) != 40 {
		t.Fatalf("page-size continuation mismatch: rows=%d err=%v", len(page.Rows), err)
	}
	if page.SessionID != nil {
		server.closeQuerySession(*page.SessionID)
	}

	empty, err := server.executeQueryPage(queryOptions{SQL: `SELECT * FROM "empty_rows";`, Schema: keyspace, MaxRows: 1_000}, 100)
	if err != nil || len(empty.Rows) != 0 || empty.HasMore || empty.SessionID != nil {
		t.Fatalf("empty page mismatch: page=%v err=%v", empty, err)
	}

	deletes := make([]string, 0, 5)
	for id := 200; id < 205; id++ {
		deletes = append(deletes, fmt.Sprintf("DELETE FROM %s WHERE id = %d", qualifiedCQLName(keyspace, "paged_rows"), id))
	}
	mustStatements(t, server, keyspace, deletes, false)
	page, err = server.executeQueryPage(queryOptions{SQL: tableSQL, Schema: keyspace, MaxRows: 1_000}, 100)
	if err != nil {
		t.Fatal(err)
	}
	totalRows := 0
	pageCount := 0
	for {
		totalRows += len(page.Rows)
		pageCount++
		if !page.HasMore {
			break
		}
		if page.SessionID == nil || pageCount >= 3 {
			t.Fatalf("exact-boundary cursor did not terminate: page=%v page_count=%d", page, pageCount)
		}
		page, err = server.fetchQueryPage(*page.SessionID, 100)
		if err != nil {
			t.Fatal(err)
		}
	}
	if totalRows != 200 {
		t.Fatalf("exact-boundary row count mismatch: got %d", totalRows)
	}
}

func TestCassandraMaterializedViewDDLIntegration(t *testing.T) {
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
	t.Cleanup(runtime.close)
	server := newServer(runtime, connection)
	if err := server.validateConnection(); err != nil {
		t.Fatal(err)
	}
	connectionInfo, err := server.connectionInfo()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Cassandra runtime version: %v", connectionInfo["version"])

	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	keyspace := "dbx_issue_7475_regression_" + suffix
	baseTable := "BaseEvents"
	view := "EventsByCategory"
	allColumnsView := "AllEventsByCategory"
	mustCQL(t, server, "CREATE KEYSPACE "+quoteCQLIdentifier(keyspace)+" WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}", "")
	t.Cleanup(func() {
		if _, err := server.executeQuery(queryOptions{SQL: "DROP KEYSPACE IF EXISTS " + quoteCQLIdentifier(keyspace)}); err != nil {
			t.Errorf("drop integration keyspace %s: %v", keyspace, err)
		}
	})
	mustCQL(t, server, "CREATE TABLE "+qualifiedCQLName(keyspace, baseTable)+" ("+
		`"Tenant Id" text, "Bucket" int, "Event Time" timestamp, "Category" text, "Payload" text, `+
		`PRIMARY KEY ("Tenant Id", "Event Time", "Bucket")) `+
		`WITH CLUSTERING ORDER BY ("Event Time" DESC, "Bucket" ASC)`, keyspace)
	mustCQL(t, server, "CREATE MATERIALIZED VIEW "+qualifiedCQLName(keyspace, view)+" AS "+
		`SELECT "Tenant Id", "Bucket", "Event Time", "Category" FROM `+qualifiedCQLName(keyspace, baseTable)+" "+
		`WHERE "Tenant Id" IS NOT NULL AND "Event Time" IS NOT NULL AND "Bucket" IS NOT NULL AND "Category" IS NOT NULL `+
		`PRIMARY KEY (("Tenant Id", "Category"), "Event Time", "Bucket") `+
		`WITH CLUSTERING ORDER BY ("Event Time" DESC, "Bucket" ASC) AND comment = 'issue 7475 round trip' AND gc_grace_seconds = 86401`, keyspace)
	mustCQL(t, server, "CREATE MATERIALIZED VIEW "+qualifiedCQLName(keyspace, allColumnsView)+" AS "+
		`SELECT * FROM `+qualifiedCQLName(keyspace, baseTable)+" "+
		`WHERE "Tenant Id" IS NOT NULL AND "Event Time" IS NOT NULL AND "Bucket" IS NOT NULL AND "Category" IS NOT NULL `+
		`PRIMARY KEY (("Tenant Id", "Category"), "Event Time", "Bucket") `+
		`WITH CLUSTERING ORDER BY ("Event Time" DESC, "Bucket" ASC)`, keyspace)

	ddl, err := server.getTableDDL(keyspace, view)
	if err != nil {
		t.Fatalf("materialized view DDL failed: %v", err)
	}
	for _, fragment := range []string{
		"CREATE MATERIALIZED VIEW",
		"FROM " + keyspace + "." + quoteCQLIdentifier(baseTable),
		`PRIMARY KEY (("Tenant Id", "Category"), "Event Time", "Bucket")`,
		`CLUSTERING ORDER BY ("Event Time" DESC, "Bucket" ASC)`,
		"comment = 'issue 7475 round trip'",
		"gc_grace_seconds = 86401",
	} {
		if !strings.Contains(ddl, fragment) {
			t.Fatalf("materialized view DDL omitted %q:\n%s", fragment, ddl)
		}
	}
	projection := materializedViewProjection(t, ddl)
	wantProjection := []string{`"Bucket"`, `"Category"`, `"Event Time"`, `"Tenant Id"`}
	sort.Strings(projection)
	sort.Strings(wantProjection)
	if strings.Join(projection, ",") != strings.Join(wantProjection, ",") || strings.Contains(ddl, `"Payload"`) || strings.Contains(ddl, "SELECT *") {
		t.Fatalf("materialized view DDL lost its selected-column subset:\n%s", ddl)
	}
	metadataSession, err := runtime.sessionFor("")
	if err != nil {
		t.Fatal(err)
	}
	legacyCatalog, err := legacyMaterializedViewCatalog(metadataSession, keyspace, view)
	if err != nil {
		t.Fatalf("legacy materialized view catalog failed: %v", err)
	}
	legacyDDL, err := materializedViewDDLFromCatalog(keyspace, view, legacyCatalog)
	if err != nil {
		t.Fatalf("legacy materialized view DDL failed: %v", err)
	}
	legacyProjection := materializedViewProjection(t, legacyDDL)
	sort.Strings(legacyProjection)
	if strings.Join(legacyProjection, ",") != strings.Join(wantProjection, ",") || strings.Contains(legacyDDL, `"Payload"`) || strings.Contains(legacyDDL, "SELECT *") {
		t.Fatalf("legacy materialized view DDL lost its selected-column subset:\n%s", legacyDDL)
	}
	allColumnsDDL, err := server.getTableDDL(keyspace, allColumnsView)
	if err != nil || !strings.Contains(allColumnsDDL, "SELECT *") {
		t.Fatalf("materialized view SELECT * was not preserved: ddl=%q err=%v", allColumnsDDL, err)
	}

	result, _, err := server.dispatch("get_object_source", map[string]json.RawMessage{
		"schema":      json.RawMessage(strconv.Quote(keyspace)),
		"name":        json.RawMessage(strconv.Quote(view)),
		"object_type": json.RawMessage(`"MATERIALIZED_VIEW"`),
	})
	if err != nil {
		t.Fatalf("materialized view object-source RPC failed: %v", err)
	}
	source, ok := result.(objectSource)
	if !ok || source.Source != ddl || source.Name != view || source.ObjectType != "MATERIALIZED_VIEW" {
		t.Fatalf("unexpected materialized view object-source response: %#v", result)
	}

	tableDDL, err := server.getTableDDL(keyspace, baseTable)
	if err != nil || !strings.HasPrefix(tableDDL, "CREATE TABLE ") || strings.Contains(tableDDL, "CREATE MATERIALIZED VIEW") {
		t.Fatalf("ordinary table DDL changed: ddl=%q err=%v", tableDDL, err)
	}
	if _, err := server.getTableDDL(keyspace, "MissingObject"); err == nil {
		t.Fatal("missing schema object unexpectedly returned DDL")
	}
	if _, err := server.getMaterializedViewDDL(keyspace, "MissingObject"); err == nil {
		t.Fatal("missing materialized view unexpectedly returned DDL")
	}

	mustCQL(t, server, "DROP MATERIALIZED VIEW "+qualifiedCQLName(keyspace, view), keyspace)
	mustCQL(t, server, ddl, keyspace)
	recreatedDDL, err := server.getTableDDL(keyspace, view)
	if err != nil {
		t.Fatalf("materialized view DDL after recreation failed: %v", err)
	}
	if recreatedDDL != ddl {
		t.Fatalf("materialized view changed after DDL round trip:\nbefore:\n%s\nafter:\n%s", ddl, recreatedDDL)
	}
	mustCQL(t, server, "DROP MATERIALIZED VIEW "+qualifiedCQLName(keyspace, view), keyspace)
	mustCQL(t, server, legacyDDL, keyspace)
	legacyRecreatedDDL, err := server.getTableDDL(keyspace, view)
	if err != nil {
		t.Fatalf("materialized view DDL after legacy recreation failed: %v", err)
	}
	if legacyRecreatedDDL != ddl {
		t.Fatalf("legacy materialized view DDL changed the definition:\nbefore:\n%s\nafter:\n%s", ddl, legacyRecreatedDDL)
	}
}

func materializedViewProjection(t *testing.T, ddl string) []string {
	t.Helper()
	upper := strings.ToUpper(ddl)
	selectIndex := strings.Index(upper, "SELECT ")
	if selectIndex < 0 {
		t.Fatalf("DDL has no SELECT clause:\n%s", ddl)
	}
	projectionStart := selectIndex + len("SELECT ")
	fromOffset := strings.Index(upper[projectionStart:], "FROM ")
	if fromOffset < 0 {
		t.Fatalf("DDL has no FROM clause:\n%s", ddl)
	}
	projection := strings.TrimSpace(ddl[projectionStart : projectionStart+fromOffset])
	if projection == "" {
		t.Fatalf("DDL has an empty projection:\n%s", ddl)
	}
	columns := strings.Split(projection, ",")
	for index := range columns {
		columns[index] = strings.TrimSpace(columns[index])
	}
	return columns
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
