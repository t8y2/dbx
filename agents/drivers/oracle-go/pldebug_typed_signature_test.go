package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestPLDebugOracleTypedSignatureFreezesCompleteDetailsAndRejectsConcurrentChange(t *testing.T) {
	ptr := func(s string) *string { return &s }
	candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", PackageName: ptr("P"), ObjectType: "PROCEDURE", ObjectID: "42", SubprogramID: 1, Status: ptr("VALID"), Arguments: []plDebugNativeArgument{{Name: ptr("X"), Position: 1, Sequence: 1, Level: 0, Mode: "IN", Type: "PL/SQL RECORD", TypeOwner: ptr("S"), TypeName: ptr("P"), TypeSubname: ptr("R"), Defaulted: ptr("N")}}}
	for _, change := range []string{"none", "source", "details", "incomplete-source", "oci-null-strings"} {
		connector := &plDebugGraphTestConnector{argumentDetails: true, changed: change == "source", argumentChanged: change == "details", incompleteSource: change == "incomplete-source", emptyNullStrings: change == "oci-null-strings"}
		db := sql.OpenDB(connector)
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		signature, err := plDebugBuildNativeTypedSignature(context.Background(), conn, candidate)
		conn.Close()
		db.Close()
		if change != "none" && change != "oci-null-strings" {
			if err == nil {
				t.Fatalf("concurrent %s change accepted", change)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if signature.SignatureVersion != 2 || len(signature.TypeBindings) != 1 || signature.TypeBindings[0].Reference.TypeName != "R" || len(signature.TypeGraph.Nodes) != 1 || len(signature.TargetVersion.Objects) != 2 || signature.ArgumentDetails[0].text("DATA_LENGTH") != "40" || signature.ArgumentDetails[0]["PLS_TYPE"] != nil {
			t.Fatalf("incomplete signature: %+v", signature)
		}
		encoded, err := json.Marshal(signature)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(encoded), `"schema":"S"`) || !strings.Contains(string(encoded), `"signatureVersion":2`) || strings.Contains(string(encoded), `"plDebugNativeCandidate"`) {
			t.Fatal("v2 signature did not retain flat legacy identity")
		}
	}
}

func TestPLDebugOracleTypedDiscoveryBudgetDoesNotChangeLegacyQueries(t *testing.T) {
	c := plDebugTargetFixture()
	c.subprograms = [][]driver.Value{{int64(1)}}
	c.arguments = map[int64][][]driver.Value{1: {}}
	for i := int64(1); i <= 8193; i++ {
		c.arguments[1] = append(c.arguments[1], plDebugTargetArgument(fmt.Sprintf("P%d", i), i, i, 0, "IN", "NUMBER", "N"))
	}
	db := sql.OpenDB(c)
	defer db.Close()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	request := plDebugNativeStart{ObjectType: "PROCEDURE", ObjectName: "P", MetadataPreparation: "type_only"}
	if _, _, err = plDebugLoadNativeTargets(context.Background(), conn, request); err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatalf("typed discovery was not bounded: %v", err)
	}
	request.MetadataPreparation = ""
	_, candidates, err := plDebugLoadNativeTargets(context.Background(), conn, request)
	if err != nil || len(candidates) != 1 || len(candidates[0].Arguments) != 8193 {
		t.Fatalf("typed prerequisite leaked into legacy discovery: %v", err)
	}
}

func TestPLDebugOracleScalarSignatureRoundTripAndNationalIdentity(t *testing.T) {
	ptr := func(s string) *string { return &s }
	for _, kind := range []string{"NUMBER", "NCHAR", "NVARCHAR2"} {
		connector := &plDebugGraphTestConnector{argumentDetails: true, scalarArgument: kind, nationalCharset: "AL16UTF16"}
		db := sql.OpenDB(connector)
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", PackageName: ptr("P"), ObjectType: "PROCEDURE", ObjectID: "42", SubprogramID: 1, Status: ptr("VALID"), Arguments: []plDebugNativeArgument{{Name: ptr("X"), Position: 1, Sequence: 1, Mode: "IN", Type: kind, Defaulted: ptr("N")}}}
		signature, err := plDebugBuildNativeTypedSignature(context.Background(), conn, candidate)
		if err != nil {
			t.Fatal(err)
		}
		value, _ := plDebugNativeJSONValue(signature)
		frozen, err := plDebugDecodeNativeTypedSignature(plDebugNativeStart{MetadataPreparation: "type_only", TargetSignature: value.(map[string]interface{})})
		if err != nil {
			t.Fatal(err)
		}
		plan := &plDebugNativePlan{target: candidate, typedSignature: frozen}
		if err = plDebugRevalidateNativeTypedSignature(context.Background(), conn, plan, true, false); err != nil {
			t.Fatalf("%s roundtrip: %v", kind, err)
		}
		connector.nationalCharset = "UTF8"
		err = plDebugRevalidateNativeTypedSignature(context.Background(), conn, plan, false, false)
		if (err != nil) != (kind != "NUMBER") {
			t.Fatalf("%s character set change: %v", kind, err)
		}
		connector.nationalCharset = ""
		err = plDebugRevalidateNativeTypedSignature(context.Background(), conn, plan, true, false)
		if (err != nil) != (kind != "NUMBER") {
			t.Fatalf("%s missing character set: %v", kind, err)
		}
		if kind != "NUMBER" {
			connector.nationalCharset = "AL16UTF16"
			frozen.NationalCharacterSet = "UTF8"
			if err = plDebugRevalidateNativeTypedSignature(context.Background(), conn, plan, true, false); err == nil {
				t.Fatalf("%s accepted a client-modified character set", kind)
			}
		}
		conn.Close()
		db.Close()
	}
}

