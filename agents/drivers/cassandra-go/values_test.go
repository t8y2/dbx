package main

import (
	"net"
	"reflect"
	"testing"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

func TestNormalizeCQLValueRendersScalarsAndCQLLiterals(t *testing.T) {
	uuid, err := gocql.ParseUUID("00112233-4455-6677-8899-aabbccddeeff")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		value any
		want  any
	}{
		{nil, nil},
		{42, "42"},
		{true, "true"},
		{[]byte{0x00, 0xff}, "0x00ff"},
		{uuid, "00112233-4455-6677-8899-aabbccddeeff"},
		{net.ParseIP("127.0.0.1"), "127.0.0.1"},
		{time.Date(2026, 8, 3, 12, 34, 56, 7, time.UTC), "2026-08-03T12:34:56.000000007Z"},
		{gocql.Duration{Months: 1, Days: 2, Nanoseconds: 3}, "1mo2d3ns"},
		{[]int{1, 2}, "[1, 2]"},
		{[]any{1, nil, "three"}, "[1, null, 'three']"},
		{[]string{"it's", "b"}, "['it''s', 'b']"},
		{map[string]int{"b": 2, "a": 1}, "{'a': 1, 'b': 2}"},
		{map[string]string{"tier": "gold", "color": "blue", "region": "eu-west"}, "{'color': 'blue', 'region': 'eu-west', 'tier': 'gold'}"},
		{map[string]any{"tags": []string{"x,y", "z=1"}, "count": int64(3)}, "{'count': 3, 'tags': ['x,y', 'z=1']}"},
		{map[int]bool{2: true, 10: false}, "{10: false, 2: true}"},
		{[]any{uuid, net.ParseIP("10.0.0.1"), time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC), []byte{0x01}}, "[00112233-4455-6677-8899-aabbccddeeff, '10.0.0.1', '2026-08-03T00:00:00Z', 0x01]"},
		{cqlTuple{1, "a", nil}, "(1, 'a', null)"},
		{map[string]any{"pos": cqlTuple{1, 2}}, "{'pos': (1, 2)}"},
	}
	for _, test := range tests {
		if got := normalizeCQLValue(test.value); !reflect.DeepEqual(got, test.want) {
			t.Fatalf("normalizeCQLValue(%#v) = %#v, want %#v", test.value, got, test.want)
		}
	}
}

func TestCQLTypeNameUsesCQLSyntax(t *testing.T) {
	typeInfo := gocql.NewNativeType(4, gocql.TypeList, "varchar")
	if got := cqlTypeName(typeInfo); got != "list<text>" {
		t.Fatalf("unexpected collection type name: %s", got)
	}
}
