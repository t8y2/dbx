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

func TestKingbaseIntegration(t *testing.T) {
	host := os.Getenv("KINGBASE_TEST_HOST")
	portText := os.Getenv("KINGBASE_TEST_PORT")
	username := os.Getenv("KINGBASE_TEST_USERNAME")
	password := os.Getenv("KINGBASE_TEST_PASSWORD")
	if host == "" || portText == "" || username == "" || password == "" {
		t.Skip("Kingbase integration environment is not configured")
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	database := os.Getenv("KINGBASE_TEST_DATABASE")
	if database == "" {
		database = "test"
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	parent := "dbx_go_parent_" + suffix
	child := "dbx_go_child_" + suffix
	view := "dbx_go_view_" + suffix
	function := "dbx_go_fn_" + suffix

	server := newServer()
	cp := connectParams{
		Host: host, Port: port, Database: database, Username: username, Password: password,
		ConnectionString: fmt.Sprintf("jdbc:kingbase8://%s:%d/%s", host, port, database),
	}
	if err := server.connect(cp); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.disconnect() })
	cleanup := []string{
		"DROP VIEW IF EXISTS public." + quoteIdentifier(view),
		"DROP FUNCTION IF EXISTS public." + quoteIdentifier(function) + "()",
		"DROP TABLE IF EXISTS public." + quoteIdentifier(child),
		"DROP TABLE IF EXISTS public." + quoteIdentifier(parent),
	}
	t.Cleanup(func() {
		for _, statement := range cleanup {
			_, _ = server.executeQuery(queryOptions{SQL: statement})
		}
	})

	mustExecute(t, server, "CREATE TABLE public."+quoteIdentifier(parent)+" (id integer PRIMARY KEY, name varchar(64) NOT NULL)")
	mustExecute(t, server, "CREATE TABLE public."+quoteIdentifier(child)+" (id integer PRIMARY KEY, parent_id integer REFERENCES public."+quoteIdentifier(parent)+"(id))")
	mustExecute(t, server, "CREATE INDEX "+quoteIdentifier(child+"_parent_idx")+" ON public."+quoteIdentifier(child)+"(parent_id)")
	mustExecute(t, server, "CREATE VIEW public."+quoteIdentifier(view)+" AS SELECT id, name FROM public."+quoteIdentifier(parent))
	mustExecute(t, server, "CREATE FUNCTION public."+quoteIdentifier(function)+"() RETURNS text AS $$ SELECT 'dbx'; $$ LANGUAGE SQL")

	tables, err := server.listTables("public", metadataListConstraints{Filter: suffix})
	if err != nil || len(tables) < 3 {
		t.Fatalf("list tables failed: count=%d err=%v", len(tables), err)
	}
	columns, err := server.getColumns("public", child)
	if err != nil || len(columns) != 2 || !columns[0].IsPrimaryKey {
		t.Fatalf("get columns failed: columns=%v err=%v", columns, err)
	}
	indexes, err := server.listIndexes("public", child)
	if err != nil || len(indexes) < 2 {
		t.Fatalf("list indexes failed: indexes=%v err=%v", indexes, err)
	}
	foreignKeys, err := server.listForeignKeys("public", child)
	if err != nil || len(foreignKeys) != 1 || foreignKeys[0].RefTable != parent {
		t.Fatalf("list foreign keys failed: keys=%v err=%v", foreignKeys, err)
	}
	source, err := server.getObjectSource("public", function, "FUNCTION")
	if err != nil || !strings.Contains(fmt.Sprint(source["source"]), function) {
		t.Fatalf("get function source failed: source=%v err=%v", source, err)
	}

	transactionParams := map[string]json.RawMessage{
		"schema":     rawJSON("public"),
		"statements": rawJSON([]string{"INSERT INTO " + quoteIdentifier(parent) + " VALUES (1, 'one')", "INSERT INTO " + quoteIdentifier(child) + " VALUES (1, 1)"}),
	}
	if _, err := server.executeTransaction(transactionParams); err != nil {
		t.Fatal(err)
	}
	page, err := server.executeQueryPage(queryOptions{SQL: "SELECT generate_series(1, 250)", MaxRows: 250}, 100)
	if err != nil || !page.HasMore || page.SessionID == nil || len(page.Rows) != 100 {
		t.Fatalf("first page failed: page=%v err=%v", page, err)
	}
	second, err := server.fetchQueryPage(*page.SessionID, 100)
	if err != nil || !second.HasMore || len(second.Rows) != 100 {
		t.Fatalf("second page failed: page=%v err=%v", second, err)
	}
	third, err := server.fetchQueryPage(*page.SessionID, 100)
	if err != nil || third.HasMore || len(third.Rows) != 50 {
		t.Fatalf("third page failed: page=%v err=%v", third, err)
	}

	cancelStart := time.Now()
	cancelResult := make(chan error, 1)
	go func() {
		_, queryErr := server.executeQuery(queryOptions{SQL: "SELECT sys_sleep(5)", MaxRows: 1})
		cancelResult <- queryErr
	}()
	time.Sleep(200 * time.Millisecond)
	server.cancelActiveQuery()
	if queryErr := <-cancelResult; queryErr == nil {
		t.Fatal("cancel_session did not interrupt the active query")
	}
	if elapsed := time.Since(cancelStart); elapsed > 3*time.Second {
		t.Fatalf("query cancellation was too slow: %s", elapsed)
	}
	if err := server.validateConnection(); err != nil {
		t.Fatalf("connection was not reusable after cancellation: %v", err)
	}
}

func rawJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return json.RawMessage(data)
}

func mustExecute(t *testing.T, server *server, statement string) {
	t.Helper()
	if _, err := server.executeQuery(queryOptions{SQL: statement}); err != nil {
		t.Fatalf("execute %q: %v", statement, err)
	}
}
