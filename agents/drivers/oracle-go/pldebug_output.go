package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	go_ora "github.com/sijms/go-ora/v2"
)

const plDebugNativeOutputChars = 16 * 1024 * 1024
const plDebugNativeOutputBytes = 4 * plDebugNativeOutputChars

var errPLDebugOutputLimit = errors.New("CLOB capture exceeds the output transfer limit")

type plDebugNativeBlock struct {
	SQL              string
	SourceLineOffset int
	SourceLineCount  int
	PrivateNames     []string
	CallLine         int
	CallLastLine     int
}

func plDebugWrapNativeTarget(source string, inputCount int) (plDebugNativeBlock, error) {
	return plDebugNativeCaptureBlock(source, inputCount, false)
}

func plDebugNativeCleanupBlock() (plDebugNativeBlock, error) {
	return plDebugNativeCaptureBlock("", 0, true)
}

func plDebugNativeCaptureBlock(source string, inputCount int, cleanup bool) (plDebugNativeBlock, error) {
	return plDebugNativeCaptureRender(source, inputCount, cleanup, nil)
}

func plDebugNativeCaptureRender(source string, inputCount int, cleanup bool, render func(string) plDebugNativeBody) (plDebugNativeBlock, error) {
	end := len(strings.TrimRight(source, " \t\r\n"))
	if end > 0 && source[end-1] == '/' {
		line := strings.LastIndex(source[:end-1], "\n") + 1
		if strings.TrimSpace(source[line:end-1]) == "" {
			source = source[:line]
		}
	}
	var prefix, savepoint string
	for {
		var token [6]byte
		if _, err := rand.Read(token[:]); err != nil {
			return plDebugNativeBlock{}, err
		}
		id := strings.ToUpper(hex.EncodeToString(token[:]))
		prefix, savepoint = "DBX_"+id+"_", "DBX_PD_"+id
		upper := strings.ToUpper(source)
		if !strings.Contains(upper, prefix) && !strings.Contains(upper, savepoint) {
			break
		}
	}
	declarations := `DECLARE
  $OUTPUT CLOB;
  $LINE VARCHAR2(32767);
  $STATUS INTEGER;
  $ERROR INTEGER := 0;
  $MESSAGE VARCHAR2(32767);
  $ROLLBACK INTEGER := -1;
  $OUTPUT_ERROR VARCHAR2(32767);
  $TRUNCATED INTEGER := 0;
  $COMPLETE INTEGER := 0;
  $KEEP INTEGER;
  $RETAINED INTEGER := 0;
BEGIN
`
	declarations = strings.ReplaceAll(declarations, "$", prefix)
	var body plDebugNativeBody
	if render != nil {
		body = render(prefix)
		declarations = strings.TrimSuffix(declarations, "BEGIN\n") + body.Declarations + "BEGIN\n"
		source = body.Source
	}
	start := declarations + "  SAVEPOINT " + savepoint + ";\n  BEGIN\n"
	if body.Initialization != "" {
		start += body.Initialization + "    DECLARE\n" + body.ScopedDeclarations + "    BEGIN\n      BEGIN\n"
	}
	failure := `
  EXCEPTION WHEN OTHERS THEN
    $ERROR := SQLCODE; $MESSAGE := SQLERRM;
    BEGIN ROLLBACK TO ` + savepoint + `; $ROLLBACK := 1;
    EXCEPTION WHEN OTHERS THEN $ROLLBACK := 0; END;
  END;
`
	if body.RollbackCondition != "" {
		failure = strings.Replace(failure, "    BEGIN ROLLBACK TO ", "    IF "+body.RollbackCondition+" THEN\n    BEGIN ROLLBACK TO ", 1)
		failure = strings.Replace(failure, "  END;\n", "    END IF;\n  END;\n", 1)
	}
	tail := fmt.Sprintf(`  BEGIN
    SYS.DBMS_DEBUG.DEBUG_OFF;
    SYS.DBMS_LOB.CREATETEMPORARY($OUTPUT, TRUE);
    LOOP
      SYS.DBMS_OUTPUT.GET_LINE($LINE, $STATUS);
      IF $STATUS = 1 THEN $COMPLETE := 1; EXIT; END IF;
      IF $STATUS <> 0 THEN RAISE_APPLICATION_ERROR(-20000, 'Unexpected DBMS_OUTPUT status'); END IF;
      $KEEP := LEAST(NVL(LENGTH($LINE), 0), GREATEST(%d - $RETAINED, 0));
      IF $KEEP > 0 THEN
        SYS.DBMS_LOB.WRITEAPPEND($OUTPUT, $KEEP, SUBSTR($LINE, 1, $KEEP));
        $RETAINED := $RETAINED + $KEEP;
      END IF;
      IF $KEEP < NVL(LENGTH($LINE), 0) THEN $TRUNCATED := 1; EXIT; END IF;
      IF $RETAINED < %d THEN
        SYS.DBMS_LOB.WRITEAPPEND($OUTPUT, 1, CHR(10)); $RETAINED := $RETAINED + 1;
      ELSE $TRUNCATED := 1; EXIT; END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN $OUTPUT_ERROR := SQLERRM;
  END;
`, plDebugNativeOutputChars, plDebugNativeOutputChars)
	for i, name := range []string{"ERROR", "MESSAGE", "ROLLBACK", "OUTPUT", "OUTPUT_ERROR", "TRUNCATED", "COMPLETE"} {
		tail += fmt.Sprintf("  :%d := $%s;\n", inputCount+i+1, name)
	}
	tail += "END;"
	names := []string{}
	for _, name := range []string{"OUTPUT", "LINE", "STATUS", "ERROR", "MESSAGE", "ROLLBACK", "OUTPUT_ERROR", "TRUNCATED", "COMPLETE", "KEEP", "RETAINED"} {
		names = append(names, prefix+name)
	}
	names = append(names, body.PrivateNames...)
	if cleanup {
		return plDebugNativeBlock{SQL: declarations + strings.ReplaceAll(tail, "$", prefix), PrivateNames: names}, nil
	}
	callLine := 0
	if body.CallLine > 0 {
		callLine = strings.Count(start, "\n") + body.CallLine
	}
	callLastLine := 0
	if body.CallLastLine > 0 {
		callLastLine = strings.Count(start, "\n") + body.CallLastLine
	}
	ending := strings.ReplaceAll(failure, "$", prefix) + body.After
	if body.Initialization != "" {
		ending = strings.ReplaceAll(failure, "$", prefix) + "  SYS.DBMS_DEBUG.DEBUG_OFF;\n" + body.After + "    END;\n" + strings.ReplaceAll(failure, "$", prefix) + body.Completion
	}
	return plDebugNativeBlock{SQL: start + source + ending + strings.ReplaceAll(tail, "$", prefix), SourceLineOffset: strings.Count(start, "\n"), SourceLineCount: strings.Count(source, "\n") + 1, PrivateNames: names, CallLine: callLine, CallLastLine: callLastLine}, nil
}

