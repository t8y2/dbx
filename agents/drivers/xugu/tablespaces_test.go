package main

import (
	"encoding/json"
	"testing"
)

func TestXuguTablespaceValueHelpers(t *testing.T) {
	if got := xuguInt64(int32(12)); got != 12 {
		t.Fatalf("xuguInt64(int32) = %d, want 12", got)
	}
	if got := xuguInt64(" 4096 "); got != 4096 {
		t.Fatalf("xuguInt64(string) = %d, want 4096", got)
	}
	if got := optionalInt64(nil); got != nil {
		t.Fatalf("optionalInt64(nil) = %v, want nil", *got)
	}
	if got := optionalStringPtr(nil); got != nil {
		t.Fatalf("optionalStringPtr(nil) = %q, want nil", *got)
	}
	if got := optionalStringPtr([]byte("F")); got == nil || *got != "F" {
		t.Fatalf("optionalStringPtr([]byte) = %v, want F", got)
	}
}

func TestXuguTablespaceNestedJSONShape(t *testing.T) {
	value := xuguTablespaceInfo{
		NodeID:        "1",
		SpaceID:       7,
		SpaceName:     "DATA1",
		DatafileNum:   1,
		SpaceType:     "PERMANENT",
		MediaError:    nil,
		TotalChunkNum: optionalInt64("8"),
		FreeChunkNum:  optionalInt64("3"),
		Datafiles: []xuguDatafileInfo{{
			NodeID:    "1",
			SpaceID:   7,
			Path:      "/data/DATA1.DBF",
			FileNo:    1,
			MaxSize:   nil,
			StepSize:  optionalInt64(64),
			CurrSize:  optionalInt64(1024),
			Reserved1: nil,
		}},
	}
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded xuguTablespaceInfo
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Datafiles) != 1 || decoded.Datafiles[0].Path != "/data/DATA1.DBF" {
		t.Fatalf("nested datafile was not preserved: %+v", decoded)
	}
	if decoded.TotalChunkNum == nil || *decoded.TotalChunkNum != 8 || decoded.Datafiles[0].MaxSize != nil {
		t.Fatalf("nullable storage fields changed shape: %+v", decoded)
	}
}
