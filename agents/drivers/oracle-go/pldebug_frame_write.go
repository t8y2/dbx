package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type plDebugNativeValueRequest struct {
	OperationID  string  `json:"operationId"`
	StopRevision *int64  `json:"stopRevision"`
	Name         string  `json:"name"`
	Frame        int     `json:"frame"`
	Index        int     `json:"index"`
	Value        *string `json:"value"`
}

type plDebugNativeValueOperation struct {
	frozen       string
	done         chan struct{}
	state        string
	result       interface{}
	err          error
	stopRevision int64
}

func (e *plDebugNativeEntry) valueOperationStatus(params map[string]json.RawMessage) (interface{}, error) {
	id := stringParam(params, "operationId")
	e.mu.Lock()
	defer e.mu.Unlock()
	if op := e.executeOperations[id]; op != nil {
		state := "running"
		select {
		case <-op.done:
			state = op.state
		default:
		}
		result := map[string]interface{}{"operationId": id, "action": "execute", "state": state, "stopRevision": op.stopRevision, "result": op.result}
		if op.err != nil {
			result["message"] = op.err.Error()
			if data := errorResponse(nil, op.err, "pl_debug_execute", e.agentSessionID).Error.Data; data != nil {
				value, err := plDebugNativeJSONValue(data)
				if err != nil {
					return nil, err
				}
				diagnostic := value.(map[string]interface{})
				diagnostic["message"] = op.err.Error()
				result["error"] = diagnostic
			}
		}
		return result, nil
	}
	if op := e.breakpointOperations[id]; op != nil {
		result := map[string]interface{}{"operationId": id, "action": op.action, "state": op.state, "stopRevision": op.stopRevision, "result": op.result}
		if op.err != nil {
			result["message"] = op.err.Error()
		}
		return result, nil
	}
	op := e.valueOperations[id]
	if op == nil {
		return nil, errors.New("the original value operation is not available")
	}
	result := map[string]interface{}{"operationId": id, "action": "set_value", "state": op.state, "stopRevision": op.stopRevision, "result": op.result}
	if op.err != nil {
		result["message"] = op.err.Error()
	}
	return result, nil
}

