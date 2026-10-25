package main

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

var exactTriggerColumns = []string{"OWNER", "TRIGGER_NAME", "EVENT", "TIMING", "ENABLED", "PARENT_OWNER", "PARENT_NAME", "SCOPE", "DESCRIPTION", "CONDITION", "REFERENCING", "OBJECT_ID", "DDL_TIME", "VALIDITY"}

func exactTriggerRow(owner, name, id string) []driver.Value {
	return []driver.Value{owner, name, "INSERT", "INSTEAD OF", "DISABLED", " Parent Owner ", " View ", "VIEW", nil, nil, nil, id, "2026-10-21 08:00:00", "INVALID"}
}

func exactTriggerStep(owner, name, id string) oracleViewSourceQueryStep {
	return oracleViewSourceQueryStep{queryContains: "FROM ALL_TRIGGERS", args: []driver.Value{owner, name}, columns: exactTriggerColumns, rows: [][]driver.Value{exactTriggerRow(owner, name, id)}}
}

func exactTriggerParams(text string) map[string]json.RawMessage {
	var params map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &params); err != nil {
		panic(err)
	}
	return params
}

func TestExactTriggerSchemaRPCPreservesPagedIdentity(t *testing.T) {
	owner, name := " Owner ", " Trigger "
	metadata := exactTriggerStep(owner, name, "9007199254740993")
	db, scripted := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
		{queryContains: "'PACKAGE BODY', 'INDEX', 'TRIGGER'", args: []driver.Value{owner, owner, owner, owner, "%T%R%I%G%", "TRIGGER", int64(3), int64(2)},
			columns: []string{"OBJECT_NAME", "OBJECT_TYPE", "COMMENTS", "PARENT_SCHEMA", "PARENT_NAME"}, rows: [][]driver.Value{{name, "TRIGGER", nil, nil, nil}}},
		metadata,
	})
	s := newServer()
	s.db = db
	value, _, err := s.dispatch("list_objects", exactTriggerParams(`{"schema":" Owner ","object_types":["TRIGGER"],"filter":"trig","limit":1,"offset":2,"identity_mode":"exact"}`))
	if err != nil {
		t.Fatal(err)
	}
	objects := value.([]objectInfo)
	if len(objects) != 1 || objects[0].Name != name || objects[0].Trigger == nil {
		t.Fatalf("missing exact trigger: %#v", objects)
	}
	trigger := objects[0].Trigger
	if trigger.OracleMetadata.Owner != owner || trigger.OracleMetadata.Parent.Owner != " Parent Owner " {
		t.Fatalf("owners collapsed: %#v", trigger.OracleMetadata)
	}
	if trigger.Enabled == nil || *trigger.Enabled || trigger.Valid == nil || *trigger.Valid {
		t.Fatalf("independent states missing: %#v", trigger)
	}
	if *trigger.OracleMetadata.ObjectID != "9007199254740993" || trigger.Statement != nil {
		t.Fatalf("summary must retain ID without loading source: %#v", trigger)
	}
	if scripted.next != 2 {
		t.Fatalf("unexpected source or approximate lookup: %d", scripted.next)
	}
}

func TestExactTriggerParentRPCKeepsComplexDefinition(t *testing.T) {
	definition := "TRIGGER \" Trigger \" INSTEAD OF INSERT ON \" Parent Owner \".\" View \"\nREFERENCING NEW AS N OLD AS O\nFOR EACH ROW\nBEGIN NULL; END;"
	row := append(exactTriggerRow(" Owner ", " Trigger ", "42"), int64(1), definition)
	row[10] = "REFERENCING NEW AS N OLD AS O"
	db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{{queryContains: "t.TABLE_OWNER=:1 AND t.TABLE_NAME=:2", args: []driver.Value{" Parent Owner ", " View "},
		columns: append(append([]string{}, exactTriggerColumns...), "LINE", "TEXT"), rows: [][]driver.Value{row}}})
	s := newServer()
	s.db = db
	value, _, err := s.dispatch("list_triggers", exactTriggerParams(`{"schema":" Parent Owner ","table":" View ","identity_mode":"exact"}`))
	if err != nil {
		t.Fatal(err)
	}
	trigger := value.([]triggerInfo)[0]
	if trigger.OracleMetadata.Owner != " Owner " || trigger.Statement == nil || *trigger.Statement != definition {
		t.Fatalf("complex source or independent owner lost: %#v", trigger)
	}
}

