package main

import (
	"os"
	"testing"
)

// TestLiveTriggerDetails verifies the metadata shape against a real XuguDB
// server. It is opt-in because the public CI has no XuguDB service. Set
// XUGU_LIVE_TEST=1 and the XUGU_LIVE_* connection variables to run it.
func TestLiveTriggerDetails(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 to run against a real XuguDB server")
	}
	params := connectParams{
		Host:     os.Getenv("XUGU_LIVE_HOST"),
		Port:     parsePort(os.Getenv("XUGU_LIVE_PORT")),
		Database: os.Getenv("XUGU_LIVE_DATABASE"),
		Username: os.Getenv("XUGU_LIVE_USERNAME"),
		Password: os.Getenv("XUGU_LIVE_PASSWORD"),
	}
	if params.Host == "" || params.Database == "" || params.Username == "" || params.Password == "" {
		t.Fatal("XUGU_LIVE_HOST, XUGU_LIVE_DATABASE, XUGU_LIVE_USERNAME, and XUGU_LIVE_PASSWORD are required")
	}

	s := newServer()
	db, err := openDB(params)
	if err != nil {
		t.Fatal(err)
	}
	s.db = db
	s.params = params
	s.currentDatabase = params.Database
	defer s.disconnect()

	const source = "DBX_TRIGGER_METADATA_LIVE"
	const audit = "DBX_TRIGGER_METADATA_AUDIT"
	const rowTrigger = "DBX_TRIGGER_METADATA_ROW"
	const statementTrigger = "DBX_TRIGGER_METADATA_STATEMENT"
	for _, statement := range []string{
		"DROP TRIGGER IF EXISTS " + rowTrigger,
		"DROP TRIGGER IF EXISTS " + statementTrigger,
		"DROP TABLE IF EXISTS " + audit,
		"DROP TABLE IF EXISTS " + source,
	} {
		if err := s.execWithReconnect(statement); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, statement := range []string{
			"DROP TRIGGER IF EXISTS " + rowTrigger,
			"DROP TRIGGER IF EXISTS " + statementTrigger,
			"DROP TABLE IF EXISTS " + audit,
			"DROP TABLE IF EXISTS " + source,
		} {
			_ = s.execWithReconnect(statement)
		}
	}()

	for _, statement := range []string{
		"CREATE TABLE " + source + " (ID INTEGER, NEW_VALUE INTEGER)",
		"CREATE TABLE " + audit + " (ID INTEGER)",
		"CREATE OR REPLACE TRIGGER " + rowTrigger + " BEFORE INSERT OR UPDATE ON " + source + " FOR EACH ROW WHEN (NEW_VALUE >= 0) COMMENT 'row metadata regression' BEGIN INSERT INTO " + audit + " VALUES (NEW.ID); END",
		"CREATE OR REPLACE TRIGGER " + statementTrigger + " AFTER DELETE ON " + source + " FOR STATEMENT COMMENT 'statement metadata regression' BEGIN INSERT INTO " + audit + " VALUES (0); END",
		"ALTER TRIGGER " + statementTrigger + " DISABLE",
	} {
		if err := s.execWithReconnect(statement); err != nil {
			t.Fatal(err)
		}
	}

	triggers, err := s.listTriggers(params.Username, source)
	if err != nil {
		t.Fatal(err)
	}
	byName := make(map[string]triggerInfo, len(triggers))
	for _, trigger := range triggers {
		byName[trigger.Name] = trigger
	}

	row, ok := byName[rowTrigger]
	if !ok {
		t.Fatalf("row trigger not listed: %#v", triggers)
	}
	if row.Timing != "BEFORE" || row.Event != "INSERT OR UPDATE" || row.Level != "FOR EACH ROW" || row.Condition == nil || *row.Condition == "" || row.Comment == nil || *row.Comment != "row metadata regression" || row.Enabled == nil || !*row.Enabled || row.Valid == nil || !*row.Valid || row.CreatedAt == nil || *row.CreatedAt == "" {
		t.Fatalf("unexpected row trigger metadata: %#v", row)
	}

	statement, ok := byName[statementTrigger]
	if !ok {
		t.Fatalf("statement trigger not listed: %#v", triggers)
	}
	if statement.Timing != "AFTER" || statement.Event != "DELETE" || statement.Level != "FOR STATEMENT" || statement.Comment == nil || *statement.Comment != "statement metadata regression" || statement.Enabled == nil || *statement.Enabled || statement.Valid == nil || !*statement.Valid || statement.CreatedAt == nil || *statement.CreatedAt == "" {
		t.Fatalf("unexpected statement trigger metadata: %#v", statement)
	}

	objects, err := s.listObjects(params.Username, metadataListConstraints{ObjectTypes: []string{"TRIGGER"}})
	if err != nil {
		t.Fatal(err)
	}
	objectByName := make(map[string]objectInfo, len(objects))
	for _, object := range objects {
		objectByName[object.Name] = object
	}
	rowObject, ok := objectByName[rowTrigger]
	if !ok || rowObject.Trigger == nil || rowObject.Trigger.Level != "FOR EACH ROW" || rowObject.Trigger.Condition == nil || *rowObject.Trigger.Condition == "" || rowObject.Valid == nil || !*rowObject.Valid {
		t.Fatalf("unexpected schema-tree row trigger metadata: %#v", rowObject)
	}
	statementObject, ok := objectByName[statementTrigger]
	if !ok || statementObject.Trigger == nil || statementObject.Trigger.Level != "FOR STATEMENT" || statementObject.Trigger.Enabled == nil || *statementObject.Trigger.Enabled || statementObject.Valid == nil || !*statementObject.Valid {
		t.Fatalf("unexpected schema-tree statement trigger metadata: %#v", statementObject)
	}
}
