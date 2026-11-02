package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPLDebugOracleTypeReferenceKeepsPackageContainerAndQuotedIdentity(t *testing.T) {
	owner, pack, name := "Owner Name", "Pack.With.Dot", "Record.Type"
	ref, err := plDebugNativeArgumentTypeRef(plDebugNativeArgument{TypeOwner: &owner, TypeName: &pack, TypeSubname: &name})
	if err != nil || ref.Owner != owner || ref.PackageName == nil || *ref.PackageName != pack || ref.TypeName != name || ref.declaration() != `"Owner Name"."Pack.With.Dot"."Record.Type"` {
		t.Fatalf("wrong package mapping: %+v %v", ref, err)
	}
	ref, err = plDebugNativeArgumentTypeRef(plDebugNativeArgument{TypeOwner: &owner, TypeName: &name})
	if err != nil || ref.PackageName != nil || ref.TypeName != name {
		t.Fatalf("wrong schema type mapping: %+v %v", ref, err)
	}
	if _, err = plDebugNativeArgumentTypeRef(plDebugNativeArgument{TypeName: &name}); err == nil {
		t.Fatal("incomplete identity accepted")
	}
}

func TestPLDebugOracleTypeReferenceProofSeparatesDeniedAccessFromTransportAndCancellation(t *testing.T) {
	for _, test := range []struct {
		name      string
		failure   error
		cancelled bool
		state     string
		code      int
		wantError bool
	}{
		{"verified", nil, false, "type_only_verified", 0, false},
		{"denied", errors.New("ORA-01031: insufficient privileges"), false, "type_only_failed", 1031, false},
		{"compile", errors.New("ORA-06550: declaration is not visible"), false, "type_only_failed", 6550, false},
		{"disconnected", errors.New("ORA-03113: end-of-file on communication channel"), false, "", 0, true},
		{"bad-connection", driver.ErrBadConn, false, "", 0, true},
		{"cancelled", nil, true, "", 0, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			connector := &plDebugConnectTestConnector{execErr: test.failure}
			db := sql.OpenDB(connector)
			defer db.Close()
			conn, err := db.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if test.cancelled {
				cancel()
			}
			access, err := plDebugNativeCheckTypeReference(ctx, conn, plDebugNativeTypeRef{Owner: "S", TypeName: "T"})
			if (err != nil) != test.wantError || access.State != test.state {
				t.Fatalf("wrong proof result: %+v %v", access, err)
			}
			if test.code != 0 && (access.VendorCode == nil || *access.VendorCode != test.code) {
				t.Fatal("Oracle denial code lost")
			}
			if connector.connects != 1 || connector.execs > 1 || test.cancelled && connector.execs != 0 {
				t.Fatal("reference proof replayed or dispatched after cancellation")
			}
		})
	}
}

func TestPLDebugOracleTypeReferenceLateDriverSuccessCannotPublishAfterCancellation(t *testing.T) {
	connector := &plDebugConnectTestConnector{execStarted: make(chan struct{}), execRelease: make(chan struct{})}
	db := sql.OpenDB(connector)
	defer db.Close()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		access, e := plDebugNativeCheckTypeReference(ctx, conn, plDebugNativeTypeRef{Owner: "S", TypeName: "T"})
		if access.State != "" {
			done <- errors.New("late reference proof was published")
			return
		}
		done <- e
	}()
	select {
	case <-connector.execStarted:
	case <-time.After(time.Second):
		close(connector.execRelease)
		t.Fatal("reference preparation did not start")
	}
	cancel()
	close(connector.execRelease)
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("late success did not preserve cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("late reference preparation did not return")
	}
	if connector.connects != 1 || connector.execs != 1 {
		t.Fatal("late reference preparation was replayed")
	}
}

type plDebugGraphTestConnector struct {
	rawMetadata            []byte
	base                   plDebugConnectTestConnector
	sourceReads            int
	changed                bool
	queries                []string
	objectMode             bool
	subtypeReads           int
	membershipChanged      bool
	argumentDetails        bool
	scalarArgument         string
	nationalCharset        string
	argumentReads          int
	argumentChanged        bool
	incompleteSource       bool
	objectField            bool
	emptyNullStrings       bool
	dictionaryVersion      [2]sql.NullInt64
	dictionaryVersionError error
	dictionaryVersionCalls int
}

