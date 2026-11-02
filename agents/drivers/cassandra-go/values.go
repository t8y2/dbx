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

// cqlTuple marks a decoded tuple so it renders as a CQL tuple literal.
type cqlTuple []any

func normalizeCQLValue(value any) any {
	if value == nil {
		return nil
	}
	return cqlString(value)
}

// cqlString renders a column value for the grid. Scalars keep their plain
// text form; collections are rendered as CQL literals, the same text cqlsh
// prints, so a copied cell can be pasted back into a CQL statement.
func cqlString(value any) string {
	return renderCQLValue(value, false)
}

// cqlLiteral renders a value nested inside a collection: text-like values
// are single-quoted so the literal stays unambiguous and valid CQL.
func cqlLiteral(value any) string {
	return renderCQLValue(value, true)
}

func renderCQLValue(value any, nested bool) string {
	if value == nil {
		return "null"
	}
	quote := func(text string) string {
		if nested {
			return quoteCQLString(text)
		}
		return text
	}
	switch typed := value.(type) {
	case string:
		return quote(typed)
	case []byte:
		return "0x" + hex.EncodeToString(typed)
	case time.Time:
		return quote(typed.Format(time.RFC3339Nano))
	case time.Duration:
		return quote(typed.String())
	case gocql.Duration:
		return fmt.Sprintf("%dmo%dd%dns", typed.Months, typed.Days, typed.Nanoseconds)
	case gocql.UUID:
		return typed.String()
	case net.IP:
		return quote(typed.String())
	case *big.Int:
		if typed == nil {
			return ""
		}
		return typed.String()
	case big.Int:
		return typed.String()
	case cqlTuple:
		values := make([]string, len(typed))
		for index, element := range typed {
			values[index] = cqlLiteral(element)
		}
		return "(" + strings.Join(values, ", ") + ")"
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
		type entry struct{ key, value string }
		entries := make([]entry, 0, valueOf.Len())
		iterator := valueOf.MapRange()
		for iterator.Next() {
			entries = append(entries, entry{cqlLiteral(iterator.Key().Interface()), cqlLiteral(iterator.Value().Interface())})
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].key < entries[j].key })
		parts := make([]string, len(entries))
		for index, item := range entries {
			parts[index] = item.key + ": " + item.value
		}
		return "{" + strings.Join(parts, ", ") + "}"
	case reflect.Slice, reflect.Array:
		values := make([]string, valueOf.Len())
		for index := range values {
			values[index] = cqlLiteral(valueOf.Index(index).Interface())
		}
		return "[" + strings.Join(values, ", ") + "]"
	default:
		return fmt.Sprint(value)
	}
}

func quoteCQLString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
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
