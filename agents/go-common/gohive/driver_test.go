package gohive

import (
	"context"
	"testing"

	"github.com/beltran/gohive/v2/hiveserver"
)

func TestWithFetchSize(t *testing.T) {
	ctx := WithFetchSize(context.Background(), 512)
	if value := fetchSizeFromContext(ctx); value != 512 {
		t.Fatalf("unexpected fetch size: %d", value)
	}
	if value := fetchSizeFromContext(WithFetchSize(ctx, 0)); value != 512 {
		t.Fatalf("non-positive fetch size should preserve context value, got %d", value)
	}
}

func TestCursorEffectiveFetchSize(t *testing.T) {
	connection := &connection{configuration: &connectConfiguration{FetchSize: 1000}}
	if value := (&cursor{conn: connection}).effectiveFetchSize(); value != 1000 {
		t.Fatalf("unexpected default fetch size: %d", value)
	}
	if value := (&cursor{conn: connection, fetchSize: 128}).effectiveFetchSize(); value != 128 {
		t.Fatalf("unexpected statement fetch size: %d", value)
	}
}

func TestCursorAffectedRows(t *testing.T) {
	modified := float64(7)
	value := cursorAffectedRows(&cursor{operationHandle: &hiveserver.TOperationHandle{
		HasResultSet:     false,
		ModifiedRowCount: &modified,
	}})
	if value != 7 {
		t.Fatalf("unexpected affected rows: %d", value)
	}
}

func TestCursorAffectedRowsNormalizesMissingAndNegativeValues(t *testing.T) {
	negative := float64(-1)
	for _, cursor := range []*cursor{
		nil,
		{},
		{operationHandle: &hiveserver.TOperationHandle{HasResultSet: false}},
		{operationHandle: &hiveserver.TOperationHandle{HasResultSet: false, ModifiedRowCount: &negative}},
	} {
		if value := cursorAffectedRows(cursor); value != 0 {
			t.Fatalf("expected zero affected rows, got %d", value)
		}
	}
}
