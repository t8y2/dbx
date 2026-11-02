package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

type plDebugNativeStackRecord struct {
	NativeFrameID int64   `json:"nativeFrameId"`
	Namespace     *int64  `json:"namespace"`
	Program       *string `json:"program"`
	Owner         *string `json:"programOwner"`
	DBLink        *string `json:"dblink"`
	Line          *int64  `json:"nativeLine"`
	LibUnitType   *int64  `json:"libUnitType"`
	Entrypoint    *string `json:"entrypoint"`
	Anonymous     bool    `json:"anonymous"`
	NamespaceKind string  `json:"namespaceKind"`
}

type plDebugNativeStackFrame struct {
	plDebugNativeStackRecord
	FrameIndex      int                           `json:"frameIndex"`
	StackDepth      int64                         `json:"stackDepth"`
	SourceLine      *int64                        `json:"line"`
	IdentityState   string                        `json:"identityState"`
	SourceState     string                        `json:"sourceState"`
	SourceRef       *plDebugNativeSourceRef       `json:"sourceRef"`
	SourceError     string                        `json:"sourceError"`
	RoutineIdentity *plDebugNativeRoutineIdentity `json:"routineIdentity"`
}

type plDebugNativeStack struct {
	Frames        []plDebugNativeStackFrame  `json:"frames"`
	Complete      bool                       `json:"complete"`
	MappingState  string                     `json:"frameMappingState"`
	Error         string                     `json:"structuredBacktraceError"`
	StopRevision  int64                      `json:"stopRevision"`
	NativeRecords []plDebugNativeStackRecord `json:"nativeFrames"`
	SourceError   string                     `json:"sourceError"`
}

