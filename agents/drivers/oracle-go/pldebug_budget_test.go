package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestPLDebugTypedBindAndGeneratedSQLBudgetsBeforeDispatch(t *testing.T) {
	plan := &plDebugNativePlan{typedSignature: &plDebugNativeTypedSignature{SignatureVersion: 2}}
	for i := 0; i < 5460; i++ {
		name := fmt.Sprintf("P%d", i)
		plan.arguments = append(plan.arguments, plDebugNativeInput{argument: plDebugNativeArgument{Name: &name, Position: int64(i + 1), Mode: "OUT", Type: "BLOB"}})
	}
	if _, err := plan.bind(false); err == nil || !strings.Contains(err.Error(), "bind count budget") {
		t.Fatal("too many typed output binds were allocated")
	}
	plan.arguments = nil
	for i := 0; i < 8192; i++ {
		name := fmt.Sprintf("P%04d", i) + strings.Repeat("A", 120)
		plan.arguments = append(plan.arguments, plDebugNativeInput{argument: plDebugNativeArgument{Name: &name, Position: int64(i + 1), Mode: "IN", Type: "VARCHAR2"}, state: "null"})
	}
	if _, err := plan.block(); err == nil || !strings.Contains(err.Error(), "SQL byte budget") {
		t.Fatal("oversized generated SQL was accepted")
	}
	plan.typedSignature = nil
	if _, err := plan.block(); err != nil {
		t.Fatal("typed SQL budget changed legacy generation contract")
	}
}

func TestPLDebugTypedInputPayloadBudgetIncludesScalarAndLobTogether(t *testing.T) {
	valid, cname, tname := "VALID", "C", "T"
	candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", ObjectType: "PROCEDURE", ObjectID: "42", Status: &valid, Arguments: []plDebugNativeArgument{{Name: &cname, Position: 1, Sequence: 1, Mode: "IN", Type: "CLOB"}, {Name: &tname, Position: 2, Sequence: 2, Mode: "IN", Type: "VARCHAR2"}}}
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: candidate, SignatureVersion: 2, MetadataPreparation: "type_only", ArgumentDetails: []plDebugNativeMetadataRow{}}
	value, err := plDebugNativeJSONValue(signature)
	if err != nil {
		t.Fatal(err)
	}
	for _, extra := range []int{0, 1} {
		request := plDebugNativeStart{MetadataPreparation: "type_only", TargetSignature: value.(map[string]interface{}), Params: []interface{}{
			map[string]interface{}{"name": "C", "mode": "IN", "type": "CLOB", "typedValue": map[string]interface{}{"kind": "clob", "value": strings.Repeat("x", 1024)}},
			map[string]interface{}{"name": "T", "mode": "IN", "type": "VARCHAR2", "value": strings.Repeat("x", plDebugTypedInputBytes-1024+extra)},
		}}
		_, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{candidate}, request)
		if extra == 0 && err != nil || extra == 1 && (err == nil || !strings.Contains(err.Error(), "input byte budget")) {
			t.Fatalf("mixed input budget boundary failed: extra=%d err=%v", extra, err)
		}
	}
}
