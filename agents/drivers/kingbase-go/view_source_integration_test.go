package main

import (
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestKingbaseNonOwnerViewSourceIntegration(t *testing.T) {
	host := os.Getenv("KINGBASE_TEST_HOST")
	portText := os.Getenv("KINGBASE_TEST_PORT")
	username := os.Getenv("KINGBASE_TEST_USERNAME")
	if host == "" || portText == "" || username == "" {
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
	cp := connectParams{Host: host, Port: port, Database: database, Username: username, Password: os.Getenv("KINGBASE_TEST_PASSWORD")}
	if strings.HasPrefix(host, "/") {
		cp.URLParams = "sslmode=disable"
	}
	server := newServer()
	if err := server.connect(cp); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.disconnect() })
	// SET ROLE and metadata queries must share the connection for the whole test.
	server.db.SetConnMaxLifetime(0)
	rolesCatalog := "sys_catalog.sys_roles"
	if server.mode.postgresCatalog {
		rolesCatalog = "pg_catalog.pg_roles"
	}
	var superuser bool
	if err := server.requireDBQueryRow("SELECT rolsuper FROM "+rolesCatalog+" WHERE rolname = current_user", &superuser); err != nil {
		t.Fatal(err)
	}
	if !superuser {
		t.Skip("non-owner view source integration requires a superuser to create and assume an isolated test role")
	}

	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	schema := "dbx_view_src_" + suffix
	role := "dbx_view_reader_" + suffix
	view := "visible_view"
	qualifiedView := quoteIdentifier(schema) + "." + quoteIdentifier(view)
	mustExecute(t, server, "CREATE ROLE "+quoteIdentifier(role)+" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT")
	t.Cleanup(func() {
		for _, statement := range []string{
			"RESET ROLE",
			"DROP VIEW IF EXISTS " + qualifiedView,
			"DROP SCHEMA IF EXISTS " + quoteIdentifier(schema),
			"DROP ROLE IF EXISTS " + quoteIdentifier(role),
		} {
			if _, err := server.executeQuery(queryOptions{SQL: statement}); err != nil {
				t.Errorf("cleanup %s: %v", statement, err)
			}
		}
	})
	mustExecute(t, server, "CREATE SCHEMA "+quoteIdentifier(schema))
	mustExecute(t, server, "CREATE VIEW "+qualifiedView+" AS SELECT 13002 AS issue_no")
	mustExecute(t, server, "GRANT USAGE ON SCHEMA "+quoteIdentifier(schema)+" TO "+quoteIdentifier(role))
	mustExecute(t, server, "GRANT SELECT ON "+qualifiedView+" TO "+quoteIdentifier(role))

	ownerSource, err := server.getObjectSource(schema, view, "VIEW")
	if err != nil || !strings.Contains(fmt.Sprint(ownerSource["source"]), "13002") {
		t.Fatalf("owner could not read view source: source=%v err=%v", ownerSource, err)
	}
	mustExecute(t, server, "SET ROLE "+quoteIdentifier(role))
	var currentUser string
	if err := server.requireDBQueryRow("SELECT current_user", &currentUser); err != nil || currentUser != role {
		t.Fatalf("test role was not applied: current_user=%q err=%v", currentUser, err)
	}
	var value int
	if err := server.requireDBQueryRow("SELECT issue_no FROM "+qualifiedView, &value); err != nil || value != 13002 {
		t.Fatalf("non-owner cannot select from test view: value=%d err=%v", value, err)
	}
	if server.mode.mysqlCompat {
		var definition sql.NullString
		query := "SELECT view_definition FROM information_schema.views WHERE table_schema = " + quoteLiteral(schema) + " AND table_name = " + quoteLiteral(view)
		if err := server.requireDBQueryRow(query, &definition); err != nil {
			t.Fatal(err)
		}
		if definition.Valid {
			t.Fatal("expected a hidden information_schema definition for the non-owner role")
		}
		t.Log("non-owner can SELECT the view while information_schema.view_definition is NULL")
	}
	source, err := server.getObjectSource(schema, view, "VIEW")
	if err != nil || !strings.Contains(fmt.Sprint(source["source"]), "13002") {
		t.Fatalf("non-owner could not read view source: source=%v err=%v", source, err)
	}
	t.Logf("non-owner view source recovered (mysqlCompat=%v, postgresCatalog=%v)", server.mode.mysqlCompat, server.mode.postgresCatalog)
}
