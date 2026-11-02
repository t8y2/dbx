package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
)

type plDebugNativeBreakpoint struct {
	ID          int64   `json:"id"`
	Name        *string `json:"name"`
	Owner       *string `json:"owner"`
	DBLink      *string `json:"dblink"`
	Line        *int64  `json:"line"`
	LibUnitType *int64  `json:"libUnitType"`
	Status      *int64  `json:"status"`
	LocalActive bool    `json:"localActive"`
}

type plDebugNativeListedBreakpoint struct {
	plDebugNativeBreakpoint
	BreakpointNumber int64  `json:"breakpointNumber"`
	NativeLine       *int64 `json:"nativeLine"`
	Line             *int64 `json:"line"`
	Owned            bool   `json:"owned"`
	RegistrationID   string `json:"registrationId,omitempty"`
	SourceRefID      string `json:"sourceRefId,omitempty"`
	SourceRevision   int64  `json:"sourceRevision,omitempty"`
	Kind             string `json:"kind,omitempty"`
	IgnoreCount      int64  `json:"ignoreCount"`
	Condition        string `json:"condition"`
	Message          string `json:"message"`
	Hits             int64  `json:"hits"`
}

const plDebugNativeJSONDeclarations = `  payload CLOB;
  PROCEDURE append_text(value VARCHAR2) IS
  BEGIN
    IF value IS NOT NULL THEN
      IF SYS.DBMS_LOB.GETLENGTH(payload) + LENGTH(value) > 16777216 THEN
        RAISE_APPLICATION_ERROR(-20000, 'Native breakpoint inventory exceeds the transfer limit');
      END IF;
      SYS.DBMS_LOB.WRITEAPPEND(payload, LENGTH(value), value);
    END IF;
  END;
  PROCEDURE append_string(value VARCHAR2) IS
    character_value VARCHAR2(8);
    character_code BINARY_INTEGER;
  BEGIN
    IF value IS NULL THEN append_text('null'); RETURN; END IF;
    append_text('"');
    FOR i IN 1 .. LENGTH(value) LOOP
      character_value := SUBSTR(value, i, 1);
      character_code := ASCII(character_value);
      IF character_value = CHR(34) OR character_value = CHR(92) THEN
        append_text(CHR(92) || character_value);
      ELSIF character_code BETWEEN 0 AND 31 THEN
        append_text(CHR(92) || 'u00' || LPAD(TO_CHAR(character_code, 'FMXX'), 2, '0'));
      ELSE
        append_text(character_value);
      END IF;
    END LOOP;
    append_text('"');
  END;
  PROCEDURE append_integer(value BINARY_INTEGER) IS
  BEGIN
    IF value IS NULL THEN append_text('null');
    ELSE append_text(TO_CHAR(value, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')); END IF;
  END;
`

const plDebugNativeBreakpointsBlock = `DECLARE
  listing SYS.DBMS_DEBUG.breakpoint_table;
  position BINARY_INTEGER;
` + plDebugNativeJSONDeclarations + `BEGIN
  SYS.DBMS_DEBUG.SHOW_BREAKPOINTS(listing);
  SYS.DBMS_LOB.CREATETEMPORARY(payload, TRUE);
  append_text('[');
  position := listing.FIRST;
  WHILE position IS NOT NULL LOOP
    IF position != listing.FIRST THEN append_text(','); END IF;
    append_text('{"id":'); append_integer(position);
    append_text(',"name":'); append_string(listing(position).name);
    append_text(',"owner":'); append_string(listing(position).owner);
    append_text(',"dblink":'); append_string(listing(position).dblink);
    append_text(',"line":'); append_integer(listing(position).line#);
    append_text(',"libUnitType":'); append_integer(listing(position).libunittype);
    append_text(',"status":'); append_integer(listing(position).status);
    append_text(',"localActive":');
    IF listing(position).status = SYS.DBMS_DEBUG.breakpoint_status_active THEN
      append_text('true');
    ELSE append_text('false'); END IF;
    append_text('}');
    position := listing.NEXT(position);
  END LOOP;
  append_text(']');
  :1 := payload;
  :2 := 1;
  :3 := 0;
EXCEPTION WHEN OTHERS THEN
  IF payload IS NOT NULL AND SYS.DBMS_LOB.ISTEMPORARY(payload) = 1 THEN
    SYS.DBMS_LOB.FREETEMPORARY(payload);
  END IF;
  RAISE;
END;`

