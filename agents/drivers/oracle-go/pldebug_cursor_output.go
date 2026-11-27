package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

const (
	plDebugCursorPreviewRows    = 100
	plDebugCursorPreviewColumns = 64
	plDebugCursorPreviewBytes   = 64 * 1024
)

type plDebugCursorPreview struct {
	Columns  []string          `json:"columns"`
	Rows     []json.RawMessage `json:"rows"`
	Complete bool              `json:"complete"`
}

type plDebugCursorOutput struct {
	bind         interface{}
	receipt      *sql.NullInt64
	thin         *go_ora.RefCursor
	oci          driver.Rows
	preview      *plDebugCursorPreview
	previewBytes int
	state        string
	err          error
	attempted    bool
	released     bool
}

func newPLDebugCursorOutput(oci bool, receipt *sql.NullInt64) *plDebugCursorOutput {
	output := &plDebugCursorOutput{receipt: receipt, state: "pending"}
	if oci {
		output.bind = sql.Out{Dest: &output.oci}
	} else {
		output.thin = new(go_ora.RefCursor)
		output.bind = sql.Out{Dest: output.thin}
	}
	return output
}

func (output *plDebugCursorOutput) collect(ctx context.Context, allocation *plDebugAllocation, budget int) {
	if output.attempted || output.released {
		return
	}
	if output.oci == nil && (output.thin == nil || !output.thin.CanAutoClose()) {
		output.state, output.err = "error", errors.New("cursor OUT bind was not returned")
		output.released = true
		return
	}
	_, err := allocation.exec(ctx, func(private context.Context) (driver.Result, error) {
		output.attempted = true
		output.state = "error"
		var rows driver.Rows = output.oci
		var release func() error
		if output.thin != nil {
			release = output.thin.Close
		} else {
			release = rows.Close
		}
		if !output.receipt.Valid || output.receipt.Int64 != 0 && output.receipt.Int64 != 1 {
			output.err = errors.New("cursor OUT bind receipt is missing or invalid")
		} else if output.receipt.Int64 == 0 {
			output.state = "not_open"
		} else if budget == 0 {
			output.state = "partial"
		} else {
			if output.thin != nil {
				var data *go_ora.DataSet
				data, output.err = output.thin.Query()
				if output.err == nil {
					rows, release = data, data.Close
				}
			}
			if output.err == nil {
				output.preview, output.previewBytes, output.err = readPLDebugCursorPreview(private, rows, budget)
			}
			if output.preview != nil {
				output.state = "partial"
				if output.preview.Complete {
					output.state = "value"
				}
			} else if output.err == nil {
				output.state = "partial"
			}
		}
		if closeErr := release(); closeErr != nil {
			allocation.mu.Lock()
			allocation.unknown = true
			allocation.mu.Unlock()
			return nil, closeErr
		}
		output.released = true
		return nil, nil
	})
	if err != nil {
		output.err = errors.Join(output.err, err)
		output.state = "error"
	}
}

func readPLDebugCursorPreview(ctx context.Context, rows driver.Rows, budget int) (*plDebugCursorPreview, int, error) {
	columns := rows.Columns()
	if len(columns) == 0 || len(columns) > plDebugCursorPreviewColumns {
		return nil, 0, fmt.Errorf("cursor preview supports between 1 and %d columns", plDebugCursorPreviewColumns)
	}
	preview := &plDebugCursorPreview{Columns: columns, Rows: []json.RawMessage{}}
	header, err := json.Marshal(preview)
	if err != nil || len(header) > budget {
		return nil, 0, err
	}
	used := len(header)
	types := make([]string, len(columns))
	if metadata, ok := rows.(driver.RowsColumnTypeDatabaseTypeName); ok {
		for i := range columns {
			types[i] = metadata.ColumnTypeDatabaseTypeName(i)
			if strings.Contains(strings.ToUpper(types[i]), "CURSOR") {
				return nil, 0, errors.New("nested cursor columns are unavailable in the cursor preview")
			}
		}
	}
	values := make([]driver.Value, len(columns))
	cells := make([]*string, len(columns))
	for {
		if err := ctx.Err(); err != nil {
			return preview, used, err
		}
		err := rows.Next(values)
		if errors.Is(err, io.EOF) {
			preview.Complete = true
			return preview, used, nil
		}
		if err != nil {
			return preview, used, err
		}
		if len(preview.Rows) == plDebugCursorPreviewRows {
			return preview, used, nil
		}
		remaining := budget - used
		for i, value := range values {
			cells[i] = nil
			if value == nil {
				continue
			}
			switch v := value.(type) {
			case []byte:
				if len(v) > remaining {
					return preview, used, nil
				}
			case string:
				if len(v) > remaining {
					return preview, used, nil
				}
			case time.Time, int64, float64, bool, fmt.Stringer:
			default:
				return preview, used, fmt.Errorf("cursor column %d (%s) could not be displayed", i+1, types[i])
			}
			text := fmt.Sprint(normalizeValue(value, types[i]))
			remaining -= len(text)
			if remaining < 0 {
				return preview, used, nil
			}
			cells[i] = &text
		}
		row, err := json.Marshal(cells)
		if err != nil || used+len(row)+1 > budget {
			return preview, used, err
		}
		used += len(row) + 1
		preview.Rows = append(preview.Rows, row)
	}
}
