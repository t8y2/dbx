package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

type plDebugNativeVariable struct {
	Name         string  `json:"name"`
	Type         *string `json:"type"`
	State        string  `json:"state"`
	Value        *string `json:"value"`
	RawValue     *string `json:"rawValue"`
	NativeResult *int64  `json:"nativeResult"`
	Message      *string `json:"message"`
}

func plDebugNativeVariableResult(name string, value plDebugNativeValue) plDebugNativeVariable {
	variable := plDebugNativeVariable{Name: name, State: "unknown"}
	if value.Result.Valid {
		code := value.Result.Int64
		variable.NativeResult = &code
	}
	if value.Value.Valid {
		raw := value.Value.String
		variable.RawValue = &raw
	}
	if !value.Result.Valid {
		return variable
	}
	switch value.Result.Int64 {
	case plDebugErrSuccess:
		if variable.RawValue != nil {
			variable.State, variable.Value = "value", variable.RawValue
			if *variable.RawValue == "" {
				variable.State = "empty"
			}
		} else {
			message := "Native GET_VALUE returned no scalar payload"
			variable.Message = &message
		}
	case plDebugErrNullValue:
		variable.State = "null"
	case plDebugErrNoSuchObject:
		variable.State = "out_of_scope"
		message := "Variable is not in this native frame"
		variable.Message = &message
	default:
		variable.State = "error"
		message := fmt.Sprintf("SYS.DBMS_DEBUG.GET_VALUE result=%d", value.Result.Int64)
		variable.Message = &message
	}
	return variable
}

func (e *plDebugNativeEntry) readValue(params map[string]json.RawMessage) (result interface{}, err error) {
	return e.readNativeValues(params, false)
}

func (e *plDebugNativeEntry) readNativeValues(params map[string]json.RawMessage, enumerate bool) (result interface{}, err error) {
	var request struct {
		Name         string `json:"name"`
		Frame        int    `json:"frame"`
		StopRevision *int64 `json:"stopRevision"`
	}
	raw, decodeErr := json.Marshal(params)
	if decodeErr == nil {
		decodeErr = json.Unmarshal(raw, &request)
	}
	if decodeErr != nil {
		return nil, decodeErr
	}
	if (!enumerate && request.Name == "") || request.Frame < 0 || request.StopRevision == nil {
		return nil, errors.New("name, current stopRevision, and a nonnegative frame index are required")
	}
	if rawFrame, exists := params["frame"]; exists && bytes.Equal(bytes.TrimSpace(rawFrame), []byte("null")) {
		return nil, errors.New("frame index cannot be null")
	}
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return nil, err
	}
	e.mu.Lock()
	if e.closeRequested || e.actionBusy || e.targetReturned || e.startState != "succeeded" || e.state != "paused" || *request.StopRevision != e.stopRevision {
		e.mu.Unlock()
		return nil, errors.New("the variable belongs to an unavailable or old debug stop")
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
	e.actionBusy, e.actionCancel, e.actionDone = true, cancel, make(chan struct{})
	e.mu.Unlock()
	var variable plDebugNativeVariable
	variables := []plDebugNativeVariable{}
	discoveryError := ""
	defer func() {
		if recovered := recover(); recovered != nil {
			e.server.plAllocation.mu.Lock()
			e.server.plAllocation.unknown = true
			e.server.plAllocation.mu.Unlock()
			err = &plDebugNativeError{message: fmt.Sprintf("native value inspection panic: %v", recovered), outcome: "unknown", agentSessionID: e.agentSessionID, category: "protocol", stage: "execute"}
			result = nil
		}
		e.server.plAllocation.mu.Lock()
		unknown := e.server.plAllocation.unknown || e.server.plAllocation.active != nil
		e.server.plAllocation.mu.Unlock()
		e.mu.Lock()
		e.actionBusy = false
		close(e.actionDone)
		if !e.closeRequested && (unknown || e.targetReturned) {
			e.state = "unknown"
		}
		if err == nil && (e.closeRequested || unknown || e.targetReturned) {
			err = &plDebugNativeError{message: "the original debug stop ended during value inspection", outcome: "unknown", agentSessionID: e.agentSessionID}
			result = nil
		}
		if err == nil {
			snapshot := e.snapshotLocked()
			snapshot["frame"], snapshot["nativeFrameId"], snapshot["frameMappingState"] = request.Frame, nativeFrame, "verified"
			if enumerate {
				snapshot["variables"], snapshot["variablesSource"] = variables, "get_value"
				snapshot["variablesComplete"], snapshot["variablesError"] = discoveryError == "", discoveryError
			} else {
				snapshot["variable"] = variable
			}
			result = snapshot
		}
		e.mu.Unlock()
	}()
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return nil, err
	}
	names := []string{request.Name}
	types := map[string]string{}
	if enumerate {
		names, discoveryError = e.nativeVariableNames(ctx, request.Frame, nativeFrame, *request.StopRevision, types)
	}
	for _, name := range names {
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			return nil, err
		}
		value, readErr := plDebugNativeGetValue(ctx, e.server.plConnection, p.oci, name, nativeFrame)
		if readErr != nil {
			if enumerate && ctx.Err() == nil && !errors.Is(readErr, errPLDebugNativeValueResultMissing) {
				message := readErr.Error()
				failed := plDebugNativeVariable{Name: name, State: "error", Message: &message}
				if declaredType, known := types[name]; known {
					failed.Type = &declaredType
				}
				variables = append(variables, failed)
				if discoveryError != "" {
					discoveryError += "; "
				}
				discoveryError += "GET_VALUE failed for " + name + ": " + message
				continue
			}
			category := "sql"
			if errors.Is(readErr, errPLDebugNativeValueResultMissing) {
				category = "protocol"
			} else if errors.Is(readErr, context.DeadlineExceeded) {
				category = "timeout"
			} else if errors.Is(readErr, context.Canceled) {
				category = "canceled"
			}
			return nil, &plDebugNativeError{message: readErr.Error(), outcome: "unknown", agentSessionID: e.agentSessionID, category: category, stage: "execute"}
		}
		variable = plDebugNativeVariableResult(name, value)
		if declaredType, known := types[name]; known {
			variable.Type = &declaredType
		}
		if enumerate && (variable.State == "error" || variable.State == "unknown") {
			if discoveryError != "" {
				discoveryError += "; "
			}
			discoveryError += "Scalar value unavailable for " + name
		}
		variables = append(variables, variable)
	}
	return nil, nil
}