func plDebugNativeBreakpoints(ctx context.Context, conn *sql.Conn, allocation *plDebugAllocation, oci bool) ([]plDebugNativeBreakpoint, *plDebugNativeCapture, error) {
	capture, err := plDebugReadNativeJSON(ctx, conn, allocation, oci, plDebugNativeBreakpointsBlock)
	if err != nil {
		return nil, capture, err
	}
	var breakpoints []plDebugNativeBreakpoint
	if err := json.Unmarshal([]byte(capture.Output), &breakpoints); err != nil {
		return nil, capture, err
	}
	if breakpoints == nil {
		return nil, capture, errors.New("native breakpoint inventory did not return an array")
	}
	seen := map[int64]bool{}
	for _, breakpoint := range breakpoints {
		if seen[breakpoint.ID] {
			return nil, capture, errors.New("native breakpoint inventory returned duplicate indices")
		}
		seen[breakpoint.ID] = true
	}
	return breakpoints, capture, nil
}

func (e *plDebugNativeEntry) listNativeBreakpoints() (result interface{}, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return nil, err
	}
	e.mu.Lock()
	if e.closeRequested || e.actionBusy || e.targetReturned || e.startState != "succeeded" || e.state != "paused" {
		e.mu.Unlock()
		return nil, errors.New("the original paused operation is not available for breakpoint inspection")
	}
	e.actionBusy, e.actionCancel, e.actionDone = true, cancel, make(chan struct{})
	e.mu.Unlock()
	var breakpoints []plDebugNativeBreakpoint
	defer func() {
		if recovered := recover(); recovered != nil {
			e.server.plAllocation.mu.Lock()
			e.server.plAllocation.unknown = true
			e.server.plAllocation.mu.Unlock()
			err = &plDebugNativeError{message: fmt.Sprintf("native breakpoint inspection panic: %v", recovered), outcome: "unknown", agentSessionID: e.agentSessionID, category: "protocol", stage: "execute"}
		}
		e.server.plAllocation.mu.Lock()
		unknown := e.server.plAllocation.unknown || e.server.plAllocation.active != nil
		e.server.plAllocation.mu.Unlock()
		e.mu.Lock()
		defer e.mu.Unlock()
		e.actionBusy = false
		close(e.actionDone)
		if !e.closeRequested && (unknown || e.targetReturned) {
			e.state = "unknown"
		}
		if err == nil && (e.closeRequested || unknown || e.targetReturned) {
			err = &plDebugNativeError{message: "the original debug stop ended during breakpoint inspection", outcome: "unknown", agentSessionID: e.agentSessionID}
		}
		if err != nil {
			result = nil
			return
		}
		snapshot := e.snapshotLocked()
		listed := make([]plDebugNativeListedBreakpoint, len(breakpoints))
		for i, breakpoint := range breakpoints {
			listed[i] = plDebugNativeListedBreakpoint{plDebugNativeBreakpoint: breakpoint, BreakpointNumber: breakpoint.ID, NativeLine: breakpoint.Line, Line: breakpoint.Line}
			if owned, exists := e.ownedBreakpoints[breakpoint.ID]; exists && reflect.DeepEqual(owned.Native, breakpoint) {
				line := owned.Line
				listed[i].Line, listed[i].Owned = &line, true
				listed[i].RegistrationID, listed[i].SourceRefID = owned.RegistrationID, owned.Source.ID
				listed[i].SourceRevision, listed[i].Kind = owned.Source.SourceRevision, owned.Source.ObjectType
				listed[i].IgnoreCount, listed[i].Condition, listed[i].Message, listed[i].Hits = owned.Rules.IgnoreCount, owned.Rules.Condition, owned.Rules.Message, owned.Hits
			}
		}
		snapshot["breakpoints"] = listed
		result = snapshot
	}()
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return nil, err
	}
	breakpoints, err = e.readNativeBreakpointInventory(ctx)
	return nil, err
}

