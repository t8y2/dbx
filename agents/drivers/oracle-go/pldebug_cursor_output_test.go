package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

type plDebugTestCursorRows struct {
	values [][]driver.Value
	closed bool
	err    error
}

func (*plDebugTestCursorRows) Columns() []string { return []string{"ID", "LABEL"} }
func (r *plDebugTestCursorRows) Close() error    { r.closed = true; return nil }
func (r *plDebugTestCursorRows) Next(values []driver.Value) error {
	if len(r.values) == 0 {
		if r.err != nil {
			return r.err
		}
		return io.EOF
	}
	copy(values, r.values[0])
	r.values = r.values[1:]
	return nil
}

func TestPLDebugCursorOutputTransfer(t *testing.T) {
	for _, test := range []struct {
		name       string
		values     [][]driver.Value
		readErr    error
		receipt    int64
		state      string
		wantRows   []string
		isComplete bool
	}{
		{name: "rows", receipt: 1, state: "value", values: [][]driver.Value{{int64(17), nil}, {"12345678901234567890.123", "Alpha"}}, wantRows: []string{`["17",null]`, `["12345678901234567890.123","Alpha"]`}, isComplete: true},
		{name: "empty", receipt: 1, state: "value", wantRows: []string{}, isComplete: true},
		{name: "closed", state: "not_open"},
		{name: "fetch fails after one row", receipt: 1, state: "partial", values: [][]driver.Value{{int64(17), "Alpha"}}, readErr: errors.New("cursor fetch failed"), wantRows: []string{`["17","Alpha"]`}},
		{name: "byte cap", receipt: 1, state: "partial", values: [][]driver.Value{{int64(17), strings.Repeat("x", plDebugCursorPreviewBytes)}}, wantRows: []string{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			rows := &plDebugTestCursorRows{values: test.values, err: test.readErr}
			receipt := sql.NullInt64{Int64: test.receipt, Valid: true}
			output := newPLDebugCursorOutput(true, &receipt)
			*output.bind.(sql.Out).Dest.(*driver.Rows) = rows
			output.collect(context.Background(), &plDebugAllocation{}, plDebugCursorPreviewBytes)
			if !output.released || !rows.closed || output.state != test.state || !errors.Is(output.err, test.readErr) {
				t.Fatalf("cursor state=%s released=%v closed=%v err=%v", output.state, output.released, rows.closed, output.err)
			}
			if test.wantRows == nil {
				if output.preview != nil {
					t.Fatal("an unopened cursor must not be displayed as an empty result set")
				}
				return
			}
			var got = []string{}
			for _, row := range output.preview.Rows {
				got = append(got, string(row))
			}
			if !reflect.DeepEqual(got, test.wantRows) || output.preview.Complete != test.isComplete {
				t.Fatalf("cursor preview=%v rows=%v", output.preview, got)
			}
			encoded, err := json.Marshal(output.preview)
			if err != nil || len(encoded) > output.previewBytes {
				t.Fatalf("cursor preview size=%d budget used=%d err=%v", len(encoded), output.previewBytes, err)
			}
		})
	}
}

func TestPLDebugCursorOutputPreviewRowLimit(t *testing.T) {
	for _, total := range []int{plDebugCursorPreviewRows, plDebugCursorPreviewRows + 1} {
		rows := &plDebugTestCursorRows{values: make([][]driver.Value, total)}
		preview, _, err := readPLDebugCursorPreview(context.Background(), rows, plDebugCursorPreviewBytes)
		if err != nil || len(preview.Rows) != plDebugCursorPreviewRows || preview.Complete != (total == plDebugCursorPreviewRows) {
			t.Fatalf("%d database rows yielded %v, %v", total, preview, err)
		}
	}
}

func TestPLDebugCursorOutputTransportRequiresAnOutParameter(t *testing.T) {
	argument := plDebugNativeArgument{Type: "REF CURSOR", Position: 3, Mode: "OUT"}
	if !argument.adapted() || !plDebugNativeTypedRootAdapter(argument) {
		t.Fatal("OUT REF CURSOR was blocked by preflight")
	}
	for _, mode := range []string{"IN", "IN OUT"} {
		argument.Mode = mode
		if argument.adapted() || plDebugNativeTypedRootAdapter(argument) {
			t.Fatalf("unsupported %s REF CURSOR was accepted", mode)
		}
	}
}
