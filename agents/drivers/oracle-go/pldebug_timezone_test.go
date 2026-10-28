package main

import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
)

func TestPLDebugTimezoneResultValidatesFourComponentsWithoutLosingExtendedYears(t *testing.T) {
	part := func(value string) sql.NullString { return sql.NullString{String: value, Valid: true} }
	argument := plDebugNativeArgument{Type: plDebugTimestampTZ, Mode: "OUT"}
	parts := [4]sql.NullString{part("9999-12-31T23:59:59.123456789"), part("-12:59"), part("+10000-01-01T12:58:59.123456789"), part("UNKNOWN")}
	item, err := plDebugNativeTimezoneResult(argument, parts, true, true)
	if err != nil {
		t.Fatal(err)
	}
	value := item["typedValue"].(map[string]interface{})["value"].(map[string]interface{})
	if value["instant"] != "+10000-01-01T12:58:59.123456789Z" || value["region"] != nil || value["regionState"] != "not_returned" {
		t.Fatal("native extended instant or region evidence changed")
	}
	for component := range parts {
		broken := parts
		broken[component] = sql.NullString{}
		if _, err := plDebugNativeTimezoneResult(argument, broken, true, true); err == nil {
			t.Fatal("a missing timezone component was reported as a complete value")
		}
	}
	if _, err := plDebugNativeTimezoneResult(argument, parts, false, true); err == nil {
		t.Fatal("timezone output without logical DONE was accepted")
	}
	if _, err := plDebugNativeTimezoneResult(argument, [4]sql.NullString{}, true, false); err == nil {
		t.Fatal("uncertain execution was treated as SQL NULL")
	}
	if item, err := plDebugNativeTimezoneResult(argument, [4]sql.NullString{}, true, true); err != nil || item["state"] != "null" {
		t.Fatal("verified TZ NULL changed")
	}
	argument.Type = plDebugTimestampLTZ
	if _, err := plDebugNativeTimezoneResult(argument, [4]sql.NullString{}, true, true); err == nil {
		t.Fatal("LTZ NULL silently lost its session context")
	}
	if item, err := plDebugNativeTimezoneResult(argument, [4]sql.NullString{{}, {}, {}, part("America/New_York")}, true, true); err != nil || item["state"] != "null" || item["sessionTimeZone"] != "America/New_York" {
		t.Fatal("LTZ NULL context was not retained")
	}
	if !plDebugNativeTimezoneOutputText("0000-12-31T10:00:00.123456789") || plDebugNativeTimezoneOutputText("2024-02-30T10:00:00.123456789") {
		t.Fatal("timezone output calendar validator confused input and extended UTC contracts")
	}
}

func TestPLDebugTimezoneRecordConsumesDictionaryAliasesWithoutChangingFrozenRows(t *testing.T) {
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "R"}
	code, name, kind := "PL/SQL RECORD", "T", "TIMESTAMP WITH TZ"
	row := plDebugNativeMetadataRow{"ATTR_NAME": &name, "ATTR_TYPE_NAME": &kind}
	graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{{Reference: ref, Definition: plDebugNativeMetadataRow{"TYPECODE": &code}, Attributes: []plDebugNativeMetadataRow{row}}}}
	raw := json.RawMessage(`{"kind":"record","value":[{"name":"T","value":{"kind":"timestamp_tz","value":{"local":"2024-11-03T01:30:00.123456789","offset":"-04:00","region":"America/New_York"}}}]}`)
	input, err := plDebugDecodeRecordInput(graph, ref, raw, 8192, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(input.leaves) != 1 || input.leaves[0].input.argument.Type != plDebugTimestampTZ || !input.needsInitializer() {
		t.Fatal("timezone record leaf did not select the strong typed initializer")
	}
	builder := plDebugCollectionInitializer{prefix: "DBX_IN_", timezonePrefix: "DBX_TZ_"}
	if err := builder.record(input, "DBX_VALUE"); err != nil {
		t.Fatal(err)
	}
	bindings := 0
	for _, operation := range builder.operations {
		if operation.input != nil {
			bindings++
		}
	}
	if bindings != 3 || row.text("ATTR_TYPE_NAME") != "TIMESTAMP WITH TZ" {
		t.Fatal("timezone alias changed evidence or physical input width")
	}
	if _, err := plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{ref}); err != nil {
		t.Fatal("raw timezone alias could not be exported")
	}
}

func TestPLDebugTimezoneInputKeepsExactLocalAndNativeRegion(t *testing.T) {
	raw := json.RawMessage(`{"local":"2024-11-03T01:30:00.123456789","offset":"-04:00","region":"America/New_York"}`)
	value, err := plDebugDecodeTimezoneInput(raw, false, 1000)
	if err != nil || value.wall.day != "2024-11-03" || value.wall.seconds != "5400.123456789" || value.offset != "-04:00" || value.region == nil || *value.region != "America/New_York" {
		t.Fatalf("exact timezone components lost: %+v %v", value, err)
	}
	for _, region := range []string{"America/New_York", "DBX/NotInHostTimezoneDatabase"} {
		payload, _ := json.Marshal(map[string]string{"local": "1969-12-31T23:45:00.000000001", "offset": "-00:30", "region": region})
		if _, err := plDebugDecodeTimezoneInput(payload, false, 1000); err != nil {
			t.Fatal("host timezone database became an input prerequisite")
		}
	}
	ltz, err := plDebugDecodeTimezoneInput(json.RawMessage(`{"instant":"1969-12-31T23:59:59.000000001Z"}`), true, 1000)
	if err != nil || ltz.wall.day != "1969-12-31" || ltz.wall.seconds != "86399.000000001" || ltz.region != nil {
		t.Fatal("LTZ instant was parsed through host time")
	}
	if _, err := plDebugDecodeTimezoneInput(raw, false, value.bytes-1); err == nil {
		t.Fatal("timezone components escaped cumulative byte budget")
	}
}