func TestExactTriggerSourceRPCReadsInvalidErrorsAndRetainsLongSource(t *testing.T) {
	owner, name := " Owner ", " Trigger "
	definition := "TRIGGER \" Trigger \" INSTEAD OF INSERT ON \" Parent Owner \".\" View \"\nBEGIN /* " + strings.Repeat("中文😀", 12_000) + " */ NULL; END;"
	db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
		exactTriggerStep(owner, name, "42"),
		{queryContains: "XMLAGG", args: []driver.Value{owner, name, "TRIGGER"}, rows: [][]driver.Value{{definition}}},
		{queryContains: "FROM ALL_ERRORS", args: []driver.Value{owner, name}, columns: []string{"SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE"}, rows: [][]driver.Value{{int64(1), int64(4), int64(7), "Missing procedure", "ERROR"}}},
		exactTriggerStep(owner, name, "42"),
	})
	s := newServer()
	s.db = db
	value, _, err := s.dispatch("get_object_source", exactTriggerParams(`{"schema":" Owner ","name":" Trigger ","object_type":"TRIGGER","identity_mode":"exact"}`))
	if err != nil {
		t.Fatal(err)
	}
	source := value.(map[string]any)
	trigger := source["trigger"].(triggerInfo)
	if source["source"] != definition || !trigger.OracleMetadata.Definition.Complete {
		t.Fatal("full source was lost or not verified")
	}
	if trigger.Valid == nil || *trigger.Valid || len(trigger.OracleMetadata.Errors) != 1 || trigger.OracleMetadata.Errors[0].Position != 7 {
		t.Fatalf("INVALID/errors lost: %#v", trigger)
	}
}

func TestExactTriggerListAndSourceUseTheSameStatement(t *testing.T) {
	owner, name := " Owner ", " Trigger "
	description := "\" Trigger \" INSTEAD OF INSERT ON \" Parent Owner \".\" View \""
	for _, referencing := range []string{"REFERENCING NEW AS NEW OLD AS OLD", "REFERENCING NEW AS N OLD AS O"} {
		t.Run(referencing, func(t *testing.T) {
			definition := "TRIGGER " + description + "\nBEGIN NULL; END;"
			before, after := exactTriggerStep(owner, name, "42"), exactTriggerStep(owner, name, "42")
			for _, step := range []*oracleViewSourceQueryStep{&before, &after} {
				step.rows[0][8], step.rows[0][10] = description, referencing
			}
			row := append(append([]driver.Value{}, before.rows[0]...), int64(1), definition)
			db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
				{queryContains: "t.TABLE_OWNER=:1 AND t.TABLE_NAME=:2", args: []driver.Value{" Parent Owner ", " View "},
					columns: append(append([]string{}, exactTriggerColumns...), "LINE", "TEXT"), rows: [][]driver.Value{row}},
				before,
				{queryContains: "XMLAGG", args: []driver.Value{owner, name, "TRIGGER"}, rows: [][]driver.Value{{definition}}},
				{queryContains: "FROM ALL_ERRORS", args: []driver.Value{owner, name}},
				after,
			})
			s := newServer()
			s.db = db
			listed, _, err := s.dispatch("list_triggers", exactTriggerParams(`{"schema":" Parent Owner ","table":" View ","identity_mode":"exact"}`))
			if err != nil {
				t.Fatal(err)
			}
			value, _, err := s.dispatch("get_object_source", exactTriggerParams(`{"schema":" Owner ","name":" Trigger ","object_type":"TRIGGER","identity_mode":"exact"}`))
			if err != nil {
				t.Fatal(err)
			}
			trigger := value.(map[string]any)["trigger"].(triggerInfo)
			original := listed.([]triggerInfo)[0]
			if original.Statement == nil || trigger.Statement == nil || *original.Statement != *trigger.Statement {
				t.Fatalf("statement differs between list and source: %#v / %#v", original, trigger)
			}
			want := definition
			if referencing == "REFERENCING NEW AS NEW OLD AS OLD" {
				want = "BEGIN NULL; END;"
			}
			if *trigger.Statement != want || !trigger.OracleMetadata.Definition.Complete {
				t.Fatalf("statement representation or completeness lost: %#v", trigger)
			}
			encoded, err := json.Marshal(trigger.OracleMetadata)
			if err != nil || strings.Contains(string(encoded), "description") || strings.Contains(string(encoded), "referencing") {
				t.Fatalf("internal dictionary fields leaked: %s (%v)", encoded, err)
			}
		})
	}
}

