package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestPLDebugIntegerConstructorInputKeepsFormalAndUsesCallCarrier(t *testing.T) {
	for _, kind := range []string{"INTEGER", "PLS_INTEGER", "BINARY_INTEGER", "SIMPLE_INTEGER"} {
		graph, ref := plDebugObjectInputFixture()
		source := plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(V "+kind+") RETURN SELF AS RESULT)")
		graph.Nodes[0].ConstructorSource = &source
		for _, value := range []string{`"0.66"`, `null`} {
			payload := json.RawMessage(`{"kind":"object","value":{"type":{"owner":"S","typeName":"T"},"constructorId":"user-1","arguments":[{"name":"V","state":"value","value":{"kind":"number","value":` + value + `}}]}}`)
			input, err := plDebugDecodeObjectInput(graph, ref, payload, 100, 100)
			if err != nil {
				t.Fatalf("%s/%s: %v", kind, value, err)
			}
			if input.arguments[0].formal.Type.text("ATTR_TYPE_NAME") != kind {
				t.Fatal("formal identity rewritten")
			}
			if value != `null` {
				want, _ := plDebugNativeDecimal("0.66")
				if !reflect.DeepEqual(input.arguments[0].scalar.value, want) {
					t.Fatal("decimal rounded before dispatch")
				}
			}
			builder := plDebugCollectionInitializer{prefix: "DBX_INT_"}
			if err := builder.object(input, "ROOT"); err != nil {
				t.Fatal(err)
			}
			carrier := "PLS_INTEGER"
			if kind == "INTEGER" {
				carrier = "NUMBER"
			}
			if !strings.Contains(builder.declarations, " "+carrier+";\n") || strings.Contains(builder.declarations, "SIMPLE_INTEGER") {
				t.Fatalf("wrong carrier: %s", builder.declarations)
			}
		}
	}
}

func plDebugObjectInputFixture() (plDebugNativeTypeGraph, plDebugNativeTypeRef) {
	text := func(s string) *string { return &s }
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	source := plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(LABEL VARCHAR2,EXTRA NUMBER DEFAULT 7) RETURN SELF AS RESULT)")
	node := plDebugNativeTypeNode{Reference: ref, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT"), "INSTANTIABLE": text("YES"), "FINAL": text("YES")}, Attributes: []plDebugNativeMetadataRow{{"ATTR_NAME": text("N"), "ATTR_TYPE_NAME": text("NUMBER")}}, ConstructorSource: &source, ObjectAccess: &plDebugNativeTypeAccess{State: "type_only_verified"}}
	return plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{node}}, ref
}

func TestPLDebugObjectInputPreservesExplicitConstructorDefaultsAndTypedValues(t *testing.T) {
	graph, ref := plDebugObjectInputFixture()
	payload := json.RawMessage(`{"kind":"object","value":{"type":{"owner":"S","packageName":null,"typeName":"T"},"constructorId":"user-1","arguments":[{"name":"EXTRA","state":"default"},{"name":"LABEL","state":"value","value":{"kind":"text","value":"abc"}}]}}`)
	input, err := plDebugDecodeObjectInput(graph, ref, payload, 3, 3)
	if err != nil {
		t.Fatal(err)
	}
	if input.null || input.constructor.ID != "user-1" || input.nodes != 3 || input.bytes != 3 || !input.arguments[0].defaulted || input.arguments[1].scalar.value != "abc" {
		t.Fatal("constructor default or bound value changed")
	}
	builder := plDebugCollectionInitializer{prefix: "DBX_OBJ_"}
	if err = builder.object(input, "ROOT"); err != nil {
		t.Fatal(err)
	}
	bindings := 0
	for _, operation := range builder.operations {
		if operation.input != nil {
			bindings++
			if operation.input.value != "abc" {
				t.Fatal("constructor emitted an invented default binding")
			}
		}
	}
	if bindings != 1 || len(builder.names) != 1 {
		t.Fatal("constructor default became an eager input initializer")
	}
	if _, err = plDebugDecodeObjectInput(graph, ref, payload, 2, 3); err == nil {
		t.Fatal("constructor default bypassed node budget")
	}
	if _, err = plDebugDecodeObjectInput(graph, ref, payload, 3, 2); err == nil {
		t.Fatal("object input bypassed value byte budget")
	}
	for _, invalid := range []string{
		strings.Replace(string(payload), `"state":"default"`, `"state":"default","value":null`, 1),
		strings.Replace(string(payload), `"EXTRA"`, `"LABEL"`, 1),
		strings.Replace(string(payload), `"typeName":"T"`, `"typeName":"MISSING"`, 1),
		strings.Replace(string(payload), `"packageName":null`, `"packageName":"P"`, 1),
	} {
		if _, err = plDebugDecodeObjectInput(graph, ref, json.RawMessage(invalid), 100, 100); err == nil {
			t.Fatal("invalid object construction accepted")
		}
	}
}