func TestPLDebugOracleTypedSelectionRequiresCompleteVersionedIdentity(t *testing.T) {
	valid := "VALID"
	candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", ObjectType: "PROCEDURE", ObjectID: "42", SubprogramID: 1, Status: &valid, Arguments: []plDebugNativeArgument{}}
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: candidate, SignatureVersion: 2, MetadataPreparation: "type_only", ArgumentDetails: []plDebugNativeMetadataRow{}}
	for _, change := range []string{"none", "unknown-version", "null-version", "missing-details", "unknown-field", "wrong-policy", "changed-id", "legacy"} {
		t.Run(change, func(t *testing.T) {
			value, err := plDebugNativeJSONValue(signature)
			if err != nil {
				t.Fatal(err)
			}
			request := plDebugNativeStart{MetadataPreparation: "type_only", TargetSignature: value.(map[string]interface{})}
			switch change {
			case "unknown-version":
				request.TargetSignature["signatureVersion"] = json.Number("3")
			case "null-version":
				request.TargetSignature["signatureVersion"] = nil
			case "missing-details":
				delete(request.TargetSignature, "argumentDetails")
			case "unknown-field":
				request.TargetSignature["unverified"] = true
			case "wrong-policy":
				request.MetadataPreparation = ""
			case "changed-id":
				request.TargetSignature["objectId"] = "43"
			case "legacy":
				value, _ := plDebugNativeJSONValue(candidate)
				request.TargetSignature, request.MetadataPreparation = value.(map[string]interface{}), ""
			}
			plan, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{candidate}, request)
			if change != "none" && change != "legacy" {
				if err == nil {
					t.Fatal("invalid signature selected")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if (plan.typedSignature != nil) != (change == "none") {
				t.Fatal("signature generation was not preserved")
			}
		})
	}
}

func TestPLDebugOracleTypedRevalidationRejectsFrozenMetadataChange(t *testing.T) {
	ptr := func(s string) *string { return &s }
	candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", PackageName: ptr("P"), ObjectType: "PROCEDURE", ObjectID: "42", SubprogramID: 1, Status: ptr("VALID"), Arguments: []plDebugNativeArgument{{Name: ptr("X"), Position: 1, Sequence: 1, Mode: "IN", Type: "PL/SQL RECORD", TypeOwner: ptr("S"), TypeName: ptr("P"), TypeSubname: ptr("R"), Defaulted: ptr("N")}}}
	for _, changed := range []bool{false, true} {
		connector := &plDebugGraphTestConnector{argumentDetails: true, objectField: true}
		db := sql.OpenDB(connector)
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		signature, err := plDebugBuildNativeTypedSignature(context.Background(), conn, candidate)
		if err != nil {
			t.Fatal(err)
		}
		if changed {
			signature.ArgumentDetails[0]["DATA_LENGTH"] = ptr("41")
		}
		plan := &plDebugNativePlan{target: candidate, typedSignature: &signature}
		if err := plDebugRevalidateNativeTypedSignature(context.Background(), conn, plan, false, false); err == nil {
			t.Fatal("dispatch accepted without original debuggee preparation")
		}
		beforePreparation := connector.base.execs
		err = plDebugRevalidateNativeTypedSignature(context.Background(), conn, plan, true, false)
		if err == nil {
			if connector.base.execs <= beforePreparation {
				t.Fatal("object references were not prepared before initialization")
			}
			beforeDispatch := connector.base.execs
			err = plDebugRevalidateNativeTypedSignature(context.Background(), conn, plan, false, false)
			if connector.base.execs != beforeDispatch {
				t.Fatal("dispatch revalidation executed an anonymous block after DEBUG_ON")
			}
		}
		conn.Close()
		db.Close()
		if (err != nil) != changed {
			t.Fatalf("changed=%v: %v", changed, err)
		}
	}
}

