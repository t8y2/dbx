package main

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"net"
	"reflect"
	"sort"
	"strings"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

func normalizeCQLValue(value any) any {
	if value == nil {
		return nil
	}
	return cqlString(value)
}

func cqlString(value any) string {
	if value == nil {
		return "null"
	}
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return "0x" + hex.EncodeToString(typed)
	case time.Time:
		return typed.Format(time.RFC3339Nano)
	case time.Duration:
		return typed.String()
	case gocql.Duration:
		return fmt.Sprintf("%dmo%dd%dns", typed.Months, typed.Days, typed.Nanoseconds)
	case gocql.UUID:
		return typed.String()
	case net.IP:
		return typed.String()
	case *big.Int:
		if typed == nil {
			return ""
		}
		return typed.String()
	case big.Int:
		return typed.String()
	case fmt.Stringer:
		return typed.String()
	}
	valueOf := reflect.ValueOf(value)
	for valueOf.Kind() == reflect.Pointer {
		if valueOf.IsNil() {
			return ""
		}
		valueOf = valueOf.Elem()
	}
	switch valueOf.Kind() {
	case reflect.Map:
		entries := make([]string, 0, valueOf.Len())
		iterator := valueOf.MapRange()
		for iterator.Next() {
			entries = append(entries, cqlString(iterator.Key().Interface())+"="+cqlString(iterator.Value().Interface()))
		}
		sort.Strings(entries)
		return "{" + strings.Join(entries, ", ") + "}"
	case reflect.Slice, reflect.Array:
		values := make([]string, valueOf.Len())
		for index := range values {
			values[index] = cqlString(valueOf.Index(index).Interface())
		}
		return "[" + strings.Join(values, ", ") + "]"
	default:
		return fmt.Sprint(value)
	}
}

func cqlTypeName(typeInfo gocql.TypeInfo) string {
	if typeInfo == nil {
		return "unknown"
	}
	switch typed := typeInfo.(type) {
	case gocql.CollectionType:
		switch typed.Type() {
		case gocql.TypeMap:
			return "map<" + cqlTypeName(typed.Key) + ", " + cqlTypeName(typed.Elem) + ">"
		case gocql.TypeList:
			return "list<" + cqlTypeName(typed.Elem) + ">"
		case gocql.TypeSet:
			return "set<" + cqlTypeName(typed.Elem) + ">"
		}
	case gocql.TupleTypeInfo:
		parts := make([]string, len(typed.Elems))
		for index, element := range typed.Elems {
			parts[index] = cqlTypeName(element)
		}
		return "tuple<" + strings.Join(parts, ", ") + ">"
	case gocql.UDTTypeInfo:
		return quoteCQLIdentifier(typed.Name)
	case gocql.VectorType:
		return fmt.Sprintf("vector<%s, %d>", cqlTypeName(typed.SubType), typed.Dimensions)
	}
	names := map[gocql.Type]string{
		gocql.TypeCustom: "custom", gocql.TypeAscii: "ascii", gocql.TypeBigInt: "bigint",
		gocql.TypeBlob: "blob", gocql.TypeBoolean: "boolean", gocql.TypeCounter: "counter",
		gocql.TypeDecimal: "decimal", gocql.TypeDouble: "double", gocql.TypeFloat: "float",
		gocql.TypeInt: "int", gocql.TypeText: "text", gocql.TypeTimestamp: "timestamp",
		gocql.TypeUUID: "uuid", gocql.TypeVarchar: "text", gocql.TypeVarint: "varint",
		gocql.TypeTimeUUID: "timeuuid", gocql.TypeInet: "inet", gocql.TypeDate: "date",
		gocql.TypeTime: "time", gocql.TypeSmallInt: "smallint", gocql.TypeTinyInt: "tinyint",
		gocql.TypeDuration: "duration", gocql.TypeUDT: "udt", gocql.TypeTuple: "tuple",
		gocql.TypeList: "list", gocql.TypeMap: "map", gocql.TypeSet: "set",
	}
	if name := names[typeInfo.Type()]; name != "" {
		return name
	}
	return "unknown"
}
