package main

import "testing"

func TestPLDebugBinaryFloatHexPreservesNativeInputBits(t *testing.T) {
	for _, test := range []struct {
		value, want string
		double      bool
	}{
		{"00000001", "00000001", false}, {"80000000", "80000000", false},
		{"7fc01234", "7FC01234", false}, {"ff800000", "FF800000", false},
		{"7fefffffffffffff", "7FEFFFFFFFFFFFFF", true}, {"7ff8000000001234", "7FF8000000001234", true},
	} {
		value, err := plDebugNativeBinaryFloatHex(test.value, test.double)
		if err != nil || value != test.want {
			t.Fatalf("%s: got %q, %v", test.value, value, err)
		}
	}
	for _, value := range []string{"", "1", "0x000001", "0000000G", "00000000 ", "１２３４５６７８", "0000000000000000"} {
		if _, err := plDebugNativeBinaryFloatHex(value, false); err == nil {
			t.Fatalf("invalid FLOAT hex accepted: %q", value)
		}
	}
	if _, err := plDebugNativeBinaryFloatHex("00000000", true); err == nil {
		t.Fatal("FLOAT width accepted for DOUBLE")
	}
}

func TestPLDebugBinaryFloatTypedSelectionRejectsNumericBypass(t *testing.T) {
	valid, name := "VALID", "X"
	for _, kind := range []string{"BINARY_FLOAT", "BINARY_DOUBLE"} {
		a := plDebugNativeArgument{Name: &name, Position: 1, Sequence: 1, Mode: "IN", Type: kind}
		candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", ObjectType: "PROCEDURE", ObjectID: "42", SubprogramID: 1, Status: &valid, Arguments: []plDebugNativeArgument{a}}
		signature := plDebugNativeTypedSignature{plDebugNativeCandidate: candidate, SignatureVersion: 2, MetadataPreparation: "type_only", ArgumentDetails: []plDebugNativeMetadataRow{}}
		identity, _ := plDebugNativeJSONValue(signature)
		text, want, tag := "7fc01234", "7FC01234", "binary_float"
		if kind == "BINARY_DOUBLE" {
			text, want, tag = "7ff8000000001234", "7FF8000000001234", "binary_double"
		}
		for _, mode := range []string{"typed", "raw", "numeric", "wrong-kind", "extra-field", "short"} {
			param := map[string]interface{}{"name": "X", "mode": "IN", "type": kind}
			payload := map[string]interface{}{"kind": tag, "value": text}
			switch mode {
			case "raw":
				param["value"] = text
			case "numeric":
				payload["value"] = 1
			case "wrong-kind":
				payload["kind"] = "number"
			case "extra-field":
				payload["extra"] = true
			case "short":
				payload["value"] = "0"
			}
			if mode != "raw" {
				param["typedValue"] = payload
			}
			plan, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{candidate}, plDebugNativeStart{MetadataPreparation: "type_only", TargetSignature: identity.(map[string]interface{}), Params: []interface{}{param}})
			if mode != "typed" {
				if err == nil {
					t.Fatalf("%s accepted %s bypass", kind, mode)
				}
				continue
			}
			if err != nil || plan.arguments[0].value != want {
				t.Fatalf("%s typed identity: %v", kind, err)
			}
		}
	}
}
