package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"unicode/utf16"
	"unicode/utf8"

	go_ora "github.com/sijms/go-ora/v2"
)

const plDebugTypedResultBytes = 16 * 1024 * 1024

var errPLDebugLobBudget = errors.New("typed LOB result byte budget exceeded")

type plDebugLobOutput struct {
	bind             interface{}
	read             func(int) ([]byte, error)
	release          func() error
	memory           bool
	binary           bool
	receipt          *sql.NullInt64
	length           *sql.NullInt64
	data             []byte
	state            string
	err              error
	readAttempted    bool
	releaseAttempted bool
	released         bool
	reference        map[string]interface{}
	sourceError      string
	nationalLob      bool
	nationalSource   *plDebugNclobSource
}

type plDebugNclobSource struct {
	Kind           string  `json:"kind"`
	State          string  `json:"state"`
	Value          *string `json:"value"`
	SourceLength   *int64  `json:"sourceLength"`
	RetainedLength *int64  `json:"retainedLength"`
	LengthUnit     string  `json:"lengthUnit"`
}

func (output *plDebugLobOutput) freezeNationalSource() {
	if !output.nationalLob {
		return
	}
	var source plDebugNclobSource
	if json.Unmarshal(output.data, &source) != nil || source.Kind != "nclob" || source.LengthUnit != "utf16" || source.RetainedLength == nil {
		return
	}
	if source.State == "null" {
		if output.state != "value" || source.Value != nil || source.SourceLength != nil || *source.RetainedLength != 0 {
			return
		}
	} else {
		if source.Value == nil || source.SourceLength == nil || *source.SourceLength < 0 || *source.RetainedLength != int64(len(utf16.Encode([]rune(*source.Value)))) || *source.SourceLength < *source.RetainedLength {
			return
		}
		switch source.State {
		case "empty":
			if output.state != "value" || *source.SourceLength != 0 {
				return
			}
		case "value":
			if output.state != "value" || *source.SourceLength != *source.RetainedLength {
				return
			}
		case "partial":
			if output.state != "partial" {
				return
			}
		default:
			return
		}
	}
	// The cached JSON owns the text; retain only its validated source summary.
	source.Value = nil
	output.nationalSource = &source
}

func newPLDebugLobOutput(oci, binary bool, receipt, length *sql.NullInt64) (*plDebugLobOutput, error) {
	var output *plDebugLobOutput
	if oci {
		var err error
		output, err = newPLDebugOCILobOutput(binary)
		if err != nil {
			return nil, err
		}
	} else {
		output = &plDebugLobOutput{memory: true, release: func() error { return nil }}
		if binary {
			value := new(go_ora.Blob)
			output.bind = go_ora.Out{Dest: value}
			output.read = func(limit int) ([]byte, error) {
				if len(value.Data) > limit {
					return append([]byte{}, value.Data[:limit]...), errPLDebugLobBudget
				}
				return append([]byte{}, value.Data...), nil
			}
		} else {
			value := new(go_ora.Clob)
			output.bind = go_ora.Out{Dest: value}
			output.read = func(limit int) ([]byte, error) {
				if len(value.String) > limit {
					return []byte(plDebugOutputPrefix(value.String, limit)), errPLDebugLobBudget
				}
				return []byte(value.String), nil
			}
		}
	}
	output.binary, output.receipt, output.length, output.state = binary, receipt, length, "unavailable"
	return output, nil
}

func (output *plDebugLobOutput) collect(ctx context.Context, allocation *plDebugAllocation, remaining int) {
	if output.readAttempted {
		return
	}
	run := func(context.Context) (driver.Result, error) {
		output.readAttempted = true
		output.state = "error"
		if !output.receipt.Valid || !output.length.Valid {
			return nil, errors.New("LOB export receipt missing")
		}
		if output.receipt.Int64 == 1 && output.length.Int64 == -1 {
			output.state = "null"
			return nil, nil
		}
		if output.receipt.Int64 != 2 && output.receipt.Int64 != 3 && output.receipt.Int64 != 4 && output.receipt.Int64 != 5 || output.length.Int64 < 0 {
			return nil, errors.New("LOB export receipt invalid")
		}
		if output.receipt.Int64 == 2 && output.length.Int64 != 0 || output.receipt.Int64 == 3 && output.length.Int64 == 0 {
			return nil, errors.New("LOB empty/value receipt disagrees with length")
		}
		data, err := output.read(remaining)
		length := int64(len(data))
		if !output.binary {
			if !utf8.Valid(data) {
				end := 0
				for end < len(data) {
					r, size := utf8.DecodeRune(data[end:])
					if r == utf8.RuneError && size == 1 {
						break
					}
					end += size
				}
				data = data[:end]
				err = errors.Join(err, errors.New("LOB text is not valid UTF-8"))
			}
			length = int64(len(utf16.Encode([]rune(string(data)))))
		}
		if err != nil {
			if len(data) > 0 && length <= output.length.Int64 {
				output.data, output.state = data, "partial"
			}
			return nil, err
		}
		if length != output.length.Int64 {
			return nil, errors.New("LOB payload length disagrees with export receipt")
		}
		output.data, output.state = data, "value"
		if output.receipt.Int64 == 4 {
			output.state = "partial"
			return nil, errPLDebugLobBudget
		}
		if output.receipt.Int64 == 5 {
			output.state = "partial"
			output.sourceError = "export_incomplete"
			return nil, errors.New("composite export incomplete")
		}
		return nil, nil
	}
	if output.memory {
		_, output.err = run(context.Background())
	} else {
		_, output.err = allocation.exec(ctx, run)
	}
	output.freezeNationalSource()
}

func (output *plDebugLobOutput) finish(ctx context.Context, allocation *plDebugAllocation) {
	if output.releaseAttempted {
		return
	}
	run := func(context.Context) (driver.Result, error) {
		output.releaseAttempted = true
		err := output.release()
		output.released = err == nil
		if err != nil {
			allocation.mu.Lock()
			allocation.unknown = true
			allocation.mu.Unlock()
		}
		return nil, err
	}
	var err error
	if output.memory {
		_, err = run(context.Background())
	} else {
		_, err = allocation.exec(ctx, run)
	}
	output.err = errors.Join(output.err, err)
}

func (output *plDebugLobOutput) value() interface{} {
	if output.state != "value" {
		return nil
	}
	if output.binary {
		return map[string]interface{}{"encoding": "base64", "data": base64.StdEncoding.EncodeToString(output.data)}
	}
	return string(output.data)
}