func TestPLDebugOracleTypedBooleanSelectionAndReceipts(t *testing.T) {
	valid, name := "VALID", "X"
	a := plDebugNativeArgument{Name: &name, Position: 1, Sequence: 1, Mode: "IN OUT", Type: "PL/SQL BOOLEAN"}
	candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", ObjectType: "PROCEDURE", ObjectID: "42", SubprogramID: 1, Status: &valid, Arguments: []plDebugNativeArgument{a}}
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: candidate, SignatureVersion: 2, MetadataPreparation: "type_only", ArgumentDetails: []plDebugNativeMetadataRow{}}
	for _, test := range []struct {
		name           string
		payload        interface{}
		state          string
		legacy, reject bool
	}{
		{"true", map[string]interface{}{"kind": "boolean", "value": true}, "value", false, false},
		{"false", map[string]interface{}{"kind": "boolean", "value": false}, "value", false, false},
		{"null", nil, "null", false, false},
		{"text", map[string]interface{}{"kind": "boolean", "value": "true"}, "value", false, true},
		{"wrong-kind", map[string]interface{}{"kind": "text", "value": true}, "value", false, true},
		{"typed-null", map[string]interface{}{"kind": "boolean", "value": nil}, "value", false, true},
		{"null-envelope", json.RawMessage("null"), "value", false, true},
		{"legacy", map[string]interface{}{"kind": "boolean", "value": true}, "value", true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			value, _ := plDebugNativeJSONValue(signature)
			request := plDebugNativeStart{MetadataPreparation: "type_only", TargetSignature: value.(map[string]interface{})}
			if test.legacy {
				value, _ = plDebugNativeJSONValue(candidate)
				request.TargetSignature = value.(map[string]interface{})
				request.MetadataPreparation = ""
			}
			parameter := map[string]interface{}{"name": "X", "mode": "IN OUT", "type": "PL/SQL BOOLEAN", "inputState": test.state}
			if test.payload != nil {
				parameter["typedValue"] = test.payload
			}
			request.Params = []interface{}{parameter}
			plan, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{candidate}, request)
			if test.reject {
				if err == nil {
					t.Fatal("malformed BOOLEAN accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			call, err := plan.bind(false)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(call.arguments[len(call.arguments)-1], plDebugOutArg(false, &call.phase)) {
				t.Fatal("typed phase binding must follow scoped output bindings")
			}
			want := interface{}(int64(0))
			if test.name == "true" {
				want = int64(1)
			}
			if test.name == "null" {
				want = nil
			}
			if call.arguments[0] != want {
				t.Fatal("BOOLEAN binding did not preserve true/false/NULL")
			}
			call.phase = sql.NullInt64{Int64: 3, Valid: true}
			call.copied[0] = sql.NullInt64{Int64: 1, Valid: true}
			call.values[0] = sql.NullString{String: test.name, Valid: test.name != "null"}
			result := call.result(plDebugNativeCapture{}, nil)
			out := result["outParams"].([]map[string]interface{})[0]
			typed, ok := out["typedValue"].(map[string]interface{})
			if !ok || typed["kind"] != "boolean" {
				t.Fatal("typed BOOLEAN output missing")
			}
			if test.name == "null" {
				if typed["value"] != nil {
					t.Fatal("NULL became false")
				}
			} else if typed["value"] != (test.name == "true") {
				t.Fatal("BOOLEAN output changed")
			}
		})
	}
}

func TestPLDebugOracleDictionarySlashINOUTPreservesRawDetails(t *testing.T) {
	fixture := plDebugTargetFixture()
	fixture.subprograms = [][]driver.Value{{int64(1)}}
	fixture.arguments = map[int64][][]driver.Value{1: {plDebugTargetArgument("X", 1, 1, 0, "IN/OUT", "PL/SQL BOOLEAN", "N")}}
	db := sql.OpenDB(fixture)
	defer db.Close()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, candidates, err := plDebugLoadNativeTargets(context.Background(), conn, plDebugNativeStart{ObjectType: "PROCEDURE", ObjectName: "RUN"})
	if err != nil || len(candidates) != 1 || candidates[0].Arguments[0].Mode != "IN OUT" {
		t.Fatalf("native dictionary IN/OUT rejected: %v", err)
	}
	ptr := func(s string) *string { return &s }
	row := plDebugNativeMetadataRow{"ARGUMENT_NAME": ptr("X"), "POSITION": ptr("1"), "SEQUENCE": ptr("1"), "DATA_LEVEL": ptr("0"), "IN_OUT": ptr("IN/OUT"), "DATA_TYPE": ptr("PL/SQL BOOLEAN"), "DEFAULTED": ptr("N")}
	if !plDebugNativeArgumentDetailsMatch(candidates[0], []plDebugNativeMetadataRow{row}) || row.text("IN_OUT") != "IN/OUT" {
		t.Fatal("normalized signature rejected or rewrote raw frozen dictionary details")
	}
}
