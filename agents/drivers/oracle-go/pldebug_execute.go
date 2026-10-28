package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const plDebugNativeExecuteBlock = `DECLARE
	statement_text VARCHAR2(32767) := :1;
	bind_results BINARY_INTEGER := :2;
	row_limit BINARY_INTEGER := :3;
	text_limit BINARY_INTEGER := :4;
  results SYS.DBMS_DEBUG_VC2COLL := SYS.DBMS_DEBUG_VC2COLL();
  errm VARCHAR2(4000);
  position BINARY_INTEGER;
  fetched BINARY_INTEGER := 0;
  text_count BINARY_INTEGER := 0;
  rows_truncated BOOLEAN := FALSE;
` + plDebugNativeJSONDeclarations + `BEGIN
  :5 := 0;
  BEGIN
    SYS.DBMS_DEBUG.EXECUTE(statement_text, -1, bind_results, results, errm);
    :5 := 1;
  EXCEPTION WHEN OTHERS THEN
    :5 := 1;
    errm := SQLERRM;
  END;
  :6 := errm;
  BEGIN
    SYS.DBMS_LOB.CREATETEMPORARY(payload, TRUE);
    append_text('{"rows":[');
    IF bind_results != 0 THEN
      BEGIN
        position := results.FIRST;
      EXCEPTION WHEN COLLECTION_IS_NULL THEN position := NULL;
      END;
      WHILE position IS NOT NULL LOOP
        IF fetched >= row_limit OR text_count + NVL(LENGTH(results(position)), 0) > text_limit THEN
          rows_truncated := TRUE;
          EXIT;
        END IF;
        IF fetched > 0 THEN append_text(','); END IF;
        append_string(results(position));
        text_count := text_count + NVL(LENGTH(results(position)), 0);
        fetched := fetched + 1;
        position := results.NEXT(position);
      END LOOP;
    END IF;
    append_text('],"count":'); append_integer(fetched);
    IF rows_truncated THEN
      append_text(',"complete":false,"truncated":true}');
    ELSE
      append_text(',"complete":true,"truncated":false}');
    END IF;
    :7 := payload;
    :8 := 1;
    :9 := 0;
    :10 := NULL;
  EXCEPTION WHEN OTHERS THEN
    :7 := payload;
    :8 := 0;
    :9 := 0;
    :10 := SQLERRM;
  END;
END;`

type plDebugNativeExecuteRows struct {
	Rows      []*string `json:"rows"`
	Count     int       `json:"count"`
	Complete  bool      `json:"complete"`
	Truncated bool      `json:"truncated"`
}

type plDebugNativeExecuteCapture struct {
	Returned sql.NullInt64
	Error    sql.NullString
	Capture  *plDebugNativeCapture
	Result   plDebugNativeExecuteRows
}

