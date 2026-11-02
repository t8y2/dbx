package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

type plDebugNativeError struct{ message, outcome, agentSessionID, category, stage string }

func (e *plDebugNativeError) Error() string { return e.message }

type plDebugNativeStart struct {
	OperationID         string                 `json:"operationId"`
	Schema              string                 `json:"schema"`
	ObjectType          string                 `json:"objectType"`
	ObjectName          string                 `json:"objectName"`
	PackageName         string                 `json:"packageName"`
	Source              string                 `json:"source"`
	Params              []interface{}          `json:"params"`
	TargetSignature     map[string]interface{} `json:"targetSignature"`
	MetadataPreparation string                 `json:"metadataPreparation,omitempty"`
}

type plDebugNativeEntry struct {
	mu                                          sync.Mutex
	runtime                                     *runtimeServer
	server                                      *server
	agentSessionID                              string
	request                                     plDebugNativeStart
	frozen                                      string
	nativeID                                    string
	session                                     *plDebugSession
	cached                                      map[string]interface{}
	startDone                                   chan struct{}
	startOwnerDone                              chan struct{}
	preflightRejected                           bool
	captureDone                                 chan struct{}
	dispatchDone                                chan struct{}
	startCancel                                 context.CancelFunc
	startDeadline                               time.Time
	startState, startError, state               string
	actionBusy, closeRequested, cancelRequested bool
	actionCancel                                context.CancelFunc
	actionDone                                  chan struct{}
	targetDispatched, targetReturned            bool
	captureFinished                             bool
	capture                                     plDebugNativeCapture
	targetError                                 string
	block                                       plDebugNativeBlock
	namedPlan                                   *plDebugNativePlan
	namedCall                                   *plDebugNativeNamedCall
	namedResult                                 map[string]interface{}
	resultCache                                 plDebugResultCache
	targetSource                                *plDebugNativeSource
	targetSignatureSource                       *plDebugNativeSource
	programProbe                                *plDebugNativeProgramProbe
	nativeReadPending                           []*plDebugNativeCapture
	entryState                                  string
	entryError                                  string
	nativeStack                                 *plDebugNativeStack
	valueOperations                             map[string]*plDebugNativeValueOperation
	executeOperations                           map[string]*plDebugNativeValueOperation
	breakpointOperations                        map[string]*plDebugNativeBreakpointOperation
	ownedBreakpoints                            map[int64]plDebugNativeOwnedBreakpoint
	ruleEventSequence                           int64
	ruleEvents                                  []plDebugNativeRuleEvent
	stopRevision                                int64
	releaseState, transactionOutcome            string
	cleanupBusy                                 bool
	cleanupDone                                 chan struct{}
	cleanupDeadline                             time.Time
	cleanupError                                string
	continuationDone                            chan struct{}
	continuationWaiting                         bool
	outputRecoveryAttempted                     bool
	outputRecoveryDone                          chan struct{}
	outputRecoveryCapture                       plDebugNativeCapture
	outputRecoveryError                         string
	abortAcknowledged                           bool
	abortAttempted                              bool
	abortError                                  string
	leaseDeadline                               time.Time
	leaseTimer                                  *time.Timer
	closeReason                                 string
}

var plDebugOperationID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func plDebugFreezeStart(params map[string]json.RawMessage) (plDebugNativeStart, string, error) {
	request, err := plDebugDecodeNativeStart(params)
	if err != nil {
		return request, "", err
	}
	if !plDebugOperationID.MatchString(request.OperationID) {
		return request, "", errors.New("a stable operationId is required")
	}
	frozen, err := json.Marshal(request)
	return request, string(frozen), err
}

