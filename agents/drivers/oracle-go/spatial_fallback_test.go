package main

import (
	"database/sql/driver"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// spatialUnavailableErr is the error a server without a usable Oracle Spatial
// installation raises from SDO_UTIL.TO_WKTGEOMETRY (issue #13827).
var spatialUnavailableErr = errors.New(`ORA-04067: not executed, type body "MDSYS.SDO_GEOMETRY" does not exist
ORA-06508: PL/SQL: could not find program unit being called: "MDSYS.SDO_GEOMETRY"
ORA-06512: at "MDSYS.SDO_UTIL", line 318
 error occur at position: 839`)

const sdoGeometryPlaceholderProjection = `SELECT "ID", CASE WHEN "GEOM" IS NULL THEN NULL ELSE '<SDO_GEOMETRY>' END AS "GEOM" FROM "T_GEOM"`

func TestIsOracleSpatialUnavailable(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "missing SDO_GEOMETRY type body", err: spatialUnavailableErr, want: true},
		{name: "ORA-06508 alone", err: errors.New(`ORA-06508: PL/SQL: could not find program unit being called: "MDSYS.SDO_UTIL"`), want: true},
		{name: "lowercase", err: errors.New(`ora-04067: not executed, package body "mdsys.sdo_util" does not exist`), want: true},
		{name: "wrapped", err: fmt.Errorf("query failed: %w", spatialUnavailableErr), want: true},
		{name: "ORA-04067 outside MDSYS", err: errors.New(`ORA-04067: not executed, package body "APP.PKG" does not exist`), want: false},
		{name: "Spatial error about one geometry", err: errors.New(`ORA-13199: wk buffer merge failure
ORA-06512: at "MDSYS.SDO_UTIL", line 318`), want: false},
		{name: "unrelated ORA error", err: errors.New("ORA-00942: table or view does not exist"), want: false},
		{name: "nil error", err: nil, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isOracleSpatialUnavailable(tc.err); got != tc.want {
				t.Fatalf("isOracleSpatialUnavailable(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestOracleGeometryFunctionFallbackSQLKeepsOtherValueRewrites(t *testing.T) {
	loadColumns := func(schema, table string) ([]oracleColumnMeta, error) {
		return []oracleColumnMeta{
			{Name: "ID", DataType: "NUMBER"},
			{Name: "GEOM", DataType: "SDO_GEOMETRY", DataTypeOwner: "MDSYS"},
			{Name: "DOC", DataType: "XMLTYPE", DataTypeOwner: "SYS"},
			{Name: "NOTE", DataType: "CLOB"},
		}, nil
	}
	got, ok := oracleGeometryFunctionFallbackSQL(`SELECT * FROM "T_GEOM"`, loadColumns, spatialUnavailableErr)
	if !ok {
		t.Fatal("expected a placeholder fallback for a server without Oracle Spatial")
	}
	want := `SELECT "ID", CASE WHEN "GEOM" IS NULL THEN NULL ELSE '<SDO_GEOMETRY>' END AS "GEOM", XMLSERIALIZE(CONTENT "DOC" AS CLOB) AS "DOC", "NOTE" FROM "T_GEOM"`
	if got != want {
		t.Fatalf("fallback SQL = %s\nwant %s", got, want)
	}
	if _, ok := oracleGeometryFunctionFallbackSQL(`SELECT * FROM "T_GEOM"`, loadColumns, errors.New("ORA-01013: user requested cancel of current operation")); ok {
		t.Fatal("unrelated errors must keep the value rewrite error")
	}
}

func TestExecuteOracleSelectFallsBackWhenValueRewriteCannotConvertGeometry(t *testing.T) {
	originalSQL := `SELECT * FROM "T_GEOM"`
	rewrittenSQL := `SELECT "ID", SDO_UTIL.TO_WKTGEOMETRY("GEOM") AS "GEOM" FROM "T_GEOM"`
	run := func(placeholderErr error) ([]string, queryResult, error) {
		calls := []string{}
		result, err := executeOracleSelectWithXMLTypeRetry(
			originalSQL,
			func(sqlText string) (queryResult, error) {
				calls = append(calls, sqlText)
				switch sqlText {
				case originalSQL:
					return queryResult{}, errors.New("TTC error: received code 3 during response reading")
				case rewrittenSQL:
					return queryResult{}, spatialUnavailableErr
				default:
					if placeholderErr != nil {
						return queryResult{}, placeholderErr
					}
					return queryResult{Columns: []string{"ID", "GEOM"}, Rows: [][]any{{"1", "<SDO_GEOMETRY>"}}}, nil
				}
			},
			func(string) (string, error) { return rewrittenSQL, nil },
			func(sqlText string, err error) (string, bool) {
				if sqlText != originalSQL || !errors.Is(err, spatialUnavailableErr) {
					t.Fatalf("fallback(%q, %v): want the original SQL and the rewrite error", sqlText, err)
				}
				return sdoGeometryPlaceholderProjection, true
			},
		)
		return calls, result, err
	}

	calls, result, err := run(nil)
	if err != nil {
		t.Fatalf("expected the placeholder projection to serve rows, got %v", err)
	}
	if !reflect.DeepEqual(calls, []string{originalSQL, rewrittenSQL, sdoGeometryPlaceholderProjection}) {
		t.Fatalf("execute calls = %#v", calls)
	}
	if !reflect.DeepEqual(result.Rows, [][]any{{"1", "<SDO_GEOMETRY>"}}) {
		t.Fatalf("unexpected rows: %#v", result.Rows)
	}

	_, _, err = run(errors.New("ORA-01013: user requested cancel of current operation"))
	if !errors.Is(err, spatialUnavailableErr) {
		t.Fatalf("a failing placeholder must keep the rewrite error, got %v", err)
	}
}

func sdoGeometryMetadataStep(schema string) oracleViewSourceQueryStep {
	return oracleViewSourceQueryStep{
		queryContains: "ALL_TAB_COLUMNS",
		args:          []driver.Value{schema, "T_GEOM"},
		columns:       []string{"COLUMN_NAME", "DATA_TYPE", "DATA_TYPE_OWNER"},
		rows:          [][]driver.Value{{"ID", "NUMBER", nil}, {"GEOM", "SDO_GEOMETRY", "MDSYS"}},
	}
}

// sdoGeometrySpatialUnavailableSteps scripts a SELECT whose geometry cannot be
// decoded, followed by a WKT rewrite that the server cannot run.
func sdoGeometrySpatialUnavailableSteps() []oracleViewSourceQueryStep {
	return []oracleViewSourceQueryStep{
		{exec: true, queryContains: `ALTER SESSION SET CURRENT_SCHEMA = "DBXT"`},
		{queryContains: `SELECT * FROM "T_GEOM"`, args: []driver.Value{}, err: errors.New("TTC error: received code 3 during response reading")},
		{exec: true, queryContains: `ALTER SESSION SET CURRENT_SCHEMA = "DBXT"`},
		{queryContains: "CURRENT_SCHEMA", args: []driver.Value{}, columns: []string{"SCHEMA"}, rows: [][]driver.Value{{"DBXT"}}},
		sdoGeometryMetadataStep("DBXT"),
		{queryContains: `SDO_UTIL.TO_WKTGEOMETRY("GEOM") AS "GEOM"`, args: []driver.Value{}, err: spatialUnavailableErr},
		{queryContains: "CURRENT_SCHEMA", args: []driver.Value{}, columns: []string{"SCHEMA"}, rows: [][]driver.Value{{"DBXT"}}},
		sdoGeometryMetadataStep("DBXT"),
		{
			queryContains: sdoGeometryPlaceholderProjection,
			args:          []driver.Value{},
			columns:       []string{"ID", "GEOM"},
			rows:          [][]driver.Value{{int64(1), nil}, {int64(2), "<SDO_GEOMETRY>"}},
		},
	}
}

func TestExecuteQueryFallsBackToGeometryPlaceholderWithoutOracleSpatial(t *testing.T) {
	steps := sdoGeometrySpatialUnavailableSteps()
	db, scripted := openGuardedOracleViewSourceTestDB(t, steps)
	s := newServer()
	s.db = db
	result, err := s.executeQuery(queryOptions{SQL: `SELECT * FROM "T_GEOM"`, Schema: "DBXT", MaxRows: 10})
	if err != nil {
		t.Fatalf("expected the geometry placeholder to serve rows, got %v", err)
	}
	if !reflect.DeepEqual(result.Rows, [][]any{{int64(1), nil}, {int64(2), "<SDO_GEOMETRY>"}}) {
		t.Fatalf("unexpected rows: %#v", result.Rows)
	}
	if scripted.next != len(steps) {
		t.Fatalf("expected all %d scripted steps, ran %d", len(steps), scripted.next)
	}
}

func TestExecuteQueryPageFallsBackToGeometryPlaceholderWithoutOracleSpatial(t *testing.T) {
	steps := sdoGeometrySpatialUnavailableSteps()
	db, scripted := openGuardedOracleViewSourceTestDB(t, steps)
	s := newServer()
	s.db = db
	result, err := s.executeQueryPage(queryOptions{SQL: `SELECT * FROM "T_GEOM"`, Schema: "DBXT", MaxRows: 10}, 10)
	if err != nil {
		t.Fatalf("expected the geometry placeholder to serve the first page, got %v", err)
	}
	if !reflect.DeepEqual(result.Rows, [][]any{{int64(1), nil}, {int64(2), "<SDO_GEOMETRY>"}}) || result.HasMore {
		t.Fatalf("unexpected page: %+v", result)
	}
	if scripted.next != len(steps) {
		t.Fatalf("expected all %d scripted steps, ran %d", len(steps), scripted.next)
	}
	if s.statementConn != nil || s.repinnedStatementConn != nil || db.Stats().InUse != 0 {
		t.Fatalf("statement leaked its pinned connections: %+v", db.Stats())
	}
}

func TestOracleLockingSelectFallsBackToGeometryPlaceholderWithoutOracleSpatial(t *testing.T) {
	sqlText := `SELECT * FROM DBXT.T_GEOM FOR UPDATE`
	db, scripted := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
		sdoGeometryMetadataStep("DBXT"),
		{queryContains: `SDO_UTIL.TO_WKTGEOMETRY("GEOM") AS "GEOM"`, args: []driver.Value{}, err: spatialUnavailableErr},
		sdoGeometryMetadataStep("DBXT"),
		{
			queryContains: `SELECT "ID", CASE WHEN "GEOM" IS NULL THEN NULL ELSE '<SDO_GEOMETRY>' END AS "GEOM" FROM DBXT.T_GEOM FOR UPDATE`,
			args:          []driver.Value{},
			columns:       []string{"ID", "GEOM"},
			rows:          [][]driver.Value{{int64(1), "<SDO_GEOMETRY>"}},
		},
	})
	s := newServer()
	s.db = db
	rows, err := s.queryRowsWithOracleValueRewriteIfNeeded(sqlText, 0, false)
	if err != nil {
		t.Fatalf("expected the geometry placeholder to serve rows, got %v", err)
	}
	defer rows.Close()
	if scripted.next != len(scripted.steps) {
		t.Fatalf("expected all %d scripted steps, ran %d", len(scripted.steps), scripted.next)
	}
	if !rows.Next() {
		t.Fatalf("expected one placeholder row, got %v", rows.Err())
	}
	var id int64
	var geom string
	if err := rows.Scan(&id, &geom); err != nil {
		t.Fatal(err)
	}
	if id != 1 || geom != "<SDO_GEOMETRY>" {
		t.Fatalf("unexpected placeholder row: %v %v", id, geom)
	}
}

func TestOracleQueryRowsKeepsSpatialErrorForOtherGeometryFailures(t *testing.T) {
	singleGeometryErr := errors.New(`ORA-13199: wk buffer merge failure
ORA-06512: at "MDSYS.SDO_UTIL", line 318`)
	db, scripted := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
		sdoGeometryMetadataStep("DBXT"),
		{queryContains: `SDO_UTIL.TO_WKTGEOMETRY("GEOM") AS "GEOM"`, args: []driver.Value{}, err: singleGeometryErr},
	})
	s := newServer()
	s.db = db
	rows, err := s.queryRowsWithOracleValueRewriteIfNeeded(`SELECT * FROM DBXT.T_GEOM FOR UPDATE`, 0, false)
	if rows != nil {
		t.Fatal("failed rewrite must not return rows")
	}
	if !errors.Is(err, singleGeometryErr) && (err == nil || !strings.Contains(err.Error(), "ORA-13199")) {
		t.Fatalf("expected the ORA-13199 rewrite error, got %v", err)
	}
	if scripted.next != len(scripted.steps) {
		t.Fatalf("expected no placeholder retry, ran %d of %d steps", scripted.next, len(scripted.steps))
	}
}
