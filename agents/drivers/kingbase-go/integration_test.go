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
	schema, err := server.effectiveSchema("")
	if err != nil {
		t.Fatal(err)
	}
	qualifiedSchema := quoteIdentifier(schema)
	cleanup := []string{
		"DROP VIEW IF EXISTS " + qualifiedSchema + "." + quoteIdentifier(view),
		"DROP FUNCTION IF EXISTS " + qualifiedSchema + "." + quoteIdentifier(function) + "()",
		"DROP TABLE IF EXISTS " + qualifiedSchema + "." + quoteIdentifier(child),
		"DROP TABLE IF EXISTS " + qualifiedSchema + "." + quoteIdentifier(parent),
	}
	t.Cleanup(func() {
		for _, statement := range cleanup {
			_, _ = server.executeQuery(queryOptions{SQL: statement})
		}
	})

	mustExecute(t, server, "CREATE TABLE "+qualifiedSchema+"."+quoteIdentifier(parent)+" (id integer PRIMARY KEY, name varchar(64) NOT NULL, code character(32))")
	mustExecute(t, server, "COMMENT ON TABLE "+qualifiedSchema+"."+quoteIdentifier(parent)+" IS '订单父表'")
	mustExecute(t, server, "COMMENT ON COLUMN "+qualifiedSchema+"."+quoteIdentifier(parent)+".id IS '主键编号'")
	mustExecute(t, server, "COMMENT ON COLUMN "+qualifiedSchema+"."+quoteIdentifier(parent)+".name IS '客户''名称'")
	mustExecute(t, server, "CREATE TABLE "+qualifiedSchema+"."+quoteIdentifier(child)+" (id integer PRIMARY KEY, parent_id integer REFERENCES "+qualifiedSchema+"."+quoteIdentifier(parent)+"(id))")
	mustExecute(t, server, "CREATE INDEX "+quoteIdentifier(child+"_parent_idx")+" ON "+qualifiedSchema+"."+quoteIdentifier(child)+"(parent_id)")
	mustExecute(t, server, "CREATE VIEW "+qualifiedSchema+"."+quoteIdentifier(view)+" AS SELECT id, name FROM "+qualifiedSchema+"."+quoteIdentifier(parent))
	mustExecute(t, server, "CREATE FUNCTION "+qualifiedSchema+"."+quoteIdentifier(function)+"() RETURNS text AS $$ SELECT 'dbx'; $$ LANGUAGE SQL")

	tables, err := server.listTables(schema, metadataListConstraints{Filter: suffix})
	if err != nil || len(tables) < 3 {
		t.Fatalf("list tables failed: count=%d err=%v", len(tables), err)
	}
	columns, err := server.getColumns(schema, child)
	if err != nil || len(columns) != 2 || !columns[0].IsPrimaryKey {
		t.Fatalf("get columns failed: columns=%v err=%v", columns, err)
	}
	parentColumns, err := server.getColumns(schema, parent)
	if err != nil || len(parentColumns) != 3 || parentColumns[0].Comment == nil || *parentColumns[0].Comment != "主键编号" || parentColumns[1].Comment == nil || *parentColumns[1].Comment != "客户'名称" {
		t.Fatalf("get commented columns failed: columns=%v err=%v", parentColumns, err)
	}
	parentVarcharType := strings.ToLower(strings.TrimSpace(parentColumns[1].DataType))
	if !strings.Contains(parentVarcharType, "varchar") && !strings.Contains(parentVarcharType, "character varying") {
		t.Fatalf("varchar type metadata mismatch: column=%+v", parentColumns[1])
	}
	if parentColumns[1].CharacterMaximumLength == nil || *parentColumns[1].CharacterMaximumLength != 64 {
		actualLength := -1
		if parentColumns[1].CharacterMaximumLength != nil {
			actualLength = *parentColumns[1].CharacterMaximumLength
		}
		t.Fatalf("varchar length metadata mismatch: length=%d column=%+v", actualLength, parentColumns[1])
	}
	parentCharacterType := strings.ToLower(strings.TrimSpace(parentColumns[2].DataType))
	if ((!strings.HasPrefix(parentCharacterType, "char") && !strings.HasPrefix(parentCharacterType, "character") && parentCharacterType != "bpchar") || strings.Contains(parentCharacterType, "varying")) || parentColumns[2].CharacterMaximumLength == nil || *parentColumns[2].CharacterMaximumLength != 32 {
		t.Fatalf("character length metadata mismatch: column=%+v", parentColumns[2])
	}
	ddl, err := server.getTableDDL(schema, parent)
	if err != nil {
		t.Fatalf("get table DDL failed: %v", err)
	}
	qualifiedParent := server.quoteDDLIdentifier(schema) + "." + server.quoteDDLIdentifier(parent)
	for _, expected := range []string{
		"COMMENT ON TABLE " + qualifiedParent + " IS '订单父表';",
		"COMMENT ON COLUMN " + qualifiedParent + "." + server.quoteDDLIdentifier(parentColumns[0].Name) + " IS '主键编号';",
		"COMMENT ON COLUMN " + qualifiedParent + "." + server.quoteDDLIdentifier(parentColumns[1].Name) + " IS '客户''名称';",
	} {
		if !strings.Contains(ddl, expected) {
			t.Fatalf("table DDL missing %q:\n%s", expected, ddl)
		}
	}
	indexes, err := server.listIndexes(schema, child)
	if err != nil || len(indexes) < 2 {
		t.Fatalf("list indexes failed: indexes=%v err=%v", indexes, err)
	}
	foreignKeys, err := server.listForeignKeys(schema, child)
	if err != nil || len(foreignKeys) != 1 || foreignKeys[0].RefTable != parent {
		t.Fatalf("list foreign keys failed: keys=%v err=%v", foreignKeys, err)
	}
	source, err := server.getObjectSource(schema, function, "FUNCTION")
	if err != nil || !strings.Contains(fmt.Sprint(source["source"]), function) {
		t.Fatalf("get function source failed: source=%v err=%v", source, err)
	}
	viewSource, err := server.getObjectSource(schema, view, "VIEW")
	if err != nil || !strings.Contains(fmt.Sprint(viewSource["source"]), parent) {
		t.Fatalf("get view source failed: source=%v err=%v", viewSource, err)
	}

	transactionParams := map[string]json.RawMessage{
		"schema":     rawJSON(schema),
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

func TestKingbaseConstraintsIntegration(t *testing.T) {
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
	schema := "dbx_constraints_" + suffix
	schemaIdent := quoteIdentifier(schema)
	parent := "parent"
	child := "child"
	parentTable := schemaIdent + "." + quoteIdentifier(parent)
	childTable := schemaIdent + "." + quoteIdentifier(child)

	server := newServer()
	cp := connectParams{
		Host: host, Port: port, Database: database, Username: username, Password: password,
		ConnectionString: fmt.Sprintf("jdbc:kingbase8://%s:%d/%s", host, port, database),
	}
	if err := server.connect(cp); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.disconnect() })
	t.Cleanup(func() {
		_, _ = server.executeQuery(queryOptions{SQL: "DROP SCHEMA IF EXISTS " + schemaIdent + " CASCADE"})
	})

	mustExecute(t, server, "CREATE SCHEMA "+schemaIdent)
	mustExecute(t, server, "CREATE TABLE "+parentTable+" (a bigint NOT NULL, b bigint NOT NULL, CONSTRAINT parent_pk PRIMARY KEY (a, b))")
	mustExecute(t, server, "CREATE TABLE "+childTable+" (id bigint PRIMARY KEY, parent_a bigint, parent_b bigint, code text NOT NULL, amount int, CONSTRAINT child_parent_fk FOREIGN KEY (parent_a, parent_b) REFERENCES "+parentTable+" (a, b) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, CONSTRAINT child_code_unique UNIQUE (code), CONSTRAINT child_code_check CHECK (length(code) > 0))")

	constraints, err := server.listConstraints(schema, child)
	if err != nil {
		t.Fatalf("list constraints failed in %s mode: %v", server.mode.compatibilityMode, err)
	}
	byName := map[string]constraintInfo{}
	for _, constraint := range constraints {
		byName[constraint.Name] = constraint
	}
	pk := byName["child_pkey"]
	if pk.ConstraintType != "PRIMARY KEY" || len(pk.Columns) != 1 || pk.Columns[0] != "id" {
		t.Fatalf("primary key metadata mismatch in %s mode: %+v", server.mode.compatibilityMode, pk)
	}
	fk := byName["child_parent_fk"]
	if fk.ConstraintType != "FOREIGN KEY" || !equalStringSlices(fk.Columns, []string{"parent_a", "parent_b"}) || !equalStringSlices(fk.RefColumns, []string{"a", "b"}) || fk.RefSchema == nil || *fk.RefSchema != schema || fk.RefTable == nil || *fk.RefTable != parent || fk.OnDelete == nil || *fk.OnDelete != "CASCADE" || !fk.Deferrable || !fk.InitiallyDeferred {
		t.Fatalf("foreign key metadata mismatch in %s mode: %+v", server.mode.compatibilityMode, fk)
	}
	unique := byName["child_code_unique"]
	if unique.ConstraintType != "UNIQUE" || !equalStringSlices(unique.Columns, []string{"code"}) {
		t.Fatalf("unique metadata mismatch in %s mode: %+v", server.mode.compatibilityMode, unique)
	}
	check := byName["child_code_check"]
	if check.ConstraintType != "CHECK" || !equalStringSlices(check.Columns, []string{"code"}) || !strings.Contains(check.Definition, "length(code) > 0") || !check.Enabled {
		t.Fatalf("check metadata mismatch in %s mode: %+v", server.mode.compatibilityMode, check)
	}
	foreignKeys, err := server.listForeignKeys(schema, child)
	if err != nil {
		t.Fatalf("list foreign keys failed in %s mode: %v", server.mode.compatibilityMode, err)
	}
	foreignKeyNames := map[string]struct{}{}
	for _, foreignKey := range foreignKeys {
		foreignKeyNames[foreignKey.Name] = struct{}{}
	}
	constraintForeignKeyNames := map[string]struct{}{}
	for _, constraint := range constraints {
		if constraint.ConstraintType == "FOREIGN KEY" {
			constraintForeignKeyNames[constraint.Name] = struct{}{}
		}
	}
	if len(foreignKeyNames) != len(constraintForeignKeyNames) {
		t.Fatalf("foreign-key metadata sources disagree in %s mode: constraints=%v foreign_keys=%v", server.mode.compatibilityMode, constraintForeignKeyNames, foreignKeyNames)
	}
	for name := range foreignKeyNames {
		if _, ok := constraintForeignKeyNames[name]; !ok {
			t.Fatalf("foreign-key %q missing from list_constraints in %s mode", name, server.mode.compatibilityMode)
		}
	}
	if server.mode.compatibilityMode == "oracle" {
		mustExecute(t, server, "ALTER TABLE "+childTable+" DISABLE CONSTRAINT child_code_check")
		disabled, err := server.listConstraints(schema, child)
		if err != nil {
			t.Fatalf("list disabled constraints failed in %s mode: %v", server.mode.compatibilityMode, err)
		}
		var disabledCheck constraintInfo
		found := false
		for _, constraint := range disabled {
			if constraint.Name == "child_code_check" {
				disabledCheck = constraint
				found = true
				break
			}
		}
		if !found || disabledCheck.Enabled {
			t.Fatalf("disabled constraint state mismatch in %s mode: %+v", server.mode.compatibilityMode, disabledCheck)
		}
		mustExecute(t, server, "ALTER TABLE "+childTable+" ENABLE CONSTRAINT child_code_check")
	}
	parentConstraints, err := server.listConstraints(schema, parent)
	if err != nil {
		t.Fatalf("list parent constraints failed in %s mode: %v", server.mode.compatibilityMode, err)
	}
	if len(parentConstraints) != 1 || parentConstraints[0].Name != "parent_pk" || !equalStringSlices(parentConstraints[0].Columns, []string{"a", "b"}) {
		t.Fatalf("composite primary key order mismatch in %s mode: %+v", server.mode.compatibilityMode, parentConstraints)
	}
}