func plDebugDecodeNativeStart(params map[string]json.RawMessage) (plDebugNativeStart, error) {
	var request plDebugNativeStart
	raw, err := json.Marshal(params)
	if err != nil {
		return request, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err = decoder.Decode(&request); err != nil {
		return request, err
	}
	if policy, supplied := params["metadataPreparation"]; supplied && !bytes.Equal(bytes.TrimSpace(policy), []byte("null")) && request.MetadataPreparation != "type_only" {
		return request, errors.New("unsupported type metadata preparation policy")
	}
	return request, nil
}

func (r *runtimeServer) dispatchNativeDebug(method string, params map[string]json.RawMessage) (interface{}, error) {
	if method == "pl_debug_compile" {
		return r.compileNativeTarget(params)
	}
	if method == "pl_debug_compile_status" {
		return r.nativeCompileStatus(params)
	}
	if method == "pl_debug_inspect" {
		return r.inspectNativeTarget(params)
	}
	if method == "pl_debug_resolve_target" {
		return r.previewNativeTarget(params)
	}
	if method == "pl_debug_start" {
		return r.startNativeDebug(params)
	}
	id := stringParam(params, "debugId")
	if id == "" {
		id = stringParam(params, "operationId")
	}
	r.mu.RLock()
	entry := r.plNativeEntries[id]
	r.mu.RUnlock()
	if entry == nil || (stringParam(params, "agentSessionId") != "" && stringParam(params, "agentSessionId") != entry.agentSessionID) {
		return nil, errors.New("PL/SQL operation is not accessible")
	}
	switch method {
	case "pl_debug_heartbeat":
		return entry.heartbeat(), nil
	case "pl_debug_status", "pl_debug_get_status":
		return entry.snapshot(), nil
	case "pl_debug_operation_status":
		return entry.valueOperationStatus(params)
	case "pl_debug_get_log":
		return entry.output(params)
	case "pl_debug_get_log_page":
		pageParams := make(map[string]json.RawMessage, len(params)+1)
		for key, value := range params {
			pageParams[key] = value
		}
		if _, supplied := pageParams["offset"]; !supplied {
			pageParams["offset"] = json.RawMessage("0")
		}
		return entry.output(pageParams)
	case "pl_debug_get_results":
		return entry.results(), nil
	case "pl_debug_get_result_page":
		return entry.resultPage(params)
	case "pl_debug_get_stack":
		return entry.stack(params)
	case "pl_debug_list_breakpoints":
		return entry.listNativeBreakpoints()
	case "pl_debug_set_breakpoints":
		return entry.mutateNativeBreakpoint(params, "set_breakpoints")
	case "pl_debug_delete_breakpoints":
		return entry.mutateNativeBreakpoint(params, "delete_breakpoints")
	case "pl_debug_set_breakpoint_enabled":
		return entry.mutateNativeBreakpoint(params, "set_breakpoint_enabled")
	case "pl_debug_get_value":
		return entry.readValue(params)
	case "pl_debug_get_variables":
		return entry.readNativeValues(params, true)
	case "pl_debug_set_value":
		return entry.writeValue(params)
	case "pl_debug_execute":
		return entry.executeStatement(params)
	case "pl_debug_close", "pl_debug_abort":
		return entry.close()
	case "pl_debug_resume", "pl_debug_step_over", "pl_debug_step_in", "pl_debug_step_out", "pl_debug_resume_ignore_breakpoints", "pl_debug_set_exception_breakpoint":
		return entry.control(method, params)
	default:
		return nil, errors.New("this native PL/SQL operation is not yet connected")
	}
}

func (r *runtimeServer) startNativeDebug(params map[string]json.RawMessage) (interface{}, error) {
	request, frozen, err := plDebugFreezeStart(params)
	if err != nil {
		return nil, err
	}
	agentID := stringParam(params, "agentSessionId")
	if agentID == "" {
		return nil, errors.New("agentSessionId is required")
	}
	r.mu.Lock()
	if existing := r.plNativeEntries[request.OperationID]; existing != nil {
		r.mu.Unlock()
		if existing.agentSessionID != agentID || existing.frozen != frozen {
			return nil, errors.New("operationId conflicts with the original start request")
		}
		return existing.snapshot(), nil
	}
	session := r.sessions[agentID]
	if session == nil {
		r.mu.Unlock()
		return nil, errors.New("the original dedicated session is not available")
	}
	if r.plMetadataBusy || r.nativeCompileUnresolvedLocked() || !session.mu.TryLock() {
		r.mu.Unlock()
		return nil, &plDebugNativeError{message: "the original debugger connection is busy preparing metadata", outcome: "not_started", agentSessionID: agentID, category: "resource", stage: "request"}
	}
	ready := session.server.plConnection != nil
	session.mu.Unlock()
	if !ready {
		r.mu.Unlock()
		return nil, &plDebugNativeError{message: "the original dedicated session has not finished connecting", outcome: "not_started", agentSessionID: agentID, category: "resource", stage: "request"}
	}
	if len(r.plNativeEntries) >= 8 {
		r.mu.Unlock()
		return nil, errors.New("PL/SQL operation receipt limit reached")
	}
	// One dedicated runtime owns one physical pair, including after a failed start.
	// A different id must never inherit or replay that pair.
	if len(r.plNativeEntries) != 0 {
		r.mu.Unlock()
		return nil, errors.New("this dedicated runtime already owns its original start")
	}
	entry := &plDebugNativeEntry{runtime: r, server: session.server, agentSessionID: agentID, request: request, frozen: frozen,
		cached: map[string]interface{}{}, startDone: make(chan struct{}), captureDone: make(chan struct{}), dispatchDone: make(chan struct{}),
		startState: "pending", state: "starting", releaseState: "open", transactionOutcome: "not_started"}
	entry.startOwnerDone = make(chan struct{})
	entry.preflightRejected = true
	entry.startDeadline = time.Now().Add(plDebugOpenTimeout + 3*plDebugCallTimeout)
	if r.plNativeEntries == nil {
		r.plNativeEntries = map[string]*plDebugNativeEntry{}
	}
	r.plNativeEntries[request.OperationID] = entry
	entry.leaseDeadline = time.Now().Add(plDebugNativeLease)
	entry.leaseTimer = time.AfterFunc(plDebugNativeLease, entry.expireLease)
	r.mu.Unlock()
	go entry.start()
	if err := plDebugWaitUntil(entry.startDone, entry.startDeadline); err != nil {
		entry.mu.Lock()
		if entry.startState == "pending" {
			entry.state = "unknown"
			entry.startError = "original start is still pending after its wait deadline"
		}
		entry.mu.Unlock()
	}
	return entry.snapshot(), nil
}

func (e *plDebugNativeEntry) snapshot() map[string]interface{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.snapshotLocked()
}

func (e *plDebugNativeEntry) snapshotLocked() map[string]interface{} {
	result := make(map[string]interface{}, len(e.cached)+25)
	for key, value := range e.cached {
		result[key] = value
	}
	result["debugId"], result["startOperationId"], result["nativeDebugId"] = e.request.OperationID, e.request.OperationID, e.nativeID
	result["startState"], result["startError"], result["state"] = e.startState, e.startError, e.state
	result["operationBusy"] = e.actionBusy || e.startState == "pending" || e.cleanupBusy
	result["targetDispatched"], result["targetReturned"] = e.targetDispatched, e.targetReturned
	result["cancelRequested"], result["closeRequested"] = e.cancelRequested, e.closeRequested
	result["closeReason"] = e.closeReason
	result["releaseState"], result["transactionOutcome"] = e.releaseState, e.transactionOutcome
	result["transactionScope"] = "uncommitted_work_only"
	result["stopRevision"] = e.stopRevision
	result["breakpointRuleEvents"] = append([]plDebugNativeRuleEvent{}, e.ruleEvents...)
	result["breakpointRulesOwner"] = "agent"
	result["sourceLineOffset"], result["sourceLineCount"], result["sourceMappingState"] = e.block.SourceLineOffset, e.block.SourceLineCount, "unverified"
	result["wrapperCallLine"] = e.block.CallLine
	result["nativeLine"] = result["line"]
	result["sourceRef"], result["sourceError"] = nil, ""
	result["routineIdentity"] = nil
	result["frameMappingState"] = "unverified"
	result["entryState"] = e.entryState
	result["entryError"] = e.entryError
	if e.programProbe != nil {
		probe := *e.programProbe
		result["currentProgramProbe"] = probe
	}
	if e.nativeStack != nil && e.nativeStack.StopRevision == e.stopRevision && e.state == "paused" && !e.closeRequested && !e.targetReturned {
		result["stackComplete"], result["frameMappingState"] = e.nativeStack.Complete, e.nativeStack.MappingState
		result["sourceError"] = e.nativeStack.SourceError
		if len(e.nativeStack.Frames) != 0 && e.nativeStack.MappingState == "verified" {
			frame := e.nativeStack.Frames[0]
			result["routineIdentity"] = frame.RoutineIdentity
			if frame.SourceRef != nil {
				result["sourceRef"] = frame.SourceRef
				result["line"] = nil
				if frame.SourceState == "resolved" {
					result["sourceMappingState"] = "verified"
					result["line"] = frame.SourceLine
				}
			}
		}
	}
	result["outputComplete"], result["outputTruncated"], result["outputError"] = e.capture.OutputComplete, e.capture.Truncated, e.capture.OutputError
	result["savepointRollback"] = plDebugNativeInteger(e.capture.SavepointRollback)
	result["cleanupError"] = e.cleanupError
	result["outputRecoveryError"] = e.outputRecoveryError
	result["executionOutcome"] = "unknown"
	result["executionStopped"], result["cancelConfirmed"] = false, false
	if !e.targetDispatched {
		result["executionOutcome"], result["executionStopped"] = "not_started", true
	}
	if e.targetReturned && e.capture.Code.Valid {
		result["executionStopped"] = true
		result["executionOutcome"] = "succeeded"
		if e.capture.Code.Int64 != 0 {
			result["executionOutcome"] = "failed"
		}
		result["businessCode"], result["businessError"] = e.capture.Code.Int64, plDebugNativeString(e.capture.Message)
		if !e.closeRequested {
			result["state"] = "ended"
		}
	}
	if terminated, _ := e.cached["terminated"].(bool); terminated {
		result["executionStopped"] = true
	}
	if e.namedPlan != nil {
		result["targetSignature"] = e.namedPlan.target
		result["targetSource"] = e.targetSource
		result["targetSignatureSource"] = e.targetSignatureSource
		result["wrapperCode"], result["wrapperError"] = plDebugNativeInteger(e.capture.Code), plDebugNativeString(e.capture.Message)
		for key, value := range e.namedResult {
			if key != "executionOutcome" && key != "executionStage" {
				result[key] = value
			}
		}
		if e.targetReturned {
			outcome, _ := e.namedResult["executionOutcome"].(string)
			result["executionOutcome"], result["executionStage"] = outcome, e.namedResult["executionStage"]
			if outcome != "unknown" && outcome != "" {
				result["executionStopped"] = true
				if !e.closeRequested {
					result["state"] = "ended"
				}
			}
			if outcome == "succeeded" {
				result["businessCode"], result["businessError"] = int64(0), nil
			} else if outcome == "not_started" {
				result["businessCode"], result["businessError"] = nil, nil
			}
		}
	}
	if e.abortAcknowledged && e.targetReturned && !e.capture.Code.Valid && e.namedResult["executionOutcome"] != "succeeded" {
		result["executionStopped"], result["cancelConfirmed"], result["executionOutcome"] = true, true, "cancelled"
	}
	if e.targetError != "" {
		result["targetError"] = e.targetError
	}
	result["terminated"] = result["executionStopped"]
	return result
}

func (e *plDebugNativeEntry) start() {
	ctx, cancel := context.WithDeadline(context.Background(), e.startDeadline)
	e.mu.Lock()
	e.startCancel = cancel
	closing := e.closeRequested
	e.mu.Unlock()
	defer cancel()
	defer close(e.startOwnerDone)
	defer func() {
		close(e.startDone)
		e.mu.Lock()
		rejected := e.preflightRejected
		if rejected && e.closeReason == "" {
			e.closeReason = "preflight_rejected"
		}
		e.mu.Unlock()
		if rejected {
			_, _ = e.close()
		}
	}()
	defer func() {
		if recovered := recover(); recovered != nil {
			e.failStart(fmt.Errorf("native start panic: %v", recovered))
		}
	}()
	fail := func(err error) { e.failStart(err) }
	if closing {
		fail(errors.New("start closed before dispatch"))
		return
	}
	s := e.server
	schema := e.request.Schema
	var block plDebugNativeBlock
	var err error
	if plDebugNativeToken(e.request.ObjectType) == "ANONYMOUS" {
		if strings.TrimSpace(e.request.Source) == "" {
			fail(errors.New("anonymous source is required"))
			return
		}
		if len(e.request.Params) != 0 {
			fail(errors.New("native anonymous parameter binding is not yet connected; no target was dispatched"))
			return
		}
		block, err = plDebugWrapNativeTarget(e.request.Source, 0)
	} else {
		var candidates []plDebugNativeCandidate
		schema, candidates, err = plDebugLoadNativeTargets(ctx, s.plConnection, e.request)
		if err != nil {
			fail(err)
			return
		}
		plan, selectErr := plDebugSelectNativeTarget(candidates, e.request)
		if selectErr != nil {
			fail(selectErr)
			return
		}
		call, bindErr := plan.bind(usesOCIProfile(s.params))
		if bindErr != nil {
			fail(bindErr)
			return
		}
		block, err = plan.block()
		if err != nil {
			fail(err)
			return
		}
		source, sourceErr := plDebugLoadNativeSource(ctx, s.plConnection, plan.target)
		if sourceErr != nil {
			fail(sourceErr)
			return
		}
		signatureSource, sourceErr := plDebugLoadNativeSignatureSource(ctx, s.plConnection, plan.target)
		if sourceErr != nil {
			fail(sourceErr)
			return
		}
		e.mu.Lock()
		e.namedPlan, e.namedCall, e.namedResult = plan, call, plan.unread("pending")
		e.targetSource = &source
		e.targetSignatureSource = signatureSource
		e.mu.Unlock()
	}
	if err != nil {
		fail(err)
		return
	}
	e.mu.Lock()
	e.block = block
	e.preflightRejected = false
	e.mu.Unlock()
	conn, err := s.openNativeDebuggee(ctx)
	if err != nil {
		fail(err)
		return
	}
	if schema != "" {
		_, err = conn.ExecContext(ctx, "ALTER SESSION SET CURRENT_SCHEMA = "+quoteIdentifier(schema))
		if err != nil {
			fail(err)
			return
		}
	}
	if e.namedPlan != nil {
		if err := plDebugRevalidateNativeTypedSignature(ctx, conn, e.namedPlan, true, usesOCIProfile(s.params)); err != nil {
			fail(err)
			return
		}
	}
	id, err := plDebugNativeInitialize(ctx, conn, usesOCIProfile(s.params))
	if err != nil {
		fail(err)
		return
	}
	e.mu.Lock()
	e.nativeID = id
	e.mu.Unlock()
	tx, err := s.beginNativeDebuggeeTransaction()
	if err != nil {
		fail(err)
		return
	}
	e.mu.Lock()
	e.transactionOutcome = "open"
	e.mu.Unlock()
	if err = plDebugNativeEnable(ctx, conn, usesOCIProfile(s.params)); err != nil {
		fail(err)
		return
	}
	if e.namedPlan != nil {
		if _, err := e.checkNativeTargetVersion(ctx, "dispatch"); err != nil {
			fail(err)
			return
		}
	}
	p := &plDebugSession{debugID: id, owner: schema, nativeDebugger: s.plConnection, nativeContext: ctx,
		oci: usesOCIProfile(s.params), targetDone: make(chan struct{}), breakpointDisabled: map[int]bool{}, timeoutBehaviour: 3}
	p.touch()
	e.mu.Lock()
	e.session = p
	e.transactionOutcome = "open"
	e.mu.Unlock()
	go e.executeTarget(tx, p, block)
	select {
	case <-e.dispatchDone:
	case <-e.captureDone:
		fail(errors.New("target could not be dispatched"))
		return
	case <-ctx.Done():
		fail(ctx.Err())
		return
	}
	_, err = s.plConnection.ExecContext(ctx, `BEGIN SYS.DBMS_DEBUG.ATTACH_SESSION(:1); END;`, id)
	if err != nil {
		fail(err)
		return
	}
	stop, err := plDebugNativeControl(ctx, s.plConnection, p.oci, procSynchronize)
	if err != nil {
		fail(err)
		return
	}
	if stop.Result.Int64 != 0 {
		fail(fmt.Errorf("native synchronization failed (%d)", stop.Result.Int64))
		return
	}
	p.mu.Lock()
	p.applyNativeStop(&stop)
	cached := p.snapshot("")
	p.mu.Unlock()
	e.mu.Lock()
	e.cached = cached
	e.stopRevision++
	e.entryState = "unresolved"
	e.mu.Unlock()
	entrySteps := 0
	if stop.Reason.Valid && stop.Reason.Int64 == 2 && plDebugNativeStopState(stop) == "paused" {
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			fail(err)
			return
		}
		stop, err = plDebugNativeControl(ctx, s.plConnection, p.oci, procCntStepIn)
		if err != nil || stop.Result.Int64 != 0 {
			if err == nil {
				err = fmt.Errorf("initial native entry step failed (%d)", stop.Result.Int64)
			}
			fail(err)
			return
		}
		p.mu.Lock()
		p.applyNativeStop(&stop)
		cached = p.snapshot("")
		p.mu.Unlock()
		e.mu.Lock()
		e.cached = cached
		e.stopRevision++
		e.mu.Unlock()
		entrySteps++
	}
	stop, err = e.driveNativeEntry(ctx, p, stop, entrySteps)
	if err != nil {
		fail(err)
		return
	}
	e.mu.Lock()
	mapped := e.nativeStack != nil && e.nativeStack.StopRevision == e.stopRevision && len(e.nativeStack.Frames) > 0 && e.nativeStack.Frames[0].SourceRef != nil
	e.mu.Unlock()
	if !mapped && stop.Reason.Valid && stop.Reason.Int64 != plDebugReasonBreakpoint && stop.Reason.Int64 != plDebugReasonException && stop.Reason.Int64 != plDebugReasonHandler {
		_ = e.inspectNativeCurrentProgram(ctx, stop)
	}
	s.plAllocation.mu.Lock()
	inspectionUnknown := s.plAllocation.unknown || s.plAllocation.active != nil
	s.plAllocation.mu.Unlock()
	e.mu.Lock()
	if plDebugNativeStopState(stop) == "ended" {
		e.entryState = "ended_before_entry"
	}
	e.startState = "succeeded"
	if !e.closeRequested {
		e.state = plDebugNativeStopState(stop)
		if inspectionUnknown || len(e.nativeReadPending) != 0 || (e.programProbe != nil && e.programProbe.Uncertain) {
			e.state = "unknown"
		}
		if e.targetReturned && e.state == "paused" {
			e.state = "unknown"
		}
	}
	e.mu.Unlock()
}

