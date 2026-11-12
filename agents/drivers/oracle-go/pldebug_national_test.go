package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestPLDebugNclobSourceSummarySurvivesCarrierCaching(t *testing.T) {
	for _, state := range []string{"null", "empty", "value", "partial", "invalid"} {
		value := interface{}("中🙂")
		sourceLength := interface{}(int64(3))
		retained := int64(3)
		carrierState, receipt := "value", int64(3)
		if state == "null" {
			value, sourceLength, retained = nil, nil, 0
		}
		if state == "empty" {
			value, sourceLength, retained = "", int64(0), 0
		}
		if state == "partial" {
			sourceLength, carrierState, receipt = int64(20), "partial", 5
		}
		if state == "invalid" {
			retained = 2
		}
		data, _ := json.Marshal(map[string]interface{}{"kind": "nclob", "state": state, "value": value, "sourceLength": sourceLength, "retainedLength": retained, "lengthUnit": "utf16"})
		length := sql.NullInt64{Int64: int64(len(utf16.Encode([]rune(string(data))))), Valid: true}
		status := sql.NullInt64{Int64: receipt, Valid: true}
		output := &plDebugLobOutput{memory: true, nationalLob: true, receipt: &status, length: &length, read: func(int) ([]byte, error) { return data, nil }}
		output.collect(context.Background(), nil, plDebugTypedResultBytes)
		if output.state != carrierState {
			t.Fatalf("%s changed carrier state: %s", state, output.state)
		}
		output.data = nil
		if state == "invalid" {
			if output.nationalSource != nil {
				t.Fatal("invalid source summary accepted")
			}
			continue
		}
		if output.nationalSource == nil || output.nationalSource.State != state || *output.nationalSource.RetainedLength != retained || output.nationalSource.Value != nil {
			t.Fatalf("%s source summary lost or retained duplicate text", state)
		}
		entry := &plDebugNativeEntry{agentSessionID: "owner", captureFinished: true, releaseState: "released"}
		reference, err := entry.resultCache.retain(data, false, "X")
		if err != nil {
			t.Fatal(err)
		}
		output.reference = reference
		name := "X"
		plan := &plDebugNativePlan{typedSignature: &plDebugNativeTypedSignature{}, arguments: []plDebugNativeInput{{argument: plDebugNativeArgument{Name: &name, Position: 1, Mode: "OUT", Type: "NCLOB"}}}}
		call := &plDebugNativeNamedCall{plan: plan, phase: sql.NullInt64{Int64: 3, Valid: true}, lobs: map[int]*plDebugLobOutput{0: output}}
		entry.namedResult = call.result(plDebugNativeCapture{}, nil)
		item := entry.namedResult["outParams"].([]map[string]interface{})[0]
		if item["state"] != state {
			t.Fatalf("%s source state changed after result assembly", state)
		}
		runtime := newRuntimeServer()
		runtime.plDebugRuntime = true
		runtime.plNativeEntries = map[string]*plDebugNativeEntry{"original": entry}
		page := plDebugManagerSnapshot(t, plDebugManagerRPC(t, runtime, "pl_debug_get_result_page", map[string]interface{}{"debugId": "original", "agentSessionId": "owner", "generation": reference["generation"], "resultId": reference["resultId"], "offset": 0, "limit": 4096}))
		if page["data"] != string(data) || page["length"] != reference["length"] {
			t.Fatalf("%s released NCLOB JSON cache page changed", state)
		}
	}
}