func TestPLDebugTimezoneRootInputUsesExistingExactNumberAndTextBindings(t *testing.T) {
	for _, isNull := range []bool{false, true} {
		tzName, ltzName := "T", "L"
		tz := plDebugNativeArgument{Name: &tzName, Mode: "IN", Type: plDebugTimestampTZ, Position: 1}
		ltz := plDebugNativeArgument{Name: &ltzName, Mode: "IN", Type: plDebugTimestampLTZ, Position: 2}
		state := "value"
		var tv, lv interface{}
		if isNull {
			state = "null"
		} else {
			var err error
			tv, err = plDebugDecodeTimezoneInput(json.RawMessage(`{"local":"2024-11-03T01:30:00.123456789","offset":"-04:00","region":"America/New_York"}`), false, 1000)
			if err != nil {
				t.Fatal(err)
			}
			lv, err = plDebugDecodeTimezoneInput(json.RawMessage(`{"instant":"2024-11-03T05:30:00.123456789Z"}`), true, 1000)
			if err != nil {
				t.Fatal(err)
			}
		}
		plan := &plDebugNativePlan{arguments: []plDebugNativeInput{{argument: tz, state: state, value: tv}, {argument: ltz, state: state, value: lv}}}
		if plan.inputCount() != 4 {
			t.Fatal("NULL and value must use the same physical timezone input width")
		}
		call, err := plan.bind(false)
		if err != nil {
			t.Fatal(err)
		}
		if len(call.arguments) != 5 {
			t.Fatal("timezone input binding changed the legacy phase slot")
		}
		if isNull {
			for _, binding := range call.arguments[:4] {
				if binding != nil {
					t.Fatal("NULL timezone input bound a fabricated component")
				}
			}
		} else if call.arguments[1] != "-04:00" || call.arguments[2] != "America/New_York" {
			t.Fatal("timezone offset or region bypassed original text binding")
		}
	}
}

func TestPLDebugTimezoneOffsetBoundariesAndZeroNormalization(t *testing.T) {
	for _, text := range []string{"-12:59", "-00:30", "+00:00", "+13:59", "+14:00"} {
		if actual, err := plDebugNativeTimezoneOffset(text); err != nil || actual != text {
			t.Fatalf("valid datetime offset rejected: %s", text)
		}
	}
	if value, err := plDebugNativeTimezoneOffset("-00:00"); err != nil || value != "+00:00" {
		t.Fatal("zero timezone offset was not canonicalized")
	}
	for _, text := range []string{"-13:00", "+14:01", "+00:60", "+1:00", "00:00", " +00:00", "＋00:00", "+18:00"} {
		if _, err := plDebugNativeTimezoneOffset(text); err == nil {
			t.Fatalf("invalid offset accepted: %s", text)
		}
	}
}

func TestPLDebugTimezoneInputRejectsMalformedComponentsWithoutTrimming(t *testing.T) {
	for _, raw := range []string{`null`, `"x"`, `{}`, `{"local":"2024-01-01T00:00:00","offset":null}`, `{"local":"2024-02-30T00:00:00","offset":"+00:00"}`, `{"local":"2024-01-01T00:00:00.1234567890","offset":"+00:00"}`, `{"local":"2024-01-01T00:00:00 ","offset":"+00:00"}`, `{"local":"2024-01-01T00:00:00","offset":"+00:00","extra":"x"}`, `{"local":"2024-01-01T00:00:00","offset":"+00:00","region":""}`, `{"local":"2024-01-01T00:00:00","offset":"+00:00","region":7}`} {
		if _, err := plDebugDecodeTimezoneInput(json.RawMessage(raw), false, 1000); err == nil {
			t.Fatalf("malformed TZ input accepted: %s", raw)
		}
	}
	for _, raw := range []string{`{"instant":"2024-01-01T00:00:00+00:00"}`, `{"instant":"2024-01-01T00:00:00z"}`, `{"instant":"2024-01-01T00:00:00Z","region":"UTC"}`, `{"instant":null}`} {
		if _, err := plDebugDecodeTimezoneInput(json.RawMessage(raw), true, 1000); err == nil {
			t.Fatalf("malformed LTZ input accepted: %s", raw)
		}
	}
	long, _ := json.Marshal(map[string]string{"local": "2024-01-01T00:00:00", "offset": "+00:00", "region": strings.Repeat("X", 129)})
	if _, err := plDebugDecodeTimezoneInput(long, false, 1000); err == nil {
		t.Fatal("region exceeded Oracle component capacity")
	}
}
