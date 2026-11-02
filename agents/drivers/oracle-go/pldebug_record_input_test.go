package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func plDebugRecordInputFixture() (plDebugNativeTypeGraph, plDebugNativeTypeRef) {
	text := func(value string) *string { return &value }
	pack := "P"
	root := plDebugNativeTypeRef{Owner: "S", PackageName: &pack, TypeName: "R"}
	nested := plDebugNativeTypeRef{Owner: "S", PackageName: &pack, TypeName: "NESTED"}
	return plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{
		{Reference: root, Definition: plDebugNativeMetadataRow{"TYPECODE": text("PL/SQL RECORD")}, Attributes: []plDebugNativeMetadataRow{
			{"ATTR_NAME": text("N"), "ATTR_TYPE_NAME": text("NUMBER")},
			{"ATTR_NAME": text("Child"), "ATTR_TYPE_NAME": text("NESTED"), "ATTR_TYPE_OWNER": text("S"), "ATTR_TYPE_PACKAGE": &pack},
			{"ATTR_NAME": text("Defaulted"), "ATTR_TYPE_NAME": text("VARCHAR2")},
		}},
		{Reference: nested, Definition: plDebugNativeMetadataRow{"TYPECODE": text("PL/SQL RECORD")}, Attributes: []plDebugNativeMetadataRow{
			{"ATTR_NAME": text("B"), "ATTR_TYPE_NAME": text("BOOLEAN")},
			{"ATTR_NAME": text("T"), "ATTR_TYPE_NAME": text("VARCHAR2")},
		}},
	}}, root
}

func TestPLDebugRecordIntegerDictionaryAliasesUseExactNumberCarrier(t *testing.T) {
	for _, kind := range []string{"INTEGER", "PL/SQL PLS INTEGER", "PL/SQL BINARY INTEGER"} {
		t.Run(kind, func(t *testing.T) {
			graph, root := plDebugRecordInputFixture()
			graph.Nodes[0].Attributes[0]["ATTR_TYPE_NAME"] = &kind
			input, err := plDebugDecodeRecordInput(graph, root, json.RawMessage(`{"kind":"record","value":[{"name":"N","value":{"kind":"number","value":"12345678901234567890123456789012345678"}}]}`), 10, 100)
			if err != nil || len(input.leaves) != 1 || input.leaves[0].input.argument.Type != "NUMBER" || input.leaves[0].input.value != "12345678901234567890123456789012345678" {
				t.Fatalf("integer alias lost exact numeric carrier: %v", err)
			}
			if _, err = plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{root}); err != nil {
				t.Fatalf("verified integer dictionary alias has no output adapter: %v", err)
			}
		})
	}
}

func TestPLDebugRecordInputNormalizesExactNestedFieldsWithoutInventingDefaults(t *testing.T) {
	graph, root := plDebugRecordInputFixture()
	payload := json.RawMessage(`{"kind":"record","value":[{"name":"N","value":{"kind":"number","value":"12345678901234567890123456789012345678"}},{"name":"Child","value":{"kind":"record","value":[{"name":"B","value":{"kind":"boolean","value":true}},{"name":"T","value":{"kind":"text","value":null}}]}}]}`)
	input, err := plDebugDecodeRecordInput(graph, root, payload, 8192, plDebugTypedInputBytes)
	if err != nil {
		t.Fatal(err)
	}
	if input.nodes != 5 || len(input.leaves) != 3 || input.leaves[0].input.value != "12345678901234567890123456789012345678" || input.leaves[1].input.value != true || input.leaves[2].input.state != "null" {
		t.Fatal("record normalization lost exact numeric/boolean/NULL values")
	}
	if strings.Join(input.leaves[1].path, "/") != "Child/B" || input.leaves[1].input.argument.Type != "PL/SQL BOOLEAN" {
		t.Fatal("nested field identity or leaf adapter lost")
	}
	for _, leaf := range input.leaves {
		if leaf.path[0] == "Defaulted" {
			t.Fatal("omitted field default was overwritten")
		}
	}
	if _, err = plDebugDecodeRecordInput(graph, root, payload, 4, plDebugTypedInputBytes); err == nil {
		t.Fatal("recursive node budget was not enforced")
	}
	if _, err = plDebugDecodeRecordInput(graph, root, payload, 8192, 41); err == nil {
		t.Fatal("recursive byte budget was not enforced")
	}
}

