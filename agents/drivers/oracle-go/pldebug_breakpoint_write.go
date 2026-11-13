package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"
)

type plDebugNativeBreakpointRequest struct {
	OperationID      string                        `json:"operationId"`
	SourceRefID      string                        `json:"sourceRefId"`
	SourceRevision   int64                         `json:"sourceRevision"`
	StopRevision     int64                         `json:"stopRevision"`
	NativeFrameID    int64                         `json:"nativeFrameId"`
	Line             int64                         `json:"line"`
	BreakpointNumber *int64                        `json:"breakpointNumber"`
	RegistrationID   string                        `json:"registrationId"`
	Enabled          *bool                         `json:"enabled"`
	Rules            *plDebugNativeBreakpointRules `json:"rules"`
}

type plDebugNativeBreakpointOperation struct {
	frozen       string
	done         chan struct{}
	result       interface{}
	err          error
	state        string
	stopRevision int64
	action       string
}

type plDebugNativeOwnedBreakpoint struct {
	Native         plDebugNativeBreakpoint
	Source         plDebugNativeSourceRef
	Line           int64
	RegistrationID string
	Rules          plDebugNativeBreakpointRules
	Hits           int64
}

func (e *plDebugNativeEntry) mutateNativeBreakpoint(params map[string]json.RawMessage, action string) (result interface{}, err error) {
	defer func() {
		var native *plDebugNativeError
		if err != nil && !errors.As(err, &native) {
			err = &plDebugNativeError{message: err.Error(), outcome: "not_started", agentSessionID: e.agentSessionID, category: "protocol", stage: "request"}
		}
	}()
	deleting := action == "delete_breakpoints"
	var request plDebugNativeBreakpointRequest
	raw, err := json.Marshal(params)
	if err == nil {
		err = json.Unmarshal(raw, &request)
	}
	if err != nil {
		return nil, err
	}
	creating := action == "set_breakpoints" && request.BreakpointNumber == nil
	updatingRules := action == "set_breakpoints" && !creating && request.Rules != nil
	if !plDebugOperationID.MatchString(request.OperationID) || request.StopRevision <= 0 || (creating && (request.SourceRefID == "" || request.SourceRevision <= 0 || request.NativeFrameID <= 0 || request.Line <= 0)) || (!creating && (request.BreakpointNumber == nil || request.RegistrationID == "")) || (!creating && !deleting && !updatingRules && request.Enabled == nil) {
		return nil, errors.New("operationId, current stopRevision and registered breakpoint/source identity are required")
	}
	if request.Rules != nil && (request.Rules.IgnoreCount < 0 || len(request.Rules.Condition) > 4096 || len(request.Rules.Message) > 4096) {
		return nil, errors.New("breakpoint rules require a nonnegative ignore count and at most 4096 bytes per condition/message")
	}
	frozen, _ := json.Marshal(request)
	frozenRequest := action + ":" + string(frozen)
	e.mu.Lock()
	if e.valueOperations[request.OperationID] != nil || e.executeOperations[request.OperationID] != nil {
		e.mu.Unlock()
		return nil, errors.New("operationId belongs to the original value operation")
	}
	if previous := e.breakpointOperations[request.OperationID]; previous != nil {
		if previous.frozen != frozenRequest {
			e.mu.Unlock()
			return nil, errors.New("operationId conflicts with the original breakpoint request")
		}
		done := previous.done
		e.mu.Unlock()
		if err := plDebugWaitUntil(done, time.Now().Add(plDebugCallTimeout)); err != nil {
			return nil, &plDebugNativeError{message: "the original breakpoint operation is still pending", outcome: "unknown", agentSessionID: e.agentSessionID, category: "timeout", stage: "execute"}
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		return previous.result, previous.err
	}
	if len(e.breakpointOperations) >= 256 || e.closeRequested || e.actionBusy || e.targetReturned || e.startState != "succeeded" || e.state != "paused" || request.StopRevision != e.stopRevision || (creating && e.nativeStack == nil) {
		e.mu.Unlock()
		return nil, errors.New("the original paused source is not available for breakpoint modification")
	}
	var source *plDebugNativeSourceRef
	var owned plDebugNativeOwnedBreakpoint
	if !creating {
		var exists bool
		owned, exists = e.ownedBreakpoints[*request.BreakpointNumber]
		if !exists || owned.RegistrationID != request.RegistrationID {
			e.mu.Unlock()
			return nil, errors.New("the breakpoint is not owned by the original registration")
		}
	} else {
		for _, frame := range e.nativeStack.Frames {
			ref := frame.SourceRef
			if frame.SourceState == "resolved" && ref != nil && ref.ID == request.SourceRefID && ref.SourceRevision == request.SourceRevision && ref.StopRevision == request.StopRevision && ref.NativeFrameID == request.NativeFrameID {
				copy := *ref
				source = &copy
				break
			}
		}
		if source == nil || request.Line > int64(strings.Count(source.Source, "\n")+1) || (source.ObjectType == "ANONYMOUS" && source.NativeFrameID != e.nativeStack.Frames[0].NativeFrameID) {
			e.mu.Unlock()
			return nil, errors.New("the breakpoint does not belong to the registered current source")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	op := &plDebugNativeBreakpointOperation{frozen: frozenRequest, done: make(chan struct{}), state: "running", stopRevision: request.StopRevision, action: action}
	if e.breakpointOperations == nil {
		e.breakpointOperations = map[string]*plDebugNativeBreakpointOperation{}
	}
	e.breakpointOperations[request.OperationID] = op
	e.actionBusy, e.actionCancel, e.actionDone = true, cancel, make(chan struct{})
	e.mu.Unlock()
	dispatched := false
	defer func() {
		if recovered := recover(); recovered != nil {
			e.server.plAllocation.mu.Lock()
			e.server.plAllocation.unknown = true
			e.server.plAllocation.mu.Unlock()
			err = fmt.Errorf("native breakpoint modification panic: %v", recovered)
		}
		e.server.plAllocation.mu.Lock()
		unknown := e.server.plAllocation.unknown || e.server.plAllocation.active != nil
		e.server.plAllocation.mu.Unlock()
		e.mu.Lock()
		defer e.mu.Unlock()
		e.actionBusy = false
		close(e.actionDone)
		if unknown || (dispatched && err != nil) {
			if !e.closeRequested {
				e.state = "unknown"
			}
		}
		if err != nil {
			op.state = "failed"
			outcome, stage := "not_started", "request"
			if dispatched {
				outcome, stage = "unknown", "execute"
				op.state = "unknown"
			}
			err = &plDebugNativeError{message: err.Error(), outcome: outcome, agentSessionID: e.agentSessionID, category: "protocol", stage: stage}
			result = nil
		} else {
			result.(map[string]interface{})["snapshot"] = e.snapshotLocked()
			op.state = "failed"
			if result.(map[string]interface{})["ok"] == true {
				op.state = "succeeded"
			}
		}
		op.result, op.err = result, err
		close(op.done)
	}()
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return nil, err
	}
	if (creating || (!deleting && request.Enabled != nil && *request.Enabled)) && e.namedPlan != nil {
		if changed, err := e.checkNativeTargetVersion(ctx, "breakpoint modification"); err != nil {
			if changed {
				e.mu.Lock()
				if e.nativeStack != nil {
					for i := range e.nativeStack.Frames {
						e.nativeStack.Frames[i].SourceRef = nil
						e.nativeStack.Frames[i].SourceState = "stale"
					}
					e.nativeStack.SourceError = err.Error()
				}
				e.entryState, e.entryError = "unresolved", err.Error()
				e.mu.Unlock()
			}
			return nil, err
		}
	}
	before, err := e.readNativeBreakpointInventory(ctx)
	if err != nil {
		return nil, err
	}
	if !creating {
		matched := false
		for _, current := range before {
			if current.ID == *request.BreakpointNumber {
				matched = reflect.DeepEqual(current, owned.Native)
			}
		}
		if !matched {
			return nil, errors.New("the owned native breakpoint inventory changed before modification")
		}
		if updatingRules {
			e.mu.Lock()
			if owned.Rules.IgnoreCount != request.Rules.IgnoreCount {
				owned.Hits = 0
			}
			owned.Rules = *request.Rules
			e.ownedBreakpoints[*request.BreakpointNumber] = owned
			e.mu.Unlock()
			return map[string]interface{}{"operationId": request.OperationID, "ok": true, "result": int64(0), "stopRevision": request.StopRevision, "breakpointNumber": *request.BreakpointNumber, "rules": owned.Rules, "hits": owned.Hits, "rulesUpdated": true, "nativeMutation": false}, nil
		}
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			return nil, err
		}
		dispatched = true
		var code sql.NullInt64
		if deleting {
			code, err = plDebugNativeDeleteBreakpoint(ctx, e.server.plConnection, usesOCIProfile(e.server.params), *request.BreakpointNumber)
		} else {
			code, err = plDebugNativeToggleBreakpoint(ctx, e.server.plConnection, usesOCIProfile(e.server.params), *request.BreakpointNumber, *request.Enabled)
		}
		if err != nil {
			return nil, err
		}
		if code.Int64 != 0 {
			return map[string]interface{}{"operationId": request.OperationID, "stopRevision": request.StopRevision, "ok": false, "result": code.Int64}, nil
		}
		after, err := e.readNativeBreakpointInventory(ctx)
		if err != nil {
			return nil, err
		}
		var updated *plDebugNativeBreakpoint
		for _, current := range after {
			if current.ID == *request.BreakpointNumber {
				if deleting {
					return nil, errors.New("deleted native breakpoint is still present; do not replay")
				}
				identity := current
				identity.Status, identity.LocalActive = owned.Native.Status, owned.Native.LocalActive
				if !reflect.DeepEqual(identity, owned.Native) || current.LocalActive != *request.Enabled {
					return nil, errors.New("native breakpoint toggle readback does not match the owned record; do not replay")
				}
				copy := current
				updated = &copy
			}
		}
		if !deleting && updated == nil {
			return nil, errors.New("toggled native breakpoint is absent; do not replay")
		}
		remaining := make([]plDebugNativeBreakpoint, 0, len(before)-1)
		for _, current := range before {
			if current.ID != *request.BreakpointNumber {
				remaining = append(remaining, current)
			} else if updated != nil {
				remaining = append(remaining, *updated)
			}
		}
		if !reflect.DeepEqual(remaining, after) {
			return nil, errors.New("native breakpoint modification changed unrelated inventory records")
		}
		e.mu.Lock()
		if deleting {
			delete(e.ownedBreakpoints, *request.BreakpointNumber)
		} else {
			owned.Native = *updated
			e.ownedBreakpoints[*request.BreakpointNumber] = owned
		}
		e.mu.Unlock()
		response := map[string]interface{}{"operationId": request.OperationID, "ok": true, "result": code.Int64, "breakpointNumber": *request.BreakpointNumber, "registrationId": request.RegistrationID, "stopRevision": request.StopRevision}
		if !deleting {
			response["enabled"] = *request.Enabled
		}
		return response, nil
	}
	nativeLine := request.Line
	namespace, owner, name := source.Namespace, source.Owner, source.Name
	if source.ObjectType == "ANONYMOUS" {
		nativeLine += int64(source.LineOffset)
		namespace, owner, name = nil, nil, nil
	}
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return nil, err
	}
	dispatched = true
	code, number, rejected, err := plDebugNativeSetBreakpoint(ctx, e.server.plConnection, usesOCIProfile(e.server.params), namespace, owner, name, nil, nativeLine)
	if err != nil {
		return nil, err
	}
	if !code.Valid || !rejected.Valid || (code.Int64 == 0 && !number.Valid) {
		return nil, errors.New("native breakpoint creation did not return a complete receipt; do not replay")
	}
	if code.Int64 != 0 {
		return map[string]interface{}{"operationId": request.OperationID, "stopRevision": request.StopRevision, "ok": false, "result": code.Int64, "rejected": rejected.Int64}, nil
	}
	after, err := e.readNativeBreakpointInventory(ctx)
	if err != nil {
		return nil, err
	}
	for _, existing := range before {
		found := false
		for _, current := range after {
			if current.ID == existing.ID {
				found = reflect.DeepEqual(existing, current)
				break
			}
		}
		if !found {
			return nil, errors.New("native breakpoint creation changed an existing inventory record")
		}
	}
	for _, current := range after {
		if current.ID == number.Int64 && current.Line != nil && *current.Line == nativeLine && current.LocalActive && (source.ObjectType == "ANONYMOUS" || (reflect.DeepEqual(current.Owner, owner) && reflect.DeepEqual(current.Name, name))) {
			existing := false
			for _, previous := range before {
				existing = existing || previous.ID == current.ID
			}
			e.mu.Lock()
			if e.ownedBreakpoints == nil {
				e.ownedBreakpoints = map[int64]plDebugNativeOwnedBreakpoint{}
			}
			if !existing {
				owned := plDebugNativeOwnedBreakpoint{Native: current, Source: *source, Line: request.Line, RegistrationID: request.OperationID}
				if request.Rules != nil {
					owned.Rules = *request.Rules
				}
				e.ownedBreakpoints[current.ID] = owned
			}
			owned, registered := e.ownedBreakpoints[current.ID]
			registered = registered && reflect.DeepEqual(owned.Native, current)
			e.mu.Unlock()
			registration := ""
			if registered {
				registration = owned.RegistrationID
			}
			return map[string]interface{}{"operationId": request.OperationID, "ok": true, "result": code.Int64, "breakpointNumber": number.Int64, "sourceRefId": source.ID, "sourceRevision": source.SourceRevision, "stopRevision": source.StopRevision, "line": request.Line, "nativeLine": nativeLine, "owned": registered, "registrationId": registration}, nil
		}
	}
	return nil, errors.New("native breakpoint receipt could not be verified against the original source; do not replay")
}
