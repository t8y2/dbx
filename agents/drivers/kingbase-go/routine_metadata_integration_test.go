package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestKingbaseRoutineMetadataIntegration(t *testing.T) {
	host := os.Getenv("KINGBASE_TEST_HOST")
	portText := os.Getenv("KINGBASE_TEST_PORT")
	username := os.Getenv("KINGBASE_TEST_USERNAME")
	if host == "" || portText == "" || username == "" {
		t.Skip("Kingbase integration environment is not configured")
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	database := os.Getenv("KINGBASE_TEST_DATABASE")
	if database == "" {
		database = "test"
	}
	cp := connectParams{Host: host, Port: port, Database: database, Username: username, Password: os.Getenv("KINGBASE_TEST_PASSWORD")}
	if strings.HasPrefix(host, "/") {
		cp.URLParams = "sslmode=disable"
	}
	s := newServer()
	if err := s.connect(cp); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.disconnect() })
	if s.mode.legacyV7 {
		t.Skip("routine metadata integration requires Kingbase V8 procedure syntax")
	}

	schema := "dbx_routines_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	qualifiedSchema := quoteIdentifier(schema)
	mustExecute(t, s, "CREATE SCHEMA "+qualifiedSchema)
	t.Cleanup(func() {
		for _, statement := range []string{
			"DROP PROCEDURE IF EXISTS " + qualifiedSchema + ".no_args()",
			"DROP PROCEDURE IF EXISTS " + qualifiedSchema + ".input_only(integer)",
			"DROP PROCEDURE IF EXISTS " + qualifiedSchema + ".inout_value(integer)",
			"DROP PROCEDURE IF EXISTS " + qualifiedSchema + ".two_inout(integer, text)",
			"DROP PROCEDURE IF EXISTS " + qualifiedSchema + ".overloaded()",
			"DROP PROCEDURE IF EXISTS " + qualifiedSchema + ".overloaded(integer)",
			"DROP PROCEDURE IF EXISTS " + qualifiedSchema + ".overloaded(text)",
			"DROP FUNCTION IF EXISTS " + qualifiedSchema + ".void_function()",
			"DROP FUNCTION IF EXISTS " + qualifiedSchema + ".scalar_function()",
			"DROP SCHEMA IF EXISTS " + qualifiedSchema,
		} {
			if _, err := s.executeQuery(queryOptions{SQL: statement}); err != nil {
				t.Errorf("cleanup %s: %v", statement, err)
			}
		}
	})
	for _, definition := range []string{
		"PROCEDURE " + qualifiedSchema + ".no_args() LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$",
		"PROCEDURE " + qualifiedSchema + ".input_only(IN value integer) LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$",
		"PROCEDURE " + qualifiedSchema + ".inout_value(INOUT value integer) LANGUAGE plpgsql AS $$ BEGIN value := value + 1; END; $$",
		"PROCEDURE " + qualifiedSchema + ".two_inout(INOUT value integer, INOUT label text) LANGUAGE plpgsql AS $$ BEGIN value := 13046; label := 'probe'; END; $$",
		"PROCEDURE " + qualifiedSchema + ".overloaded() LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'no_args_overload_marker'; END; $$",
		"PROCEDURE " + qualifiedSchema + ".overloaded(IN value integer) LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'integer_overload_marker'; END; $$",
		"PROCEDURE " + qualifiedSchema + ".overloaded(IN value text) LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'text_overload_marker'; END; $$",
		"FUNCTION " + qualifiedSchema + ".void_function() RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$",
		"FUNCTION " + qualifiedSchema + ".scalar_function() RETURNS integer LANGUAGE sql AS $$ SELECT 13046; $$",
	} {
		mustExecute(t, s, "CREATE "+definition)
	}
	mustExecute(t, s, "COMMENT ON PROCEDURE "+qualifiedSchema+".inout_value(integer) IS 'INOUT procedure comment'")

	procedures, err := s.listObjects(schema, metadataListConstraints{ObjectTypes: []string{"PROCEDURE"}})
	if err != nil || len(procedures) != 7 {
		t.Fatalf("expected all seven procedures, including INOUT and overloads: objects=%+v err=%v", procedures, err)
	}
	functions, err := s.listObjects(schema, metadataListConstraints{ObjectTypes: []string{"FUNCTION"}})
	if err != nil || len(functions) != 2 {
		t.Fatalf("expected scalar and void functions: objects=%+v err=%v", functions, err)
	}
	for _, item := range functions {
		if item.Name != "void_function" && item.Name != "scalar_function" {
			t.Fatalf("procedure was incorrectly classified as a function: %+v", item)
		}
	}
	overloads := []objectInfo{}
	for _, item := range procedures {
		if item.ObjectType != "PROCEDURE" || item.Schema != schema {
			t.Fatalf("routine type or schema was lost: %+v", item)
		}
		if item.Name == "inout_value" && (item.Comment == nil || *item.Comment != "INOUT procedure comment") {
			t.Fatalf("procedure comment was lost: %+v", item)
		}
		if item.Name == "overloaded" {
			overloads = append(overloads, item)
		}
	}
	if len(overloads) != 3 {
		t.Fatalf("overloaded procedures need distinct signatures: %+v", overloads)
	}
	if _, _, err := s.dispatch("get_object_source", map[string]json.RawMessage{
		"schema": rawJSON(schema), "name": rawJSON("overloaded"), "object_type": rawJSON("PROCEDURE"),
	}); err == nil || !strings.Contains(strings.ToLower(err.Error()), "ambiguous") {
		t.Fatalf("an overloaded name without a signature must report ambiguity: %v", err)
	}
	markers := map[string]bool{}
	signatures := map[string]bool{}
	for _, item := range overloads {
		if item.Signature == nil || signatures[*item.Signature] {
			t.Fatalf("overload signature is missing or duplicated: %+v", item)
		}
		signatures[*item.Signature] = true
		marker := "integer_overload_marker"
		if *item.Signature == "" {
			marker = "no_args_overload_marker"
		} else if strings.Contains(*item.Signature, "text") {
			marker = "text_overload_marker"
		}
		result, _, err := s.dispatch("get_object_source", map[string]json.RawMessage{
			"schema": rawJSON(schema), "name": rawJSON(item.Name), "object_type": rawJSON(item.ObjectType), "signature": rawJSON(*item.Signature),
		})
		if err != nil {
			t.Fatalf("source for overload %q failed: %v", *item.Signature, err)
		}
		source := fmt.Sprint(result.(map[string]any)["source"])
		if !strings.Contains(source, marker) {
			t.Fatalf("signature %q selected the wrong overload, expected %s: %s", *item.Signature, marker, source)
		}
		markers[marker] = true
	}
	if len(markers) != 3 || !signatures[""] {
		t.Fatalf("different overload signatures did not select distinct source bodies: %v", markers)
	}
	first, err := s.listObjects(schema, metadataListConstraints{ObjectTypes: []string{"PROCEDURE"}, Filter: "overloaded", Limit: 1})
	if err != nil || len(first) != 1 || first[0].Signature == nil {
		t.Fatalf("first overload page failed: %+v err=%v", first, err)
	}
	second, err := s.listObjects(schema, metadataListConstraints{ObjectTypes: []string{"PROCEDURE"}, Filter: "overloaded", Limit: 1, Offset: 1})
	if err != nil || len(second) != 1 || second[0].Signature == nil || *first[0].Signature == *second[0].Signature {
		t.Fatalf("overload paging duplicated or lost an identity: first=%+v second=%+v err=%v", first, second, err)
	}
	t.Logf("verified seven procedures, two functions, comments and all three overload sources (mode=%s)", s.mode.compatibilityMode)
}
