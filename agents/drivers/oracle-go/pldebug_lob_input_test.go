package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	go_ora "github.com/sijms/go-ora/v2"
)

func TestPLDebugTypedLobInputValidation(t *testing.T) {
	for _, sample := range []struct {
		raw       string
		binary    bool
		remaining int
		valid     bool
	}{
		{`{"kind":"clob","value":"中文🙂\u0000"}`, false, 11, true},
		{`{"kind":"clob","value":""}`, false, 0, true},
		{`{"kind":"clob","value":"中文🙂\u0000"}`, false, 10, false},
		{`{"kind":"clob","value":null}`, false, 20, false},
		{`{"kind":"clob","value":"x","extra":1}`, false, 20, false},
		{`{"kind":"blob","value":{"encoding":"base64","data":"AP+A"}}`, true, 3, true},
		{`{"kind":"blob","value":{"encoding":"base64","data":""}}`, true, 0, true},
		{`{"kind":"blob","value":{"encoding":"base64","data":"AP+A"}}`, true, 2, false},
		{`{"kind":"blob","value":{"encoding":"base64"}}`, true, 10, false},
		{`{"kind":"blob","value":{"encoding":"base64","data":"AB=="}}`, true, 10, false},
		{`{"kind":"blob","value":{"encoding":"base64","data":"AA==\n\n\n\n"}}`, true, 10, false},
	} {
		_, err := plDebugDecodeLobInput(json.RawMessage(sample.raw), sample.binary, sample.remaining)
		if (err == nil) != sample.valid {
			t.Fatalf("unexpected validation result for %s: %v", sample.raw, err)
		}
	}
}

func TestPLDebugTypedLobInputBindAndEmptyDeclaration(t *testing.T) {
	for _, empty := range []bool{true, false} {
		c, b := "中文🙂\x00", []byte{0, 255, 128}
		if empty {
			c = ""
			b = []byte{}
		}
		cn, bn := "C", "B"
		plan := &plDebugNativePlan{typedSignature: &plDebugNativeTypedSignature{SignatureVersion: 2}, target: plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", ObjectType: "PROCEDURE"}, arguments: []plDebugNativeInput{
			{argument: plDebugNativeArgument{Name: &cn, Position: 1, Mode: "IN", Type: "CLOB"}, state: "value", value: plDebugLobInput{text: c, bytes: len(c)}},
			{argument: plDebugNativeArgument{Name: &bn, Position: 2, Mode: "IN", Type: "BLOB"}, state: "value", value: plDebugLobInput{binary: b, bytes: len(b)}},
		}}
		call, err := plan.bind(false)
		if err != nil {
			t.Fatal(err)
		}
		if call.arguments[0].(go_ora.Clob).String != c || !bytes.Equal(call.arguments[1].(go_ora.Blob).Data, b) {
			t.Fatal("LOB input bytes changed")
		}
		body := plan.render("DBX_LI_")
		want := 0
		if empty {
			want = 2
		}
		if strings.Count(body.Source, "SYS.DBMS_LOB.CREATETEMPORARY") != want {
			t.Fatal("empty LOB was confused with SQL NULL")
		}
		if !strings.Contains(body.ScopedDeclarations, " CLOB;") || !strings.Contains(body.ScopedDeclarations, " BLOB;") {
			t.Fatal("LOB local declaration lost")
		}
		call.phase = sql.NullInt64{Int64: 3, Valid: true}
		if call.result(plDebugNativeCapture{}, nil)["executionOutcome"] != "succeeded" {
			t.Fatal("input-only LOB lost normal target receipt")
		}
	}
}

func TestPLDebugTypedNullLobUsesTypedBindAndNullLocal(t *testing.T) {
	for _, kind := range []string{"CLOB", "BLOB"} {
		name := "X"
		plan := &plDebugNativePlan{typedSignature: &plDebugNativeTypedSignature{SignatureVersion: 2}, arguments: []plDebugNativeInput{{argument: plDebugNativeArgument{Name: &name, Position: 1, Mode: "IN", Type: kind}, state: "null"}}}
		call, err := plan.bind(false)
		if err != nil {
			t.Fatal(err)
		}
		switch value := call.arguments[0].(type) {
		case go_ora.Clob:
			if kind != "CLOB" || value.Valid {
				t.Fatal("incorrect NULL CLOB carrier")
			}
		case go_ora.Blob:
			if kind != "BLOB" || value.Valid {
				t.Fatal("incorrect NULL BLOB carrier")
			}
		default:
			t.Fatal("untyped NULL bind makes Oracle reject BLOB assignment")
		}
		source := plan.render("DBX_NULL_").Source
		if !strings.Contains(source, "DBX_NULL_ARG_0 := NULL;") || strings.Contains(source, "CREATETEMPORARY") {
			t.Fatal("NULL input became a non-NULL empty LOB")
		}
	}
}

func TestPLDebugTypedRequestWireBudgetRejectsBeforeStartOwnership(t *testing.T) {
	r := newRuntimeServer()
	r.plDebugRuntime = true
	line := `{"id":1,"method":"pl_debug_start","params":{"metadataPreparation":"type_only","padding":"` + strings.Repeat("x", plDebugTypedRequestWireBytes) + `"}}`
	response, _ := r.handleLine(line)
	if response.Error == nil || !strings.Contains(response.Error.Message, "wire byte budget") || len(r.plNativeEntries) != 0 {
		t.Fatal("oversized typed request reached start ownership")
	}
	legacy := strings.Replace(line, `"method":"pl_debug_start"`, `"method":"handshake"`, 1)
	response, _ = r.handleLine(legacy)
	if response.Error != nil {
		t.Fatal("typed request limit changed an existing handshake contract")
	}
}

func TestPLDebugTypedRawSelectionBoundsAndDriverBind(t *testing.T) {
	valid, name := "VALID", "R"
	argument := plDebugNativeArgument{Name: &name, Position: 1, Sequence: 1, Mode: "IN OUT", Type: "RAW"}
	candidate := plDebugNativeCandidate{Schema: "S", ObjectName: "RUN", ObjectType: "PROCEDURE", ObjectID: "42", SubprogramID: 1, Status: &valid, Arguments: []plDebugNativeArgument{argument}}
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: candidate, SignatureVersion: 2, MetadataPreparation: "type_only", ArgumentDetails: []plDebugNativeMetadataRow{}}
	value, err := plDebugNativeJSONValue(signature)
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{0, 3, 32767, 32768} {
		data := bytes.Repeat([]byte{255}, size)
		request := plDebugNativeStart{MetadataPreparation: "type_only", TargetSignature: value.(map[string]interface{}), Params: []interface{}{map[string]interface{}{"name": "R", "mode": "IN OUT", "type": "RAW", "inputState": "value", "typedValue": map[string]interface{}{"kind": "raw", "value": map[string]interface{}{"encoding": "base64", "data": base64.StdEncoding.EncodeToString(data)}}}}}
		plan, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{candidate}, request)
		if size > 32767 {
			if err == nil {
				t.Fatal("oversized RAW reached binding")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		call, err := plan.bind(false)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(call.arguments[0].([]byte), data) || !call.lobs[0].binary {
			t.Fatal("RAW was bound as text or exported through a text carrier")
		}
		body := plan.render("DBX_RAW_")
		if !strings.Contains(body.ScopedDeclarations, "RAW(32767)") || strings.Contains(body.Source, "CREATETEMPORARY") {
			t.Fatal("RAW empty input became a temporary LOB instead of SQL NULL")
		}
	}
}