type plDebugClobOutput struct {
	bind    interface{}
	read    func() (string, error)
	release func() error
	memory  bool
}

func newPLDebugClobOutput(oci bool) (*plDebugClobOutput, error) {
	if oci {
		return newPLDebugOCIClobOutput()
	}
	value := new(go_ora.Clob)
	return &plDebugClobOutput{bind: go_ora.Out{Dest: value}, memory: true, read: func() (string, error) {
		if !value.Valid {
			return "", errors.New("no CLOB capture was returned")
		}
		if len(value.String) > plDebugNativeOutputBytes {
			return plDebugOutputPrefix(value.String, plDebugNativeOutputBytes), errPLDebugOutputLimit
		}
		return value.String, nil
	}, release: func() error { return nil }}, nil
}

func plDebugOutputPrefix(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end]
}

type plDebugNativeCapture struct {
	Code              sql.NullInt64
	Message           sql.NullString
	SavepointRollback sql.NullInt64
	NativeOutputError sql.NullString
	NativeTruncated   sql.NullInt64
	NativeComplete    sql.NullInt64
	Output            string
	OutputComplete    bool
	Truncated         bool
	OutputError       string
	ReleaseError      string
	ReferencesPending bool
	references        *plDebugCaptureReferences
	utf16Text         []uint16
}