func (c *plDebugGraphTestConnector) Driver() driver.Driver { return c.base.Driver() }
func (c *plDebugGraphTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	raw, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugGraphTestConnection{raw.(*plDebugConnectTestConnection), c}, nil
}

type plDebugGraphTestConnection struct {
	*plDebugConnectTestConnection
	graph *plDebugGraphTestConnector
}

func (*plDebugGraphTestConnection) CheckNamedValue(*driver.NamedValue) error { return nil }

func (c *plDebugGraphTestConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if !strings.Contains(query, "SYS.DBMS_DB_VERSION.VERSION") {
		return c.plDebugConnectTestConnection.ExecContext(ctx, query, args)
	}
	c.graph.dictionaryVersionCalls++
	if c.graph.dictionaryVersionError != nil {
		return nil, c.graph.dictionaryVersionError
	}
	if len(args) != 2 {
		return nil, errors.New("expected dictionary version outputs")
	}
	for i := range args {
		if err := plDebugManagerSetOut(args[i], c.graph.dictionaryVersion[i]); err != nil {
			return nil, err
		}
	}
	return driver.RowsAffected(1), nil
}

func (c *plDebugGraphTestConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if query == "raw metadata" {
		return &plDebugRawMetadataTestRows{&plDebugTargetTestRows{columns: []string{"TYPE_OID", "TEXT", "NULL_VALUE"}, rows: [][]driver.Value{{c.graph.rawMetadata, "中文", nil}}}}, nil
	}
	c.graph.queries = append(c.graph.queries, query)
	var columns []string
	var rows [][]driver.Value
	switch {
	case strings.Contains(query, "FROM NLS_DATABASE_PARAMETERS"):
		columns = []string{"VALUE"}
		if c.graph.nationalCharset != "" {
			rows = [][]driver.Value{{c.graph.nationalCharset}}
		}
	case strings.Contains(query, "FROM SYS.ALL_ARGUMENTS") && c.graph.argumentDetails:
		c.graph.argumentReads++
		columns = []string{"ARGUMENT_NAME", "POSITION", "SEQUENCE", "DATA_LEVEL", "IN_OUT", "DATA_TYPE", "TYPE_OWNER", "TYPE_NAME", "TYPE_SUBNAME", "DEFAULTED", "PLS_TYPE", "CHAR_USED", "DATA_LENGTH", "TYPE_LINK"}
		rows = [][]driver.Value{{"X", "1", "1", "0", "IN", "PL/SQL RECORD", "S", "P", "R", "N", nil, "C", "40", nil}}
		if c.graph.scalarArgument != "" {
			rows[0][5] = c.graph.scalarArgument
			rows[0][6], rows[0][7], rows[0][8] = nil, nil, nil
		}
		if c.graph.argumentChanged && c.graph.argumentReads > 1 {
			rows[0][12] = "80"
		}
	case strings.Contains(query, "FROM SYS.ALL_OBJECTS"):
		columns = []string{"OBJECT_ID", "OBJECT_TYPE", "STATUS", "LAST_DDL_TIME"}
		kind := args[2].Value.(string)
		rows = [][]driver.Value{{"42", kind, "VALID", "2026-10-24 00:00:00"}, {"43", kind + " BODY", "VALID", "2026-10-24 00:00:00"}}
	case strings.Contains(query, "FROM SYS.ALL_SOURCE"):
		c.graph.sourceReads++
		text := "PACKAGE P AS TYPE R IS RECORD(N NUMBER); END;"
		if c.graph.changed && c.graph.sourceReads > 1 {
			text += " -- changed"
		}
		columns = []string{"TYPE", "LINE", "TEXT"}
		rows = [][]driver.Value{{"PACKAGE", "1", text}, {"PACKAGE BODY", "1", "PACKAGE BODY P AS END;"}}
		if c.graph.incompleteSource {
			rows[0][1] = "2"
		}
		if c.graph.objectMode || c.graph.objectField && args[2].Value == "TYPE" {
			rows = [][]driver.Value{{"TYPE", "1", "TYPE " + args[1].Value.(string) + " AS OBJECT(N NUMBER)"}, {"TYPE BODY", "1", "TYPE BODY " + args[1].Value.(string) + " AS END;"}}
		}
	case strings.Contains(query, "FROM SYS.ALL_TYPES") && strings.Contains(query, "WHERE SUPERTYPE_OWNER"):
		c.graph.subtypeReads++
		columns = []string{"OWNER", "TYPE_NAME"}
		rows = [][]driver.Value{{"S", "SUB"}}
		if c.graph.membershipChanged && c.graph.subtypeReads > 1 {
			rows = nil
		}
	case strings.Contains(query, "FROM SYS.ALL_TYPES"):
		columns = []string{"TYPE_NAME", "TYPECODE", "FINAL", "SUPERTYPE_OWNER", "SUPERTYPE_NAME"}
		if args[1].Value == "BASE" {
			rows = [][]driver.Value{{"BASE", "OBJECT", "NO", nil, nil}}
		} else {
			rows = [][]driver.Value{{"SUB", "OBJECT", "YES", "S", "BASE"}}
		}
	case strings.Contains(query, "FROM SYS.ALL_TYPE_ATTRS"):
		if !strings.HasSuffix(query, " ORDER BY ATTR_NO") {
			return nil, errors.New("object attribute ordinal ordering missing")
		}
		columns = []string{"ATTR_NAME", "ATTR_TYPE_OWNER", "ATTR_TYPE_NAME", "ATTR_TYPE_PACKAGE", "ATTR_NO"}
		rows = [][]driver.Value{{"N", nil, "NUMBER", nil, "1"}}
	case strings.Contains(query, "FROM SYS.ALL_COLL_TYPES"):
		columns = []string{"COLL_TYPE"}
	case strings.Contains(query, "FROM SYS.ALL_TYPE_METHODS"):
		columns = []string{"METHOD_NAME", "METHOD_NO", "METHOD_TYPE"}
		rows = [][]driver.Value{{args[1].Value, "1", "CONSTRUCTOR"}}
	case strings.Contains(query, "FROM SYS.ALL_METHOD_PARAMS"):
		columns = []string{"METHOD_NO", "PARAM_NO", "PARAM_NAME", "PARAM_TYPE_NAME"}
		rows = [][]driver.Value{{"1", "1", "N", "NUMBER"}}
	case strings.Contains(query, "FROM SYS.ALL_PLSQL_TYPES"):
		columns = []string{"TYPE_NAME", "TYPECODE"}
		kind := "PL/SQL RECORD"
		if args[1].Value == "IA" {
			kind = "COLLECTION"
		}
		rows = [][]driver.Value{{args[1].Value, kind}}
	case strings.Contains(query, "FROM SYS.ALL_PLSQL_TYPE_ATTRS"):
		if !strings.HasSuffix(query, " ORDER BY ATTR_NO") {
			return nil, errors.New("attribute ordinal ordering missing")
		}
		columns = []string{"ATTR_NAME", "ATTR_TYPE_OWNER", "ATTR_TYPE_NAME", "ATTR_TYPE_PACKAGE", "ATTR_NO", "PRECISION", "SCALE", "CHAR_USED"}
		if args[1].Value == "R" {
			rows = [][]driver.Value{{"N", nil, "NUMBER", nil, "1", "20", "4", "B"}, {"T", nil, "VARCHAR2", nil, "2", nil, nil, "C"}, {"B", nil, "PL/SQL BOOLEAN", nil, "3", nil, nil, "B"}}
			if c.graph.objectField {
				rows = append(rows, []driver.Value{"O", "S", "BASE", nil, "4", nil, nil, nil})
			}
		}
	case strings.Contains(query, "FROM SYS.ALL_PLSQL_COLL_TYPES"):
		columns = []string{"COLL_TYPE", "ELEM_TYPE_OWNER", "ELEM_TYPE_NAME", "ELEM_TYPE_PACKAGE", "INDEX_BY"}
		if args[1].Value == "IA" {
			rows = [][]driver.Value{{"PL/SQL INDEX TABLE", "S", "R", "P", "BINARY_INTEGER"}}
		}
	default:
		return nil, errors.New("unexpected graph SQL")
	}
	if c.graph.emptyNullStrings {
		for _, row := range rows {
			for i, value := range row {
				if value == nil {
					row[i] = ""
				}
			}
		}
	}
	return &plDebugTargetTestRows{columns: columns, rows: rows}, nil
}