func equalStringSlices(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestKingbaseCustomTypesIntegration(t *testing.T) {
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
	schema := "dbx_types_" + suffix
	schemaIdent := quoteIdentifier(schema)
	statusType := schemaIdent + "." + quoteIdentifier("status")
	emailDomain := schemaIdent + "." + quoteIdentifier("email")
	addressType := schemaIdent + "." + quoteIdentifier("address")
	ordersTable := schemaIdent + "." + quoteIdentifier("orders")

	server := newServer()
	cp := connectParams{
		Host: host, Port: port, Database: database, Username: username, Password: password,
		ConnectionString: fmt.Sprintf("jdbc:kingbase8://%s:%d/%s", host, port, database),
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

func TestKingbaseCustomTypeDetailsIntegration(t *testing.T) {
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
		ConnectionString: fmt.Sprintf("jdbc:kingbase8://%s:%d/%s", host, port, database),
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
	if status.Kind != customTypeKindEnum || len(status.Members) != 3 {
		t.Fatalf("unexpected enum details: %+v", status)
	}
	if status.Members[0].EnumValue == nil || *status.Members[0].EnumValue != "draft" || status.Members[2].EnumValue == nil || *status.Members[2].EnumValue != "已归档" {
		t.Fatalf("enum values out of order: %+v", status.Members)
	}
	if status.DDL == nil || !status.DDL.Complete || !strings.Contains(status.DDL.SQL, "AS ENUM ('draft', 'published', '已归档')") {
		t.Fatalf("unexpected enum DDL: %+v", status.DDL)
	}

	email, err := server.getTypeDetails(schema, "email")
	if err != nil {
		t.Fatalf("getTypeDetails(email) failed: %v", err)
	}
	if email.Kind != customTypeKindDomain || email.Properties.BaseType == nil || *email.Properties.BaseType != "text" {
		t.Fatalf("unexpected domain details: %+v", email)
	}
	if len(email.Properties.DomainConstraints) == 0 || !strings.Contains(email.Properties.DomainConstraints[0].Definition, "VALUE") {
		t.Fatalf("domain constraint lost: %+v", email.Properties.DomainConstraints)
	}

	address, err := server.getTypeDetails(schema, "address")
	if err != nil {
		t.Fatalf("getTypeDetails(address) failed: %v", err)
	}
	if address.Kind != customTypeKindComposite || len(address.Members) != 2 || address.Members[0].Name != "city" || address.Members[0].Comment == nil || *address.Members[0].Comment != "city name" {
		t.Fatalf("unexpected composite details: %+v", address)
	}
	if address.DDL == nil || !address.DDL.Complete || !strings.Contains(address.DDL.SQL, "COMMENT ON COLUMN "+schemaIdent+".\"address\".\"city\" IS 'city name';") {
		t.Fatalf("unexpected composite DDL: %+v", address.DDL)
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