type plDebugCaptureReferences struct {
	statement               *sql.Stmt
	clob                    *plDebugClobOutput
	readAttempted           bool
	readComplete            bool
	releaseAttempted        bool
	released                bool
	statementCloseAttempted bool
	lobs                    []*plDebugLobOutput
}

func plDebugExecuteNativeCapture(ctx context.Context, tx *sql.Tx, allocation *plDebugAllocation, oci bool, block plDebugNativeBlock, inputs []interface{}) (plDebugNativeCapture, error) {
	return plDebugExecuteObservedCapture(ctx, tx, allocation, oci, block, inputs, nil)
}

type plDebugCaptureObserver struct {
	dispatch func() error
	returned func(plDebugNativeCapture, error)
	lobs     []*plDebugLobOutput
}

func plDebugExecuteObservedCapture(ctx context.Context, tx *sql.Tx, allocation *plDebugAllocation, oci bool, block plDebugNativeBlock, inputs []interface{}, observer *plDebugCaptureObserver) (plDebugNativeCapture, error) {
	clob, err := newPLDebugClobOutput(oci)
	if err != nil {
		return plDebugNativeCapture{}, err
	}
	return plDebugExecuteCaptureWith(ctx, tx, allocation, oci, block, inputs, clob, observer)
}

func plDebugExecuteBoundCapture(ctx context.Context, tx *sql.Tx, allocation *plDebugAllocation, oci bool, block plDebugNativeBlock, inputs []interface{}, clob *plDebugClobOutput) (plDebugNativeCapture, error) {
	return plDebugExecuteCaptureWith(ctx, tx, allocation, oci, block, inputs, clob, nil)
}

func plDebugExecuteCaptureWith(ctx context.Context, tx *sql.Tx, allocation *plDebugAllocation, oci bool, block plDebugNativeBlock, inputs []interface{}, clob *plDebugClobOutput, observer *plDebugCaptureObserver) (plDebugNativeCapture, error) {
	var capture plDebugNativeCapture
	stmt, err := tx.PrepareContext(ctx, block.SQL)
	if err != nil {
		return capture, err
	}
	capture.references = &plDebugCaptureReferences{statement: stmt, clob: clob}
	if observer != nil {
		capture.references.lobs = observer.lobs
	}
	capture.ReferencesPending = true
	args := append([]interface{}{}, inputs...)
	args = append(args, plDebugOutArg(oci, &capture.Code), plDebugOutArg(oci, &capture.Message), plDebugOutArg(oci, &capture.SavepointRollback), clob.bind, plDebugOutArg(oci, &capture.NativeOutputError), plDebugOutArg(oci, &capture.NativeTruncated), plDebugOutArg(oci, &capture.NativeComplete))
	if observer != nil && observer.dispatch != nil {
		if err := observer.dispatch(); err != nil {
			for _, lob := range capture.references.lobs {
				lob.readAttempted, lob.releaseAttempted, lob.released = true, true, true
			}
			capture.references.readAttempted = true
			capture.references.releaseAttempted = true
			capture.references.released = true
			capture.finishReferences(ctx, allocation)
			return capture, err
		}
	}
	_, err = stmt.ExecContext(ctx, args...)
	if observer != nil && observer.returned != nil {
		observer.returned(capture, err)
	}
	if capture.NativeOutputError.Valid {
		capture.OutputError = capture.NativeOutputError.String
	}
	if err == nil && !capture.Code.Valid {
		err = errors.New("target wrapper returned no business outcome")
	}
	capture.finishReferences(ctx, allocation)
	return capture, err
}

