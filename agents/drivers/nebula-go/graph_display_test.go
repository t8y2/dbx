package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	wire "github.com/vesoft-inc/nebula-go/v3/nebula"
)

func TestGraphDisplayPartsPreserveOrderedEntitiesAndScalarTokens(t *testing.T) {
	large := int64(9007199254740993)
	small := 0.000001
	a := &wire.Vertex{Vid: &wire.Value{SVal: []byte("a")}, Tags: []*wire.Tag{{Name: []byte("Person"), Props: map[string]*wire.Value{"count": {IVal: &large}}}}}
	b := &wire.Vertex{Vid: &wire.Value{SVal: []byte("b")}}
	edge := &wire.Edge{Src: a.Vid, Dst: b.Vid, Name: []byte("LINK"), Type: 1, Ranking: 7, Props: map[string]*wire.Value{"weight": {FVal: &small}}}
	path := &wire.Path{Src: a, Steps: []*wire.Step{{Dst: b, Type: -1, Name: edge.Name, Ranking: edge.Ranking, Props: edge.Props}}}
	values := []*wire.Value{
		{PVal: path},
		{LVal: &wire.NList{Values: []*wire.Value{{VVal: a}, {SVal: []byte("literal(a)")}, {IVal: &large}, {FVal: &small}, {EVal: edge}}}},
		{UVal: &wire.NSet{Values: []*wire.Value{{VVal: a}, {EVal: edge}}}},
		{MVal: &wire.NMap{Kvs: map[string]*wire.Value{"nested": {LVal: &wire.NList{Values: []*wire.Value{{VVal: a}, {VVal: a}}}}, "scalar": {IVal: &large}}}},
	}
	rows, _, err := readRows(resultSet(t, []string{"path", "list", "set", "map"}, [][]*wire.Value{values}), 1)
	if err != nil {
		t.Fatal(err)
	}
	for column, value := range rows[0] {
		cell := value.(*graphCell)
		if len(cell.DisplayParts) == 0 {
			t.Fatalf("column %d has no editable display references", column)
		}
		nodes := make(map[string]bool)
		edges := make(map[string]bool)
		for _, node := range cell.Nodes {
			nodes[node.ID] = true
		}
		for _, edge := range cell.Edges {
			edges[edge.ID] = true
		}
		for _, part := range cell.DisplayParts {
			encoded, err := json.Marshal(part)
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := part.(string); ok {
				continue
			}
			var reference struct {
				NodeID string `json:"nodeId"`
				EdgeID string `json:"edgeId"`
			}
			if err := json.Unmarshal(encoded, &reference); err != nil || (!nodes[reference.NodeID] && !edges[reference.EdgeID]) {
				t.Fatalf("unresolvable display reference: %s", encoded)
			}
		}
	}
	pathCell := rows[0][0].(*graphCell)
	if !reflect.DeepEqual(pathCell.DisplayParts[2], "<-") || !reflect.DeepEqual(pathCell.DisplayParts[4], "-") {
		t.Fatalf("reverse path order lost: %#v", pathCell.DisplayParts)
	}
	listJSON, _ := json.Marshal(rows[0][1].(*graphCell).DisplayParts)
	if !strings.Contains(string(listJSON), "literal(a)") || !strings.Contains(string(listJSON), "9007199254740993") || !strings.Contains(string(listJSON), "1e-06") || strings.Contains(string(listJSON), "1e-06.0") {
		t.Fatalf("scalar text or exact numbers changed: %s", listJSON)
	}
	mapCell := rows[0][3].(*graphCell)
	var references []string
	for _, part := range mapCell.DisplayParts {
		if ref, ok := part.(map[string]string); ok {
			references = append(references, ref["nodeId"])
		}
	}
	if len(references) != 2 || references[0] != references[1] {
		t.Fatalf("repeated aliases lost: %#v", mapCell.DisplayParts)
	}
}
