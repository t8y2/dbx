package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	thriftVersionMask        uint32 = 0xffff0000
	thriftVersion1           uint32 = 0x80010000
	thriftTypeMask           uint32 = 0x000000ff
	thriftMaxDepth                  = 32
	thriftMaxContainerItems         = 10000
	thriftMaxMethodNameBytes        = 256
)

const (
	thriftStop   byte = 0
	thriftVoid   byte = 1
	thriftBool   byte = 2
	thriftByte   byte = 3
	thriftDouble byte = 4
	thriftI16    byte = 6
	thriftI32    byte = 8
	thriftI64    byte = 10
	thriftString byte = 11
	thriftStruct byte = 12
	thriftMap    byte = 13
	thriftSet    byte = 14
	thriftList   byte = 15
	thriftUUID   byte = 16
)

var errInvalidThrift = errors.New("invalid thrift binary payload")

type thriftReader struct {
	data []byte
	pos  int
}

func (r *thriftReader) remaining() int {
	return len(r.data) - r.pos
}

func (r *thriftReader) atEnd() bool {
	return r.pos >= len(r.data)
}

func (r *thriftReader) take(n int) ([]byte, error) {
	if n < 0 || r.pos+n > len(r.data) {
		return nil, errInvalidThrift
	}
	slice := r.data[r.pos : r.pos+n]
	r.pos += n
	return slice, nil
}

func (r *thriftReader) u8() (byte, error) {
	b, err := r.take(1)
	if err != nil {
		return 0, err
	}
	return b[0], nil
}

func (r *thriftReader) i16() (int16, error) {
	b, err := r.take(2)
	if err != nil {
		return 0, err
	}
	return int16(binary.BigEndian.Uint16(b)), nil
}

func (r *thriftReader) i32() (int32, error) {
	b, err := r.take(4)
	if err != nil {
		return 0, err
	}
	return int32(binary.BigEndian.Uint32(b)), nil
}

func (r *thriftReader) u32() (uint32, error) {
	b, err := r.take(4)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(b), nil
}

func (r *thriftReader) i64() (int64, error) {
	b, err := r.take(8)
	if err != nil {
		return 0, err
	}
	return int64(binary.BigEndian.Uint64(b)), nil
}

func (r *thriftReader) f64() (float64, error) {
	b, err := r.take(8)
	if err != nil {
		return 0, err
	}
	v := math.Float64frombits(binary.BigEndian.Uint64(b))
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, errInvalidThrift
	}
	return v, nil
}

func isPrintableUTF8(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	for _, r := range string(data) {
		if (r < 0x20 && r != '\t' && r != '\n' && r != '\r') || r == 0x7f {
			return false
		}
	}
	return true
}

func isValidThriftMethodName(name string) bool {
	if len(name) == 0 || len(name) > thriftMaxMethodNameBytes {
		return false
	}
	for i := 0; i < len(name); i++ {
		if name[i] <= 0x20 || name[i] >= 0x7f {
			return false
		}
	}
	return true
}

func thriftMessageTypeName(code byte) (string, bool) {
	switch code {
	case 1:
		return "CALL", true
	case 2:
		return "REPLY", true
	case 3:
		return "EXCEPTION", true
	case 4:
		return "ONEWAY", true
	default:
		return "", false
	}
}

func decodeThriftBinaryOrString(data []byte, depth int) any {
	if len(data) == 0 {
		return ""
	}
	if isPrintableUTF8(data) {
		return string(data)
	}
	if depth < thriftMaxDepth {
		if nested, err := decodeThriftRawStruct(data, depth+1); err == nil {
			return nested
		}
	}
	return map[string]any{"$bytes": hex.EncodeToString(data)}
}

