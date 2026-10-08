package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	neo4j "github.com/neo4j/neo4j-go-driver/v6/neo4j"
)

func TestNodeResultKeepsSourceWidthAndExactPropertyValues(t *testing.T) {
	node := neo4j.Node{Labels: []string{"Person"}, Props: map[string]any{
		"name": "Ada", "age": int64(9007199254740993), "active": true, "scores": []any{int64(1), int64(2)},
	}}
	row := normalizeRecord(&neo4j.Record{Values: []any{node, int64(7), nil}}, 3)
	cell, ok := row[0].(nodeCell)
	if !ok || len(row) != 3 || row[1] != "7" || row[2] != nil {
		t.Fatalf("unexpected record: %#v", row)
	}
	want := []nodeProperty{
		{Name: "active", Type: "Boolean", Value: "true"},
		{Name: "age", Type: "Integer", Value: "9007199254740993"},
		{Name: "name", Type: "String", Value: "Ada"},
		{Name: "scores", Type: "List", Value: "[1,2]"},
	}
	if cell.Marker != "v1" || cell.Display != formatNode(node) || !reflect.DeepEqual(cell.Properties, want) {
		t.Fatalf("unexpected node cell: %#v", cell)
	}
	encoded, err := json.Marshal(row)
	if err != nil || !strings.Contains(string(encoded), `"value":"9007199254740993"`) {
		t.Fatalf("inexact wire value: %s, err=%v", encoded, err)
	}
}

func TestEmptyNodeAndNonNodeValues(t *testing.T) {
	node := neo4j.Node{Labels: []string{"Empty"}}
	cell := normalizeNodeCell(node)
	if cell.Properties == nil || len(cell.Properties) != 0 {
		t.Fatalf("empty properties must serialize as []: %#v", cell)
	}
	for _, value := range []any{nil, "(:Person {\"name\":\"literal\"})", true, int64(42),
		neo4j.Relationship{Type: "KNOWS"}, neo4j.Path{Nodes: []neo4j.Node{node}},
		[]any{node}, map[string]any{"node": node}} {
		row := normalizeRecord(&neo4j.Record{Values: []any{value}}, 1)
		if !reflect.DeepEqual(row[0], normalizeQueryValue(value)) {
			t.Fatalf("non-node result changed for %T: %#v", value, row)
		}
	}
}