func (e *plDebugNativeEntry) failStart(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.startState, e.startError = "failed", err.Error()
	if !e.closeRequested {
		e.state = "unknown"
		if !e.targetDispatched {
			e.state = "ended"
		}
	}
}

func (e *plDebugNativeEntry) executeTarget(tx *sql.Tx, p *plDebugSession, block plDebugNativeBlock) {
	var capture plDebugNativeCapture
	var executionErr error
	defer func() {
		if recovered := recover(); recovered != nil {
			executionErr = fmt.Errorf("native target panic: %v", recovered)
			a := e.server.nativeDebuggeeAllocation()
			a.mu.Lock()
			a.unknown = true
			a.mu.Unlock()
		}
		e.mu.Lock()
		e.capture = capture
		e.captureFinished = true
		if e.namedCall != nil && e.targetReturned {
			for i := range e.namedCall.values {
				lob := e.namedCall.lobs[i]
				if lob == nil || lob.state != "value" && lob.state != "partial" || lob.reference != nil {
					continue
				}
				argument := e.namedCall.plan.outputs()[i]
				path := "$return"
				if argument.Name != nil {
					path = *argument.Name
				}
				sourceError := ""
				if lob.state == "partial" && !errors.Is(lob.err, errPLDebugLobBudget) {
					sourceError = "read_failed"
				}
				if lob.sourceError != "" {
					sourceError = lob.sourceError
				}
				reference, err := e.resultCache.retainWithState(lob.data, lob.binary, path, lob.state == "value", sourceError)
				if err != nil {
					lob.state, lob.err = "error", err
				} else {
					lob.reference = reference
					lob.data = nil
					if reference["complete"] != true {
						lob.state = "partial"
					}
				}
			}
			e.namedResult = e.namedCall.result(capture, executionErr)
		}
		if executionErr != nil {
			e.recordTargetErrorLocked(executionErr)
		}
		e.mu.Unlock()
		close(e.captureDone)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(plDebugTimeoutMillis)*time.Millisecond)
	defer cancel()
	observer := &plDebugCaptureObserver{
		dispatch: func() error {
			e.mu.Lock()
			defer e.mu.Unlock()
			if e.closeRequested {
				return errors.New("target closed before dispatch")
			}
			e.targetDispatched = true
			close(e.dispatchDone)
			return nil
		},
		returned: func(value plDebugNativeCapture, err error) {
			var named map[string]interface{}
			if e.namedCall != nil {
				named = e.namedCall.result(value, err)
			}
			e.mu.Lock()
			e.targetReturned = true
			e.capture.Code, e.capture.Message, e.capture.SavepointRollback = value.Code, value.Message, value.SavepointRollback
			if named != nil {
				e.namedResult = named
			}
			if err != nil {
				e.recordTargetErrorLocked(err)
			}
			e.mu.Unlock()
			p.mu.Lock()
			p.targetReturned = err == nil && value.Code.Valid && value.Code.Int64 == 0
			if named != nil {
				p.targetReturned = named["executionOutcome"] == "succeeded"
			}
			if p.targetReturned {
				p.targetErr = ""
			} else if value.Code.Valid && value.Code.Int64 != 0 {
				p.targetErr = value.Message.String
			} else if err != nil {
				p.targetErr = err.Error()
			}
			p.mu.Unlock()
			p.targetOnce.Do(func() { close(p.targetDone) })
		},
	}
	var arguments []interface{}
	if e.namedCall != nil {
		arguments = e.namedCall.arguments
		observer.lobs = e.namedCall.lobOutputs()
	}
	capture, executionErr = plDebugExecuteObservedCapture(ctx, tx, e.server.nativeDebuggeeAllocation(), p.oci, block, arguments, observer)
}