func readThriftValue(r *thriftReader, fieldType byte, depth int) (any, error) {
	if depth > thriftMaxDepth {
		return nil, errInvalidThrift
	}
	switch fieldType {
	case thriftVoid:
		return nil, nil
	case thriftBool:
		b, err := r.u8()
		if err != nil || (b != 0 && b != 1) {
			return nil, errInvalidThrift
		}
		return b == 1, nil
	case thriftByte:
		b, err := r.u8()
		if err != nil {
			return nil, err
		}
		return int8(b), nil
	case thriftDouble:
		return r.f64()
	case thriftI16:
		return r.i16()
	case thriftI32:
		return r.i32()
	case thriftI64:
		return r.i64()
	case thriftString:
		length, err := r.i32()
		if err != nil || length < 0 {
			return nil, errInvalidThrift
		}
		raw, err := r.take(int(length))
		if err != nil {
			return nil, err
		}
		return decodeThriftBinaryOrString(raw, depth), nil
	case thriftStruct:
		return readThriftStruct(r, depth+1)
	case thriftMap:
		keyType, err := r.u8()
		if err != nil {
			return nil, err
		}
		valType, err := r.u8()
		if err != nil {
			return nil, err
		}
		size, err := r.i32()
		if err != nil || size < 0 || int(size) > thriftMaxContainerItems || int(size) > r.remaining() {
			return nil, errInvalidThrift
		}
		out := make(map[string]any, int(size))
		for i := 0; i < int(size); i++ {
			k, err := readThriftValue(r, keyType, depth+1)
			if err != nil {
				return nil, err
			}
			v, err := readThriftValue(r, valType, depth+1)
			if err != nil {
				return nil, err
			}
			keyBytes, err := json.Marshal(k)
			if err != nil {
				return nil, errInvalidThrift
			}
			keyStr := string(keyBytes)
			if len(keyStr) >= 2 && keyStr[0] == '"' && keyStr[len(keyStr)-1] == '"' {
				if unquoted, err := strconv.Unquote(keyStr); err == nil {
					keyStr = unquoted
				}
			}
			out[keyStr] = v
		}
		return out, nil
	case thriftSet, thriftList:
		elemType, err := r.u8()
		if err != nil {
			return nil, err
		}
		size, err := r.i32()
		if err != nil || size < 0 || int(size) > thriftMaxContainerItems || int(size) > r.remaining() {
			return nil, errInvalidThrift
		}
		items := make([]any, 0, int(size))
		for i := 0; i < int(size); i++ {
			item, err := readThriftValue(r, elemType, depth+1)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return items, nil
	case thriftUUID:
		raw, err := r.take(16)
		if err != nil {
			return nil, err
		}
		h := hex.EncodeToString(raw)
		return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
	default:
		return nil, errInvalidThrift
	}
}

func readThriftStruct(r *thriftReader, depth int) (map[string]any, error) {
	if depth > thriftMaxDepth {
		return nil, errInvalidThrift
	}
	fields := make(map[string]any)
	for {
		fieldType, err := r.u8()
		if err != nil {
			return nil, err
		}
		if fieldType == thriftStop {
			break
		}
		fieldID, err := r.i16()
		if err != nil || fieldID < 0 {
			return nil, errInvalidThrift
		}
		key := strconv.Itoa(int(fieldID))
		if _, exists := fields[key]; exists {
			return nil, errInvalidThrift
		}
		val, err := readThriftValue(r, fieldType, depth)
		if err != nil {
			return nil, err
		}
		fields[key] = val
	}
	return fields, nil
}

func decodeThriftStrictMessage(data []byte) (map[string]any, error) {
	r := &thriftReader{data: data}
	versionAndType, err := r.u32()
	if err != nil || (versionAndType&thriftVersionMask) != thriftVersion1 || (versionAndType&0x0000ff00) != 0 {
		return nil, errInvalidThrift
	}
	msgType, ok := thriftMessageTypeName(byte(versionAndType & thriftTypeMask))
	if !ok {
		return nil, errInvalidThrift
	}
	nameLen, err := r.i32()
	if err != nil || nameLen <= 0 || int(nameLen) > thriftMaxMethodNameBytes {
		return nil, errInvalidThrift
	}
	nameBytes, err := r.take(int(nameLen))
	if err != nil || !isPrintableUTF8(nameBytes) {
		return nil, errInvalidThrift
	}
	method := string(nameBytes)
	if !isValidThriftMethodName(method) {
		return nil, errInvalidThrift
	}
	seqID, err := r.i32()
	if err != nil {
		return nil, err
	}
	fields, err := readThriftStruct(r, 0)
	if err != nil || !r.atEnd() {
		return nil, errInvalidThrift
	}
	return map[string]any{
		"method": method,
		"type":   msgType,
		"seqId":  seqID,
		"fields": fields,
	}, nil
}

func decodeThriftNonStrictMessage(data []byte) (map[string]any, error) {
	r := &thriftReader{data: data}
	nameLen, err := r.i32()
	if err != nil || nameLen <= 0 || int(nameLen) > thriftMaxMethodNameBytes {
		return nil, errInvalidThrift
	}
	nameBytes, err := r.take(int(nameLen))
	if err != nil || !isPrintableUTF8(nameBytes) {
		return nil, errInvalidThrift
	}
	method := string(nameBytes)
	if !isValidThriftMethodName(method) {
		return nil, errInvalidThrift
	}
	typeByte, err := r.u8()
	if err != nil {
		return nil, err
	}
	msgType, ok := thriftMessageTypeName(typeByte)
	if !ok {
		return nil, errInvalidThrift
	}
	seqID, err := r.i32()
	if err != nil {
		return nil, err
	}
	fields, err := readThriftStruct(r, 0)
	if err != nil || !r.atEnd() {
		return nil, errInvalidThrift
	}
	return map[string]any{
		"method": method,
		"type":   msgType,
		"seqId":  seqID,
		"fields": fields,
	}, nil
}

func decodeThriftRawStruct(data []byte, depth int) (map[string]any, error) {
	r := &thriftReader{data: data}
	fields, err := readThriftStruct(r, depth)
	if err != nil || !r.atEnd() || len(fields) == 0 {
		return nil, errInvalidThrift
	}
	return fields, nil
}

func decodeThriftUnframed(data []byte) (map[string]any, error) {
	if len(data) >= 4 && (binary.BigEndian.Uint32(data[:4])&thriftVersionMask) == thriftVersion1 {
		return decodeThriftStrictMessage(data)
	}
	if msg, err := decodeThriftNonStrictMessage(data); err == nil {
		return msg, nil
	}
	return decodeThriftRawStruct(data, 0)
}

func decodeThriftBinaryJSON(data []byte) (string, bool) {
	if len(data) == 0 {
		return "", false
	}
	value, err := decodeThriftUnframed(data)
	if err != nil && len(data) > 4 {
		frameLen := binary.BigEndian.Uint32(data[:4])
		if frameLen > 0 && int(frameLen) == len(data)-4 {
			value, err = decodeThriftUnframed(data[4:])
		}
	}
	if err != nil {
		return "", false
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		return "", false
	}
	return strings.TrimSuffix(buf.String(), "\n"), true
}

func decodeDeliveryPayloadText(body []byte) (string, bool) {
	if len(body) > 0 && isPrintableUTF8(body) {
		return string(body), true
	}
	if decoded, ok := decodeThriftBinaryJSON(body); ok {
		return decoded, true
	}
	if utf8.Valid(body) {
		return string(body), true
	}
	return "", false
}
