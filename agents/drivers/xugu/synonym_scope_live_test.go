package main

import (
	"os"
	"strings"
	"testing"
)

// TestLivePublicSynonymScope exercises the complete discovery/list/source
// protocol against a real Xugu database. It is opt-in because public CI does
// not provide a Xugu service. Set XUGU_LIVE_TEST=1 and the XUGU_LIVE_*
// connection variables to run it.
func TestLivePublicSynonymScope(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* connection settings to run the XuguDB integration test")
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

	// A real GUEST schema verifies that the database-global scope does not
	// replace or hide an ordinary schema in discovery. The unit matrix below
	// covers the same-name private/public routing independently of permissions
	// available in the live account.
	schemas, err := s.listSchemas()
	if err != nil {
		t.Fatal(err)
	}
	if !containsXuguName(schemas, "GUEST") {
		t.Skip("the live database has no real GUEST schema")
	}

	const privateTable = "DBX_PUBLIC_SYNONYM_SCOPE_PRIVATE_T"
	const publicTable = "DBX_PUBLIC_SYNONYM_SCOPE_PUBLIC_T"
	const privateName = "DBX_PUBLIC_SYNONYM_SCOPE_PRIVATE_ALIAS"
	const publicName = "DBX_PUBLIC_SYNONYM_SCOPE_PUBLIC_ALIAS"
	privateScope := params.Username
	cleanup := []string{
		"DROP PUBLIC SYNONYM " + publicName,
		"DROP SYNONYM \"" + privateScope + "\".\"" + privateName + "\"",
		"DROP TABLE " + publicTable,
		"DROP TABLE " + privateTable,
	}
	for _, statement := range cleanup {
		_ = s.execWithReconnect(statement)
	}
	defer func() {
		for _, statement := range cleanup {
			_ = s.execWithReconnect(statement)
		}
	}()

	for _, statement := range []string{
		"CREATE TABLE " + privateTable + " (ID INTEGER)",
		"CREATE TABLE " + publicTable + " (ID INTEGER)",
		"CREATE OR REPLACE SYNONYM \"" + privateScope + "\".\"" + privateName + "\" FOR \"SYSDBA\".\"" + privateTable + "\"",
		"CREATE OR REPLACE PUBLIC SYNONYM " + publicName + " FOR " + publicTable,
	} {
		if err := s.execWithReconnect(statement); err != nil {
			t.Fatal(err)
		}
	}

	listedSchemas, err := s.listSchemas()
	if err != nil {
		t.Fatal(err)
	}
	if !containsXuguName(listedSchemas, "GUEST") || !containsXuguName(listedSchemas, xuguPublicSynonymScope) {
		t.Fatalf("schema discovery lost one of the independent scopes: %v", listedSchemas)
	}

	privateObjects, err := s.listObjects(privateScope, metadataListConstraints{ObjectTypes: []string{"SYNONYM"}})
	if err != nil {
		t.Fatal(err)
	}
	publicObjects, err := s.listObjects(xuguPublicSynonymScope, metadataListConstraints{ObjectTypes: []string{"SYNONYM"}})
	if err != nil {
		t.Fatal(err)
	}
	if !containsXuguObject(privateObjects, privateName) {
		t.Fatalf("private scope did not expose the expected synonym: %#v", privateObjects)
	}
	if !containsXuguObject(publicObjects, publicName) {
		t.Fatalf("public scope did not expose the expected synonym: %#v", publicObjects)
	}

	privateSource, err := s.getObjectSource(privateScope, privateName, "SYNONYM")
	if err != nil {
		t.Fatal(err)
	}
	publicSource, err := s.getObjectSource(xuguPublicSynonymScope, publicName, "SYNONYM")
	if err != nil {
		t.Fatal(err)
	}
	privateDDL := privateSource["source"].(string)
	publicDDL := publicSource["source"].(string)
	if !strings.HasPrefix(privateDDL, "CREATE SYNONYM") || !strings.Contains(privateDDL, privateTable) {
		t.Fatalf("private synonym source used the wrong DDL: %#v", privateSource)
	}
	if !strings.HasPrefix(publicDDL, "CREATE PUBLIC SYNONYM") || !strings.Contains(publicDDL, publicTable) {
		t.Fatalf("public synonym source used the wrong DDL: %#v", publicSource)
	}
}

func containsXuguName(names []string, want string) bool {
	for _, name := range names {
		if strings.EqualFold(name, want) {
			return true
		}
	}
	return false
}

func containsXuguObject(objects []objectInfo, want string) bool {
	for _, object := range objects {
		if object.Name == want {
			return true
		}
	}
	return false
}
