package main

import (
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// spatialColumn and the corresponding per-cell SRID values are part of the
// common agent query-result protocol consumed by the desktop map preview.
type spatialColumn struct {
	ColumnIndex int     `json:"column_index"`
	SRID        *uint32 `json:"srid"`
}

type xuguRowScanner struct {
	values  []any
	targets []any
	spatial *xuguSpatialDecoder
}

func newXuguRowScanner(count int, columnTypes []string) *xuguRowScanner {
	if len(columnTypes) < count {
		expanded := make([]string, count)
		copy(expanded, columnTypes)
		columnTypes = expanded
	}
	scanner := &xuguRowScanner{
		values:  make([]any, count),
		targets: make([]any, count),
		spatial: newXuguSpatialDecoder(columnTypes),
	}
	for index := range scanner.targets {
		scanner.targets[index] = &scanner.values[index]
	}
	return scanner
}

func (scanner *xuguRowScanner) scan(rows *sql.Rows) ([]any, []*uint32, error) {
	for index := range scanner.values {
		scanner.values[index] = nil
	}
	if err := rows.Scan(scanner.targets...); err != nil {
		return nil, nil, err
	}
	result := make([]any, len(scanner.values))
	copy(result, scanner.values)
	return scanner.spatial.normalizeRow(result)
}

type xuguSpatialDecoder struct {
	columnTypes  []string
	indices      []int
	candidates   []int
	spatial      []bool
	observed     bool
	sridByColumn map[int]uint32
}

func newXuguSpatialDecoder(columnTypes []string) *xuguSpatialDecoder {
	decoder := &xuguSpatialDecoder{
		columnTypes:  columnTypes,
		spatial:      make([]bool, len(columnTypes)),
		sridByColumn: map[int]uint32{},
	}
	for index, columnType := range columnTypes {
		if isXuguSpatialColumnType(columnType) {
			decoder.indices = append(decoder.indices, index)
			decoder.spatial[index] = true
			continue
		}
		// The current Xugu Go driver leaves DatabaseTypeName empty for direct
		// GEOMETRY/GEOGRAPHY projections. Keep only those unknown columns as
		// candidates; explicit BLOB/BINARY columns are never auto-classified.
		if strings.TrimSpace(columnType) == "" {
			decoder.candidates = append(decoder.candidates, index)
		}
	}
	return decoder
}

func isXuguSpatialColumnType(columnType string) bool {
	normalized := strings.ToLower(strings.TrimSpace(columnType))
	if index := strings.LastIndexByte(normalized, '.'); index >= 0 {
		normalized = normalized[index+1:]
	}
	if index := strings.IndexByte(normalized, '('); index >= 0 {
		normalized = normalized[:index]
	}
	return normalized == "geometry" || normalized == "geography"
}

func (decoder *xuguSpatialDecoder) normalizeRow(values []any) ([]any, []*uint32, error) {
	rowSRIDs := make([]*uint32, len(values))
	for _, index := range decoder.candidates {
		if index >= len(values) || decoder.spatial[index] {
			continue
		}
		decoded, srid, recognized := decodeXuguSpatialValue(values[index])
		if !recognized {
			continue
		}
		decoder.indices = append(decoder.indices, index)
		decoder.spatial[index] = true
		decoder.columnTypes[index] = "GEOMETRY"
		values[index] = decoded
		rowSRIDs[index] = srid
		decoder.recordSRID(index, srid)
	}
	for _, index := range decoder.indices {
		if index >= len(values) || rowSRIDs[index] != nil {
			continue
		}
		decoded, srid, _ := decodeXuguSpatialValue(values[index])
		values[index] = decoded
		rowSRIDs[index] = srid
		decoder.recordSRID(index, srid)
	}
	for index, value := range values {
		if !decoder.spatial[index] {
			values[index] = normalizeValue(value)
		}
	}
	if len(decoder.indices) > 0 {
		decoder.observed = true
	}
	return values, rowSRIDs, nil
}

func (decoder *xuguSpatialDecoder) recordSRID(index int, srid *uint32) {
	if srid == nil {
		return
	}
	if _, exists := decoder.sridByColumn[index]; !exists {
		decoder.sridByColumn[index] = *srid
	}
}

func (decoder *xuguSpatialDecoder) columns() []spatialColumn {
	if !decoder.observed {
		return nil
	}
	columns := make([]spatialColumn, 0, len(decoder.indices))
	for _, index := range decoder.indices {
		var srid *uint32
		if value, found := decoder.sridByColumn[index]; found {
			srid = uint32Pointer(value)
		}
		columns = append(columns, spatialColumn{ColumnIndex: index, SRID: srid})
	}
	return columns
}

func xuguSpatialResultMetadata(scanner *xuguRowScanner, values [][]*uint32) ([]spatialColumn, [][]*uint32) {
	columns := scanner.spatial.columns()
	if len(columns) == 0 {
		return nil, nil
	}
	return columns, values
}

func finishXuguSpatialPage(result queryPageResult, scanner *xuguRowScanner, values [][]*uint32) queryPageResult {
	result.SpatialColumns, result.SpatialValues = xuguSpatialResultMetadata(scanner, values)
	return result
}

func decodeXuguSpatialValue(value any) (any, *uint32, bool) {
	if value == nil {
		return nil, nil, false
	}
	switch typed := value.(type) {
	case []byte:
		if decoded, ok := decodeXuguWKB(typed); ok {
			return decoded.WKT, decoded.SRID, true
		}
		if utf8.Valid(typed) {
			return decodeXuguSpatialText(string(typed))
		}
		return "0x" + hex.EncodeToString(typed), nil, false
	case string:
		return decodeXuguSpatialText(typed)
	default:
		return fmt.Sprint(normalizeValue(value)), nil, false
	}
}

func decodeXuguSpatialText(value string) (any, *uint32, bool) {
	if strings.HasPrefix(strings.ToUpper(value), "SRID=") {
		if separator := strings.IndexByte(value, ';'); separator > 5 {
			if parsed, err := strconv.ParseUint(value[5:separator], 10, 32); err == nil {
				srid := uint32(parsed)
				wkt := strings.TrimSpace(value[separator+1:])
				if isXuguWKT(wkt) {
					return wkt, uint32Pointer(srid), true
				}
			}
		}
	}
	if raw, ok := parseXuguSpatialHex(value); ok {
		if decoded, decodedOK := decodeXuguWKB(raw); decodedOK {
			return decoded.WKT, decoded.SRID, true
		}
	}
	// Plain WKT is valid for a declared spatial column. It is intentionally
	// not used to promote an unknown column, because free-form text can look
	// like WKT and must not change a non-spatial result's representation.
	return value, nil, false
}

func isXuguWKT(value string) bool {
	upper := strings.ToUpper(strings.TrimSpace(value))
	for _, prefix := range []string{"POINT", "LINESTRING", "POLYGON", "MULTIPOINT", "MULTILINESTRING", "MULTIPOLYGON", "GEOMETRYCOLLECTION"} {
		if strings.HasPrefix(upper, prefix+"(") || strings.HasPrefix(upper, prefix+" ") {
			return true
		}
	}
	return false
}

func parseXuguSpatialHex(value string) ([]byte, bool) {
	normalized := strings.TrimSpace(value)
	if strings.HasPrefix(normalized, "0x") || strings.HasPrefix(normalized, "0X") || strings.HasPrefix(normalized, `\x`) || strings.HasPrefix(normalized, `\X`) {
		normalized = normalized[2:]
	}
	if len(normalized) < 10 || len(normalized)%2 != 0 || (normalized[:2] != "00" && normalized[:2] != "01") {
		return nil, false
	}
	raw, err := hex.DecodeString(normalized)
	return raw, err == nil
}

func uint32Pointer(value uint32) *uint32 {
	result := value
	return &result
}

type decodedXuguWKB struct {
	WKT  string
	SRID *uint32
}

type xuguWKBDimensions struct{ z, m bool }

func (dimensions xuguWKBDimensions) size() int {
	size := 2
	if dimensions.z {
		size++
	}
	if dimensions.m {
		size++
	}
	return size
}

func (dimensions xuguWKBDimensions) suffix() string {
	if dimensions.z && dimensions.m {
		return " ZM"
	}
	if dimensions.z {
		return " Z"
	}
	if dimensions.m {
		return " M"
	}
	return ""
}

type xuguWKBReader struct {
	raw []byte
	pos int
}

func (reader *xuguWKBReader) uint32(order binary.ByteOrder) (uint32, bool) {
	if reader.pos+4 > len(reader.raw) {
		return 0, false
	}
	value := order.Uint32(reader.raw[reader.pos : reader.pos+4])
	reader.pos += 4
	return value, true
}

func (reader *xuguWKBReader) float64(order binary.ByteOrder) (float64, bool) {
	if reader.pos+8 > len(reader.raw) {
		return 0, false
	}
	value := math.Float64frombits(order.Uint64(reader.raw[reader.pos : reader.pos+8]))
	reader.pos += 8
	return value, true
}

func (reader *xuguWKBReader) byteOrder() (binary.ByteOrder, bool) {
	if reader.pos >= len(reader.raw) {
		return nil, false
	}
	value := reader.raw[reader.pos]
	reader.pos++
	if value == 0 {
		return binary.BigEndian, true
	}
	if value == 1 {
		return binary.LittleEndian, true
	}
	return nil, false
}

func decodeXuguWKB(raw []byte) (decodedXuguWKB, bool) {
	reader := &xuguWKBReader{raw: raw}
	wkt, srid, ok := reader.geometry(0)
	if !ok || reader.pos != len(raw) {
		return decodedXuguWKB{}, false
	}
	return decodedXuguWKB{WKT: wkt, SRID: srid}, true
}

func (reader *xuguWKBReader) geometry(depth int) (string, *uint32, bool) {
	if depth > 64 {
		return "", nil, false
	}
	order, ok := reader.byteOrder()
	if !ok {
		return "", nil, false
	}
	typeWord, ok := reader.uint32(order)
	if !ok {
		return "", nil, false
	}
	kind, dimensions, hasSRID := parseXuguWKBType(typeWord)
	var srid *uint32
	if hasSRID {
		value, valueOK := reader.uint32(order)
		if !valueOK {
			return "", nil, false
		}
		if value != 0 {
			srid = uint32Pointer(value)
		}
	}
	name := map[uint32]string{1: "POINT", 2: "LINESTRING", 3: "POLYGON", 4: "MULTIPOINT", 5: "MULTILINESTRING", 6: "MULTIPOLYGON", 7: "GEOMETRYCOLLECTION"}[kind]
	if name == "" {
		return "", nil, false
	}
	suffix := dimensions.suffix()
	switch kind {
	case 1:
		point, empty, pointOK := reader.point(order, dimensions)
		if !pointOK {
			return "", nil, false
		}
		if empty {
			return name + suffix + " EMPTY", srid, true
		}
		return name + suffix + "(" + point + ")", srid, true
	case 2:
		points, pointsOK := reader.points(order, dimensions)
		if !pointsOK {
			return "", nil, false
		}
		if len(points) == 0 {
			return name + suffix + " EMPTY", srid, true
		}
		return name + suffix + "(" + strings.Join(points, ",") + ")", srid, true
	case 3:
		rings, ringsOK := reader.rings(order, dimensions)
		if !ringsOK {
			return "", nil, false
		}
		if len(rings) == 0 {
			return name + suffix + " EMPTY", srid, true
		}
		return name + suffix + "(" + strings.Join(rings, ",") + ")", srid, true
	case 4, 5, 6, 7:
		count, countOK := reader.uint32(order)
		if !countOK || uint64(count)*5 > uint64(len(reader.raw)-reader.pos) {
			return "", nil, false
		}
		parts := make([]string, int(count))
		for index := range parts {
			child, _, childOK := reader.geometry(depth + 1)
			if !childOK {
				return "", nil, false
			}
			switch kind {
			case 4:
				if !strings.HasPrefix(child, "POINT"+suffix) {
					return "", nil, false
				}
				rest := strings.TrimPrefix(child, "POINT"+suffix)
				if strings.HasPrefix(rest, " EMPTY") {
					parts[index] = "EMPTY"
				} else if strings.HasPrefix(rest, "(") && strings.HasSuffix(rest, ")") {
					parts[index] = "(" + strings.TrimSuffix(strings.TrimPrefix(rest, "("), ")") + ")"
				}
			case 5:
				parts[index] = trimXuguWKBChild(child, "LINESTRING", suffix)
			case 6:
				parts[index] = trimXuguWKBChild(child, "POLYGON", suffix)
			default:
				parts[index] = child
			}
			if parts[index] == "" {
				return "", nil, false
			}
		}
		if len(parts) == 0 {
			return name + suffix + " EMPTY", srid, true
		}
		return name + suffix + "(" + strings.Join(parts, ",") + ")", srid, true
	}
	return "", nil, false
}

func trimXuguWKBChild(value, name, suffix string) string {
	prefix := name + suffix
	if !strings.HasPrefix(value, prefix+"(") || !strings.HasSuffix(value, ")") {
		return ""
	}
	return "(" + strings.TrimSuffix(strings.TrimPrefix(value, prefix+"("), ")") + ")"
}

func parseXuguWKBType(typeWord uint32) (uint32, xuguWKBDimensions, bool) {
	kind := typeWord & 0x1fffffff
	dimensions := xuguWKBDimensions{z: typeWord&0x80000000 != 0, m: typeWord&0x40000000 != 0}
	hasSRID := typeWord&0x20000000 != 0
	switch {
	case kind >= 3000:
		dimensions.z, dimensions.m, kind = true, true, kind-3000
	case kind >= 2000:
		dimensions.m, kind = true, kind-2000
	case kind >= 1000:
		dimensions.z, kind = true, kind-1000
	}
	return kind, dimensions, hasSRID
}

func (reader *xuguWKBReader) point(order binary.ByteOrder, dimensions xuguWKBDimensions) (string, bool, bool) {
	values := make([]string, dimensions.size())
	empty := true
	for index := range values {
		value, ok := reader.float64(order)
		if !ok {
			return "", false, false
		}
		empty = empty && math.IsNaN(value)
		values[index] = strconv.FormatFloat(value, 'g', -1, 64)
	}
	return strings.Join(values, " "), empty, true
}

func (reader *xuguWKBReader) points(order binary.ByteOrder, dimensions xuguWKBDimensions) ([]string, bool) {
	count, ok := reader.uint32(order)
	if !ok || uint64(count)*uint64(dimensions.size())*8 > uint64(len(reader.raw)-reader.pos) {
		return nil, false
	}
	points := make([]string, int(count))
	for index := range points {
		point, empty, pointOK := reader.point(order, dimensions)
		if !pointOK || empty {
			return nil, false
		}
		points[index] = point
	}
	return points, true
}

func (reader *xuguWKBReader) rings(order binary.ByteOrder, dimensions xuguWKBDimensions) ([]string, bool) {
	count, ok := reader.uint32(order)
	if !ok || uint64(count)*4 > uint64(len(reader.raw)-reader.pos) {
		return nil, false
	}
	rings := make([]string, int(count))
	for index := range rings {
		points, pointsOK := reader.points(order, dimensions)
		if !pointsOK {
			return nil, false
		}
		rings[index] = "(" + strings.Join(points, ",") + ")"
	}
	return rings, true
}