const plDebugNativeStackBlock = `DECLARE
  listing SYS.DBMS_DEBUG.backtrace_table;
  position BINARY_INTEGER;
` + plDebugNativeJSONDeclarations + `BEGIN
  SYS.DBMS_DEBUG.PRINT_BACKTRACE(listing);
  SYS.DBMS_LOB.CREATETEMPORARY(payload, TRUE);
  append_text('[');
  position := listing.FIRST;
  WHILE position IS NOT NULL LOOP
    IF position != listing.FIRST THEN append_text(','); END IF;
    append_text('{"nativeFrameId":'); append_integer(position);
    append_text(',"namespace":'); append_integer(listing(position).namespace);
    append_text(',"program":'); append_string(listing(position).name);
    append_text(',"programOwner":'); append_string(listing(position).owner);
    append_text(',"dblink":'); append_string(listing(position).dblink);
    append_text(',"nativeLine":'); append_integer(listing(position).line#);
    append_text(',"libUnitType":'); append_integer(listing(position).libunittype);
    append_text(',"entrypoint":'); append_string(listing(position).entrypointname);
    append_text(',"anonymous":');
    IF listing(position).namespace = SYS.DBMS_DEBUG.namespace_cursor
       AND listing(position).name IS NULL AND listing(position).owner IS NULL THEN
      append_text('true');
    ELSE append_text('false'); END IF;
    append_text(',"namespaceKind":');
    IF listing(position).namespace = SYS.DBMS_DEBUG.namespace_pkg_body THEN
      append_string('package_body');
    ELSIF listing(position).namespace = SYS.DBMS_DEBUG.namespace_pkgspec_or_toplevel THEN
      append_string('toplevel_or_spec');
    ELSE append_text('null'); END IF;
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

func plDebugNativeReadStack(ctx context.Context, conn *sql.Conn, allocation *plDebugAllocation, oci bool) ([]plDebugNativeStackRecord, *plDebugNativeCapture, error) {
	capture, err := plDebugReadNativeJSON(ctx, conn, allocation, oci, plDebugNativeStackBlock)
	if err != nil {
		return nil, capture, err
	}
	var records []plDebugNativeStackRecord
	if err := json.Unmarshal([]byte(capture.Output), &records); err != nil {
		return nil, capture, err
	}
	if records == nil {
		return nil, capture, errors.New("native backtrace did not return an array")
	}
	seen := map[int64]bool{}
	for _, record := range records {
		if record.NativeFrameID <= 0 || seen[record.NativeFrameID] {
			return nil, capture, errors.New("native backtrace returned invalid or duplicate frame indices")
		}
		seen[record.NativeFrameID] = true
	}
	return records, capture, nil
}

func plDebugNativeMapStack(stop plDebugNativeStop, records []plDebugNativeStackRecord, readErr error, revision int64) plDebugNativeStack {
	stack := plDebugNativeStack{Frames: []plDebugNativeStackFrame{}, MappingState: "unverified", StopRevision: revision, NativeRecords: records}
	if readErr != nil {
		stack.Error = readErr.Error()
	}
	if plDebugNativeStopState(stop) != "paused" || !stop.StackDepth.Valid || stop.StackDepth.Int64 <= 0 {
		return stack
	}
	depth := stop.StackDepth.Int64
	stack.MappingState = "verified"
	byID := map[int64]plDebugNativeStackRecord{}
	consistent := readErr == nil && int64(len(records)) == depth
	for _, record := range records {
		if record.NativeFrameID < 1 || record.NativeFrameID > depth {
			consistent = false
		}
		byID[record.NativeFrameID] = record
	}
	leaf := byID[depth]
	conflict := func(raw sql.NullString, observed *string) bool {
		return raw.Valid && observed != nil && raw.String != *observed
	}
	if conflict(stop.Program, leaf.Program) || conflict(stop.Owner, leaf.Owner) || conflict(stop.DBLink, leaf.DBLink) || conflict(stop.Entrypoint, leaf.Entrypoint) || (stop.LibUnitType.Valid && leaf.LibUnitType != nil && stop.LibUnitType.Int64 != *leaf.LibUnitType) || (stop.Namespace.Valid && leaf.Namespace != nil && stop.Namespace.Int64 != *leaf.Namespace) || (stop.Line.Valid && leaf.Line != nil && stop.Line.Int64 != *leaf.Line) {
		consistent = false
		stack.Error = "native backtrace conflicts with the current runtime stop"
	}
	stack.Complete = consistent
	for nativeID := depth; nativeID >= 1; nativeID-- {
		frame := plDebugNativeStackFrame{plDebugNativeStackRecord: plDebugNativeStackRecord{NativeFrameID: nativeID}, FrameIndex: int(depth - nativeID), IdentityState: "unresolved", SourceState: "unresolved"}
		if consistent {
			frame.plDebugNativeStackRecord = byID[nativeID]
		}
		if nativeID == depth {
			if stop.Program.Valid {
				value := stop.Program.String
				frame.Program = &value
			}
			if stop.Owner.Valid {
				value := stop.Owner.String
				frame.Owner = &value
			}
			if stop.Namespace.Valid {
				value := stop.Namespace.Int64
				frame.Namespace = &value
			}
			if stop.Line.Valid {
				value := stop.Line.Int64
				frame.Line = &value
			}
			if stop.DBLink.Valid {
				value := stop.DBLink.String
				frame.DBLink = &value
			}
			if stop.LibUnitType.Valid {
				value := stop.LibUnitType.Int64
				frame.LibUnitType = &value
			}
			if stop.Entrypoint.Valid {
				value := stop.Entrypoint.String
				frame.Entrypoint = &value
			}
		}
		if frame.Program != nil && frame.Owner != nil && frame.Namespace != nil {
			frame.IdentityState = "native"
		} else {
			stack.Complete = false
		}
		frame.StackDepth, frame.SourceLine = nativeID, frame.plDebugNativeStackRecord.Line
		stack.Frames = append(stack.Frames, frame)
	}
	if !consistent && readErr == nil && stack.Error == "" {
		stack.Error = fmt.Sprintf("native backtrace does not match runtime depth %d", depth)
	}
	return stack
}

func (e *plDebugNativeEntry) stack(params map[string]json.RawMessage) (interface{}, error) {
	var revisionFence *int64
	if raw, exists := params["stopRevision"]; exists {
		if err := json.Unmarshal(raw, &revisionFence); err != nil || revisionFence == nil {
			return nil, errors.New("stack inspection requires a valid stopRevision")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	e.mu.Lock()
	if e.closeRequested || e.actionBusy || e.targetReturned || e.startState != "succeeded" || e.state != "paused" || e.session == nil || (revisionFence != nil && *revisionFence != e.stopRevision) {
		e.mu.Unlock()
		return nil, errors.New("the original paused operation is not available for stack inspection")
	}
	p, revision := e.session, e.stopRevision
	e.actionBusy, e.actionCancel, e.actionDone = true, cancel, make(chan struct{})
	e.mu.Unlock()
	p.mu.Lock()
	stop := *p.nativeStop
	p.mu.Unlock()
	stack := e.readNativeMappedStack(ctx, stop, revision)
	e.server.plAllocation.mu.Lock()
	unknown := e.server.plAllocation.unknown || e.server.plAllocation.active != nil
	e.server.plAllocation.mu.Unlock()
	e.mu.Lock()
	e.actionBusy = false
	close(e.actionDone)
	e.publishNativeStackLocked(stack, unknown)
	stack = *e.nativeStack
	result := e.snapshotLocked()
	result["frames"], result["nativeFrames"] = stack.Frames, stack.NativeRecords
	result["complete"], result["structuredBacktraceError"] = stack.Complete, stack.Error
	result["sourceError"] = stack.SourceError
	result["runtimeDepth"] = plDebugNativeInteger(stop.StackDepth)
	e.mu.Unlock()
	return result, nil
}

func (e *plDebugNativeEntry) readNativeMappedStack(ctx context.Context, stop plDebugNativeStop, revision int64) (stack plDebugNativeStack) {
	var records []plDebugNativeStackRecord
	var readErr error
	defer func() {
		if recovered := recover(); recovered != nil {
			e.server.plAllocation.mu.Lock()
			e.server.plAllocation.unknown = true
			e.server.plAllocation.mu.Unlock()
			readErr = fmt.Errorf("native stack inspection panic: %v", recovered)
		}
		if stack.Frames == nil {
			stack = plDebugNativeMapStack(stop, records, readErr, revision)
		}
		if readErr != nil && stack.Error == "" {
			stack.Error = readErr.Error()
		}
	}()
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		readErr = err
		return
	}
	var capture *plDebugNativeCapture
	records, capture, readErr = plDebugNativeReadStack(ctx, e.server.plConnection, e.server.plAllocation, usesOCIProfile(e.server.params))
	if capture != nil && capture.ReferencesPending {
		e.mu.Lock()
		e.nativeReadPending = append(e.nativeReadPending, capture)
		e.mu.Unlock()
	}
	stack = plDebugNativeMapStack(stop, records, readErr, revision)
	e.resolveNativeNamedSources(ctx, &stack)
	if stack.SourceError == "" {
		e.resolveNativeAnonymousSources(ctx, &stack)
	}
	if e.namedPlan != nil && stack.MappingState == "verified" && len(stack.Frames) != 0 && stack.Frames[0].SourceRef == nil && (!stop.Program.Valid || !stop.Owner.Valid) && stop.Reason.Valid && stop.Reason.Int64 != plDebugReasonBreakpoint && stop.Reason.Int64 != plDebugReasonException && stop.Reason.Int64 != plDebugReasonHandler {
		if err := e.inspectNativeCurrentProgram(ctx, stop); err == nil {
			e.resolveNativeNamedSources(ctx, &stack)
		}
	}
	return
}

func (e *plDebugNativeEntry) publishNativeStackLocked(stack plDebugNativeStack, unknown bool) {
	if unknown || len(e.nativeReadPending) != 0 || e.closeRequested || e.targetReturned {
		stack.MappingState, stack.Complete = "unverified", false
		for i := range stack.Frames {
			stack.Frames[i].SourceRef = nil
			stack.Frames[i].SourceState = "unresolved"
			stack.Frames[i].RoutineIdentity = nil
		}
		if !e.closeRequested {
			e.state = "unknown"
		}
	}
	e.entryState = "unresolved"
	e.entryError = stack.Error
	if stack.SourceError != "" {
		e.entryError = stack.SourceError
	}
	if stack.MappingState == "verified" && len(stack.Frames) != 0 && stack.Frames[0].SourceRef != nil && stack.Frames[0].SourceRef.ObjectType == "ANONYMOUS" {
		if stack.Frames[0].SourceState == "resolved" {
			e.entryState = "reached"
		} else {
			e.entryState = "wrapper"
		}
	}
	if stack.MappingState == "verified" && len(stack.Frames) != 0 && stack.Frames[0].RoutineIdentity != nil {
		switch stack.Frames[0].RoutineIdentity.State {
		case "verified":
			e.entryState = "reached"
		case "package_initialization":
			e.entryState = "package_initialization"
		case "other_routine":
			e.entryState = "other_routine"
		}
		if stack.Frames[0].RoutineIdentity.Error != "" {
			e.entryError = stack.Frames[0].RoutineIdentity.Error
		}
	}
	e.nativeStack = &stack
	if e.entryState != "unresolved" {
		e.entryError = ""
	}
}