type plDebugRawMetadataTestRows struct{ *plDebugTargetTestRows }

func (*plDebugRawMetadataTestRows) ColumnTypeDatabaseTypeName(index int) string {
	if index == 0 {
		return "RAW"
	}
	return "VARCHAR2"
}

func TestPLDebugTypeMetadataRawIdentitySurvivesJSON(t *testing.T) {
	connector := &plDebugGraphTestConnector{rawMetadata: []byte{0xff, 0, 'A'}}
	db := sql.OpenDB(connector)
	defer db.Close()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	loader := plDebugNativeTypeLoader{ctx: context.Background(), conn: conn}
	first, err := loader.query("raw metadata")
	if err != nil {
		t.Fatal(err)
	}
	if first[0].text("TYPE_OID") != "FF0041" || first[0].text("TEXT") != "中文" || first[0]["NULL_VALUE"] != nil || loader.bytes != 12 {
		t.Fatalf("metadata encoding or budget changed: %+v, bytes=%d", first, loader.bytes)
	}
	encoded, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	var frozen []plDebugNativeMetadataRow
	if err = json.Unmarshal(encoded, &frozen); err != nil {
		t.Fatal(err)
	}
	current, err := loader.query("raw metadata")
	if err != nil || !reflect.DeepEqual(frozen, current) {
		t.Fatalf("identity changed after JSON: %v", err)
	}
	connector.rawMetadata = []byte("AB")
	changed, err := loader.query("raw metadata")
	if err != nil || changed[0].text("TYPE_OID") != "4142" || reflect.DeepEqual(frozen, changed) {
		t.Fatalf("changed RAW identity lost: %v", err)
	}
	loader.bytes = 1048576 - 5
	if _, err = loader.query("raw metadata"); err == nil || !strings.Contains(err.Error(), "byte budget") {
		t.Fatalf("encoded budget not enforced: %v", err)
	}
}