func (e *plDebugNativeEntry) recordTargetErrorLocked(err error) {
	if e.namedResult["executionOutcome"] == "succeeded" {
		e.namedResult["resultError"] = "The target returned, but its result or output transfer failed: " + err.Error()
	} else {
		e.targetError = err.Error()
	}
}

func plDebugNativeStopState(stop plDebugNativeStop) string {
	if !stop.Terminated.Valid {
		return "unknown"
	}
	if stop.Terminated.Int64 != 0 {
		return "ended"
	}
	return "paused"
}

func (e *plDebugNativeEntry) control(method string, params map[string]json.RawMessage) (interface{}, error) {
	var enabled bool
	if method == "pl_debug_set_exception_breakpoint" {
		raw, ok := params["enabled"]
		if !ok {
			return nil, errors.New("enabled is required")
		}
		if err := json.Unmarshal(raw, &enabled); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	e.mu.Lock()
	knownNamed := e.namedResult["executionOutcome"] == "succeeded" || e.namedResult["executionOutcome"] == "failed" || e.namedResult["executionOutcome"] == "not_started"
	if e.closeRequested || e.actionBusy || e.startState != "succeeded" || e.state != "paused" || (e.targetReturned && (e.capture.Code.Valid || knownNamed)) {
		e.mu.Unlock()
		return nil, errors.New("the original debug operation is not available for control")
	}
	p := e.session
	e.actionBusy = true
	e.programProbe = nil
	e.nativeStack = nil
	e.entryState = "unresolved"
	e.entryError = ""
	e.actionCancel, e.actionDone = cancel, make(chan struct{})
	e.state = "running"
	e.mu.Unlock()
	p.nativeContext = ctx
	result, err := e.runNativeControl(p, method, enabled)
	if err == nil && p.nativeStop != nil {
		result, err = e.applyNativeBreakpointRules(ctx, p, method, result)
	}
	e.mu.Lock()
	e.actionBusy = false
	close(e.actionDone)
	if err == nil {
		e.cached = result
		e.stopRevision++
	}
	if !e.closeRequested {
		e.state = "unknown"
		if err == nil && p.nativeStop != nil {
			e.state = plDebugNativeStopState(*p.nativeStop)
		}
	}
	snapshot := e.snapshotLocked()
	e.mu.Unlock()
	if err != nil {
		var native *plDebugNativeError
		if errors.As(err, &native) {
			return nil, native
		}
		return nil, &plDebugNativeError{message: err.Error(), outcome: "unknown", agentSessionID: e.agentSessionID}
	}
	return snapshot, nil
}

func (e *plDebugNativeEntry) runNativeControl(p *plDebugSession, method string, enabled bool) (result map[string]interface{}, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			e.server.plAllocation.mu.Lock()
			e.server.plAllocation.unknown = true
			e.server.plAllocation.mu.Unlock()
			err = &plDebugNativeError{message: fmt.Sprintf("native control panic: %v", recovered), outcome: "unknown", agentSessionID: e.agentSessionID, category: "protocol", stage: "execute"}
		}
	}()
	switch method {
	case "pl_debug_resume":
		result, err = p.resume()
	case "pl_debug_step_over":
		result, err = p.stepOver()
	case "pl_debug_step_in":
		result, err = p.stepIn()
	case "pl_debug_step_out":
		result, err = p.stepOut()
	case "pl_debug_resume_ignore_breakpoints":
		result, err = p.resumeIgnoreBreakpoints()
	case "pl_debug_set_exception_breakpoint":
		result = p.setExceptionBreakpoint(enabled)
	}
	return result, err
}