func (capture *plDebugNativeCapture) finishReferences(ctx context.Context, allocation *plDebugAllocation) {
	refs := capture.references
	if refs == nil {
		return
	}
	remaining := plDebugTypedResultBytes
	for _, lob := range refs.lobs {
		lob.collect(ctx, allocation, remaining)
		remaining -= len(lob.data)
	}
	if !refs.readAttempted {
		capture.OutputError = ""
		if capture.NativeOutputError.Valid {
			capture.OutputError = capture.NativeOutputError.String
		}
		read := func(context.Context) (driver.Result, error) {
			refs.readAttempted = true
			capture.utf16Text = nil
			var err error
			capture.Output, err = refs.clob.read()
			refs.readComplete = err == nil
			return nil, err
		}
		var err error
		if refs.clob.memory {
			_, err = read(context.Background())
		} else {
			_, err = allocation.exec(ctx, read)
		}
		if err != nil {
			capture.OutputError = joinPLDebugOutputError(capture.OutputError, err.Error())
		}
		if errors.Is(err, errPLDebugOutputLimit) {
			capture.Truncated = true
		}
	}
	capture.Truncated = capture.Truncated || (capture.NativeTruncated.Valid && capture.NativeTruncated.Int64 != 0)
	capture.OutputComplete = refs.readComplete && capture.NativeComplete.Valid && capture.NativeComplete.Int64 == 1 && capture.NativeTruncated.Valid && capture.NativeTruncated.Int64 == 0 && capture.OutputError == ""
	if !refs.releaseAttempted {
		capture.ReleaseError = ""
		release := func(context.Context) (driver.Result, error) {
			refs.releaseAttempted = true
			err := refs.clob.release()
			refs.released = err == nil
			if err != nil {
				allocation.mu.Lock()
				allocation.unknown = true
				allocation.mu.Unlock()
			}
			return nil, err
		}
		var err error
		if refs.clob.memory {
			_, err = release(context.Background())
		} else {
			_, err = allocation.exec(ctx, release)
		}
		if err != nil {
			capture.ReleaseError = err.Error()
		}
	}
	lobsReleased := true
	for _, lob := range refs.lobs {
		lob.finish(ctx, allocation)
		lobsReleased = lobsReleased && lob.released
		if lob.releaseAttempted && !lob.released {
			capture.ReleaseError = joinPLDebugOutputError(capture.ReleaseError, "typed LOB release not confirmed")
		}
	}
	if refs.released && lobsReleased && !refs.statementCloseAttempted {
		refs.statementCloseAttempted = true
		if err := refs.statement.Close(); err != nil {
			capture.ReleaseError = err.Error()
		}
	}
	if refs.released && lobsReleased && refs.statementCloseAttempted {
		allocation.mu.Lock()
		finished := allocation.active == nil && !allocation.unknown && len(allocation.statements) == 0 && len(allocation.rows) == 0
		allocation.mu.Unlock()
		if finished {
			capture.references = nil
			capture.ReferencesPending = false
			capture.ReleaseError = ""
		}
	}
}

func joinPLDebugOutputError(left, right string) string {
	if left == "" {
		return right
	}
	return left + "; " + right
}

type plDebugNativeOutputPage struct {
	Text       string
	Offset     int
	NextOffset int
	TotalChars int
	Complete   bool
	Truncated  bool
	Error      string
}

func (capture *plDebugNativeCapture) page(offset, limit int) (plDebugNativeOutputPage, error) {
	if capture.utf16Text == nil {
		capture.utf16Text = utf16.Encode([]rune(capture.Output))
	}
	text := capture.utf16Text
	if offset < 0 || offset > len(text) {
		return plDebugNativeOutputPage{}, errors.New("invalid output cursor")
	}
	if offset > 0 && offset < len(text) && text[offset] >= 0xDC00 && text[offset] <= 0xDFFF && text[offset-1] >= 0xD800 && text[offset-1] <= 0xDBFF {
		return plDebugNativeOutputPage{}, errors.New("output cursor splits a Unicode character")
	}
	if limit < 2 || limit > 64*1024 {
		return plDebugNativeOutputPage{}, errors.New("invalid output page size")
	}
	count := len(text) - offset
	if count > limit {
		count = limit
	}
	end := offset + count
	if end < len(text) && end > offset && text[end-1] >= 0xD800 && text[end-1] <= 0xDBFF && text[end] >= 0xDC00 && text[end] <= 0xDFFF {
		end--
	}
	return plDebugNativeOutputPage{Text: string(utf16.Decode(text[offset:end])), Offset: offset, NextOffset: end, TotalChars: len(text), Complete: capture.OutputComplete, Truncated: capture.Truncated, Error: capture.OutputError}, nil
}