func plDebugExecuteNativeStatement(ctx context.Context, conn *sql.Conn, allocation *plDebugAllocation, oci bool, source string, maxRows int, retain func(*plDebugNativeCapture), returned func(sql.NullInt64, sql.NullString, error)) (result plDebugNativeExecuteCapture, err error) {
	statementText, plsqlBlock := plDebugExecuteSource(source)
	if statementText == "" {
		return result, errors.New("the statement is empty")
	}
	bindResults := 0
	if plsqlBlock {
		bindResults = 1
	}
	if maxRows <= 0 {
		maxRows = plDebugExecuteDefaultRows
	}
	if maxRows > plDebugExecuteMaxRows {
		maxRows = plDebugExecuteMaxRows
	}
	clob, err := newPLDebugClobOutput(oci)
	if err != nil {
		return result, err
	}
	statement, err := conn.PrepareContext(ctx, plDebugNativeExecuteBlock)
	if err != nil {
		return result, err
	}
	capture := &plDebugNativeCapture{references: &plDebugCaptureReferences{statement: statement, clob: clob}, ReferencesPending: true}
	result.Capture = capture
	if retain != nil {
		retain(capture)
	}
	_, err = statement.ExecContext(ctx, statementText, bindResults, maxRows, plDebugExecuteTextLimit,
		plDebugOutArg(oci, &result.Returned), plDebugOutArg(oci, &result.Error), clob.bind,
		plDebugOutArg(oci, &capture.NativeComplete), plDebugOutArg(oci, &capture.NativeTruncated), plDebugOutArg(oci, &capture.NativeOutputError))
	if returned != nil {
		returned(result.Returned, result.Error, err)
	}
	capture.finishReferences(ctx, allocation)
	if err != nil {
		return result, err
	}
	if !result.Returned.Valid || result.Returned.Int64 != 1 {
		return result, errors.New("native EXECUTE did not confirm its return")
	}
	if !capture.OutputComplete {
		return result, errors.New("native EXECUTE result is incomplete: " + joinPLDebugOutputError(capture.OutputError, capture.ReleaseError))
	}
	var wire struct {
		Rows      []*string `json:"rows"`
		Count     *int      `json:"count"`
		Complete  *bool     `json:"complete"`
		Truncated *bool     `json:"truncated"`
	}
	if err = json.Unmarshal([]byte(capture.Output), &wire); err != nil {
		return result, err
	}
	if wire.Rows == nil || wire.Count == nil || wire.Complete == nil || wire.Truncated == nil || *wire.Count != len(wire.Rows) || *wire.Count > maxRows || *wire.Complete == *wire.Truncated {
		return result, errors.New("native EXECUTE returned inconsistent row metadata")
	}
	result.Result = plDebugNativeExecuteRows{Rows: wire.Rows, Count: *wire.Count, Complete: *wire.Complete, Truncated: *wire.Truncated}
	if capture.ReferencesPending || capture.ReleaseError != "" {
		return result, errors.New("native EXECUTE references are not released: " + capture.ReleaseError)
	}
	return result, nil
}