func plDebugReadNativeJSON(ctx context.Context, conn *sql.Conn, allocation *plDebugAllocation, oci bool, query string, inputs ...interface{}) (*plDebugNativeCapture, error) {
	clob, err := newPLDebugClobOutput(oci)
	if err != nil {
		return nil, err
	}
	statement, err := conn.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	capture := &plDebugNativeCapture{references: &plDebugCaptureReferences{statement: statement, clob: clob}, ReferencesPending: true}
	args := append(append([]interface{}{}, inputs...), clob.bind, plDebugOutArg(oci, &capture.NativeComplete), plDebugOutArg(oci, &capture.NativeTruncated))
	_, err = statement.ExecContext(ctx, args...)
	capture.finishReferences(ctx, allocation)
	if err != nil {
		return capture, err
	}
	if !capture.OutputComplete || capture.ReferencesPending || capture.ReleaseError != "" {
		return capture, fmt.Errorf("native structured result is incomplete: %s", joinPLDebugOutputError(capture.OutputError, capture.ReleaseError))
	}
	return capture, nil
}

func plDebugNativeSetBreakpoint(ctx context.Context, conn *sql.Conn, oci bool, namespace *int64, owner, name, dblink *string, line int64) (sql.NullInt64, sql.NullInt64, sql.NullInt64, error) {
	var result, number, rejected sql.NullInt64
	inputs := []interface{}{nil, nil, nil, nil, line, plDebugOutArg(oci, &result), plDebugOutArg(oci, &number), plDebugOutArg(oci, &rejected)}
	if namespace != nil {
		inputs[0] = *namespace
	}
	for index, value := range []*string{owner, name, dblink} {
		if value != nil {
			inputs[index+1] = *value
		}
	}
	_, err := conn.ExecContext(ctx, `DECLARE
  program SYS.DBMS_DEBUG.program_info;
  breakpoint_number BINARY_INTEGER;
  line_number BINARY_INTEGER;
  result_code BINARY_INTEGER;
BEGIN
  program.namespace := :1;
  program.owner := :2;
  program.name := :3;
  program.dblink := :4;
  line_number := :5;
  program.line# := line_number;
  result_code := SYS.DBMS_DEBUG.SET_BREAKPOINT(program, line_number, breakpoint_number, 0);
  :6 := result_code;
  :7 := breakpoint_number;
  IF result_code IN (SYS.DBMS_DEBUG.error_illegal_line, SYS.DBMS_DEBUG.error_bad_handle) THEN
    :8 := 1;
  ELSE :8 := 0; END IF;
END;`, inputs...)
	if err == nil && (!result.Valid || !rejected.Valid || (result.Int64 == 0 && !number.Valid)) {
		err = errors.New("native SET_BREAKPOINT returned an incomplete result; do not repeat the operation")
	}
	return result, number, rejected, err
}

func plDebugNativeDeleteBreakpoint(ctx context.Context, conn *sql.Conn, oci bool, number int64) (sql.NullInt64, error) {
	var result sql.NullInt64
	_, err := conn.ExecContext(ctx, `BEGIN :2 := SYS.DBMS_DEBUG.DELETE_BREAKPOINT(:1); END;`, number, plDebugOutArg(oci, &result))
	if err == nil && !result.Valid {
		err = errors.New("native DELETE_BREAKPOINT returned no result code")
	}
	return result, err
}

func plDebugNativeToggleBreakpoint(ctx context.Context, conn *sql.Conn, oci bool, number int64, enabled bool) (sql.NullInt64, error) {
	var result sql.NullInt64
	statement := `BEGIN :2 := SYS.DBMS_DEBUG.DISABLE_BREAKPOINT(:1); END;`
	if enabled {
		statement = `BEGIN :2 := SYS.DBMS_DEBUG.ENABLE_BREAKPOINT(:1); END;`
	}
	_, err := conn.ExecContext(ctx, statement, number, plDebugOutArg(oci, &result))
	if err == nil && !result.Valid {
		err = errors.New("native breakpoint toggle returned no result code; do not replay")
	}
	return result, err
}