func (e *plDebugNativeEntry) output(params map[string]json.RawMessage) (interface{}, error) {
	offset, limit := 0, plDebugLogChars
	if raw, ok := params["offset"]; ok {
		if err := json.Unmarshal(raw, &offset); err != nil {
			return nil, err
		}
	}
	if raw, ok := params["limit"]; ok {
		if err := json.Unmarshal(raw, &limit); err != nil {
			return nil, err
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	result := e.snapshotLocked()
	result["outputPending"] = !e.captureFinished
	_, hasOffset := params["offset"]
	_, hasLimit := params["limit"]
	if !hasOffset && !hasLimit {
		result["output"] = e.capture.Output
		return result, nil
	}
	page, err := e.capture.page(offset, limit)
	if err != nil {
		return nil, err
	}
	result["outputPage"] = map[string]interface{}{"text": page.Text, "offset": page.Offset, "nextOffset": page.NextOffset, "totalChars": page.TotalChars, "complete": page.Complete, "truncated": page.Truncated, "error": page.Error}
	return result, nil
}

func (e *plDebugNativeEntry) close() (interface{}, error) {
	e.mu.Lock()
	e.closeRequested, e.cancelRequested = true, true
	if e.closeReason == "" {
		e.closeReason = "requested"
	}
	if e.leaseTimer != nil {
		e.leaseTimer.Stop()
	}
	if e.releaseState == "released" {
		result := e.snapshotLocked()
		e.mu.Unlock()
		return result, nil
	}
	e.state = "closing"
	if e.cleanupDeadline.IsZero() {
		e.cleanupDeadline = time.Now().Add(plDebugReleaseTimeout)
	}
	if e.cleanupBusy {
		done := e.cleanupDone
		deadline := e.cleanupDeadline
		e.mu.Unlock()
		_ = plDebugWaitUntil(done, deadline)
		return e.snapshot(), nil
	}
	e.cleanupBusy = true
	e.cleanupDone = make(chan struct{})
	done := e.cleanupDone
	deadline := e.cleanupDeadline
	busy := e.actionBusy
	starting := e.startState == "pending"
	p := e.session
	startCancel := e.startCancel
	e.mu.Unlock()
	go func() {
		var err error
		defer func() {
			if recovered := recover(); recovered != nil {
				err = fmt.Errorf("original cleanup panic: %v", recovered)
			}
			var next <-chan struct{}
			if err != nil && time.Now().Before(deadline) {
				next = e.pendingCleanupContinuation()
			}
			e.mu.Lock()
			e.cleanupBusy = false
			if err != nil {
				e.releaseState, e.cleanupError, e.state = "unknown", err.Error(), "unknown"
			} else {
				e.releaseState, e.cleanupError, e.state = "released", "", "closed"
			}
			var continuation chan struct{}
			if next != nil && !e.continuationWaiting {
				e.continuationWaiting = true
				continuation = make(chan struct{})
				e.continuationDone = continuation
			}
			close(done)
			e.mu.Unlock()
			if continuation != nil {
				go e.resumeCleanupAfter(next, continuation, deadline)
			}
		}()
		err = e.cleanup(deadline, busy, starting, p, startCancel)
	}()
	err := plDebugWaitUntil(done, deadline)
	e.mu.Lock()
	if err != nil && e.cleanupBusy {
		e.releaseState = "unknown"
		e.cleanupError = err.Error()
		e.state = "unknown"
	}
	result := e.snapshotLocked()
	e.mu.Unlock()
	return result, nil
}

func (e *plDebugNativeEntry) cleanup(deadline time.Time, busy, starting bool, p *plDebugSession, startCancel context.CancelFunc) error {
	if time.Now().After(deadline) {
		if e.originalPhysicalReleaseConfirmed() {
			return e.runtime.closeNativeLogicalSession(e.agentSessionID)
		}
		return errPLDebugAllocationUnknown
	}
	e.server.plDebugMu.Lock()
	e.server.plRetiring = true
	if e.server.plCleanupDeadline.IsZero() || deadline.Before(e.server.plCleanupDeadline) {
		e.server.plCleanupDeadline = deadline
	}
	e.server.plDebugMu.Unlock()
	if starting && startCancel != nil {
		startCancel()
	}
	e.mu.Lock()
	dispatched, returned := e.targetDispatched, e.targetReturned
	actionCancel := e.actionCancel
	actionDone := e.actionDone
	e.mu.Unlock()
	if busy && actionCancel != nil {
		actionCancel()
	}
	if !starting {
		if err := e.finishNativeReads(deadline); err != nil {
			return err
		}
	}
	if dispatched && !returned {
		if !busy && !starting && p != nil {
			if err := e.abortOriginalTarget(deadline, p); err != nil {
				return err
			}
		} else {
			for _, a := range []*plDebugAllocation{e.server.plAllocation, e.server.nativeDebuggeeAllocation()} {
				if a == nil {
					continue
				}
				a.mu.Lock()
				active := a.active
				a.mu.Unlock()
				if active != nil {
					go a.cancelCall(active)
				}
			}
		}
		if err := plDebugWaitUntil(e.captureDone, deadline); err != nil {
			return err
		}
	}
	if starting {
		if err := plDebugWaitUntil(e.startDone, deadline); err != nil {
			return err
		}
		if err := e.finishNativeReads(deadline); err != nil {
			return err
		}
	}
	if dispatched {
		if err := plDebugWaitUntil(e.captureDone, deadline); err != nil {
			return err
		}
	}
	if busy {
		if err := plDebugWaitUntil(actionDone, deadline); err != nil {
			return err
		}
	}
	if err := e.finishNativeReads(deadline); err != nil {
		return err
	}
	e.mu.Lock()
	capture := e.capture
	finished := e.captureFinished
	dispatched = e.targetDispatched
	e.mu.Unlock()
	if dispatched {
		if !finished {
			return errPLDebugAllocationUnknown
		}
		if capture.ReferencesPending {
			ctx, cancel := context.WithDeadline(context.Background(), deadline)
			capture.finishReferences(ctx, e.server.nativeDebuggeeAllocation())
			cancel()
			e.mu.Lock()
			e.capture = capture
			e.mu.Unlock()
		}
		if capture.ReferencesPending {
			return errors.New("original output references are not released")
		}
		if !capture.Code.Valid && !capture.OutputComplete && !capture.Truncated {
			if err := e.recoverOutput(deadline); err != nil {
				return err
			}
			e.mu.Lock()
			capture = e.capture
			e.mu.Unlock()
		}
		if !capture.OutputComplete && !capture.Truncated {
			return errors.New("original target output recovery is pending")
		}
	}
	e.server.plDebugMu.Lock()
	if e.server.plCleanupDeadline.IsZero() || deadline.Before(e.server.plCleanupDeadline) {
		e.server.plCleanupDeadline = deadline
	}
	e.server.plDebugMu.Unlock()
	closeErr := e.server.closeNativeAllocations()
	e.server.plDebugMu.Lock()
	rollbackDone, rollbackErr := e.server.plTxRollbackDone, e.server.plTxRollbackErr
	e.server.plDebugMu.Unlock()
	e.mu.Lock()
	if rollbackDone != nil {
		e.transactionOutcome = "unknown"
		select {
		case <-rollbackDone:
			if rollbackErr == nil {
				e.transactionOutcome = "rollback_confirmed"
			}
		default:
		}
	}
	e.mu.Unlock()
	if closeErr != nil {
		return closeErr
	}
	return e.runtime.closeNativeLogicalSession(e.agentSessionID)
}

func (e *plDebugNativeEntry) originalPhysicalReleaseConfirmed() bool {
	e.mu.Lock()
	ready := plDebugPendingCompletion(e.startDone) == nil && !e.actionBusy && (!e.targetDispatched || e.captureFinished) && plDebugPendingCompletion(e.outputRecoveryDone) == nil
	e.mu.Unlock()
	if !ready {
		return false
	}
	s := e.server
	s.plDebugMu.Lock()
	allocations := []*plDebugAllocation{s.plAllocation, s.plDebuggeeAllocation}
	ready = plDebugPendingCompletion(s.plDebuggeeOpenDone) == nil && plDebugPendingCompletion(s.plTxBeginDone) == nil
	rolledBack := s.plDebuggeeTx != nil && s.plTxRollbackDone != nil && plDebugPendingCompletion(s.plTxRollbackDone) == nil && s.plTxRollbackErr == nil
	if s.plDebuggeeTx != nil && !rolledBack {
		ready = false
	}
	s.plDebugMu.Unlock()
	if !ready {
		return false
	}
	for _, a := range allocations {
		if a == nil {
			continue
		}
		a.mu.Lock()
		ready = a.closed && a.active == nil && len(a.statements) == 0 && len(a.rows) == 0
		a.mu.Unlock()
		if !ready {
			return false
		}
	}
	if rolledBack {
		e.mu.Lock()
		e.transactionOutcome = "rollback_confirmed"
		e.mu.Unlock()
	}
	return true
}

func (e *plDebugNativeEntry) abortOriginalTarget(deadline time.Time, p *plDebugSession) error {
	e.mu.Lock()
	if e.abortAttempted {
		message := e.abortError
		e.mu.Unlock()
		if message != "" {
			return errors.New(message)
		}
		return nil
	}
	e.abortAttempted = true
	e.mu.Unlock()
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	stop, err := plDebugNativeControl(ctx, e.server.plConnection, p.oci, procCntAbort)
	if err == nil && stop.Result.Int64 != 0 {
		err = fmt.Errorf("native abort failed (%d)", stop.Result.Int64)
	}
	if err != nil {
		e.mu.Lock()
		e.abortError = err.Error()
		e.mu.Unlock()
		return err
	}
	p.mu.Lock()
	p.applyNativeStop(&stop)
	cached := p.snapshot("")
	p.mu.Unlock()
	e.mu.Lock()
	e.cached = cached
	e.abortAcknowledged = stop.Terminated.Valid && stop.Terminated.Int64 != 0 && stop.Reason.Valid && stop.Reason.Int64 == plDebugReasonAborting
	e.mu.Unlock()
	return nil
}

func (e *plDebugNativeEntry) recoverOutput(deadline time.Time) error {
	e.mu.Lock()
	if !e.abortAcknowledged || !e.targetReturned || e.capture.NativeComplete.Valid || e.capture.Output != "" {
		e.mu.Unlock()
		return errors.New("original output consumption cannot be established; retain the original session")
	}
	if e.outputRecoveryAttempted {
		done := e.outputRecoveryDone
		e.mu.Unlock()
		if err := plDebugWaitUntil(done, deadline); err != nil {
			return err
		}
		return e.mergeRecoveredOutput()
	}
	for _, allocation := range []*plDebugAllocation{e.server.plAllocation, e.server.nativeDebuggeeAllocation()} {
		allocation.mu.Lock()
		ready := !allocation.unknown && !allocation.retiring && allocation.active == nil && len(allocation.rows) == 0 && len(allocation.statements) == 0
		allocation.mu.Unlock()
		if !ready {
			e.mu.Unlock()
			return errPLDebugAllocationUnknown
		}
	}
	e.outputRecoveryAttempted = true
	e.outputRecoveryDone = make(chan struct{})
	done := e.outputRecoveryDone
	e.mu.Unlock()
	block, err := plDebugNativeCleanupBlock()
	if err != nil {
		e.mu.Lock()
		e.outputRecoveryError = err.Error()
		close(done)
		e.mu.Unlock()
		return err
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	started := make(chan struct{})
	go func() {
		var result plDebugNativeCapture
		var captureErr error
		defer func() {
			if recovered := recover(); recovered != nil {
				captureErr = fmt.Errorf("private output cleanup panic: %v", recovered)
			}
			e.mu.Lock()
			e.outputRecoveryCapture = result
			if captureErr != nil {
				e.outputRecoveryError = captureErr.Error()
			}
			close(done)
			e.mu.Unlock()
		}()
		e.server.plDebugMu.Lock()
		tx := e.server.plDebuggeeTx
		e.server.plDebugMu.Unlock()
		result, captureErr = plDebugExecuteObservedCapture(ctx, tx, e.server.nativeDebuggeeAllocation(), usesOCIProfile(e.server.params), block, nil,
			&plDebugCaptureObserver{dispatch: func() error { close(started); return nil }})
	}()
	select {
	case <-started:
	case <-done:
		return e.mergeRecoveredOutput()
	case <-ctx.Done():
		return ctx.Err()
	}
	// These events belong only to the private DEBUG_OFF/drain block. They must
	// not replace the target's stop, business result or stop revision.
	stop, err := plDebugNativeControl(ctx, e.server.plConnection, usesOCIProfile(e.server.params), procSynchronize)
	if err != nil {
		return err
	}
	if stop.Result.Int64 != 0 || !stop.Terminated.Valid {
		return errors.New("private output synchronization could not be confirmed")
	}
	if stop.Terminated.Int64 == 0 {
		stop, err = plDebugNativeControl(ctx, e.server.plConnection, usesOCIProfile(e.server.params), procCntNextBreakpoint)
		if err != nil {
			return err
		}
		if stop.Result.Int64 != 0 {
			return errors.New("private output continuation could not be confirmed")
		}
	}
	if err := plDebugWaitUntil(done, deadline); err != nil {
		return err
	}
	return e.mergeRecoveredOutput()
}

func (e *plDebugNativeEntry) mergeRecoveredOutput() error {
	e.mu.Lock()
	result := e.outputRecoveryCapture
	deadline := e.cleanupDeadline
	e.mu.Unlock()
	if result.ReferencesPending {
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		result.finishReferences(ctx, e.server.nativeDebuggeeAllocation())
		cancel()
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.outputRecoveryCapture = result
	if e.outputRecoveryError != "" {
		return errors.New(e.outputRecoveryError)
	}
	if result.ReferencesPending || (!result.OutputComplete && !result.Truncated) {
		return errors.New("private output capture is incomplete or still owns references")
	}
	e.capture.Output, e.capture.OutputComplete, e.capture.Truncated, e.capture.OutputError = result.Output, result.OutputComplete, result.Truncated, result.OutputError
	e.capture.utf16Text = nil
	return nil
}

func plDebugWaitUntil(done <-chan struct{}, deadline time.Time) error {
	select {
	case <-done:
		return nil
	default:
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-timer.C:
		return errPLDebugAllocationUnknown
	}
}

func (s *server) nativeDebuggeeAllocation() *plDebugAllocation {
	s.plDebugMu.Lock()
	defer s.plDebugMu.Unlock()
	return s.plDebuggeeAllocation
}