func TestPLDebugNclobInitializationKeepsNullEmptyAndChunkedInputDistinct(t *testing.T) {
	for _, text := range []string{"", strings.Repeat("中🙂", 10000)} {
		raw, _ := json.Marshal(map[string]interface{}{"kind": "nclob", "value": text})
		value, err := plDebugDecodeBinaryOrLobInput(raw, "nclob", plDebugTypedInputBytes)
		if err != nil || value.text != text || value.bytes != len(text) {
			t.Fatalf("NCLOB text decode: %v", err)
		}
		builder := plDebugCollectionInitializer{prefix: "DBX_TEST_"}
		builder.scalar(plDebugNativeInput{argument: plDebugNativeArgument{Type: "NCLOB"}, state: "value", value: value}, "ROOT")
		bindings := 0
		for _, operation := range builder.operations {
			if operation.input != nil {
				bindings++
				if operation.input.argument.Type != plDebugNationalChunkType || len(operation.input.value.(string)) > 30000 {
					t.Fatal("NCLOB input escaped its ASCII national chunk transport")
				}
			}
		}
		if len(builder.names) != 2 || (bindings == 0) != (text == "") || len(text) > 32767 && bindings < 2 {
			t.Fatal("NCLOB empty or large input was collapsed into a scalar")
		}
	}
	builder := plDebugCollectionInitializer{}
	builder.scalar(plDebugNativeInput{argument: plDebugNativeArgument{Type: "NCLOB"}, state: "null"}, "ROOT")
	if len(builder.names) != 0 || len(builder.operations) != 1 {
		t.Fatal("NULL NCLOB allocated an input locator")
	}
}

func TestPLDebugNationalInputChunksPreserveWholeUnicodeCharacters(t *testing.T) {
	input := plDebugEncodeNationalInput("中🙂\\\x00\"")
	if len(input.chunks) != 1 || input.chunks[0] != `\4E2D\D83D\DE42\005C\0000\0022` {
		t.Fatal("national ASCII carrier lost Unicode/control/backslash identity")
	}
	input = plDebugEncodeNationalInput(strings.Repeat("中", 5999) + "🙂" + strings.Repeat("文", 2))
	if len(input.chunks) != 2 || len(input.chunks[0]) != 29995 || !strings.HasPrefix(input.chunks[1], `\D83D\DE42`) {
		t.Fatal("national chunk split a surrogate pair or exceeded its scalar bind budget")
	}
	for _, chunk := range input.chunks {
		if len(chunk) > 30000 {
			t.Fatal("national bind chunk exceeds budget")
		}
	}
}

func TestPLDebugNationalRootCarrierUsesFrozenCharacterSet(t *testing.T) {
	name := "X"
	for _, charset := range []string{"AL16UTF16", "UTF8"} {
		plan := &plDebugNativePlan{
			target:         plDebugNativeCandidate{Schema: "S", ObjectName: "P", ObjectType: "PROCEDURE", Arguments: []plDebugNativeArgument{{Name: &name, Position: 1, Mode: "OUT", Type: "NCHAR"}}},
			typedSignature: &plDebugNativeTypedSignature{NationalCharacterSet: charset},
		}
		plan.arguments = []plDebugNativeInput{{argument: plan.target.Arguments[0], state: "value"}}
		block, err := plan.block()
		if err != nil {
			t.Fatal(err)
		}
		width := "32767"
		if charset == "AL16UTF16" {
			width = "16383"
		}
		if !strings.Contains(block.SQL, "NVARCHAR2("+width+")") {
			t.Fatalf("%s did not retain its frozen national carrier", charset)
		}
	}
}

func TestPLDebugNationalRootRequiresCharacterSetIdentity(t *testing.T) {
	for _, kind := range []string{"NCHAR", "NVARCHAR2", "NUMBER"} {
		for _, charset := range []string{"", "AL16UTF16"} {
			signature := plDebugNativeTypedSignature{
				plDebugNativeCandidate: plDebugNativeCandidate{Arguments: []plDebugNativeArgument{{Type: kind}}},
				SignatureVersion:       2, MetadataPreparation: "type_only", ArgumentDetails: []plDebugNativeMetadataRow{},
				NationalCharacterSet: charset,
			}
			value, err := plDebugNativeJSONValue(signature)
			if err != nil {
				t.Fatal(err)
			}
			_, err = plDebugDecodeNativeTypedSignature(plDebugNativeStart{MetadataPreparation: "type_only", TargetSignature: value.(map[string]interface{})})
			if (err != nil) != (kind != "NUMBER" && charset == "") {
				t.Fatalf("kind=%s charset=%q: %v", kind, charset, err)
			}
		}
	}
}