func (e *plDebugNativeEntry) writeValue(params map[string]json.RawMessage) (result interface{}, err error) {
	defer func() {
		var native *plDebugNativeError
		if err != nil && !errors.As(err, &native) {
			err = &plDebugNativeError{message: err.Error(), outcome: "not_started", agentSessionID: e.agentSessionID, category: "protocol", stage: "request"}
		}
	}()
	var request plDebugNativeValueRequest
	raw, decodeErr := json.Marshal(params)
	if decodeErr == nil {
		decodeErr = json.Unmarshal(raw, &request)
	}
	if decodeErr != nil {
		return nil, decodeErr
	}
	if !plDebugOperationID.MatchString(request.OperationID) || request.StopRevision == nil || strings.TrimSpace(request.Name) == "" || request.Frame < 0 || request.Index < 0 || request.Value == nil {
		return nil, errors.New("operationId, current stopRevision, name, value and nonnegative frame/index are required")
	}
	for _, key := range []string{"frame", "index"} {
		if value, exists := params[key]; exists && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, fmt.Errorf("%s cannot be null", key)
		}
	}
	frozen, _ := json.Marshal(request)
	e.mu.Lock()
	if e.breakpointOperations[request.OperationID] != nil || e.executeOperations[request.OperationID] != nil {
		e.mu.Unlock()
		return nil, errors.New("operationId belongs to the original breakpoint operation")
	}
	if previous := e.valueOperations[request.OperationID]; previous != nil {
		if previous.frozen != string(frozen) {
			e.mu.Unlock()
			return nil, errors.New("operationId conflicts with the original value request")
		}
		done := previous.done
		e.mu.Unlock()
		if waitErr := plDebugWaitUntil(done, time.Now().Add(plDebugCallTimeout)); waitErr != nil {
			return nil, &plDebugNativeError{message: "the original value operation is still pending", outcome: "unknown", agentSessionID: e.agentSessionID, category: "timeout", stage: "execute"}
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		return previous.result, previous.err
	}
	if len(e.valueOperations) >= 256 {
		e.mu.Unlock()
		return nil, errors.New("value operation receipt limit reached")
	}
	if e.closeRequested || e.actionBusy || e.targetReturned || e.startState != "succeeded" || e.state != "paused" || *request.StopRevision != e.stopRevision {
		e.mu.Unlock()
		return nil, errors.New("the assignment belongs to an unavailable or old debug stop")
	}
	p := e.session
	p.mu.Lock()
	stop := *p.nativeStop
	p.mu.Unlock()
	if !stop.StackDepth.Valid || stop.StackDepth.Int64 <= 0 || int64(request.Frame) >= stop.StackDepth.Int64 {
		e.mu.Unlock()
		return nil, errors.New("the requested native frame position is not verified")
	}
	nativeFrame := int(stop.StackDepth.Int64 - int64(request.Frame))
	if int64(nativeFrame) != stop.StackDepth.Int64-int64(request.Frame) {
		e.mu.Unlock()
		return nil, errors.New("native frame position is outside the driver integer range")
	}
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	op := &plDebugNativeValueOperation{frozen: string(frozen), done: make(chan struct{}), state: "running", stopRevision: *request.StopRevision}
	if e.valueOperations == nil {
		e.valueOperations = map[string]*plDebugNativeValueOperation{}
	}
	e.valueOperations[request.OperationID] = op
	e.actionBusy, e.actionCancel, e.actionDone = true, cancel, make(chan struct{})
	e.mu.Unlock()
	dispatched := false
	defer func() {
		if recovered := recover(); recovered != nil {
			e.server.plAllocation.mu.Lock()
			e.server.plAllocation.unknown = true
			e.server.plAllocation.mu.Unlock()
			err = &plDebugNativeError{message: fmt.Sprintf("native assignment panic: %v", recovered), outcome: "unknown", agentSessionID: e.agentSessionID, category: "protocol", stage: "execute"}
		}
		e.server.plAllocation.mu.Lock()
		unknown := e.server.plAllocation.unknown || e.server.plAllocation.active != nil
		e.server.plAllocation.mu.Unlock()
		e.mu.Lock()
		e.actionBusy = false
		close(e.actionDone)
		if !e.closeRequested && (unknown || e.targetReturned || (err != nil && dispatched)) {
			e.state = "unknown"
		}
		if err != nil {
			op.state = "unknown"
			if !dispatched {
				op.state = "failed"
			}
			result = nil
		} else {
			response := result.(map[string]interface{})
			response["snapshot"] = e.snapshotLocked()
			op.state = "failed"
			if response["ok"] == true {
				op.state = "succeeded"
			}
		}
		op.result, op.err = result, err
		close(op.done)
		e.mu.Unlock()
	}()
	if allowedErr := e.nativeEntryCallAllowed(ctx); allowedErr != nil {
		return nil, allowedErr
	}
	assignment := plDebugAssignmentStatement(request.Name, request.Index, *request.Value)
	if !strings.HasSuffix(strings.TrimSpace(assignment), ";") {
		assignment += ";"
	}
	dispatched = true
	code, writeErr := plDebugNativeSetValue(ctx, e.server.plConnection, p.oci, nativeFrame, assignment)
	if writeErr != nil {
		category := "sql"
		if errors.Is(writeErr, errPLDebugNativeSetResultMissing) {
			category = "protocol"
		}
		if errors.Is(writeErr, context.Canceled) {
			category = "canceled"
		} else if errors.Is(writeErr, context.DeadlineExceeded) {
			category = "timeout"
		}
		return nil, &plDebugNativeError{message: writeErr.Error(), outcome: "unknown", agentSessionID: e.agentSessionID, category: category, stage: "execute"}
	}
	return map[string]interface{}{"operationId": request.OperationID, "stopRevision": *request.StopRevision, "frameIndex": request.Frame, "nativeFrameId": nativeFrame, "ok": code.Int64 == plDebugErrSuccess, "result": code.Int64, "message": fmt.Sprintf("SYS.DBMS_DEBUG.SET_VALUE result=%d", code.Int64)}, nil
}
