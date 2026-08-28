package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// TestLiveXuguSpatialQueryRegression exercises the value path used by the
// desktop map preview against a real Xugu server. It is opt-in because CI does
// not provide a Xugu service. The test deliberately covers both GEOMETRY and
// GEOGRAPHY columns, explicit SRIDs, EWKT input, and the multi-geometry types
// rendered by the shared map preview.
func TestLiveXuguSpatialQueryRegression(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* connection settings to run the XuguDB integration test")
	}
	params := liveXuguParams(t)
	s := newServer()
	db, err := openDB(params)
	if err != nil {
		t.Fatal(err)
	}
	s.db = db
	s.params = params
	s.currentDatabase = params.Database
	defer s.disconnect()

	const table = "DBX_SPATIAL_VALUE_LIVE_T"
	_ = s.execWithReconnect("DROP TABLE IF EXISTS " + table)
	defer func() { _ = s.execWithReconnect("DROP TABLE IF EXISTS " + table) }()

	for _, statement := range []string{
		"CREATE TABLE " + table + " (ID INTEGER, G_POINT GEOMETRY, G_MULTI GEOMETRY, G_MULTI_LINE GEOMETRY, G_COLLECTION GEOMETRY, G_GEO GEOGRAPHY)",
		"INSERT INTO " + table + " VALUES (1, ST_GeomFromEWKT('SRID=4326;POINT(116.397 39.908)'), ST_GeomFromEWKT('SRID=3857;MULTIPOINT((1 2),(3 4))'), ST_GeomFromEWKT('SRID=4326;MULTILINESTRING((0 0,1 1),(2 2,3 3))'), ST_GeomFromEWKT('SRID=4326;GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(3 4,5 6))'), ST_GeomFromEWKT('SRID=4326;POINT(116.397 39.908)'))",
		"INSERT INTO " + table + " VALUES (2, ST_GeomFromText('LINESTRING(0 0,1 1,2 2)', 0), ST_GeomFromText('MULTIPOLYGON(((0 0,0 1,1 1,0 0)))', 4326), ST_GeomFromText('MULTILINESTRING((4 4,5 5),(6 6,7 7))', 4326), ST_GeomFromText('POLYGON((0 0,0 1,1 1,0 0))', 4326), ST_GeomFromText('POINT(10 20)', 4326))",
	} {
		if err := s.execWithReconnect(statement); err != nil {
			t.Fatalf("setup statement failed: %s: %v", statement, err)
		}
	}

	result, err := s.executeSelect("SELECT ID, G_POINT, G_MULTI, G_MULTI_LINE, G_COLLECTION, G_GEO FROM "+table+" ORDER BY ID", 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 2 {
		t.Fatalf("row count = %d, want 2: %#v", len(result.Rows), result.Rows)
	}
	// The current Go driver reports direct GEOGRAPHY projections without a
	// DatabaseTypeName. The decoder deliberately classifies a valid spatial
	// payload as GEOMETRY in that case. This is sufficient for the shared map
	// preview (which accepts GEOMETRY and GEOGRAPHY), while catalog metadata
	// still exposes the source column as GEOGRAPHY.
	wantTypes := []string{"INTEGER", "GEOMETRY", "GEOMETRY", "GEOMETRY", "GEOMETRY", "GEOMETRY"}
	for i, want := range wantTypes {
		if i >= len(result.ColumnTypes) || !strings.EqualFold(result.ColumnTypes[i], want) {
			t.Fatalf("column %d type = %#v, want %s (columns=%#v)", i, result.ColumnTypes, want, result.Columns)
		}
	}
	if len(result.SpatialColumns) != 5 {
		t.Fatalf("spatial column metadata = %#v, want five geometry/geography columns", result.SpatialColumns)
	}
	for rowIndex, row := range result.Rows {
		for _, columnIndex := range []int{1, 2, 3, 4, 5} {
			if row[columnIndex] == nil {
				t.Fatalf("row %d column %d unexpectedly NULL: %#v", rowIndex, columnIndex, row)
			}
			if !isXuguWKT(fmt.Sprint(row[columnIndex])) {
				t.Fatalf("row %d column %d was not decoded as WKT: %#v", rowIndex, columnIndex, row[columnIndex])
			}
		}
	}
	if len(result.SpatialValues) != 2 || len(result.SpatialValues[0]) != 6 {
		t.Fatalf("spatial cell metadata shape = %#v", result.SpatialValues)
	}
	if result.SpatialValues[0][1] == nil || *result.SpatialValues[0][1] != 4326 || result.SpatialValues[0][5] == nil || *result.SpatialValues[0][5] != 4326 {
		t.Fatalf("row 1 SRIDs = %#v, want geometry/geography SRID 4326", result.SpatialValues[0])
	}
	if result.SpatialValues[0][2] == nil || *result.SpatialValues[0][2] != 3857 {
		t.Fatalf("row 1 multipoint SRID = %#v, want 3857", result.SpatialValues[0][2])
	}
	raw, err := s.executeSelect("SELECT ST_AsBinary(G_POINT), ST_AsEWKB(G_POINT), ST_AsEWKT(G_GEO), ST_AsEWKB(G_MULTI), ST_AsEWKB(G_COLLECTION) FROM "+table+" WHERE ID = 1", 20, 0)
	if err != nil {
		t.Fatalf("WKB/EWKB/EWKT query failed: %v", err)
	}
	if len(raw.Rows) != 1 || len(raw.Rows[0]) != 5 {
		t.Fatalf("unexpected WKB/EWKB/EWKT result: %#v", raw)
	}
	for columnIndex, wantSRID := range map[int]*uint32{0: nil, 1: uint32Pointer(4326)} {
		bytes, ok := raw.Rows[0][columnIndex].(string)
		if !ok {
			t.Fatalf("raw WKB column %d type = %T, want binary string", columnIndex, raw.Rows[0][columnIndex])
		}
		decoded, decodedOK := decodeXuguWKB([]byte(bytes))
		if !decodedOK || !isXuguWKT(decoded.WKT) || (wantSRID == nil && decoded.SRID != nil) || (wantSRID != nil && (decoded.SRID == nil || *decoded.SRID != *wantSRID)) {
			t.Fatalf("raw WKB column %d decoded as value=%#v ok=%v", columnIndex, decoded, decodedOK)
		}
	}
	decodedEWKT, sridEWKT, recognizedEWKT := decodeXuguSpatialValue(raw.Rows[0][2])
	if !recognizedEWKT || decodedEWKT != "POINT(116.397 39.908)" || sridEWKT == nil || *sridEWKT != 4326 {
		t.Fatalf("EWKT column decoded as value=%#v srid=%#v recognized=%v", decodedEWKT, sridEWKT, recognizedEWKT)
	}
	for columnIndex, want := range map[int]struct {
		wkt  string
		srid uint32
	}{
		3: {wkt: "MULTIPOINT((1 2),(3 4))", srid: 3857},
		4: {wkt: "GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(3 4,5 6))", srid: 4326},
	} {
		bytes, ok := raw.Rows[0][columnIndex].(string)
		if !ok {
			t.Fatalf("complex EWKB column %d type = %T, want binary string", columnIndex, raw.Rows[0][columnIndex])
		}
		decoded, decodedOK := decodeXuguWKB([]byte(bytes))
		if !decodedOK || decoded.WKT != want.wkt || decoded.SRID == nil || *decoded.SRID != want.srid {
			t.Fatalf("complex EWKB column %d decoded as value=%#v ok=%v", columnIndex, decoded, decodedOK)
		}
	}
	t.Logf("Xugu WKB/EWKB/EWKT result: types=%#v columns=%#v rows=%#v spatialColumns=%#v spatialValues=%#v", raw.ColumnTypes, raw.Columns, raw.Rows, raw.SpatialColumns, raw.SpatialValues)
	t.Logf("decoded Xugu spatial result: columns=%#v types=%#v spatialColumns=%#v values=%#v rows=%#v", result.Columns, result.ColumnTypes, result.SpatialColumns, result.SpatialValues, result.Rows)
}

