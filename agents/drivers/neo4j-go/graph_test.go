package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	neo4j "github.com/neo4j/neo4j-go-driver/v6/neo4j"
)

func TestGraphRecordPreservesScalarDisplayAndExactIdentity(t *testing.T) {
	node := neo4j.Node{Id: 9007199254740993, ElementId: "4:test:1", Labels: []string{"Person", "Employee"}, Props: map[string]any{"name": "Sample A", "count": int64(9007199254740993), "enabled": true}}
	for _, legacy := range []bool{false, true} {
		row := normalizeRecord(&neo4j.Record{Values: []any{node, int64(42), nil, true}}, 4, legacy)
		cell, ok := row[0].(*graphCell)
		if !ok || cell.Marker != "neo4j-v1" || cell.Kind != "vertex" || cell.Display != formatNode(node) {
			t.Fatalf("invalid graph cell: %#v", row[0])
		}
		if !reflect.DeepEqual(row[1:], []any{"42", nil, "true"}) {
			t.Fatalf("scalar results changed: %#v", row[1:])
		}
		vid := cell.Nodes[0].VID
		if legacy && (vid.Type != "neo4j-id" || vid.Value != "9007199254740993") || !legacy && (vid.Type != "neo4j-element-id" || vid.Value != "4:test:1") {
			t.Fatalf("identity lost: %#v", vid)
		}
		encoded, err := json.Marshal(cell)
		if err != nil || !strings.Contains(string(encoded), `"value":"9007199254740993"`) || !strings.Contains(string(encoded), `"value":true`) {
			t.Fatalf("property types or precision lost: %s, %v", encoded, err)
		}
	}
}

func TestGraphPathsPreserveDirectionParallelEdgesAndSelfLoops(t *testing.T) {
	a := neo4j.Node{ElementId: "a", Labels: []string{"Person"}}
	b := neo4j.Node{ElementId: "b"}
	reverse := neo4j.Relationship{ElementId: "r1", StartElementId: "b", EndElementId: "a", Type: "KNOWS"}
	parallel := reverse
	parallel.ElementId = "r2"
	loop := neo4j.Relationship{ElementId: "a", StartElementId: "a", EndElementId: "a", Type: "SELF"}
	path := neo4j.Path{Nodes: []neo4j.Node{a, b}, Relationships: []neo4j.Relationship{reverse, parallel, loop}}
	cell := normalizeGraphQueryValue(map[string]any{"paths": []any{path}}, false).(*graphCell)
	if len(cell.DisplayParts) == 0 {
		t.Fatal("nested graph display references were lost")
	}
	if len(cell.Edges) != 3 || cell.Edges[0].Source != graphPlaceholder("b", 0, false).ID || cell.Edges[0].Target != graphPlaceholder("a", 0, false).ID {
		t.Fatalf("relationship direction lost: %#v", cell.Edges)
	}
	if cell.Edges[0].ID == cell.Edges[1].ID || cell.Edges[2].ID == cell.Nodes[0].ID || cell.Edges[2].Source != cell.Edges[2].Target {
		t.Fatal("parallel relationships, node IDs or self-loops collided")
	}
	if got := normalizeGraphQueryValue([]any{int64(1), "text"}, false); got != `[1,"text"]` {
		t.Fatalf("scalar collection changed: %#v", got)
	}
}

func TestGraphBinaryPropertyRetainsItsJSONRepresentation(t *testing.T) {
	for _, bytes := range [][]byte{{}, {0, 34, 92, 128, 255}, []byte(`{"looks":"like JSON"}`)} {
		node := neo4j.Node{ElementId: "binary", Labels: []string{"Sample"}, Props: map[string]any{"bytes": bytes, "name": "before"}}
		cell := normalizeGraphQueryValue(node, false).(*graphCell)
		property := cell.Nodes[0].Properties[0]
		value, ok := property.Value.(string)
		if !ok || !json.Valid([]byte(value)) || value != formatJSONValue(bytes) {
			t.Fatalf("binary property cannot be reconstructed: %#v, want %s", property, formatJSONValue(bytes))
		}
	}
}