func TestPLDebugRecordInputRejectsAtomicNullUnknownAndDuplicateFields(t *testing.T) {
	graph, root := plDebugRecordInputFixture()
	for _, payload := range []string{
		`{"kind":"record","value":null}`,
		`{"kind":"collection","value":[]}`,
		`{"kind":"record","value":[{"name":"n","value":{"kind":"number","value":"1"}}]}`,
		`{"kind":"record","value":[{"name":"N","value":{"kind":"number","value":"1"}},{"name":"N","value":{"kind":"number","value":"2"}}]}`,
		`{"kind":"record","value":[{"name":"N","value":{"kind":"number","value":1}}]}`,
		`{"kind":"record","value":[{"name":"Child","value":{"kind":"record","value":[{"name":"B","value":{"kind":"boolean","value":"true"}}]}}]}`,
	} {
		if _, err := plDebugDecodeRecordInput(graph, root, json.RawMessage(payload), 8192, plDebugTypedInputBytes); err == nil {
			t.Fatalf("invalid record input accepted: %s", payload)
		}
	}
	input, err := plDebugDecodeRecordInput(graph, root, json.RawMessage(`{"kind":"record","value":[]}`), 8192, plDebugTypedInputBytes)
	if err != nil || len(input.leaves) != 0 || input.nodes != 1 {
		t.Fatal("empty field array must preserve all real record defaults")
	}
}

func TestPLDebugRecordInputUsesOriginalSelectorAndFlattenedBinds(t *testing.T) {
	graph, root := plDebugRecordInputFixture()
	valid, name, owner, pack, subtype := "VALID", "R", "S", "P", "R"
	argument := plDebugNativeArgument{Name: &name, Position: 1, Sequence: 1, Mode: "IN", Type: "PL/SQL RECORD", TypeOwner: &owner, TypeName: &pack, TypeSubname: &subtype}
	candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", PackageName: &pack, ObjectType: "PROCEDURE", ObjectID: "42", Status: &valid, Arguments: []plDebugNativeArgument{argument}}
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: candidate, SignatureVersion: 2, MetadataPreparation: "type_only", ArgumentDetails: []plDebugNativeMetadataRow{}, TypeBindings: []plDebugNativeTypeBinding{{Sequence: 1, Reference: root}}, TypeGraph: graph}
	value, err := plDebugNativeJSONValue(signature)
	if err != nil {
		t.Fatal(err)
	}
	payload := json.RawMessage(`{"kind":"record","value":[{"name":"N","value":{"kind":"number","value":"19"}},{"name":"Child","value":{"kind":"record","value":[{"name":"B","value":{"kind":"boolean","value":false}}]}}]}`)
	request := plDebugNativeStart{MetadataPreparation: "type_only", TargetSignature: value.(map[string]interface{}), Params: []interface{}{map[string]interface{}{"name": "R", "mode": "IN", "type": "PL/SQL RECORD", "typedValue": payload}}}
	plan, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{candidate}, request)
	if err != nil {
		t.Fatal(err)
	}
	if plan.inputCount() != 2 || plan.arguments[0].record.reference.key() != root.key() {
		t.Fatal("record was not bound through its verified declared identity")
	}
	call, err := plan.bind(false)
	if err != nil || len(call.arguments) != 3 {
		t.Fatal("record input did not flatten into two leaf binds and the original phase receipt")
	}
	body := plan.render("DBX_REC_")
	if !strings.Contains(body.ScopedDeclarations, `DBX_REC_ARG_0 "S"."P"."R";`) || !strings.Contains(body.Source, `DBX_REC_ARG_0."Child"."B" := CASE :2`) || strings.Contains(body.Source, `"Defaulted" :=`) {
		t.Fatal("record declaration/field identity/default preservation changed")
	}
	request.Params = []interface{}{map[string]interface{}{"name": "R", "mode": "IN", "type": "PL/SQL RECORD", "inputState": "null"}}
	if _, err = plDebugSelectNativeTarget([]plDebugNativeCandidate{candidate}, request); err == nil {
		t.Fatal("record atomic NULL was accepted by production selector")
	}
}

