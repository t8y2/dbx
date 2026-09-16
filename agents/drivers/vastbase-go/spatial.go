package main

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

type spatialColumn struct {
	ColumnIndex int     `json:"column_index"`
	SRID        *uint32 `json:"srid"`
}

type spatialDecoder struct {
	indices      []int
	spatial      []bool
	observed     bool
	sridByColumn map[int]uint32
}

func newSpatialDecoder(columnTypes []string) *spatialDecoder {
	indices := make([]int, 0, len(columnTypes))
	for index, columnType := range columnTypes {
		if isSpatialColumnType(columnType) {
			indices = append(indices, index)
		}
	}
	if len(indices) == 0 {
		return nil
	}
	spatial := make([]bool, len(columnTypes))
	for _, index := range indices {
		spatial[index] = true
	}
	return &spatialDecoder{indices: indices, spatial: spatial, sridByColumn: map[int]uint32{}}
}

func isSpatialColumnType(columnType string) bool {
	normalized := strings.ToLower(strings.TrimSpace(columnType))
	if index := strings.LastIndexByte(normalized, '.'); index >= 0 {
		normalized = normalized[index+1:]
	}
	if index := strings.IndexByte(normalized, '('); index >= 0 {
		normalized = normalized[:index]
	}
	return normalized == "geometry" || normalized == "geography"
}

func (decoder *spatialDecoder) normalizeRow(values []any) ([]any, []*uint32, error) {
	rowSRIDs := make([]*uint32, len(values))
	decoder.observed = true
	for _, index := range decoder.indices {
		if index >= len(values) {
			continue
		}
		value, srid := decodeSpatialValue(values[index])
		values[index] = value
		rowSRIDs[index] = srid
		if srid != nil {
			if _, exists := decoder.sridByColumn[index]; !exists {
				decoder.sridByColumn[index] = *srid
			}
		}
	}
	for index, value := range values {
		if index >= len(decoder.spatial) || !decoder.spatial[index] {
			values[index] = normalizeValue(value)
		}
	}
	return values, rowSRIDs, nil
}

func (decoder *spatialDecoder) columns() []spatialColumn {
	if decoder == nil || !decoder.observed {
		return nil
	}
	columns := make([]spatialColumn, 0, len(decoder.indices))
	for _, index := range decoder.indices {
		var srid *uint32
		if value, ok := decoder.sridByColumn[index]; ok {
			srid = uint32Pointer(value)
		}
		columns = append(columns, spatialColumn{ColumnIndex: index, SRID: srid})
	}
	return columns
}

func spatialResultMetadata(decoder *spatialDecoder, values [][]*uint32) ([]spatialColumn, [][]*uint32) {
	columns := decoder.columns()
	if len(columns) == 0 {
		return nil, nil
	}
	return columns, values
}

func finishSpatialPage(result queryPageResult, decoder *spatialDecoder, values [][]*uint32) queryPageResult {
	result.SpatialColumns, result.SpatialValues = spatialResultMetadata(decoder, values)
	return result
}

func decodeSpatialValue(value any) (any, *uint32) {
	if value == nil {
		return nil, nil
	}
	switch typed := value.(type) {
	case []byte:
		if decoded, ok := decodeWKBGeometry(typed); ok {
			return decoded.WKT, decoded.SRID
		}
		if utf8.Valid(typed) {
			return decodeSpatialText(string(typed))
		}
		return "0x" + hex.EncodeToString(typed), nil
	case string:
		return decodeSpatialText(typed)
	default:
		return decodeSpatialText(fmt.Sprint(value))
	}
}

func decodeSpatialText(value string) (any, *uint32) {
	if len(value) >= 7 && strings.EqualFold(value[:5], "SRID=") {
		if separator := strings.IndexByte(value[5:], ';'); separator >= 0 {
			separator += 5
			if parsed, err := strconv.ParseInt(value[5:separator], 10, 32); err == nil {
				var srid *uint32
				if parsed > 0 {
					srid = uint32Pointer(uint32(parsed))
				}
				return value[separator+1:], srid
			}
		}
	}
	raw, ok := parseSpatialHex(value)
	if !ok {
		return value, nil
	}
	if decoded, decodedOK := decodeWKBGeometry(raw); decodedOK {
		return decoded.WKT, decoded.SRID
	}
	if strings.HasPrefix(value, "0x") || strings.HasPrefix(value, "0X") {
		return value, nil
	}
	return "0x" + value, nil
}