// TestLiveXuguSpatialReplay probes the literal form generated by the generic
// export path. Xugu accepts WKT constructors for replay; the test records
// whether a plain quoted WKT is accepted so export code can remain database
// specific instead of guessing from PostgreSQL syntax.
func TestLiveXuguSpatialReplay(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* connection settings to run the XuguDB integration test")
	}
	params := liveXuguParams(t)
	s := newServer()
	db, err := openDB(params)
	if err != nil {
		t.Fatal(err)
	}
	s.db = db
	s.params = params
	s.currentDatabase = params.Database
	defer s.disconnect()

	const table = "DBX_SPATIAL_REPLAY_LIVE_T"
	_ = s.execWithReconnect("DROP TABLE IF EXISTS " + table)
	defer func() { _ = s.execWithReconnect("DROP TABLE IF EXISTS " + table) }()
	for _, statement := range []string{
		"CREATE TABLE " + table + " (ID INTEGER, G GEOMETRY, GEO GEOGRAPHY)",
		"INSERT INTO " + table + " VALUES (1, ST_GeomFromEWKT('SRID=4326;POINT(1 2)'), ST_GeomFromEWKT('SRID=4326;POINT(3 4)'))",
	} {
		if err := s.execWithReconnect(statement); err != nil {
			t.Fatalf("setup statement failed: %s: %v", statement, err)
		}
	}
	if err := s.execWithReconnect("INSERT INTO " + table + " VALUES (2, 'POINT(5 6)', 'POINT(7 8)')"); err != nil {
		t.Logf("plain quoted WKT is rejected by Xugu (expected on typed spatial columns): %v", err)
	} else {
		t.Log("plain quoted WKT is accepted by Xugu typed spatial columns")
	}
	if err := s.execWithReconnect("INSERT INTO " + table + " VALUES (3, ST_GeomFromEWKT('SRID=3857;POINT(9 10)'), ST_GeomFromEWKT('SRID=4326;POINT(11 12)'))"); err != nil {
		t.Fatalf("Xugu spatial constructor replay failed: %v", err)
	}
	result, err := s.executeSelect("SELECT ID, ST_AsEWKT(G), ST_AsEWKT(GEO) FROM "+table+" ORDER BY ID", 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) < 2 {
		t.Fatalf("spatial replay returned too few rows: %#v", result.Rows)
	}
	t.Logf("Xugu spatial replay result: types=%#v rows=%#v", result.ColumnTypes, result.Rows)
}

func liveXuguParams(t *testing.T) connectParams {
	t.Helper()
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
	return params
}
