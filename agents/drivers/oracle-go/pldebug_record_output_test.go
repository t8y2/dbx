package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPLDebugRecordOutputPreflightAndTextCarrier(t *testing.T) {
	graph, root := plDebugRecordInputFixture()
	valid, name, pack, owner, subtype := "VALID", "R", "P", "S", "R"
	argument := plDebugNativeArgument{Name: &name, Position: 1, Sequence: 1, Mode: "IN OUT", Type: "PL/SQL RECORD", TypeOwner: &owner, TypeName: &pack, TypeSubname: &subtype}
	candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", PackageName: &pack, ObjectType: "PROCEDURE", ObjectID: "42", Status: &valid, Arguments: []plDebugNativeArgument{argument}}
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: candidate, SignatureVersion: 2, MetadataPreparation: "type_only", ArgumentDetails: []plDebugNativeMetadataRow{}, TypeBindings: []plDebugNativeTypeBinding{{Sequence: 1, Reference: root}}, TypeGraph: graph}
	value, err := plDebugNativeJSONValue(signature)
	if err != nil {
		t.Fatal(err)
	}
	request := plDebugNativeStart{MetadataPreparation: "type_only", TargetSignature: value.(map[string]interface{}), Params: []interface{}{map[string]interface{}{"name": "R", "mode": "IN OUT", "type": "PL/SQL RECORD", "typedValue": json.RawMessage(`{"kind":"record","value":[]}`)}}}
	plan, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{candidate}, request)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.compositeOutputNodes) != 2 || plan.inputCount() != 0 {
		t.Fatal("nested record output graph or omitted defaults were lost")
	}
	call, err := plan.bind(false)
	if err != nil || len(call.arguments) != 4 || call.lobs[0].binary {
		t.Fatal("record JSON was not bound through the original text carrier")
	}
	if _, err = plan.block(); err != nil {
		t.Fatal(err)
	}
	graph.Nodes[1].Attributes[0]["ATTR_TYPE_NAME"] = &subtype
	if _, err = plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{root}); err == nil {
		t.Fatal("unknown output leaf was silently encoded as text")
	}
}

func TestPLDebugResultMetadataReservationKeepsStructuredJSONWhole(t *testing.T) {
	x, y := "X", "Y"
	plan := &plDebugNativePlan{arguments: []plDebugNativeInput{{argument: plDebugNativeArgument{Name: &x, Position: 1, Mode: "OUT", Type: "PL/SQL RECORD"}}, {argument: plDebugNativeArgument{Name: &y, Position: 2, Mode: "OUT", Type: "PL/SQL RECORD"}}}}
	budget := plan.resultPayloadBudget()
	cache := plDebugResultCache{}
	for index, path := range []string{x, y} {
		size := budget / 2
		if index == 1 {
			size = budget - size
		}
		data := []byte(`{"kind":"record","fields":{}}` + strings.Repeat(" ", size-len(`{"kind":"record","fields":{}}`)))
		reference, err := cache.retain(data, false, path)
		if err != nil || reference["complete"] != true || reference["length"] != size {
			t.Fatal("result metadata truncated a server-budgeted structured document")
		}
	}
	if cache.used > plDebugTypedResultBytes {
		t.Fatal("metadata reservation exceeded the cumulative result budget")
	}
}

func TestPLDebugRecordOnlyDeclaresRequiredLobPackageAdapters(t *testing.T) {
	graph, root := plDebugRecordInputFixture()
	nodes, err := plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{root})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(newPLDebugCompositeEncoder(nodes, "DBX_REC_", "LEFT_BYTES").declarations(), "UTL_ENCODE") {
		t.Fatal("scalar record acquired an unrelated binary package prerequisite")
	}
	kind := "BLOB"
	graph.Nodes[1].Attributes[0]["ATTR_TYPE_NAME"] = &kind
	nodes, err = plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{root})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(newPLDebugCompositeEncoder(nodes, "DBX_REC_", "LEFT_BYTES").declarations(), "UTL_ENCODE.BASE64_ENCODE") {
		t.Fatal("binary record leaf has no connected base64 adapter")
	}
}