func TestExactTriggerSourceKeepsGetDDLFallbackWithoutInventingAListStatement(t *testing.T) {
	owner, name := " Owner ", " Trigger "
	definition := "CREATE TRIGGER \" Trigger \" INSTEAD OF INSERT ON \" Parent Owner \".\" View \" BEGIN NULL; END;"
	db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
		exactTriggerStep(owner, name, "42"),
		{queryContains: "XMLAGG", args: []driver.Value{owner, name, "TRIGGER"}, err: errors.New("ORA-01031")},
		{queryContains: "SELECT TEXT", args: []driver.Value{owner, name, "TRIGGER"}, err: errors.New("ORA-01031")},
		{queryContains: "DBMS_METADATA.GET_DDL", args: []driver.Value{"TRIGGER", name, owner}, rows: [][]driver.Value{{definition}}},
		{queryContains: "FROM ALL_ERRORS", args: []driver.Value{owner, name}},
		exactTriggerStep(owner, name, "42"),
	})
	s := newServer()
	s.db = db
	value, err := s.getExactTriggerSource(owner, name)
	if err != nil {
		t.Fatal(err)
	}
	trigger := value["trigger"].(triggerInfo)
	if value["source"] != definition || trigger.Statement != nil || !trigger.OracleMetadata.Definition.Complete || trigger.OracleMetadata.Definition.Origin != "DBMS_METADATA" {
		t.Fatalf("GET_DDL fallback changed: %#v", value)
	}
}

func TestExactTriggerSourceRejectsConcurrentReplacementAndDoesNotHideErrorReadFailure(t *testing.T) {
	owner, name := " Owner ", " Trigger "
	db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
		exactTriggerStep(owner, name, "42"),
		{queryContains: "XMLAGG", args: []driver.Value{owner, name, "TRIGGER"}, rows: [][]driver.Value{{"TRIGGER draft"}}},
		{queryContains: "FROM ALL_ERRORS", args: []driver.Value{owner, name}, err: errors.New("ORA-01031: insufficient privileges")},
		exactTriggerStep(owner, name, "43"),
	})
	s := newServer()
	s.db = db
	value, err := s.getExactTriggerSource(owner, name)
	if err != nil {
		t.Fatal(err)
	}
	trigger := value["trigger"].(triggerInfo)
	if value["source"] != "TRIGGER draft" || trigger.OracleMetadata.Definition.Complete {
		t.Fatal("racing source must remain visible but not writable")
	}
	if trigger.OracleMetadata.Reads["identity"].State != "incomplete" || trigger.OracleMetadata.Reads["errors"].State != "denied" || trigger.OracleMetadata.Errors != nil {
		t.Fatalf("unknown was converted to complete/empty: %#v", trigger.OracleMetadata)
	}
}

func TestExactTriggerSourceKeepsNonTableScopeAndNoFakeParent(t *testing.T) {
	owner, name := " Owner ", " Trigger "
	before, after := exactTriggerStep(owner, name, "42"), exactTriggerStep(owner, name, "42")
	for _, step := range []*oracleViewSourceQueryStep{&before, &after} {
		step.rows[0][6], step.rows[0][7] = nil, "SCHEMA"
	}
	db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{before,
		{queryContains: "XMLAGG", args: []driver.Value{owner, name, "TRIGGER"}, rows: [][]driver.Value{{"TRIGGER \" Trigger \" AFTER CREATE ON \" Parent Owner \".SCHEMA BEGIN NULL; END;"}}},
		{queryContains: "FROM ALL_ERRORS", args: []driver.Value{owner, name}}, after})
	s := newServer()
	s.db = db
	value, err := s.getExactTriggerSource(owner, name)
	if err != nil {
		t.Fatal(err)
	}
	metadata := value["trigger"].(triggerInfo).OracleMetadata
	if metadata.Scope != "SCHEMA" || metadata.Parent != nil || metadata.ScopeOwner == nil || *metadata.ScopeOwner != " Parent Owner " {
		t.Fatalf("non-table scope lost: %#v", metadata)
	}
}