func parseSpatialHex(value string) ([]byte, bool) {
	normalized := value
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

type decodedWKBGeometry struct {
	WKT  string
	SRID *uint32
}

type wkbDimensions struct {
	hasZ bool
	hasM bool
}

func (dimensions wkbDimensions) suffix() string {
	switch {
	case dimensions.hasZ && dimensions.hasM:
		return " ZM"
	case dimensions.hasZ:
		return " Z"
	case dimensions.hasM:
		return " M"
	default:
		return ""
	}
}

func (dimensions wkbDimensions) coordinateLength() int {
	length := 2
	if dimensions.hasZ {
		length++
	}
	if dimensions.hasM {
		length++
	}
	return length
}

type wkbGeometry struct {
	kind       uint32
	dimensions wkbDimensions
	coords     []float64
	points     [][]float64
	rings      [][][]float64
	multiPoint []wkbPoint
	polygons   [][][][]float64
	children   []wkbGeometry
}

type wkbPoint struct {
	coords []float64
	empty  bool
}

func (geometry wkbGeometry) wkt() string {
	suffix := geometry.dimensions.suffix()
	switch geometry.kind {
	case 1:
		if geometry.coords == nil {
			return "POINT" + suffix + " EMPTY"
		}
		return "POINT" + suffix + "(" + formatWKBCoordinate(geometry.coords) + ")"
	case 2:
		if len(geometry.points) == 0 {
			return "LINESTRING" + suffix + " EMPTY"
		}
		return "LINESTRING" + suffix + "(" + formatWKBCoordinateSequence(geometry.points) + ")"
	case 3:
		if len(geometry.rings) == 0 {
			return "POLYGON" + suffix + " EMPTY"
		}
		return "POLYGON" + suffix + "(" + formatWKBRings(geometry.rings) + ")"
	case 4:
		if len(geometry.multiPoint) == 0 {
			return "MULTIPOINT" + suffix + " EMPTY"
		}
		parts := make([]string, len(geometry.multiPoint))
		for index, point := range geometry.multiPoint {
			if point.empty {
				parts[index] = "EMPTY"
			} else {
				parts[index] = "(" + formatWKBCoordinate(point.coords) + ")"
			}
		}
		return "MULTIPOINT" + suffix + "(" + strings.Join(parts, ",") + ")"
	case 5:
		if len(geometry.rings) == 0 {
			return "MULTILINESTRING" + suffix + " EMPTY"
		}
		return "MULTILINESTRING" + suffix + "(" + formatWKBRings(geometry.rings) + ")"
	case 6:
		if len(geometry.polygons) == 0 {
			return "MULTIPOLYGON" + suffix + " EMPTY"
		}
		parts := make([]string, len(geometry.polygons))
		for index, polygon := range geometry.polygons {
			parts[index] = "(" + formatWKBRings(polygon) + ")"
		}
		return "MULTIPOLYGON" + suffix + "(" + strings.Join(parts, ",") + ")"
	case 7:
		if len(geometry.children) == 0 {
			return "GEOMETRYCOLLECTION" + suffix + " EMPTY"
		}
		parts := make([]string, len(geometry.children))
		for index, child := range geometry.children {
			parts[index] = child.wkt()
		}
		return "GEOMETRYCOLLECTION" + suffix + "(" + strings.Join(parts, ",") + ")"
	default:
		return ""
	}
}

func formatWKBCoordinate(coordinates []float64) string {
	values := make([]string, len(coordinates))
	for index, value := range coordinates {
		switch {
		case math.IsInf(value, 1):
			values[index] = "inf"
		case math.IsInf(value, -1):
			values[index] = "-inf"
		default:
			values[index] = strconv.FormatFloat(value, 'g', -1, 64)
		}
	}
	return strings.Join(values, " ")
}

func formatWKBCoordinateSequence(points [][]float64) string {
	values := make([]string, len(points))
	for index, point := range points {
		values[index] = formatWKBCoordinate(point)
	}
	return strings.Join(values, ",")
}

func formatWKBRings(rings [][][]float64) string {
	values := make([]string, len(rings))
	for index, ring := range rings {
		values[index] = "(" + formatWKBCoordinateSequence(ring) + ")"
	}
	return strings.Join(values, ",")
}

type wkbReader struct {
	raw      []byte
	position int
}

func (reader *wkbReader) readByte() (byte, bool) {
	if reader.position >= len(reader.raw) {
		return 0, false
	}
	value := reader.raw[reader.position]
	reader.position++
	return value, true
}

func (reader *wkbReader) readUint32(order binary.ByteOrder) (uint32, bool) {
	end := reader.position + 4
	if end > len(reader.raw) {
		return 0, false
	}
	value := order.Uint32(reader.raw[reader.position:end])
	reader.position = end
	return value, true
}

func (reader *wkbReader) readFloat64(order binary.ByteOrder) (float64, bool) {
	end := reader.position + 8
	if end > len(reader.raw) {
		return 0, false
	}
	value := math.Float64frombits(order.Uint64(reader.raw[reader.position:end]))
	reader.position = end
	return value, true
}

func (reader *wkbReader) remaining() int {
	return len(reader.raw) - reader.position
}

func parseWKBType(typeWord uint32) (uint32, wkbDimensions, bool) {
	baseType := typeWord & 0x1fffffff
	dimensions := wkbDimensions{hasZ: typeWord&0x80000000 != 0, hasM: typeWord&0x40000000 != 0}
	hasSRID := typeWord&0x20000000 != 0
	switch {
	case baseType >= 3000:
		dimensions.hasZ = true
		dimensions.hasM = true
		baseType -= 3000
	case baseType >= 2000:
		dimensions.hasM = true
		baseType -= 2000
	case baseType >= 1000:
		dimensions.hasZ = true
		baseType -= 1000
	}
	return baseType, dimensions, hasSRID
}

func readWKBOrder(reader *wkbReader) (binary.ByteOrder, bool) {
	value, ok := reader.readByte()
	if !ok {
		return nil, false
	}
	switch value {
	case 0:
		return binary.BigEndian, true
	case 1:
		return binary.LittleEndian, true
	default:
		return nil, false
	}
}

func parseWKBPoints(reader *wkbReader, order binary.ByteOrder, dimensions wkbDimensions) ([][]float64, bool) {
	count, ok := reader.readUint32(order)
	if !ok {
		return nil, false
	}
	coordinateLength := dimensions.coordinateLength()
	required := uint64(count) * uint64(coordinateLength) * 8
	if required > uint64(reader.remaining()) {
		return nil, false
	}
	points := make([][]float64, int(count))
	for pointIndex := range points {
		coordinates := make([]float64, coordinateLength)
		for coordinateIndex := range coordinates {
			value, valueOK := reader.readFloat64(order)
			if !valueOK {
				return nil, false
			}
			coordinates[coordinateIndex] = value
		}
		points[pointIndex] = coordinates
	}
	return points, true
}

func readWKBPoint(reader *wkbReader, expected wkbDimensions, depth int) (wkbPoint, bool) {
	geometry, _, ok := parseWKBGeometry(reader, depth+1)
	if !ok || geometry.kind != 1 || geometry.dimensions != expected {
		return wkbPoint{}, false
	}
	return wkbPoint{coords: geometry.coords, empty: geometry.coords == nil}, true
}

func parseWKBGeometry(reader *wkbReader, depth int) (wkbGeometry, *uint32, bool) {
	if depth > 64 {
		return wkbGeometry{}, nil, false
	}
	order, ok := readWKBOrder(reader)
	if !ok {
		return wkbGeometry{}, nil, false
	}
	typeWord, ok := reader.readUint32(order)
	if !ok {
		return wkbGeometry{}, nil, false
	}
	baseType, dimensions, hasSRID := parseWKBType(typeWord)
	var srid *uint32
	if hasSRID {
		value, valueOK := reader.readUint32(order)
		if !valueOK {
			return wkbGeometry{}, nil, false
		}
		if value != 0 {
			srid = uint32Pointer(value)
		}
	}
	geometry := wkbGeometry{kind: baseType, dimensions: dimensions}
	switch baseType {
	case 1:
		coordinates := make([]float64, dimensions.coordinateLength())
		allNaN := true
		for index := range coordinates {
			value, valueOK := reader.readFloat64(order)
			if !valueOK {
				return wkbGeometry{}, nil, false
			}
			coordinates[index] = value
			allNaN = allNaN && math.IsNaN(value)
		}
		if !allNaN {
			geometry.coords = coordinates
		}
	case 2:
		points, pointsOK := parseWKBPoints(reader, order, dimensions)
		if !pointsOK {
			return wkbGeometry{}, nil, false
		}
		geometry.points = points
	case 3:
		count, countOK := reader.readUint32(order)
		if !countOK || uint64(count)*4 > uint64(reader.remaining()) {
			return wkbGeometry{}, nil, false
		}
		geometry.rings = make([][][]float64, int(count))
		for index := range geometry.rings {
			ring, ringOK := parseWKBPoints(reader, order, dimensions)
			if !ringOK {
				return wkbGeometry{}, nil, false
			}
			geometry.rings[index] = ring
		}
	case 4:
		count, countOK := reader.readUint32(order)
		if !countOK || uint64(count)*5 > uint64(reader.remaining()) {
			return wkbGeometry{}, nil, false
		}
		geometry.multiPoint = make([]wkbPoint, int(count))
		for index := range geometry.multiPoint {
			point, pointOK := readWKBPoint(reader, dimensions, depth)
			if !pointOK {
				return wkbGeometry{}, nil, false
			}
			geometry.multiPoint[index] = point
		}
	case 5:
		count, countOK := reader.readUint32(order)
		if !countOK || uint64(count)*5 > uint64(reader.remaining()) {
			return wkbGeometry{}, nil, false
		}
		geometry.rings = make([][][]float64, int(count))
		for index := range geometry.rings {
			child, _, childOK := parseWKBGeometry(reader, depth+1)
			if !childOK || child.kind != 2 {
				return wkbGeometry{}, nil, false
			}
			geometry.rings[index] = child.points
		}
	case 6:
		count, countOK := reader.readUint32(order)
		if !countOK || uint64(count)*5 > uint64(reader.remaining()) {
			return wkbGeometry{}, nil, false
		}
		geometry.polygons = make([][][][]float64, int(count))
		for index := range geometry.polygons {
			child, _, childOK := parseWKBGeometry(reader, depth+1)
			if !childOK || child.kind != 3 {
				return wkbGeometry{}, nil, false
			}
			geometry.polygons[index] = child.rings
		}
	case 7:
		count, countOK := reader.readUint32(order)
		if !countOK || uint64(count)*5 > uint64(reader.remaining()) {
			return wkbGeometry{}, nil, false
		}
		geometry.children = make([]wkbGeometry, int(count))
		for index := range geometry.children {
			child, _, childOK := parseWKBGeometry(reader, depth+1)
			if !childOK {
				return wkbGeometry{}, nil, false
			}
			geometry.children[index] = child
		}
	default:
		return wkbGeometry{}, nil, false
	}
	return geometry, srid, true
}

func decodeWKBGeometry(raw []byte) (decodedWKBGeometry, bool) {
	reader := &wkbReader{raw: raw}
	geometry, srid, ok := parseWKBGeometry(reader, 0)
	if !ok || reader.position != len(raw) {
		return decodedWKBGeometry{}, false
	}
	return decodedWKBGeometry{WKT: geometry.wkt(), SRID: srid}, true
}
