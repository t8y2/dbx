package main

import (
	"encoding/hex"
	"reflect"
	"testing"
)

func TestDecodeSpatialValuesMatchesJDBCGeometryShape(t *testing.T) {
	point := mustDecodeHex(t, "0101000020E6100000C520B07268195D404E62105839F44340")
	tests := []struct {
		name  string
		value any
		wkt   any
		srid  *uint32
	}{
		{name: "raw ewkb", value: point, wkt: "POINT(116.397 39.908)", srid: uint32Pointer(4326)},
		{name: "hex ewkb", value: "0x0101000020E6100000C520B07268195D404E62105839F44340", wkt: "POINT(116.397 39.908)", srid: uint32Pointer(4326)},
		{name: "pq text bytes", value: []byte("0101000020E6100000C520B07268195D404E62105839F44340"), wkt: "POINT(116.397 39.908)", srid: uint32Pointer(4326)},
		{name: "ewkt", value: "SRID=3857;POINT(1 2)", wkt: "POINT(1 2)", srid: uint32Pointer(3857)},
		{name: "wkt", value: "POINT(1 2)", wkt: "POINT(1 2)"},
		{name: "null", value: nil, wkt: nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			wkt, srid := decodeSpatialValue(test.value)
			if !reflect.DeepEqual(wkt, test.wkt) || !reflect.DeepEqual(srid, test.srid) {
				t.Fatalf("decodeSpatialValue(%v) = (%v, %v), want (%v, %v)", test.value, wkt, srid, test.wkt, test.srid)
			}
		})
	}
}

func TestDecodeSpatialValuesSupportsComplexEWKB(t *testing.T) {
	tests := map[string]string{
		"0106000020E610000002000000010300000001000000050000000000000000005D4000000000000044400000000000405D4000000000000044400000000000405D4000000000008044400000000000005D4000000000008044400000000000005D400000000000004440010300000001000000050000000000000000805D4000000000008043400000000000C05D4000000000008043400000000000C05D4000000000000044400000000000805D4000000000000044400000000000805D400000000000804340": "MULTIPOLYGON(((116 40,117 40,117 41,116 41,116 40)),((118 39,119 39,119 40,118 40,118 39)))",
		"0107000020E61000000200000001010000000000000000005D4000000000000044400102000000020000000000000000405D4000000000008044400000000000805D400000000000004540": "GEOMETRYCOLLECTION(POINT(116 40),LINESTRING(117 41,118 42))",
	}
	for encoded, expected := range tests {
		decoded, ok := decodeWKBGeometry(mustDecodeHex(t, encoded))
		if !ok || decoded.WKT != expected || decoded.SRID == nil || *decoded.SRID != 4326 {
			t.Fatalf("unexpected complex EWKB decode: %+v ok=%v", decoded, ok)
		}
	}
}

func TestSpatialDecoderBuildsColumnAndPerCellMetadata(t *testing.T) {
	decoder := newSpatialDecoder([]string{"INT4", "public.geometry", "geography(POINT,4326)"})
	row, values, err := decoder.normalizeRow([]any{int64(1), "SRID=4326;POINT(1 2)", nil})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(row, []any{int64(1), "POINT(1 2)", nil}) {
		t.Fatalf("unexpected normalized row: %v", row)
	}
	if len(values) != 3 || values[0] != nil || values[1] == nil || *values[1] != 4326 || values[2] != nil {
		t.Fatalf("unexpected per-cell spatial metadata: %v", values)
	}
	columns := decoder.columns()
	if len(columns) != 2 || columns[0].ColumnIndex != 1 || columns[0].SRID == nil || *columns[0].SRID != 4326 || columns[1].ColumnIndex != 2 || columns[1].SRID != nil {
		t.Fatalf("unexpected spatial columns: %+v", columns)
	}
}

func TestMalformedSpatialBytesFallBackToHex(t *testing.T) {
	value, srid := decodeSpatialValue(mustDecodeHex(t, "0101000020E6100000C520B072"))
	if value != "0x0101000020e6100000c520b072" || srid != nil {
		t.Fatalf("unexpected malformed EWKB fallback: value=%v srid=%v", value, srid)
	}
}

func mustDecodeHex(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}