func TestPLDebugRecordTemporalLeavesUseExactComponents(t *testing.T) {
	graph, root := plDebugRecordInputFixture()
	text := func(value string) *string { return &value }
	graph.Nodes[0].Attributes = append(graph.Nodes[0].Attributes, plDebugNativeMetadataRow{"ATTR_NAME": text("D"), "ATTR_TYPE_NAME": text("DATE")}, plDebugNativeMetadataRow{"ATTR_NAME": text("TS"), "ATTR_TYPE_NAME": text("TIMESTAMP")})
	payload := json.RawMessage(`{"kind":"record","value":[{"name":"D","value":{"kind":"date","value":"0001-01-01T00:00:00"}},{"name":"TS","value":{"kind":"timestamp","value":"1969-12-31T23:59:59.123456789"}}]}`)
	input, err := plDebugDecodeRecordInput(graph, root, payload, 8192, plDebugTypedInputBytes)
	if err != nil {
		t.Fatal(err)
	}
	date := input.leaves[0].input.value.(plDebugNativeTemporalInput)
	stamp := input.leaves[1].input.value.(plDebugNativeTemporalInput)
	if date.day != "0001-01-01" || date.seconds != "0" || stamp.day != "1969-12-31" || stamp.seconds != "86399.123456789" {
		t.Fatal("nested temporal values were rounded or shifted")
	}
	if _, err = plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{root}); err != nil {
		t.Fatal("shared record temporal output preflight rejected supported leaves")
	}
}

func TestPLDebugRecordLobLeavesShareDecodedByteBudget(t *testing.T) {
	graph, root := plDebugRecordInputFixture()
	text := func(value string) *string { return &value }
	for _, field := range []struct{ name, kind string }{{"L", "CLOB"}, {"BIN", "BLOB"}, {"RAW", "RAW"}} {
		graph.Nodes[1].Attributes = append(graph.Nodes[1].Attributes, plDebugNativeMetadataRow{"ATTR_NAME": text(field.name), "ATTR_TYPE_NAME": text(field.kind)})
	}
	payload := json.RawMessage(`{"kind":"record","value":[{"name":"Child","value":{"kind":"record","value":[{"name":"L","value":{"kind":"clob","value":"中文🙂\u0000"}},{"name":"BIN","value":{"kind":"blob","value":{"encoding":"base64","data":"AP+A"}}},{"name":"RAW","value":{"kind":"raw","value":{"encoding":"base64","data":"AP+A"}}}]}}]}`)
	input, err := plDebugDecodeRecordInput(graph, root, payload, 8192, 17)
	if err != nil {
		t.Fatal(err)
	}
	if input.bytes != 17 || input.nodes != 5 || len(input.leaves) != 3 || input.leaves[0].input.value.(plDebugLobInput).text != "中文🙂\x00" || input.leaves[2].input.value.(plDebugLobInput).bytes != 3 {
		t.Fatal("recursive LOB normalization lost bytes or identity")
	}
	if _, err = plDebugDecodeRecordInput(graph, root, payload, 8192, 16); err == nil {
		t.Fatal("recursive LOB byte budgets were applied independently instead of cumulatively")
	}
	if _, err = plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{root}); err != nil {
		t.Fatal(err)
	}
}
