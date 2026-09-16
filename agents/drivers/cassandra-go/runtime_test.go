package main

import (
	"testing"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

func TestInvalidateMetadataSessionDefersCloseUntilOperationsFinish(t *testing.T) {
	runtime := &connectionRuntime{
		sessions:        map[string]*gocql.Session{"": {}},
		permits:         make(chan struct{}, 2),
		metadataPermits: make(chan struct{}, 1),
	}

	releaseFirst, err := runtime.acquire(false)
	if err != nil {
		t.Fatal(err)
	}
	releaseSecond, err := runtime.acquire(false)
	if err != nil {
		t.Fatal(err)
	}
	metadataSession := runtime.sessions[""]

	runtime.invalidateMetadataSession()
	if metadataSession.Closed() {
		t.Fatal("metadata session closed while operations were active")
	}
	if len(runtime.retiredSessions) != 1 {
		t.Fatalf("unexpected retired session count: %d", len(runtime.retiredSessions))
	}

	releaseFirst()
	if metadataSession.Closed() {
		t.Fatal("metadata session closed before the final operation completed")
	}

	releaseSecond()
	if !metadataSession.Closed() {
		t.Fatal("metadata session was not closed after the final operation completed")
	}
	if len(runtime.retiredSessions) != 0 {
		t.Fatalf("retired sessions were not cleared: %d", len(runtime.retiredSessions))
	}
}

func TestInvalidateMetadataSessionClosesImmediatelyWithoutOperations(t *testing.T) {
	metadataSession := &gocql.Session{}
	runtime := &connectionRuntime{sessions: map[string]*gocql.Session{"": metadataSession}}

	runtime.invalidateMetadataSession()

	if !metadataSession.Closed() {
		t.Fatal("idle metadata session was not closed immediately")
	}
	if _, exists := runtime.sessions[""]; exists {
		t.Fatal("invalidated metadata session remains cached")
	}
}