func TestPLDebugOracleObjectTypeGraphFreezesInheritanceAndSubtypeMembership(t *testing.T) {
	for _, changed := range []bool{false, true} {
		connector := &plDebugGraphTestConnector{objectMode: true, membershipChanged: changed}
		db := sql.OpenDB(connector)
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		graph, err := plDebugLoadNativeTypeGraph(context.Background(), conn, []plDebugNativeTypeRef{{Owner: "S", TypeName: "BASE"}})
		conn.Close()
		db.Close()
		if changed {
			if err == nil || !strings.Contains(err.Error(), "subtype membership changed") {
				t.Fatalf("changed membership accepted: %v", err)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(graph.Nodes) != 2 || len(graph.Versions) != 2 || graph.Nodes[1].Definition.text("SUPERTYPE_NAME") != "BASE" || len(graph.Nodes[0].Methods) != 1 || len(graph.Nodes[0].MethodParameters) != 1 {
			t.Fatalf("incomplete object graph: %+v", graph)
		}
		if connector.subtypeReads != 2 {
			t.Fatal("subtype membership not rechecked")
		}
	}
}

func TestPLDebugOraclePackageTypeGraphFreezesNestedMetadataAndRejectsSourceChange(t *testing.T) {
	for _, changed := range []bool{false, true} {
		connector := &plDebugGraphTestConnector{changed: changed}
		db := sql.OpenDB(connector)
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		pack := "P"
		root := plDebugNativeTypeRef{Owner: "S", PackageName: &pack, TypeName: "IA"}
		graph, err := plDebugLoadNativeTypeGraph(context.Background(), conn, []plDebugNativeTypeRef{root, root})
		conn.Close()
		db.Close()
		if changed {
			if err == nil || !strings.Contains(err.Error(), "source changed") {
				t.Fatalf("changed source accepted: %v", err)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(graph.Nodes) != 2 || len(graph.Versions) != 1 || len(graph.Nodes[1].Attributes) != 3 {
			t.Fatalf("wrong closure: %+v", graph)
		}
		attrs := graph.Nodes[1].Attributes
		if attrs[0].text("ATTR_NAME") != "N" || attrs[1].text("ATTR_NAME") != "T" || attrs[2].text("ATTR_NAME") != "B" || attrs[1]["PRECISION"] != nil || attrs[1].text("CHAR_USED") != "C" {
			t.Fatal("field order, NULL or character semantics lost")
		}
		if connector.sourceReads != 2 {
			t.Fatal("source version was not revalidated")
		}
	}
}