func TestExactTriggerProtocolRejectsUnknownModesAndLegacyPayloadStaysSmall(t *testing.T) {
	for _, text := range []string{`{"identity_mode":"approximate"}`, `{"identity_mode":"exact","identityMode":"legacy"}`} {
		if _, err := exactMetadataReadParam(exactTriggerParams(text)); err == nil {
			t.Fatalf("accepted unknown mode: %s", text)
		}
	}
	value, err := json.Marshal(triggerInfo{Name: "T", Event: "INSERT", Timing: "BEFORE"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(value), "oracle_metadata") || strings.Contains(string(value), "enabled") || strings.Contains(string(value), "valid") {
		t.Fatalf("legacy gained metadata defaults: %s", value)
	}
}

func TestExactTriggerSourceDoesNotPromoteAPartialReadToACompleteDefinition(t *testing.T) {
	owner, name := " Owner ", " Trigger "
	db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
		exactTriggerStep(owner, name, "42"),
		{queryContains: "XMLAGG", args: []driver.Value{owner, name, "TRIGGER"}, err: errors.New("aggregate unavailable")},
		{queryContains: "SELECT TEXT", args: []driver.Value{owner, name, "TRIGGER"}, rows: [][]driver.Value{{"TRIGGER partial"}}, nextError: errors.New("source stream ended early")},
		{queryContains: "DBMS_METADATA.GET_DDL", args: []driver.Value{"TRIGGER", name, owner}, err: errors.New("metadata unavailable")},
		{queryContains: "FROM ALL_ERRORS", args: []driver.Value{owner, name}},
		exactTriggerStep(owner, name, "42"),
	})
	s := newServer()
	s.db = db
	value, err := s.getExactTriggerSource(owner, name)
	if err != nil {
		t.Fatal(err)
	}
	metadata := value["trigger"].(triggerInfo).OracleMetadata
	if metadata.Definition.Complete || metadata.Reads["definition"].State == "available" {
		t.Fatalf("partial source became authoritative: %#v", metadata)
	}
}

func TestExactObjectReadDoesNotTurnPGAErrorsIntoAnEmptyTriggerGroup(t *testing.T) {
	db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{{queryContains: "'TRIGGER'", args: []driver.Value{" Owner ", " Owner ", " Owner ", " Owner ", "TRIGGER", int64(1), int64(0)}, err: errors.New("ORA-04036: PGA memory used by the instance exceeds PGA_AGGREGATE_LIMIT")}})
	s := newServer()
	s.db = db
	if _, err := s.listObjects(" Owner ", metadataListConstraints{Exact: true, Limit: 1, ObjectTypes: []string{"TRIGGER"}}); err == nil {
		t.Fatal("catalog failure became an empty result")
	}
}

func TestExactTriggerVisibleEmptyReadIsExplicitAndNotADictionaryError(t *testing.T) {
	owner, name := " Owner ", " Trigger "
	for _, failure := range []error{nil, errors.New("ORA-01031")} {
		label := "empty"
		if failure != nil {
			label = "denied"
		}
		t.Run(label, func(t *testing.T) {
			db, _ := openOracleViewSourceTestDB(t, []oracleViewSourceQueryStep{
				{queryContains: "FROM ALL_TRIGGERS", args: []driver.Value{owner, name}, columns: exactTriggerColumns, err: failure},
			})
			s := newServer()
			s.db = db
			value, err := s.getExactTriggerSource(owner, name)
			if failure != nil {
				if err == nil {
					t.Fatal("dictionary failure became absence")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			metadata := value["trigger"].(triggerInfo).OracleMetadata
			if metadata.Reads["identity"].State != "empty" || metadata.Owner != owner || metadata.Name != name || metadata.ObjectID != nil || metadata.Definition != nil {
				t.Fatalf("visible empty read lost its exact provenance: %#v", metadata)
			}
		})
	}
}
