package main

import (
	"encoding/hex"
	"reflect"
	"testing"
)

func TestDecodeXuguSpatialValues(t *testing.T) {
	point := mustDecodeXuguHex(t, "0101000020E6100000C520B07268195D404E62105839F44340")
	tests := []struct {
		name       string
		value      any
		wantValue  any
		wantSRID   *uint32
		recognized bool
	}{
		{"raw EWKB", point, "POINT(116.397 39.908)", uint32Pointer(4326), true},
		{"hex EWKB", "0x0101000020E6100000C520B07268195D404E62105839F44340", "POINT(116.397 39.908)", uint32Pointer(4326), true},
		{"EWKT", "SRID=3857;POINT(1 2)", "POINT(1 2)", uint32Pointer(3857), true},
		{"invalid EWKT is not promoted", "SRID=3857;not a geometry", "SRID=3857;not a geometry", nil, false},
		{"WKT remains text for unknown columns", "POINT(1 2)", "POINT(1 2)", nil, false},
		{"NULL", nil, nil, nil, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value, srid, recognized := decodeXuguSpatialValue(test.value)
			if !reflect.DeepEqual(value, test.wantValue) || !reflect.DeepEqual(srid, test.wantSRID) || recognized != test.recognized {
				t.Fatalf("decodeXuguSpatialValue(%v) = (%v, %v, %v), want (%v, %v, %v)", test.value, value, srid, recognized, test.wantValue, test.wantSRID, test.recognized)
			}
		})
	}
}

func TestXuguSpatialDecoderInfersBlankGeometryTypeWithoutPromotingText(t *testing.T) {
	columnTypes := []string{"INTEGER", "", "VARCHAR"}
	decoder := newXuguSpatialDecoder(columnTypes)
	point := mustDecodeXuguHex(t, "0101000020E6100000000000000000F03F0000000000000040")
	row, values, err := decoder.normalizeRow([]any{int64(1), point, "POINT(9 9)"})
	if err != nil {
		t.Fatal(err)
	}
	if row[1] != "POINT(1 2)" || row[2] != "POINT(9 9)" {
		t.Fatalf("unexpected normalized row: %v", row)
	}
	if columnTypes[1] != "GEOMETRY" || columnTypes[2] != "VARCHAR" {
		t.Fatalf("unexpected inferred column types: %v", columnTypes)
	}
	if len(values) != 3 || values[1] == nil || *values[1] != 4326 || values[2] != nil {
		t.Fatalf("unexpected spatial cell metadata: %v", values)
	}
	columns := decoder.columns()
	if len(columns) != 1 || columns[0].ColumnIndex != 1 || columns[0].SRID == nil || *columns[0].SRID != 4326 {
		t.Fatalf("unexpected spatial columns: %+v", columns)
	}
}

func TestXuguSpatialDecoderKeepsOrdinaryBinaryColumnUntouched(t *testing.T) {
	columnTypes := []string{"BLOB", "BINARY"}
	decoder := newXuguSpatialDecoder(columnTypes)
	value := []byte{0x01, 0x02, 0x03}
	row, values, err := decoder.normalizeRow([]any{value, value})
	if err != nil {
		t.Fatal(err)
	}
	if len(decoder.indices) != 0 || len(decoder.columns()) != 0 || len(values) != 2 {
		t.Fatalf("ordinary binary values were classified as spatial: columns=%+v values=%v", decoder.columns(), values)
	}
	if row[0] != string(value) || row[1] != string(value) {
		t.Fatalf("ordinary binary values changed: %v", row)
	}
}

func TestDecodeXuguSpatialComplexEWKB(t *testing.T) {
	encoded := "0107000020E61000000200000001010000000000000000005D4000000000000044400102000000020000000000000000405D4000000000008044400000000000805D400000000000004540"
	decoded, ok := decodeXuguWKB(mustDecodeXuguHex(t, encoded))
	if !ok || decoded.WKT != "GEOMETRYCOLLECTION(POINT(116 40),LINESTRING(117 41,118 42))" || decoded.SRID == nil || *decoded.SRID != 4326 {
		t.Fatalf("unexpected complex EWKB: %+v ok=%v", decoded, ok)
	}
}

func TestMalformedXuguSpatialBytesFallBack(t *testing.T) {
	value, srid, recognized := decodeXuguSpatialValue(mustDecodeXuguHex(t, "0101000020E6100000C520B072"))
	if value != "0x0101000020e6100000c520b072" || srid != nil || recognized {
		t.Fatalf("unexpected malformed fallback: value=%v srid=%v recognized=%v", value, srid, recognized)
	}
}

func TestXuguDataTypesExposeSpatialDomainTypes(t *testing.T) {
	want := []string{"GEOMETRY", "GEOGRAPHY", "BOX2D", "BOX3D"}
	set := make(map[string]bool, len(xuguDataTypes))
	for _, value := range xuguDataTypes {
		set[value] = true
	}
	for _, value := range want {
		if !set[value] {
			t.Fatalf("spatial data type %q is not exposed", value)
		}
	}
}

func mustDecodeXuguHex(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}