func (e *plDebugNativeEntry) executeStatement(params map[string]json.RawMessage) (response interface{}, err error) {
	defer func() {
		var native *plDebugNativeError
		if err != nil && !errors.As(err, &native) {
			err = &plDebugNativeError{message: err.Error(), outcome: "not_started", agentSessionID: e.agentSessionID, category: "protocol", stage: "request"}
		}
	}()
	var request struct {
		OperationID  string `json:"operationId"`
		StopRevision *int64 `json:"stopRevision"`
		SQL          string `json:"sql"`
		MaxRows      int    `json:"maxRows"`
	}
	raw, decodeErr := json.Marshal(params)
	if decodeErr == nil {
		decodeErr = json.Unmarshal(raw, &request)
	}
	if decodeErr != nil {
		return nil, decodeErr
	}
	if !plDebugOperationID.MatchString(request.OperationID) || request.StopRevision == nil || strings.TrimSpace(request.SQL) == "" {
		return nil, errors.New("operationId, current stopRevision and SQL are required")
	}
	if request.MaxRows <= 0 {
		request.MaxRows = plDebugExecuteDefaultRows
	}
	if request.MaxRows > plDebugExecuteMaxRows {
		request.MaxRows = plDebugExecuteMaxRows
	}
	frozen, _ := json.Marshal(request)
	e.mu.Lock()
	if e.valueOperations[request.OperationID] != nil || e.breakpointOperations[request.OperationID] != nil {
		e.mu.Unlock()
		return nil, errors.New("operationId belongs to another original action")
	}
	if previous := e.executeOperations[request.OperationID]; previous != nil {
		if previous.frozen != string(frozen) {
			e.mu.Unlock()
			return nil, errors.New("operationId conflicts with the original SQL request")
		}
		done := previous.done
		e.mu.Unlock()
		if waitErr := plDebugWaitUntil(done, time.Now().Add(plDebugCallTimeout)); waitErr != nil {
			return nil, &plDebugNativeError{message: "original SQL operation is still pending", outcome: "unknown", agentSessionID: e.agentSessionID, category: "timeout", stage: "execute"}
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		return previous.result, previous.err
	}
	if len(e.executeOperations) >= 256 {
		e.mu.Unlock()
		return nil, errors.New("SQL operation receipt limit reached")
	}
	if e.closeRequested || e.actionBusy || e.targetReturned || e.startState != "succeeded" || e.state != "paused" || *request.StopRevision != e.stopRevision {
		e.mu.Unlock()
		return nil, errors.New("SQL belongs to an unavailable or old debug stop")
	}
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	op := &plDebugNativeValueOperation{frozen: string(frozen), done: make(chan struct{}), state: "running", stopRevision: *request.StopRevision}
	if e.executeOperations == nil {
		e.executeOperations = map[string]*plDebugNativeValueOperation{}
	}
	e.executeOperations[request.OperationID] = op
	e.actionBusy, e.actionCancel, e.actionDone = true, cancel, make(chan struct{})
	e.mu.Unlock()
	dispatched, known := false, false
	var capture *plDebugNativeCapture
	defer func() {
		if recovered := recover(); recovered != nil {
			e.server.plAllocation.mu.Lock()
			e.server.plAllocation.unknown = true
			e.server.plAllocation.mu.Unlock()
			err = &plDebugNativeError{message: fmt.Sprintf("native SQL panic: %v", recovered), outcome: "unknown", agentSessionID: e.agentSessionID, category: "protocol", stage: "execute"}
		}
		e.server.plAllocation.mu.Lock()
		uncertain := e.server.plAllocation.unknown || e.server.plAllocation.active != nil
		e.server.plAllocation.mu.Unlock()
		e.mu.Lock()
		defer e.mu.Unlock()
		if capture != nil && capture.ReferencesPending {
			e.nativeReadPending = append(e.nativeReadPending, capture)
			uncertain = true
		}
		e.actionBusy = false
		close(e.actionDone)
		if !e.closeRequested && (uncertain || e.targetReturned || dispatched && !known) {
			e.state = "unknown"
		}
		if known {
			if response == nil {
				response = op.result
			}
			copy := map[string]interface{}{}
			for key, value := range response.(map[string]interface{}) {
				copy[key] = value
			}
			response = copy
			copy["snapshot"] = e.snapshotLocked()
			if err != nil {
				response.(map[string]interface{})["resultError"] = err.Error()
				response.(map[string]interface{})["complete"] = false
				err = nil
			}
		} else if err != nil {
			op.state = "failed"
			if dispatched {
				op.state = "unknown"
			}
			response = nil
		}
		op.result, op.err = response, err
		close(op.done)
	}()
	if allowedErr := e.nativeEntryCallAllowed(ctx); allowedErr != nil {
		return nil, &plDebugNativeError{message: allowedErr.Error(), outcome: "not_started", agentSessionID: e.agentSessionID, category: "protocol", stage: "request"}
	}
	result, executeErr := plDebugExecuteNativeStatement(ctx, e.server.plConnection, e.server.plAllocation, e.session.oci, request.SQL, request.MaxRows, func(owned *plDebugNativeCapture) { capture = owned; dispatched = true }, func(returned sql.NullInt64, nativeError sql.NullString, _ error) {
		if !returned.Valid || returned.Int64 != 1 {
			return
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		known = true
		op.state = "succeeded"
		if nativeError.Valid && nativeError.String != "" {
			op.state = "failed"
		}
		op.result = map[string]interface{}{"operationId": request.OperationID, "action": "execute", "stopRevision": *request.StopRevision, "ok": op.state == "succeeded", "rows": []*string{}, "count": 0, "complete": false, "truncated": false, "error": nativeError.String}
	})
	capture = result.Capture
	if known {
		copy := map[string]interface{}{}
		for key, value := range op.result.(map[string]interface{}) {
			copy[key] = value
		}
		response = copy
		if result.Result.Rows != nil {
			m := response.(map[string]interface{})
			m["rows"], m["count"], m["complete"], m["truncated"] = result.Result.Rows, result.Result.Count, result.Result.Complete, result.Result.Truncated
		}
		if executeErr != nil {
			response.(map[string]interface{})["resultError"] = executeErr.Error()
			response.(map[string]interface{})["complete"] = false
		}
		return response, nil
	}
	if executeErr == nil {
		executeErr = errors.New("native EXECUTE has no original return receipt")
	}
	if !dispatched {
		return nil, &plDebugNativeError{message: executeErr.Error(), outcome: "not_started", agentSessionID: e.agentSessionID, category: "sql", stage: "prepare"}
	}
	return nil, &plDebugNativeError{message: executeErr.Error(), outcome: "unknown", agentSessionID: e.agentSessionID, category: "sql", stage: "execute"}
}