func TestPLDebugObjectAtomicNullDoesNotRequireConstructorExecution(t *testing.T) {
	graph, ref := plDebugObjectInputFixture()
	no := "NO"
	graph.Nodes[0].Definition["INSTANTIABLE"] = &no
	graph.Nodes[0].ConstructorSource = nil
	input, err := plDebugDecodeObjectInput(graph, ref, json.RawMessage(`{"kind":"object","value":null}`), 1, 0)
	if err != nil || !input.null || len(input.arguments) != 0 || input.nodes != 1 {
		t.Fatalf("abstract object NULL incorrectly required construction: %v", err)
	}
	graph.Nodes[0].ObjectAccess.State = "type_only_failed"
	if _, err = plDebugDecodeObjectInput(graph, ref, json.RawMessage(`{"kind":"object","value":null}`), 1, 0); err == nil {
		t.Fatal("object NULL bypassed actual declared type access")
	}
}

func TestPLDebugNestedObjectInputsPreserveRecordElementOwnership(t *testing.T) {
	graph, object := plDebugObjectInputFixture()
	records, record := plDebugRecordInputFixture()
	text := func(s string) *string { return &s }
	records.Nodes[0].Attributes = append(records.Nodes[0].Attributes, plDebugNativeMetadataRow{"ATTR_NAME": text("Obj"), "ATTR_TYPE_OWNER": &object.Owner, "ATTR_TYPE_NAME": &object.TypeName})
	graph.Nodes = append(graph.Nodes, records.Nodes...)
	root := plDebugNativeTypeRef{Owner: record.Owner, PackageName: record.PackageName, TypeName: "ROWS"}
	graph.Nodes = append(graph.Nodes, plDebugNativeTypeNode{Reference: root, Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text("TABLE"), "ELEM_TYPE_OWNER": &record.Owner, "ELEM_TYPE_PACKAGE": record.PackageName, "ELEM_TYPE_NAME": &record.TypeName}}})
	payload := json.RawMessage(`{"kind":"collection","value":[{"index":"1","value":{"kind":"record","value":[{"name":"Obj","value":{"kind":"object","value":null}}]}},{"index":"3","value":{"kind":"record","value":[{"name":"Obj","value":{"kind":"object","value":{"type":{"owner":"S","typeName":"T"},"constructorId":"user-1","arguments":[{"name":"LABEL","state":"value","value":{"kind":"text","value":"abc"}},{"name":"EXTRA","state":"default"}]}}}]}}]}`)
	input, err := plDebugDecodeCollectionInput(graph, root, payload, 7, 5)
	if err != nil {
		t.Fatal(err)
	}
	first, second := input.entries[0].record, input.entries[1].record
	if input.nodes != 7 || input.bytes != 5 || len(first.objects) != 1 || len(second.objects) != 1 || !first.objects[0].input.null || second.objects[0].input.null || second.objects[0].input.constructor.ID != "user-1" {
		t.Fatal("nested OBJECT input leaked across record elements")
	}
	builder := plDebugCollectionInitializer{prefix: "DBX_OBJ_"}
	if err = builder.collection(input, "ROOT"); err != nil {
		t.Fatal(err)
	}
	bindings := 0
	for _, operation := range builder.operations {
		if operation.input != nil {
			bindings++
		}
	}
	if bindings != 1 || len(builder.names) != 3 {
		t.Fatal("nested object initializer invented defaults or record constructors")
	}
}
