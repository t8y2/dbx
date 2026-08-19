package gohive

import (
	"strings"
	"testing"

	"github.com/beltran/gohive/v2/hiveserver"
)

func TestHiveStatusErrorDoesNotDumpEmptyThriftFields(t *testing.T) {
	err := hiveStatusError("opening session", &hiveserver.TStatus{StatusCode: hiveserver.TStatusCode_ERROR_STATUS})
	message := err.Error()
	if message != "HiveServer2 error while opening session: server returned ERROR_STATUS without error details" {
		t.Fatalf("unexpected empty-status error: %q", message)
	}
	for _, leakedField := range []string{"InfoMessages", "<nil>", "ErrorMessage"} {
		if strings.Contains(message, leakedField) {
			t.Fatalf("error leaked raw Thrift field %q: %q", leakedField, message)
		}
	}
}

func TestHiveStatusErrorPreservesUsefulServerDiagnostics(t *testing.T) {
	sqlState := "28000"
	errorCode := int32(1001)
	errorMessage := "authentication failed"
	err := hiveStatusError("opening session", &hiveserver.TStatus{
		StatusCode:   hiveserver.TStatusCode_ERROR_STATUS,
		InfoMessages: []string{"gateway rejected the session", "authentication failed", ""},
		SqlState:     &sqlState,
		ErrorCode:    &errorCode,
		ErrorMessage: &errorMessage,
	})

	expected := "HiveServer2 error while opening session: authentication failed; gateway rejected the session (SQLState 28000, error code 1001)"
	if err.Error() != expected {
		t.Fatalf("unexpected diagnostic error: %q", err.Error())
	}
	hiveError, ok := err.(*Error)
	if !ok || hiveError.Message != "authentication failed; gateway rejected the session (SQLState 28000, error code 1001)" {
		t.Fatalf("unexpected Hive error payload: %#v", err)
	}
}

func TestFetchResultsReadyPollsWhileOperationIsStillExecuting(t *testing.T) {
	ready, err := fetchResultsReady(&hiveserver.TStatus{
		StatusCode: hiveserver.TStatusCode_STILL_EXECUTING_STATUS,
	})
	if err != nil || ready {
		t.Fatalf("still-executing fetch must be retried: ready=%v err=%v", ready, err)
	}
}

func TestFetchResultsReadyAcceptsSuccessAndRejectsErrors(t *testing.T) {
	ready, err := fetchResultsReady(&hiveserver.TStatus{
		StatusCode: hiveserver.TStatusCode_SUCCESS_WITH_INFO_STATUS,
	})
	if err != nil || !ready {
		t.Fatalf("successful fetch was rejected: ready=%v err=%v", ready, err)
	}

	ready, err = fetchResultsReady(&hiveserver.TStatus{
		StatusCode: hiveserver.TStatusCode_ERROR_STATUS,
	})
	if err == nil || ready || !strings.Contains(err.Error(), "ERROR_STATUS") {
		t.Fatalf("failed fetch did not preserve the server status: ready=%v err=%v", ready, err)
	}
}
