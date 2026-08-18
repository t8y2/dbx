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

func TestVastbaseIntegration(t *testing.T) {
	host := os.Getenv("VASTBASE_TEST_HOST")
	portText := os.Getenv("VASTBASE_TEST_PORT")
	username := os.Getenv("VASTBASE_TEST_USERNAME")
	password := os.Getenv("VASTBASE_TEST_PASSWORD")
	if host == "" || portText == "" || username == "" || password == "" {
		t.Skip("Vastbase integration environment is not configured")
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	database := os.Getenv("VASTBASE_TEST_DATABASE")
	if database == "" {
		database = "test"
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	parent := "dbx_go_parent_" + suffix
	child := "dbx_go_child_" + suffix
	view := "dbx_go_view_" + suffix
	function := "dbx_go_fn_" + suffix
	searchFirst := "dbx_go_first_" + suffix
	searchSecond := "dbx_go_second_" + suffix
	searchTable := "DBX_GO_VISIBLE_" + suffix

	server := newServer()
	cp := connectParams{
		Host: host, Port: port, Database: database, Username: username, Password: password,
		ConnectionString: fmt.Sprintf("jdbc:vastbase://%s:%d/%s", host, port, database),
	}
	if err := server.connect(cp); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.disconnect() })
	cleanup := []string{
		"DROP SCHEMA IF EXISTS " + quoteIdentifier(searchFirst) + " CASCADE",
		"DROP SCHEMA IF EXISTS " + quoteIdentifier(searchSecond) + " CASCADE",
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
	mustExecute(t, server, "COMMENT ON TABLE public."+quoteIdentifier(parent)+" IS '订单父表'")
	mustExecute(t, server, "COMMENT ON COLUMN public."+quoteIdentifier(parent)+".id IS '主键编号'")
	mustExecute(t, server, "COMMENT ON COLUMN public."+quoteIdentifier(parent)+".name IS '客户''名称'")
	mustExecute(t, server, "CREATE TABLE public."+quoteIdentifier(child)+" (id integer PRIMARY KEY, parent_id integer REFERENCES public."+quoteIdentifier(parent)+"(id))")
	mustExecute(t, server, "CREATE INDEX "+quoteIdentifier(child+"_parent_idx")+" ON public."+quoteIdentifier(child)+"(parent_id)")
	mustExecute(t, server, "CREATE VIEW public."+quoteIdentifier(view)+" AS SELECT id, name FROM public."+quoteIdentifier(parent))
	mustExecute(t, server, "CREATE FUNCTION public."+quoteIdentifier(function)+"() RETURNS text AS $$ SELECT 'dbx'; $$ LANGUAGE SQL")
	mustExecute(t, server, "CREATE SCHEMA "+quoteIdentifier(searchFirst))
	mustExecute(t, server, "CREATE SCHEMA "+quoteIdentifier(searchSecond))
	mustExecute(t, server, "CREATE TABLE "+quoteIdentifier(searchSecond)+"."+quoteIdentifier(searchTable)+" (id integer PRIMARY KEY, name varchar(64))")
	mustExecute(t, server, "SET search_path TO "+quoteIdentifier(searchFirst)+", "+quoteIdentifier(searchSecond))
	visibleColumns, err := server.getColumns("", searchTable)
	if err != nil || len(visibleColumns) != 2 || visibleColumns[0].ResolvedSchema == nil || *visibleColumns[0].ResolvedSchema != searchSecond {
		t.Fatalf("unqualified metadata did not resolve the non-first search_path schema: columns=%#v err=%v", visibleColumns, err)
	}
	mustExecute(t, server, "INSERT INTO "+quoteIdentifier(searchTable)+" VALUES (1, 'visible')")
	mustExecute(t, server, "SET search_path TO public")

	tables, err := server.listTables("public", metadataListConstraints{Filter: suffix})
	if err != nil || len(tables) < 3 {
		t.Fatalf("list tables failed: count=%d err=%v", len(tables), err)
	}
	columns, err := server.getColumns("public", child)
	if err != nil || len(columns) != 2 || !columns[0].IsPrimaryKey {
		t.Fatalf("get columns failed: columns=%v err=%v", columns, err)
	}
	parentColumns, err := server.getColumns("public", parent)
	if err != nil || len(parentColumns) != 2 || parentColumns[0].Comment == nil || *parentColumns[0].Comment != "主键编号" || parentColumns[1].Comment == nil || *parentColumns[1].Comment != "客户'名称" {
		t.Fatalf("get commented columns failed: columns=%v err=%v", parentColumns, err)
	}
	ddl, err := server.getTableDDL("public", parent)
	if err != nil {
		t.Fatalf("get table DDL failed: %v", err)
	}
	qualifiedParent := quoteIdentifier("public") + "." + quoteIdentifier(parent)
	for _, expected := range []string{
		"COMMENT ON TABLE " + qualifiedParent + " IS '订单父表';",
		"COMMENT ON COLUMN " + qualifiedParent + "." + quoteIdentifier("id") + " IS '主键编号';",
		"COMMENT ON COLUMN " + qualifiedParent + "." + quoteIdentifier("name") + " IS '客户''名称';",
	} {
		if !strings.Contains(ddl, expected) {
			t.Fatalf("table DDL missing %q:\n%s", expected, ddl)
		}
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
		_, queryErr := server.executeQuery(queryOptions{SQL: "SELECT pg_sleep(5)", MaxRows: 1})
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

func TestVastbaseCustomTypesIntegration(t *testing.T) {
	host := os.Getenv("VASTBASE_TEST_HOST")
	portText := os.Getenv("VASTBASE_TEST_PORT")
	username := os.Getenv("VASTBASE_TEST_USERNAME")
	password := os.Getenv("VASTBASE_TEST_PASSWORD")
	if host == "" || portText == "" || username == "" || password == "" {
		t.Skip("Vastbase integration environment is not configured")
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	database := os.Getenv("VASTBASE_TEST_DATABASE")
	if database == "" {
		database = "test"
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	schema := "dbx_types_" + suffix
	schemaIdent := quoteIdentifier(schema)
	statusType := schemaIdent + "." + quoteIdentifier("status")
	emailDomain := schemaIdent + "." + quoteIdentifier("email")
	addressType := schemaIdent + "." + quoteIdentifier("address")
	ordersTable := schemaIdent + "." + quoteIdentifier("orders")

	server := newServer()
	cp := connectParams{
		Host: host, Port: port, Database: database, Username: username, Password: password,
		ConnectionString: fmt.Sprintf("jdbc:vastbase://%s:%d/%s", host, port, database),
	}
	if err := server.connect(cp); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.disconnect() })
	t.Cleanup(func() {
		_, _ = server.executeQuery(queryOptions{SQL: "DROP SCHEMA IF EXISTS " + schemaIdent + " CASCADE"})
	})

	mustExecute(t, server, "CREATE SCHEMA "+schemaIdent)

	// Detect the compatibility mode before creating any type object: MySQL
	// compatibility mode has no pg_type catalog contract and may reject type
	// syntax, so the type feature degrades to an empty group (never an error)
	// while the plain table listing keeps working.
	if server.mode.mysqlCompat {
		mustExecute(t, server, "CREATE TABLE "+ordersTable+" (id bigint, state text, ship_to text)")
		empty, err := server.listCustomTypes(schema)
		if err != nil {
			t.Fatalf("listCustomTypes failed in mysql compat mode: %v", err)
		}
		if len(empty) != 0 {
			t.Fatalf("mysql compat mode must not list types, got %#v", empty)
		}
		typeOnly, err := server.listObjects(schema, metadataListConstraints{ObjectTypes: []string{"TYPE"}})
		if err != nil {
			t.Fatalf("listObjects([TYPE]) failed in mysql compat mode: %v", err)
		}
		if len(typeOnly) != 0 {
			t.Fatalf("mysql compat mode TYPE request must be empty, got %#v", typeOnly)
		}
		all, err := server.listObjects(schema, metadataListConstraints{})
		if err != nil {
			t.Fatalf("listObjects(all) failed in mysql compat mode: %v", err)
		}
		var sawOrders bool
		for _, item := range all {
			if item.Name == "orders" && item.ObjectType == "TABLE" {
				sawOrders = true
			}
			if item.ObjectType == "TYPE" || strings.Contains(item.ObjectType, "FUNCTION") || strings.Contains(item.ObjectType, "PROCEDURE") {
				t.Fatalf("mysql compat mode must not list types or routines: %#v", all)
			}
		}
		if !sawOrders {
			t.Fatalf("orders table missing from mysql compat listing: %#v", all)
		}
		return
	}

	mustExecute(t, server, "CREATE TYPE "+statusType+" AS ENUM ('draft', 'published')")
	mustExecute(t, server, "CREATE DOMAIN "+emailDomain+" AS text CHECK (VALUE ~ '.+@.+')")
	mustExecute(t, server, "CREATE TYPE "+addressType+" AS (city text, zip text)")
	mustExecute(t, server, "COMMENT ON TYPE "+statusType+" IS '订单状态'")
	mustExecute(t, server, "CREATE TABLE "+ordersTable+" (id bigint, state "+statusType+", ship_to "+addressType+")")

	customTypes, err := server.listCustomTypes(schema)
	if err != nil {
		t.Fatalf("listCustomTypes failed: %v", err)
	}
	typeNames := make(map[string]string, len(customTypes))
	for _, item := range customTypes {
		comment := ""
		if item.Comment != nil {
			comment = *item.Comment
		}
		typeNames[item.Name] = comment
	}
	if len(customTypes) != 3 {
		t.Fatalf("expected exactly the 3 user-created types, got %#v", customTypes)
	}
	for _, name := range []string{"status", "email", "address"} {
		if _, ok := typeNames[name]; !ok {
			t.Fatalf("user-created type %q missing from listing: %#v", name, customTypes)
		}
	}
	if _, ok := typeNames["orders"]; ok {
		t.Fatalf("relation auto-generated row type leaked into type listing: %#v", customTypes)
	}
	for _, name := range []string{"_status", "_email", "_address"} {
		if _, ok := typeNames[name]; ok {
			t.Fatalf("auto-generated array type %q leaked into type listing: %#v", name, customTypes)
		}
	}
	if comment := typeNames["status"]; comment != "订单状态" {
		t.Fatalf("type comment was lost: got %q, want %q", comment, "订单状态")
	}
	for _, item := range customTypes {
		if item.ObjectType != "TYPE" {
			t.Fatalf("type object_type was lost: %#v", item)
		}
	}

	// A dedicated TYPE request must return only types.
	// The sidebar type group sends TYPE together with the TYPE_BODY companion kind.
	for _, objectTypes := range [][]string{{"TYPE"}, {"TYPE", "TYPE_BODY"}} {
		onlyTypes, err := server.listObjects(schema, metadataListConstraints{ObjectTypes: objectTypes})
		if err != nil {
			t.Fatalf("listObjects(%v) failed: %v", objectTypes, err)
		}
		if len(onlyTypes) != 3 {
			t.Fatalf("listObjects(%v) must return only the 3 types: %#v", objectTypes, onlyTypes)
		}
		for _, item := range onlyTypes {
			if item.ObjectType != "TYPE" {
				t.Fatalf("listObjects(%v) returned a non-type: %#v", objectTypes, onlyTypes)
			}
		}
	}

	// The unfiltered object list keeps the table and the types, and never
	// exposes the array companions or the relation row type.
	all, err := server.listObjects(schema, metadataListConstraints{})
	if err != nil {
		t.Fatalf("listObjects(all) failed: %v", err)
	}
	var sawOrders bool
	for _, item := range all {
		if item.Name == "orders" && item.ObjectType == "TABLE" {
			sawOrders = true
		}
		if strings.HasPrefix(item.Name, "_") {
			t.Fatalf("auto-generated array type leaked into object list: %#v", all)
		}
	}
	if !sawOrders {
		t.Fatalf("orders table missing from object list: %#v", all)
	}
}

func TestVastbaseCustomTypeDetailsIntegration(t *testing.T) {
	host := os.Getenv("VASTBASE_TEST_HOST")
	portText := os.Getenv("VASTBASE_TEST_PORT")
	username := os.Getenv("VASTBASE_TEST_USERNAME")
	password := os.Getenv("VASTBASE_TEST_PASSWORD")
	if host == "" || portText == "" || username == "" || password == "" {
		t.Skip("Vastbase integration environment is not configured")
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	database := os.Getenv("VASTBASE_TEST_DATABASE")
	if database == "" {
		database = "test"
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	schema := "dbx_details_" + suffix
	schemaIdent := quoteIdentifier(schema)
	statusType := schemaIdent + "." + quoteIdentifier("status")
	emailDomain := schemaIdent + "." + quoteIdentifier("email")
	addressType := schemaIdent + "." + quoteIdentifier("address")
	priceRangeType := schemaIdent + "." + quoteIdentifier("price_range")
	ordersTable := schemaIdent + "." + quoteIdentifier("orders")

	server := newServer()
	cp := connectParams{
		Host: host, Port: port, Database: database, Username: username, Password: password,
		ConnectionString: fmt.Sprintf("jdbc:vastbase://%s:%d/%s", host, port, database),
	}
	if err := server.connect(cp); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.disconnect() })
	t.Cleanup(func() {
		_, _ = server.executeQuery(queryOptions{SQL: "DROP SCHEMA IF EXISTS " + schemaIdent + " CASCADE"})
	})

	mustExecute(t, server, "CREATE SCHEMA "+schemaIdent)

	// MySQL compatibility mode has no pg_type contract; details must return an
	// explicit unsupported error instead of executing PG catalog SQL.
	if server.mode.mysqlCompat {
		if _, err := server.getTypeDetails(schema, "status"); err == nil || !strings.Contains(err.Error(), "MySQL compatibility mode") {
			t.Fatalf("expected MySQL compat rejection, got %v", err)
		}
		return
	}

	mustExecute(t, server, "CREATE TYPE "+statusType+" AS ENUM ('draft', 'published', '已归档')")
	mustExecute(t, server, "CREATE DOMAIN "+emailDomain+" AS text DEFAULT '' CHECK (VALUE <> '')")
	mustExecute(t, server, "CREATE TYPE "+addressType+" AS (city text, zip numeric(6))")
	mustExecute(t, server, "COMMENT ON TYPE "+addressType+" IS 'shipping address'")
	mustExecute(t, server, "COMMENT ON COLUMN "+addressType+".city IS 'city name'")
	mustExecute(t, server, "CREATE TYPE "+priceRangeType+" AS RANGE (subtype = numeric)")
	mustExecute(t, server, "CREATE TABLE "+ordersTable+" (state "+statusType+", address "+addressType+")")

	status, err := server.getTypeDetails(schema, "status")
	if err != nil {
		t.Fatalf("getTypeDetails(status) failed: %v", err)
	}
	if status.Kind != customTypeKindEnum || len(status.Members) != 3 || status.Members[0].EnumValue == nil || *status.Members[0].EnumValue != "draft" || status.Members[2].EnumValue == nil || *status.Members[2].EnumValue != "已归档" {
		t.Fatalf("unexpected enum details: %+v", status)
	}
	if status.DDL == nil || !status.DDL.Complete || !strings.Contains(status.DDL.SQL, "AS ENUM ('draft', 'published', '已归档')") {
		t.Fatalf("unexpected enum DDL: %+v", status.DDL)
	}

	email, err := server.getTypeDetails(schema, "email")
	if err != nil {
		t.Fatalf("getTypeDetails(email) failed: %v", err)
	}
	if email.Kind != customTypeKindDomain || email.Properties.BaseType == nil || *email.Properties.BaseType != "text" || len(email.Properties.DomainConstraints) == 0 {
		t.Fatalf("unexpected domain details: %+v", email)
	}

	address, err := server.getTypeDetails(schema, "address")
	if err != nil {
		t.Fatalf("getTypeDetails(address) failed: %v", err)
	}
	if address.Kind != customTypeKindComposite || len(address.Members) != 2 || address.Members[0].Name != "city" || address.Members[0].Comment == nil || *address.Members[0].Comment != "city name" {
		t.Fatalf("unexpected composite details: %+v", address)
	}

	priceRange, err := server.getTypeDetails(schema, "price_range")
	if err != nil {
		t.Fatalf("getTypeDetails(price_range) failed: %v", err)
	}
	if priceRange.Kind != customTypeKindRange || priceRange.Properties.RangeSubtype == nil || *priceRange.Properties.RangeSubtype != "numeric" {
		t.Fatalf("unexpected range details: %+v", priceRange)
	}

	if _, err := server.getTypeDetails(schema, "orders"); err == nil || !strings.Contains(err.Error(), "row type") {
		t.Fatalf("relation row type must be rejected, got %v", err)
	}
	if _, err := server.getTypeDetails(schema, "_status"); err == nil || !strings.Contains(err.Error(), "array companion") {
		t.Fatalf("array companion must be rejected, got %v", err)
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
