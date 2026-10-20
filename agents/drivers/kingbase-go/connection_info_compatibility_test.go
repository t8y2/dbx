package main

import "testing"

func TestConnectionInfoPreservesModeInDatabaseInfo(t *testing.T) {
	for _, mode := range []string{"oracle", "future_mode", ""} {
		db := openModeDetectionDB(t, &modeDetectionDriverState{})
		s := newServer()
		s.db = db
		s.mode.compatibilityMode = mode
		info, err := s.connectionInfo()
		if err != nil {
			t.Fatal(err)
		}
		nested, ok := info["databaseInfo"].(map[string]string)
		if !ok || nested["compatibilityMode"] != mode || nested["productVersion"] != info["version"] || nested["currentDatabase"] != info["database"] {
			t.Fatalf("databaseInfo must survive the Rust/frontend envelope: %#v", info)
		}
	}
}
